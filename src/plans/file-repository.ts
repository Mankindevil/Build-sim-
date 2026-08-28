import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { open, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { serializeConfig, TOPOLOGY_V3_FEATURE_FLAG, type BuildConfig, type BuildConfigDocument, type ConfigV2 } from "../config/types";
import { sha256Hex as sha256String } from "../hash";
import {
  EVIDENCE_SCHEMA_VERSION,
  type EvidenceCapture,
  type EvidenceDocument,
  type PlanEvidenceBinding,
} from "../evidence/contracts";
import { canonicalJson, deepReadonly, hashPlanConfig, sha256Hex } from "./canonical";
import { assertExpectedConfigHash, assertExpectedRevision, PlanConflictError } from "./conflict";
import {
  PLAN_IDEMPOTENCY_REQUEST,
  PLAN_SCHEMA_VERSION,
  type BuildPlan,
  type BuildPlanSummary,
  type BindPlanEvidenceInput,
  type CreatePlanInput,
  type DuplicatePlanInput,
  type EvidenceCaptureLookup,
  type EvidenceDocumentLookup,
  type MigrateDraftToV3Input,
  type PlanRepository,
  type ReplayIdempotentPlanWriteInput,
  type PlanVersion,
  type SaveVersionInput,
  type UnbindPlanEvidenceInput,
  type UpdateDraftInput,
  type UpdatePlanInfoInput,
} from "./contracts";
import { PlanRepositoryError } from "./errors";
import { assertValidBuildPlan, assertValidPlanVersion, planEvidenceBindingId, planEvidenceBindingIdentity, validatePlanEvidenceBinding } from "./validation";
import { createImmutablePlanVersion } from "./version";
import { migrateBuildConfigV2ToV3 } from "./migration";
import { applyPlanV3ProposalOperations, applyRequirementConfirmations, confirmableRequirementFieldIds } from "./proposals";
import { validatePlanIdempotencyRuntime } from "./canonical-runtime.mjs";
import { assertValidConfig } from "../config/validate";
import { loadBundledCatalog } from "../sku/catalog";
import type { SkuCatalog } from "../sku/types";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteFile, atomicWriteJson, confined, ensurePrivateDirectory, sha256Bytes, withDirectoryLock } from "../runtime/fs.mjs";

const STORED_SCHEMA_VERSION = "1.0.0" as const;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;

interface StoredEnvelope<T> {
  schemaVersion: typeof STORED_SCHEMA_VERSION;
  kind: "plan" | "version" | "idempotency";
  checksum: string;
  payload: T;
}

type IdempotencyResultMaterial =
  | { kind: "plan"; planId: string; writeReceipt?: PlanWriteReceipt }
  | { kind: "version"; planId: string; versionId: string }
  | { kind: "evidence-binding"; planId: string; bindingId: PlanEvidenceBinding["id"] }
  | { kind: "void"; planId: string };

interface PlanWriteReceipt {
  schemaVersion: "plan-write-receipt-v1";
  appliedDraftRevision: number;
  appliedConfigHash: string;
  appliedUpdatedAt: string;
  appliedPlanHash: string;
}

interface IdempotencyRecord {
  schemaVersion: "plan-idempotency-v2";
  operation: string;
  requestHash: string;
  result: IdempotencyResultMaterial & { resultHash: string };
}

type EvidenceBindingIdentity = Pick<PlanEvidenceBinding,
  "planId" | "documentId" | "captureId" | "subject" | "purposes" | "locators"
>;

