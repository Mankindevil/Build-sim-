import type { AssemblyPlan } from "../core/assembly";
import type { EngineFinding } from "../core/engine";
import type { PlacedPart } from "../core/geometry";
import type { ConflictHit, OccupancyModel } from "../core/occupancy";
import type { Port, RoutedCable } from "../core/routing";
import type { BuildConfig, BuildLineItem, CaseFanGroupSelection } from "../config/types";
import type { SkuCatalog } from "../sku/types";
import type { WiringPlan } from "../wiring/types";
import type { CaseCapabilities, PowerProfile, ThermalProfile } from "../core/capabilities";
import type { PhysicalEvaluation } from "../core/physical";
import type { CalibrationEvaluation } from "../core/calibration";
import type { CaseInstanceOverrides } from "./instance-overrides";
import { compareCanonical, isPortableId } from "../capabilities/validation";

export interface CaseRuntimeFanGroup {
  size: 120 | 140;
  count: number;
}

export interface CaseRuntimeFans {
  front?: CaseRuntimeFanGroup | null;
  rear?: CaseRuntimeFanGroup | null;
  left?: CaseRuntimeFanGroup | null;
  right?: CaseRuntimeFanGroup | null;
}

export interface CaseRuntimeGpuOverride {
  name: string;
  lengthMm: number;
  slots: number;
  workstation?: boolean;
}

/**
 * Evaluator-owned inputs. An adapter translates these into its private geometry
 * environment; the core never names a case-specific mount or coordinate.
 */
export interface CaseRuntimeEnvironmentInput {
  fans: CaseRuntimeFans;
  reserveHbaSlot?: boolean;
  gpuOverride?: CaseRuntimeGpuOverride | null;
  instanceOverrides?: Readonly<CaseInstanceOverrides>;
}

export interface CaseRuntimeRouting {
  cables: RoutedCable[];
  ports: Port[];
  findings: EngineFinding[];
}

export interface CaseRuntimeDefaults {
  diskSkuId?: string;
  bootBaySkuId?: string;
  ownedNvmeSkuId?: string;
  ownedNvmeQty: number;
  hbaSkuId?: string;
  hbaBreakoutSkuId?: string;
  slimsasCableSkuId?: string;
  dualSyncSkuId?: string;
  secondaryPsuSkuId?: string;
}

export interface CaseRuntimeLowerChamberPolicy {
  fanMountId: string;
  unavailableWithPsuTopologies: readonly BuildConfig["selection"]["psuTopology"][];
  effectDescription: string;
}

export type CaseRuntimeDomain = "electronics" | "geometry" | "wiring" | "routing" | "assembly" | "thermal" | "calibration";

export interface CaseRuntimeDomainAvailability {
  status: "ready" | "blocked";
  reasonCodes: string[];
}

export type CaseRuntimeDomainMap = Record<CaseRuntimeDomain, CaseRuntimeDomainAvailability>;

export interface CaseRuntimeResolution {
  schemaVersion: "case-runtime-resolution-v1";
  /** Interpreter/domain executability only; never a safety-pass signal. */
  status: "ready" | "partial" | "blocked";
  /** Safety conclusions require a fully ready, per-field governed runtime. */
  safetyStatus: "eligible" | "unknown";
  adapterId: string | null;
  adapterVersion: string | null;
  authorityStatus: "legacy_unverified" | "governed_fact_derivation_bound" | null;
  manifestHash: string | null;
  projectionHash: string | null;
  spatialHash: string | null;
  identity: { skuId: string; region: string; revision: string } | null;
  domains: CaseRuntimeDomainMap;
}

export interface CaseRuntimeLookupIdentity {
  skuId: string;
  region: string;
  revision: string;
}

function runtimeIdentityKey(identity: CaseRuntimeLookupIdentity): string {
  if (![identity.skuId, identity.region, identity.revision].every(isPortableId)) throw new TypeError("case runtime lookup identity invalid");
  return `${identity.skuId}\0${identity.region}\0${identity.revision}`;
}

/**
 * Synchronous, deterministic case runtime. The exact adapter bytes are locked
 * by the manifest/ArtifactLockfile layer before this projection is registered.
 * This contract deliberately has no generic fallback implementation.
 */
