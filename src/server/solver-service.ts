import { createHash } from "node:crypto";
import { canonicalize, isSnapshotHashes, sha256Hex, type SnapshotHashes } from "../hash";
import { configV3Hash } from "../topology/hash";
import type { BuildConfigV3 } from "../topology/contracts";
import type { SolveLimits, SolveRequest, SolveResult, SolverCandidate, UnsatProof } from "../solver/contracts";
import { validateSolveRequest } from "../solver/contracts";
import { normalizeSolverComponentRequirement, type SolverComponentRequirement } from "../solver/candidate-index";
import {
  solveWholeBuild,
  type AuthoritativeSolverEvaluator,
  type SolverArtifactWriter,
  type SolverSearchCheckpoint,
} from "../solver/solve";
import {
  assertAuthoritativeCapabilityCandidateService,
  type AuthoritativeCapabilityCandidateService,
} from "../solver/capability-candidates";
import {
  solverArtifactReferencesRuntime,
  validateSolverArtifactRuntime,
  validateSolverApprovalArtifactRuntime,
  validateSolverApprovalClosureRuntime,
  validateSolverCandidateClosureRuntime,
  validateSolverJobCheckpointRuntime,
  validateSolverRequestArtifactRuntime,
  validateSolverResultArtifactRuntime,
} from "../solver/runtime-validation.mjs";
import { FileJobRepository, type JobLease } from "../jobs/repository";
import {
  JobHandlerError,
  type BackgroundJobHandler,
  type JobHandlerContext,
} from "../jobs/worker";
import type { BackgroundJob } from "../jobs/contracts";
import { validateBackgroundJob, validateJobTransition } from "../jobs/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { atomicWriteJson, confined, ensurePrivateDirectory, pathExists, readJson, sha256Json } from "../runtime/fs.mjs";
import { agentAuditHash } from "../agent/audit";
import { stableDefinition } from "../agent/contract-validation";
import { AGENT_CONTRACT_VERSION, type JsonSchema } from "../agent/contracts";
import {
  assertValidatedAgentWriteApprovalProofAtRoot,
  createAgentWriteApprovalBinding,
  type AgentWriteApprovalBinding,
  type ValidatedAgentWriteApprovalProof,
} from "../agent/write-approval-authority";

const MEDIA_TYPE = "application/vnd.buildsim.solver+json";
const REF = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
export const WHOLE_BUILD_SOLVER_JOB_TYPE = "solver.whole-build" as const;
export const WHOLE_BUILD_SOLVER_HANDLER_VERSION = "1" as const;

interface ArtifactRecord {
  ref: string;
  kind: string;
  mediaType: string;
}

export interface SolverArtifactRepository {
  put(input: {
    bytes: Uint8Array;
    mediaType: string;
    privacyClass: "runtime_internal";
    kind: string;
    references: ReadonlyArray<{ ref: string; necessity: "required_for_replay" | "optional_for_audit" }>;
    createdAt?: string;
  }, options?: {
    expectedRuntimeGeneration?: number;
    expectedJobLease?: { jobId: string; expectedRevision: number; leaseToken: string; runtimeGeneration: number };
  }): Promise<{ record: ArtifactRecord; created: boolean }>;
  get(ref: string): Promise<{ record: ArtifactRecord; bytes: Uint8Array } | null>;
}

export interface SolverBaseSnapshot {
  planId: string;
  basePlanVersionId: string;
  config: BuildConfigV3;
  configHash: string;
  snapshotHashes: SnapshotHashes;
  draftRevision: number;
  basePlanVersionRef: string;
  evaluationLockRef: string;
}

/** Must resolve only the currently applicable immutable base/version. */
export interface SolverBaseAuthority {
  readonly authorityKind: "solver-base-authority-v1";
  resolveCurrentAtRoot(activeRoot: string, input: { planId: string; basePlanVersionId: string }): Promise<SolverBaseSnapshot | null>;
}

export interface SolverRequirementAuthority {
  readonly authorityKind: "solver-requirement-authority-v1";
  resolveAtRoot(activeRoot: string, input: { base: Readonly<SolverBaseSnapshot> }): Promise<{
    requirements: SolverComponentRequirement[];
    /** Content-addressed `RequirementClosureResult` from requirements/closure. */
    requirementClosureRef: string;
  }>;
}

export interface SolverRequestArtifact {
  schemaVersion: "whole-build-solver-request-v1";
  planId: string;
  request: SolveRequest;
  baseConfigRef: string;
  requirementClosureRef: string;
  requirements: SolverComponentRequirement[];
  solverVersion: string;
  seed: string;
  runtimeGeneration: number;
  basePlanVersionRef: string;
  evaluationLockRef: string;
}

export interface SolverJobCheckpointArtifact {
  schemaVersion: "solver-job-checkpoint-v1";
  jobId: string;
  requestRef: string;
  runtimeGeneration: number;
  phase: "searching" | "result_ready" | "pending_approval" | "committed" | "aborted" | "stale";
  search: SolverSearchCheckpoint;
  resultRef: string | null;
  approvalRef: string | null;
}

export interface SolverResultArtifact {
  schemaVersion: "whole-build-solver-result-v1";
  jobId: string;
  requestRef: string;
  checkpointRef: string;
  result: SolveResult;
  unsatProof: UnsatProof | null;
}

/** Root-pinned solver material consumed by the recommendation promotion gate.
 * Every config and candidate is re-read from the immutable artifact closure;
 * callers never supply candidate bytes or evaluation coverage. */
export interface SolverRecommendationCandidateMaterial {
  candidateArtifactRef: string;
  candidate: SolverCandidate;
  config: BuildConfigV3;
}

export interface SolverRecommendationSource {
  planId: string;
  jobId: string;
  runtimeGeneration: number;
  requestRef: string;
  resultRef: string;
  request: SolverRequestArtifact;
  result: SolverResultArtifact;
  baseConfig: BuildConfigV3;
  candidates: SolverRecommendationCandidateMaterial[];
}

