import { PLAN_SCHEMA_VERSION, type PlanTransactionLink } from "./contracts";
import { parseConfig, type ConfigV2 } from "../config/types";
import { legacyCanonicalize, sha256Hex } from "../hash";
import { V3_RESOLVED_CATALOG_KIND_MATCHERS } from "../config/v3-catalog-runtime.mjs";
import type { SkuCatalog } from "../sku/types";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";
import { validateBuildConfigV3 } from "../topology/validation";

export const LEGACY_PROGRESS_KEY = "build-sim.progress.v1";
export const LEGACY_PROGRESS_BACKUP_KEY = "build-sim.progress.v1.backup";
export const LEGACY_PROGRESS_MIGRATION_KEY = "build-sim.progress.v1.migrated";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LegacyProgressMigrationItem {
  legacyItemId: string;
  snapshot: Record<string, unknown>;
  transactionLink: PlanTransactionLink | null;
}

export interface LegacyProgressMigrationResult {
  migrated: boolean;
  items: LegacyProgressMigrationItem[];
  error?: "invalid_json" | "invalid_shape";
}

export function migrateLegacyProgress(storage: KeyValueStorage): LegacyProgressMigrationResult {
  const existing = storage.getItem(LEGACY_PROGRESS_MIGRATION_KEY);
  if (existing) {
    try { return JSON.parse(existing) as LegacyProgressMigrationResult; } catch { /* re-run from backup */ }
  }
  const raw = storage.getItem(LEGACY_PROGRESS_KEY) ?? storage.getItem(LEGACY_PROGRESS_BACKUP_KEY);
  if (!raw) {
    const result: LegacyProgressMigrationResult = { migrated: false, items: [] };
    storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
    return result;
  }
  storage.setItem(LEGACY_PROGRESS_BACKUP_KEY, raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const result: LegacyProgressMigrationResult = { migrated: false, items: [], error: "invalid_json" };
    storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
    return result;
  }
  const candidate = parsed as { schemaVersion?: unknown; items?: unknown };
  if (candidate.schemaVersion !== 1 || !candidate.items || typeof candidate.items !== "object" || Array.isArray(candidate.items)) {
    const result: LegacyProgressMigrationResult = { migrated: false, items: [], error: "invalid_shape" };
    storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
    return result;
  }
  const items = Object.entries(candidate.items as Record<string, unknown>)
    .filter(([, item]) => item !== null && typeof item === "object" && !Array.isArray(item))
    .map(([legacyItemId, item]) => {
      const snapshot = structuredClone(item as Record<string, unknown>);
      const hasTransaction = snapshot.transaction !== null && typeof snapshot.transaction === "object";
      return {
        legacyItemId,
        snapshot,
        transactionLink: hasTransaction ? {
          schemaVersion: PLAN_SCHEMA_VERSION,
          planId: null,
          planVersionIdAtCapture: null,
          planItemId: null,
          linkStatus: "unlinked" as const,
        } : null,
      };
    });
  const result: LegacyProgressMigrationResult = { migrated: true, items };
  storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
  return result;
}

export interface BuildConfigV3MigrationDiff {
  sourcePath: string;
  targetPath: string | null;
  operation: "mapped" | "expanded" | "omitted";
  before: unknown;
  after: unknown;
}

export interface BuildConfigV3MigrationWarning {
  code:
    | "owned_mapped_to_ordered"
    | "legacy_purchase_bucket_mapped_to_planned"
    | "nvme_identity_unresolved"
    | "fan_identity_unresolved"
    | "disk_identity_missing"
    | "cooler_kind_unresolved"
    | "legacy_hba_not_migrated"
    | "legacy_bom_item_not_migrated"
    | "legacy_topology_not_migrated";
  sourcePath: string;
  message: string;
}

export interface BuildConfigV2RollbackRef {
  schemaVersion: "build-config-v2-rollback-ref-v1";
  configId: string;
  sourceSchemaVersion: "2.0.0";
  sourceHash: string;
  sourceByteLength: number;
}