export interface CaseRuntimeAdapter {
  schemaVersion: "case-runtime-adapter-v1";
  adapterId: string;
  adapterVersion: string;
  /** Executability is separate from evidence authority. */
  authorityStatus: "legacy_unverified" | "governed_fact_derivation_bound" | null;
  identity: {
    skuId: string;
    region: string;
    revision: string;
    manifestHash: string;
    projectionHash: string;
  };
  domains: CaseRuntimeDomainMap;
  capabilities: CaseCapabilities;
  powerProfile: PowerProfile;
  thermalProfile?: ThermalProfile;
  defaults: CaseRuntimeDefaults;
  thermalDeckY?: number;
  lowerChamberPolicy?: CaseRuntimeLowerChamberPolicy;
  effectiveFanSelections(config: BuildConfig, catalog?: SkuCatalog): CaseFanGroupSelection[];
  configuredFanGroups(config: BuildConfig, catalog?: SkuCatalog): CaseRuntimeFans;
  geometryEnvironment(input: CaseRuntimeEnvironmentInput): unknown;
  buildGeometry(config: BuildConfig, catalog: SkuCatalog, environment: unknown): PlacedPart[];
  buildOccupancy(config: BuildConfig, catalog: SkuCatalog, environment: unknown): OccupancyModel;
  planWiring(config: BuildConfig, catalog: SkuCatalog): WiringPlan;
  deriveBom(config: BuildConfig, catalog: SkuCatalog): BuildLineItem[];
  buildRouting(parts: PlacedPart[], plan: WiringPlan, catalog: SkuCatalog): CaseRuntimeRouting;
  buildAssembly(parts: PlacedPart[], cables: RoutedCable[]): AssemblyPlan;
  domainFindings(config: BuildConfig, catalog: SkuCatalog): EngineFinding[];
  conflictMarkerParts(parts: PlacedPart[], conflicts: ConflictHit[]): PlacedPart[];
  evaluatePhysical(config: BuildConfig, catalog: SkuCatalog, geometry: PlacedPart[], routing: CaseRuntimeRouting, wiring: WiringPlan): PhysicalEvaluation;
  evaluateCalibration(config: BuildConfig): CalibrationEvaluation;
  psuInLowerChamber(config: BuildConfig): boolean;
  thermalFans(config: BuildConfig, fans: CaseRuntimeFans): CaseRuntimeFans;
}

function assertRuntimeAdapter(adapter: CaseRuntimeAdapter): void {
  if (!adapter || adapter.schemaVersion !== "case-runtime-adapter-v1") throw new TypeError("case runtime adapter schemaVersion invalid");
  if (![adapter.adapterId, adapter.adapterVersion, adapter.identity?.skuId, adapter.identity?.region, adapter.identity?.revision]
    .every(isPortableId)) throw new TypeError("case runtime adapter identity invalid");
  if (!/^[a-f0-9]{64}$/.test(adapter.identity.manifestHash)) throw new TypeError("case runtime adapter manifestHash invalid");
  if (!/^[a-f0-9]{64}$/.test(adapter.identity.projectionHash)) throw new TypeError("case runtime adapter projectionHash invalid");
  if (adapter.authorityStatus !== null && adapter.authorityStatus !== "legacy_unverified"
    && adapter.authorityStatus !== "governed_fact_derivation_bound") throw new TypeError("case runtime adapter authorityStatus invalid");
  // v1 has no field-path -> fact/derivation bindings. Aggregate references can
  // be borrowed from an unrelated valid fact, so even a caller-constructed
  // executable must not opt itself into safety eligibility.
  if (adapter.authorityStatus === "governed_fact_derivation_bound") {
    throw new TypeError("governed case runtime adapters require per-field authority bindings unavailable in v1");
  }
  if (adapter.capabilities?.caseId !== adapter.identity.skuId) throw new TypeError("case runtime adapter capability identity mismatch");
  if (adapter.domains?.thermal?.status === "ready"
    && (!Number.isFinite(adapter.thermalDeckY) || !adapter.thermalProfile)) {
    throw new TypeError("case runtime adapter thermal profile/deck invalid");
  }
  if (!Number.isSafeInteger(adapter.defaults?.ownedNvmeQty) || adapter.defaults.ownedNvmeQty < 0) {
    throw new TypeError("case runtime adapter NVMe default invalid");
  }
  const methods: (keyof CaseRuntimeAdapter)[] = [
    "effectiveFanSelections", "configuredFanGroups", "geometryEnvironment", "buildGeometry", "buildOccupancy", "planWiring",
    "deriveBom", "buildRouting", "buildAssembly", "domainFindings", "conflictMarkerParts",
    "evaluatePhysical", "evaluateCalibration", "psuInLowerChamber", "thermalFans",
  ];
  if (methods.some((method) => typeof adapter[method] !== "function")) throw new TypeError("case runtime adapter method missing");
}

