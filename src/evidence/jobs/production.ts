import { randomUUID } from "node:crypto";
import path from "node:path";
import { FileArtifactRepository } from "../../artifacts/repository.mjs";
import { FileEvidenceRepository } from "../repository.mjs";
import {
  OfficialClaimCandidateRepository,
  createFilePlanClaimCandidateAuthority,
} from "../claim-candidate-repository";
import { ThirdPartyClaimCandidateRepository } from "../third-party-claim-candidate-repository";
import { EvidenceBindingProposalRepository } from "../binding-proposal-repository";
import { createGovernedEvidenceAdapterSeams } from "../adapters";
import { FileJobRepository, JobRepositoryError, currentJobLease, type BackgroundJob } from "../../jobs";
import { DurableJobScheduler } from "../../jobs/worker";
import { validateRuntimeJobSideEffectFence } from "../../jobs/runtime-validation.mjs";
import { confined, readJson, sha256Json } from "../../runtime/fs.mjs";
import type { RuntimeCoordinator } from "../../runtime/coordinator.mjs";
import {
  ProvisionalCaseAdapterService,
  provisionalCaseAdapterCandidateArtifactRef,
  type ProvisionalCaseAdapterCandidate,
} from "../../adapters/provisional";
import {
  ProductionEvidenceServiceError,
  createProductionEvidenceStageServices,
} from "../../../scripts/price-server/evidence/services.mjs";
import { createDefaultThirdPartyDiscovery } from "../../../scripts/price-server/evidence/third-party-discovery.mjs";
import type { AttachmentInspectionLimits } from "../../attachments/security";
import { EvidenceJobArtifactStore } from "./artifact-store";
import {
  EVIDENCE_PIPELINE_STAGES,
  createEvidencePipelineRequest,
  evidenceStageCommitHash,
  jobIdForEvidenceStage,
  type EvidencePipelineDescriptor,
  type EvidencePipelineRequest,
  type EvidencePipelineRequestInput,
  type EvidencePipelineStage,
  type EvidenceStageResult,
} from "./contracts";
import {
  EvidenceStageOfflineError,
  EvidenceStageRetryableError,
  createEvidenceJobWorker,
  type EvidencePipelineServices,
  type EvidenceStageEffectContext,
  type EvidenceStageService,
} from "./handlers";
import { EvidenceJobPipeline } from "./pipeline";

const JOB_ENVELOPE_SCHEMA = "job-store-envelope-v1";
const PIPELINE_ID = /^evidence-pipeline-sha256-[a-f0-9]{64}$/;

export interface ProductionEvidenceJobStatus {
  readonly pipelineId: EvidencePipelineRequest["pipelineId"];
  readonly requestHash: string;
  readonly planId?: string;
  readonly stages: ReadonlyArray<{
    readonly stage: EvidencePipelineStage;
    readonly jobId: string;
    readonly status: BackgroundJob["status"];
    readonly revision: number;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly runAfter: string;
    readonly progress?: BackgroundJob["progress"];
    readonly lastError?: BackgroundJob["lastError"];
    readonly result?: EvidenceStageResult;
  }>;
}

export interface ProductionEvidenceJobRuntimeOptions {
  readonly runtimeRoot: string;
  readonly coordinator: RuntimeCoordinator;
  readonly evidenceRepository: FileEvidenceRepository;
  readonly artifactRepository: FileArtifactRepository;
  readonly factRepository?: unknown;
  readonly online?: () => boolean | Promise<boolean>;
  readonly now?: () => string;
  readonly workerId?: string;
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly schedulerIntervalMs?: number;
  readonly topologyV3Enabled?: boolean;
  /** Constructor-only production adapters. They are never exposed by HTTP. */
  readonly officialFetcher?: unknown;
  readonly officialRegistry?: unknown;
  readonly officialClaimExtractor?: unknown;
  readonly thirdPartyRegistry?: unknown;
  readonly thirdPartyDiscovery?: unknown;
  readonly thirdPartyFetcher?: unknown;
  readonly thirdPartyClaimExtractor?: unknown;
  readonly adapterGenerator?: unknown;
  /** Governed U5 adapter_generation hook for exact case subjects. */
  readonly provisionalCaseAdapter?: {
    readonly service: Pick<ProvisionalCaseAdapterService, "proposeAtRoot">;
    resolveCaseComponentInstanceIdAtRoot(activeRoot: string, input: {
      planId: string;
      subject: EvidencePipelineRequest["subject"];
    }): Promise<string>;
  };
  readonly bindingProposer?: unknown;
  readonly rateLimiter?: unknown;
  readonly evidenceOcrLimits?: Partial<AttachmentInspectionLimits>;
  readonly evidenceOcrFaultInjector?: (input: {
    point: "after_ocr_artifact";
    artifactRef: string;
    created: boolean;
  }) => void | Promise<void>;
}