export interface BuildConfigV3MigrationCatalogBinding {
  schemaVersion: "build-config-v3-migration-catalog-binding-v1";
  rulesetId: "v2-to-v3-governed-component-kind-v1";
  catalog: {
    /** Content address of the exact catalog object supplied to this migration. */
    contentHash: string;
    schemaVersion: string;
    catalogVersion: string | null;
    updatedAt: string;
  };
  /** The complete governed catalog projection consumed by the V2 migration. */
  cooler: {
    skuId: string;
    catalogSkuId: string | null;
    category: string | null;
    type: string | null;
  };
  /** Content address of every field above; excludes only this hash field. */
  bindingHash: string;
}

export interface BuildConfigV3MigrationResult {
  config: BuildConfigV3;
  diff: BuildConfigV3MigrationDiff[];
  warnings: BuildConfigV3MigrationWarning[];
  rollbackRef: BuildConfigV2RollbackRef;
  catalogBinding: BuildConfigV3MigrationCatalogBinding;
  source: { schemaVersion: "2.0.0"; sourceHash: string; sourceBytes: string };
}

export interface BuildConfigV3MigrationOptions {
  /** Hash issued for the immutable V2 bytes by the plan repository. */
  sourceHash: string;
  /** Exact bytes retained by the V2 plan version; migration never rewrites them. */
  sourceBytes: string;
  /** Exact governed catalog used to create a new immutable input binding. */
  catalog?: SkuCatalog;
  /** Existing immutable input binding used to replay a historical migration. */
  catalogBinding?: BuildConfigV3MigrationCatalogBinding;
}

function normalizeBindingText(value: string): string {
  return value.normalize("NFC");
}

export function migrationCatalogBindingMaterial(binding: Omit<BuildConfigV3MigrationCatalogBinding, "bindingHash">): Omit<BuildConfigV3MigrationCatalogBinding, "bindingHash"> {
  return {
    schemaVersion: binding.schemaVersion,
    rulesetId: binding.rulesetId,
    catalog: { ...binding.catalog },
    cooler: { ...binding.cooler },
  };
}

async function migrationBindingHash(binding: Omit<BuildConfigV3MigrationCatalogBinding, "bindingHash">): Promise<string> {
  return sha256Hex(legacyCanonicalize(migrationCatalogBindingMaterial(binding)));
}

export async function createBuildConfigV3MigrationCatalogBinding(
  catalog: SkuCatalog,
  coolerSkuId: string,
): Promise<BuildConfigV3MigrationCatalogBinding> {
  const exactCatalog = structuredClone(catalog);
  const coolerSku = exactCatalog.skus.find((sku) => sku.id === coolerSkuId);
  const material: Omit<BuildConfigV3MigrationCatalogBinding, "bindingHash"> = {
    schemaVersion: "build-config-v3-migration-catalog-binding-v1",
    rulesetId: "v2-to-v3-governed-component-kind-v1",
    catalog: {
      contentHash: await sha256Hex(legacyCanonicalize(exactCatalog)),
      schemaVersion: normalizeBindingText(exactCatalog.schemaVersion),
      catalogVersion: typeof exactCatalog.catalogVersion === "string" ? normalizeBindingText(exactCatalog.catalogVersion) : null,
      updatedAt: normalizeBindingText(exactCatalog.updatedAt),
    },
    cooler: {
      skuId: normalizeBindingText(coolerSkuId),
      catalogSkuId: coolerSku ? normalizeBindingText(coolerSku.id) : null,
      category: coolerSku && typeof coolerSku.category === "string" ? normalizeBindingText(coolerSku.category) : null,
      type: coolerSku && typeof coolerSku.attrs?.type === "string" ? normalizeBindingText(coolerSku.attrs.type) : null,
    },
  };
  return { ...material, bindingHash: await migrationBindingHash(material) };
}

