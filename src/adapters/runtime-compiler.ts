import type { BuildConfig, BuildLineItem, CaseFanGroupSelection } from "../config/types";
import type { PlacedPart } from "../core/geometry";
import type { PhysicalEvaluation } from "../core/physical";
import { PHYSICAL_RULESET_VERSION } from "../core/physical";
import type { CalibrationEvaluation } from "../core/calibration";
import type { SkuCatalog } from "../sku/types";
import type { WiringPlan } from "../wiring/types";
import { verifyCaseAdapterManifest, type CaseAdapterManifest } from "./contracts";
import type { CaseAdapterProjection } from "./data-driven-case";
import type {
  CaseRuntimeAdapter,
  CaseRuntimeDomain,
  CaseRuntimeDomainMap,
  CaseRuntimeEnvironmentInput,
  CaseRuntimeFans,
} from "./runtime";
import { caseAdapterSpatialProjectionHash } from "./spatial-projection";
import { verifyCaseRuntimeModel, type CaseRuntimeModel } from "./runtime-model";
import { createDeclarativeCaseRuntime } from "./declarative-case/runtime";
import { createPrimitiveCaseRuntime } from "./declarative-case/primitive-runtime";
import { asValidatedPrimitiveCaseDocuments, isPrimitiveCaseRuntimeDocuments } from "./runtime-model-schema";

const BLOCKED_DOMAINS: Record<Exclude<CaseRuntimeDomain, "electronics">, string[]> = {
  geometry: ["mount-pose-unavailable", "usable-volume-unavailable"],
  wiring: ["electrical-topology-unavailable"],
  routing: ["routing-zone-closure-unavailable", "mount-port-attachment-unavailable"],
  assembly: ["mount-pose-unavailable", "install-sweep-unavailable"],
  thermal: ["thermal-zone-model-unavailable", "component-pose-unavailable"],
  calibration: ["case-calibration-snapshot-unavailable"],
};

function domains(): CaseRuntimeDomainMap {
  return {
    electronics: { status: "ready", reasonCodes: [] },
    geometry: { status: "blocked", reasonCodes: [...BLOCKED_DOMAINS.geometry] },
    wiring: { status: "blocked", reasonCodes: [...BLOCKED_DOMAINS.wiring] },
    routing: { status: "blocked", reasonCodes: [...BLOCKED_DOMAINS.routing] },
    assembly: { status: "blocked", reasonCodes: [...BLOCKED_DOMAINS.assembly] },
    thermal: { status: "blocked", reasonCodes: [...BLOCKED_DOMAINS.thermal] },
    calibration: { status: "blocked", reasonCodes: [...BLOCKED_DOMAINS.calibration] },
  };
}

type RuntimeProjectionSource = CaseAdapterProjection | CaseAdapterManifest;

function facetValue(source: RuntimeProjectionSource, facetId: string): unknown {
  return source.schemaVersion === "case-adapter-projection-v1"
    ? source.capabilityRecord.facets.find((facet) => facet.facetId === facetId)?.value
    : undefined;
}

