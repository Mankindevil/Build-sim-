import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import {
  atomicWriteJson,
  confined,
  ensurePrivateDirectory,
  pathExists,
  readJson,
  sha256Json,
} from "../runtime/fs.mjs";
import {
  authorizeJobCommit,
  isTerminalJobStatus,
  restoreBackgroundJob,
  validateBackgroundJob,
  validateJobTransition,
  type BackgroundJob,
  type BackgroundJobStatus,
} from "./contracts";

const ENVELOPE_SCHEMA_VERSION = "job-store-envelope-v1" as const;
const JOB_SCHEMA_VERSION = "background-job-v1" as const;
const SAFE_JOB_ID = /^job-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface StoredEnvelope<T> {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  kind: "background-job" | "job-idempotency" | "job-rollback";
  checksum: string;
  payload: T;
}

interface IdempotencyRecord {
  schemaVersion: "job-idempotency-v1";
  idempotencyKeyHash: string;
  jobId: string;
  type: string;
  handlerVersion: string;
  inputHash: string;
  payloadRef: string;
  createdAt: string;
}

interface JobRollbackRecord {
  schemaVersion: "job-rollback-v1";
  jobId: string;
  fromRevision: number;
  toRevision: number;
  previousChecksum: string;
  createdAt: string;
  previous: BackgroundJob;
}

export interface CreateBackgroundJobInput {
  type: string;
  handlerVersion: string;
  idempotencyKey: string;
  inputHash: string;
  payloadRef: string;
  planId?: string;
  maxAttempts?: number;
  runAfter?: string;
  networkRequired?: boolean;
  dependencyJobIds?: string[];
}

export interface JobLease {
  expectedRevision: number;
  leaseToken: string;
  runtimeGeneration: number;
}

export interface ClaimedBackgroundJob {
  job: BackgroundJob;
  lease: JobLease;
}

export interface JobFailureInput {
  code: string;
  /** Must already be redacted. Repositories never persist an exception stack. */
  redactedMessage: string;
  retryAt?: string;
  retryable?: boolean;
}

export interface FileJobRepositoryOptions {
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  now?: () => string;
  leaseToken?: () => string;
  leaseDurationMs?: number;
}

interface RuntimeStateView {
  runtimeGeneration: number;
  revision: number;
  activeRoot: string;
}

interface RuntimeOperationContext {
  state: RuntimeStateView;
  activeRoot: string;
}

export type JobRepositoryErrorCode =
  | "not_found"
  | "conflict"
  | "corrupt_data"
  | "invalid_input"
  | "fenced"
  | "dependency_blocked";

export class JobRepositoryError extends Error {
  constructor(readonly code: JobRepositoryErrorCode, message: string) {
    super(message);
    this.name = "JobRepositoryError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new JobRepositoryError("invalid_input", `${field} must be an ISO timestamp`);
  return timestamp;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new JobRepositoryError("invalid_input", `${field} must not be empty`);
}

function jobIdFor(idempotencyKey: string): string {
  return `job-${createHash("sha256").update(idempotencyKey.normalize("NFC"), "utf8").digest("hex")}`;
}

function idempotencyHash(idempotencyKey: string): string {
  return createHash("sha256").update(`buildsim-job-idempotency\0${idempotencyKey.normalize("NFC")}`, "utf8").digest("hex");
}

function leaseFor(job: BackgroundJob): JobLease {
  if (job.status !== "running" || !job.leaseToken) throw new JobRepositoryError("invalid_input", "job does not hold a live lease");
  return Object.freeze({
    expectedRevision: job.revision,
    leaseToken: job.leaseToken,
    runtimeGeneration: job.runtimeGeneration,
  });
}

function withoutLease(job: BackgroundJob): Omit<BackgroundJob, "leaseOwner" | "leaseToken" | "leaseExpiresAt"> {
  const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expires, ...rest } = job;
  return rest;
}

function envelope<T>(kind: StoredEnvelope<T>["kind"], payload: T): StoredEnvelope<T> {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind,
    checksum: sha256Json(payload),
    payload: clone(payload),
  };
}

