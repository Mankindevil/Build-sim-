import { createHash } from "node:crypto";
import { createEvidenceClaim } from "../claims";
import {
  assessThirdPartySourceIndependence,
  evaluateOfficialDocumentPromotion,
  type OfficialDocumentPromotionInput,
  type ThirdPartyEvidenceFinding,
  type ThirdPartyEvidenceSource,
} from "../ladder.mjs";
import { validateEvidenceSearchOutcome } from "../search-outcome.mjs";
import { officialClaimCandidateIdRuntime } from "../claim-candidate-runtime.mjs";
import type { OfficialClaimCandidateSink } from "../claim-candidate-repository";
import { thirdPartyClaimCandidateIdRuntime } from "../third-party-claim-candidate-runtime.mjs";
import type { ThirdPartyClaimCandidateSink } from "../third-party-claim-candidate-repository";
import { validateEvidenceBindingProposalRuntime } from "../binding-proposal-runtime.mjs";
import type { EvidenceBindingProposalSink } from "../binding-proposal-repository";
import {
  DurableJobWorker,
  JobHandlerError,
  type BackgroundJobHandler,
  type FileJobRepository,
  type JobHandlerContext,
  type JobLease,
} from "../../jobs";
import {
  EVIDENCE_NETWORK_STAGES,
  EVIDENCE_PIPELINE_HANDLER_VERSION,
  EVIDENCE_PIPELINE_JOB_TYPES,
  EVIDENCE_PIPELINE_STAGES,
  assertEvidenceStageEffectResult,
  evidenceStageCommitHash,
  evidenceStageIdempotencyKey,
  jobIdForEvidenceStage,
  type EvidenceClaimCandidateOutput,
  type EvidenceOfficialSearchReason,
  type EvidencePipelineRequest,
  type EvidencePipelineStage,
  type EvidenceStageAttemptCheckpoint,
  type EvidenceStageEffectResult,
  type EvidenceStageResult,
} from "./contracts";
import { EvidenceJobArtifactStore, type EvidenceJobArtifactFence } from "./artifact-store";

export interface EvidenceStageArtifactInput {
  readonly kind: `evidence-${string}`;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly privacyClass?: "public_source" | "private_user" | "runtime_internal";
  readonly references?: readonly string[];
}

export interface EvidenceStageEffectContext {
  readonly request: EvidencePipelineRequest;
  readonly stage: EvidencePipelineStage;
  readonly priorResults: readonly EvidenceStageResult[];
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly fencingToken: string;
  readonly expectedRevision: number;
  readonly runtimeGeneration: number;
  /** Exact immutable request + prior governed result closure for this attempt. */
  readonly inputRefs: readonly string[];
  /** Durable pre-effect checkpoint; stable across crash/restart replay. */
  readonly attemptRef: `sha256:${string}`;
  /** Stable across retries after the pre-effect checkpoint is durable. */
  readonly attemptStartedAt: string;
  /** For a URL entry this is the canonical origin; search adapters use a governed registry key. */
  readonly rateLimitKey: string;
  putArtifact(input: EvidenceStageArtifactInput): Promise<{ ref: string; created: boolean }>;
  /** Must be invoked before writing an artifact when required network is unavailable. */
  pauseOffline(): Promise<never>;
}

export type EvidenceStageService = (context: EvidenceStageEffectContext) => Promise<EvidenceStageEffectResult>;

/** Named contracts make the minimum U4 production handler set explicit. */
export interface EvidencePipelineServices {
  readonly officialDiscovery: EvidenceStageService;
  readonly officialAcquire: EvidenceStageService;
  readonly archive: EvidenceStageService;
  readonly parseOrOcr: EvidenceStageService;
  readonly excerpt: EvidenceStageService;
  readonly extractClaims: EvidenceStageService;
  readonly thirdPartyFallback: EvidenceStageService;
  readonly assessFactImpact: EvidenceStageService;
  readonly generateAdapterCandidate: EvidenceStageService;
  readonly proposeBinding: EvidenceStageService;
}

const SERVICE_BY_STAGE: Readonly<Record<EvidencePipelineStage, keyof EvidencePipelineServices>> = Object.freeze({
  official_discovery: "officialDiscovery",
  official_acquisition: "officialAcquire",
  archive: "archive",
  parse_ocr: "parseOrOcr",
  excerpt: "excerpt",
  claim_extraction: "extractClaims",
  third_party_fallback: "thirdPartyFallback",
  fact_impact: "assessFactImpact",
  adapter_generation: "generateAdapterCandidate",
  binding_proposal: "proposeBinding",
});

