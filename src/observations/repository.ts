import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../plans/canonical";
import { hashContent } from "../hash";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json, withDirectoryLock } from "../runtime/fs.mjs";
import {
  validateUserObservation,
  validateUserObservationSnapshot,
  type UserObservation,
  type UserObservationSnapshot,
} from "./contracts";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class ObservationRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input", message: string) { super(message); this.name = "ObservationRepositoryError"; }
}

export interface AttachmentClosureLookup {
  hasAvailable(attachmentId: string, planId: string): Promise<boolean>;
  /** Required when observations and attachments share a RuntimeCoordinator. */
  hasAvailableAtRoot?(activeRoot: string, attachmentId: string, planId: string): Promise<boolean>;
}
interface StoredObservation { schemaVersion: "observation-repository-v1"; revision: number; recordHash: string; observation: UserObservation; }
interface Supersession { schemaVersion: "observation-supersession-v1"; planId: string; supersededObservationId: string; replacementObservationId: string; createdAt: string; contentHash: string; }
interface Envelope<T> { schemaVersion: "observation-repository-v1"; kind: "observation" | "supersession" | "snapshot"; checksum: string; payload: T; }
interface Journal<T = unknown> { schemaVersion: "observation-journal-v1"; kind: "transaction"; checksum: string; payload: { transactionId: string; operation: "observation-create" | "snapshot-create"; planId: string; authorityId: string; authority: T; supersession?: Supersession; state: "prepared" | "committed"; createdAt: string; }; }
export interface ObservationRepositoryOptions { root?: string; runtimeRoot?: string; coordinator?: RuntimeCoordinator; now?: () => string; id?: (prefix: "observation" | "snapshot") => string; attachments: AttachmentClosureLookup; }
export interface PutObservationInput { observation: UserObservation; expectedRevision?: number; expectedHash?: string; maintenanceLeaseToken?: string; }

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function clone<T>(value: T): T { return structuredClone(value); }
function observationHash(observation: UserObservation): string { const { contentHash: _ignored, ...rest } = observation; return digest(canonicalJson(rest)); }