async function assertMigrationCatalogBinding(
  binding: BuildConfigV3MigrationCatalogBinding,
  coolerSkuId: string,
): Promise<BuildConfigV3MigrationCatalogBinding> {
  if (binding.schemaVersion !== "build-config-v3-migration-catalog-binding-v1"
    || binding.rulesetId !== "v2-to-v3-governed-component-kind-v1"
    || binding.cooler.skuId !== coolerSkuId
    || binding.cooler.skuId !== binding.cooler.skuId.normalize("NFC")
    || binding.catalog.schemaVersion !== binding.catalog.schemaVersion.normalize("NFC")
    || binding.catalog.updatedAt !== binding.catalog.updatedAt.normalize("NFC")
    || (binding.catalog.catalogVersion !== null && binding.catalog.catalogVersion !== binding.catalog.catalogVersion.normalize("NFC"))
    || (binding.cooler.catalogSkuId !== null && binding.cooler.catalogSkuId !== binding.cooler.catalogSkuId.normalize("NFC"))
    || (binding.cooler.category !== null && binding.cooler.category !== binding.cooler.category.normalize("NFC"))
    || (binding.cooler.type !== null && binding.cooler.type !== binding.cooler.type.normalize("NFC"))
    || !/^[a-f0-9]{64}$/.test(binding.catalog.contentHash)
    || !/^[a-f0-9]{64}$/.test(binding.bindingHash)
    || await migrationBindingHash(migrationCatalogBindingMaterial(binding)) !== binding.bindingHash) {
    throw new Error("BuildConfig V2 migration catalog binding is invalid");
  }
  if ((binding.cooler.catalogSkuId === null) !== (binding.cooler.category === null)) {
    throw new Error("BuildConfig V2 migration catalog binding cooler projection is invalid");
  }
  return structuredClone(binding);
}