export class EvidenceStageOfflineError extends Error {
  constructor() {
    super("evidence stage network is offline");
    this.name = "EvidenceStageOfflineError";
  }
}

export class EvidenceStageRetryableError extends Error {
  constructor(
    readonly code: string,
    readonly redactedMessage: string,
    readonly retryAt?: string,
  ) {
    super(redactedMessage);
    this.name = "EvidenceStageRetryableError";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || !redactedMessage || redactedMessage.length > 512
      || /(?:api[_-]?key|authorization|bearer|cookie|password)\s*[:=]/i.test(redactedMessage)
      || (retryAt !== undefined && !Number.isFinite(Date.parse(retryAt)))) {
      throw new TypeError("evidence retry error is not safely redacted");
    }
  }
}

export interface EvidenceJobHandlerFactoryOptions {
  readonly jobs: FileJobRepository;
  readonly artifacts: EvidenceJobArtifactStore;
  readonly services: EvidencePipelineServices;
  readonly claimCandidates?: OfficialClaimCandidateSink;
  readonly thirdPartyClaimCandidates?: ThirdPartyClaimCandidateSink;
  readonly bindingProposals?: EvidenceBindingProposalSink;
  readonly now?: () => string;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function currentFence(context: JobHandlerContext): EvidenceJobArtifactFence {
  const lease: JobLease = context.currentLease();
  return { jobId: context.job.jobId, ...lease };
}

function rateLimitKey(request: EvidencePipelineRequest): string {
  if (request.entry.kind === "official_url") return new URL(request.entry.url).origin;
  return `governed-search:${request.subject.brand.toLocaleLowerCase("en-US")}`;
}

function retryAtFor(jobId: string, attempt: number, from: string): string {
  const baseMs = Math.min(300_000, 1_000 * 2 ** Math.min(12, Math.max(0, attempt - 1)));
  const byte = Number.parseInt(createHash("sha256").update(`${jobId}:${attempt}`, "utf8").digest("hex").slice(0, 2), 16);
  const jitter = 0.75 + byte / 510;
  return new Date(Date.parse(from) + Math.round(baseMs * jitter)).toISOString();
}

function propagatedReason(priorResults: readonly EvidenceStageResult[]): EvidenceOfficialSearchReason | undefined {
  return [...priorResults].reverse().find((result) => result.officialSearchReason !== undefined)?.officialSearchReason;
}

function searchOutcomeFrom(priorResults: readonly EvidenceStageResult[]): unknown {
  return [...priorResults].reverse().map((result) => result.output.searchOutcome).find((value) => value !== undefined);
}

function reasonField(priorResults: readonly EvidenceStageResult[]): { officialSearchReason: EvidenceOfficialSearchReason } | Record<string, never> {
  const reason = propagatedReason(priorResults);
  return reason === undefined ? {} : { officialSearchReason: reason };
}

function automaticResult(
  stage: EvidencePipelineStage,
  request: EvidencePipelineRequest,
  priorResults: readonly EvidenceStageResult[],
): EvidenceStageEffectResult | null {
  const officialStages: readonly EvidencePipelineStage[] = [
    "official_discovery", "official_acquisition", "archive", "parse_ocr", "excerpt", "claim_extraction",
  ];
  if (officialStages.includes(stage) && stage !== "official_discovery") {
    const previousOfficial = priorResults.filter((result) => officialStages.includes(result.stage)).at(-1);
    if (previousOfficial?.status !== "completed") {
      return {
        status: "skipped",
        output: Object.freeze({
          reason: "upstream_official_evidence_unavailable",
          ...(searchOutcomeFrom(priorResults) === undefined ? {} : { searchOutcome: searchOutcomeFrom(priorResults) }),
        }),
        ...reasonField(priorResults),
      };
    }
  }
  if (stage === "third_party_fallback") {
    const officialClaims = priorResults.find((result) => result.stage === "claim_extraction");
    if (officialClaims?.status === "completed") {
      return { status: "skipped", output: Object.freeze({ reason: "official_evidence_sufficient" }) };
    }
    if (!request.allowThirdPartyFallback) {
      return {
        status: "blocked",
        output: Object.freeze({
          reason: "third_party_fallback_not_authorized",
          ...(searchOutcomeFrom(priorResults) === undefined ? {} : { searchOutcome: searchOutcomeFrom(priorResults) }),
        }),
        ...reasonField(priorResults),
      };
    }
  }
  if (stage === "fact_impact") {
    const hasClaims = priorResults.some((result) => ["claim_extraction", "third_party_fallback"].includes(result.stage)
      && result.status === "completed");
    if (!hasClaims) {
      return {
        status: "blocked",
        output: Object.freeze({
          reason: "no_governed_claim_candidate",
          ...(searchOutcomeFrom(priorResults) === undefined ? {} : { searchOutcome: searchOutcomeFrom(priorResults) }),
        }),
        ...reasonField(priorResults),
      };
    }
  }
  if (stage === "adapter_generation" && priorResults.find((result) => result.stage === "fact_impact")?.status !== "completed") {
    return { status: "blocked", output: Object.freeze({ reason: "fact_impact_not_completed" }) };
  }
  if (stage === "binding_proposal" && priorResults.find((result) => result.stage === "adapter_generation")?.status !== "completed") {
    return { status: "blocked", output: Object.freeze({ reason: "adapter_candidate_not_completed" }) };
  }
  return null;
}

function sameCandidateIdentity(
  candidate: EvidenceClaimCandidateOutput["claimCandidates"][number],
  identity: { skuId: string; familyId: string; modelId: string; variantId?: string; revision?: string; region?: string },
): boolean {
  return candidate.subject.skuId === identity.skuId && candidate.subject.familyId === identity.familyId
    && candidate.subject.modelId === identity.modelId && candidate.subject.variantId === identity.variantId
    && candidate.subject.revision === identity.revision && candidate.subject.region === identity.region;
}

async function normalizeAndValidateEffectSemantics(
  stage: EvidencePipelineStage,
  result: EvidenceStageEffectResult,
  request?: EvidencePipelineRequest,
): Promise<EvidenceStageEffectResult> {
  assertEvidenceStageEffectResult(result);
  if (result.officialSearchReason !== undefined) {
    const outcome = result.output.searchOutcome;
    const errors = validateEvidenceSearchOutcome(outcome);
    if (!Array.isArray(errors) || errors.length > 0 || (outcome as { reason?: unknown }).reason !== result.officialSearchReason) {
      throw new TypeError("official search reason must be derived from a valid audited search outcome");
    }
  }
  let governedOutput: Readonly<Record<string, unknown>> = result.output;
  if ((stage === "claim_extraction" || stage === "third_party_fallback") && result.status === "completed") {
    const candidates = (result.output as unknown as Partial<EvidenceClaimCandidateOutput>).claimCandidates;
    if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 512) {
      throw new TypeError("completed claim stage requires bounded EvidenceClaimInput candidates");
    }
    const expectedAuthority = stage === "claim_extraction" ? "official" : "third_party";
    for (const candidate of candidates) {
      if (candidate.authority !== expectedAuthority) throw new TypeError(`${stage} claim authority is invalid`);
      await createEvidenceClaim(candidate);
    }
    if (stage === "claim_extraction") {
      const promotion = evaluateOfficialDocumentPromotion(result.output.officialPromotionInput as OfficialDocumentPromotionInput);
      if (!promotion.eligible || promotion.identity.basis !== "official-document-explicit") {
        throw new TypeError("official claim extraction lacks an eligible exact document identity promotion");
      }
      if (candidates.some((candidate) => candidate.source.documentSha256 !== (result.output.officialPromotionInput as OfficialDocumentPromotionInput).documentSha256
        || !sameCandidateIdentity(candidate, promotion.identity))) {
        throw new TypeError("official claim candidate does not close the promoted document identity");
      }
      const claims = await Promise.all(candidates.map((candidate) => createEvidenceClaim(candidate)));
      const claimCandidateIds = request?.planId ? claims.map((claim, candidateIndex) => officialClaimCandidateIdRuntime({
        planId: request.planId!, pipelineId: request.pipelineId, candidateIndex,
        claimId: claim.claimId, confirmationId: promotion.confirmationId,
      })) : [];
      if (claimCandidateIds.some((candidateId) => candidateId === null)) throw new TypeError("official claim candidate identity cannot be derived");
      governedOutput = Object.freeze({
        ...structuredClone(result.output),
        officialPromotion: promotion,
        ...(request?.planId ? { claimCandidateIds: Object.freeze(claimCandidateIds) } : {}),
      });
    } else {
      const sources = result.output.thirdPartySources as readonly ThirdPartyEvidenceSource[];
      const findings = result.output.thirdPartyFindings as readonly ThirdPartyEvidenceFinding[];
      const assessment = assessThirdPartySourceIndependence(sources, {
        findings,
        assessedAt: (result.output.assessedAt as string | undefined) ?? candidates[0]!.retrievedAt,
      });
      if (assessment.conflicted || assessment.confidence === "none" || assessment.ladderLevel === null) {
        throw new TypeError("third-party claim extraction lacks a qualifying independent professional source");
      }
      if (candidates.some((candidate) => !sources.some((source) => source.sourceContentHash === candidate.source.documentSha256
        && sameCandidateIdentity(candidate, source.subject)))) {
        throw new TypeError("third-party claim candidate does not close a qualifying source identity");
      }
      const claims = await Promise.all(candidates.map((candidate) => createEvidenceClaim(candidate)));
      const claimCandidateIds = request?.planId ? claims.map((claim, candidateIndex) => {
        const matchingSources = sources.filter((source) => source.sourceContentHash === claim.source.documentSha256
          && sameCandidateIdentity(claim, source.subject));
        if (matchingSources.length !== 1) return null;
        return thirdPartyClaimCandidateIdRuntime({
          planId: request.planId!,
          pipelineId: request.pipelineId,
          candidateIndex,
          claimId: claim.claimId,
          sourceId: matchingSources[0]!.sourceId,
          assessmentId: assessment.assessmentId,
        });
      }) : [];
      if (claimCandidateIds.some((candidateId) => candidateId === null)) {
        throw new TypeError("third-party claim candidate identity cannot be derived uniquely");
      }
      governedOutput = Object.freeze({
        ...structuredClone(result.output),
        independenceAssessment: assessment,
        ...(request?.planId ? { claimCandidateIds: Object.freeze(claimCandidateIds) } : {}),
      });
    }
  }
  if (stage === "binding_proposal" && result.status === "completed"
    && validateEvidenceBindingProposalRuntime(governedOutput).length) {
    throw new TypeError("completed binding proposal lacks a strict durable ID/hash authority");
  }
  return Object.freeze({
    status: result.status,
    output: governedOutput,
    ...(result.resultRefs === undefined ? {} : { resultRefs: result.resultRefs }),
    ...(result.officialSearchReason === undefined ? {} : { officialSearchReason: result.officialSearchReason }),
  });
}

