import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  confined,
  ensurePrivateDirectory,
  pathExists,
  readJson,
  withDirectoryLock,
} from "./fs.mjs";

export const RUNTIME_STATE_SCHEMA_VERSION = "runtime-state-v1";
/** Frozen U1 active-generation layout. Repositories may add nested directories. */
export const RUNTIME_ROOT_REGISTRY = Object.freeze([
  "plans", "transactions", "catalog-overlays", "domain-overlays", "facts", "prices", "snapshots",
  "evidence", "attachments", "observations", "jobs", "artifacts", "config", "audit", "agent",
  "execution-sessions", "exports", "backups", "diagnostics", "migrations",
]);

export const RUNTIME_REQUIRED_ROOTS = RUNTIME_ROOT_REGISTRY;

function validState(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === RUNTIME_STATE_SCHEMA_VERSION
    && Number.isInteger(value.runtimeGeneration) && value.runtimeGeneration > 0
    && Number.isInteger(value.revision) && value.revision >= 0
    && typeof value.activeRoot === "string" && /^generations\/[1-9]\d*$/.test(value.activeRoot)
    && typeof value.appVersion === "string" && value.appVersion.length > 0;
}

export class RuntimeCoordinator {
  constructor(options = {}) {
    this.root = path.resolve(options.root ?? path.join(process.cwd(), "runtime"));
    this.now = options.now ?? (() => new Date().toISOString());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.controlRoot = confined(this.root, "control");
    this.stateFile = confined(this.controlRoot, "active-pointer.json");
    this.leaseFile = confined(this.controlRoot, "maintenance-lease.json");
    this.lockDirectory = confined(this.controlRoot, ".runtime-lock");
    this.stagingRoot = confined(this.root, "staging");
  }

  async initialize(appVersion = "0.2.0-alpha") {
    if (await pathExists(this.stateFile)) return this.readState();
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(this.controlRoot);
    await ensurePrivateDirectory(confined(this.root, "generations"));
    await ensurePrivateDirectory(this.stagingRoot);
    return this.exclusive(async () => {
      if (!await pathExists(this.stateFile)) {
        const activeRoot = "generations/1";
        const absolute = confined(this.root, activeRoot);
        await ensurePrivateDirectory(absolute);
        for (const name of RUNTIME_REQUIRED_ROOTS) await ensurePrivateDirectory(confined(absolute, name));
        for (const name of ["records", "idempotency", "rollback"]) await ensurePrivateDirectory(confined(absolute, "jobs", name));
        await atomicWriteJson(this.stateFile, {
          schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
          runtimeGeneration: 1,
          revision: 0,
          activeRoot,
          appVersion,
          updatedAt: this.now(),
        });
      }
      return this.readState();
    });
  }

  async readState() {
    const state = await readJson(this.stateFile);
    if (!validState(state)) throw new Error("runtime active pointer is corrupt");
    const activeRoot = confined(this.root, state.activeRoot);
    if (!await pathExists(activeRoot)) throw new Error("runtime active pointer references a missing generation");
    return structuredClone(state);
  }

  async readStateObservation() {
    const bytes = await readFile(this.stateFile);
    const state = JSON.parse(bytes.toString("utf8"));
    if (!validState(state)) throw new Error("runtime active pointer is corrupt");
    const activeRoot = confined(this.root, state.activeRoot);
    if (!await pathExists(activeRoot)) throw new Error("runtime active pointer references a missing generation");
    return { bytes, state: structuredClone(state), activeRoot };
  }

  async coordinationLockExists() {
    try {
      await lstat(this.lockDirectory);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  activeRoot(state) {
    if (!validState(state)) throw new Error("runtime state is invalid");
    return confined(this.root, state.activeRoot);
  }

  async exclusive(operation) {
    return withDirectoryLock(this.lockDirectory, operation, { timeoutMs: this.lockTimeoutMs });
  }

  async currentLease() {
    if (!await pathExists(this.leaseFile)) return null;
    const lease = await readJson(this.leaseFile);
    if (!lease || lease.schemaVersion !== "maintenance-lease-v1" || typeof lease.token !== "string"
      || typeof lease.owner !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))) throw new Error("maintenance lease is corrupt");
    return lease;
  }