function coolerKindFromMigrationBinding(binding: BuildConfigV3MigrationCatalogBinding): "aio" | "cpu_cooler" | null {
  const projectedSku = binding.cooler.catalogSkuId === null ? undefined : {
    id: binding.cooler.catalogSkuId,
    category: binding.cooler.category,
    attrs: { type: binding.cooler.type },
  };
  return projectedSku && V3_RESOLVED_CATALOG_KIND_MATCHERS.aio(projectedSku) ? "aio"
    : projectedSku && V3_RESOLVED_CATALOG_KIND_MATCHERS.cpu_cooler(projectedSku) ? "cpu_cooler" : null;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function migrationClaim(sourceHash: string, sourcePath: string): string {
  return `migration:v2:${sourceHash}:${sourcePath.replace(/^\//, "")}`;
}

async function migrationStableId(
  prefix: "migci" | "migrd" | "migrole",
  sourceHash: string,
  sourcePath: string,
  ordinal = 1,
): Promise<string> {
  const digest = await sha256Hex(`build-sim:v2-migration:${sourceHash}:${sourcePath}:${ordinal}`);
  return `${prefix}-${digest}`;
}

function v3Timestamp(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error("BuildConfig V2 updatedAt cannot be represented as a V3 timestamp");
  return new Date(parsed).toISOString();
}

/**
 * Pure V2 -> V3 projection. It never updates the V2 object/bytes and does not
 * infer requirements, wiring, firmware, system, HBA, logical layout, or tools.
 */
export async function migrateBuildConfigV2ToV3(
  source: ConfigV2,
  options: BuildConfigV3MigrationOptions,
): Promise<BuildConfigV3MigrationResult> {
  if (source.schemaVersion !== "2.0.0") throw new Error("BuildConfig V2 migration requires schemaVersion 2.0.0");
  if (!/^[a-f0-9]{64}$/.test(options.sourceHash)) throw new Error("BuildConfig V2 migration requires a SHA-256 sourceHash");
  if (await sha256Hex(options.sourceBytes) !== options.sourceHash) throw new Error("BuildConfig V2 migration sourceHash does not match the exact source bytes");
  const parsedSource = parseConfig(options.sourceBytes, { topologyV3Enabled: false });
  if (JSON.stringify(parsedSource) !== JSON.stringify(source)) throw new Error("BuildConfig V2 migration source bytes do not match the supplied config");

  if ((options.catalog === undefined) === (options.catalogBinding === undefined)) {
    throw new Error("BuildConfig V2 migration requires exactly one explicit catalog or immutable catalogBinding");
  }
  const sourceSnapshot = structuredClone(source);
  const catalogBinding = options.catalog
    ? await createBuildConfigV3MigrationCatalogBinding(options.catalog, source.selection.coolerId)
    : await assertMigrationCatalogBinding(options.catalogBinding!, source.selection.coolerId);
  const migratedUpdatedAt = v3Timestamp(source.updatedAt);
  const components: ComponentInstance[] = [];
  const diff: BuildConfigV3MigrationDiff[] = source.updatedAt === migratedUpdatedAt ? [] : [{
    sourcePath: "/updatedAt", targetPath: "/updatedAt", operation: "mapped", before: source.updatedAt, after: migratedUpdatedAt,
  }];
  const warnings: BuildConfigV3MigrationWarning[] = [];
  const migratedSkuIds = new Set<string>();
  const stateWarningKeys = new Set<string>();
  const bomBySku = new Map<string, ConfigV2["bom"]>();
  const bomInstanceCursor = new Map<string, number>();
  for (const line of source.bom) bomBySku.set(line.skuId, [...(bomBySku.get(line.skuId) ?? []), line]);

  let ownedMapped = false;
  const stateForSku = (skuId: string, sourcePath: string): ComponentInstance["state"] => {
    const lines = bomBySku.get(skuId) ?? [];
    const instanceOrdinal = bomInstanceCursor.get(skuId) ?? 0;
    bomInstanceCursor.set(skuId, instanceOrdinal + 1);
    const ownedQuantity = lines
      .filter((line) => line.bucket === "owned")
      .reduce((total, line) => total + line.qty, 0);
    if (instanceOrdinal < ownedQuantity) {
      ownedMapped = true;
      const key = `owned\0${sourcePath}\0${skuId}`;
      if (!stateWarningKeys.has(key)) {
        warnings.push({
          code: "owned_mapped_to_ordered",
          sourcePath,
          message: `Legacy owned state for ${skuId} became ordered; possession, installation, and health remain unknown.`,
        });
        stateWarningKeys.add(key);
      }
      return "ordered";
    }
    if (lines.length > 0) {
      const key = `planned\0${sourcePath}\0${skuId}`;
      if (!stateWarningKeys.has(key)) {
        warnings.push({
          code: "legacy_purchase_bucket_mapped_to_planned",
          sourcePath,
          message: `Legacy purchase state for ${skuId} instance ${instanceOrdinal + 1} became planned; only ${ownedQuantity} explicitly owned unit(s) may become ordered.`,
        });
        stateWarningKeys.add(key);
      }
    }
    return "planned";
  };

  const addResolved = async (input: { kind: ComponentInstance["kind"]; role: string; skuId: string; sourcePath: string; ordinal?: number }) => {
    if (!input.skuId) return;
    const ordinal = input.ordinal ?? 1;
    const component: ComponentInstance = {
      instanceId: await migrationStableId("migci", options.sourceHash, input.sourcePath, ordinal),
      kind: input.kind,
      role: input.role,
      state: stateForSku(input.skuId, input.sourcePath),
      identity: { status: "resolved", skuId: input.skuId, identityClaimIds: [migrationClaim(options.sourceHash, input.sourcePath)] },
      source: "migration",
    };
    components.push(component);
    migratedSkuIds.add(input.skuId);
    diff.push({ sourcePath: input.sourcePath, targetPath: `/components/${components.length - 1}`, operation: "mapped", before: input.skuId, after: component });
  };

  await addResolved({ kind: "case", role: "case", skuId: source.caseId, sourcePath: "/caseId" });
  await addResolved({ kind: "motherboard", role: "motherboard", skuId: source.boardId, sourcePath: "/boardId" });
  await addResolved({ kind: "cpu", role: "cpu", skuId: source.cpuId, sourcePath: "/cpuId" });
  await addResolved({ kind: "psu", role: "primary_psu", skuId: source.selection.psuId, sourcePath: "/selection/psuId" });
  if (source.selection.secondaryPsuId) await addResolved({ kind: "psu", role: "secondary_psu", skuId: source.selection.secondaryPsuId, sourcePath: "/selection/secondaryPsuId" });
  const coolerKind = coolerKindFromMigrationBinding(catalogBinding);
  if (coolerKind) {
    await addResolved({ kind: coolerKind, role: "cpu_cooler", skuId: source.selection.coolerId, sourcePath: "/selection/coolerId" });
  } else {
    warnings.push({
      code: "cooler_kind_unresolved",
      sourcePath: "/selection/coolerId",
      message: `Legacy cooler ${source.selection.coolerId} was not migrated because the governed catalog does not prove AIO or CPU cooler kind.`,
    });
    diff.push({ sourcePath: "/selection/coolerId", targetPath: null, operation: "omitted", before: source.selection.coolerId, after: null });
  }
  await addResolved({ kind: "memory_module", role: "system_memory", skuId: source.selection.memoryId, sourcePath: "/selection/memoryId" });

  const roleDecisions: BuildConfigV3["roleDecisions"] = [];
  if (source.selection.gpuId === "gpu.none") {
    const decision = {
      roleDecisionId: await migrationStableId("migrd", options.sourceHash, "/selection/gpuId"),
      role: "discrete_gpu",
      decision: "not_needed" as const,
      source: "migration" as const,
      confirmedAt: migratedUpdatedAt,
    };
    roleDecisions.push(decision);
    diff.push({ sourcePath: "/selection/gpuId", targetPath: "/roleDecisions/0", operation: "mapped", before: source.selection.gpuId, after: decision });
  } else {
    await addResolved({ kind: "gpu", role: "discrete_gpu", skuId: source.selection.gpuId, sourcePath: "/selection/gpuId" });
  }

  if (source.selection.diskCount > 0 && source.selection.diskSkuId) {
    for (let index = 1; index <= source.selection.diskCount; index += 1) {
      await addResolved({ kind: "storage_drive", role: "data_disk", skuId: source.selection.diskSkuId, sourcePath: "/selection/diskSkuId", ordinal: index });
    }
    diff.push({
      sourcePath: "/selection/diskCount",
      targetPath: "/components",
      operation: "expanded",
      before: source.selection.diskCount,
      after: components.filter((component) => component.role === "data_disk").map((component) => component.instanceId),
    });
  } else if (source.selection.diskCount > 0) {
    warnings.push({ code: "disk_identity_missing", sourcePath: "/selection/diskCount", message: "Legacy diskCount had no diskSkuId; no SATA disk identity was invented." });
    diff.push({ sourcePath: "/selection/diskCount", targetPath: null, operation: "omitted", before: source.selection.diskCount, after: null });
  }

  for (let index = 1; index <= (source.selection.nvmeCount ?? 0); index += 1) {
    const component: ComponentInstance = {
      instanceId: await migrationStableId("migci", options.sourceHash, "/selection/nvmeCount", index),
      kind: "storage_drive",
      role: "nvme_storage",
      state: "planned",
      identity: { status: "unresolved", userText: `Legacy config recorded NVMe drive ${index} of ${source.selection.nvmeCount}; no SKU was recorded.` },
      source: "migration",
    };
    components.push(component);
  }
  if ((source.selection.nvmeCount ?? 0) > 0) {
    warnings.push({ code: "nvme_identity_unresolved", sourcePath: "/selection/nvmeCount", message: "NVMe count was preserved as unresolved instances; no Samsung 980 PRO or other SKU was inferred." });
    diff.push({ sourcePath: "/selection/nvmeCount", targetPath: "/components", operation: "expanded", before: source.selection.nvmeCount, after: components.filter((component) => component.role === "nvme_storage").map((component) => component.instanceId) });
  }

  for (const [groupIndex, group] of (source.selection.fanGroups ?? []).entries()) {
    const groupSourcePath = `/selection/fanGroups/${groupIndex}`;
    const role = await migrationStableId("migrole", options.sourceHash, groupSourcePath);
    for (let index = 1; index <= group.count; index += 1) {
      components.push({
        instanceId: await migrationStableId("migci", options.sourceHash, groupSourcePath, index),
        kind: "case_fan",
        role,
        state: "planned",
        identity: { status: "unresolved", userText: `Legacy config requested ${group.sizeMm}mm case fan ${index} of ${group.count} at mount ${group.mountId}; no fan SKU was recorded.` },
        source: "migration",
      });
    }
    warnings.push({ code: "fan_identity_unresolved", sourcePath: groupSourcePath, message: `Fan group ${group.mountId} was preserved as unresolved ${group.sizeMm}mm fan requirements.` });
  }
  if ((source.selection.fanGroups?.length ?? 0) > 0) diff.push({ sourcePath: "/selection/fanGroups", targetPath: "/components", operation: "expanded", before: source.selection.fanGroups, after: components.filter((component) => component.kind === "case_fan").map((component) => component.instanceId) });

  if (source.selection.hbaSkuId || source.selection.hbaMode === "always") {
    warnings.push({ code: "legacy_hba_not_migrated", sourcePath: "/selection/hbaSkuId", message: "Legacy HBA policy/SKU was not promoted into topology because controller need and identity require explicit V3 review." });
    diff.push({ sourcePath: "/selection/hbaSkuId", targetPath: null, operation: "omitted", before: source.selection.hbaSkuId ?? null, after: null });
  }
  if (source.selection.psuTopology !== "auto" || source.selection.dualStart) {
    warnings.push({ code: "legacy_topology_not_migrated", sourcePath: "/selection/psuTopology", message: "Legacy PSU placement/start policy was not converted into placement or connection edges." });
  }
  for (const [index, line] of source.bom.entries()) {
    if (migratedSkuIds.has(line.skuId) || line.skuId === source.selection.hbaSkuId) continue;
    warnings.push({ code: "legacy_bom_item_not_migrated", sourcePath: `/bom/${index}`, message: `Legacy BOM row ${line.skuId} was outside the explicit V2 component mapping and was not invented as V3 topology.` });
    diff.push({ sourcePath: `/bom/${index}`, targetPath: null, operation: "omitted", before: line, after: null });
  }

  const migrationNote = "[migration] Legacy owned BOM entries were mapped to ordered; receipt, possession, installation, and hardware health were not inferred.";
  const config: BuildConfigV3 = {
    schemaVersion: "3.0.0",
    id: source.id,
    name: source.name,
    updatedAt: migratedUpdatedAt,
    intent: null,
    requirementSpec: null,
    system: null,
    components,
    roleDecisions,
    placements: [],
    connections: [],
    logicalLayouts: [],
    firmwareTargets: [],
    ...((source.notes?.length || ownedMapped) ? { notes: [...(source.notes ?? []), ...(ownedMapped ? [migrationNote] : [])] } : {}),
  };
  const validationErrors = validateBuildConfigV3(config);
  if (validationErrors.length > 0) throw new Error(`Migrated BuildConfigV3 is invalid: ${validationErrors.join("; ")}`);
  if (JSON.stringify(source) !== JSON.stringify(sourceSnapshot)) throw new Error("BuildConfig V2 migration mutated its source");

  return {
    config,
    diff,
    warnings,
    rollbackRef: {
      schemaVersion: "build-config-v2-rollback-ref-v1",
      configId: source.id,
      sourceSchemaVersion: "2.0.0",
      sourceHash: options.sourceHash,
      sourceByteLength: utf8Length(options.sourceBytes),
    },
    catalogBinding,
    source: { schemaVersion: "2.0.0", sourceHash: options.sourceHash, sourceBytes: options.sourceBytes },
  };
}