async function loadPriorResults(
  jobs: FileJobRepository,
  artifacts: EvidenceJobArtifactStore,
  request: EvidencePipelineRequest,
  stage: EvidencePipelineStage,
): Promise<Array<{ result: EvidenceStageResult; ref: string }>> {
  const priorStages = EVIDENCE_PIPELINE_STAGES.slice(0, EVIDENCE_PIPELINE_STAGES.indexOf(stage));
  const resolved: Array<{ result: EvidenceStageResult; ref: string }> = [];
  for (const priorStage of priorStages) {
    const job = await jobs.get(jobIdForEvidenceStage(request.pipelineId, priorStage));
    if (job.status !== "succeeded") continue;
    let match: { result: EvidenceStageResult; ref: string } | null = null;
    for (const ref of job.resultRefs) {
      const result = await artifacts.getResult(ref);
      if (result?.pipelineId === request.pipelineId && result.stage === priorStage && result.jobId === job.jobId) {
        if (match) throw new TypeError("job contains multiple governed stage result artifacts");
        match = { result, ref };
      }
    }
    if (!match) throw new TypeError("succeeded evidence job is missing its governed stage result");
    if (job.checkpointRef !== match.ref || job.resultCommitHash !== await evidenceStageCommitHash(match.result)
      || !sameStrings(job.resultRefs, [match.ref, ...match.result.resultRefs])) {
      throw new TypeError("succeeded evidence job commit does not close its governed stage result");
    }
    await validateEffectRefs(artifacts, match.result.resultRefs);
    resolved.push(match);
  }
  return resolved;
}