function parseEnvelope<T>(raw: unknown, kind: StoredEnvelope<T>["kind"]): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new JobRepositoryError("corrupt_data", "job store envelope is not an object");
  const candidate = raw as Partial<StoredEnvelope<T>>;
  if (candidate.schemaVersion !== ENVELOPE_SCHEMA_VERSION || candidate.kind !== kind || !("payload" in candidate)
    || typeof candidate.checksum !== "string" || candidate.checksum !== sha256Json(candidate.payload)) {
    throw new JobRepositoryError("corrupt_data", "job store envelope checksum or schema is invalid");
  }
  return clone(candidate.payload as T);
}

/**
 * Durable job state backed by the active runtime generation. Every mutation is
 * serialized by RuntimeCoordinator's cross-process lock and then guarded again
 * by job revision/lease/runtime-generation fencing.
 */
export class FileJobRepository {
  readonly coordinator: RuntimeCoordinator;
  private readonly now: () => string;
  private readonly makeLeaseToken: () => string;
  private readonly leaseDurationMs: number;

  constructor(options: FileJobRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.makeLeaseToken = options.leaseToken ?? randomUUID;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    if (!Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000 || this.leaseDurationMs > 3_600_000) {
      throw new TypeError("leaseDurationMs must be between 1 second and 1 hour");
    }
    this.coordinator = options.coordinator ?? new RuntimeCoordinator({ root: options.runtimeRoot, now: this.now });
  }

  async initialize(appVersion?: string): Promise<void> {
    const state = await this.coordinator.initialize(appVersion);
    await this.ensureLayout(this.coordinator.activeRoot(state));
  }

  private jobsRoot(activeRoot: string): string {
    return confined(activeRoot, "jobs");
  }

  private recordsRoot(activeRoot: string): string {
    return confined(this.jobsRoot(activeRoot), "records");
  }

  private idempotencyRoot(activeRoot: string): string {
    return confined(this.jobsRoot(activeRoot), "idempotency");
  }

  private rollbackRoot(activeRoot: string): string {
    return confined(this.jobsRoot(activeRoot), "rollback");
  }

  private jobFile(activeRoot: string, jobId: string): string {
    if (!SAFE_JOB_ID.test(jobId)) throw new JobRepositoryError("invalid_input", "jobId is invalid");
    return confined(this.recordsRoot(activeRoot), `${jobId}.json`);
  }

  private idempotencyFile(activeRoot: string, keyHash: string): string {
    if (!SHA256.test(keyHash)) throw new JobRepositoryError("invalid_input", "idempotency hash is invalid");
    return confined(this.idempotencyRoot(activeRoot), `${keyHash}.json`);
  }

  private rollbackFile(activeRoot: string, job: BackgroundJob): string {
    return confined(this.rollbackRoot(activeRoot), job.jobId, `${String(job.revision).padStart(12, "0")}.json`);
  }

  private async ensureLayout(activeRoot: string): Promise<void> {
    await ensurePrivateDirectory(this.recordsRoot(activeRoot));
    await ensurePrivateDirectory(this.idempotencyRoot(activeRoot));
    await ensurePrivateDirectory(this.rollbackRoot(activeRoot));
  }

  private async readStoredJob(activeRoot: string, jobId: string): Promise<BackgroundJob> {
    const file = this.jobFile(activeRoot, jobId);
    if (!await pathExists(file)) throw new JobRepositoryError("not_found", `background job ${jobId} was not found`);
    let job: BackgroundJob;
    try {
      job = parseEnvelope<BackgroundJob>(await readJson(file), "background-job");
    } catch (error) {
      if (error instanceof JobRepositoryError) throw error;
      throw new JobRepositoryError("corrupt_data", `background job ${jobId} cannot be read`);
    }
    const errors = validateBackgroundJob(job);
    if (errors.length > 0 || job.jobId !== jobId) throw new JobRepositoryError("corrupt_data", `background job ${jobId} is invalid: ${errors.join("; ")}`);
    return job;
  }