export interface EvidenceJobRouteRuntime {
  enqueue(input: unknown): Promise<EvidencePipelineDescriptor>;
  status(pipelineId: string): Promise<ProductionEvidenceJobStatus>;
  listForPlan(planId: string): Promise<readonly ProductionEvidenceJobStatus[]>;
  cancel(input: { pipelineId: string; stage: string; expectedRevision: number }): Promise<BackgroundJob>;
  resume(input: { pipelineId: string; stage: string; expectedRevision: number }): Promise<BackgroundJob>;
}

function assertPipelineId(value: string): asserts value is EvidencePipelineRequest["pipelineId"] {
  if (!PIPELINE_ID.test(value)) throw new TypeError("evidence pipeline id is invalid");
}

function stage(value: string): EvidencePipelineStage {
  if (!(EVIDENCE_PIPELINE_STAGES as readonly string[]).includes(value)) throw new TypeError("evidence pipeline stage is invalid");
  return value as EvidencePipelineStage;
}

function fencedEvidenceRepository(
  coordinator: RuntimeCoordinator,
  base: FileEvidenceRepository,
  context: EvidenceStageEffectContext,
  now: () => string,
): FileEvidenceRepository {
  const importBuffer = async (content: Uint8Array, input: unknown) => (await coordinator.withWrite(async ({ state, activeRoot }: {
    state: { runtimeGeneration: number };
    activeRoot: string;
  }) => {
    const file = confined(activeRoot, "jobs", "records", `${context.jobId}.json`);
    const envelope = await readJson(file);
    if (!envelope || envelope.schemaVersion !== JOB_ENVELOPE_SCHEMA || envelope.kind !== "background-job"
      || envelope.checksum !== sha256Json(envelope.payload)
      || validateRuntimeJobSideEffectFence(envelope.payload, {
        jobId: context.jobId,
        expectedRevision: context.expectedRevision,
        leaseToken: context.fencingToken,
        runtimeGeneration: context.runtimeGeneration,
      }, now()).length > 0
      || state.runtimeGeneration !== context.runtimeGeneration) {
      throw new JobRepositoryError("fenced", "evidence capture belongs to a stale job lease");
    }
    return base.atActiveRoot(activeRoot).importBuffer(content, input);
  })).result;

  // Reads are delegated to the coordinator-backed repository. Only the
  // acquisition write needs the context-bound side-effect fence.
  return Object.freeze({
    getLatestCaptureForUrl: base.getLatestCaptureForUrl.bind(base),
    getDocument: base.getDocument.bind(base),
    readContent: base.readContent.bind(base),
    getDocumentContent: base.getDocumentContent.bind(base),
    importBuffer,
  }) as unknown as FileEvidenceRepository;
}

function governedServices(raw: Record<string, EvidenceStageService>): EvidencePipelineServices {
  const wrap = (service: EvidenceStageService): EvidenceStageService => async (context) => {
    try {
      return await service(context);
    } catch (error) {
      if (error instanceof ProductionEvidenceServiceError) {
        if (error.offline) throw new EvidenceStageOfflineError();
        if (error.retryable) throw new EvidenceStageRetryableError(error.code, error.message, error.retryAt);
      }
      throw error;
    }
  };
  return Object.freeze(Object.fromEntries(Object.entries(raw).map(([key, service]) => [key, wrap(service)]))) as unknown as EvidencePipelineServices;
}

