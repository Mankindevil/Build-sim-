import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { hashContent } from "../hash";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, ensurePrivateDirectory, pathExists, readJson, sha256Json } from "../runtime/fs.mjs";
import {
  validateImmutableListingCapture,
  validatePriceHistoryPoint,
  validatePriceObservationWithResolvedCaptures,
  validatePriceTarget,
  validatePriceTargetEvent,
  type ImmutableListingCapture,
  type PriceHistoryPoint,
  type PriceObservation,
  type PriceTarget,
  type PriceTargetEvent,
} from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ENVELOPE_VERSION = "price-repository-v1" as const;

type RecordKind = "capture" | "observation" | "history" | "target" | "event" | "event-idempotency" | "rollback" | "rollback-manifest";
interface Envelope<T> { schemaVersion: typeof ENVELOPE_VERSION; kind: RecordKind; revision: number; payloadHash: string; checksum: string; payload: T; }
interface Stored<T> { value: T; revision: number; recordHash: string; }
interface EventIndex { schemaVersion: "price-event-idempotency-v1"; idempotencyHash: string; eventId: string; eventHash: string; createdAt: string; }
interface TargetRollback { schemaVersion: "price-target-rollback-v1"; targetId: string; fromRevision: number; toRevision: number; previousHash: string; previous: PriceTarget; createdAt: string; }
interface RollbackManifest { schemaVersion: "price-rollback-manifest-v1"; entries: Array<{ targetId: string; fromRevision: number; toRevision: number; previousHash: string; createdAt: string; }>; }

export class PriceRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input" | "fenced", message: string) {
    super(message); this.name = "PriceRepositoryError";
  }
}

export interface PriceRepositoryOptions { runtimeRoot?: string; coordinator?: RuntimeCoordinator; now?: () => string; }
export interface ExpectedVersion { expectedRevision?: number; expectedHash?: string; maintenanceLeaseToken?: string; }
export interface VersionedPriceTarget { target: PriceTarget; revision: number; recordHash: string; }
export interface RecordedPriceEvent { event: PriceTargetEvent; created: boolean; }

function clone<T>(value: T): T { return structuredClone(value); }
function assertId(value: string, label: string): void { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new PriceRepositoryError("invalid_input", `${label} is invalid`); }
function idempotencyHash(key: string): string { return createHash("sha256").update(`buildsim-price-event\0${key.normalize("NFC")}`, "utf8").digest("hex"); }
function envelope<T>(kind: RecordKind, payload: T, revision = 0): Envelope<T> {
  const payloadHash = sha256Json(payload);
  const base = { schemaVersion: ENVELOPE_VERSION, kind, revision, payloadHash, payload: clone(payload) };
  return { ...base, checksum: sha256Json(base) };
}
function parseEnvelope<T>(value: unknown, kind: RecordKind): Stored<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PriceRepositoryError("corrupt_data", "price record envelope is invalid");
  const raw = value as Partial<Envelope<T>>;
  if (raw.schemaVersion !== ENVELOPE_VERSION || raw.kind !== kind || !Number.isInteger(raw.revision) || raw.revision! < 0
    || typeof raw.payloadHash !== "string" || !SHA256.test(raw.payloadHash) || !("payload" in raw)) {
    throw new PriceRepositoryError("corrupt_data", "price record envelope schema is invalid");
  }
  const base = { schemaVersion: raw.schemaVersion, kind: raw.kind, revision: raw.revision, payloadHash: raw.payloadHash, payload: raw.payload };
  if (raw.payloadHash !== sha256Json(raw.payload) || raw.checksum !== sha256Json(base)) throw new PriceRepositoryError("corrupt_data", "price record checksum is invalid");
  return { value: clone(raw.payload as T), revision: raw.revision!, recordHash: raw.payloadHash };
}

/**
 * U1 durable store for immutable captures/observations/history and mutable
 * price targets.  It deliberately has no refresh, scheduling, or notification
 * behavior: those U10 concerns must consume this single authoritative store.
 */
export class PriceRepository {
  readonly coordinator: RuntimeCoordinator;
  private readonly now: () => string;

  constructor(options: PriceRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.coordinator = options.coordinator ?? new RuntimeCoordinator({ root: options.runtimeRoot, now: this.now });
  }