  private async readIdempotency(activeRoot: string, keyHash: string): Promise<IdempotencyRecord | null> {
    const file = this.idempotencyFile(activeRoot, keyHash);
    if (!await pathExists(file)) return null;
    try {
      const record = parseEnvelope<IdempotencyRecord>(await readJson(file), "job-idempotency");
      if (record.schemaVersion !== "job-idempotency-v1" || record.idempotencyKeyHash !== keyHash || !SAFE_JOB_ID.test(record.jobId)
        || !record.type || !record.handlerVersion || !SHA256.test(record.inputHash) || !record.payloadRef
        || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("invalid idempotency record");
      return record;
    } catch {
      throw new JobRepositoryError("corrupt_data", "job idempotency index is corrupt");
    }
  }

  private async listStoredJobs(activeRoot: string): Promise<BackgroundJob[]> {
    if (!await pathExists(this.recordsRoot(activeRoot))) return [];
    const entries = await readdir(this.recordsRoot(activeRoot), { withFileTypes: true });
    const jobs: BackgroundJob[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw new JobRepositoryError("corrupt_data", "job repository contains a symbolic link");
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const jobId = entry.name.slice(0, -5);
      jobs.push(await this.readStoredJob(activeRoot, jobId));
    }
    return jobs;
  }

  private async writeNewJob(activeRoot: string, job: BackgroundJob): Promise<void> {
    const errors = validateBackgroundJob(job);
    if (errors.length > 0) throw new JobRepositoryError("invalid_input", errors.join("; "));
    const file = this.jobFile(activeRoot, job.jobId);
    if (await pathExists(file)) throw new JobRepositoryError("conflict", "background job already exists");
    await atomicWriteJson(file, envelope("background-job", job));
  }

  private async writeTransition(activeRoot: string, previous: BackgroundJob, next: BackgroundJob): Promise<void> {
    const errors = validateJobTransition(previous, next);
    if (errors.length > 0) throw new JobRepositoryError("invalid_input", errors.join("; "));
    const rollback: JobRollbackRecord = {
      schemaVersion: "job-rollback-v1",
      jobId: previous.jobId,
      fromRevision: previous.revision,
      toRevision: next.revision,
      previousChecksum: sha256Json(previous),
      createdAt: this.now(),
      previous: clone(previous),
    };
    await atomicWriteJson(this.rollbackFile(activeRoot, previous), envelope("job-rollback", rollback));
    await atomicWriteJson(this.jobFile(activeRoot, next.jobId), envelope("background-job", next));
  }

  private assertCurrentGeneration(job: BackgroundJob, runtimeGeneration: number): void {
    if (job.runtimeGeneration !== runtimeGeneration) throw new JobRepositoryError("fenced", "job belongs to a stale runtime generation");
  }

  private assertFence(job: BackgroundJob, lease: JobLease, committedAt: string, runtimeGeneration: number): void {
    this.assertCurrentGeneration(job, runtimeGeneration);
    const authorization = authorizeJobCommit(job, { ...lease, committedAt });
    if (!authorization.allowed) throw new JobRepositoryError("fenced", `job commit was fenced: ${authorization.reason ?? "unknown"}`);
  }

  async create(input: CreateBackgroundJobInput): Promise<{ job: BackgroundJob; created: boolean }> {
    assertNonEmpty(input.type, "type");
    assertNonEmpty(input.handlerVersion, "handlerVersion");
    assertNonEmpty(input.idempotencyKey, "idempotencyKey");
    assertNonEmpty(input.payloadRef, "payloadRef");
    if (!SHA256.test(input.inputHash)) throw new JobRepositoryError("invalid_input", "inputHash must be sha256");
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new JobRepositoryError("invalid_input", "maxAttempts must be positive");
    const dependencyJobIds = [...(input.dependencyJobIds ?? [])];
    if (dependencyJobIds.some((id) => !SAFE_JOB_ID.test(id)) || new Set(dependencyJobIds).size !== dependencyJobIds.length) {
      throw new JobRepositoryError("invalid_input", "dependencyJobIds are invalid or duplicated");
    }
    const runAfter = input.runAfter ?? this.now();
    parseTimestamp(runAfter, "runAfter");
    const keyHash = idempotencyHash(input.idempotencyKey);
    const jobId = jobIdFor(input.idempotencyKey);
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      await this.ensureLayout(activeRoot);
      const existingIndex = await this.readIdempotency(activeRoot, keyHash);
      if (existingIndex) {
        const existing = await this.readStoredJob(activeRoot, existingIndex.jobId);
        if (existing.type !== input.type || existing.handlerVersion !== input.handlerVersion || existing.inputHash !== input.inputHash
          || existing.payloadRef !== input.payloadRef || existing.idempotencyKey !== input.idempotencyKey) {
          throw new JobRepositoryError("conflict", "idempotency key was already used for different input");
        }
        return { job: clone(existing), created: false };
      }
      if (await pathExists(this.jobFile(activeRoot, jobId))) {
        const orphan = await this.readStoredJob(activeRoot, jobId);
        if (orphan.type !== input.type || orphan.handlerVersion !== input.handlerVersion || orphan.inputHash !== input.inputHash
          || orphan.payloadRef !== input.payloadRef || orphan.idempotencyKey !== input.idempotencyKey) {
          throw new JobRepositoryError("conflict", "deterministic job identity conflicts with different input");
        }
        const recoveredIndex: IdempotencyRecord = {
          schemaVersion: "job-idempotency-v1", idempotencyKeyHash: keyHash, jobId,
          type: orphan.type, handlerVersion: orphan.handlerVersion, inputHash: orphan.inputHash,
          payloadRef: orphan.payloadRef, createdAt: orphan.createdAt,
        };
        await atomicWriteJson(this.idempotencyFile(activeRoot, keyHash), envelope("job-idempotency", recoveredIndex));
        return { job: clone(orphan), created: false };
      }
      for (const dependencyJobId of dependencyJobIds) await this.readStoredJob(activeRoot, dependencyJobId);
      const createdAt = this.now();
      parseTimestamp(createdAt, "createdAt");
      const job: BackgroundJob = {
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        type: input.type,
        handlerVersion: input.handlerVersion,
        idempotencyKey: input.idempotencyKey,
        inputHash: input.inputHash,
        payloadRef: input.payloadRef,
        ...(input.planId === undefined ? {} : { planId: input.planId }),
        status: "queued",
        revision: 0,
        attempt: 0,
        maxAttempts,
        runAfter,
        runtimeGeneration: state.runtimeGeneration,
        networkRequired: input.networkRequired ?? false,
        dependencyJobIds,
        resultRefs: [],
        createdAt,
        updatedAt: createdAt,
      };
      await this.writeNewJob(activeRoot, job);
      const index: IdempotencyRecord = {
        schemaVersion: "job-idempotency-v1", idempotencyKeyHash: keyHash, jobId,
        type: job.type, handlerVersion: job.handlerVersion, inputHash: job.inputHash,
        payloadRef: job.payloadRef, createdAt,
      };
      await atomicWriteJson(this.idempotencyFile(activeRoot, keyHash), envelope("job-idempotency", index));
      return { job: clone(job), created: true };
    })).result;
  }

  async get(jobId: string): Promise<BackgroundJob> {
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: RuntimeOperationContext) => this.readStoredJob(activeRoot, jobId))).result;
  }

  async list(): Promise<BackgroundJob[]> {
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: RuntimeOperationContext) => this.listStoredJobs(activeRoot))).result;
  }

  /** Called from a RuntimeCoordinator consistent-snapshot barrier; it never reacquires the lock or writes. */
  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "jobs";
    revision: number;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" | "optional_for_audit" }>;
  }> {
    const jobs = await this.listStoredJobs(activeRoot);
    const jobRef = (jobId: string) => `job:${jobId}`;
    const nodes = jobs.map((job) => jobRef(job.jobId)).sort();
    const edges = jobs.flatMap((job) => {
      const fromRef = jobRef(job.jobId);
      const replayNecessity = isTerminalJobStatus(job.status) ? "optional_for_audit" as const : "required_for_replay" as const;
      return [
        { fromRef, toRef: job.payloadRef, necessity: replayNecessity },
        ...job.dependencyJobIds.map((dependencyJobId) => ({ fromRef, toRef: jobRef(dependencyJobId), necessity: "required_for_replay" as const })),
        ...(job.checkpointRef ? [{ fromRef, toRef: job.checkpointRef, necessity: replayNecessity }] : []),
        ...job.resultRefs.map((toRef) => ({ fromRef, toRef, necessity: "optional_for_audit" as const })),
      ];
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return {
      providerId: "jobs",
      revision: jobs.reduce((maximum, job) => Math.max(maximum, job.revision), 0),
      manifestHash: sha256Json(jobs),
      snapshotPointers: [...nodes],
      nodes,
      edges,
    };
  }

  async claimNext(workerId: string, options: { online?: boolean; leaseDurationMs?: number; types?: readonly string[] } = {}): Promise<ClaimedBackgroundJob | null> {
    assertNonEmpty(workerId, "workerId");
    const duration = options.leaseDurationMs ?? this.leaseDurationMs;
    if (!Number.isInteger(duration) || duration < 1_000 || duration > 3_600_000) throw new JobRepositoryError("invalid_input", "lease duration is invalid");
    const now = this.now();
    const nowMs = parseTimestamp(now, "now");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const jobs = await this.listStoredJobs(activeRoot);
      const byId = new Map(jobs.map((job) => [job.jobId, job]));
      const allowedTypes = options.types === undefined ? null : new Set(options.types);
      if (allowedTypes?.has("") || (allowedTypes && allowedTypes.size !== options.types?.length)) {
        throw new JobRepositoryError("invalid_input", "claim types must be unique and non-empty");
      }
      const candidates = jobs
        .filter((job) => job.status === "queued" && job.runtimeGeneration === state.runtimeGeneration && Date.parse(job.runAfter) <= nowMs
          && (allowedTypes === null || allowedTypes.has(job.type)))
        .sort((left, right) => left.runAfter.localeCompare(right.runAfter) || left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId));
      for (const job of candidates) {
        if (job.dependencyJobIds.some((dependencyId) => byId.get(dependencyId)?.status !== "succeeded")) continue;
        if (job.networkRequired && options.online === false) {
          const paused: BackgroundJob = { ...job, status: "paused_offline", revision: job.revision + 1, updatedAt: now };
          await this.writeTransition(activeRoot, job, paused);
          continue;
        }
        const leaseToken = this.makeLeaseToken();
        assertNonEmpty(leaseToken, "leaseToken");
        const claimed: BackgroundJob = {
          ...job,
          status: "running",
          revision: job.revision + 1,
          attempt: job.attempt + 1,
          leaseOwner: workerId,
          leaseToken,
          leaseExpiresAt: new Date(nowMs + duration).toISOString(),
          updatedAt: now,
        };
        await this.writeTransition(activeRoot, job, claimed);
        return { job: clone(claimed), lease: leaseFor(claimed) };
      }
      return null;
    })).result;
  }

  async heartbeat(jobId: string, lease: JobLease, options: { progress?: BackgroundJob["progress"]; leaseDurationMs?: number } = {}): Promise<ClaimedBackgroundJob> {
    const duration = options.leaseDurationMs ?? this.leaseDurationMs;
    if (!Number.isInteger(duration) || duration < 1_000 || duration > 3_600_000) throw new JobRepositoryError("invalid_input", "lease duration is invalid");
    const now = this.now();
    const nowMs = parseTimestamp(now, "now");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const current = await this.readStoredJob(activeRoot, jobId);
      this.assertFence(current, lease, now, state.runtimeGeneration);
      const next: BackgroundJob = {
        ...current,
        revision: current.revision + 1,
        leaseExpiresAt: new Date(nowMs + duration).toISOString(),
        ...(options.progress === undefined ? {} : { progress: clone(options.progress) }),
        updatedAt: now,
      };
      await this.writeTransition(activeRoot, current, next);
      return { job: clone(next), lease: leaseFor(next) };
    })).result;
  }

  async checkpoint(jobId: string, lease: JobLease, checkpointRef: string, progress?: BackgroundJob["progress"]): Promise<ClaimedBackgroundJob> {
    assertNonEmpty(checkpointRef, "checkpointRef");
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const current = await this.readStoredJob(activeRoot, jobId);
      this.assertFence(current, lease, now, state.runtimeGeneration);
      const next: BackgroundJob = {
        ...current,
        revision: current.revision + 1,
        checkpointRef,
        ...(progress === undefined ? {} : { progress: clone(progress) }),
        updatedAt: now,
      };
      await this.writeTransition(activeRoot, current, next);
      return { job: clone(next), lease: leaseFor(next) };
    })).result;
  }

  async succeed(jobId: string, lease: JobLease, resultRefs: string[], resultCommitHash: string): Promise<BackgroundJob> {
    if (!SHA256.test(resultCommitHash)) throw new JobRepositoryError("invalid_input", "resultCommitHash must be sha256");
    if (resultRefs.some((ref) => !ref) || new Set(resultRefs).size !== resultRefs.length) throw new JobRepositoryError("invalid_input", "resultRefs are invalid or duplicated");
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const current = await this.readStoredJob(activeRoot, jobId);
      this.assertFence(current, lease, now, state.runtimeGeneration);
      const next: BackgroundJob = {
        ...withoutLease(current),
        status: "succeeded",
        revision: current.revision + 1,
        resultRefs: [...resultRefs],
        resultCommitHash,
        updatedAt: now,
      };
      await this.writeTransition(activeRoot, current, next);
      return clone(next);
    })).result;
  }

  async fail(jobId: string, lease: JobLease, failure: JobFailureInput): Promise<BackgroundJob> {
    assertNonEmpty(failure.code, "failure.code");
    assertNonEmpty(failure.redactedMessage, "failure.redactedMessage");
    if (failure.redactedMessage.length > 512 || /(?:api[_-]?key|authorization|bearer|cookie|password)\s*[:=]/i.test(failure.redactedMessage)) {
      throw new JobRepositoryError("invalid_input", "failure message is not safely redacted");
    }
    const now = this.now();
    const retryAt = failure.retryAt ?? now;
    parseTimestamp(retryAt, "retryAt");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const current = await this.readStoredJob(activeRoot, jobId);
      this.assertFence(current, lease, now, state.runtimeGeneration);
      const retryable = failure.retryable ?? true;
      const status: BackgroundJobStatus = !retryable ? "failed" : current.attempt >= current.maxAttempts ? "dead_letter" : "waiting_retry";
      const next: BackgroundJob = {
        ...withoutLease(current),
        status,
        revision: current.revision + 1,
        runAfter: retryAt,
        lastError: { code: failure.code, message: failure.redactedMessage, redacted: true },
        updatedAt: now,
      };
      await this.writeTransition(activeRoot, current, next);
      return clone(next);
    })).result;
  }

  async promoteReadyRetries(): Promise<number> {
    const now = this.now();
    const nowMs = parseTimestamp(now, "now");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const jobs = await this.listStoredJobs(activeRoot);
      let promoted = 0;
      for (const job of jobs) {
        if (job.status !== "waiting_retry" || job.runtimeGeneration !== state.runtimeGeneration || Date.parse(job.runAfter) > nowMs) continue;
        const next: BackgroundJob = { ...job, status: "queued", revision: job.revision + 1, updatedAt: now };
        await this.writeTransition(activeRoot, job, next);
        promoted += 1;
      }
      return promoted;
    })).result;
  }

  async recoverExpiredLeases(): Promise<number> {
    const now = this.now();
    const nowMs = parseTimestamp(now, "now");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const jobs = await this.listStoredJobs(activeRoot);
      let recovered = 0;
      for (const job of jobs) {
        if (job.status !== "running" || job.runtimeGeneration !== state.runtimeGeneration || Date.parse(job.leaseExpiresAt ?? "") > nowMs) continue;
        const status: BackgroundJobStatus = job.attempt >= job.maxAttempts ? "dead_letter" : "waiting_retry";
        const next: BackgroundJob = {
          ...withoutLease(job),
          status,
          revision: job.revision + 1,
          runAfter: now,
          lastError: { code: "lease_expired", message: "Worker lease expired before completion", redacted: true },
          updatedAt: now,
        };
        await this.writeTransition(activeRoot, job, next);
        recovered += 1;
      }
      return recovered;
    })).result;
  }

  async resume(jobId: string, expectedRevision: number): Promise<BackgroundJob> {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const current = await this.readStoredJob(activeRoot, jobId);
      this.assertCurrentGeneration(current, state.runtimeGeneration);
      if (current.revision !== expectedRevision) throw new JobRepositoryError("conflict", "job revision changed");
      if (!["waiting_user", "waiting_retry", "paused_offline", "paused_restore_review"].includes(current.status)) {
        throw new JobRepositoryError("invalid_input", "job status cannot be resumed");
      }
      const next: BackgroundJob = { ...current, status: "queued", revision: current.revision + 1, runAfter: now, updatedAt: now };
      await this.writeTransition(activeRoot, current, next);
      return clone(next);
    })).result;
  }

  async pauseOffline(jobId: string, lease: JobLease): Promise<BackgroundJob> {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const current = await this.readStoredJob(activeRoot, jobId);
      this.assertFence(current, lease, now, state.runtimeGeneration);
      if (!current.networkRequired) throw new JobRepositoryError("invalid_input", "only network-required jobs may pause offline");
      const next: BackgroundJob = { ...withoutLease(current), status: "paused_offline", revision: current.revision + 1, updatedAt: now };
      await this.writeTransition(activeRoot, current, next);
      return clone(next);
    })).result;
  }

  async cancel(jobId: string, expectedRevision: number, lease?: JobLease): Promise<BackgroundJob> {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      const current = await this.readStoredJob(activeRoot, jobId);
      this.assertCurrentGeneration(current, state.runtimeGeneration);
      if (isTerminalJobStatus(current.status)) return clone(current);
      if (current.revision !== expectedRevision) throw new JobRepositoryError("conflict", "job revision changed");
      if (current.status === "running") {
        if (!lease) throw new JobRepositoryError("fenced", "running job cancellation requires its lease");
        this.assertFence(current, lease, now, state.runtimeGeneration);
      }
      const base = current.status === "running" ? withoutLease(current) : current;
      const next: BackgroundJob = { ...base, status: "cancelled", revision: current.revision + 1, updatedAt: now };
      await this.writeTransition(activeRoot, current, next);
      return clone(next);
    })).result;
  }
}

