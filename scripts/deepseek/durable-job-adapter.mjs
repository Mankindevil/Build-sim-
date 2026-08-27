import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  confined,
  ensurePrivateDirectory,
  pathExists,
  readJson,
  sha256Json,
} from "../../src/runtime/fs.mjs";
import { validateRuntimeBackgroundJob } from "../../src/jobs/runtime-validation.mjs";

const ENVELOPE_SCHEMA = "job-store-envelope-v1";
const JOB_SCHEMA = "background-job-v1";
const JOB_ID = /^job-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const clone = (value) => structuredClone(value);
const jobIdFor = (key) => `job-${createHash("sha256").update(key.normalize("NFC"), "utf8").digest("hex")}`;
const keyHashFor = (key) => createHash("sha256").update(`buildsim-job-idempotency\0${key.normalize("NFC")}`, "utf8").digest("hex");
const envelope = (kind, payload) => ({ schemaVersion: ENVELOPE_SCHEMA, kind, checksum: sha256Json(payload), payload: clone(payload) });

function parseEnvelope(value, kind) {
  if (!value || typeof value !== "object" || value.schemaVersion !== ENVELOPE_SCHEMA || value.kind !== kind
    || value.checksum !== sha256Json(value.payload)) throw new Error("durable job envelope is corrupt");
  return clone(value.payload);
}

function withoutLease(job) {
  const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expires, ...rest } = job;
  return rest;
}

/**
 * Node-MJS bridge for the shared U1 JobRepository layout. It intentionally
 * implements only the CAS/lease/fencing operations used by DeepSeek advice;
 * records remain readable and restorable by the TypeScript repository.
 */
export class DurableJobAdapter {
  /** @param {{coordinator?: any, now?: () => string, leaseToken?: () => string, leaseDurationMs?: number}} [options] */
  constructor(options = {}) {
    const { coordinator, now = () => new Date().toISOString(), leaseToken = randomUUID, leaseDurationMs = 180_000 } = options;
    if (!coordinator) throw new TypeError("durable job adapter requires RuntimeCoordinator");
    this.coordinator = coordinator;
    this.now = now;
    this.leaseToken = leaseToken;
    this.leaseDurationMs = leaseDurationMs;
  }

  roots(activeRoot) {
    const root = confined(activeRoot, "jobs");
    return { root, records: confined(root, "records"), idempotency: confined(root, "idempotency"), rollback: confined(root, "rollback") };
  }

  async initialize() {
    const state = await this.coordinator.initialize();
    const roots = this.roots(this.coordinator.activeRoot(state));
    await Promise.all(Object.values(roots).map((root) => ensurePrivateDirectory(root)));
  }

  jobFile(activeRoot, jobId) {
    if (!JOB_ID.test(jobId)) throw new Error("invalid durable job id");
    return confined(this.roots(activeRoot).records, `${jobId}.json`);
  }

  async readAt(activeRoot, jobId, expectedRuntimeGeneration) {
    const file = this.jobFile(activeRoot, jobId);
    if (!await pathExists(file)) return null;
    const job = parseEnvelope(await readJson(file), "background-job");
    const errors = validateRuntimeBackgroundJob(job, expectedRuntimeGeneration === undefined ? {} : { expectedRuntimeGeneration });
    if (job.schemaVersion !== JOB_SCHEMA || job.jobId !== jobId || errors.length) {
      throw new Error(`durable job record is invalid${errors.length ? `: ${errors.join("; ")}` : ""}`);
    }
    return job;
  }

  async writeTransition(activeRoot, previous, next) {
    const errors = validateRuntimeBackgroundJob(next, { expectedRuntimeGeneration: previous.runtimeGeneration });
    const immutable = ["jobId", "type", "handlerVersion", "idempotencyKey", "inputHash", "payloadRef", "runtimeGeneration", "createdAt"];
    if (errors.length || next.revision !== previous.revision + 1
      || immutable.some((field) => next[field] !== previous[field]) || next.attempt < previous.attempt) {
      throw new Error(`durable job transition is invalid${errors.length ? `: ${errors.join("; ")}` : ""}`);
    }
    const roots = this.roots(activeRoot);
    const rollback = {
      schemaVersion: "job-rollback-v1", jobId: previous.jobId, fromRevision: previous.revision,
      toRevision: next.revision, previousChecksum: sha256Json(previous), createdAt: this.now(), previous,
    };
    const rollbackFile = confined(roots.rollback, previous.jobId, `${String(previous.revision).padStart(12, "0")}.json`);
    await atomicWriteJson(rollbackFile, envelope("job-rollback", rollback));
    await atomicWriteJson(this.jobFile(activeRoot, next.jobId), envelope("background-job", next));
  }

