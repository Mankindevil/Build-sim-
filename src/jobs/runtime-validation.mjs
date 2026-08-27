const SHA256 = /^[a-f0-9]{64}$/;
const GENERIC_JOB_ID = /^job-[a-f0-9]{64}$/;
export const RUNTIME_JOB_STATUSES = Object.freeze([
  "queued", "running", "waiting_user", "waiting_retry", "paused_offline",
  "paused_restore_review", "succeeded", "failed", "cancelled", "dead_letter",
]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "dead_letter"]);
const ALLOWED_FIELDS = new Set([
  "schemaVersion", "jobId", "type", "handlerVersion", "idempotencyKey", "inputHash", "payloadRef", "planId",
  "status", "revision", "attempt", "maxAttempts", "runAfter", "leaseOwner", "leaseToken", "leaseExpiresAt",
  "checkpointRef", "runtimeGeneration", "networkRequired", "dependencyJobIds", "progress", "resultRefs",
  "resultCommitHash", "lastError", "createdAt", "updatedAt",
]);

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.length > 0; }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function uniqueStrings(value) { return Array.isArray(value) && value.every(nonEmpty) && new Set(value).size === value.length; }

/** Total runtime validator shared by backup/restore and Doctor. */
export function validateRuntimeBackgroundJob(value, options = {}) {
  if (!record(value)) return ["job must be an object"];
  const errors = [];
  const jobIdPattern = options.jobIdPattern ?? GENERIC_JOB_ID;
  if (Object.keys(value).some((field) => !ALLOWED_FIELDS.has(field))) errors.push("job contains unknown fields");
  if (value.schemaVersion !== "background-job-v1" || !jobIdPattern.test(String(value.jobId ?? ""))
    || !nonEmpty(value.type) || !nonEmpty(value.handlerVersion) || !nonEmpty(value.idempotencyKey)
    || !SHA256.test(String(value.inputHash ?? "")) || !nonEmpty(value.payloadRef)) errors.push("job identity/reference fields invalid");
  if (!RUNTIME_JOB_STATUSES.includes(value.status)) errors.push("job status invalid");
  if (!Number.isInteger(value.revision) || value.revision < 0) errors.push("job revision invalid");
  if (!Number.isInteger(value.attempt) || value.attempt < 0 || !Number.isInteger(value.maxAttempts)
    || value.maxAttempts < 1 || value.attempt > value.maxAttempts) errors.push("job attempts invalid");
  if (!Number.isInteger(value.runtimeGeneration) || value.runtimeGeneration < 1) errors.push("job runtime generation invalid");
  if (options.expectedRuntimeGeneration !== undefined && value.runtimeGeneration !== options.expectedRuntimeGeneration) errors.push("job runtime generation mismatch");
  if (options.maxRuntimeGenerationExclusive !== undefined && value.runtimeGeneration >= options.maxRuntimeGenerationExclusive) errors.push("job is not from an older runtime generation");
  if (typeof value.networkRequired !== "boolean") errors.push("job networkRequired invalid");
  if (!uniqueStrings(value.dependencyJobIds) || value.dependencyJobIds?.includes(value.jobId)) errors.push("job dependencies invalid");
  if (!uniqueStrings(value.resultRefs)) errors.push("job result refs invalid");
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt) || !timestamp(value.runAfter)
    || (timestamp(value.createdAt) && timestamp(value.updatedAt) && Date.parse(value.updatedAt) < Date.parse(value.createdAt))) errors.push("job timestamps invalid");
  const leaseFields = [value.leaseOwner, value.leaseToken, value.leaseExpiresAt];
  const leaseCount = leaseFields.filter((entry) => entry !== undefined).length;
  if (value.status === "running") {
    if (leaseCount !== 3 || !leaseFields.every(nonEmpty) || !timestamp(value.leaseExpiresAt) || value.attempt < 1) errors.push("running job lease invalid");
  } else if (leaseCount !== 0) errors.push("non-running job retains a lease");
  if (value.status === "paused_offline" && value.networkRequired !== true) errors.push("offline pause requires network");
  if (["waiting_retry", "failed", "dead_letter"].includes(value.status)) {
    if (!record(value.lastError) || value.lastError.redacted !== true || !nonEmpty(value.lastError.code) || !nonEmpty(value.lastError.message)
      || Object.keys(value.lastError).some((field) => !["code", "message", "redacted"].includes(field))) errors.push("job redacted error invalid");
  } else if (value.lastError !== undefined && (!record(value.lastError) || value.lastError.redacted !== true)) errors.push("job error invalid");
  if (value.status === "succeeded") {
    if (!SHA256.test(String(value.resultCommitHash ?? ""))) errors.push("succeeded job result commit invalid");
  } else if (value.resultCommitHash !== undefined) errors.push("non-succeeded job has a result commit hash");
  if (value.planId !== undefined && !nonEmpty(value.planId)) errors.push("job planId invalid");
  if (value.checkpointRef !== undefined && !nonEmpty(value.checkpointRef)) errors.push("job checkpoint ref invalid");
  if (value.progress !== undefined) {
    if (!record(value.progress) || Object.keys(value.progress).some((field) => !["stage", "completed", "total"].includes(field))
      || !nonEmpty(value.progress.stage) || !Number.isFinite(value.progress.completed) || value.progress.completed < 0
      || (value.progress.total !== undefined && (!Number.isFinite(value.progress.total) || value.progress.total < value.progress.completed))) errors.push("job progress invalid");
  }
  return errors;
}