/** Registry instances are caller-scoped, so tests and what-if runs never mutate process defaults. */
export class CaseRuntimeAdapterRegistry {
  private readonly adapters = new Map<string, CaseRuntimeAdapter>();
  private readonly keysBySku = new Map<string, Set<string>>();

  static create(adapters: readonly CaseRuntimeAdapter[] = []): CaseRuntimeAdapterRegistry {
    const registry = new CaseRuntimeAdapterRegistry();
    for (const adapter of adapters) registry.register(adapter);
    return registry;
  }

  register(adapter: CaseRuntimeAdapter): void {
    assertRuntimeAdapter(adapter);
    const key = runtimeIdentityKey(adapter.identity);
    if (this.adapters.has(key)) throw new Error(`case runtime adapter already registered: ${key.replaceAll("\0", "@")}`);
    this.adapters.set(key, adapter);
    const skuKeys = this.keysBySku.get(adapter.identity.skuId) ?? new Set<string>();
    skuKeys.add(key);
    this.keysBySku.set(adapter.identity.skuId, skuKeys);
  }

  resolveExact(identity: CaseRuntimeLookupIdentity): CaseRuntimeAdapter | null {
    try { return this.adapters.get(runtimeIdentityKey(identity)) ?? null; }
    catch { return null; }
  }

  /** V2-only seam. It fails closed as soon as one SKU has multiple region/revision variants. */
  resolveLegacySku(caseSkuId: string): CaseRuntimeAdapter | null {
    if (!isPortableId(caseSkuId)) return null;
    const keys = [...(this.keysBySku.get(caseSkuId) ?? [])];
    return keys.length === 1 ? this.adapters.get(keys[0]!) ?? null : null;
  }

  list(): CaseRuntimeAdapter[] {
    return [...this.adapters.entries()].sort(([left], [right]) => compareCanonical(left, right)).map(([, adapter]) => adapter);
  }
}

/** Application bootstrap target. Case implementation modules register explicitly. */
export const DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY = CaseRuntimeAdapterRegistry.create();

export function registerBuiltInCaseRuntimeAdapter(adapter: CaseRuntimeAdapter): void {
  DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY.register(adapter);
}

const ALL_DOMAINS: CaseRuntimeDomain[] = ["electronics", "geometry", "wiring", "routing", "assembly", "thermal", "calibration"];

export function caseRuntimeResolution(adapter: CaseRuntimeAdapter | null, caseSkuId: string, spatialHash: string | null = null): CaseRuntimeResolution {
  if (!adapter) {
    const domains = Object.fromEntries(ALL_DOMAINS.map((domain) => [domain, { status: "blocked", reasonCodes: ["case-adapter-unavailable"] }])) as CaseRuntimeDomainMap;
    return { schemaVersion: "case-runtime-resolution-v1", status: "blocked", safetyStatus: "unknown", adapterId: null, adapterVersion: null, authorityStatus: null, manifestHash: null, projectionHash: null, spatialHash, identity: null, domains };
  }
  const domains = structuredClone(adapter.domains);
  const ready = Object.values(domains).filter((domain) => domain.status === "ready").length;
  const status = ready === ALL_DOMAINS.length ? "ready" : ready === 0 ? "blocked" : "partial";
  return {
    schemaVersion: "case-runtime-resolution-v1",
    status,
    safetyStatus: status === "ready" && adapter.authorityStatus === "governed_fact_derivation_bound" ? "eligible" : "unknown",
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    authorityStatus: adapter.authorityStatus,
    manifestHash: adapter.identity.manifestHash,
    projectionHash: adapter.identity.projectionHash,
    spatialHash,
    identity: { skuId: caseSkuId, region: adapter.identity.region, revision: adapter.identity.revision },
    domains,
  };
}
