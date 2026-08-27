import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../plans/canonical";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json, withDirectoryLock } from "../runtime/fs.mjs";
import {
  validateExecutionSession,
  type BuildProcedure,
  type ExecutionSession,
  type ProcedureDependencyContext,
} from "./contracts";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export class ExecutionRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input" | "fenced", message: string) { super(message); this.name = "ExecutionRepositoryError"; }
}

export interface StoredExecutionSession {
  schemaVersion: "execution-repository-v1";
  revision: number;
  runtimeGeneration: number;
  leaseToken: string;
  leaseExpiresAt: string;
  recordHash: string;
  session: ExecutionSession;
  replayContext: ExecutionReplayContext;
}
export interface ExecutionReplayContext {
  procedure: BuildProcedure;
  dependencyContext: ProcedureDependencyContext;
  references: {
    planVersionRef: string;
    evaluationRef: string;
    procedureRef: string;
    procedureSafetyRef: string;
    evaluatorArtifactRef: string;
  };
}
interface Envelope<T> { schemaVersion: "execution-repository-v1"; kind: "execution-session"; checksum: string; payload: T; }
interface RollbackRecord { schemaVersion: "execution-rollback-v1"; kind: "execution-rollback"; checksum: string; payload: { executionSessionId: string; fromRevision: number; toRevision: number; previousHash: string; previous: StoredExecutionSession; createdAt: string; }; }
export interface ExecutionRepositoryOptions { root?: string; runtimeRoot?: string; coordinator?: RuntimeCoordinator; now?: () => string; runtimeGeneration?: () => number; }
export interface CreateExecutionSessionInput { session: ExecutionSession; procedure: BuildProcedure; dependencyContext: ProcedureDependencyContext; leaseToken: string; leaseExpiresAt: string; runtimeGeneration?: number; expectedHash?: string; maintenanceLeaseToken?: string; }
export interface CommitExecutionSessionInput { session: ExecutionSession; procedure: BuildProcedure; dependencyContext: ProcedureDependencyContext; expectedRevision: number; expectedHash: string; leaseToken: string; runtimeGeneration: number; leaseExpiresAt?: string; maintenanceLeaseToken?: string; }
export interface RollbackExecutionSessionInput { expectedRevision: number; expectedHash: string; leaseToken: string; runtimeGeneration: number; leaseExpiresAt?: string; maintenanceLeaseToken?: string; }

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function clone<T>(value: T): T { return structuredClone(value); }
function iso(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function replayContext(session: ExecutionSession, procedure: BuildProcedure, dependencyContext: ProcedureDependencyContext): ExecutionReplayContext {
  if (dependencyContext.evaluatorArtifactRef !== `sha256:${dependencyContext.evaluatorArtifactHash}`) {
    throw new ExecutionRepositoryError("invalid_input", "execution evaluator artifact must be a content-addressed sha256 ref");
  }
  return {
    procedure: clone(procedure),
    dependencyContext: clone(dependencyContext),
    references: {
      planVersionRef: `plan-version:${session.planVersionId}`,
      evaluationRef: `evaluation:${session.evaluationHash}`,
      procedureRef: `execution-procedure:sha256:${digest(procedure)}`,
      procedureSafetyRef: `procedure-safety:${session.procedureSafetyHash}`,
      evaluatorArtifactRef: dependencyContext.evaluatorArtifactRef,
    },
  };
}

/** Durable execution state. The persisted runtime generation and lease form a fencing boundary, not client hints. */
export class ExecutionRepository {
  private root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly now: () => string;
  private readonly generation: () => number;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(options: ExecutionRepositoryOptions = {}) { this.root = path.resolve(options.root ?? "runtime/execution-sessions"); this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: options.runtimeRoot, now: options.now }); this.now = options.now ?? (() => new Date().toISOString()); this.generation = options.runtimeGeneration ?? (() => 0); }
  private assertId(value: string): void { if (!SAFE_ID.test(value)) throw new ExecutionRepositoryError("invalid_input", "execution session id invalid"); }
  private fileAt(repositoryRoot: string, id: string): string { this.assertId(id); return confined(repositoryRoot, "sessions", `${id}.json`); }
  private file(id: string): string { return this.fileAt(this.root, id); }
  private rollbackFileAt(repositoryRoot: string, id: string, revision: number): string { this.assertId(id); if (!Number.isInteger(revision) || revision < 0) throw new ExecutionRepositoryError("invalid_input", "execution rollback revision invalid"); return confined(repositoryRoot, "rollback", id, `${String(revision).padStart(12, "0")}.json`); }
  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> { const previous = this.queues.get(key) ?? Promise.resolve(); const current = previous.catch(() => undefined).then(fn); this.queues.set(key, current); try { return await current; } finally { if (this.queues.get(key) === current) this.queues.delete(key); } }
  private async withRoot<T>(key: string, write: boolean, operation: (runtimeGeneration?: number) => Promise<T>, maintenanceLeaseToken?: string): Promise<T> {
    const invoke = async (root: string, runtimeGeneration?: number) => { const previous = this.root; this.root = root; try { return await operation(runtimeGeneration); } finally { this.root = previous; } };
    if (this.coordinator) { await this.coordinator.initialize(); if (write) return (await this.coordinator.withWrite(({ activeRoot, state }: { activeRoot: string; state: { runtimeGeneration: number } }) => invoke(confined(activeRoot, "execution-sessions"), state.runtimeGeneration), { maintenanceLeaseToken })).result as T; return (await this.coordinator.withConsistentSnapshot(({ activeRoot, state }: { activeRoot: string; state: { runtimeGeneration: number } }) => invoke(confined(activeRoot, "execution-sessions"), state.runtimeGeneration))).result as T; }
    return withDirectoryLock(confined(this.root, ".locks", digest(key)), () => operation(undefined));
  }
  private async write(id: string, stored: StoredExecutionSession): Promise<void> { const file = this.file(id); const envelope: Envelope<StoredExecutionSession> = { schemaVersion: "execution-repository-v1", kind: "execution-session", checksum: digest(stored), payload: stored }; await atomicWriteJson(file, envelope); }
  private async writeRollback(previous: StoredExecutionSession, nextRevision: number): Promise<void> {
    const payload = { executionSessionId: previous.session.executionSessionId, fromRevision: previous.revision, toRevision: nextRevision, previousHash: previous.recordHash, previous: clone(previous), createdAt: this.now() };
    const envelope: RollbackRecord = { schemaVersion: "execution-rollback-v1", kind: "execution-rollback", checksum: digest(payload), payload };
    await atomicWriteJson(this.rollbackFileAt(this.root, previous.session.executionSessionId, previous.revision), envelope);
    const manifestFile = confined(this.root, "rollback", "manifest.json");
    let manifest: { schemaVersion: "execution-rollback-manifest-v1"; entries: unknown[]; checksum?: string } = { schemaVersion: "execution-rollback-manifest-v1", entries: [] };
    try {
      manifest = JSON.parse(await readFile(manifestFile, "utf8")) as typeof manifest;
      const { checksum: _checksum, ...body } = manifest;
      if (manifest.schemaVersion !== "execution-rollback-manifest-v1" || !Array.isArray(manifest.entries) || manifest.checksum !== digest(body)) throw new Error("invalid manifest");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ExecutionRepositoryError("corrupt_data", "execution rollback manifest cannot be read"); }
    const body = { schemaVersion: "execution-rollback-manifest-v1" as const, entries: [...manifest.entries, { executionSessionId: previous.session.executionSessionId, fromRevision: previous.revision, toRevision: nextRevision, previousHash: previous.recordHash, createdAt: payload.createdAt }] };
    await atomicWriteJson(manifestFile, { ...body, checksum: digest(body) });
  }
  private async readAt(repositoryRoot: string, id: string): Promise<StoredExecutionSession> {
    let parsed: unknown; try { parsed = JSON.parse(await readFile(this.fileAt(repositoryRoot, id), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutionRepositoryError("not_found", "execution session was not found"); throw new ExecutionRepositoryError("corrupt_data", "execution session cannot be read"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ExecutionRepositoryError("corrupt_data", "execution session envelope invalid");
    const envelope = parsed as Partial<Envelope<StoredExecutionSession>>;
    if (envelope.schemaVersion !== "execution-repository-v1" || envelope.kind !== "execution-session" || !envelope.payload || envelope.checksum !== digest(envelope.payload)) throw new ExecutionRepositoryError("corrupt_data", "execution session envelope checksum invalid");
    const value = envelope.payload;
    const { recordHash: _recordHash, ...base } = value;
    if (value.schemaVersion !== "execution-repository-v1" || !Number.isInteger(value.revision) || value.revision < 0 || !Number.isInteger(value.runtimeGeneration) || value.runtimeGeneration < 0 || !value.leaseToken || !iso(value.leaseExpiresAt) || !SHA256.test(value.recordHash) || value.recordHash !== digest(base)) throw new ExecutionRepositoryError("corrupt_data", "execution session integrity invalid");
    try {
      if (!value.replayContext || typeof value.replayContext !== "object") throw new Error("execution replay context missing");
      this.assertSession(value.session, value.replayContext.procedure, value.replayContext.dependencyContext);
      if (canonicalJson(value.replayContext) !== canonicalJson(replayContext(value.session, value.replayContext.procedure, value.replayContext.dependencyContext))) {
        throw new Error("execution replay context mismatch");
      }
    } catch { throw new ExecutionRepositoryError("corrupt_data", "execution replay context is invalid"); }
    return clone(value);
  }
  private async read(id: string): Promise<StoredExecutionSession> { return this.readAt(this.root, id); }
  private assertSession(session: ExecutionSession, procedure: BuildProcedure, context: ProcedureDependencyContext): void { const errors = validateExecutionSession(session, procedure, context); if (errors.length) throw new ExecutionRepositoryError("invalid_input", errors.join("; ")); }
  private public(value: StoredExecutionSession): StoredExecutionSession { return clone(value); }
  private sameImmutableIdentity(left: ExecutionSession, right: ExecutionSession): boolean {
    return left.executionSessionId === right.executionSessionId
      && left.planVersionId === right.planVersionId
      && left.procedureId === right.procedureId
      && left.evaluationHash === right.evaluationHash
      && left.procedureSafetyHash === right.procedureSafetyHash;
  }
  private assertSameReplayContext(existing: StoredExecutionSession, session: ExecutionSession, procedure: BuildProcedure, dependencyContext: ProcedureDependencyContext): void {
    if (canonicalJson(existing.replayContext) !== canonicalJson(replayContext(session, procedure, dependencyContext))) {
      throw new ExecutionRepositoryError("conflict", "execution replay context cannot change");
    }
  }

  async create(input: CreateExecutionSessionInput): Promise<StoredExecutionSession> {
    this.assertId(input.session.executionSessionId); this.assertSession(input.session, input.procedure, input.dependencyContext);
    if (!input.leaseToken || !iso(input.leaseExpiresAt)) throw new ExecutionRepositoryError("invalid_input", "execution lease invalid");
    if (Date.parse(input.leaseExpiresAt) <= Date.parse(this.now())) throw new ExecutionRepositoryError("invalid_input", "execution lease expiry must be in the future");
    return this.withRoot(input.session.executionSessionId, true, (coordinatorGeneration) => this.serial(input.session.executionSessionId, async () => {
      try {
        const existing = await this.read(input.session.executionSessionId);
        if (input.expectedHash !== undefined && input.expectedHash !== existing.recordHash) throw new ExecutionRepositoryError("conflict", "execution expected hash mismatch");
        const { recordHash: _recordHash, ...base } = existing;
        if (existing.recordHash !== digest(base)) throw new ExecutionRepositoryError("corrupt_data", "execution record hash invalid");
        if (!this.sameImmutableIdentity(existing.session, input.session)) throw new ExecutionRepositoryError("conflict", "execution session id is already bound to a different immutable identity");
        this.assertSameReplayContext(existing, input.session, input.procedure, input.dependencyContext);
        return this.public(existing);
      } catch (error) { if (!(error instanceof ExecutionRepositoryError) || error.code !== "not_found") throw error; }
      const runtimeGeneration = input.runtimeGeneration ?? coordinatorGeneration ?? this.generation();
      if (!Number.isInteger(runtimeGeneration) || runtimeGeneration < 0) throw new ExecutionRepositoryError("invalid_input", "runtime generation invalid");
      if (coordinatorGeneration !== undefined && runtimeGeneration !== coordinatorGeneration) throw new ExecutionRepositoryError("fenced", "execution creation uses a stale runtime generation");
      const base: Omit<StoredExecutionSession, "recordHash"> = { schemaVersion: "execution-repository-v1", revision: 0, runtimeGeneration, leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt, session: clone(input.session), replayContext: replayContext(input.session, input.procedure, input.dependencyContext) };
      const recordHash = digest(base); if (input.expectedHash !== undefined && input.expectedHash !== recordHash) throw new ExecutionRepositoryError("conflict", "execution expected hash mismatch");
      const stored: StoredExecutionSession = { ...base, recordHash }; await this.write(input.session.executionSessionId, stored); return this.public(stored);
    }), input.maintenanceLeaseToken);
  }
  async get(id: string): Promise<StoredExecutionSession> { return this.withRoot(id, false, async () => this.public(await this.read(id))); }
  async list(): Promise<StoredExecutionSession[]> { return this.withRoot("sessions", false, async () => { const directory = path.join(this.root, "sessions"); let entries: import("node:fs").Dirent[]; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } if (entries.some((entry) => entry.isSymbolicLink())) throw new ExecutionRepositoryError("corrupt_data", "execution session listing contains a symlink"); return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort().map((name) => this.read(name.slice(0, -5)))); }); }
  async commit(id: string, input: CommitExecutionSessionInput): Promise<StoredExecutionSession> {
    this.assertId(id); this.assertSession(input.session, input.procedure, input.dependencyContext);
    if (id !== input.session.executionSessionId) throw new ExecutionRepositoryError("conflict", "execution commit id does not match the session id");
    return this.withRoot(id, true, (coordinatorGeneration) => this.serial(id, async () => {
      const existing = await this.read(id);
      if (existing.revision !== input.expectedRevision || existing.recordHash !== input.expectedHash) throw new ExecutionRepositoryError("conflict", "execution revision/hash conflict");
      if (existing.leaseToken !== input.leaseToken || existing.runtimeGeneration !== input.runtimeGeneration || input.runtimeGeneration !== (coordinatorGeneration ?? this.generation())) throw new ExecutionRepositoryError("fenced", "stale execution lease or runtime generation cannot commit");
      if (Date.parse(existing.leaseExpiresAt) <= Date.parse(this.now())) throw new ExecutionRepositoryError("fenced", "expired execution lease cannot commit");
      if (!this.sameImmutableIdentity(existing.session, input.session)) throw new ExecutionRepositoryError("conflict", "execution immutable identity cannot change");
      this.assertSameReplayContext(existing, input.session, input.procedure, input.dependencyContext);
      if (existing.session.status !== "active" && input.session.status === "active") throw new ExecutionRepositoryError("conflict", "terminal execution session cannot return to active");
      const leaseExpiresAt = input.leaseExpiresAt ?? existing.leaseExpiresAt;
      if (!iso(leaseExpiresAt) || Date.parse(leaseExpiresAt) <= Date.parse(this.now())) throw new ExecutionRepositoryError("invalid_input", "execution lease expiry must be in the future");
      if (Date.parse(leaseExpiresAt) < Date.parse(existing.leaseExpiresAt)) throw new ExecutionRepositoryError("conflict", "execution lease expiry cannot move backwards");
      const { recordHash: _previousRecordHash, ...withoutRecordHash } = existing;
      const base: Omit<StoredExecutionSession, "recordHash"> = { ...withoutRecordHash, revision: existing.revision + 1, leaseExpiresAt, session: clone(input.session) };
      const stored: StoredExecutionSession = { ...base, recordHash: digest(base) }; await this.writeRollback(existing, stored.revision); await this.write(id, stored); return this.public(stored);
    }), input.maintenanceLeaseToken);
  }

  /** Revert one commit only with a current hash/revision and live lease. */
  async rollback(id: string, input: RollbackExecutionSessionInput, procedure?: BuildProcedure, dependencyContext?: ProcedureDependencyContext): Promise<StoredExecutionSession> {
    this.assertId(id);
    if (this.coordinator && !input.maintenanceLeaseToken) throw new ExecutionRepositoryError("invalid_input", "execution rollback requires a maintenance lease");
    return this.withRoot(id, true, (coordinatorGeneration) => this.serial(id, async () => {
      const current = await this.read(id);
      if (current.revision !== input.expectedRevision || current.recordHash !== input.expectedHash) throw new ExecutionRepositoryError("conflict", "execution rollback revision/hash conflict");
      if (current.runtimeGeneration !== input.runtimeGeneration || input.runtimeGeneration !== (coordinatorGeneration ?? this.generation()) || current.leaseToken !== input.leaseToken) throw new ExecutionRepositoryError("fenced", "stale execution rollback lease or runtime generation");
      const expiry = input.leaseExpiresAt ?? current.leaseExpiresAt;
      if (!iso(expiry) || Date.parse(expiry) <= Date.parse(this.now()) || Date.parse(current.leaseExpiresAt) <= Date.parse(this.now())) throw new ExecutionRepositoryError("fenced", "expired execution rollback lease");
      const previousPath = this.rollbackFileAt(this.root, id, Math.max(0, current.revision - 1));
      let parsed: RollbackRecord;
      try { parsed = JSON.parse(await readFile(previousPath, "utf8")) as RollbackRecord; } catch { throw new ExecutionRepositoryError("not_found", "execution rollback history was not found"); }
      if (parsed.schemaVersion !== "execution-rollback-v1" || parsed.kind !== "execution-rollback" || parsed.checksum !== digest(parsed.payload) || parsed.payload.executionSessionId !== id || parsed.payload.toRevision !== current.revision || parsed.payload.previousHash !== parsed.payload.previous.recordHash) throw new ExecutionRepositoryError("corrupt_data", "execution rollback history is invalid");
      const { recordHash: _previousRecordHash, ...previousBase } = parsed.payload.previous;
      const base: Omit<StoredExecutionSession, "recordHash"> = { ...previousBase, revision: current.revision + 1, runtimeGeneration: current.runtimeGeneration, leaseToken: input.leaseToken, leaseExpiresAt: expiry };
      if (procedure && dependencyContext) this.assertSession(base.session, procedure, dependencyContext);
      const restored: StoredExecutionSession = { ...base, recordHash: digest(base) };
      await this.writeRollback(current, restored.revision); await this.write(id, restored); return this.public(restored);
    }), input.maintenanceLeaseToken);
  }

  /** Called inside RuntimeCoordinator.withConsistentSnapshot; never reacquires it or writes. */
  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "execution-sessions";
    revision: number;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const repositoryRoot = confined(activeRoot, "execution-sessions");
    const sessionsRoot = confined(repositoryRoot, "sessions");
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(sessionsRoot, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = []; else throw error; }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new ExecutionRepositoryError("corrupt_data", "execution session listing contains a symlink");
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => this.readAt(repositoryRoot, entry.name.slice(0, -5))));
    const nodes = sessions.flatMap((stored) => [
      `execution-session:${stored.session.executionSessionId}`,
      stored.replayContext.references.procedureRef,
      stored.replayContext.references.procedureSafetyRef,
    ]).sort();
    const edgeByKey = new Map<string, { fromRef: string; toRef: string; necessity: "required_for_replay" }>();
    for (const stored of sessions) {
      const fromRef = `execution-session:${stored.session.executionSessionId}`;
      for (const toRef of Object.values(stored.replayContext.references)) {
        const edge = { fromRef, toRef, necessity: "required_for_replay" as const };
        edgeByKey.set(canonicalJson(edge), edge);
      }
      for (const observationId of stored.session.results.flatMap((result) => result.observationIds ?? [])) {
        const edge = { fromRef, toRef: `observation:${observationId}`, necessity: "required_for_replay" as const };
        edgeByKey.set(canonicalJson(edge), edge);
      }
    }
    return {
      providerId: "execution-sessions",
      revision: sessions.reduce((total, stored) => total + stored.revision + 1, 0),
      manifestHash: sha256Json(sessions.map((stored) => ({ id: stored.session.executionSessionId, recordHash: stored.recordHash }))),
      snapshotPointers: nodes,
      nodes,
      edges: [...edgeByKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, edge]) => edge),
    };
  }
}
