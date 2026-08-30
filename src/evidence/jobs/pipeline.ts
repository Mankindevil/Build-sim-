import {
  FileJobRepository,
  isTerminalJobStatus,
  type BackgroundJob,
  type JobLease,
} from "../../jobs";
import {
  EVIDENCE_NETWORK_STAGES,
  EVIDENCE_PIPELINE_HANDLER_VERSION,
  EVIDENCE_PIPELINE_JOB_TYPES,
  EVIDENCE_PIPELINE_STAGES,
  createEvidencePipelineRequest,
  evidenceStageIdempotencyKey,
  evidenceStageCommitHash,
  evidenceStageInputHash,
  jobIdForEvidenceStage,
  type EvidencePipelineDescriptor,
  type EvidencePipelineRequest,
  type EvidencePipelineRequestInput,
  type EvidencePipelineStage,
  type EvidenceStageResult,
} from "./contracts";
import { EvidenceJobArtifactStore } from "./artifact-store";

export interface EvidenceJobPipelineOptions {
  readonly jobs: FileJobRepository;
  readonly artifacts: EvidenceJobArtifactStore;
  readonly maxAttempts?: number;
}

/**
 * Durable DAG coordinator. It only derives state from content-addressed request
 * artifacts and FileJobRepository records; no process-local pipeline registry
 * is authoritative or needed after restart.
 */
export class EvidenceJobPipeline {
  readonly jobs: FileJobRepository;
  readonly artifacts: EvidenceJobArtifactStore;
  private readonly maxAttempts: number;

  constructor(options: EvidenceJobPipelineOptions) {
    this.jobs = options.jobs;
    this.artifacts = options.artifacts;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 100) {
      throw new TypeError("evidence pipeline maxAttempts is invalid");
    }
  }

  async enqueue(input: EvidencePipelineRequestInput): Promise<EvidencePipelineDescriptor> {
    const request = await createEvidencePipelineRequest(input);
    const requestRef = await this.artifacts.putRequest(request);
    const jobIds = {} as Record<EvidencePipelineStage, string>;
    for (let index = 0; index < EVIDENCE_PIPELINE_STAGES.length; index += 1) {
      const stage = EVIDENCE_PIPELINE_STAGES[index]!;
      const dependencyJobIds = index === 0 ? [] : [jobIds[EVIDENCE_PIPELINE_STAGES[index - 1]!]!];
      const created = await this.jobs.create({
        type: EVIDENCE_PIPELINE_JOB_TYPES[stage],
        handlerVersion: EVIDENCE_PIPELINE_HANDLER_VERSION,
        idempotencyKey: evidenceStageIdempotencyKey(request.pipelineId, stage),
        inputHash: await evidenceStageInputHash(request, stage, dependencyJobIds),
        payloadRef: requestRef,
        ...(request.planId === undefined ? {} : { planId: request.planId }),
        maxAttempts: this.maxAttempts,
        networkRequired: (EVIDENCE_NETWORK_STAGES as readonly EvidencePipelineStage[]).includes(stage),
        dependencyJobIds,
      });
      const expectedJobId = jobIdForEvidenceStage(request.pipelineId, stage);
      if (created.job.jobId !== expectedJobId) throw new TypeError("evidence job repository returned a non-deterministic job identity");
      jobIds[stage] = created.job.jobId;
    }
    return Object.freeze({
      pipelineId: request.pipelineId,
      requestRef,
      requestHash: request.requestHash,
      jobIds: Object.freeze({ ...jobIds }),
    });
  }

  async request(descriptor: Pick<EvidencePipelineDescriptor, "pipelineId" | "requestRef" | "requestHash">): Promise<EvidencePipelineRequest> {
    const request = await this.artifacts.getRequest(descriptor.requestRef);
    if (request.pipelineId !== descriptor.pipelineId || request.requestHash !== descriptor.requestHash) {
      throw new TypeError("evidence pipeline descriptor does not match its governed request artifact");
    }
    return request;
  }

  async jobsFor(pipelineId: EvidencePipelineRequest["pipelineId"]): Promise<Readonly<Record<EvidencePipelineStage, BackgroundJob>>> {
    const entries = await Promise.all(EVIDENCE_PIPELINE_STAGES.map(async (stage) => [
      stage,
      await this.jobs.get(jobIdForEvidenceStage(pipelineId, stage)),
    ] as const));
    return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<EvidencePipelineStage, BackgroundJob>>;
  }

  async result(pipelineId: EvidencePipelineRequest["pipelineId"], stage: EvidencePipelineStage): Promise<EvidenceStageResult | null> {
    const job = await this.jobs.get(jobIdForEvidenceStage(pipelineId, stage));
    if (job.status !== "succeeded") return null;
    let result: EvidenceStageResult | null = null;
    let resultRef: string | null = null;
    for (const ref of job.resultRefs) {
      const candidate = await this.artifacts.getResult(ref);
      if (candidate?.pipelineId === pipelineId && candidate.stage === stage && candidate.jobId === job.jobId) {
        if (result) throw new TypeError("evidence job contains multiple stage result receipts");
        result = candidate;
        resultRef = ref;
      }
    }
    if (!result) throw new TypeError("succeeded evidence job has no governed stage result receipt");
    if (job.checkpointRef !== resultRef || job.resultCommitHash !== await evidenceStageCommitHash(result)
      || job.resultRefs.length !== result.resultRefs.length + 1
      || job.resultRefs.some((ref, index) => ref !== [resultRef, ...result.resultRefs][index])) {
      throw new TypeError("succeeded evidence job commit does not close its governed result receipt");
    }
    for (const ref of result.resultRefs) {
      if (!await this.artifacts.repository.get(ref)) throw new TypeError("evidence stage result contains a dangling artifact reference");
    }
    return result;
  }

  async resumeOffline(pipelineId: EvidencePipelineRequest["pipelineId"]): Promise<number> {
    const jobs = await this.jobsFor(pipelineId);
    let resumed = 0;
    for (const stage of EVIDENCE_PIPELINE_STAGES) {
      const job = jobs[stage];
      if (job.status !== "paused_offline") continue;
      await this.jobs.resume(job.jobId, job.revision);
      resumed += 1;
    }
    return resumed;
  }

  async cancelStage(input: {
    pipelineId: EvidencePipelineRequest["pipelineId"];
    stage: EvidencePipelineStage;
    expectedRevision: number;
    lease?: JobLease;
  }): Promise<BackgroundJob> {
    return this.jobs.cancel(jobIdForEvidenceStage(input.pipelineId, input.stage), input.expectedRevision, input.lease);
  }

  async cancelRemaining(pipelineId: EvidencePipelineRequest["pipelineId"]): Promise<number> {
    const jobs = await this.jobsFor(pipelineId);
    let cancelled = 0;
    for (const stage of [...EVIDENCE_PIPELINE_STAGES].reverse()) {
      const job = jobs[stage];
      if (isTerminalJobStatus(job.status) || job.status === "running") continue;
      const result = await this.jobs.cancel(job.jobId, job.revision);
      if (result.status === "cancelled") cancelled += 1;
    }
    return cancelled;
  }
}
