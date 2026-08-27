export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_retry"
  | "paused_offline"
  | "paused_restore_review"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "dead_letter";

export interface BackgroundJob {
  schemaVersion: string;
  jobId: string;
  type: string;
  handlerVersion: string;
  idempotencyKey: string;
  inputHash: string;
  payloadRef: string;
  planId?: string;
  status: BackgroundJobStatus;
  revision: number;
  attempt: number;
  maxAttempts: number;
  runAfter: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  checkpointRef?: string;
  runtimeGeneration: number;
  networkRequired: boolean;
  dependencyJobIds: string[];
  progress?: { stage: string; completed: number; total?: number };
  resultRefs: string[];
  resultCommitHash?: string;
  lastError?: { code: string; message: string; redacted: true };
  createdAt: string;
  updatedAt: string;
}

export interface JobCommitFence {
  expectedRevision: number;
  leaseToken: string;
  runtimeGeneration: number;
  committedAt: string;
}

export interface JobCommitAuthorization {
  allowed: boolean;
  reason?: "not_running" | "stale_revision" | "lease_mismatch" | "lease_expired" | "runtime_generation_mismatch" | "invalid_timestamp";
}

const TERMINAL_STATUSES: readonly BackgroundJobStatus[] = ["succeeded", "failed", "cancelled", "dead_letter"];

export function isTerminalJobStatus(status: BackgroundJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function validateBackgroundJob(job: BackgroundJob): string[] {
  const errors: string[] = [];
  if (!job.schemaVersion || !job.jobId || !job.type || !job.handlerVersion || !job.idempotencyKey || !job.payloadRef) errors.push("job identity/reference fields must not be empty");
  if (!isSha256Hex(job.inputHash)) errors.push("job inputHash invalid");
  if (!Number.isInteger(job.revision) || job.revision < 0) errors.push("job revision must be a non-negative integer");
  if (!Number.isInteger(job.attempt) || job.attempt < 0 || !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.attempt > job.maxAttempts) errors.push("job attempts invalid");
  if (!Number.isInteger(job.runtimeGeneration) || job.runtimeGeneration < 0) errors.push("runtimeGeneration invalid");
  const leaseCount = [job.leaseOwner, job.leaseToken, job.leaseExpiresAt].filter((value) => value !== undefined).length;
  if (job.status === "running" && leaseCount !== 3) errors.push("running job requires a complete lease");
  if (job.status !== "running" && leaseCount !== 0) errors.push("non-running job cannot retain a live lease");
  if (job.status === "running" && job.attempt < 1) errors.push("running job requires a started attempt");
  if (job.status === "paused_offline" && !job.networkRequired) errors.push("only a network-required job may pause offline");
  if (["waiting_retry", "failed", "dead_letter"].includes(job.status) && !job.lastError) errors.push(`${job.status} job requires a redacted error`);
  if (job.progress && (!Number.isFinite(job.progress.completed) || job.progress.completed < 0 || (job.progress.total !== undefined && (job.progress.total < job.progress.completed || !Number.isFinite(job.progress.total))))) errors.push("job progress invalid");
  if (job.lastError && job.lastError.redacted !== true) errors.push("job error must be redacted");
  if (job.lastError && (!job.lastError.code || !job.lastError.message)) errors.push("job error code/message missing");
  if (job.resultCommitHash !== undefined && !isSha256Hex(job.resultCommitHash)) errors.push("job resultCommitHash invalid");
  if (job.status === "succeeded" && !isSha256Hex(job.resultCommitHash)) errors.push("succeeded job requires a result commit hash");
  if (job.status !== "succeeded" && job.resultCommitHash !== undefined) errors.push("only a succeeded job may retain resultCommitHash");
  if (job.dependencyJobIds.some((id) => !id || id === job.jobId) || new Set(job.dependencyJobIds).size !== job.dependencyJobIds.length) errors.push("job dependencies must be unique, non-empty and non-self");
  if (job.resultRefs.some((ref) => !ref) || new Set(job.resultRefs).size !== job.resultRefs.length) errors.push("job resultRefs invalid");
  const created = Date.parse(job.createdAt);
  const updated = Date.parse(job.updatedAt);
  if (![created, updated, Date.parse(job.runAfter)].every(Number.isFinite) || updated < created) errors.push("job timestamps invalid");
  if (job.leaseExpiresAt !== undefined && !Number.isFinite(Date.parse(job.leaseExpiresAt))) errors.push("job lease expiry invalid");
  return errors;
}

/** CAS + lease token + runtime-generation fencing. All three must match. */
export function authorizeJobCommit(job: BackgroundJob, fence: JobCommitFence): JobCommitAuthorization {
  if (job.status !== "running") return { allowed: false, reason: "not_running" };
  if (job.revision !== fence.expectedRevision) return { allowed: false, reason: "stale_revision" };
  if (job.leaseToken !== fence.leaseToken) return { allowed: false, reason: "lease_mismatch" };
  if (job.runtimeGeneration !== fence.runtimeGeneration) return { allowed: false, reason: "runtime_generation_mismatch" };
  const leaseExpiresAt = Date.parse(job.leaseExpiresAt ?? "");
  const committedAt = Date.parse(fence.committedAt);
  if (!Number.isFinite(leaseExpiresAt) || !Number.isFinite(committedAt)) return { allowed: false, reason: "invalid_timestamp" };
  if (leaseExpiresAt <= committedAt) return { allowed: false, reason: "lease_expired" };
  return { allowed: true };
}

export function restoredJobStatus(status: BackgroundJobStatus): BackgroundJobStatus {
  return isTerminalJobStatus(status) ? status : "paused_restore_review";
}

/** Restore fencing always advances generation and discards every pre-restore lease. */
export function restoreBackgroundJob(job: BackgroundJob, runtimeGeneration: number, restoredAt: string): BackgroundJob {
  if (!Number.isInteger(runtimeGeneration) || runtimeGeneration <= job.runtimeGeneration) throw new TypeError("restored runtimeGeneration must advance");
  if (!Number.isFinite(Date.parse(restoredAt))) throw new TypeError("restoredAt invalid");
  const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expiry, ...restored } = job;
  return {
    ...restored,
    status: restoredJobStatus(job.status),
    runtimeGeneration,
    revision: job.revision + 1,
    updatedAt: restoredAt,
  };
}