async function validateEffectRefs(artifacts: EvidenceJobArtifactStore, refs: readonly string[]): Promise<void> {
  if (refs.some((ref) => !/^sha256:[a-f0-9]{64}$/.test(ref)) || new Set(refs).size !== refs.length) {
    throw new TypeError("evidence stage result references must be unique content-addressed artifacts");
  }
  for (const ref of refs) {
    if (!await artifacts.repository.get(ref)) throw new TypeError("evidence stage result contains a dangling artifact reference");
  }
}

function validateCheckpointIdentity(
  checkpoint: EvidenceStageAttemptCheckpoint | EvidenceStageResult,
  request: EvidencePipelineRequest,
  stage: EvidencePipelineStage,
  context: JobHandlerContext,
  inputRefs: readonly string[],
): void {
  if (checkpoint.pipelineId !== request.pipelineId || checkpoint.stage !== stage || checkpoint.jobId !== context.job.jobId
    || !sameStrings(checkpoint.inputRefs, inputRefs)) {
    throw new TypeError("evidence checkpoint does not match the active job input closure");
  }
}

export function createEvidenceJobHandlers(options: EvidenceJobHandlerFactoryOptions): ReadonlyMap<string, BackgroundJobHandler> {
  const now = options.now ?? (() => new Date().toISOString());
  return new Map(EVIDENCE_PIPELINE_STAGES.map((stage) => {
    const key = `${EVIDENCE_PIPELINE_JOB_TYPES[stage]}@${EVIDENCE_PIPELINE_HANDLER_VERSION}`;
    const handler: BackgroundJobHandler = async (context) => {
      let governedEffectWritten = false;
      try {
        const request = await options.artifacts.getRequest(context.payloadRef);
        if (context.job.jobId !== jobIdForEvidenceStage(request.pipelineId, stage)
          || context.idempotencyKey !== evidenceStageIdempotencyKey(request.pipelineId, stage)) {
          throw new TypeError("evidence job identity does not match its authoritative request");
        }
        const prior = await loadPriorResults(options.jobs, options.artifacts, request, stage);
        const inputRefs = Object.freeze([context.payloadRef, ...prior.map(({ ref }) => ref)]);

        let attempt: EvidenceStageAttemptCheckpoint | null = null;
        let attemptRef: `sha256:${string}` | null = null;
        if (context.job.checkpointRef) {
          const completed = await options.artifacts.getResult(context.job.checkpointRef);
          if (completed) {
            validateCheckpointIdentity(completed, request, stage, context, inputRefs);
            const replay = await normalizeAndValidateEffectSemantics(stage, {
              status: completed.status,
              output: completed.output,
              resultRefs: completed.resultRefs,
              ...(completed.officialSearchReason === undefined ? {} : { officialSearchReason: completed.officialSearchReason }),
            }, request);
            await validateEffectRefs(options.artifacts, replay.resultRefs ?? []);
            const commitHash = await evidenceStageCommitHash(completed);
            return { resultRefs: [context.job.checkpointRef, ...completed.resultRefs], resultCommitHash: commitHash };
          }
          attempt = await options.artifacts.getAttempt(context.job.checkpointRef);
          if (!attempt) throw new TypeError("evidence job checkpoint has an unknown artifact kind");
          validateCheckpointIdentity(attempt, request, stage, context, inputRefs);
          attemptRef = context.job.checkpointRef as `sha256:${string}`;
        }
        if (!attempt) {
          const attemptStartedAt = new Date(now()).toISOString();
          attempt = Object.freeze({
            schemaVersion: "evidence-stage-attempt-v1",
            pipelineId: request.pipelineId,
            stage,
            jobId: context.job.jobId,
            attemptStartedAt,
            inputRefs,
          });
          attemptRef = await options.artifacts.putAttempt(attempt, currentFence(context)) as `sha256:${string}`;
          await context.checkpoint(attemptRef, { stage, completed: 0, total: 1 });
        }
        if (!attemptRef) throw new TypeError("evidence stage attempt authority is missing");

        const automatic = automaticResult(stage, request, prior.map(({ result }) => result));
        let effect: EvidenceStageEffectResult;
        if (automatic) effect = automatic;
        else {
          const service = options.services[SERVICE_BY_STAGE[stage]];
          const lease = context.currentLease();
          effect = await service(Object.freeze({
            request,
            stage,
            priorResults: Object.freeze(prior.map(({ result }) => result)),
            idempotencyKey: context.idempotencyKey,
            jobId: context.job.jobId,
            fencingToken: lease.leaseToken,
            expectedRevision: lease.expectedRevision,
            runtimeGeneration: lease.runtimeGeneration,
            inputRefs,
            attemptRef,
            attemptStartedAt: attempt.attemptStartedAt,
            rateLimitKey: rateLimitKey(request),
            putArtifact: async (input: EvidenceStageArtifactInput) => {
              const stored = await options.artifacts.putStageArtifact({
                ...input,
                stage,
                createdAt: attempt!.attemptStartedAt,
              }, currentFence(context));
              governedEffectWritten = true;
              return stored;
            },
            pauseOffline: async (): Promise<never> => {
              if (governedEffectWritten) {
                throw new JobHandlerError("offline_after_effect", "Offline pause was requested after a governed stage effect", false);
              }
              throw new EvidenceStageOfflineError();
            },
          }));
        }
        effect = await normalizeAndValidateEffectSemantics(stage, effect, request);
        const effectRefs = Object.freeze([...(effect.resultRefs ?? [])]);
        await validateEffectRefs(options.artifacts, effectRefs);
        const result: EvidenceStageResult = Object.freeze({
          schemaVersion: "evidence-stage-result-v1",
          pipelineId: request.pipelineId,
          stage,
          handlerVersion: EVIDENCE_PIPELINE_HANDLER_VERSION,
          jobId: context.job.jobId,
          idempotencyKey: context.idempotencyKey,
          attemptStartedAt: attempt.attemptStartedAt,
          // The transaction clock is deliberately stable across crash replay.
          completedAt: attempt.attemptStartedAt,
          status: effect.status,
          inputRefs,
          output: Object.freeze(structuredClone(effect.output)),
          resultRefs: effectRefs,
          ...(effect.officialSearchReason === undefined ? {} : { officialSearchReason: effect.officialSearchReason }),
        });
        const resultRef = await options.artifacts.putResult(result, currentFence(context));
        if (stage === "claim_extraction" && result.status === "completed"
          && Array.isArray(result.output.claimCandidateIds) && options.claimCandidates) {
          await options.claimCandidates.putFromStageResult(result, resultRef, currentFence(context));
          governedEffectWritten = true;
        }
        if (stage === "third_party_fallback" && result.status === "completed"
          && Array.isArray(result.output.claimCandidateIds) && options.thirdPartyClaimCandidates) {
          await options.thirdPartyClaimCandidates.putFromStageResult(result, resultRef, currentFence(context));
          governedEffectWritten = true;
        }
        if (stage === "binding_proposal" && result.status === "completed" && options.bindingProposals) {
          await options.bindingProposals.putFromStageResult(result, resultRef, currentFence(context));
          governedEffectWritten = true;
        }
        await context.checkpoint(resultRef, { stage, completed: 1, total: 1 });
        return { resultRefs: [resultRef, ...result.resultRefs], resultCommitHash: await evidenceStageCommitHash(result) };
      } catch (error) {
        if (error instanceof EvidenceStageOfflineError) {
          if (governedEffectWritten) {
            throw new JobHandlerError("offline_after_effect", "Offline pause was requested after a governed stage effect", false);
          }
          if (!(EVIDENCE_NETWORK_STAGES as readonly EvidencePipelineStage[]).includes(stage)) {
            throw new JobHandlerError("offline_invalid_stage", "A non-network evidence stage reported an offline transition", false);
          }
          return context.pauseOffline({ stage, completed: 0, total: 1 });
        }
        if (error instanceof EvidenceStageRetryableError) {
          const from = new Date(now()).toISOString();
          throw new JobHandlerError(
            error.code,
            error.redactedMessage,
            true,
            error.retryAt ?? retryAtFor(context.job.jobId, context.job.attempt, from),
          );
        }
        if (error instanceof JobHandlerError) throw error;
        throw new JobHandlerError("evidence_contract_failure", "Evidence job input, checkpoint, or governed output failed validation", false);
      }
    };
    return [key, handler] as const;
  }));
}

export function createEvidenceJobWorker(options: EvidenceJobHandlerFactoryOptions & {
  readonly workerId: string;
  readonly online?: () => boolean | Promise<boolean>;
}): DurableJobWorker {
  return new DurableJobWorker({
    repository: options.jobs,
    workerId: options.workerId,
    handlers: createEvidenceJobHandlers(options),
    types: Object.values(EVIDENCE_PIPELINE_JOB_TYPES),
    ...(options.online === undefined ? {} : { online: options.online }),
  });
}
