import { canonicalize } from "../../hash";
import type { JobLease } from "../../jobs";
import {
  validateEvidenceStageAttempt,
  validateEvidenceStageResult,
  verifyEvidencePipelineRequest,
  type EvidencePipelineRequest,
  type EvidencePipelineStage,
  type EvidenceStageAttemptCheckpoint,
  type EvidenceStageResult,
} from "./contracts";

export const EVIDENCE_JOB_MEDIA_TYPE = "application/vnd.buildsim.evidence-job+json" as const;

export interface EvidenceArtifactRecord {
  readonly ref: string;
  readonly mediaType: string;
  readonly kind: string;
  readonly privacyClass: string;
}

export interface EvidenceArtifactRepository {
  put(input: {
    bytes: Uint8Array;
    mediaType: string;
    privacyClass: "public_source" | "private_user" | "runtime_internal";
    kind: string;
    references?: ReadonlyArray<{ ref: string; necessity: "required_for_replay" | "optional_for_audit" }>;
    createdAt?: string;
  }, options?: {
    expectedRuntimeGeneration?: number;
    expectedJobLease?: {
      jobId: string;
      expectedRevision: number;
      leaseToken: string;
      runtimeGeneration: number;
    };
  }): Promise<{ record: EvidenceArtifactRecord; created: boolean }>;
  get(ref: string): Promise<{ record: EvidenceArtifactRecord; bytes: Uint8Array } | null>;
  /** Optional root-pinned read seam implemented by FileArtifactRepository. */
  repositoryRoot?(activeRoot?: string): Promise<string>;
  getAt?(root: string, ref: string, options?: { initialize?: boolean; allowMissingManifest?: boolean }): Promise<{
    record: EvidenceArtifactRecord;
    bytes: Uint8Array;
  } | null>;
}

export interface EvidenceJobArtifactFence extends JobLease {
  readonly jobId: string;
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function requiredReferences(refs: readonly string[]) {
  return [...new Set(refs)].map((ref) => ({ ref, necessity: "required_for_replay" as const }));
}

function fencedOptions(fence: EvidenceJobArtifactFence | undefined) {
  if (!fence) return undefined;
  return {
    expectedRuntimeGeneration: fence.runtimeGeneration,
    expectedJobLease: {
      jobId: fence.jobId,
      expectedRevision: fence.expectedRevision,
      leaseToken: fence.leaseToken,
      runtimeGeneration: fence.runtimeGeneration,
    },
  };
}

function parseJsonArtifact(value: { record: EvidenceArtifactRecord; bytes: Uint8Array } | null, kind: string): unknown {
  if (!value || value.record.kind !== kind || value.record.mediaType !== EVIDENCE_JOB_MEDIA_TYPE || value.bytes.byteLength > 4 * 1024 * 1024) {
    throw new TypeError(`evidence artifact ${kind} is missing or has invalid governed metadata`);
  }
  try {
    return JSON.parse(Buffer.from(value.bytes).toString("utf8"));
  } catch {
    throw new TypeError(`evidence artifact ${kind} is not valid JSON`);
  }
}

/**
 * Content-addressed durable state for the evidence DAG. The artifact repository
 * performs runtime-generation and active job-lease fencing in the same write
 * barrier as every stage side-effect receipt.
 */
export class EvidenceJobArtifactStore {
  constructor(readonly repository: EvidenceArtifactRepository) {}

  async putRequest(request: EvidencePipelineRequest): Promise<string> {
    if (!await verifyEvidencePipelineRequest(request)) throw new TypeError("evidence pipeline request is invalid");
    const stored = await this.repository.put({
      bytes: bytes(request),
      mediaType: EVIDENCE_JOB_MEDIA_TYPE,
      privacyClass: "runtime_internal",
      kind: "evidence-pipeline-request",
      references: [],
      createdAt: request.requestedAt,
    });
    return stored.record.ref;
  }

  async getRequest(ref: string): Promise<EvidencePipelineRequest> {
    const request = parseJsonArtifact(await this.repository.get(ref), "evidence-pipeline-request");
    if (!await verifyEvidencePipelineRequest(request)) throw new TypeError("evidence pipeline request content is invalid");
    return request as EvidencePipelineRequest;
  }