  // Keep governed U1/U10 domain records separate from the legacy/current-price
  // snapshot layout (`prices/history`, `prices/listing-captures`, and
  // `prices/targets`). Both live under the same backed-up root, but they use
  // different schemas and must never parse one another's files.
  private root(activeRoot: string): string { return confined(activeRoot, "prices", "domain"); }
  private directory(activeRoot: string, kind: "captures" | "observations" | "history" | "targets" | "events" | "event-idempotency" | "rollback"): string { return confined(this.root(activeRoot), kind); }
  private file(activeRoot: string, kind: "captures" | "observations" | "history" | "targets" | "events", id: string): string { assertId(id, `${kind} id`); return confined(this.directory(activeRoot, kind), `${id}.json`); }
  private indexFile(activeRoot: string, keyHash: string): string { if (!SHA256.test(keyHash)) throw new PriceRepositoryError("invalid_input", "event idempotency hash is invalid"); return confined(this.directory(activeRoot, "event-idempotency"), `${keyHash}.json`); }
  private rollbackFile(activeRoot: string, targetId: string, revision: number): string { assertId(targetId, "target id"); return confined(this.directory(activeRoot, "rollback"), "targets", targetId, `${String(revision).padStart(12, "0")}.json`); }
  private manifestFile(activeRoot: string): string { return confined(this.directory(activeRoot, "rollback"), "manifest.json"); }