function finiteFacet(source: RuntimeProjectionSource, facetId: string): number | null {
  const value = facetValue(source, facetId);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function fanSizes(standardIds: readonly string[]): (120 | 140)[] {
  const sizes = standardIds.flatMap((standardId) => standardId.endsWith(".120") ? [120 as const] : standardId.endsWith(".140") ? [140 as const] : []);
  return [...new Set(sizes)];
}

function blockedWiring(config: BuildConfig): WiringPlan {
  return {
    caseId: config.caseId,
    bayPaths: [],
    backplanePower: [],
    backplaneHarness: {
      feedPsuId: config.selection.psuId,
      feedRole: "main",
      inlets: 0,
      required: { sata: 0, molex: 0 },
      confirmed: { sata: null, molex: null },
      connectors: { sata: null, molex: null },
      uniquePeripheralLeads: null,
      oneLeadPerInlet: false,
      daisyChainOnly: false,
      peripheralSockets: null,
      socketLimited: false,
      spinUp: {
        diskCount: config.selection.diskCount,
        perDiskA: null,
        totalA: null,
        perInletA: null,
        perSharedLeadA: null,
        leadLimitW: null,
        evidence: "unknown",
        notes: ["机箱 adapter 未提供闭合的电气拓扑，接线域保持 blocked。"],
      },
      verdict: "unknown",
      evidence: "unknown",
      notes: ["机箱 adapter 未提供闭合的电气拓扑，未借用其他机箱的背板或线束。"],
    },
    checklist: [],
    warnings: ["case-runtime.blocked:wiring"],
  };
}

function genericBom(config: BuildConfig, catalog: SkuCatalog): BuildLineItem[] {
  const items: BuildLineItem[] = [
    { skuId: config.caseId, qty: 1, bucket: "owned" },
    { skuId: config.boardId, qty: 1, bucket: "owned" },
    { skuId: config.cpuId, qty: 1, bucket: "owned" },
    { skuId: config.selection.psuId, qty: 1, bucket: "buy_now" },
    { skuId: config.selection.coolerId, qty: 1, bucket: "buy_now" },
    { skuId: config.selection.memoryId, qty: 1, bucket: "buy_now" },
  ];
  if (config.selection.gpuId !== "gpu.none") items.push({ skuId: config.selection.gpuId, qty: 1, bucket: "upgrade_later" });
  if (config.selection.diskCount > 0 && config.selection.diskSkuId) items.push({ skuId: config.selection.diskSkuId, qty: config.selection.diskCount, bucket: "buy_now" });
  if (config.selection.hbaSkuId) items.push({ skuId: config.selection.hbaSkuId, qty: 1, bucket: "buy_now" });
  if (config.selection.secondaryPsuId) items.push({ skuId: config.selection.secondaryPsuId, qty: 1, bucket: "optional" });
  const merged = new Map(items.map((item) => [item.skuId, item]));
  for (const item of config.bom) merged.set(item.skuId, item);
  const result = [...merged.values()];
  for (const item of result) {
    if (!catalog.skus.some((sku) => sku.id === item.skuId)) throw new TypeError(`explicit BOM SKU is not in the evaluated catalog: ${item.skuId}`);
  }
  return result;
}

function blockedPhysical(config: BuildConfig, manifestHash: string): PhysicalEvaluation {
  return {
    schemaVersion: "1.0.0",
    rulesetVersion: PHYSICAL_RULESET_VERSION,
    hash: `blocked-${manifestHash}`,
    provenance: [manifestHash, ...BLOCKED_DOMAINS.geometry, ...BLOCKED_DOMAINS.routing],
    plugSweeps: [],
    bendRadius: [],
    slotWidth: { gpuSlots: null, hbaSlots: 0, totalSlots: 0, evidence: "unknown" },
    lane: { nvmeCount: config.selection.nvmeCount ?? 0, m2Slots: 0, slimSasClaimed: false, hbaPresent: false, evidence: "unknown" },
    serviceSpace: { minimumInsertionMm: null, blockedPorts: [], evidence: "unknown" },
    findings: [],
  };
}

function blockedCalibration(config: BuildConfig, manifestHash: string): CalibrationEvaluation {
  return {
    snapshot: {
      schemaVersion: "1.0.0",
      calibrationVersion: "unavailable",
      caseId: config.caseId,
      source: "case runtime calibration domain blocked",
      provenance: [manifestHash],
      wallPowerW: { value: null, evidence: "unknown", unit: "W" },
      smartTemperatureC: { value: null, evidence: "unknown", unit: "°C" },
      cpuTemperatureC: { value: null, evidence: "unknown", unit: "°C" },
      gpuTemperatureC: { value: null, evidence: "unknown", unit: "°C" },
      noiseDba: { value: null, evidence: "unknown", unit: "dBA" },
      fanCurve: { mode: null, rpm: null, cfm: null, evidence: "unknown" },
    },
    unknown: ["wallPowerW", "smartTemperatureC", "cpuTemperatureC", "gpuTemperatureC", "noiseDba", "fanCurve"],
    provenance: [manifestHash],
    narrowedRanges: {},
    hash: `blocked-${manifestHash}`,
  };
}

/**
 * Compile a governed projection into an honest partial runtime. The current
 * manifest proves envelope, symbolic mounts and provisional zones, but it does
 * not prove per-component pose or route closure. Those domains stay blocked.
 */
async function compilePartialCaseRuntime(
  manifest: CaseAdapterManifest,
  source: RuntimeProjectionSource,
  options: { projectionHash?: string } = {},
  requireFrozenProjection = false,
): Promise<CaseRuntimeAdapter> {
  if (source.schemaVersion === "case-adapter-projection-v1") {
    if (requireFrozenProjection && !Object.isFrozen(source)) throw new TypeError("case runtime compiler requires an authority-issued frozen projection");
    if (manifest.contentHash !== source.manifestHash || manifest.adapterId !== source.adapterId
      || manifest.adapterVersion !== source.adapterVersion || manifest.identity.skuId !== source.capabilityRecord.subjectSkuId) {
      throw new TypeError("case runtime projection does not close the exact manifest identity/hash");
    }
  } else if (source !== manifest) {
    throw new TypeError("case runtime manifest compiler requires the exact verified locked manifest");
  }
  if (options.projectionHash !== undefined && !/^[a-f0-9]{64}$/.test(options.projectionHash)) {
    throw new TypeError("case runtime projectionHash invalid");
  }
  const projectionHash = await caseAdapterSpatialProjectionHash(source);
  if (options.projectionHash !== undefined && options.projectionHash !== projectionHash) {
    throw new TypeError("case runtime projectionHash does not match the canonical spatial projection");
  }
  const driveCount = source.mounts.filter((mount) => mount.kind === "drive").reduce((sum, mount) => sum + mount.quantity, 0);
  const fanMounts = source.mounts.filter((mount) => mount.kind === "fan").flatMap((mount) => {
    const supportedSizes = fanSizes(mount.standardIds);
    if (supportedSizes.length === 0) return [];
    const size = supportedSizes[0]!;
    return [{
      id: mount.mountId,
      label: mount.location,
      size,
      count: mount.quantity,
      supportedSizes,
      maxCountBySize: Object.fromEntries(supportedSizes.map((entry) => [entry, mount.quantity])),
      direction: "intake" as const,
      chamber: "upper" as const,
      evidence: mount.binding.status === "verified" ? "official" as const : "inferred" as const,
      source: manifest.sourceRefs.join(","),
    }];
  });
  const effectiveFanSelections = (config: BuildConfig): CaseFanGroupSelection[] => (config.selection.fanGroups ?? []).filter((selection) => {
    const mount = fanMounts.find((entry) => entry.id === selection.mountId);
    return Boolean(mount?.supportedSizes.includes(selection.sizeMm) && selection.count > 0 && selection.count <= (mount.maxCountBySize[selection.sizeMm] ?? 0));
  });
  const envelope = source.geometry.envelope;
  const shell: PlacedPart = {
    id: envelope.nodeId,
    name: manifest.identity.skuId,
    kind: "chassis",
    box: { c: [...envelope.centerMm], w: envelope.sizeMm[0], h: envelope.sizeMm[1], d: envelope.sizeMm[2] },
    sizeEvidence: envelope.binding.status === "verified" ? "official" : "inferred",
    anchorEvidence: envelope.binding.status === "verified" ? "official" : "inferred",
    dimsLabel: `${envelope.sizeMm.join("×")}mm · adapter envelope only`,
    skuId: manifest.identity.skuId,
  };
  const adapter: CaseRuntimeAdapter = {
    schemaVersion: "case-runtime-adapter-v1",
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    authorityStatus: null,
    identity: {
      skuId: manifest.identity.skuId,
      region: manifest.identity.region,
      revision: manifest.identity.revision,
      manifestHash: manifest.contentHash,
      projectionHash,
    },
    domains: domains(),
    capabilities: {
      caseId: manifest.identity.skuId,
      trayCount: driveCount,
      backplane: { sataPowerInlets: 0, molexInlets: 0, evidence: "unknown" },
      fanMounts,
      psuLimits: { atxMaxLengthMm: null, sfxMaxLengthMm: null },
      coolerLimits: { overheadAtxMm: finiteFacet(source, "case.cpu_cooler_max_height"), openTopMm: null },
      gpuLimits: { planningMinMm: finiteFacet(source, "case.gpu_max_length"), publishedMaxMm: finiteFacet(source, "case.gpu_max_length") },
    },
    powerProfile: {
      boardBaseW: null, fanBaseW: null, fan120W: null, fan140W: null, dualSyncW: null,
      cpuIdleW: null, cpuReadW: null, cpuQuickSyncW: null, hbaW: null, driveSpinUpExtraW: null,
      evidence: "unknown", source: `${manifest.adapterId}@${manifest.adapterVersion}`,
    },
    defaults: { ownedNvmeQty: 0 },
    effectiveFanSelections,
    configuredFanGroups: () => ({}),
    geometryEnvironment: (input) => input,
    buildGeometry: (_config, _catalog, environment) => {
      const part = structuredClone(shell);
      const overrides = (environment as CaseRuntimeEnvironmentInput | undefined)?.instanceOverrides?.overrides ?? [];
      for (const override of overrides) {
        if (override.targetKind !== "envelope") continue;
        if (override.property === "width") part.box.w = override.value;
        else if (override.property === "height") part.box.h = override.value;
        else if (override.property === "depth") part.box.d = override.value;
      }
      part.dimsLabel = `${part.box.w}×${part.box.h}×${part.box.d}mm · adapter envelope plus plan-scoped overrides`;
      return [part];
    },
    buildOccupancy: (config) => ({ caseId: config.caseId, slots: [], occupants: [] }),
    planWiring: blockedWiring,
    deriveBom: genericBom,
    buildRouting: () => ({ cables: [], ports: [], findings: [] }),
    buildAssembly: () => ({ steps: [], constraints: [], findings: [] }),
    domainFindings: () => Object.entries(BLOCKED_DOMAINS).map(([domain, reasonCodes]) => ({
      id: `case-runtime.blocked:${domain}`,
      verdict: "warn" as const,
      evidence: "unknown" as const,
      message: `当前机箱 ${domain} 域被 adapter 阻断：${reasonCodes.join(", ")}`,
      related: [manifest.identity.skuId, manifest.contentHash],
    })),
    conflictMarkerParts: () => [],
    evaluatePhysical: (config) => blockedPhysical(config, manifest.contentHash),
    evaluateCalibration: (config) => blockedCalibration(config, manifest.contentHash),
    psuInLowerChamber: () => false,
    thermalFans: (_config, fans: CaseRuntimeFans) => fans,
  };
  return Object.freeze(adapter);
}

/** Compile an authority-issued fact projection, retaining resolved capability values. */
export async function compileCaseAdapterProjectionRuntime(
  manifest: CaseAdapterManifest,
  projection: CaseAdapterProjection,
  options: { projectionHash?: string } = {},
): Promise<CaseRuntimeAdapter> {
  return compilePartialCaseRuntime(manifest, projection, options, true);
}

/**
 * Hydrate the manifest bytes persisted in a verified adapter artifact. A
 * manifest contains governed envelope/mount declarations but not resolved fact
 * values, so capability limits remain null and the affected domains stay
 * blocked instead of borrowing fixture or case-specific data.
 */
export async function compileLockedCaseAdapterManifestRuntime(
  manifest: CaseAdapterManifest,
  options: { projectionHash?: string } = {},
): Promise<CaseRuntimeAdapter> {
  if (!await verifyCaseAdapterManifest(manifest)) throw new TypeError("case runtime locked manifest integrity invalid");
  return compilePartialCaseRuntime(manifest, manifest, options);
}

/**
 * Hydrate a replay-locked manifest plus its exact declarative model bytes. The
 * ready path is intentionally separate from the honest manifest-only partial
 * compiler, so missing runtime evidence can never be mistaken for executable
 * geometry or wiring.
 */
export async function compileLockedCaseAdapterRuntime(
  manifest: CaseAdapterManifest,
  model: CaseRuntimeModel,
  options: { projectionHash?: string } = {},
): Promise<CaseRuntimeAdapter> {
  if (!await verifyCaseRuntimeModel(manifest, model)) throw new TypeError("case runtime locked declarative model integrity invalid");
  if (options.projectionHash !== undefined && !/^[a-f0-9]{64}$/.test(options.projectionHash)) {
    throw new TypeError("case runtime projectionHash invalid");
  }
  const projectionHash = await caseAdapterSpatialProjectionHash(manifest);
  if (options.projectionHash !== undefined && options.projectionHash !== projectionHash) {
    throw new TypeError("case runtime projectionHash does not match the canonical spatial projection");
  }
  return isPrimitiveCaseRuntimeDocuments(model.documents)
    ? createPrimitiveCaseRuntime(manifest, model, asValidatedPrimitiveCaseDocuments(model.documents), projectionHash)
    : createDeclarativeCaseRuntime(manifest, model, projectionHash).adapter;
}