function provisionalCaseAdapterGenerationService(
  options: ProductionEvidenceJobRuntimeOptions,
): EvidenceStageService | null {
  const hook = options.provisionalCaseAdapter;
  if (!hook) return null;
  if (!hook.service || typeof hook.service.proposeAtRoot !== "function"
    || typeof hook.resolveCaseComponentInstanceIdAtRoot !== "function") {
    throw new TypeError("production provisional case adapter hook is invalid");
  }
  return async (context) => {
    const planId = context.request.planId;
    if (!planId || context.request.subject.category !== "case") {
      throw new TypeError("provisional case adapter generation requires a server-bound plan and case subject");
    }
    // The resolver must return the one exact matching plan component. Zero or
    // multiple matches are contract failures/needs-review; this seam never
    // picks an instance from a caller-supplied SKU.
    let resolved: { result: {
      caseComponentInstanceId: string; runtimeGeneration: number; runtimeRevision: number;
    } };
    try {
      resolved = await options.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: {
        state: { runtimeGeneration: number; revision: number };
        activeRoot: string;
      }) => ({
        caseComponentInstanceId: await hook.resolveCaseComponentInstanceIdAtRoot(activeRoot, {
          planId,
          subject: context.request.subject,
        }),
        runtimeGeneration: state.runtimeGeneration,
        runtimeRevision: state.revision,
      }));
    } catch (error) {
      if ((error as { code?: unknown }).code === "case_component_not_unique"
        || (error as { code?: unknown }).code === "exact_identity_unavailable") {
        return Object.freeze({
          status: "needs_review" as const,
          output: Object.freeze({
            reason: String((error as { code?: unknown }).code),
            blockedDomains: ["electronics", "geometry", "routing", "assembly"],
            missingFields: ["exact_case_component_identity"],
            nextEvidenceActions: [{
              fieldId: "exact_case_component_identity",
              preferredAuthority: "official",
              action: "approve_catalog_identity_and_bind_one_plan_case_component",
              reason: error instanceof Error ? error.message : "exact case component resolution is unavailable",
            }],
          }),
        });
      }
      throw error;
    }
    let candidate: ProvisionalCaseAdapterCandidate;
    try {
      candidate = await hook.service.proposeAtRoot({
        planId,
        caseComponentInstanceId: resolved.result.caseComponentInstanceId,
        expectedRuntimeGeneration: resolved.result.runtimeGeneration,
        expectedRuntimeRevision: resolved.result.runtimeRevision,
      }) as ProvisionalCaseAdapterCandidate;
    } catch (error) {
      if ((error as { code?: unknown }).code === "governed_fact_closure_unavailable") {
        return Object.freeze({
          status: "blocked" as const,
          output: Object.freeze({
            reason: "governed_fact_closure_unavailable",
            readyDomains: [],
            blockedDomains: ["electronics", "geometry", "routing", "assembly"],
            missingFields: ["identity.revision", "governed_claim_locator_closure"],
            nextEvidenceActions: [{
              fieldId: "identity.revision",
              preferredAuthority: "official",
              action: "promote_exact_revision_claim_and_fact",
              reason: error instanceof Error ? error.message : "exact governed case fact/evidence closure is unavailable",
            }],
          }),
        });
      }
      throw error;
    }
    if (candidate.runtimeGeneration !== context.runtimeGeneration
      || candidate.authorityRefs.generationJobId !== context.jobId
      || candidate.authorityRefs.generationJobResultRef !== context.attemptRef
      || candidate.createdAt !== context.attemptStartedAt) {
      throw new TypeError("provisional case adapter candidate is not bound to the active durable generation attempt");
    }
    return Object.freeze({
      status: candidate.status === "ready_for_review" ? "completed" : "blocked",
      output: candidate as unknown as Readonly<Record<string, unknown>>,
      resultRefs: Object.freeze([provisionalCaseAdapterCandidateArtifactRef(candidate.candidateId)]),
    });
  };
}

