import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeCoordinator } from "../../../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, ensurePrivateDirectory, pathExists, readJson, sha256Json } from "../../../src/runtime/fs.mjs";

const ENVELOPE_VERSION = "catalog-search-store-envelope-v1";
const JOB_VERSION = "background-job-v1";
const JOB_ID = /^catalog-search-[a-f0-9]{20}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "dead_letter"]);
const JOB_TRANSITIONS = Object.freeze({
  queued: ["running", "paused_restore_review", "cancelled"],
  running: ["running", "queued", "waiting_retry", "paused_restore_review", "succeeded", "failed", "cancelled", "dead_letter"],
  waiting_retry: ["queued", "cancelled"],
  waiting_user: ["queued", "cancelled"],
  paused_offline: ["queued", "cancelled"],
  paused_restore_review: ["queued", "cancelled"],
  succeeded: [], failed: [], cancelled: [], dead_letter: [],
});
const DEFAULT_CATALOG_LEASE_MS = 300_000;

function leaseDuration(value) {
  const parsed = Number(value ?? process.env.CATALOG_JOB_LEASE_MS ?? DEFAULT_CATALOG_LEASE_MS);
  return Number.isInteger(parsed) && parsed >= 30_000 && parsed <= 900_000 ? parsed : DEFAULT_CATALOG_LEASE_MS;
}

function clone(value) { return structuredClone(value); }
function hash(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function envelope(kind, payload) { return { schemaVersion: ENVELOPE_VERSION, kind, checksum: sha256Json(payload), payload: clone(payload) }; }
function parseEnvelope(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== ENVELOPE_VERSION
    || value.kind !== kind || typeof value.checksum !== "string" || value.checksum !== sha256Json(value.payload)) {
    throw new CatalogJobRepositoryError("corrupt_data", `catalog ${kind} envelope checksum or schema is invalid`);
  }
  return clone(value.payload);
}
function date(value, field) {
  if (!Number.isFinite(Date.parse(value))) throw new CatalogJobRepositoryError("invalid_input", `${field} must be an ISO timestamp`);
}
function withoutLease(job) {
  const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expiry, ...rest } = job;
  return rest;
}
function checkpointStage(job) {
  const value = typeof job.checkpointRef === "string" ? job.checkpointRef.split(":").pop() : "";
  return value && /^[a-z][a-z0-9_-]*$/i.test(value) ? value : null;
}
function assertJob(job) {
  if (!job || typeof job !== "object" || job.schemaVersion !== JOB_VERSION || !JOB_ID.test(job.jobId)
    || !job.type || !job.handlerVersion || !job.idempotencyKey || !SHA256.test(job.inputHash) || !job.payloadRef
    || !Number.isInteger(job.revision) || job.revision < 0 || !Number.isInteger(job.attempt) || job.attempt < 0
    || !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.attempt > job.maxAttempts
    || !Number.isInteger(job.runtimeGeneration) || job.runtimeGeneration < 1 || !Array.isArray(job.dependencyJobIds)
    || !Array.isArray(job.resultRefs) || !JOB_TRANSITIONS[job.status]) throw new CatalogJobRepositoryError("corrupt_data", "catalog background job is invalid");
  if (job.dependencyJobIds.some((id) => !id || id === job.jobId) || new Set(job.dependencyJobIds).size !== job.dependencyJobIds.length) throw new CatalogJobRepositoryError("corrupt_data", "catalog job dependencies are invalid");
  if (job.resultRefs.some((ref) => !ref) || new Set(job.resultRefs).size !== job.resultRefs.length) throw new CatalogJobRepositoryError("corrupt_data", "catalog job result references are invalid");
  date(job.createdAt, "createdAt"); date(job.updatedAt, "updatedAt"); date(job.runAfter, "runAfter");
  const leaseFields = [job.leaseOwner, job.leaseToken, job.leaseExpiresAt].filter((value) => value !== undefined);
  if (job.status === "running" && leaseFields.length !== 3) throw new CatalogJobRepositoryError("corrupt_data", "running catalog job has no complete lease");
  if (job.status !== "running" && leaseFields.length !== 0) throw new CatalogJobRepositoryError("corrupt_data", "non-running catalog job retains a lease");
  if (job.status === "running") date(job.leaseExpiresAt, "leaseExpiresAt");
  return job;
}