export interface SolverApprovalArtifact {
  schemaVersion: "solver-candidate-approval-v1";
  status: "pending" | "committed" | "aborted" | "stale";
  jobId: string;
  requestRef: string;
  checkpointRef: string;
  resultRef: string;
  candidateArtifactRefs: string[];
  candidateId: string | null;
  candidateBuildConfigHash: string | null;
  proposalRef: string | null;
  previousApprovalRef: string | null;
  approvedBy: string | null;
  writeApprovalBinding: AgentWriteApprovalBinding | null;
  approvalPlanContext: SolverApprovalPlanContext | null;
  createdAt: string;
}

export interface SolverAcceptanceProposal {
  schemaVersion: "solver-acceptance-proposal-v1";
  kind: "v3-change";
  source: "solver-feasibility-candidate";
  jobId: string;
  requestRef: string;
  resultRef: string;
  candidateArtifactRef: string;
  candidateId: string;
  expectedPlanVersionId: string;
  expectedConfigHash: string;
  expectedDraftRevision: number;
  operations: unknown[];
}

interface ArtifactFence extends JobLease { jobId: string }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.normalize("NFC") && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function canonicalReferences(value: readonly { ref: string; necessity: "required_for_replay" | "optional_for_audit" }[]) {
  const byKey = new Map(value.map((item) => [`${item.ref}\0${item.necessity}`, { ...item }]));
  return [...byKey.values()].sort((left, right) => compareText(`${left.ref}\0${left.necessity}`, `${right.ref}\0${right.necessity}`));
}

function sameSnapshots(left: SnapshotHashes, right: SnapshotHashes): boolean {
  return isSnapshotHashes(left) && isSnapshotHashes(right) && canonicalize(left) === canonicalize(right);
}

function parseArtifactJson(artifact: { record: ArtifactRecord; bytes: Uint8Array } | null, expectedKind?: string): unknown {
  if (!artifact || artifact.record.mediaType !== MEDIA_TYPE || (expectedKind && artifact.record.kind !== expectedKind)
    || artifact.bytes.byteLength > 16 * 1024 * 1024) throw new Error("solver artifact is missing or has invalid metadata");
  try { return JSON.parse(Buffer.from(artifact.bytes).toString("utf8")); }
  catch { throw new Error("solver artifact is not valid canonical JSON"); }
}