export interface FilePlanRepositoryOptions {
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  now?: () => string;
  id?: (prefix: "plan" | "version") => string;
  /** Production supplies the merged runtime catalog; tests/defaults use the bundled facts. */
  getCatalog?: () => SkuCatalog;
  getCatalogAtRoot?: (activeRoot: string) => SkuCatalog;
  /** Authoritative immutable evidence metadata lookup; required only for binding operations. */
  getEvidenceDocument?: EvidenceDocumentLookup;
  /** Authoritative capture lookup; required when a binding includes captureId. */
  getEvidenceCapture?: EvidenceCaptureLookup;
  /** Root-aware lookups used while the shared coordinator barrier is held. */
  getEvidenceDocumentAtRoot?: (activeRoot: string, documentId: string) => ReturnType<EvidenceDocumentLookup>;
  getEvidenceCaptureAtRoot?: (activeRoot: string, captureId: string) => ReturnType<EvidenceCaptureLookup>;
  topologyV3Enabled?: boolean;
  v3ReadFallback?: "migration_source";
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FilePlanRepository<TConfig extends BuildConfigDocument = BuildConfig> implements PlanRepository<TConfig> {
  private readonly root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly now: () => string;
  private readonly id: (prefix: "plan" | "version") => string;
  private readonly getCatalog: () => SkuCatalog;
  private readonly getCatalogAtRoot: FilePlanRepositoryOptions["getCatalogAtRoot"];
  private readonly getEvidenceDocument: EvidenceDocumentLookup;
  private readonly getEvidenceCapture: EvidenceCaptureLookup;
  private readonly getEvidenceDocumentAtRoot: FilePlanRepositoryOptions["getEvidenceDocumentAtRoot"];
  private readonly getEvidenceCaptureAtRoot: FilePlanRepositoryOptions["getEvidenceCaptureAtRoot"];
  private readonly topologyV3Enabled: boolean;
  private readonly v3ReadFallback: FilePlanRepositoryOptions["v3ReadFallback"];
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly boundary = new AsyncLocalStorage<boolean>();

  constructor(options: FilePlanRepositoryOptions = {}) {
    const coordinatorRoot = (options.coordinator as unknown as { root?: string } | undefined)?.root;
    const runtimeRoot = path.resolve(options.runtimeRoot ?? coordinatorRoot ?? path.join(process.cwd(), "runtime"));
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, "plans"));
    this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
    this.getCatalog = options.getCatalog ?? loadBundledCatalog;
    this.getCatalogAtRoot = options.getCatalogAtRoot;
    this.getEvidenceDocument = options.getEvidenceDocument ?? (() => null);
    this.getEvidenceCapture = options.getEvidenceCapture ?? (() => null);
    this.getEvidenceDocumentAtRoot = options.getEvidenceDocumentAtRoot;
    this.getEvidenceCaptureAtRoot = options.getEvidenceCaptureAtRoot;
    this.topologyV3Enabled = options.topologyV3Enabled === true;
    this.v3ReadFallback = options.v3ReadFallback;
  }

  /** Exact catalog snapshot used by a V2 -> V3 preview before the governed write. */
  migrationCatalogSnapshot(): SkuCatalog {
    return clone(this.getCatalog());
  }

  private async assertLegacyRootEmpty(): Promise<void> {
    if (!this.coordinator) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (entries.some((entry) => !entry.name.startsWith("."))) throw new PlanRepositoryError("invalid_input", "Legacy runtime/plans contains data; run the explicit active-generation migration dry-run before startup", 409);
  }

  private atActiveRoot(activeRoot: string): FilePlanRepository<TConfig> {
    return new FilePlanRepository<TConfig>({
      root: confined(activeRoot, "plans"), now: this.now, id: this.id,
      topologyV3Enabled: this.topologyV3Enabled,
      ...(this.v3ReadFallback ? { v3ReadFallback: this.v3ReadFallback } : {}),
      getCatalog: this.getCatalogAtRoot ? () => this.getCatalogAtRoot!(activeRoot) : this.getCatalog,
      ...(this.getCatalogAtRoot ? { getCatalogAtRoot: this.getCatalogAtRoot } : {}),
      getEvidenceDocument: this.getEvidenceDocumentAtRoot ? (id) => this.getEvidenceDocumentAtRoot!(activeRoot, id) : this.getEvidenceDocument,
      getEvidenceCapture: this.getEvidenceCaptureAtRoot ? (id) => this.getEvidenceCaptureAtRoot!(activeRoot, id) : this.getEvidenceCapture,
    });
  }

  private async publicBoundary<T>(write: boolean, coordinated: (repository: FilePlanRepository<TConfig>) => Promise<T>, local: () => Promise<T>): Promise<T> {
    if (this.coordinator) {
      await this.coordinator.initialize();
      await this.assertLegacyRootEmpty();
      if (write) return (await this.coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => coordinated(this.atActiveRoot(activeRoot)))).result as T;
      return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => coordinated(this.atActiveRoot(activeRoot)))).result as T;
    }
    if (this.boundary.getStore()) return local();
    const lock = confined(this.root, ".locks", "repository-global");
    return withDirectoryLock(lock, () => this.boundary.run(true, local));
  }

  /**
   * Drafts may be incomplete, but every fact already present must be valid.
   * In particular, fan groups are checked against the selected case adapter so
   * HTTP callers cannot persist a count/size that the UI or geometry would clamp.
   */
  private assertSemanticConfig(config: BuildConfigDocument): void {
    try {
      assertValidConfig(config, this.getCatalog(), { topologyV3Enabled: this.topologyV3Enabled });
    } catch (error) {
      throw new PlanRepositoryError("invalid_input", error instanceof Error ? error.message : "Invalid BuildConfig", 400);
    }
  }

  private assertId(id: string): void {
    if (!SAFE_ID.test(id)) throw new PlanRepositoryError("invalid_id", "Invalid plan storage id", 400);
  }

  private evidenceBindingIdentity(value: EvidenceBindingIdentity): unknown {
    return planEvidenceBindingIdentity(value);
  }

  private evidenceBindingId(value: EvidenceBindingIdentity): PlanEvidenceBinding["id"] {
    return planEvidenceBindingId(value);
  }

  private async resolveEvidenceDocument(documentId: PlanEvidenceBinding["documentId"], expectedHash?: string): Promise<EvidenceDocument> {
    if (!/^doc-sha256-[a-f0-9]{64}$/.test(documentId)) throw new PlanRepositoryError("invalid_input", "Evidence document id is invalid", 400);
    const document = await this.getEvidenceDocument(documentId);
    if (!document) throw new PlanRepositoryError("not_found", "Evidence document was not found", 404);
    if (
      document.schemaVersion !== EVIDENCE_SCHEMA_VERSION
      || document.id !== documentId
      || !/^[a-f0-9]{64}$/.test(document.sha256)
      || document.id !== `doc-sha256-${document.sha256}`
    ) throw new PlanRepositoryError("invalid_input", "Evidence document identity or content hash is invalid", 400);
    if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== document.sha256)) {
      throw new PlanRepositoryError("invalid_input", "Evidence document content hash does not match the requested pin", 409);
    }
    return document;
  }

  private async resolveEvidenceCapture(captureId: NonNullable<PlanEvidenceBinding["captureId"]>, documentId: PlanEvidenceBinding["documentId"]): Promise<EvidenceCapture> {
    if (!/^capture-sha256-[a-f0-9]{64}$/.test(captureId)) throw new PlanRepositoryError("invalid_input", "Evidence capture id is invalid", 400);
    const capture = await this.getEvidenceCapture(captureId);
    if (!capture) throw new PlanRepositoryError("not_found", "Evidence capture was not found", 404);
    if (capture.schemaVersion !== EVIDENCE_SCHEMA_VERSION || capture.id !== captureId || capture.documentId !== documentId) {
      throw new PlanRepositoryError("invalid_input", "Evidence capture does not belong to the requested document", 400);
    }
    return capture;
  }

  private planDirectory(planId: string): string {
    this.assertId(planId);
    return path.join(this.root, planId);
  }

  private planFile(planId: string): string {
    return path.join(this.planDirectory(planId), "plan.json");
  }

  private versionFile(planId: string, versionId: string): string {
    this.assertId(versionId);
    return path.join(this.planDirectory(planId), "versions", `${versionId}.json`);
  }

  private idempotencyFile(scope: string, key: string): string {
    const digest = createHash("sha256").update(`${scope}\0${key}`).digest("hex");
    return path.join(this.root, ".idempotency", `${digest}.json`);
  }

  private async atomicWrite<T>(file: string, kind: StoredEnvelope<T>["kind"], payload: T): Promise<void> {
    const envelope: StoredEnvelope<T> = { schemaVersion: STORED_SCHEMA_VERSION, kind, checksum: checksum(payload), payload };
    const prior = await readFile(file).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error));
    let backupPath: string | null = null;
    if (prior) {
      backupPath = confined(this.root, ".rollback", `${Date.now()}-${randomUUID()}-${path.basename(file)}.bak`);
      await atomicWriteFile(backupPath, prior);
    }
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    const manifestFile = confined(this.root, ".rollback", "manifest.json");
    const manifest = await readFile(manifestFile, "utf8").then((raw) => JSON.parse(raw)).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? { schemaVersion: "plan-rollback-manifest-v1", entries: [] } : Promise.reject(error));
    const eventId = randomUUID();
    const prepared = { eventId, operation: kind, target: path.relative(this.root, file), backup: backupPath ? path.relative(this.root, backupPath) : null, previousHash: prior ? sha256Bytes(prior) : null, nextHash: sha256Bytes(bytes), status: "prepared", createdAt: this.now() };
    await atomicWriteJson(manifestFile, { ...manifest, entries: [...(manifest.entries ?? []), prepared] });
    await atomicWriteFile(file, bytes);
    await atomicWriteJson(manifestFile, { ...manifest, entries: [...(manifest.entries ?? []), { ...prepared, status: "committed", committedAt: this.now() }] });
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async readEnvelope<T>(file: string, kind: StoredEnvelope<T>["kind"]): Promise<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PlanRepositoryError("not_found", "Plan data was not found", 404);
      throw new PlanRepositoryError("corrupt_data", `Cannot read plan data: ${error instanceof Error ? error.message : "unknown error"}`, 500);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PlanRepositoryError("corrupt_data", "Plan data envelope is invalid", 500);
    const envelope = parsed as Partial<StoredEnvelope<T>>;
    if (envelope.schemaVersion !== STORED_SCHEMA_VERSION || envelope.kind !== kind || !("payload" in envelope) || envelope.checksum !== checksum(envelope.payload)) {
      throw new PlanRepositoryError("corrupt_data", "Plan data integrity check failed", 500);
    }
    return envelope.payload as T;
  }

  private async readStoredPlan(planId: string): Promise<BuildPlan<BuildConfigDocument>> {
    const stored = await this.readEnvelope<BuildPlan<BuildConfigDocument>>(this.planFile(planId), "plan");
    if (stored.draft?.configAccess !== undefined) throw new PlanRepositoryError("corrupt_data", "Persisted plan must not contain runtime configAccess", 500);
    // Legacy records predate draft evidence bindings. Normalize only after the
    // stored-envelope checksum has been verified so their original bytes remain valid.
    const plan: BuildPlan<BuildConfigDocument> = {
      ...stored,
      draft: { ...stored.draft, evidenceBindings: clone(stored.draft?.evidenceBindings ?? []) },
    };
    try {
      assertValidBuildPlan(plan);
    } catch (error) {
      throw new PlanRepositoryError("corrupt_data", error instanceof Error ? error.message : "Invalid plan data", 500);
    }
    return plan;
  }

  private async readVersion(planId: string, versionId: string): Promise<PlanVersion<BuildConfigDocument>> {
    const version = await this.readEnvelope<PlanVersion<BuildConfigDocument>>(this.versionFile(planId, versionId), "version");
    try {
      assertValidPlanVersion(version);
      if (version.id !== versionId || version.planId !== planId) throw new Error("PlanVersion owner/path identity mismatch");
      if (version.configHash !== await hashPlanConfig(version.config)) throw new Error("PlanVersion config hash mismatch");
      if (version.evidenceBindings && version.evidenceHash !== await sha256Hex(version.evidenceBindings)) throw new Error("PlanVersion evidence hash mismatch");
    } catch (error) {
      throw new PlanRepositoryError("corrupt_data", error instanceof Error ? error.message : "Invalid version data", 500);
    }
    return deepReadonly(version) as PlanVersion<BuildConfigDocument>;
  }

  private async assertMigrationClosure(plan: BuildPlan<BuildConfigDocument>): Promise<PlanVersion<ConfigV2> | null> {
    const migration = plan.draft.configMigration;
    if (!migration) return null;
    if (plan.draft.config.schemaVersion !== "3.0.0") throw new PlanRepositoryError("corrupt_data", "Only a V3 draft may carry config migration metadata", 500);
    let source: PlanVersion<BuildConfigDocument>;
    try {
      source = await this.readVersion(plan.id, migration.sourceVersionId);
    } catch (error) {
      throw new PlanRepositoryError("corrupt_data", `Plan migration source is unavailable: ${error instanceof Error ? error.message : "unknown error"}`, 500);
    }
    if (source.planId !== plan.id || source.config.schemaVersion !== "2.0.0") throw new PlanRepositoryError("corrupt_data", "Plan migration source must be an immutable V2 version", 500);
    const sourceBytes = serializeConfig(source.config);
    const sourceByteHash = await sha256String(sourceBytes);
    const recomputed = await migrateBuildConfigV2ToV3(source.config, {
      sourceBytes,
      sourceHash: sourceByteHash,
      catalogBinding: migration.catalogBinding,
    });
    if (
      source.configHash !== migration.sourceConfigHash
      || source.configHash !== await hashPlanConfig(source.config)
      || migration.rollbackRef.configId !== plan.id
      || migration.rollbackRef.sourceHash !== sourceByteHash
      || migration.rollbackRef.sourceByteLength !== Buffer.byteLength(sourceBytes, "utf8")
      || canonicalJson(migration.diff) !== canonicalJson(recomputed.diff)
      || canonicalJson(migration.warnings) !== canonicalJson(recomputed.warnings)
      || canonicalJson(migration.rollbackRef) !== canonicalJson(recomputed.rollbackRef)
      || canonicalJson(migration.catalogBinding) !== canonicalJson(recomputed.catalogBinding)
    ) throw new PlanRepositoryError("corrupt_data", "Plan migration source/hash/rollback closure is invalid", 500);
    return source as PlanVersion<ConfigV2>;
  }

  private async readPlan(planId: string, allowFallback = true): Promise<BuildPlan<TConfig>> {
    const stored = await this.readStoredPlan(planId);
    const versions = await this.readAllVersions(planId);
    const versionIds = new Set(versions.map((version) => version.id));
    for (const [field, versionId] of [["activeVersionId", stored.activeVersionId], ["draft.baseVersionId", stored.draft.baseVersionId]] as const) {
      if (versionId !== null && !versionIds.has(versionId)) throw new PlanRepositoryError("corrupt_data", `${field} does not resolve to an owned immutable version`, 500);
    }
    const source = await this.assertMigrationClosure(stored);
    if (stored.draft.config.schemaVersion !== "3.0.0") return stored as BuildPlan<TConfig>;
    if (this.topologyV3Enabled) return stored as BuildPlan<TConfig>;
    if (!allowFallback || this.v3ReadFallback !== "migration_source" || !source) {
      const message = !allowFallback && this.v3ReadFallback === "migration_source"
        ? "V3-backed plan is exposed through a read-only fallback"
        : `BuildConfig V3 is disabled; enable ${TOPOLOGY_V3_FEATURE_FLAG}${source ? " or configure v3ReadFallback=migration_source" : ""}`;
      throw new PlanRepositoryError("invalid_input", message, 409);
    }
    return {
      ...stored,
      draft: {
        ...stored.draft,
        config: clone(source.config),
        configAccess: { mode: "v2_fallback", sourceVersionId: source.id },
      },
    } as BuildPlan<TConfig>;
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }

  private async readAllVersions(planId: string): Promise<PlanVersion<BuildConfigDocument>[]> {
    const directory = path.join(this.planDirectory(planId), "versions");
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const versions = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => this.readVersion(planId, file.slice(0, -5))));
    const byId = new Map(versions.map((version) => [version.id, version]));
    for (const version of versions) {
      if (version.parentVersionId === version.id) throw new PlanRepositoryError("corrupt_data", "PlanVersion lineage cannot reference itself", 500);
      if (version.parentVersionId !== null) {
        const parent = byId.get(version.parentVersionId);
        if (!parent || parent.planId !== planId) throw new PlanRepositoryError("corrupt_data", "PlanVersion parent does not resolve to an owned immutable version", 500);
        if (parent.versionNumber >= version.versionNumber) throw new PlanRepositoryError("corrupt_data", "PlanVersion parent must precede its child", 500);
      }
    }
    for (const version of versions) {
      const visited = new Set<string>();
      let cursor: PlanVersion<BuildConfigDocument> | undefined = version;
      while (cursor && cursor.parentVersionId !== null) {
        if (visited.has(cursor.id)) throw new PlanRepositoryError("corrupt_data", "PlanVersion lineage contains a cycle", 500);
        visited.add(cursor.id);
        cursor = byId.get(cursor.parentVersionId);
      }
    }
    return versions.sort((left, right) => left.versionNumber - right.versionNumber);
  }

  private async idempotent<T>(
    scope: string,
    key: string | undefined,
    request: unknown,
    operation: () => Promise<{ value: T; result: IdempotencyResultMaterial }>,
  ): Promise<T> {
    if (!key) return (await operation()).value;
    if (key.length > 200) throw new PlanRepositoryError("invalid_input", "Idempotency key is too long", 400);
    const file = this.idempotencyFile(scope, key);
    const requestHash = checksum(request);
    try {
      const stored = await this.readEnvelope<IdempotencyRecord>(file, "idempotency");
      const validationErrors = validatePlanIdempotencyRuntime(stored);
      if (validationErrors.length) throw new PlanRepositoryError("corrupt_data", `Plan idempotency record is invalid: ${validationErrors.join("; ")}`, 500);
      if (stored.operation !== scope || stored.requestHash !== requestHash) throw new PlanRepositoryError("idempotency_conflict", "Idempotency key was reused for another request", 409);
      return await this.readIdempotencyResult(stored) as T;
    } catch (error) {
      if (!(error instanceof PlanRepositoryError) || error.code !== "not_found") throw error;
    }
    const completed = await operation();
    const resultMaterial: IdempotencyResultMaterial = completed.result.kind === "plan"
      ? {
          ...completed.result,
          writeReceipt: await this.planWriteReceipt(completed.value, completed.result.planId),
        }
      : completed.result;
    const result = { ...resultMaterial, resultHash: checksum(resultMaterial) } as IdempotencyRecord["result"];
    const record: IdempotencyRecord = { schemaVersion: "plan-idempotency-v2", operation: scope, requestHash, result };
    const validationErrors = validatePlanIdempotencyRuntime(record);
    if (validationErrors.length) throw new PlanRepositoryError("corrupt_data", `Generated Plan idempotency record is invalid: ${validationErrors.join("; ")}`, 500);
    await this.atomicWrite(file, "idempotency", record);
    return completed.value;
  }

  private async planWriteReceipt(value: unknown, expectedPlanId: string): Promise<PlanWriteReceipt> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlanRepositoryError("corrupt_data", "Plan idempotency result did not produce a Plan authority", 500);
    }
    const plan = value as BuildPlan<BuildConfigDocument>;
    if (plan.id !== expectedPlanId) {
      throw new PlanRepositoryError("corrupt_data", "Plan idempotency result owner does not match its Plan authority", 500);
    }
    assertValidBuildPlan(plan);
    return {
      schemaVersion: "plan-write-receipt-v1",
      appliedDraftRevision: plan.draftRevision,
      appliedConfigHash: await hashPlanConfig(plan.draft.config),
      appliedUpdatedAt: plan.updatedAt,
      appliedPlanHash: checksum(plan),
    };
  }

  private async readIdempotencyResult(record: IdempotencyRecord, options: { requirePlanWriteReceipt?: boolean } = {}): Promise<unknown> {
    const result = record.result;
    if (result.kind === "plan") {
      const plan = await this.readPlan(result.planId);
      if (!result.writeReceipt) {
        if (options.requirePlanWriteReceipt) {
          throw new PlanRepositoryError("idempotency_conflict", "Legacy Plan idempotency result has no immutable write receipt and cannot be safely replayed", 409);
        }
        return clone(plan);
      }
      const currentReceipt = await this.planWriteReceipt(plan, result.planId);
      if (canonicalJson(currentReceipt) !== canonicalJson(result.writeReceipt)) {
        throw new PlanRepositoryError("idempotency_conflict", "Completed Plan idempotency result was superseded by a later authoritative write", 409);
      }
      return clone(plan);
    }
    if (result.kind === "version") return deepReadonly(clone(await this.readVersion(result.planId, result.versionId)));
    if (result.kind === "evidence-binding") {
      const plan = await this.readPlan(result.planId);
      const binding = (plan.draft.evidenceBindings ?? []).find((candidate) => candidate.id === result.bindingId);
      if (!binding || validatePlanEvidenceBinding(binding).length) throw new PlanRepositoryError("corrupt_data", "Idempotency evidence binding reference is unavailable or invalid", 500);
      return clone(binding);
    }
    await this.readPlan(result.planId);
    return undefined;
  }

  async replayIdempotentPlanWrite(planId: string, input: ReplayIdempotentPlanWriteInput): Promise<BuildPlan<TConfig> | null> {
    return this.publicBoundary(false, (repository) => repository.replayIdempotentPlanWrite(planId, input), async () => {
      this.assertId(planId);
      if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
        throw new PlanRepositoryError("invalid_input", "Idempotency key is invalid", 400);
      }
      const expectedRequestHash = checksum(input.request);
      let replay: BuildPlan<TConfig> | null = null;
      for (const scope of [`updateDraft:${planId}`, `migrateDraftToV3:${planId}`]) {
        let stored: IdempotencyRecord;
        try {
          stored = await this.readEnvelope<IdempotencyRecord>(this.idempotencyFile(scope, input.idempotencyKey), "idempotency");
        } catch (error) {
          if (error instanceof PlanRepositoryError && error.code === "not_found") continue;
          throw error;
        }
        const validationErrors = validatePlanIdempotencyRuntime(stored);
        if (validationErrors.length) {
          throw new PlanRepositoryError("corrupt_data", `Plan idempotency record is invalid: ${validationErrors.join("; ")}`, 500);
        }
        if (stored.operation !== scope || stored.requestHash !== expectedRequestHash) {
          throw new PlanRepositoryError("idempotency_conflict", "Idempotency key was reused for another request", 409);
        }
        if (replay) throw new PlanRepositoryError("corrupt_data", "Proposal approval resolved to multiple plan writes", 500);
        const result = await this.readIdempotencyResult(stored, { requirePlanWriteReceipt: true });
        if (!result || typeof result !== "object" || (result as BuildPlan<TConfig>).id !== planId) {
          throw new PlanRepositoryError("corrupt_data", "Proposal approval plan result is unavailable", 500);
        }
        replay = result as BuildPlan<TConfig>;
      }
      return replay;
    });
  }

  async list(): Promise<BuildPlanSummary[]> {
    return this.publicBoundary(false, (repository) => repository.list(), async () => {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const plans: BuildPlanSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const plan = await this.readPlan(entry.name);
      plans.push({
        schemaVersion: PLAN_SCHEMA_VERSION,
        id: plan.id,
        name: plan.name,
        status: plan.status,
        updatedAt: plan.updatedAt,
        activeVersionId: plan.activeVersionId,
        draftRevision: plan.draftRevision,
        dirty: plan.draft.dirty,
        ...(plan.metadata.initialization ? { initializationStatus: plan.metadata.initialization.status } : {}),
      });
    }
    return plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    });
  }

  async get(planId: string): Promise<BuildPlan<TConfig>> {
    return this.publicBoundary(false, (repository) => repository.get(planId), async () => clone(await this.readPlan(planId)));
  }

  async create(input: CreatePlanInput<TConfig>): Promise<BuildPlan<TConfig>> {
    return this.publicBoundary(true, (repository) => repository.create(input), async () => {
    if (!input.name.trim()) throw new PlanRepositoryError("invalid_input", "Plan name is required", 400);
    return this.serialize("create", () => this.idempotent(
      "create",
      input.idempotencyKey,
      input,
      async () => {
        const planId = this.id("plan");
        this.assertId(planId);
        const timestamp = this.now();
        const config = clone(input.config);
        if (config.schemaVersion === "3.0.0" && !this.topologyV3Enabled) {
          throw new PlanRepositoryError("invalid_input", `BuildConfig V3 is disabled; enable ${TOPOLOGY_V3_FEATURE_FLAG}`, 409);
        }
        config.id = planId;
        config.name = input.name.trim();
        config.updatedAt = timestamp;
        const plan: BuildPlan<TConfig> = {
          schemaVersion: PLAN_SCHEMA_VERSION,
          id: planId,
          name: input.name.trim(),
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          activeVersionId: null,
          draftRevision: 0,
          draft: { schemaVersion: PLAN_SCHEMA_VERSION, baseVersionId: null, config, evidenceBindings: [], dirty: true, updatedAt: timestamp },
          metadata: clone(input.metadata ?? {}),
        };
        assertValidBuildPlan(plan);
        this.assertSemanticConfig(plan.draft.config);
        await this.atomicWrite(this.planFile(planId), "plan", plan);
        return { value: clone(plan), result: { kind: "plan" as const, planId } };
      },
    ));
    });
  }

  async updateDraft(planId: string, input: UpdateDraftInput<TConfig>): Promise<BuildPlan<TConfig>> {
    return this.publicBoundary(true, (repository) => repository.updateDraft(planId, input), async () => this.serialize(planId, () => this.idempotent(
      `updateDraft:${planId}`,
      input.idempotencyKey,
      input[PLAN_IDEMPOTENCY_REQUEST] ?? input,
      async () => {
        const plan = await this.readPlan(planId, false);
        if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
        assertExpectedRevision(input.expectedRevision, plan.draftRevision);
        const timestamp = this.now();
        const config = clone(input.config);
        if (config.schemaVersion !== plan.draft.config.schemaVersion) {
          throw new PlanRepositoryError("invalid_input", plan.draft.config.schemaVersion === "2.0.0"
            ? "Use migrateDraftToV3 for an explicit V2 to V3 transition"
            : "A V3-backed plan cannot be rewritten as V2", 409);
        }
        const name = input.name?.trim() || plan.name;
        if (!name || name.length > 120) throw new PlanRepositoryError("invalid_input", "Plan name must contain 1 to 120 characters", 400);
        config.id = planId;
        config.name = name;
        config.updatedAt = timestamp;
        const updated: BuildPlan<TConfig> = {
          ...plan,
          name,
          ...(input.metadata ? { metadata: clone(input.metadata) } : {}),
          updatedAt: timestamp,
          draftRevision: plan.draftRevision + 1,
          draft: { ...plan.draft, config, dirty: true, updatedAt: timestamp },
        };
        assertValidBuildPlan(updated);
        this.assertSemanticConfig(updated.draft.config);
        await this.atomicWrite(this.planFile(planId), "plan", updated);
        return { value: clone(updated), result: { kind: "plan" as const, planId } };
      },
    )));
  }

  async migrateDraftToV3(planId: string, input: MigrateDraftToV3Input): Promise<BuildPlan<BuildConfigDocument>> {
    return this.publicBoundary(true, (repository) => repository.migrateDraftToV3(planId, input), async () => this.serialize(planId, () => this.idempotent(
      `migrateDraftToV3:${planId}`,
      input.idempotencyKey,
      input[PLAN_IDEMPOTENCY_REQUEST] ?? input,
      async () => {
        if (!this.topologyV3Enabled) throw new PlanRepositoryError("invalid_input", `BuildConfig V3 is disabled; enable ${TOPOLOGY_V3_FEATURE_FLAG}`, 409);
        const plan = await this.readPlan(planId, false) as BuildPlan<BuildConfigDocument>;
        if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
        assertExpectedRevision(input.expectedRevision, plan.draftRevision);
        if (plan.draft.config.schemaVersion !== "2.0.0") throw new PlanRepositoryError("invalid_input", "Only a V2 draft can be migrated to V3", 409);
        this.assertSemanticConfig(plan.draft.config);

        const sourceConfig = clone(plan.draft.config);
        const sourceConfigHash = await hashPlanConfig(sourceConfig);
        const versions = await this.readAllVersions(planId);
        let sourceVersion = plan.draft.baseVersionId
          ? versions.find((version) => version.id === plan.draft.baseVersionId && version.config.schemaVersion === "2.0.0" && version.configHash === sourceConfigHash)
          : undefined;
        sourceVersion ??= [...versions].reverse().find((version) => (
          version.reason === "migration-source" && version.config.schemaVersion === "2.0.0" && version.configHash === sourceConfigHash
        ));
        if (!sourceVersion) {
          const sourceVersionId = this.id("version");
          sourceVersion = await createImmutablePlanVersion({
            id: sourceVersionId,
            planId,
            versionNumber: versions.reduce((maximum, version) => Math.max(maximum, version.versionNumber), 0) + 1,
            createdAt: this.now(),
            reason: "migration-source",
            summary: "Immutable V2 source retained for BuildConfig V3 migration",
            config: sourceConfig,
            evidenceBindings: plan.draft.evidenceBindings ?? [],
            parentVersionId: plan.activeVersionId,
          });
          await this.atomicWrite(this.versionFile(planId, sourceVersionId), "version", sourceVersion);
        }
        if (sourceVersion.config.schemaVersion !== "2.0.0") throw new PlanRepositoryError("corrupt_data", "Migration source version is not V2", 500);

        const sourceBytes = serializeConfig(sourceVersion.config);
        const sourceHash = await sha256String(sourceBytes);
        const result = await migrateBuildConfigV2ToV3(sourceVersion.config, {
          sourceBytes,
          sourceHash,
          ...(input.catalogBinding ? { catalogBinding: input.catalogBinding } : { catalog: this.getCatalog() }),
        });
        let migratedConfig = input.operations?.length
          ? applyPlanV3ProposalOperations(result.config, input.operations, this.now())
          : result.config;
        if (input.confirmedRequirementFieldIds?.length) {
          const confirmable = new Set(confirmableRequirementFieldIds(input.operations ?? []));
          if (new Set(input.confirmedRequirementFieldIds).size !== input.confirmedRequirementFieldIds.length
            || input.confirmedRequirementFieldIds.some((id) => !confirmable.has(id))) {
            throw new PlanRepositoryError("invalid_input", "Requirement confirmation is outside the reviewed migration edit", 409);
          }
          migratedConfig = applyRequirementConfirmations(migratedConfig, input.confirmedRequirementFieldIds);
        }
        this.assertSemanticConfig(migratedConfig);
        const migratedName = migratedConfig.name.trim();
        if (!migratedName || migratedName.length > 120) throw new PlanRepositoryError("invalid_input", "Plan name must contain 1 to 120 characters", 400);
        const migratedAt = this.now();
        const updated: BuildPlan<BuildConfigDocument> = {
          ...plan,
          name: migratedName,
          ...(input.metadata ? { metadata: clone(input.metadata) } : {}),
          activeVersionId: sourceVersion.id,
          updatedAt: migratedAt,
          draftRevision: plan.draftRevision + 1,
          draft: {
            ...plan.draft,
            baseVersionId: sourceVersion.id,
            config: migratedConfig,
            configMigration: {
              schemaVersion: "plan-config-migration-v1",
              sourceSchemaVersion: "2.0.0",
              targetSchemaVersion: "3.0.0",
              sourceVersionId: sourceVersion.id,
              sourceConfigHash: sourceVersion.configHash,
              migratedAt,
              catalogBinding: clone(result.catalogBinding),
              diff: clone(result.diff),
              warnings: clone(result.warnings),
              rollbackRef: clone(result.rollbackRef),
            },
            dirty: true,
            updatedAt: migratedAt,
          },
        };
        assertValidBuildPlan(updated);
        await this.assertMigrationClosure(updated);
        await this.atomicWrite(this.planFile(planId), "plan", updated);
        return { value: clone(updated), result: { kind: "plan" as const, planId } };
      },
    )));
  }

  async updateInfo(planId: string, input: UpdatePlanInfoInput): Promise<BuildPlan<TConfig>> {
    return this.publicBoundary(true, (repository) => repository.updateInfo(planId, input), async () => this.serialize(planId, async () => {
      const plan = await this.readPlan(planId, false);
      if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
      assertExpectedRevision(input.expectedRevision, plan.draftRevision);
      const name = input.name.trim();
      if (!name || name.length > 120) throw new PlanRepositoryError("invalid_input", "Plan name must contain 1 to 120 characters", 400);
      const timestamp = this.now();
      const config = clone(plan.draft.config);
      config.name = name;
      config.updatedAt = timestamp;
      const updated: BuildPlan<TConfig> = {
        ...plan,
        name,
        ...(input.metadata ? { metadata: clone(input.metadata) } : {}),
        updatedAt: timestamp,
        draftRevision: plan.draftRevision + 1,
        draft: { ...plan.draft, config, dirty: true, updatedAt: timestamp },
      };
      if (input.description !== undefined) {
        if (input.description.trim()) updated.description = input.description.trim();
        else delete updated.description;
      }
      assertValidBuildPlan(updated);
      await this.atomicWrite(this.planFile(planId), "plan", updated);
      return clone(updated);
    }));
  }

  async saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion<TConfig>> {
    return this.publicBoundary(true, (repository) => repository.saveVersion(planId, input), async () => this.serialize(planId, () => this.idempotent(
      `saveVersion:${planId}`,
      input.idempotencyKey,
      input,
      async () => {
        const plan = await this.readPlan(planId, false);
        if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
        assertExpectedRevision(input.expectedRevision, plan.draftRevision);
        this.assertSemanticConfig(plan.draft.config);
        const actualHash = await hashPlanConfig(plan.draft.config);
        assertExpectedConfigHash(input.expectedConfigHash, actualHash);
        const versions = await this.listVersions(planId);
        const versionId = this.id("version");
        const version = await createImmutablePlanVersion({
          id: versionId,
          planId,
          versionNumber: versions.length + 1,
          createdAt: this.now(),
          reason: input.reason,
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.evaluationHash ? { evaluationHash: input.evaluationHash } : {}),
          ...(input.evaluatedAt ? { evaluatedAt: input.evaluatedAt } : {}),
          config: plan.draft.config,
          evidenceBindings: plan.draft.evidenceBindings ?? [],
          parentVersionId: plan.activeVersionId,
        });
        await this.atomicWrite(this.versionFile(planId, versionId), "version", version);
        const updated: BuildPlan<TConfig> = {
          ...plan,
          activeVersionId: versionId,
          updatedAt: version.createdAt,
          draft: { ...plan.draft, baseVersionId: versionId, dirty: false, updatedAt: version.createdAt },
        };
        await this.atomicWrite(this.planFile(planId), "plan", updated);
        return { value: version, result: { kind: "version" as const, planId, versionId } };
      },
    )));
  }

  async duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan<TConfig>> {
    return this.publicBoundary(true, (repository) => repository.duplicate(planId, input), async () => {
    if (!input.name.trim()) throw new PlanRepositoryError("invalid_input", "Plan name is required", 400);
    return this.serialize(`duplicate:${planId}`, () => this.idempotent(
      `duplicate:${planId}`,
      input.idempotencyKey,
      input,
      async () => {
        const source = await this.readPlan(planId, false);
        let created = await this.create({ name: input.name, config: source.draft.config, metadata: clone(source.metadata) });
        const copiedBindingsById = new Map<PlanEvidenceBinding["id"], PlanEvidenceBinding>();
        for (const binding of source.draft.evidenceBindings ?? []) {
          const { id: _sourceBindingId, planId: _sourcePlanId, planVersionId: _sourceVersionId, ...reference } = binding;
          const copiedBase = {
            ...clone(reference),
            planId: created.id,
          };
          const copied = {
            ...copiedBase,
            id: this.evidenceBindingId(copiedBase),
          } satisfies PlanEvidenceBinding;
          copiedBindingsById.set(copied.id, copied);
        }
        const copiedBindings = [...copiedBindingsById.values()];
        if (copiedBindings.length) {
          created = { ...created, draft: { ...created.draft, evidenceBindings: copiedBindings } };
          assertValidBuildPlan(created);
          await this.atomicWrite(this.planFile(created.id), "plan", created);
        }
        const hash = await hashPlanConfig(created.draft.config);
        await this.saveVersion(created.id, { expectedRevision: created.draftRevision, expectedConfigHash: hash, reason: "initial" });
        const saved = await this.get(created.id);
        return { value: saved, result: { kind: "plan" as const, planId: saved.id } };
      },
    ));
    });
  }

  async listEvidenceBindings(planId: string): Promise<PlanEvidenceBinding[]> {
    return this.publicBoundary(false, (repository) => repository.listEvidenceBindings(planId), async () => {
      const plan = await this.readPlan(planId);
      return clone(plan.draft.evidenceBindings ?? []);
    });
  }

  async bindEvidence(planId: string, input: BindPlanEvidenceInput): Promise<PlanEvidenceBinding> {
    return this.publicBoundary(true, (repository) => repository.bindEvidence(planId, input), async () => this.serialize(planId, () => this.idempotent(
      `bindEvidence:${planId}`,
      input.idempotencyKey,
      input,
      async () => {
        const plan = await this.readPlan(planId, false);
        if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
        const document = await this.resolveEvidenceDocument(input.documentId, input.contentHash);
        if (input.captureId) await this.resolveEvidenceCapture(input.captureId, document.id);
        if (input.subject.kind === "plan" && input.subject.id !== planId) {
          throw new PlanRepositoryError("invalid_input", "Plan evidence subject must reference the active plan", 400);
        }
        const timestamp = this.now();
        const bindingBase = {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          planId,
          documentId: document.id,
          contentHash: document.sha256,
          ...(input.captureId ? { captureId: input.captureId } : {}),
          subject: clone(input.subject),
          purposes: clone(input.purposes),
          ...(input.locators ? { locators: clone(input.locators) } : {}),
          boundAt: timestamp,
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        };
        const binding: PlanEvidenceBinding = {
          ...bindingBase,
          id: this.evidenceBindingId(bindingBase),
        };
        const errors = validatePlanEvidenceBinding(binding);
        if (errors.length) throw new PlanRepositoryError("invalid_input", `Invalid evidence binding: ${errors.join("; ")}`, 400);
        const existing = (plan.draft.evidenceBindings ?? []).find((candidate) => this.evidenceBindingId(candidate) === binding.id);
        if (existing) return { value: clone(existing), result: { kind: "evidence-binding" as const, planId, bindingId: existing.id } };
        assertExpectedRevision(input.expectedRevision, plan.draftRevision);
        const updated: BuildPlan<TConfig> = {
          ...plan,
          updatedAt: timestamp,
          draftRevision: plan.draftRevision + 1,
          draft: {
            ...plan.draft,
            evidenceBindings: [...(plan.draft.evidenceBindings ?? []), binding],
            dirty: true,
            updatedAt: timestamp,
          },
        };
        assertValidBuildPlan(updated);
        await this.atomicWrite(this.planFile(planId), "plan", updated);
        return { value: clone(binding), result: { kind: "evidence-binding" as const, planId, bindingId: binding.id } };
      },
    )));
  }

  async unbindEvidence(planId: string, input: UnbindPlanEvidenceInput): Promise<void> {
    return this.publicBoundary(true, (repository) => repository.unbindEvidence(planId, input), async () => {
    await this.serialize(planId, () => this.idempotent(
      `unbindEvidence:${planId}`,
      input.idempotencyKey,
      input,
      async () => {
        const plan = await this.readPlan(planId, false);
        if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
        assertExpectedRevision(input.expectedRevision, plan.draftRevision);
        const bindings = plan.draft.evidenceBindings ?? [];
        if (!bindings.some((binding) => binding.id === input.bindingId)) {
          throw new PlanRepositoryError("not_found", "Plan evidence binding was not found", 404);
        }
        const timestamp = this.now();
        const updated: BuildPlan<TConfig> = {
          ...plan,
          updatedAt: timestamp,
          draftRevision: plan.draftRevision + 1,
          draft: {
            ...plan.draft,
            evidenceBindings: bindings.filter((binding) => binding.id !== input.bindingId),
            dirty: true,
            updatedAt: timestamp,
          },
        };
        assertValidBuildPlan(updated);
        await this.atomicWrite(this.planFile(planId), "plan", updated);
        return { value: undefined, result: { kind: "void" as const, planId } };
      },
    ));
    });
  }

  async archive(planId: string): Promise<void> {
    return this.publicBoundary(true, (repository) => repository.archive(planId), async () => {
    await this.serialize(planId, async () => {
      const plan = await this.readPlan(planId, false);
      if (plan.status === "archived") return;
      await this.atomicWrite(this.planFile(planId), "plan", { ...plan, status: "archived", updatedAt: this.now() });
    });
    });
  }

  async restore(planId: string): Promise<void> {
    return this.publicBoundary(true, (repository) => repository.restore(planId), async () => {
    await this.serialize(planId, async () => {
      const plan = await this.readPlan(planId, false);
      if (plan.status === "active") return;
      await this.atomicWrite(this.planFile(planId), "plan", { ...plan, status: "active", updatedAt: this.now() });
    });
    });
  }

  async delete(planId: string): Promise<void> {
    return this.publicBoundary(true, (repository) => repository.delete(planId), async () => {
    await this.serialize(planId, async () => {
      await this.readPlan(planId, false);
      const target = path.join(this.root, ".trash", `${planId}-${this.now().replace(/[^0-9]/g, "")}`);
      await ensurePrivateDirectory(path.dirname(target));
      const manifestFile = confined(this.root, ".rollback", "manifest.json");
      const manifest = await readFile(manifestFile, "utf8").then((raw) => JSON.parse(raw)).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? { schemaVersion: "plan-rollback-manifest-v1", entries: [] } : Promise.reject(error));
      const eventId = randomUUID();
      const entry = { eventId, operation: "trash-plan", target: path.relative(this.root, this.planDirectory(planId)), backup: path.relative(this.root, target), previousHash: checksum(await this.readPlan(planId, false)), nextHash: null, status: "moving", createdAt: this.now() };
      await atomicWriteJson(manifestFile, { ...manifest, entries: [...(manifest.entries ?? []), entry] });
      await rename(this.planDirectory(planId), target);
      await this.syncDirectory(this.root);
      await this.syncDirectory(path.dirname(target));
      await atomicWriteJson(manifestFile, { ...manifest, entries: [...(manifest.entries ?? []), { ...entry, status: "moved", movedAt: this.now() }] });
    });
    });
  }

  async listVersions(planId: string): Promise<PlanVersion<TConfig>[]> {
    return this.publicBoundary(false, (repository) => repository.listVersions(planId), async () => {
    const plan = await this.readPlan(planId);
    if (plan.draft.configAccess) return [await this.readVersion(planId, plan.draft.configAccess.sourceVersionId) as PlanVersion<TConfig>];
    return await this.readAllVersions(planId) as PlanVersion<TConfig>[];
    });
  }
}

export function repositoryErrorResponse(error: unknown): { status: number; payload: { error: string; message: string } } {
  if (error instanceof PlanConflictError) return { status: error.status, payload: { error: error.code, message: error.message } };
  if (error instanceof PlanRepositoryError) return { status: error.status, payload: { error: error.code, message: error.message } };
  return { status: 500, payload: { error: "internal_error", message: error instanceof Error ? error.message : "Workspace request failed" } };
}