export class CatalogJobRepositoryError extends Error {
  constructor(code, message) { super(message); this.name = "CatalogJobRepositoryError"; this.code = code; }
}

/**
 * JavaScript adapter for the price process. It deliberately mirrors the U1
 * BackgroundJob fence contract without relying on a TypeScript runtime loader.
 * Records belong to the RuntimeCoordinator active generation, never to a
 * process-local Map.
 */
export class CatalogSearchJobRepository {
  constructor(options = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    // One governed candidate may legitimately require static fetch, two
    // browser renderers and bounded PDF/OCR fallback. Thirty seconds fences a
    // healthy worker mid-inspection, so catalog leases use a bounded five
    // minute default and are renewed at each durable checkpoint.
    this.leaseDurationMs = leaseDuration(options.leaseDurationMs);
    this.leaseToken = options.leaseToken ?? randomUUID;
    this.coordinator = options.coordinator ?? new RuntimeCoordinator({ root: options.persistRoot ?? path.join(process.cwd(), "runtime"), now: this.now });
    this.restoreReview = Boolean(options.restoreReview);
    // A process restart may see many abandoned workers. Recovering one lease
    // per boot keeps startup bounded; subsequent claim calls can recover the
    // next one as needed.
    this.recoveryLimit = options.recoveryLimit ?? 1;
  }

  root(activeRoot) { return confined(activeRoot, "jobs", "catalog-search"); }
  recordsRoot(activeRoot) { return confined(this.root(activeRoot), "records"); }
  idempotencyRoot(activeRoot) { return confined(this.root(activeRoot), "idempotency"); }
  candidatesRoot(activeRoot) { return confined(this.root(activeRoot), "candidates"); }
  rollbackRoot(activeRoot) { return confined(this.root(activeRoot), "rollback"); }
  candidateRollbackRoot(activeRoot) { return confined(this.rollbackRoot(activeRoot), "candidates"); }
  jobFile(activeRoot, jobId) {
    if (!JOB_ID.test(jobId)) throw new CatalogJobRepositoryError("invalid_input", "catalog jobId is invalid");
    return confined(this.recordsRoot(activeRoot), `${jobId}.json`);
  }
  candidateFile(activeRoot, candidateId) {
    if (typeof candidateId !== "string" || !/^catalog-candidate-[a-f0-9]{16}$/.test(candidateId)) throw new CatalogJobRepositoryError("invalid_input", "catalog candidateId is invalid");
    return confined(this.candidatesRoot(activeRoot), `${candidateId}.json`);
  }
  idempotencyFile(activeRoot, key) { return confined(this.idempotencyRoot(activeRoot), `${hash(`catalog-search-idempotency\0${key}`)}.json`); }

  async ensureLayout(activeRoot) {
    await Promise.all([this.recordsRoot(activeRoot), this.idempotencyRoot(activeRoot), this.candidatesRoot(activeRoot), this.rollbackRoot(activeRoot), this.candidateRollbackRoot(activeRoot)].map(ensurePrivateDirectory));
  }

  async initialize(appVersion = "0.2.0-alpha") {
    await this.coordinator.initialize(appVersion);
    // Layout creation is itself a coordinated mutation. In particular, do
    // not create repository directories beside the coordinator lock: another
    // process may be switching the active generation at the same time.
    const initialized = await this.coordinator.withWrite(async ({ activeRoot }) => {
      await this.ensureLayout(activeRoot);
      return true;
    });
    if (this.restoreReview) await this.quarantineNonTerminal();
    else await this.recoverExpiredLeases(this.recoveryLimit);
    return (await this.coordinator.readState()) ?? initialized.state;
  }

  async readJob(activeRoot, jobId) {
    const file = this.jobFile(activeRoot, jobId);
    if (!await pathExists(file)) throw new CatalogJobRepositoryError("not_found", `catalog job ${jobId} was not found`);
    let stored;
    try { stored = parseEnvelope(await readJson(file), "catalog-search-job"); } catch (error) {
      if (error instanceof CatalogJobRepositoryError) throw error;
      throw new CatalogJobRepositoryError("corrupt_data", `catalog job ${jobId} cannot be read`);
    }
    if (!stored.catalog || typeof stored.catalog !== "object") throw new CatalogJobRepositoryError("corrupt_data", "catalog job metadata is invalid");
    assertJob(stored.job);
    if (stored.job.jobId !== jobId) throw new CatalogJobRepositoryError("corrupt_data", "catalog job identity mismatch");
    return stored;
  }