const JOB_TRANSITIONS: Readonly<Record<BackgroundJobStatus, readonly BackgroundJobStatus[]>> = Object.freeze({
  queued: ["running", "paused_offline", "cancelled"],
  running: ["running", "waiting_user", "waiting_retry", "paused_offline", "succeeded", "failed", "cancelled", "dead_letter"],
  waiting_user: ["queued", "cancelled"],
  waiting_retry: ["queued", "cancelled", "dead_letter"],
  paused_offline: ["queued", "cancelled"],
  paused_restore_review: ["queued", "cancelled"],
  succeeded: [], failed: [], cancelled: [], dead_letter: [],
});

/** Repository-level state transition guard; lease acquisition/commit still uses CAS. */
export function validateJobTransition(previous: BackgroundJob, next: BackgroundJob): string[] {
  const errors = validateBackgroundJob(next);
  if (previous.jobId !== next.jobId || previous.schemaVersion !== next.schemaVersion || previous.type !== next.type || previous.handlerVersion !== next.handlerVersion || previous.idempotencyKey !== next.idempotencyKey || previous.inputHash !== next.inputHash || previous.payloadRef !== next.payloadRef || previous.createdAt !== next.createdAt) errors.push("job immutable identity/input fields changed");
  if (next.revision !== previous.revision + 1) errors.push("job transition must increment revision exactly once");
  if (next.runtimeGeneration !== previous.runtimeGeneration) errors.push("ordinary job transition cannot cross runtimeGeneration");
  if (!JOB_TRANSITIONS[previous.status].includes(next.status)) errors.push(`illegal job transition: ${previous.status} -> ${next.status}`);
  if (previous.status === "running" && previous.leaseToken !== next.leaseToken && next.status === "running") errors.push("running lease cannot be silently replaced");
  return errors;
}
import { isSha256Hex } from "../hash";