/** Production durable evidence DAG composition. No process-local map is authoritative. */
export class ProductionEvidenceJobRuntime implements EvidenceJobRouteRuntime {
  readonly jobs: FileJobRepository;
  readonly artifacts: EvidenceJobArtifactStore;
  readonly pipeline: EvidenceJobPipeline;
  readonly claimCandidates: OfficialClaimCandidateRepository;
  readonly thirdPartyClaimCandidates: ThirdPartyClaimCandidateRepository;
  readonly bindingProposals: EvidenceBindingProposalRepository;
  readonly scheduler: DurableJobScheduler;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private initialization: Promise<void> | null = null;

  constructor(readonly options: ProductionEvidenceJobRuntimeOptions) {
    const now = options.now ?? (() => new Date().toISOString());
    const governedAdapters = createGovernedEvidenceAdapterSeams();
    this.jobs = new FileJobRepository({
      coordinator: options.coordinator,
      now,
      ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    });
    this.artifacts = new EvidenceJobArtifactStore(options.artifactRepository);
    this.pipeline = new EvidenceJobPipeline({
      jobs: this.jobs,
      artifacts: this.artifacts,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    });
    const planAuthority = createFilePlanClaimCandidateAuthority({
      ...(options.topologyV3Enabled === undefined ? {} : { topologyV3Enabled: options.topologyV3Enabled }),
    });
    this.claimCandidates = new OfficialClaimCandidateRepository({
      coordinator: options.coordinator,
      runtimeRoot: options.runtimeRoot,
      now,
      planAuthority,
    });
    this.thirdPartyClaimCandidates = new ThirdPartyClaimCandidateRepository({
      coordinator: options.coordinator,
      runtimeRoot: options.runtimeRoot,
      now,
      planAuthority,
    });
    this.bindingProposals = new EvidenceBindingProposalRepository({
      coordinator: options.coordinator,
      runtimeRoot: options.runtimeRoot,
      now,
      planAuthority,
    });
    const rawServices = { ...createProductionEvidenceStageServices({
      evidenceRepository: options.evidenceRepository,
      evidenceRepositoryForContext: (context: EvidenceStageEffectContext) =>
        fencedEvidenceRepository(options.coordinator, options.evidenceRepository, context, now),
      artifactRepository: options.artifactRepository,
      factRepository: options.factRepository,
      online: options.online ?? (() => false),
      officialFetcher: options.officialFetcher,
      officialRegistry: options.officialRegistry,
      officialClaimExtractor: options.officialClaimExtractor ?? governedAdapters.officialClaimExtractor,
      thirdPartyRegistry: options.thirdPartyRegistry,
      thirdPartyDiscovery: options.thirdPartyDiscovery ?? createDefaultThirdPartyDiscovery(),
      thirdPartyFetcher: options.thirdPartyFetcher,
      thirdPartyClaimExtractor: options.thirdPartyClaimExtractor ?? governedAdapters.thirdPartyClaimExtractor,
      adapterGenerator: options.adapterGenerator ?? governedAdapters.adapterGenerator,
      bindingProposer: options.bindingProposer,
      rateLimiter: options.rateLimiter,
      evidenceOcrLimits: options.evidenceOcrLimits,
      evidenceOcrFaultInjector: options.evidenceOcrFaultInjector,
    }) } as unknown as Record<string, EvidenceStageService>;
    const provisionalAdapterService = provisionalCaseAdapterGenerationService(options);
    if (provisionalAdapterService) rawServices.generateAdapterCandidate = provisionalAdapterService;
    const services = governedServices(rawServices);
    const worker = createEvidenceJobWorker({
      jobs: this.jobs,
      artifacts: this.artifacts,
      services,
      claimCandidates: this.claimCandidates,
      thirdPartyClaimCandidates: this.thirdPartyClaimCandidates,
      bindingProposals: this.bindingProposals,
      workerId: options.workerId ?? `evidence-worker-${process.pid}-${randomUUID()}`,
      online: options.online ?? (() => false),
      now,
    });
    this.scheduler = new DurableJobScheduler(this.jobs, worker);
    this.intervalMs = options.schedulerIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 25 || this.intervalMs > 60_000) {
      throw new TypeError("evidence scheduler interval is invalid");
    }
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        await this.jobs.initialize("evidence-jobs-v1");
        await this.options.artifactRepository.initialize();
        await this.jobs.recoverExpiredLeases();
        await this.jobs.promoteReadyRetries();
      })().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async enqueue(input: unknown): Promise<EvidencePipelineDescriptor> {
    // Validate before any durable write and reject all transport-only seams or
    // unknown fields through the frozen request contract.
    await createEvidencePipelineRequest(input as EvidencePipelineRequestInput);
    return this.pipeline.enqueue(input as EvidencePipelineRequestInput);
  }

  private async requestFor(pipelineId: EvidencePipelineRequest["pipelineId"]): Promise<EvidencePipelineRequest> {
    const first = await this.jobs.get(jobIdForEvidenceStage(pipelineId, EVIDENCE_PIPELINE_STAGES[0]));
    const request = await this.artifacts.getRequest(first.payloadRef);
    if (request.pipelineId !== pipelineId) throw new TypeError("evidence pipeline request identity mismatch");
    return request;
  }

  private async requestForAtRoot(activeRoot: string, pipelineId: EvidencePipelineRequest["pipelineId"]): Promise<EvidencePipelineRequest> {
    const first = await this.jobs.getAtRoot(activeRoot, jobIdForEvidenceStage(pipelineId, EVIDENCE_PIPELINE_STAGES[0]));
    const request = await this.artifacts.getRequestAtRoot(activeRoot, first.payloadRef);
    if (request.pipelineId !== pipelineId) throw new TypeError("evidence pipeline request identity mismatch");
    return request;
  }

  async statusAtRoot(activeRoot: string, rawPipelineId: string): Promise<ProductionEvidenceJobStatus> {
    assertPipelineId(rawPipelineId);
    const request = await this.requestForAtRoot(activeRoot, rawPipelineId);
    const allJobs = await this.jobs.listAtRoot(activeRoot);
    const stages = await Promise.all(EVIDENCE_PIPELINE_STAGES.map(async (currentStage) => {
      const expectedJobId = jobIdForEvidenceStage(rawPipelineId, currentStage);
      const job = allJobs.find(({ jobId }) => jobId === expectedJobId);
      if (!job || job.payloadRef !== allJobs.find(({ jobId }) => jobId === jobIdForEvidenceStage(rawPipelineId, EVIDENCE_PIPELINE_STAGES[0]))?.payloadRef
        || job.planId !== request.planId) {
        throw new TypeError("evidence pipeline job closure is incomplete or cross-plan");
      }
      let result: EvidenceStageResult | null = null;
      let resultRef: string | null = null;
      if (job.status === "succeeded") {
        for (const ref of job.resultRefs) {
          const candidate = await this.artifacts.getResultAtRoot(activeRoot, ref);
          if (candidate?.pipelineId === rawPipelineId && candidate.stage === currentStage && candidate.jobId === job.jobId) {
            if (result) throw new TypeError("evidence job contains multiple stage result receipts");
            result = candidate;
            resultRef = ref;
          }
        }
        if (!result) throw new TypeError("succeeded evidence job does not close its governed result receipt");
        const governedResult = result;
        if (job.checkpointRef !== resultRef || job.resultCommitHash !== await evidenceStageCommitHash(governedResult)
          || job.resultRefs.length !== governedResult.resultRefs.length + 1
          || job.resultRefs.some((ref, index) => ref !== [resultRef, ...governedResult.resultRefs][index])) {
          throw new TypeError("succeeded evidence job does not close its governed result receipt");
        }
        for (const ref of governedResult.resultRefs) {
          if (!await this.artifacts.hasAtRoot(activeRoot, ref)) throw new TypeError("evidence stage result contains a dangling artifact reference");
        }
      }
      return Object.freeze({
        stage: currentStage,
        jobId: job.jobId,
        status: job.status,
        revision: job.revision,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter,
        ...(job.progress === undefined ? {} : { progress: structuredClone(job.progress) }),
        ...(job.lastError === undefined ? {} : { lastError: structuredClone(job.lastError) }),
        ...(result === null ? {} : { result }),
      });
    }));
    return Object.freeze({
      pipelineId: request.pipelineId,
      requestHash: request.requestHash,
      ...(request.planId === undefined ? {} : { planId: request.planId }),
      stages: Object.freeze(stages),
    });
  }

  async listForPlanAtRoot(activeRoot: string, planId: string): Promise<readonly ProductionEvidenceJobStatus[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(planId)) throw new TypeError("evidence summary plan ID is invalid");
    const jobs = await this.jobs.listAtRoot(activeRoot);
    const requestRefs = [...new Set(jobs.filter((job) => job.planId === planId).map(({ payloadRef }) => payloadRef))].sort();
    const requests = await Promise.all(requestRefs.map((ref) => this.artifacts.getRequestAtRoot(activeRoot, ref)));
    const pipelines = requests.filter((request) => request.planId === planId)
      .sort((left, right) => left.pipelineId.localeCompare(right.pipelineId));
    if (new Set(pipelines.map(({ pipelineId }) => pipelineId)).size !== pipelines.length) {
      throw new TypeError("evidence plan summary contains duplicate pipeline identities");
    }
    return Object.freeze(await Promise.all(pipelines.map(({ pipelineId }) => this.statusAtRoot(activeRoot, pipelineId))));
  }

  async listForPlan(planId: string): Promise<readonly ProductionEvidenceJobStatus[]> {
    await this.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) =>
      this.listForPlanAtRoot(activeRoot, planId))).result;
  }

  async status(rawPipelineId: string): Promise<ProductionEvidenceJobStatus> {
    assertPipelineId(rawPipelineId);
    const request = await this.requestFor(rawPipelineId);
    const jobs = await this.pipeline.jobsFor(rawPipelineId);
    const stages = await Promise.all(EVIDENCE_PIPELINE_STAGES.map(async (currentStage) => {
      const job = jobs[currentStage];
      const result = job.status === "succeeded" ? await this.pipeline.result(rawPipelineId, currentStage) : null;
      return Object.freeze({
        stage: currentStage,
        jobId: job.jobId,
        status: job.status,
        revision: job.revision,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        runAfter: job.runAfter,
        ...(job.progress === undefined ? {} : { progress: structuredClone(job.progress) }),
        ...(job.lastError === undefined ? {} : { lastError: structuredClone(job.lastError) }),
        ...(result === null ? {} : { result }),
      });
    }));
    return Object.freeze({
      pipelineId: request.pipelineId,
      requestHash: request.requestHash,
      ...(request.planId === undefined ? {} : { planId: request.planId }),
      stages: Object.freeze(stages),
    });
  }

  async cancel(input: { pipelineId: string; stage: string; expectedRevision: number }): Promise<BackgroundJob> {
    assertPipelineId(input.pipelineId);
    const currentStage = stage(input.stage);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TypeError("expectedRevision is invalid");
    const job = await this.jobs.get(jobIdForEvidenceStage(input.pipelineId, currentStage));
    if (job.revision !== input.expectedRevision) throw new JobRepositoryError("conflict", "job revision changed");
    return this.jobs.cancel(job.jobId, job.revision, job.status === "running" ? currentJobLease(job) : undefined);
  }

  async resume(input: { pipelineId: string; stage: string; expectedRevision: number }): Promise<BackgroundJob> {
    assertPipelineId(input.pipelineId);
    const currentStage = stage(input.stage);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TypeError("expectedRevision is invalid");
    return this.jobs.resume(jobIdForEvidenceStage(input.pipelineId, currentStage), input.expectedRevision);
  }

  async tick(): Promise<Awaited<ReturnType<DurableJobScheduler["tick"]>>> { return this.scheduler.tick(); }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.initialize();
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.scheduler.tick().catch(() => undefined).finally(() => { this.ticking = false; });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function createProductionEvidenceJobRuntime(options: ProductionEvidenceJobRuntimeOptions): ProductionEvidenceJobRuntime {
  if (!options.runtimeRoot || path.resolve(options.runtimeRoot) !== options.coordinator.root) {
    throw new TypeError("evidence jobs runtimeRoot must match the shared RuntimeCoordinator");
  }
  return new ProductionEvidenceJobRuntime(options);
}