  private async getAtActiveRoot(activeRoot: string, ref: string): Promise<{
    record: EvidenceArtifactRecord;
    bytes: Uint8Array;
  } | null> {
    if (!this.repository.repositoryRoot || !this.repository.getAt) {
      throw new TypeError("root-pinned evidence artifact authority is unavailable");
    }
    const root = await this.repository.repositoryRoot(activeRoot);
    return this.repository.getAt(root, ref, { initialize: false });
  }

  async getRequestAtRoot(activeRoot: string, ref: string): Promise<EvidencePipelineRequest> {
    const request = parseJsonArtifact(await this.getAtActiveRoot(activeRoot, ref), "evidence-pipeline-request");
    if (!await verifyEvidencePipelineRequest(request)) throw new TypeError("evidence pipeline request content is invalid");
    return request as EvidencePipelineRequest;
  }

  async putAttempt(attempt: EvidenceStageAttemptCheckpoint, fence: EvidenceJobArtifactFence): Promise<string> {
    if (!validateEvidenceStageAttempt(attempt)) throw new TypeError("evidence stage attempt checkpoint is invalid");
    const stored = await this.repository.put({
      bytes: bytes(attempt),
      mediaType: EVIDENCE_JOB_MEDIA_TYPE,
      privacyClass: "runtime_internal",
      kind: "evidence-stage-attempt",
      references: requiredReferences(attempt.inputRefs),
      createdAt: attempt.attemptStartedAt,
    }, fencedOptions(fence));
    return stored.record.ref;
  }

  async putResult(result: EvidenceStageResult, fence: EvidenceJobArtifactFence): Promise<string> {
    if (!validateEvidenceStageResult(result)) throw new TypeError("evidence stage result is invalid");
    const stored = await this.repository.put({
      bytes: bytes(result),
      mediaType: EVIDENCE_JOB_MEDIA_TYPE,
      privacyClass: "runtime_internal",
      kind: "evidence-stage-result",
      references: requiredReferences([...result.inputRefs, ...result.resultRefs]),
      createdAt: result.completedAt,
    }, fencedOptions(fence));
    return stored.record.ref;
  }

  async getAttempt(ref: string): Promise<EvidenceStageAttemptCheckpoint | null> {
    const artifact = await this.repository.get(ref);
    if (!artifact || artifact.record.kind !== "evidence-stage-attempt") return null;
    const attempt = parseJsonArtifact(artifact, "evidence-stage-attempt");
    if (!validateEvidenceStageAttempt(attempt)) throw new TypeError("evidence stage attempt checkpoint content is invalid");
    return attempt;
  }

  async getResult(ref: string): Promise<EvidenceStageResult | null> {
    const artifact = await this.repository.get(ref);
    if (!artifact || artifact.record.kind !== "evidence-stage-result") return null;
    const result = parseJsonArtifact(artifact, "evidence-stage-result");
    if (!validateEvidenceStageResult(result)) throw new TypeError("evidence stage result content is invalid");
    return result;
  }

  async getResultAtRoot(activeRoot: string, ref: string): Promise<EvidenceStageResult | null> {
    const artifact = await this.getAtActiveRoot(activeRoot, ref);
    if (!artifact || artifact.record.kind !== "evidence-stage-result") return null;
    const result = parseJsonArtifact(artifact, "evidence-stage-result");
    if (!validateEvidenceStageResult(result)) throw new TypeError("evidence stage result checkpoint content is invalid");
    return result;
  }

  async hasAtRoot(activeRoot: string, ref: string): Promise<boolean> {
    return await this.getAtActiveRoot(activeRoot, ref) !== null;
  }

  async putStageArtifact(input: {
    stage: EvidencePipelineStage;
    kind: string;
    bytes: Uint8Array;
    mediaType: string;
    privacyClass?: "public_source" | "private_user" | "runtime_internal";
    references?: readonly string[];
    createdAt: string;
  }, fence: EvidenceJobArtifactFence): Promise<{ ref: string; created: boolean }> {
    if (!input.kind || !input.kind.normalize("NFC").startsWith("evidence-")) {
      throw new TypeError("evidence stage artifact kind must be namespaced");
    }
    const stored = await this.repository.put({
      bytes: input.bytes,
      mediaType: input.mediaType,
      privacyClass: input.privacyClass ?? "runtime_internal",
      kind: input.kind,
      references: requiredReferences(input.references ?? []),
      createdAt: input.createdAt,
    }, fencedOptions(fence));
    return { ref: stored.record.ref, created: stored.created };
  }
}