  async writeJob(activeRoot, record) {
    assertJob(record.job);
    await atomicWriteJson(this.jobFile(activeRoot, record.job.jobId), envelope("catalog-search-job", record));
  }

  validateTransition(previous, next) {
    const errors = [];
    if (previous.job.jobId !== next.job.jobId || previous.job.schemaVersion !== next.job.schemaVersion
      || previous.job.type !== next.job.type || previous.job.handlerVersion !== next.job.handlerVersion
      || previous.job.idempotencyKey !== next.job.idempotencyKey || previous.job.inputHash !== next.job.inputHash
      || previous.job.payloadRef !== next.job.payloadRef || previous.job.createdAt !== next.job.createdAt) {
      errors.push("catalog job immutable identity/input fields changed");
    }
    if (next.job.revision !== previous.job.revision + 1) errors.push("catalog job transition must increment revision exactly once");
    if (next.job.runtimeGeneration !== previous.job.runtimeGeneration) errors.push("ordinary catalog transition cannot cross runtimeGeneration");
    if (!JOB_TRANSITIONS[previous.job.status]?.includes(next.job.status)) errors.push(`illegal catalog job transition: ${previous.job.status} -> ${next.job.status}`);
    if (previous.job.status === "running" && next.job.status === "running"
      && (previous.job.leaseToken !== next.job.leaseToken || previous.job.leaseOwner !== next.job.leaseOwner)) {
      errors.push("running catalog lease cannot be silently replaced");
    }
    if (errors.length) throw new CatalogJobRepositoryError("invalid_input", errors.join("; "));
  }

  async writeTransition(activeRoot, previous, next) {
    this.validateTransition(previous, next);
    const rollback = {
      schemaVersion: "catalog-search-job-rollback-v1",
      jobId: previous.job.jobId,
      fromRevision: previous.job.revision,
      toRevision: next.job.revision,
      previousChecksum: sha256Json(previous),
      createdAt: this.now(),
      previous: clone(previous),
    };
    await atomicWriteJson(confined(this.rollbackRoot(activeRoot), previous.job.jobId, `${String(previous.job.revision).padStart(12, "0")}.json`), envelope("catalog-search-job-rollback", rollback));
    await this.writeJob(activeRoot, next);
  }

  async writeRestoreTransition(activeRoot, previous, next) {
    // Restore is the one operation allowed to cross runtime generations. It
    // still gets an audit rollback record and must be an exactly-one revision
    // step, so a repeated boot is harmless.
    if (next.job.revision !== previous.job.revision + 1) throw new CatalogJobRepositoryError("invalid_input", "restore transition must increment revision exactly once");
    const rollback = {
      schemaVersion: "catalog-search-job-rollback-v1",
      jobId: previous.job.jobId,
      fromRevision: previous.job.revision,
      toRevision: next.job.revision,
      previousChecksum: sha256Json(previous),
      createdAt: this.now(),
      previous: clone(previous),
    };
    await atomicWriteJson(confined(this.rollbackRoot(activeRoot), previous.job.jobId, `${String(previous.job.revision).padStart(12, "0")}.json`), envelope("catalog-search-job-rollback", rollback));
    await this.writeJob(activeRoot, next);
  }