  async create(input) {
    if (!input.type || !input.handlerVersion || !input.idempotencyKey || !input.payloadRef || !SHA256.test(input.inputHash)) throw new Error("invalid durable job input");
    const jobId = jobIdFor(input.idempotencyKey);
    const keyHash = keyHashFor(input.idempotencyKey);
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const roots = this.roots(activeRoot);
      await Promise.all(Object.values(roots).map((root) => ensurePrivateDirectory(root)));
      const indexFile = confined(roots.idempotency, `${keyHash}.json`);
      if (await pathExists(indexFile)) {
        const index = parseEnvelope(await readJson(indexFile), "job-idempotency");
        if (index?.schemaVersion !== "job-idempotency-v1" || index.idempotencyKeyHash !== keyHash
          || !JOB_ID.test(String(index.jobId ?? "")) || index.type !== input.type || index.handlerVersion !== input.handlerVersion
          || index.inputHash !== input.inputHash || index.payloadRef !== input.payloadRef) {
          throw new Error("durable job idempotency record is invalid");
        }
        const existing = await this.readAt(activeRoot, index.jobId, state.runtimeGeneration);
        if (!existing || existing.idempotencyKey !== input.idempotencyKey || existing.type !== input.type
          || existing.handlerVersion !== input.handlerVersion || existing.inputHash !== input.inputHash || existing.payloadRef !== input.payloadRef) {
          throw new Error("durable job idempotency conflict");
        }
        return { job: clone(existing), created: false };
      }
      const createdAt = this.now();
      const job = {
        schemaVersion: JOB_SCHEMA, jobId, type: input.type, handlerVersion: input.handlerVersion,
        idempotencyKey: input.idempotencyKey, inputHash: input.inputHash, payloadRef: input.payloadRef,
        status: "queued", revision: 0, attempt: 0, maxAttempts: input.maxAttempts ?? 3,
        runAfter: createdAt, runtimeGeneration: state.runtimeGeneration,
        networkRequired: input.networkRequired ?? false, dependencyJobIds: [], resultRefs: [], createdAt, updatedAt: createdAt,
      };
      const errors = validateRuntimeBackgroundJob(job, { expectedRuntimeGeneration: state.runtimeGeneration });
      if (errors.length) throw new Error(`invalid durable job input: ${errors.join("; ")}`);
      await atomicWriteJson(this.jobFile(activeRoot, jobId), envelope("background-job", job));
      const index = {
        schemaVersion: "job-idempotency-v1", idempotencyKeyHash: keyHash, jobId, type: job.type,
        handlerVersion: job.handlerVersion, inputHash: job.inputHash, payloadRef: job.payloadRef, createdAt,
      };
      await atomicWriteJson(indexFile, envelope("job-idempotency", index));
      return { job: clone(job), created: true };
    })).result;
  }

  async get(jobId) {
    return (await this.coordinator.withConsistentSnapshot(({ state, activeRoot }) => this.readAt(activeRoot, jobId, state.runtimeGeneration))).result;
  }

  async list(type) {
    return (await this.coordinator.withConsistentSnapshot(async ({ state, activeRoot }) => {
      const records = this.roots(activeRoot).records;
      const entries = await readdir(records, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
      const jobs = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error("durable job repository contains a symlink");
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const job = await this.readAt(activeRoot, entry.name.slice(0, -5), state.runtimeGeneration);
        if (job && (!type || job.type === type)) jobs.push(job);
      }
      return jobs;
    })).result;
  }

  assertFence(job, lease, state, at) {
    if (job.status !== "running" || job.revision !== lease.expectedRevision || job.leaseToken !== lease.leaseToken
      || job.runtimeGeneration !== lease.runtimeGeneration || job.runtimeGeneration !== state.runtimeGeneration
      || Date.parse(job.leaseExpiresAt ?? "") <= Date.parse(at)) throw new Error("durable job commit fenced");
  }

  async claim(jobId, workerId) {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const job = await this.readAt(activeRoot, jobId, state.runtimeGeneration);
      if (!job || job.status !== "queued" || job.runtimeGeneration !== state.runtimeGeneration || Date.parse(job.runAfter) > Date.parse(now)) return null;
      const next = {
        ...job, status: "running", revision: job.revision + 1, attempt: job.attempt + 1,
        leaseOwner: workerId, leaseToken: this.leaseToken(),
        leaseExpiresAt: new Date(Date.parse(now) + this.leaseDurationMs).toISOString(), updatedAt: now,
      };
      await this.writeTransition(activeRoot, job, next);
      return { job: clone(next), lease: { expectedRevision: next.revision, leaseToken: next.leaseToken, runtimeGeneration: next.runtimeGeneration } };
    })).result;
  }

  async checkpoint(jobId, lease, checkpointRef) {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const job = await this.readAt(activeRoot, jobId, state.runtimeGeneration);
      if (!job) throw new Error("durable job is missing");
      this.assertFence(job, lease, state, now);
      const next = { ...job, revision: job.revision + 1, checkpointRef, updatedAt: now };
      await this.writeTransition(activeRoot, job, next);
      return { job: clone(next), lease: { expectedRevision: next.revision, leaseToken: next.leaseToken, runtimeGeneration: next.runtimeGeneration } };
    })).result;
  }

  async heartbeat(jobId, lease) {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const job = await this.readAt(activeRoot, jobId, state.runtimeGeneration);
      if (!job) throw new Error("durable job is missing");
      this.assertFence(job, lease, state, now);
      const next = { ...job, revision: job.revision + 1,
        leaseExpiresAt: new Date(Date.parse(now) + this.leaseDurationMs).toISOString(), updatedAt: now };
      await this.writeTransition(activeRoot, job, next);
      return { job: clone(next), lease: { expectedRevision: next.revision, leaseToken: next.leaseToken, runtimeGeneration: next.runtimeGeneration } };
    })).result;
  }

  async succeed(jobId, lease, resultRefs, resultCommitHash) {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const job = await this.readAt(activeRoot, jobId, state.runtimeGeneration);
      if (!job) throw new Error("durable job is missing");
      this.assertFence(job, lease, state, now);
      const next = { ...withoutLease(job), status: "succeeded", revision: job.revision + 1, resultRefs, resultCommitHash, updatedAt: now };
      await this.writeTransition(activeRoot, job, next);
      return clone(next);
    })).result;
  }

  async fail(jobId, lease, code, message, retryable = true) {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const job = await this.readAt(activeRoot, jobId, state.runtimeGeneration);
      if (!job) throw new Error("durable job is missing");
      this.assertFence(job, lease, state, now);
      const status = retryable && job.attempt < job.maxAttempts ? "waiting_retry" : retryable ? "dead_letter" : "failed";
      const next = { ...withoutLease(job), status, revision: job.revision + 1, runAfter: now,
        lastError: { code, message: String(message).slice(0, 512), redacted: true }, updatedAt: now };
      await this.writeTransition(activeRoot, job, next);
      return clone(next);
    })).result;
  }

  async recover(type) {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const entries = await readdir(this.roots(activeRoot).records, { withFileTypes: true });
      let changed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const job = await this.readAt(activeRoot, entry.name.slice(0, -5), state.runtimeGeneration);
        if (!job || job.type !== type || job.runtimeGeneration !== state.runtimeGeneration) continue;
        if (job.status === "running" && Date.parse(job.leaseExpiresAt ?? "") <= Date.parse(now)) {
          const status = job.attempt >= job.maxAttempts ? "dead_letter" : "waiting_retry";
          const next = { ...withoutLease(job), status, revision: job.revision + 1, runAfter: now,
            lastError: { code: "lease_expired", message: "Worker lease expired before completion", redacted: true }, updatedAt: now };
          await this.writeTransition(activeRoot, job, next); changed += 1;
        }
      }
      return changed;
    })).result;
  }

  async promote(type) {
    const now = this.now();
    return (await this.coordinator.withWrite(async ({ state, activeRoot }) => {
      const entries = await readdir(this.roots(activeRoot).records, { withFileTypes: true });
      let changed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const job = await this.readAt(activeRoot, entry.name.slice(0, -5), state.runtimeGeneration);
        if (!job || job.type !== type || job.runtimeGeneration !== state.runtimeGeneration || job.status !== "waiting_retry" || Date.parse(job.runAfter) > Date.parse(now)) continue;
        const next = { ...job, status: "queued", revision: job.revision + 1, updatedAt: now };
        await this.writeTransition(activeRoot, job, next); changed += 1;
      }
      return changed;
    })).result;
  }
}

export const durableJobId = jobIdFor;