/**
 * Pure authorization used by every durable side-effect repository. The
 * repository must call this while holding the same RuntimeCoordinator writer
 * critical section that contains the side effect.
 *
 * @param {unknown} value
 * @param {{ jobId?: unknown, expectedRevision?: unknown, leaseToken?: unknown, runtimeGeneration?: unknown }} fence
 * @param {unknown} committedAt
 * @returns {string[]}
 */
export function validateRuntimeJobSideEffectFence(value, fence, committedAt) {
  if (!record(fence)) return ["job side-effect fence must be an object"];
  const errors = validateRuntimeBackgroundJob(value, {
    expectedRuntimeGeneration: Number.isInteger(fence.runtimeGeneration) ? fence.runtimeGeneration : undefined,
  });
  if (!record(value)) return [...new Set(errors)];
  if (!GENERIC_JOB_ID.test(String(fence.jobId ?? "")) || value.jobId !== fence.jobId) errors.push("job side-effect identity mismatch");
  if (!Number.isInteger(fence.expectedRevision) || value.revision !== fence.expectedRevision) errors.push("job side-effect revision mismatch");
  if (!nonEmpty(fence.leaseToken) || value.leaseToken !== fence.leaseToken) errors.push("job side-effect lease mismatch");
  if (!Number.isInteger(fence.runtimeGeneration) || value.runtimeGeneration !== fence.runtimeGeneration) errors.push("job side-effect generation mismatch");
  if (value.status !== "running") errors.push("job side-effect requires a running job");
  if (!timestamp(committedAt)) errors.push("job side-effect commit timestamp invalid");
  if (!timestamp(value.leaseExpiresAt) || (timestamp(committedAt) && Date.parse(value.leaseExpiresAt) <= Date.parse(committedAt))) {
    errors.push("job side-effect lease expired");
  }
  return [...new Set(errors)];
}

export function restoreRuntimeBackgroundJob(job, runtimeGeneration, restoredAt, options = {}) {
  const sourceErrors = validateRuntimeBackgroundJob(job, { ...options, maxRuntimeGenerationExclusive: runtimeGeneration });
  if (sourceErrors.length) throw new Error(`restored job record is invalid: ${sourceErrors.join("; ")}`);
  if (!timestamp(restoredAt)) throw new Error("restored job timestamp is invalid");
  const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expiry, ...base } = job;
  const restored = {
    ...base,
    status: TERMINAL.has(job.status) ? job.status : "paused_restore_review",
    runtimeGeneration,
    revision: job.revision + 1,
    updatedAt: restoredAt,
  };
  const restoredErrors = validateRuntimeBackgroundJob(restored, { ...options, expectedRuntimeGeneration: runtimeGeneration });
  if (restoredErrors.length) throw new Error(`restored job transition is invalid: ${restoredErrors.join("; ")}`);
  return restored;
}