  async get(jobId) {
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }) => clone(await this.readJob(activeRoot, jobId)))).result;
  }

  async list() {
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }) => this.listAt(activeRoot))).result;
  }

  async listAt(activeRoot) {
    if (!await pathExists(this.recordsRoot(activeRoot))) return [];
    const entries = await readdir(this.recordsRoot(activeRoot), { withFileTypes: true });
    const records = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new CatalogJobRepositoryError("corrupt_data", "catalog job store contains a symbolic link");
      if (entry.isFile() && entry.name.endsWith(".json")) records.push(await this.readJob(activeRoot, entry.name.slice(0, -5)));
    }
    return records;
  }

  async create(input) {
    if (!JOB_ID.test(input.jobId) || !input.idempotencyKey || !SHA256.test(input.inputHash) || !input.payloadRef) {
      throw new CatalogJobRepositoryError("invalid_input", "catalog job creation input is invalid");
    }
    const idempotency = hash(`catalog-search-idempotency\0${input.idempotencyKey}`);
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      await this.ensureLayout(activeRoot);
      const indexFile = confined(this.idempotencyRoot(activeRoot), `${idempotency}.json`);
      if (await pathExists(indexFile)) {
        const index = parseEnvelope(await readJson(indexFile), "catalog-search-idempotency");
        const existing = await this.readJob(activeRoot, index.jobId);
        if (existing.job.idempotencyKey !== input.idempotencyKey || existing.job.inputHash !== input.inputHash) {
          throw new CatalogJobRepositoryError("conflict", "catalog idempotency key was reused with different input");
        }
        return { record: clone(existing), created: false };
      }
      const existingFile = this.jobFile(activeRoot, input.jobId);
      if (await pathExists(existingFile)) {
        const existing = await this.readJob(activeRoot, input.jobId);
        if (existing.job.idempotencyKey !== input.idempotencyKey || existing.job.inputHash !== input.inputHash) throw new CatalogJobRepositoryError("conflict", "catalog deterministic job id conflicts");
        await atomicWriteJson(indexFile, envelope("catalog-search-idempotency", { schemaVersion: "catalog-search-idempotency-v1", idempotency, jobId: input.jobId, createdAt: existing.job.createdAt }));
        return { record: clone(existing), created: false };
      }
      const timestamp = this.now(); date(timestamp, "now");
      const job = {
        schemaVersion: JOB_VERSION, jobId: input.jobId, type: "catalog.search", handlerVersion: "1",
        idempotencyKey: input.idempotencyKey, inputHash: input.inputHash, payloadRef: input.payloadRef,
        status: "queued", revision: 0, attempt: 0, maxAttempts: input.maxAttempts ?? 3, runAfter: timestamp,
        runtimeGeneration: state.runtimeGeneration, networkRequired: true, dependencyJobIds: [], resultRefs: [], createdAt: timestamp, updatedAt: timestamp,
      };
      const record = { job, catalog: { ...clone(input.catalog), stage: "normalize", candidates: [], warnings: [], errors: [] } };
      await this.writeJob(activeRoot, record);
      await atomicWriteJson(indexFile, envelope("catalog-search-idempotency", { schemaVersion: "catalog-search-idempotency-v1", idempotency, jobId: input.jobId, createdAt: timestamp }));
      return { record: clone(record), created: true };
    })).result;
  }

  assertFence(record, fence, state, committedAt) {
    const job = record.job;
    if (job.status !== "running" || job.revision !== fence.expectedRevision || job.leaseToken !== fence.leaseToken
      || job.runtimeGeneration !== fence.runtimeGeneration || job.runtimeGeneration !== state.runtimeGeneration
      || Date.parse(job.leaseExpiresAt ?? "") <= Date.parse(committedAt)) throw new CatalogJobRepositoryError("fenced", "catalog job commit was fenced");
  }

  async claimNext(workerId, options = {}) {
    const timestamp = this.now(); const nowMs = Date.parse(timestamp); date(timestamp, "now");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const records = await this.listAt(activeRoot);
      const record = records.filter((entry) => entry.job.status === "queued" && entry.job.runtimeGeneration === state.runtimeGeneration && Date.parse(entry.job.runAfter) <= nowMs
        && (options.jobId === undefined || entry.job.jobId === options.jobId))
        .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt) || a.job.jobId.localeCompare(b.job.jobId))[0];
      if (!record) return null;
      const job = { ...record.job, status: "running", revision: record.job.revision + 1, attempt: record.job.attempt + 1, leaseOwner: workerId, leaseToken: this.leaseToken(), leaseExpiresAt: new Date(nowMs + this.leaseDurationMs).toISOString(), updatedAt: timestamp };
      const next = { ...record, job, catalog: { ...record.catalog, stage: checkpointStage(record.job) ?? "discover" } };
      await this.writeTransition(activeRoot, record, next);
      return { record: clone(next), fence: { expectedRevision: job.revision, leaseToken: job.leaseToken, runtimeGeneration: job.runtimeGeneration } };
    })).result;
  }

  async checkpoint(jobId, fence, patch = {}) {
    const timestamp = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const record = await this.readJob(activeRoot, jobId); this.assertFence(record, fence, state, timestamp);
      const job = { ...record.job, revision: record.job.revision + 1, leaseExpiresAt: new Date(Date.parse(timestamp) + this.leaseDurationMs).toISOString(), checkpointRef: `catalog-search:${jobId}:${patch.stage ?? record.catalog.stage}`, progress: patch.progress ?? record.job.progress, updatedAt: timestamp };
      const next = { ...record, job, catalog: { ...record.catalog, ...clone(patch), stage: patch.stage ?? record.catalog.stage } };
      await this.writeTransition(activeRoot, record, next);
      return { record: clone(next), fence: { expectedRevision: job.revision, leaseToken: job.leaseToken, runtimeGeneration: job.runtimeGeneration } };
    })).result;
  }

  async writeCandidate(activeRoot, candidate, updatedAt, expectedRevision) {
    const file = this.candidateFile(activeRoot, candidate.candidateId);
    const previous = await pathExists(file) ? parseEnvelope(await readJson(file), "catalog-search-candidate") : null;
    const currentRevision = previous?.revision ?? -1;
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || currentRevision !== expectedRevision)) {
      throw new CatalogJobRepositoryError("conflict", "catalog candidate revision changed");
    }
    const payload = { schemaVersion: "catalog-search-candidate-v1", candidateId: candidate.candidateId, candidate: clone(candidate), updatedAt, revision: currentRevision + 1 };
    if (previous) {
      const rollback = {
        schemaVersion: "catalog-search-candidate-rollback-v1",
        candidateId: candidate.candidateId,
        fromRevision: currentRevision,
        toRevision: payload.revision,
        previousChecksum: sha256Json(previous),
        createdAt: updatedAt,
        previous: clone(previous),
      };
      await atomicWriteJson(confined(this.candidateRollbackRoot(activeRoot), candidate.candidateId, `${String(currentRevision).padStart(12, "0")}.json`), envelope("catalog-search-candidate-rollback", rollback));
    }
    await atomicWriteJson(file, envelope("catalog-search-candidate", payload));
    return clone(payload);
  }

  async storeCandidate(candidate, options = {}) {
    // expectedRevision is optional for compatibility with the original API;
    // when provided this is a proper candidate compare-and-swap operation.
    const expectedRevision = typeof options === "number" ? options : options?.expectedRevision;
    return (await this.coordinator.withWrite(async ({ activeRoot }) => {
      await ensurePrivateDirectory(this.candidatesRoot(activeRoot));
      return this.writeCandidate(activeRoot, candidate, this.now(), expectedRevision);
    })).result;
  }

  async complete(jobId, fence, result) {
    const timestamp = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const record = await this.readJob(activeRoot, jobId); this.assertFence(record, fence, state, timestamp);
      const resultCandidates = result.candidates ?? [];
      if (!Array.isArray(resultCandidates) || resultCandidates.some((candidate) => !candidate || typeof candidate.candidateId !== "string" || !/^catalog-candidate-[a-f0-9]{16}$/.test(candidate.candidateId))) {
        throw new CatalogJobRepositoryError("invalid_input", "catalog completion candidates are invalid");
      }
      if (new Set(resultCandidates.map((candidate) => candidate.candidateId)).size !== resultCandidates.length) {
        throw new CatalogJobRepositoryError("conflict", "catalog completion candidates must be unique");
      }
      const candidateIds = [];
      for (const candidate of resultCandidates) {
        await this.writeCandidate(activeRoot, candidate, timestamp);
        candidateIds.push(candidate.candidateId);
      }
      const catalog = { ...record.catalog, ...clone(result), candidateIds, candidates: undefined, stage: "score" };
      delete catalog.candidates;
      const resultCommitHash = sha256Json({ jobId, candidateIds, summary: catalog.summary ?? null, status: result.status });
      const job = { ...withoutLease(record.job), status: "succeeded", revision: record.job.revision + 1, resultRefs: candidateIds.map((id) => `catalog-candidate:${id}`), resultCommitHash, updatedAt: timestamp };
      const next = { job, catalog };
      await this.writeTransition(activeRoot, record, next);
      return clone(next);
    })).result;
  }

  async fail(jobId, fence, error) {
    const timestamp = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const record = await this.readJob(activeRoot, jobId); this.assertFence(record, fence, state, timestamp);
      // Provider exceptions commonly contain request URLs, snippets, email
      // addresses, or opaque response bodies. Persist a stable generic error;
      // the raw exception remains process-local and is never an audit datum.
      const message = "Catalog search failed";
      const job = { ...withoutLease(record.job), status: "failed", revision: record.job.revision + 1, lastError: { code: "catalog_search_failed", message, redacted: true }, updatedAt: timestamp };
      const next = { job, catalog: { ...record.catalog, stage: "score", errors: [...(record.catalog.errors ?? []), message] } };
      await this.writeTransition(activeRoot, record, next);
      return clone(next);
    })).result;
  }

  async findCandidate(candidateId) {
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }) => {
      const file = this.candidateFile(activeRoot, candidateId);
      if (!await pathExists(file)) return null;
      const stored = parseEnvelope(await readJson(file), "catalog-search-candidate");
      if (!stored || stored.schemaVersion !== "catalog-search-candidate-v1" || stored.candidateId !== candidateId) throw new CatalogJobRepositoryError("corrupt_data", "catalog candidate record is invalid");
      return clone(stored.candidate);
    })).result;
  }

  async listCandidates() {
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }) => {
      if (!await pathExists(this.candidatesRoot(activeRoot))) return [];
      const entries = await readdir(this.candidatesRoot(activeRoot), { withFileTypes: true });
      const candidates = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new CatalogJobRepositoryError("corrupt_data", "catalog candidate store contains a symbolic link");
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const candidateId = entry.name.slice(0, -5);
        const value = await this.findCandidateAt(activeRoot, candidateId);
        if (value) candidates.push(value);
      }
      return candidates;
    })).result;
  }

  async findCandidateAt(activeRoot, candidateId) {
    const file = this.candidateFile(activeRoot, candidateId);
    if (!await pathExists(file)) return null;
    const stored = parseEnvelope(await readJson(file), "catalog-search-candidate");
    if (stored?.candidateId !== candidateId) throw new CatalogJobRepositoryError("corrupt_data", "catalog candidate record is invalid");
    return clone(stored.candidate);
  }

  /**
   * Recover abandoned workers on an ordinary process restart. This is
   * intentionally bounded: a caller can invoke it again (or claimNext does
   * so) when draining a large backlog, avoiding a startup write storm.
   */
  async recoverExpiredLeases(limit = this.recoveryLimit) {
    if (!Number.isInteger(limit) || limit < 0) throw new CatalogJobRepositoryError("invalid_input", "recovery limit is invalid");
    const timestamp = this.now(); const nowMs = Date.parse(timestamp); date(timestamp, "now");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const records = await this.listAt(activeRoot);
      let recovered = 0;
      for (const record of records.sort((a, b) => a.job.updatedAt.localeCompare(b.job.updatedAt) || a.job.jobId.localeCompare(b.job.jobId))) {
        if (recovered >= limit || record.job.status !== "running" || record.job.runtimeGeneration !== state.runtimeGeneration
          || Date.parse(record.job.leaseExpiresAt ?? "") > nowMs) continue;
        const job = { ...withoutLease(record.job), status: record.job.attempt >= record.job.maxAttempts ? "dead_letter" : "queued", runAfter: timestamp, revision: record.job.revision + 1, lastError: { code: "lease_expired", message: "Catalog worker lease expired", redacted: true }, updatedAt: timestamp };
        await this.writeTransition(activeRoot, record, { ...record, job });
        recovered += 1;
      }
      return recovered;
    })).result;
  }

  /** Resume a restore-quarantined job only after an explicit user action. */
  async resume(jobId, expectedRevision) {
    const timestamp = this.now(); date(timestamp, "now");
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const record = await this.readJob(activeRoot, jobId);
      if (record.job.runtimeGeneration !== state.runtimeGeneration) throw new CatalogJobRepositoryError("fenced", "catalog job belongs to a stale runtime generation");
      if (record.job.revision !== expectedRevision) throw new CatalogJobRepositoryError("conflict", "catalog job revision changed");
      if (record.job.status !== "paused_restore_review") throw new CatalogJobRepositoryError("invalid_input", "catalog job is not awaiting restore review");
      const job = { ...record.job, status: "queued", runAfter: timestamp, revision: record.job.revision + 1, updatedAt: timestamp };
      const catalog = { ...record.catalog, stage: record.catalog.restoreStage ?? "normalize" };
      const next = { ...record, job, catalog };
      await this.writeTransition(activeRoot, record, next);
      return clone(next);
    })).result;
  }

  /**
   * Read-only provider used inside RuntimeCoordinator.withConsistentSnapshot.
   * It deliberately receives an active root and never calls coordinator APIs.
   */
  async snapshotReferences(activeRoot) {
    const jobs = await this.listAt(activeRoot);
    const candidates = [];
    if (await pathExists(this.candidatesRoot(activeRoot))) {
      const entries = await readdir(this.candidatesRoot(activeRoot), { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new CatalogJobRepositoryError("corrupt_data", "catalog candidate store contains a symbolic link");
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const candidateId = entry.name.slice(0, -5);
        const stored = parseEnvelope(await readJson(this.candidateFile(activeRoot, candidateId)), "catalog-search-candidate");
        if (stored?.candidateId !== candidateId) throw new CatalogJobRepositoryError("corrupt_data", "catalog candidate record is invalid");
        candidates.push(stored);
      }
    }
    const jobRef = (jobId) => `job:${jobId}`;
    const candidateRef = (candidateId) => `catalog-candidate:${candidateId}`;
    const nodes = new Set();
    const edges = [];
    for (const record of jobs) {
      const fromRef = jobRef(record.job.jobId); nodes.add(fromRef);
      const necessity = TERMINAL.has(record.job.status) ? "optional_for_audit" : "required_for_replay";
      nodes.add(record.job.payloadRef); edges.push({ fromRef, toRef: record.job.payloadRef, necessity });
      if (record.job.checkpointRef) { nodes.add(record.job.checkpointRef); edges.push({ fromRef, toRef: record.job.checkpointRef, necessity }); }
      for (const ref of record.job.resultRefs ?? []) { nodes.add(ref); edges.push({ fromRef, toRef: ref, necessity: "optional_for_audit" }); }
      for (const id of record.catalog.candidateIds ?? []) { const ref = candidateRef(id); nodes.add(ref); edges.push({ fromRef, toRef: ref, necessity }); }
      for (const dependencyJobId of record.job.dependencyJobIds ?? []) { const ref = jobRef(dependencyJobId); nodes.add(ref); edges.push({ fromRef, toRef: ref, necessity: "required_for_replay" }); }
    }
    // Include orphan candidates as nodes so Doctor/GC can report them rather
    // than silently treating the durable record as nonexistent.
    for (const candidate of candidates) nodes.add(candidateRef(candidate.candidateId));
    const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.fromRef}\0${edge.toRef}\0${edge.necessity}`, edge])).values()]
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      providerId: "catalog-search",
      revision: Math.max(0, ...jobs.map((record) => record.job.revision), ...candidates.map((record) => record.revision ?? 0)),
      manifestHash: sha256Json({ jobs, candidates }),
      snapshotPointers: [...nodes].sort(),
      nodes: [...nodes].sort(),
      edges: uniqueEdges,
    };
  }

  async quarantineNonTerminal() {
    const timestamp = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const records = await this.listAt(activeRoot); let count = 0;
      for (const record of records) {
        if (record.job.runtimeGeneration === state.runtimeGeneration && (TERMINAL.has(record.job.status) || record.job.status === "paused_restore_review")) continue;
        const status = TERMINAL.has(record.job.status) ? record.job.status : "paused_restore_review";
        const job = { ...withoutLease(record.job), status, revision: record.job.revision + 1, runtimeGeneration: state.runtimeGeneration, updatedAt: timestamp };
        await this.writeRestoreTransition(activeRoot, record, { ...record, job, catalog: { ...record.catalog, ...(status === "paused_restore_review" ? { stage: "paused_restore_review", restoreStage: record.catalog.stage } : {}) } });
        count += 1;
      }
      return count;
    })).result;
  }
}