/** Plan-scoped immutable observation log. A supersession is a separate append-only event. */
export class ObservationRepository {
  private root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly now: () => string;
  private readonly id: (prefix: "observation" | "snapshot") => string;
  private readonly attachments: AttachmentClosureLookup;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: ObservationRepositoryOptions) {
    this.root = path.resolve(options.root ?? "runtime/observations"); this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: options.runtimeRoot, now: options.now }); this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`); this.attachments = options.attachments;
  }
  private assert(value: string, label: string): void { if (!SAFE_ID.test(value)) throw new ObservationRepositoryError("invalid_input", `${label} invalid`); }
  private planRootAt(repositoryRoot: string, planId: string): string { this.assert(planId, "plan id"); return confined(repositoryRoot, "plans", planId); }
  private planRoot(planId: string): string { return this.planRootAt(this.root, planId); }
  private observationFileAt(repositoryRoot: string, planId: string, id: string): string { this.assert(id, "observation id"); return confined(this.planRootAt(repositoryRoot, planId), "records", `${id}.json`); }
  private observationFile(planId: string, id: string): string { return this.observationFileAt(this.root, planId, id); }
  private supersessionFile(planId: string, replacementId: string): string { this.assert(replacementId, "observation id"); return path.join(this.planRoot(planId), "supersessions", `${replacementId}.json`); }
  private snapshotFile(planId: string, id: string): string { this.assert(id, "snapshot id"); return path.join(this.planRoot(planId), "snapshots", `${id}.json`); }
  private journalFile(planId: string, transactionId: string): string { this.assert(planId, "plan id"); this.assert(transactionId, "transaction id"); return confined(this.root, "journal", planId, `${transactionId}.json`); }
  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> { const previous = this.queues.get(key) ?? Promise.resolve(); const current = previous.catch(() => undefined).then(fn); this.queues.set(key, current); try { return await current; } finally { if (this.queues.get(key) === current) this.queues.delete(key); } }
  private async withRoot<T>(key: string, write: boolean, operation: (activeRoot?: string) => Promise<T>, maintenanceLeaseToken?: string): Promise<T> {
    const invoke = async (root: string, activeRoot?: string) => { const previous = this.root; this.root = root; try { return await operation(activeRoot); } finally { this.root = previous; } };
    if (this.coordinator) { await this.coordinator.initialize(); if (write) return (await this.coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => invoke(confined(activeRoot, "observations"), activeRoot), { maintenanceLeaseToken })).result as T; return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => invoke(confined(activeRoot, "observations"), activeRoot))).result as T; }
    return withDirectoryLock(confined(this.root, ".locks", digest(key)), () => operation(undefined));
  }
  private async write(file: string, envelope: Envelope<unknown>): Promise<void> { await atomicWriteJson(file, envelope); }
  private async writeJournal<T>(journal: Journal<T>): Promise<void> { await atomicWriteJson(this.journalFile(journal.payload.planId, journal.payload.transactionId), journal); }
  private async recoverJournals(planId: string): Promise<void> {
    const directory = confined(this.root, "journal", planId);
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new ObservationRepositoryError("corrupt_data", "observation transaction journal contains a symlink");
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      let parsed: Journal;
      try { parsed = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as Journal; }
      catch { throw new ObservationRepositoryError("corrupt_data", "observation transaction journal cannot be read"); }
      if (!parsed || parsed.schemaVersion !== "observation-journal-v1" || parsed.kind !== "transaction" || parsed.checksum !== digest(canonicalJson(parsed.payload))) throw new ObservationRepositoryError("corrupt_data", "observation transaction journal checksum invalid");
      if (parsed.payload.planId !== planId || parsed.payload.state !== "prepared") continue;
      const authorityFile = parsed.payload.operation === "snapshot-create" ? this.snapshotFile(planId, parsed.payload.authorityId) : this.observationFile(planId, parsed.payload.authorityId);
      if (!await this.exists(authorityFile)) continue;
      if (parsed.payload.supersession) {
        const supersession = parsed.payload.supersession;
        const target = this.supersessionFile(planId, supersession.replacementObservationId);
        if (!await this.exists(target)) await this.write(target, { schemaVersion: "observation-repository-v1", kind: "supersession", checksum: digest(canonicalJson(supersession)), payload: supersession });
      }
      const committed = { ...parsed, payload: { ...parsed.payload, state: "committed" as const } };
      committed.checksum = digest(canonicalJson(committed.payload));
      await this.writeJournal(committed);
    }
  }
  private async exists(file: string): Promise<boolean> { try { await readFile(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
  private async read<T>(file: string, kind: Envelope<T>["kind"]): Promise<T> {
    let parsed: unknown; try { parsed = JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ObservationRepositoryError("not_found", "observation record was not found"); throw new ObservationRepositoryError("corrupt_data", "observation record cannot be read"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ObservationRepositoryError("corrupt_data", "observation envelope invalid");
    const envelope = parsed as Partial<Envelope<T>>;
    if (envelope.schemaVersion !== "observation-repository-v1" || envelope.kind !== kind || !("payload" in envelope) || envelope.checksum !== digest(canonicalJson(envelope.payload))) throw new ObservationRepositoryError("corrupt_data", "observation envelope checksum invalid");
    return clone(envelope.payload as T);
  }
  private async readStoredAt(repositoryRoot: string, planId: string, id: string): Promise<StoredObservation> {
    const stored = await this.read<StoredObservation>(this.observationFileAt(repositoryRoot, planId, id), "observation");
    if (stored.schemaVersion !== "observation-repository-v1" || !Number.isInteger(stored.revision) || stored.revision !== 0 || !SHA256.test(stored.recordHash) || validateUserObservation(stored.observation).length || stored.observation.planId !== planId || stored.recordHash !== digest(canonicalJson(stored.observation))) throw new ObservationRepositoryError("corrupt_data", "observation record integrity invalid");
    if (stored.observation.contentHash !== observationHash(stored.observation)) throw new ObservationRepositoryError("corrupt_data", "observation content hash invalid");
    return stored;
  }
  private async readStored(planId: string, id: string): Promise<StoredObservation> { return this.readStoredAt(this.root, planId, id); }
  private async ensureAttachmentClosure(observation: UserObservation, activeRoot?: string): Promise<void> {
    if (activeRoot && typeof this.attachments.hasAvailableAtRoot !== "function") throw new ObservationRepositoryError("invalid_input", "coordinated attachment closure lookup is unavailable");
    const checks = await Promise.all(observation.attachmentRefs.map((id) => activeRoot
      ? this.attachments.hasAvailableAtRoot!(activeRoot, id, observation.planId)
      : this.attachments.hasAvailable(id, observation.planId)));
    if (checks.some((found) => !found)) throw new ObservationRepositoryError("invalid_input", "observation attachment closure is incomplete or cross-plan");
  }

  async put(input: PutObservationInput): Promise<UserObservation> {
    const observation = clone(input.observation); this.assert(observation.planId, "plan id"); this.assert(observation.observationId, "observation id");
    if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new ObservationRepositoryError("conflict", "new immutable observations only accept revision 0");
    if (validateUserObservation(observation).length) throw new ObservationRepositoryError("invalid_input", validateUserObservation(observation).join("; "));
    if (observation.contentHash !== observationHash(observation)) throw new ObservationRepositoryError("invalid_input", "observation content hash mismatch");
    // Serialize a whole plan: two replacements must not both supersede the
    // same immutable source even when their replacement IDs differ.
    return this.withRoot(`plan:${observation.planId}`, true, (activeRoot) => this.serial(`plan:${observation.planId}`, async () => {
      await this.recoverJournals(observation.planId);
      // This lookup shares the coordinator's writer barrier with the record
      // commit. A tombstone cannot land between closure validation and rename.
      await this.ensureAttachmentClosure(observation, activeRoot);
      try {
        const existing = await this.readStored(observation.planId, observation.observationId);
        if (input.expectedHash !== undefined && input.expectedHash !== existing.recordHash) throw new ObservationRepositoryError("conflict", "observation expected hash mismatch");
        if (existing.recordHash !== digest(canonicalJson(observation))) throw new ObservationRepositoryError("conflict", "immutable observation id already exists with different content");
        return clone(existing.observation);
      } catch (error) { if (!(error instanceof ObservationRepositoryError) || error.code !== "not_found") throw error; }
      if (input.expectedHash !== undefined && input.expectedHash !== digest(canonicalJson(observation))) throw new ObservationRepositoryError("conflict", "observation expected hash mismatch");
      let supersession: Supersession | undefined;
      if (observation.supersedesObservationId) {
        const old = await this.readStored(observation.planId, observation.supersedesObservationId);
        if (old.observation.status !== "active") throw new ObservationRepositoryError("conflict", "only an active observation can be superseded");
        const alreadyReplaced = (await this.listAtRoot(observation.planId)).some((item) => item.supersedesObservationId === old.observation.observationId);
        if (alreadyReplaced) throw new ObservationRepositoryError("conflict", "observation already has an immutable replacement");
        const eventBase = { schemaVersion: "observation-supersession-v1" as const, planId: observation.planId, supersededObservationId: old.observation.observationId, replacementObservationId: observation.observationId, createdAt: this.now() };
        supersession = { ...eventBase, contentHash: digest(canonicalJson(eventBase)) };
      }
      const stored: StoredObservation = { schemaVersion: "observation-repository-v1", revision: 0, recordHash: digest(canonicalJson(observation)), observation };
      const transactionId = `observation-${observation.observationId}-${this.now().replace(/[^0-9A-Za-z]/g, "")}`;
      const journalPayload = { transactionId, operation: "observation-create" as const, planId: observation.planId, authorityId: observation.observationId, authority: stored, ...(supersession ? { supersession } : {}), state: "prepared" as const, createdAt: this.now() };
      await this.writeJournal({ schemaVersion: "observation-journal-v1", kind: "transaction", checksum: digest(canonicalJson(journalPayload)), payload: journalPayload });
      await this.write(this.observationFile(observation.planId, observation.observationId), { schemaVersion: "observation-repository-v1", kind: "observation", checksum: digest(canonicalJson(stored)), payload: stored });
      // This is a derived index. The replacement record remains authoritative if
      // a process stops between these two atomic renames, so recovery cannot
      // create a dangling reference to a missing observation.
      if (supersession) await this.write(this.supersessionFile(observation.planId, observation.observationId), { schemaVersion: "observation-repository-v1", kind: "supersession", checksum: digest(canonicalJson(supersession)), payload: supersession });
      const committedPayload = { ...journalPayload, state: "committed" as const };
      await this.writeJournal({ schemaVersion: "observation-journal-v1", kind: "transaction", checksum: digest(canonicalJson(committedPayload)), payload: committedPayload });
      return clone(observation);
    }), input.maintenanceLeaseToken);
  }

  async get(planId: string, observationId: string): Promise<UserObservation> { return this.withRoot(`plan:${planId}`, false, async () => clone((await this.readStored(planId, observationId)).observation)); }
  private async listAtRoot(planId: string): Promise<UserObservation[]> {
    const directory = path.join(this.planRoot(planId), "records"); let entries: import("node:fs").Dirent[]; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new ObservationRepositoryError("corrupt_data", "observation listing contains a symlink");
    const values = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort().map((name) => this.readStored(planId, name.slice(0, -5))));
    return values.map((item) => clone(item.observation));
  }
  async list(planId: string): Promise<UserObservation[]> { return this.withRoot(`plan:${planId}`, false, () => this.listAtRoot(planId)); }
  private async listSupersessionsAtRoot(planId: string): Promise<Supersession[]> {
    const directory = path.join(this.planRoot(planId), "supersessions"); let entries: import("node:fs").Dirent[]; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (entries.some((entry) => entry.isSymbolicLink())) throw new ObservationRepositoryError("corrupt_data", "observation supersession listing contains a symlink");
    return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort().map((name) => this.read<Supersession>(path.join(directory, name), "supersession")));
  }
  async listSupersessions(planId: string): Promise<Supersession[]> { return this.withRoot(`plan:${planId}`, false, () => this.listSupersessionsAtRoot(planId)); }
  /** Current projection; source records remain unchanged in immutable history. */
  async listCurrent(planId: string): Promise<UserObservation[]> {
    const all = await this.list(planId);
    const superseded = new Set(all.flatMap((item) => item.supersedesObservationId ? [item.supersedesObservationId] : []));
    return all.filter((item) => !superseded.has(item.observationId));
  }
  async createSnapshot(planId: string, observationIds?: string[]): Promise<UserObservationSnapshot> {
    return this.withRoot(`plan:${planId}`, true, async () => {
    await this.recoverJournals(planId);
    const all = await this.listAtRoot(planId); const ids = observationIds ? [...observationIds] : all.map((item) => item.observationId);
    if (new Set(ids).size !== ids.length || ids.some((id) => !all.some((item) => item.observationId === id))) throw new ObservationRepositoryError("invalid_input", "snapshot observation closure invalid");
    const snapshotId = this.id("snapshot"); this.assert(snapshotId, "snapshot id");
    const candidate = { schemaVersion: "user-observation-snapshot-v1" as const, snapshotId, planId, observationIds: ids, createdAt: this.now() };
    const snapshot: UserObservationSnapshot = { ...candidate, contentHash: await hashContent(candidate, { domain: "user-observation-snapshot", schemaVersion: "user-observation-snapshot-v1" }) };
    if (validateUserObservationSnapshot(snapshot).length) throw new ObservationRepositoryError("invalid_input", "snapshot invalid");
    const transactionId = `snapshot-${snapshot.snapshotId}`;
    const journalPayload = { transactionId, operation: "snapshot-create" as const, planId, authorityId: snapshot.snapshotId, authority: snapshot, state: "prepared" as const, createdAt: this.now() };
    await this.writeJournal({ schemaVersion: "observation-journal-v1", kind: "transaction", checksum: digest(canonicalJson(journalPayload)), payload: journalPayload });
    await this.write(this.snapshotFile(planId, snapshotId), { schemaVersion: "observation-repository-v1", kind: "snapshot", checksum: digest(canonicalJson(snapshot)), payload: snapshot });
    const committedPayload = { ...journalPayload, state: "committed" as const };
    await this.writeJournal({ schemaVersion: "observation-journal-v1", kind: "transaction", checksum: digest(canonicalJson(committedPayload)), payload: committedPayload });
    return clone(snapshot);
    });
  }

  private async readSnapshotAt(repositoryRoot: string, planId: string, snapshotId: string): Promise<UserObservationSnapshot> {
    const snapshot = await this.read<UserObservationSnapshot>(confined(this.planRootAt(repositoryRoot, planId), "snapshots", `${snapshotId}.json`), "snapshot");
    if (validateUserObservationSnapshot(snapshot).length || snapshot.planId !== planId || snapshot.snapshotId !== snapshotId) throw new ObservationRepositoryError("corrupt_data", "observation snapshot integrity invalid");
    const { contentHash: _contentHash, ...base } = snapshot;
    const expected = await hashContent(base, { domain: "user-observation-snapshot", schemaVersion: "user-observation-snapshot-v1" });
    if (snapshot.contentHash !== expected) throw new ObservationRepositoryError("corrupt_data", "observation snapshot content hash invalid");
    return snapshot;
  }

  /** Called inside RuntimeCoordinator.withConsistentSnapshot; never reacquires it or writes. */
  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "observations";
    revision: number;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const repositoryRoot = confined(activeRoot, "observations");
    const plansRoot = confined(repositoryRoot, "plans");
    let plans: import("node:fs").Dirent[];
    try { plans = await readdir(plansRoot, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") plans = []; else throw error; }
    if (plans.some((entry) => entry.isSymbolicLink())) throw new ObservationRepositoryError("corrupt_data", "observation plans contain a symlink");
    const records: StoredObservation[] = [];
    const snapshots: UserObservationSnapshot[] = [];
    for (const planEntry of plans.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      this.assert(planEntry.name, "plan id");
      const planRoot = this.planRootAt(repositoryRoot, planEntry.name);
      for (const [kind, directory] of [["observation", confined(planRoot, "records")], ["snapshot", confined(planRoot, "snapshots")]] as const) {
        let entries: import("node:fs").Dirent[];
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = []; else throw error; }
        if (entries.some((entry) => entry.isSymbolicLink())) throw new ObservationRepositoryError("corrupt_data", `observation ${kind} directory contains a symlink`);
        for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
          const id = entry.name.slice(0, -5);
          if (kind === "observation") records.push(await this.readStoredAt(repositoryRoot, planEntry.name, id));
          else snapshots.push(await this.readSnapshotAt(repositoryRoot, planEntry.name, id));
        }
      }
    }
    const observationNodes = records.map((record) => `observation:${record.observation.observationId}`);
    const snapshotNodes = snapshots.map((snapshot) => `observation-snapshot:${snapshot.snapshotId}`);
    const edges = [
      ...records.flatMap((record) => record.observation.attachmentRefs.map((id) => ({ fromRef: `observation:${record.observation.observationId}`, toRef: `attachment:${id}`, necessity: "required_for_replay" as const }))),
      ...snapshots.flatMap((snapshot) => snapshot.observationIds.map((id) => ({ fromRef: `observation-snapshot:${snapshot.snapshotId}`, toRef: `observation:${id}`, necessity: "required_for_replay" as const }))),
    ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    return {
      providerId: "observations",
      revision: records.length + snapshots.length,
      manifestHash: sha256Json({ records: records.map((record) => ({ id: record.observation.observationId, recordHash: record.recordHash })), snapshots: snapshots.map((snapshot) => ({ id: snapshot.snapshotId, contentHash: snapshot.contentHash })) }),
      snapshotPointers: snapshotNodes.sort(),
      nodes: [...new Set([...observationNodes, ...snapshotNodes])].sort(),
      edges,
    };
  }
}