/**
 * Must run against an inaccessible staging generation while a maintenance lease
 * is held. It removes every old lease and quarantines every non-terminal job
 * before the restored generation can become active.
 */
export async function quarantineRestoredJobs(
  stagingActiveRoot: string,
  runtimeGeneration: number,
  restoredAt: string,
): Promise<{ restored: number; terminal: number }> {
  if (!Number.isInteger(runtimeGeneration) || runtimeGeneration < 1) throw new TypeError("runtimeGeneration is invalid");
  parseTimestamp(restoredAt, "restoredAt");
  const recordsRoot = confined(stagingActiveRoot, "jobs", "records");
  await ensurePrivateDirectory(recordsRoot);
  const entries = await readdir(recordsRoot, { withFileTypes: true });
  let restored = 0;
  let terminal = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new JobRepositoryError("corrupt_data", "restored job repository contains a symbolic link");
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = confined(recordsRoot, entry.name);
    const job = parseEnvelope<BackgroundJob>(await readJson(file), "background-job");
    const errors = validateBackgroundJob(job);
    if (errors.length > 0) throw new JobRepositoryError("corrupt_data", `restored job is invalid: ${errors.join("; ")}`);
    if (job.runtimeGeneration >= runtimeGeneration) throw new JobRepositoryError("corrupt_data", "restored job generation was not advanced");
    const next = restoreBackgroundJob(job, runtimeGeneration, restoredAt);
    await atomicWriteJson(file, envelope("background-job", next));
    if (isTerminalJobStatus(job.status)) terminal += 1;
    else restored += 1;
  }
  return { restored, terminal };
}

export function currentJobLease(job: BackgroundJob): JobLease {
  return leaseFor(job);
}