/** Generic artifact adapter that enforces semantic validators and exact edges. */
export class SolverArtifactStore {
  constructor(
    readonly repository: SolverArtifactRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private options(fence?: ArtifactFence) {
    return fence ? {
      expectedRuntimeGeneration: fence.runtimeGeneration,
      expectedJobLease: {
        jobId: fence.jobId,
        expectedRevision: fence.expectedRevision,
        leaseToken: fence.leaseToken,
        runtimeGeneration: fence.runtimeGeneration,
      },
    } : undefined;
  }

  async put(kind: string, value: unknown, fence?: ArtifactFence): Promise<string> {
    const errors = validateSolverArtifactRuntime(kind, value);
    if (errors.length) throw new TypeError(`invalid ${kind} artifact: ${errors.join("; ")}`);
    const references = canonicalReferences(solverArtifactReferencesRuntime(kind, value));
    const stored = await this.repository.put({
      bytes: Buffer.from(canonicalize(value), "utf8"),
      mediaType: MEDIA_TYPE,
      privacyClass: "runtime_internal",
      kind,
      references,
      createdAt: this.now(),
    }, this.options(fence));
    if (!REF.test(stored.record.ref) || stored.record.kind !== kind || stored.record.mediaType !== MEDIA_TYPE) {
      throw new Error("solver artifact repository returned invalid metadata");
    }
    return stored.record.ref;
  }

  writer(fence?: () => ArtifactFence): SolverArtifactWriter {
    return Object.freeze({
      authorityKind: "solver-artifact-writer-v1" as const,
      put: async (input: { kind: string; value: unknown; references: ReadonlyArray<{ ref: string; necessity: "required_for_replay" | "optional_for_audit" }> }) => {
        const expected = canonicalReferences(solverArtifactReferencesRuntime(input.kind, input.value));
        if (canonicalize(canonicalReferences(input.references)) !== canonicalize(expected)) {
          throw new Error(`solver ${input.kind} references are not recomputable from its semantic payload`);
        }
        return { ref: await this.put(input.kind, input.value, fence?.()) };
      },
    });
  }

  async get<T>(ref: string, kind: string): Promise<T> {
    if (!REF.test(ref)) throw new TypeError("solver artifact ref is invalid");
    const value = parseArtifactJson(await this.repository.get(ref), kind);
    const errors = validateSolverArtifactRuntime(kind, value);
    if (errors.length) throw new Error(`solver ${kind} artifact is corrupt: ${errors.join("; ")}`);
    return structuredClone(value as T);
  }

  async getAny(ref: string): Promise<{ kind: string; value: unknown }> {
    if (!REF.test(ref)) throw new TypeError("solver artifact ref is invalid");
    const artifact = await this.repository.get(ref);
    const value = parseArtifactJson(artifact);
    const kind = artifact!.record.kind;
    const errors = validateSolverArtifactRuntime(kind, value);
    if (errors.length) throw new Error(`solver ${kind} artifact is corrupt: ${errors.join("; ")}`);
    return { kind, value: structuredClone(value) };
  }
}

export interface WholeBuildSolverServiceOptions {
  coordinator: RuntimeCoordinator;
  jobs: FileJobRepository;
  artifacts: SolverArtifactStore;
  baseAuthority: SolverBaseAuthority;
  requirementAuthority: SolverRequirementAuthority;
  candidateService: AuthoritativeCapabilityCandidateService;
  evaluator: AuthoritativeSolverEvaluator;
  solverVersion?: string;
  now?: () => string;
  nowMs?: () => number;
}

// Must remain inside the Agent tool-name grammar because U4 approval
// artifacts independently validate this execution authority at restore time.
export const SOLVER_ACCEPT_APPROVAL_TOOL_NAME = "solver_accept_feasibility_candidate" as const;
export const SOLVER_ACCEPT_APPROVAL_TOOL_CONTRACT = Object.freeze({
  contractVersion: AGENT_CONTRACT_VERSION,
  name: SOLVER_ACCEPT_APPROVAL_TOOL_NAME,
  title: "Accept solver feasibility candidate",
  description: "Accept one exact persisted feasibility candidate after human review and emit an ordinary V3 change proposal without directly mutating the plan.",
  effect: "write" as const,
  approval: "required" as const,
  timeoutMs: 30_000,
  maxResultBytes: 256_000,
  inputSchema: {
    type: "object",
    properties: {
      schemaVersion: { type: "string", const: "solver-approval-plan-context-v1" },
      jobId: { type: "string", pattern: "^job-[a-f0-9]{64}$" },
      expectedRevision: { type: "integer", minimum: 0 },
      runtimeGeneration: { type: "integer", minimum: 1 },
      candidateId: { type: "string", minLength: 1, maxLength: 256 },
      requestRef: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      resultRef: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      basePlanVersionId: { type: "string", minLength: 1, maxLength: 256 },
      baseConfigHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      candidateBuildConfigHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    required: [
      "schemaVersion", "jobId", "expectedRevision", "runtimeGeneration", "candidateId",
      "requestRef", "resultRef", "basePlanVersionId", "baseConfigHash", "candidateBuildConfigHash",
    ],
    additionalProperties: false,
  } as JsonSchema,
});
export const SOLVER_ACCEPT_APPROVAL_TOOL_DEFINITION_HASH = createHash("sha256")
  .update(stableDefinition(SOLVER_ACCEPT_APPROVAL_TOOL_CONTRACT)).digest("hex");

export interface SolverApprovalPlanContext {
  schemaVersion: "solver-approval-plan-context-v1";
  jobId: string;
  expectedRevision: number;
  runtimeGeneration: number;
  candidateId: string;
  requestRef: string;
  resultRef: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  candidateBuildConfigHash: string;
}

export function solverApprovalPlanContextHash(value: SolverApprovalPlanContext): string {
  return agentAuditHash(value);
}

export interface EnqueueWholeBuildSolveInput {
  planId: string;
  basePlanVersionId: string;
  lockedInstanceIds: string[];
  requirementSpecId: string;
  limits: SolveLimits;
}

export class WholeBuildSolverService {
  private readonly solverVersion: string;
  private readonly now: () => string;

  private rootArtifacts(activeRoot: string): SolverArtifactStore {
    return new SolverArtifactStore(new FileArtifactRepository({ root: confined(activeRoot, "artifacts"), now: this.now }), this.now);
  }

  private async readJobEnvelopeAtRoot(activeRoot: string, jobId: string): Promise<BackgroundJob | null> {
    const file = confined(activeRoot, "jobs", "records", `${jobId}.json`);
    if (!await pathExists(file)) return null;
    const stored = await readJson(file) as { schemaVersion?: string; kind?: string; checksum?: string; payload?: BackgroundJob };
    if (stored?.schemaVersion !== "job-store-envelope-v1" || stored.kind !== "background-job" || !stored.payload
      || stored.checksum !== sha256Json(stored.payload) || validateBackgroundJob(stored.payload).length || stored.payload.jobId !== jobId) {
      throw new Error("root-bound solver job authority is corrupt");
    }
    return structuredClone(stored.payload);
  }

  private async createJobAtRoot(activeRoot: string, runtimeGeneration: number, input: {
    idempotencyKey: string; inputHash: string; payloadRef: string; planId: string;
  }): Promise<{ job: BackgroundJob; created: boolean }> {
    const jobId = `job-${createHash("sha256").update(input.idempotencyKey.normalize("NFC"), "utf8").digest("hex")}`;
    const keyHash = createHash("sha256").update(`buildsim-job-idempotency\0${input.idempotencyKey.normalize("NFC")}`, "utf8").digest("hex");
    const jobsRoot = confined(activeRoot, "jobs");
    const recordFile = confined(jobsRoot, "records", `${jobId}.json`);
    const idempotencyFile = confined(jobsRoot, "idempotency", `${keyHash}.json`);
    await Promise.all([
      ensurePrivateDirectory(confined(jobsRoot, "records")), ensurePrivateDirectory(confined(jobsRoot, "idempotency")),
      ensurePrivateDirectory(confined(jobsRoot, "rollback")),
    ]);
    const existing = await this.readJobEnvelopeAtRoot(activeRoot, jobId);
    if (existing) {
      if (existing.type !== WHOLE_BUILD_SOLVER_JOB_TYPE || existing.handlerVersion !== WHOLE_BUILD_SOLVER_HANDLER_VERSION
        || existing.idempotencyKey !== input.idempotencyKey || existing.inputHash !== input.inputHash
        || existing.payloadRef !== input.payloadRef || existing.planId !== input.planId || existing.runtimeGeneration !== runtimeGeneration) {
        throw new Error("root-bound solver job idempotency collision");
      }
      const recoveredIndex = {
        schemaVersion: "job-idempotency-v1", idempotencyKeyHash: keyHash, jobId,
        type: existing.type, handlerVersion: existing.handlerVersion, inputHash: existing.inputHash,
        payloadRef: existing.payloadRef, createdAt: existing.createdAt,
      };
      if (await pathExists(idempotencyFile)) {
        const stored = await readJson(idempotencyFile) as {
          schemaVersion?: string; kind?: string; checksum?: string; payload?: unknown;
        };
        if (stored.schemaVersion !== "job-store-envelope-v1" || stored.kind !== "job-idempotency"
          || stored.checksum !== sha256Json(stored.payload) || canonicalize(stored.payload) !== canonicalize(recoveredIndex)) {
          throw new Error("root-bound solver job idempotency index is corrupt");
        }
      } else {
        // A crash may land after the deterministic job record but before its
        // secondary index. Repair that recoverable half-commit while still
        // holding the same runtime-root writer barrier.
        await atomicWriteJson(idempotencyFile, {
          schemaVersion: "job-store-envelope-v1", kind: "job-idempotency",
          checksum: sha256Json(recoveredIndex), payload: recoveredIndex,
        });
      }
      return { job: existing, created: false };
    }
    const createdAt = this.now();
    const job: BackgroundJob = {
      schemaVersion: "background-job-v1", jobId, type: WHOLE_BUILD_SOLVER_JOB_TYPE,
      handlerVersion: WHOLE_BUILD_SOLVER_HANDLER_VERSION, idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash, payloadRef: input.payloadRef, planId: input.planId,
      status: "queued", revision: 0, attempt: 0, maxAttempts: 3, runAfter: createdAt,
      runtimeGeneration, networkRequired: false, dependencyJobIds: [], resultRefs: [], createdAt, updatedAt: createdAt,
    };
    const errors = validateBackgroundJob(job);
    if (errors.length) throw new Error(`root-bound solver job invalid: ${errors.join("; ")}`);
    const idempotency = {
      schemaVersion: "job-idempotency-v1", idempotencyKeyHash: keyHash, jobId,
      type: job.type, handlerVersion: job.handlerVersion, inputHash: job.inputHash,
      payloadRef: job.payloadRef, createdAt,
    };
    if (await pathExists(idempotencyFile)) throw new Error("root-bound solver idempotency index already exists without its job");
    await atomicWriteJson(recordFile, { schemaVersion: "job-store-envelope-v1", kind: "background-job", checksum: sha256Json(job), payload: job });
    await atomicWriteJson(idempotencyFile, { schemaVersion: "job-store-envelope-v1", kind: "job-idempotency", checksum: sha256Json(idempotency), payload: idempotency });
    return { job: structuredClone(job), created: true };
  }

  private async resumeJobAtRoot(activeRoot: string, current: BackgroundJob, checkpointRef: string): Promise<BackgroundJob> {
    const updatedAt = this.now();
    const next: BackgroundJob = {
      ...current, status: "queued", revision: current.revision + 1, runAfter: updatedAt, checkpointRef, updatedAt,
    };
    const errors = validateJobTransition(current, next);
    if (errors.length) throw new Error(`root-bound solver job resume invalid: ${errors.join("; ")}`);
    const rollback = {
      schemaVersion: "job-rollback-v1", jobId: current.jobId, fromRevision: current.revision,
      toRevision: next.revision, previousChecksum: sha256Json(current), createdAt: updatedAt, previous: structuredClone(current),
    };
    const rollbackFile = confined(activeRoot, "jobs", "rollback", current.jobId, `${String(current.revision).padStart(12, "0")}.json`);
    await ensurePrivateDirectory(confined(activeRoot, "jobs", "rollback", current.jobId));
    await atomicWriteJson(rollbackFile, {
      schemaVersion: "job-store-envelope-v1", kind: "job-rollback", checksum: sha256Json(rollback), payload: rollback,
    });
    await atomicWriteJson(confined(activeRoot, "jobs", "records", `${current.jobId}.json`), {
      schemaVersion: "job-store-envelope-v1", kind: "background-job", checksum: sha256Json(next), payload: next,
    });
    return structuredClone(next);
  }

  private async cancelJobAtRoot(activeRoot: string, current: BackgroundJob): Promise<BackgroundJob> {
    const updatedAt = this.now();
    const next: BackgroundJob = {
      ...current, status: "cancelled", revision: current.revision + 1, updatedAt,
    };
    const errors = validateJobTransition(current, next);
    if (errors.length) throw new Error(`root-bound solver job cancellation invalid: ${errors.join("; ")}`);
    const rollback = {
      schemaVersion: "job-rollback-v1", jobId: current.jobId, fromRevision: current.revision,
      toRevision: next.revision, previousChecksum: sha256Json(current), createdAt: updatedAt, previous: structuredClone(current),
    };
    const rollbackFile = confined(activeRoot, "jobs", "rollback", current.jobId, `${String(current.revision).padStart(12, "0")}.json`);
    await ensurePrivateDirectory(confined(activeRoot, "jobs", "rollback", current.jobId));
    await atomicWriteJson(rollbackFile, {
      schemaVersion: "job-store-envelope-v1", kind: "job-rollback", checksum: sha256Json(rollback), payload: rollback,
    });
    await atomicWriteJson(confined(activeRoot, "jobs", "records", `${current.jobId}.json`), {
      schemaVersion: "job-store-envelope-v1", kind: "background-job", checksum: sha256Json(next), payload: next,
    });
    return structuredClone(next);
  }

  constructor(private readonly options: WholeBuildSolverServiceOptions) {
    if (options.baseAuthority?.authorityKind !== "solver-base-authority-v1") throw new TypeError("solver base authority is required");
    if (options.requirementAuthority?.authorityKind !== "solver-requirement-authority-v1") throw new TypeError("solver requirement authority is required");
    if (options.evaluator?.authorityKind !== "authoritative-solver-evaluator-v1") throw new TypeError("authoritative solver evaluator is required");
    assertAuthoritativeCapabilityCandidateService(options.candidateService);
    if (!options.coordinator || options.jobs.coordinator !== options.coordinator
      || typeof options.baseAuthority.resolveCurrentAtRoot !== "function" || typeof options.requirementAuthority.resolveAtRoot !== "function") {
      throw new TypeError("solver service requires one shared coordinator and root-bound base/requirement authorities");
    }
    this.solverVersion = options.solverVersion ?? "whole-build-solver-v1";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async assertCurrentBase(request: SolverRequestArtifact): Promise<SolverBaseSnapshot> {
    const pinned = await this.options.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number };
      activeRoot: string;
    }) => {
      if (state.runtimeGeneration !== request.runtimeGeneration) return null;
      return this.options.baseAuthority.resolveCurrentAtRoot(activeRoot, {
        planId: request.planId,
        basePlanVersionId: request.request.basePlanVersionId,
      });
    });
    const current = pinned.result;
    if (!current || current.planId !== request.planId || current.basePlanVersionId !== request.request.basePlanVersionId
      || current.configHash !== request.request.baseConfigHash || !sameSnapshots(current.snapshotHashes, request.request.baseSnapshotHashes)
      || current.basePlanVersionRef !== request.basePlanVersionRef || current.evaluationLockRef !== request.evaluationLockRef
      || await configV3Hash(current.config) !== current.configHash) {
      throw new JobHandlerError("stale_solver_base", "The solver base version or snapshots changed", false);
    }
    return current;
  }

  async enqueue(input: EnqueueWholeBuildSolveInput): Promise<{ job: BackgroundJob; created: boolean; requestRef: string }> {
    if (!portableIdentity(input.planId) || !portableIdentity(input.basePlanVersionId)) throw new TypeError("solver enqueue plan/version identity is invalid");
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withWrite(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number };
      activeRoot: string;
    }) => {
      const base = await this.options.baseAuthority.resolveCurrentAtRoot(activeRoot, {
        planId: input.planId, basePlanVersionId: input.basePlanVersionId,
      });
      if (!base || base.planId !== input.planId || base.basePlanVersionId !== input.basePlanVersionId
        || !sameSnapshots(base.snapshotHashes, { ...base.snapshotHashes, configHash: base.configHash })
        || !REF.test(base.basePlanVersionRef) || !REF.test(base.evaluationLockRef)
        || await configV3Hash(base.config) !== base.configHash) throw new Error("solver enqueue base is stale or invalid");
      const request: SolveRequest = {
        basePlanVersionId: base.basePlanVersionId, baseConfigHash: base.configHash,
        baseSnapshotHashes: structuredClone(base.snapshotHashes), lockedInstanceIds: [...input.lockedInstanceIds].sort(compareText),
        requirementSpecId: input.requirementSpecId, limits: structuredClone(input.limits),
      };
      const requestErrors = validateSolveRequest(request);
      if (requestErrors.length || base.config.requirementSpec?.requirementSpecId !== request.requirementSpecId) {
        throw new TypeError(`invalid solver enqueue request: ${requestErrors.join("; ") || "RequirementSpec binding mismatch"}`);
      }
      const closure = await this.options.requirementAuthority.resolveAtRoot(activeRoot, { base: structuredClone(base) });
      if (!REF.test(closure.requirementClosureRef) || !Array.isArray(closure.requirements)) throw new Error("solver requirement closure authority is invalid");
      const rawArtifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts"), now: this.now });
      for (const ref of [base.basePlanVersionRef, base.evaluationLockRef, closure.requirementClosureRef]) {
        if (!await rawArtifacts.get(ref)) throw new Error("solver enqueue root authority artifact is missing");
      }
      const seed = await sha256Hex(`buildsim\0solver-seed-v1\0${canonicalize({ request, solverVersion: this.solverVersion })}`);
      const artifacts = this.rootArtifacts(activeRoot);
      const baseConfigRef = await artifacts.put("solver-candidate-config", base.config);
      const requestArtifact: SolverRequestArtifact = {
        schemaVersion: "whole-build-solver-request-v1", planId: input.planId, request, baseConfigRef,
        requirementClosureRef: closure.requirementClosureRef,
        requirements: closure.requirements.map(normalizeSolverComponentRequirement).sort((left, right) => compareText(left.requirementId, right.requirementId)),
        solverVersion: this.solverVersion, seed, runtimeGeneration: state.runtimeGeneration,
        basePlanVersionRef: base.basePlanVersionRef, evaluationLockRef: base.evaluationLockRef,
      };
      const requestRef = await artifacts.put("solver-request", requestArtifact);
      const created = await this.createJobAtRoot(activeRoot, state.runtimeGeneration, {
        idempotencyKey: `whole-build-solver:${input.planId}:${requestRef}`,
        inputHash: requestRef.slice("sha256:".length), payloadRef: requestRef, planId: input.planId,
      });
      return { ...created, requestRef };
    })).result;
  }

  private async putJobCheckpoint(
    context: JobHandlerContext,
    requestRef: string,
    search: SolverSearchCheckpoint,
    phase: SolverJobCheckpointArtifact["phase"] = "searching",
    resultRef: string | null = null,
    approvalRef: string | null = null,
  ): Promise<string> {
    const artifact: SolverJobCheckpointArtifact = {
      schemaVersion: "solver-job-checkpoint-v1",
      jobId: context.job.jobId,
      requestRef,
      runtimeGeneration: context.currentLease().runtimeGeneration,
      phase,
      search: structuredClone(search),
      resultRef,
      approvalRef,
    };
    if (validateSolverJobCheckpointRuntime(artifact).length) throw new Error("solver job checkpoint failed its runtime contract");
    return this.options.artifacts.put("solver-job-checkpoint", artifact, { jobId: context.job.jobId, ...context.currentLease() });
  }

  handler(): BackgroundJobHandler {
    return async (context) => this.runJob(context);
  }

  handlers(): Readonly<Record<string, BackgroundJobHandler>> {
    return Object.freeze({ [`${WHOLE_BUILD_SOLVER_JOB_TYPE}@${WHOLE_BUILD_SOLVER_HANDLER_VERSION}`]: this.handler() });
  }

  private async runJob(context: JobHandlerContext) {
    const requestRef = context.payloadRef;
    const request = await this.options.artifacts.get<SolverRequestArtifact>(requestRef, "solver-request");
    if (validateSolverRequestArtifactRuntime(request).length || context.job.planId !== request.planId) {
      throw new JobHandlerError("corrupt_solver_request", "The durable solver request is invalid", false);
    }
    if (context.job.checkpointRef) {
      const prior = await this.options.artifacts.getAny(context.job.checkpointRef);
      if (prior.kind === "solver-approval") {
        const approval = prior.value as SolverApprovalArtifact;
        if (validateSolverApprovalArtifactRuntime(approval).length || approval.jobId !== context.job.jobId || approval.requestRef !== requestRef) {
          throw new JobHandlerError("corrupt_solver_approval", "The durable solver approval is invalid", false);
        }
        if (approval.status === "committed" && approval.proposalRef) {
          const pending = await this.options.artifacts.get<SolverApprovalArtifact>(approval.previousApprovalRef!, "solver-approval");
          const result = await this.options.artifacts.get<SolverResultArtifact>(approval.resultRef, "solver-result");
          const proposal = await this.options.artifacts.get<SolverAcceptanceProposal>(approval.proposalRef, "solver-acceptance-proposal");
          const selected = result.result.candidates.find((candidate) => candidate.candidateId === approval.candidateId);
          if (!selected?.candidateArtifactRef) {
            throw new JobHandlerError("corrupt_solver_approval", "The durable solver approval selected no persisted candidate", false);
          }
          const candidateMaterial = await this.options.artifacts.get<SolverCandidate>(selected.candidateArtifactRef, "solver-candidate");
          const baseConfig = await this.options.artifacts.get<BuildConfigV3>(request.baseConfigRef, "solver-candidate-config");
          const candidateConfig = await this.options.artifacts.get<BuildConfigV3>(selected.candidateConfigRef, "solver-candidate-config");
          const operations = await this.options.artifacts.get<unknown[]>(selected.operationsRef, "solver-candidate-operations");
          const candidateClosureErrors = validateSolverCandidateClosureRuntime(
            { ref: selected.candidateArtifactRef, value: candidateMaterial }, request,
            { ref: request.baseConfigRef, value: baseConfig },
            { ref: selected.candidateConfigRef, value: candidateConfig },
            { ref: selected.operationsRef, value: operations },
          );
          if (candidateClosureErrors.length) {
            throw new JobHandlerError("corrupt_solver_candidate", `The durable solver candidate closure is invalid: ${candidateClosureErrors.join("; ")}`, false);
          }
          const closureErrors = validateSolverApprovalClosureRuntime(
            approval, pending, request, result, proposal,
            { ref: selected.candidateArtifactRef, value: candidateMaterial },
            { ref: selected.operationsRef, value: operations },
          );
          if (closureErrors.length) {
            throw new JobHandlerError("corrupt_solver_approval", `The durable solver approval closure is invalid: ${closureErrors.join("; ")}`, false);
          }
          return {
            resultRefs: [approval.resultRef, approval.proposalRef, context.job.checkpointRef],
            resultCommitHash: context.job.checkpointRef.slice("sha256:".length),
          };
        }
        if (approval.status === "pending") {
          // Crash-safe edge: the worker may have durably checkpointed the
          // pending approval immediately before it was paused. Replaying that
          // checkpoint must return to waiting_user, never fail the job.
          return context.pauseForUser(context.job.progress);
        }
        throw new JobHandlerError(`solver_${approval.status}`, "The solver approval is not committed", false);
      }
    }
    const current = await this.assertCurrentBase(request);
    const persistedBase = await this.options.artifacts.get<BuildConfigV3>(request.baseConfigRef, "solver-candidate-config");
    if (await configV3Hash(persistedBase) !== request.request.baseConfigHash || canonicalize(persistedBase) !== canonicalize(current.config)) {
      throw new JobHandlerError("corrupt_solver_base", "The durable solver base artifact is invalid", false);
    }
    let resumeFrom: SolverSearchCheckpoint | undefined;
    if (context.job.checkpointRef) {
      const previous = await this.options.artifacts.getAny(context.job.checkpointRef);
      if (previous.kind !== "solver-job-checkpoint") throw new JobHandlerError("corrupt_solver_checkpoint", "The solver checkpoint kind is invalid", false);
      const checkpoint = previous.value as SolverJobCheckpointArtifact;
      if (validateSolverJobCheckpointRuntime(checkpoint).length || checkpoint.jobId !== context.job.jobId || checkpoint.requestRef !== requestRef) {
        throw new JobHandlerError("corrupt_solver_checkpoint", "The solver checkpoint binding is invalid", false);
      }
      resumeFrom = checkpoint.search;
    }
    const output = await solveWholeBuild({
      planId: request.planId,
      request: request.request,
      baseConfig: persistedBase,
      requirements: request.requirements,
      candidateService: this.options.candidateService,
      evaluator: this.options.evaluator,
      artifacts: this.options.artifacts.writer(() => ({ jobId: context.job.jobId, ...context.currentLease() })),
      solverVersion: request.solverVersion,
      seed: request.seed,
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(this.options.nowMs ? { nowMs: this.options.nowMs } : {}),
      checkpoint: async (search) => {
        const ref = await this.putJobCheckpoint(context, requestRef, search);
        await context.checkpoint(ref, { stage: "bounded_search", completed: search.nextAssignment, total: search.totalAssignments });
      },
    });
    const checkpointRef = await this.putJobCheckpoint(context, requestRef, output.checkpoint, "result_ready");
    await context.checkpoint(checkpointRef, { stage: "result_ready", completed: output.result.explored, total: output.checkpoint.totalAssignments });
    const resultArtifact: SolverResultArtifact = {
      schemaVersion: "whole-build-solver-result-v1",
      jobId: context.job.jobId,
      requestRef,
      checkpointRef,
      result: output.result,
      unsatProof: output.unsatProof ?? null,
    };
    if (validateSolverResultArtifactRuntime(resultArtifact).length) throw new Error("solver result failed its runtime contract");
    const resultRef = await this.options.artifacts.put("solver-result", resultArtifact, { jobId: context.job.jobId, ...context.currentLease() });
    if (!output.result.candidates.length) {
      return { resultRefs: [resultRef, output.result.searchSummaryRef], resultCommitHash: resultRef.slice("sha256:".length) };
    }
    const pending: SolverApprovalArtifact = {
      schemaVersion: "solver-candidate-approval-v1",
      status: "pending",
      jobId: context.job.jobId,
      requestRef,
      checkpointRef,
      resultRef,
      candidateArtifactRefs: output.result.candidates.map((candidate) => candidate.candidateArtifactRef!).sort(compareText),
      candidateId: null,
      candidateBuildConfigHash: null,
      proposalRef: null,
      previousApprovalRef: null,
      approvedBy: null,
      writeApprovalBinding: null,
      approvalPlanContext: null,
      createdAt: this.now(),
    };
    const pendingRef = await this.options.artifacts.put("solver-approval", pending, { jobId: context.job.jobId, ...context.currentLease() });
    await context.checkpoint(pendingRef, { stage: "waiting_candidate_approval", completed: output.result.explored, total: output.checkpoint.totalAssignments });
    return context.pauseForUser({ stage: "waiting_candidate_approval", completed: output.result.explored, total: output.checkpoint.totalAssignments });
  }

  private async pendingFor(
    job: BackgroundJob,
    artifacts: SolverArtifactStore = this.options.artifacts,
  ): Promise<{ ref: string; value: SolverApprovalArtifact; request: SolverRequestArtifact; result: SolverResultArtifact }> {
    if (job.status !== "waiting_user" || !job.checkpointRef) throw new Error("solver job is not waiting for candidate approval");
    const pending = await artifacts.get<SolverApprovalArtifact>(job.checkpointRef, "solver-approval");
    if (pending.status !== "pending" || pending.jobId !== job.jobId || pending.requestRef !== job.payloadRef) throw new Error("solver pending approval binding is invalid");
    const request = await artifacts.get<SolverRequestArtifact>(pending.requestRef, "solver-request");
    const result = await artifacts.get<SolverResultArtifact>(pending.resultRef, "solver-result");
    if (result.jobId !== job.jobId || result.requestRef !== pending.requestRef || result.checkpointRef !== pending.checkpointRef) {
      throw new Error("solver pending approval result/checkpoint closure is invalid");
    }
    return { ref: job.checkpointRef, value: pending, request, result };
  }

  async approvalPlanContext(jobId: string, candidateId: string): Promise<{
    context: SolverApprovalPlanContext;
    inputHash: string;
    toolName: typeof SOLVER_ACCEPT_APPROVAL_TOOL_NAME;
    toolDefinitionHash: string;
  }> {
    if (!portableIdentity(candidateId)) throw new TypeError("solver approval candidate is invalid");
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number };
      activeRoot: string;
    }) => {
      const job = await this.readJobEnvelopeAtRoot(activeRoot, jobId);
      if (!job || job.runtimeGeneration !== state.runtimeGeneration) throw new Error("solver approval job is missing or stale");
      const pending = await this.pendingFor(job, this.rootArtifacts(activeRoot));
      const candidate = pending.result.result.candidates.find((item) => item.candidateId === candidateId);
      if (!candidate?.candidateArtifactRef || !pending.value.candidateArtifactRefs.includes(candidate.candidateArtifactRef)) {
        throw new Error("solver candidate is outside the pending approval set");
      }
      const context: SolverApprovalPlanContext = {
        schemaVersion: "solver-approval-plan-context-v1", jobId: job.jobId, expectedRevision: job.revision,
        runtimeGeneration: job.runtimeGeneration,
        candidateId, requestRef: pending.value.requestRef, resultRef: pending.value.resultRef,
        basePlanVersionId: pending.request.request.basePlanVersionId, baseConfigHash: pending.request.request.baseConfigHash,
        candidateBuildConfigHash: candidate.buildConfigHash,
      };
      return {
        context, inputHash: solverApprovalPlanContextHash(context),
        toolName: SOLVER_ACCEPT_APPROVAL_TOOL_NAME,
        toolDefinitionHash: SOLVER_ACCEPT_APPROVAL_TOOL_DEFINITION_HASH,
      };
    })).result;
  }

  async approve(input: {
    jobId: string;
    expectedRevision: number;
    candidateId: string;
    approvalProof: ValidatedAgentWriteApprovalProof;
  }): Promise<{
    approvalRef: string;
    approval: SolverApprovalArtifact;
    proposal: SolverAcceptanceProposal;
    resumedJob: BackgroundJob;
  }> {
    if (!portableIdentity(input.candidateId)) throw new TypeError("solver approval candidate is invalid");
    return (await this.options.coordinator.withWrite(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number };
      activeRoot: string;
    }) => {
      const job = await this.readJobEnvelopeAtRoot(activeRoot, input.jobId);
      if (!job || job.revision !== input.expectedRevision || job.runtimeGeneration !== state.runtimeGeneration) {
        throw new Error("solver job revision/generation changed before approval");
      }
      const artifacts = this.rootArtifacts(activeRoot);
      const pending = await this.pendingFor(job, artifacts);
      const current = await this.options.baseAuthority.resolveCurrentAtRoot(activeRoot, {
        planId: pending.request.planId, basePlanVersionId: pending.request.request.basePlanVersionId,
      });
      if (!current || current.planId !== pending.request.planId
        || current.basePlanVersionId !== pending.request.request.basePlanVersionId
        || current.configHash !== pending.request.request.baseConfigHash
        || !sameSnapshots(current.snapshotHashes, pending.request.request.baseSnapshotHashes)
        || current.basePlanVersionRef !== pending.request.basePlanVersionRef
        || current.evaluationLockRef !== pending.request.evaluationLockRef
        || await configV3Hash(current.config) !== current.configHash) {
        // Fail before any proposal/approval/job write. A stale pending approval
        // is inert and cannot be mistaken for a committed authority.
        throw new Error("solver base is stale; candidate approval was not written");
      }
      const candidate = pending.result.result.candidates.find((item) => item.candidateId === input.candidateId);
      if (!candidate?.candidateArtifactRef || !pending.value.candidateArtifactRefs.includes(candidate.candidateArtifactRef)) {
        throw new Error("solver candidate is outside the pending approval set");
      }
      const planContext: SolverApprovalPlanContext = {
        schemaVersion: "solver-approval-plan-context-v1", jobId: job.jobId, expectedRevision: job.revision,
        runtimeGeneration: job.runtimeGeneration,
        candidateId: candidate.candidateId, requestRef: pending.value.requestRef, resultRef: pending.value.resultRef,
        basePlanVersionId: pending.request.request.basePlanVersionId, baseConfigHash: pending.request.request.baseConfigHash,
        candidateBuildConfigHash: candidate.buildConfigHash,
      };
      const planContextHash = solverApprovalPlanContextHash(planContext);
      const execution = input.approvalProof?.execution;
      if (!execution || execution.toolName !== SOLVER_ACCEPT_APPROVAL_TOOL_NAME
        || execution.toolDefinitionHash !== SOLVER_ACCEPT_APPROVAL_TOOL_DEFINITION_HASH
        || execution.inputHash !== planContextHash) {
        throw new Error("server-issued solver write approval does not bind the exact candidate/base/job context");
      }
      const durable = await assertValidatedAgentWriteApprovalProofAtRoot(activeRoot, input.approvalProof, execution, {
        now: this.now(), runtimeGeneration: state.runtimeGeneration,
      });
      const writeApprovalBinding = createAgentWriteApprovalBinding(durable, planContextHash);
      const operations = await artifacts.get<unknown[]>(candidate.operationsRef, "solver-candidate-operations");
      const proposal: SolverAcceptanceProposal = {
        schemaVersion: "solver-acceptance-proposal-v1", kind: "v3-change", source: "solver-feasibility-candidate",
        jobId: job.jobId, requestRef: pending.value.requestRef, resultRef: pending.value.resultRef,
        candidateArtifactRef: candidate.candidateArtifactRef, candidateId: candidate.candidateId,
        expectedPlanVersionId: pending.request.request.basePlanVersionId,
        expectedConfigHash: pending.request.request.baseConfigHash, expectedDraftRevision: current.draftRevision,
        operations: structuredClone(operations),
      };
      const proposalRef = await artifacts.put("solver-acceptance-proposal", proposal);
      const approval: SolverApprovalArtifact = {
        ...pending.value, status: "committed", candidateId: candidate.candidateId,
        candidateBuildConfigHash: candidate.buildConfigHash, proposalRef, previousApprovalRef: pending.ref,
        approvedBy: durable.approvedBy, writeApprovalBinding, approvalPlanContext: planContext, createdAt: durable.issuedAt,
      };
      const approvalRef = await artifacts.put("solver-approval", approval);
      const resumedJob = await this.resumeJobAtRoot(activeRoot, job, approvalRef);
      return { approvalRef, approval, proposal, resumedJob };
    })).result;
  }

  async abort(input: { jobId: string; expectedRevision: number; abortedBy: string }): Promise<{ approvalRef: string; job: BackgroundJob }> {
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(input.abortedBy)) throw new TypeError("solver abort actor is invalid");
    return (await this.options.coordinator.withWrite(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number };
      activeRoot: string;
    }) => {
      const job = await this.readJobEnvelopeAtRoot(activeRoot, input.jobId);
      if (!job || job.revision !== input.expectedRevision || job.runtimeGeneration !== state.runtimeGeneration) {
        throw new Error("solver job revision/generation changed before abort");
      }
      const artifacts = this.rootArtifacts(activeRoot);
      const pending = await this.pendingFor(job, artifacts);
      const approval: SolverApprovalArtifact = {
        ...pending.value,
        status: "aborted",
        previousApprovalRef: pending.ref,
        approvedBy: input.abortedBy,
        createdAt: this.now(),
      };
      const approvalRef = await artifacts.put("solver-approval", approval);
      return { approvalRef, job: await this.cancelJobAtRoot(activeRoot, job) };
    })).result;
  }

  async result(jobId: string): Promise<SolverResultArtifact | null> {
    const job = await this.options.jobs.get(jobId);
    if (job.status === "waiting_user" && job.checkpointRef) return (await this.pendingFor(job)).result;
    const resultRef = job.resultRefs.find((ref) => REF.test(ref));
    if (!resultRef) return null;
    try { return await this.options.artifacts.get<SolverResultArtifact>(resultRef, "solver-result"); }
    catch { return null; }
  }

  /** Reads one complete solver result inside an already-held runtime-root
   * barrier and verifies the candidate/config/operation closure again. */
  async recommendationSourceAtRoot(
    activeRoot: string,
    jobId: string,
    expectedPlanId: string,
  ): Promise<SolverRecommendationSource> {
    if (!portableIdentity(expectedPlanId) || !/^job-[a-f0-9]{64}$/.test(jobId)) {
      throw new TypeError("recommendation solver source identity is invalid");
    }
    const job = await this.readJobEnvelopeAtRoot(activeRoot, jobId);
    if (!job || job.type !== WHOLE_BUILD_SOLVER_JOB_TYPE || job.planId !== expectedPlanId) {
      throw new Error("recommendation solver source was not found for the plan");
    }
    const artifacts = this.rootArtifacts(activeRoot);
    const request = await artifacts.get<SolverRequestArtifact>(job.payloadRef, "solver-request");
    let resultRef: string | null = null;
    let result: SolverResultArtifact | null = null;
    if (job.status === "waiting_user" && job.checkpointRef) {
      const pending = await this.pendingFor(job, artifacts);
      resultRef = pending.value.resultRef;
      result = pending.result;
    } else {
      for (const ref of job.resultRefs) {
        try {
          const candidate = await artifacts.get<SolverResultArtifact>(ref, "solver-result");
          resultRef = ref;
          result = candidate;
          break;
        } catch {
          // Result refs also contain search summaries and accepted proposals.
        }
      }
    }
    if (!result || !resultRef || result.jobId !== jobId || result.requestRef !== job.payloadRef
      || request.planId !== expectedPlanId || result.result.candidates.length === 0
      || !["feasible_complete", "feasible_partial"].includes(result.result.status)) {
      throw new Error("recommendation requires a persisted feasible solver result");
    }
    const baseConfig = await artifacts.get<BuildConfigV3>(request.baseConfigRef, "solver-candidate-config");
    if (await configV3Hash(baseConfig) !== request.request.baseConfigHash) {
      throw new Error("recommendation solver base config closure is invalid");
    }
    const candidates: SolverRecommendationCandidateMaterial[] = [];
    for (const listed of result.result.candidates) {
      if (!listed.candidateArtifactRef) throw new Error("recommendation solver candidate is not persisted");
      const [candidate, config, operations] = await Promise.all([
        artifacts.get<SolverCandidate>(listed.candidateArtifactRef, "solver-candidate"),
        artifacts.get<BuildConfigV3>(listed.candidateConfigRef, "solver-candidate-config"),
        artifacts.get<unknown[]>(listed.operationsRef, "solver-candidate-operations"),
      ]);
      const closureErrors = validateSolverCandidateClosureRuntime(
        { ref: listed.candidateArtifactRef, value: candidate }, request,
        { ref: request.baseConfigRef, value: baseConfig },
        { ref: listed.candidateConfigRef, value: config },
        { ref: listed.operationsRef, value: operations },
      );
      if (closureErrors.length || canonicalize(candidate) !== canonicalize(listed)) {
        throw new Error(`recommendation solver candidate closure is invalid: ${closureErrors.join("; ") || "result material mismatch"}`);
      }
      candidates.push({
        candidateArtifactRef: listed.candidateArtifactRef,
        candidate: structuredClone(candidate),
        config: structuredClone(config),
      });
    }
    return {
      planId: expectedPlanId,
      jobId,
      runtimeGeneration: job.runtimeGeneration,
      requestRef: job.payloadRef,
      resultRef,
      request: structuredClone(request),
      result: structuredClone(result),
      baseConfig: structuredClone(baseConfig),
      candidates: candidates.sort((left, right) => compareText(left.candidate.candidateId, right.candidate.candidateId)),
    };
  }
}