  async initialize(appVersion?: string): Promise<void> {
    await this.coordinator.initialize(appVersion);
    await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => this.ensureLayout(activeRoot));
  }
  private async ensureLayout(activeRoot: string): Promise<void> {
    // atomicWriteJson creates each parent privately; this intentionally happens
    // only under the global writer barrier, never as a side effect of reads.
    for (const directory of ["captures", "observations", "history", "targets", "events", "event-idempotency", "rollback"]) {
      await ensurePrivateDirectory(this.directory(activeRoot, directory as "captures"));
    }
  }
  private async read<T>(activeRoot: string, kind: RecordKind, file: string): Promise<Stored<T>> {
    if (!await pathExists(file)) throw new PriceRepositoryError("not_found", "price record was not found");
    try { return parseEnvelope<T>(await readJson(file), kind); }
    catch (error) { if (error instanceof PriceRepositoryError) throw error; throw new PriceRepositoryError("corrupt_data", "price record cannot be read"); }
  }
  private async write<T>(file: string, kind: RecordKind, value: T, revision = 0): Promise<Stored<T>> {
    const record = envelope(kind, value, revision); await atomicWriteJson(file, record);
    return { value: clone(value), revision, recordHash: record.payloadHash };
  }
  private async list<T>(activeRoot: string, directory: "captures" | "observations" | "history" | "targets" | "events", kind: RecordKind): Promise<Array<Stored<T>>> {
    const folder = this.directory(activeRoot, directory);
    if (!await pathExists(folder)) return [];
    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())) throw new PriceRepositoryError("corrupt_data", "price repository contains a symbolic link");
    return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => this.read<T>(activeRoot, kind, path.join(folder, entry.name))));
  }
  private assertExpected(stored: Stored<unknown>, input: ExpectedVersion): void {
    if (input.expectedRevision !== undefined && input.expectedRevision !== stored.revision) throw new PriceRepositoryError("conflict", "price record revision changed");
    if (input.expectedHash !== undefined && input.expectedHash !== stored.recordHash) throw new PriceRepositoryError("conflict", "price record hash changed");
  }
  private async validateCapture(capture: ImmutableListingCapture): Promise<void> {
    assertId(capture.listingCaptureId, "listing capture id");
    const errors = validateImmutableListingCapture(capture);
    const hash = await hashContent(capture, { domain: "listing-capture", schemaVersion: "listing-capture-v1" });
    if (capture.contentHash !== hash) errors.push("listing capture contentHash verification failed");
    if (errors.length) throw new PriceRepositoryError("invalid_input", errors.join("; "));
  }

  async putListingCapture(capture: ImmutableListingCapture, input: ExpectedVersion = {}): Promise<ImmutableListingCapture> {
    const candidate = clone(capture); await this.validateCapture(candidate);
    return (await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await this.ensureLayout(activeRoot); const file = this.file(activeRoot, "captures", candidate.listingCaptureId);
      if (await pathExists(file)) {
        const existing = await this.read<ImmutableListingCapture>(activeRoot, "capture", file); this.assertExpected(existing, input);
        if (existing.recordHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "immutable listing capture id already exists with different content");
        return clone(existing.value);
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new PriceRepositoryError("conflict", "new capture expected revision must be zero");
      if (input.expectedHash !== undefined && input.expectedHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "new capture expected hash mismatch");
      await this.write(file, "capture", candidate); return candidate;
    }, { maintenanceLeaseToken: input.maintenanceLeaseToken })).result;
  }

  async putObservation(observation: PriceObservation, input: ExpectedVersion = {}): Promise<PriceObservation> {
    const candidate = clone(observation); assertId(candidate.observationId, "observation id");
    return (await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await this.ensureLayout(activeRoot);
      const capture = (await this.read<ImmutableListingCapture>(activeRoot, "capture", this.file(activeRoot, "captures", candidate.listingCaptureId))).value;
      const errors = validatePriceObservationWithResolvedCaptures(candidate, new Map([[capture.listingCaptureId, capture]]));
      if (errors.length) throw new PriceRepositoryError("invalid_input", errors.join("; "));
      const file = this.file(activeRoot, "observations", candidate.observationId);
      if (await pathExists(file)) {
        const existing = await this.read<PriceObservation>(activeRoot, "observation", file); this.assertExpected(existing, input);
        if (existing.recordHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "immutable observation id already exists with different content");
        return clone(existing.value);
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new PriceRepositoryError("conflict", "new observation expected revision must be zero");
      if (input.expectedHash !== undefined && input.expectedHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "new observation expected hash mismatch");
      await this.write(file, "observation", candidate); return candidate;
    }, { maintenanceLeaseToken: input.maintenanceLeaseToken })).result;
  }

  async putHistoryPoint(point: PriceHistoryPoint, input: ExpectedVersion = {}): Promise<PriceHistoryPoint> {
    const candidate = clone(point); assertId(candidate.historyPointId, "history point id");
    return (await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await this.ensureLayout(activeRoot);
      const observations = (await this.list<PriceObservation>(activeRoot, "observations", "observation")).map((item) => item.value);
      const errors = validatePriceHistoryPoint(candidate, observations);
      if (errors.length) throw new PriceRepositoryError("invalid_input", errors.join("; "));
      const file = this.file(activeRoot, "history", candidate.historyPointId);
      if (await pathExists(file)) {
        const existing = await this.read<PriceHistoryPoint>(activeRoot, "history", file); this.assertExpected(existing, input);
        if (existing.recordHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "immutable history point id already exists with different content");
        return clone(existing.value);
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new PriceRepositoryError("conflict", "new history expected revision must be zero");
      if (input.expectedHash !== undefined && input.expectedHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "new history expected hash mismatch");
      await this.write(file, "history", candidate); return candidate;
    }, { maintenanceLeaseToken: input.maintenanceLeaseToken })).result;
  }

  async putTarget(target: PriceTarget, input: ExpectedVersion = {}): Promise<VersionedPriceTarget> {
    const candidate = clone(target); assertId(candidate.targetId, "target id");
    const errors = validatePriceTarget(candidate); if (errors.length) throw new PriceRepositoryError("invalid_input", errors.join("; "));
    return (await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await this.ensureLayout(activeRoot); const file = this.file(activeRoot, "targets", candidate.targetId);
      if (!await pathExists(file)) {
        if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new PriceRepositoryError("conflict", "new target expected revision must be zero");
        if (input.expectedHash !== undefined && input.expectedHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "new target expected hash mismatch");
        const created = await this.write(file, "target", candidate); return { target: created.value, revision: created.revision, recordHash: created.recordHash };
      }
      const previous = await this.read<PriceTarget>(activeRoot, "target", file); this.assertExpected(previous, input);
      if (previous.recordHash === sha256Json(candidate)) return { target: previous.value, revision: previous.revision, recordHash: previous.recordHash };
      if (previous.value.revisionHash === candidate.revisionHash) throw new PriceRepositoryError("invalid_input", "changed price target must advance revisionHash");
      await this.writeTargetRollback(activeRoot, previous, candidate);
      const updated = await this.write(file, "target", candidate, previous.revision + 1);
      return { target: updated.value, revision: updated.revision, recordHash: updated.recordHash };
    }, { maintenanceLeaseToken: input.maintenanceLeaseToken })).result;
  }

  async getTarget(targetId: string): Promise<VersionedPriceTarget> {
    assertId(targetId, "target id");
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const stored = await this.read<PriceTarget>(activeRoot, "target", this.file(activeRoot, "targets", targetId));
      const errors = validatePriceTarget(stored.value); if (errors.length) throw new PriceRepositoryError("corrupt_data", errors.join("; "));
      return { target: clone(stored.value), revision: stored.revision, recordHash: stored.recordHash };
    })).result;
  }

  private async writeTargetRollback(activeRoot: string, previous: Stored<PriceTarget>, next: PriceTarget): Promise<void> {
    const rollback: TargetRollback = { schemaVersion: "price-target-rollback-v1", targetId: previous.value.targetId, fromRevision: previous.revision, toRevision: previous.revision + 1, previousHash: previous.recordHash, previous: clone(previous.value), createdAt: this.now() };
    await this.write(this.rollbackFile(activeRoot, previous.value.targetId, previous.revision), "rollback", rollback);
    const file = this.manifestFile(activeRoot); let manifest: RollbackManifest = { schemaVersion: "price-rollback-manifest-v1", entries: [] };
    if (await pathExists(file)) {
      const stored = await this.read<RollbackManifest>(activeRoot, "rollback-manifest", file);
      if (stored.value.schemaVersion !== "price-rollback-manifest-v1" || !Array.isArray(stored.value.entries)) throw new PriceRepositoryError("corrupt_data", "price rollback manifest is invalid");
      manifest = stored.value;
    }
    const entry = { targetId: rollback.targetId, fromRevision: rollback.fromRevision, toRevision: rollback.toRevision, previousHash: rollback.previousHash, createdAt: rollback.createdAt };
    // The record is authoritative; this append-only manifest is audit/rollback
    // evidence and may be rebuilt from records after an interrupted manifest write.
    await this.write(file, "rollback-manifest", { ...manifest, entries: [...manifest.entries, entry] }, manifest.entries.length + 1);
    void next;
  }

  async recordTargetEvent(event: PriceTargetEvent, input: { maintenanceLeaseToken?: string } = {}): Promise<RecordedPriceEvent> {
    const candidate = clone(event); assertId(candidate.eventId, "event id");
    const errors = validatePriceTargetEvent(candidate); if (errors.length) throw new PriceRepositoryError("invalid_input", errors.join("; "));
    const keyHash = idempotencyHash(candidate.idempotencyKey);
    return (await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await this.ensureLayout(activeRoot);
      await this.getTargetAt(activeRoot, candidate.targetId); // event must not outlive an unknown target
      const indexFile = this.indexFile(activeRoot, keyHash);
      if (await pathExists(indexFile)) {
        const index = (await this.read<EventIndex>(activeRoot, "event-idempotency", indexFile)).value;
        if (index.schemaVersion !== "price-event-idempotency-v1" || index.idempotencyHash !== keyHash || !SAFE_ID.test(index.eventId) || !SHA256.test(index.eventHash)) throw new PriceRepositoryError("corrupt_data", "price event idempotency index is invalid");
        const existing = await this.read<PriceTargetEvent>(activeRoot, "event", this.file(activeRoot, "events", index.eventId));
        if (existing.recordHash !== index.eventHash || existing.value.idempotencyKey !== candidate.idempotencyKey) throw new PriceRepositoryError("corrupt_data", "price event idempotency index hash mismatch");
        // eventId and occurredAt are delivery metadata. The contract's key binds
        // all semantic transition inputs, so a retry with a fresh event ID must
        // return the original append-only event instead of notifying twice.
        return { event: clone(existing.value), created: false };
      }
      // Recover a crash after authoritative event rename but before index rename.
      const sameKey = (await this.list<PriceTargetEvent>(activeRoot, "events", "event")).find((stored) => stored.value.idempotencyKey === candidate.idempotencyKey);
      if (sameKey) {
        const recovered: EventIndex = { schemaVersion: "price-event-idempotency-v1", idempotencyHash: keyHash, eventId: sameKey.value.eventId, eventHash: sameKey.recordHash, createdAt: sameKey.value.occurredAt };
        await this.write(indexFile, "event-idempotency", recovered); return { event: clone(sameKey.value), created: false };
      }
      const eventFile = this.file(activeRoot, "events", candidate.eventId);
      if (await pathExists(eventFile)) {
        const existing = await this.read<PriceTargetEvent>(activeRoot, "event", eventFile);
        if (existing.recordHash !== sha256Json(candidate)) throw new PriceRepositoryError("conflict", "event id already exists with different content");
        await this.write(indexFile, "event-idempotency", { schemaVersion: "price-event-idempotency-v1", idempotencyHash: keyHash, eventId: candidate.eventId, eventHash: existing.recordHash, createdAt: candidate.occurredAt });
        return { event: clone(existing.value), created: false };
      }
      const stored = await this.write(eventFile, "event", candidate);
      await this.write(indexFile, "event-idempotency", { schemaVersion: "price-event-idempotency-v1", idempotencyHash: keyHash, eventId: candidate.eventId, eventHash: stored.recordHash, createdAt: candidate.occurredAt });
      return { event: candidate, created: true };
    }, { maintenanceLeaseToken: input.maintenanceLeaseToken })).result;
  }
  private async getTargetAt(activeRoot: string, targetId: string): Promise<Stored<PriceTarget>> {
    const stored = await this.read<PriceTarget>(activeRoot, "target", this.file(activeRoot, "targets", targetId));
    const errors = validatePriceTarget(stored.value); if (errors.length) throw new PriceRepositoryError("corrupt_data", errors.join("; "));
    return stored;
  }

  async listHistoryPoints(): Promise<PriceHistoryPoint[]> { return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => (await this.list<PriceHistoryPoint>(activeRoot, "history", "history")).map((item) => clone(item.value)))).result; }
  async listObservations(): Promise<PriceObservation[]> { return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => (await this.list<PriceObservation>(activeRoot, "observations", "observation")).map((item) => clone(item.value)))).result; }
  async listTargetEvents(targetId?: string): Promise<PriceTargetEvent[]> {
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const events = (await this.list<PriceTargetEvent>(activeRoot, "events", "event")).map((item) => item.value);
      return events.filter((event) => targetId === undefined || event.targetId === targetId).map(clone);
    })).result;
  }

  /** Called inside a RuntimeCoordinator consistent-snapshot barrier; it never writes or reacquires the lock. */
  async snapshotReferences(activeRoot: string): Promise<{ providerId: "prices"; revision: number; manifestHash: string; snapshotPointers: string[]; nodes: string[]; edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" | "optional_for_audit" }>; }> {
    const [captures, observations, history, targets, events] = await Promise.all([
      this.list<ImmutableListingCapture>(activeRoot, "captures", "capture"), this.list<PriceObservation>(activeRoot, "observations", "observation"), this.list<PriceHistoryPoint>(activeRoot, "history", "history"), this.list<PriceTarget>(activeRoot, "targets", "target"), this.list<PriceTargetEvent>(activeRoot, "events", "event"),
    ]);
    for (const capture of captures) { const errors = validateImmutableListingCapture(capture.value); if (errors.length) throw new PriceRepositoryError("corrupt_data", errors.join("; ")); }
    const captureById = new Map(captures.map((item) => [item.value.listingCaptureId, item.value]));
    for (const observation of observations) { const errors = validatePriceObservationWithResolvedCaptures(observation.value, captureById); if (errors.length) throw new PriceRepositoryError("corrupt_data", errors.join("; ")); }
    const observationValues = observations.map((item) => item.value);
    for (const point of history) { const errors = validatePriceHistoryPoint(point.value, observationValues); if (errors.length) throw new PriceRepositoryError("corrupt_data", errors.join("; ")); }
    for (const target of targets) { const errors = validatePriceTarget(target.value); if (errors.length) throw new PriceRepositoryError("corrupt_data", errors.join("; ")); }
    for (const event of events) { const errors = validatePriceTargetEvent(event.value); if (errors.length) throw new PriceRepositoryError("corrupt_data", errors.join("; ")); }
    const nodes = [
      ...captures.map((item) => `price-capture:${item.value.listingCaptureId}`), ...observations.map((item) => `price-observation:${item.value.observationId}`),
      ...history.map((item) => `price-history:${item.value.historyPointId}`), ...targets.map((item) => `price-target:${item.value.targetId}`), ...events.map((item) => `price-target-event:${item.value.eventId}`),
    ].sort();
    const targetIds = new Set(targets.map((item) => item.value.targetId));
    const danglingEvent = events.find((item) => !targetIds.has(item.value.targetId));
    if (danglingEvent) throw new PriceRepositoryError("corrupt_data", "price target event references a missing target");
    const edges = [
      ...observations.map((item) => ({ fromRef: `price-observation:${item.value.observationId}`, toRef: `price-capture:${item.value.listingCaptureId}`, necessity: "required_for_replay" as const })),
      ...history.flatMap((item) => item.value.observationIds.map((id) => ({ fromRef: `price-history:${item.value.historyPointId}`, toRef: `price-observation:${id}`, necessity: "required_for_replay" as const }))),
      ...events.filter((item) => targetIds.has(item.value.targetId)).map((item) => ({ fromRef: `price-target-event:${item.value.eventId}`, toRef: `price-target:${item.value.targetId}`, necessity: "required_for_replay" as const })),
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { providerId: "prices", revision: Math.max(0, ...[...captures, ...observations, ...history, ...targets, ...events].map((item) => item.revision)), manifestHash: sha256Json({ captures, observations, history, targets, events }), snapshotPointers: nodes.filter((node) => node.startsWith("price-history:") || node.startsWith("price-target:")).sort(), nodes, edges };
  }
}