  async acquireMaintenanceLease(owner, options = {}) {
    if (typeof owner !== "string" || !owner) throw new TypeError("maintenance lease owner is required");
    const ttlMs = options.ttlMs ?? 60_000;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3_600_000) throw new TypeError("maintenance lease ttl is invalid");
    return this.exclusive(async () => {
      const existing = await this.currentLease();
      const nowMs = Date.parse(this.now());
      if (existing && Date.parse(existing.expiresAt) > nowMs) throw new Error("maintenance lease is already held");
      const lease = {
        schemaVersion: "maintenance-lease-v1",
        token: randomUUID(), owner,
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      };
      await atomicWriteJson(this.leaseFile, lease);
      return Object.freeze(structuredClone(lease));
    });
  }

  async assertMaintenanceLease(token) {
    const lease = await this.currentLease();
    if (!lease || lease.token !== token || Date.parse(lease.expiresAt) <= Date.parse(this.now())) throw new Error("maintenance lease is missing, stale, or mismatched");
    return lease;
  }

  async releaseMaintenanceLease(token) {
    return this.exclusive(async () => {
      const lease = await this.currentLease();
      if (!lease) return false;
      if (lease.token !== token) throw new Error("maintenance lease token mismatch");
      await rm(this.leaseFile, { force: true });
      return true;
    });
  }

  async withConsistentSnapshot(operation) {
    return this.exclusive(async () => {
      const before = await this.readState();
      const result = await operation({ state: structuredClone(before), activeRoot: this.activeRoot(before) });
      const after = await this.readState();
      if (before.runtimeGeneration !== after.runtimeGeneration || before.revision !== after.revision || before.activeRoot !== after.activeRoot) {
        throw new Error("runtime changed during consistent snapshot");
      }
      return { state: before, result };
    });
  }

  /**
   * Optimistic, strictly read-only snapshot for diagnostics. Pointer/lock/
   * pointer samples on both sides close races with the directory-based writer
   * barrier without creating that directory. Backups continue to use the
   * exclusive withConsistentSnapshot barrier above.
   */
  async withReadOnlySnapshot(operation) {
    const before = await this.readStateObservation();
    const lockedBefore = await this.coordinationLockExists();
    const confirmedBefore = await this.readStateObservation();
    if (lockedBefore || !before.bytes.equals(confirmedBefore.bytes)) {
      throw new Error("runtime changed during read-only snapshot");
    }

    const result = await operation({ state: structuredClone(before.state), activeRoot: before.activeRoot });

    const after = await this.readStateObservation();
    const lockedAfter = await this.coordinationLockExists();
    const confirmedAfter = await this.readStateObservation();
    if (lockedAfter || !before.bytes.equals(after.bytes) || !before.bytes.equals(confirmedAfter.bytes)) {
      throw new Error("runtime changed during read-only snapshot");
    }
    return { state: before.state, result };
  }

  async withWrite(operation, options = {}) {
    return this.exclusive(async () => {
      const state = await this.readState();
      const lease = await this.currentLease();
      if (lease && Date.parse(lease.expiresAt) > Date.parse(this.now()) && lease.token !== options.maintenanceLeaseToken) {
        throw new Error("runtime writes are fenced by maintenance lease");
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== state.revision) throw new Error("runtime expected revision conflict");
      const result = await operation({ state: structuredClone(state), activeRoot: this.activeRoot(state) });
      const next = { ...state, revision: state.revision + 1, updatedAt: this.now() };
      await atomicWriteJson(this.stateFile, next);
      return { state: next, result };
    });
  }

  async createStagingGeneration(maintenanceLeaseToken) {
    await this.assertMaintenanceLease(maintenanceLeaseToken);
    const directory = confined(this.stagingRoot, `restore-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    for (const name of RUNTIME_REQUIRED_ROOTS) await ensurePrivateDirectory(confined(directory, name));
    return directory;
  }

  async activateStagingGeneration(stagingDirectory, expectedGeneration, maintenanceLeaseToken, options = {}) {
    const resolvedStaging = path.resolve(stagingDirectory);
    if (path.dirname(resolvedStaging) !== this.stagingRoot
      || resolvedStaging !== confined(this.stagingRoot, path.basename(resolvedStaging))) {
      throw new Error("staging generation is outside runtime staging");
    }
    return this.exclusive(async () => {
      await this.assertMaintenanceLease(maintenanceLeaseToken);
      const state = await this.readState();
      if (state.runtimeGeneration !== expectedGeneration) throw new Error("runtime generation changed before pointer switch");
      const minimumGeneration = options.minimumGeneration ?? state.runtimeGeneration + 1;
      if (!Number.isInteger(minimumGeneration) || minimumGeneration <= state.runtimeGeneration) throw new Error("next runtime generation must advance");
      const nextGeneration = Math.max(state.runtimeGeneration + 1, minimumGeneration);
      const relativeRoot = `generations/${nextGeneration}`;
      const target = confined(this.root, relativeRoot);
      if (await pathExists(target)) throw new Error("next runtime generation already exists");
      await rename(stagingDirectory, target);
      const next = {
        ...state,
        runtimeGeneration: nextGeneration,
        revision: state.revision + 1,
        activeRoot: relativeRoot,
        updatedAt: this.now(),
      };
      // Pointer write is the commit point. If anything before this throws, the
      // previous active root remains selected.
      await atomicWriteJson(this.stateFile, next);
      return structuredClone(next);
    });
  }

  async discardStagingGeneration(stagingDirectory) {
    const resolved = path.resolve(stagingDirectory);
    if (path.dirname(resolved) !== this.stagingRoot) throw new Error("refusing to discard staging outside runtime staging");
    await rm(resolved, { recursive: true, force: true });
  }
}
