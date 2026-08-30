import type { BuildConfig, BuildLineItem, CaseFanGroupSelection } from "../../config/types";
import type { SkuCatalog, SkuRecord } from "../../sku/types";
import type { CenteredBox, PlacedPart, Vec3 } from "../../core/geometry";
import { chamberOf, toBoxMm } from "../../core/geometry";
import type { OccupancyModel, Occupant, ConflictHit } from "../../core/occupancy";
import { buildAssembly, type DeclaredRule, type InstallTravelDecl, type PreinstalledDecl } from "../../core/assembly";
import { evaluatePhysicalConstraints } from "../../core/physical";
import { evaluateCalibration, type CalibrationSnapshot } from "../../core/calibration";
import type { CaseRuntimeAdapter, CaseRuntimeEnvironmentInput, CaseRuntimeFans } from "../runtime";
import type { CaseAdapterManifest } from "../contracts";
import type { CaseRuntimeModel } from "../runtime-model";
import type { ValidatedPrimitiveCaseDocuments, PrimitiveDimension, PrimitiveCount, PrimitiveSkuSelector } from "../runtime-model-schema";
import type { WiringPlan } from "../../wiring/types";

function selectedSkuId(selector: PrimitiveSkuSelector, config: BuildConfig, profile: ValidatedPrimitiveCaseDocuments["profile"]): string | null {
  if (selector === "case") return config.caseId;
  if (selector === "board") return config.boardId;
  if (selector === "cpu") return config.cpuId;
  if (selector === "psu") return config.selection.psuId;
  if (selector === "cooler") return config.selection.coolerId;
  if (selector === "memory") return config.selection.memoryId;
  if (selector === "gpu") return config.selection.gpuId === "gpu.none" ? null : config.selection.gpuId;
  if (selector === "disk") return config.selection.diskSkuId ?? profile.defaults.diskSkuId ?? null;
  if (selector === "nvme") return profile.defaults.ownedNvmeSkuId ?? null;
  if (selector === "hba") return config.selection.hbaSkuId ?? profile.defaults.hbaSkuId ?? null;
  return null;
}

function selectedSku(selector: PrimitiveSkuSelector, config: BuildConfig, profile: ValidatedPrimitiveCaseDocuments["profile"], catalog: SkuCatalog): SkuRecord | null {
  const id = selectedSkuId(selector, config, profile);
  return id ? catalog.skus.find((entry) => entry.id === id) ?? null : null;
}

function countValue(spec: PrimitiveCount | undefined, config: BuildConfig, profile: ValidatedPrimitiveCaseDocuments["profile"], catalog: SkuCatalog): number {
  if (spec === undefined) return 1;
  if (typeof spec === "number") return spec;
  if (spec.source === "selection") {
    const selection = config.selection as unknown as Record<string, unknown>;
    const value = selection[spec.field];
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : spec.fallback;
  }
  const value = selectedSku(spec.selector, config, profile, catalog)?.attrs?.[spec.field];
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : spec.fallback;
}

function dimensionValue(spec: PrimitiveDimension, config: BuildConfig, profile: ValidatedPrimitiveCaseDocuments["profile"], catalog: SkuCatalog): number {
  if (typeof spec === "number") return spec;
  const value = selectedSku(spec.selector, config, profile, catalog)?.dims?.[spec.field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : spec.fallback;
}

function replaceIndex(value: string | undefined, index: number): string | undefined {
  return value?.replaceAll("{index}", String(index + 1));
}

function unionBox(boxes: CenteredBox[]): CenteredBox {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    const size = [box.w, box.h, box.d];
    for (let axis = 0; axis < 3; axis += 1) {
      lo[axis] = Math.min(lo[axis]!, box.c[axis]! - size[axis]! / 2);
      hi[axis] = Math.max(hi[axis]!, box.c[axis]! + size[axis]! / 2);
    }
  }
  return { c: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2], w: hi[0]! - lo[0]!, h: hi[1]! - lo[1]!, d: hi[2]! - lo[2]! };
}

function occupants(parts: PlacedPart[]): Occupant[] {
  const grouped = new Map<string, { occupant: Occupant; boxes: CenteredBox[] }>();
  const occupantIdByPart = new Map<string, string>();
  for (const part of parts) {
    const id = `occ-${(part.slotId ?? part.id).replaceAll(".", "-")}`;
    occupantIdByPart.set(part.id, id);
    const current = grouped.get(id);
    if (current) { current.boxes.push(part.box); continue; }
    grouped.set(id, {
      boxes: [part.box],
      occupant: {
        id,
        skuId: part.skuId ?? part.id,
        label: part.name,
        slotIds: part.slotId ? [part.slotId] : [],
        evidence: part.sizeEvidence,
        anchorEvidence: part.anchorEvidence,
        envelope: toBoxMm(part.box),
        ...(part.group ? { group: part.group } : {}),
        ...(part.mountedOn ? { mountedOn: part.mountedOn } : {}),
      },
    });
  }
  return [...grouped.values()].map(({ occupant, boxes }) => {
    if (boxes.length > 1) occupant.envelope = toBoxMm(unionBox(boxes));
    if (occupant.mountedOn) {
      const parent = occupantIdByPart.get(occupant.mountedOn);
      if (parent && parent !== occupant.id) occupant.mountedOn = parent;
      else delete occupant.mountedOn;
    }
    return occupant;
  });
}

function conflictMarkers(parts: PlacedPart[], conflicts: ConflictHit[]): PlacedPart[] {
  const boxes = new Map(parts.map((part) => [`occ-${(part.slotId ?? part.id).replaceAll(".", "-")}`, part.box]));
  return conflicts.flatMap((hit) => {
    const left = boxes.get(hit.a);
    const right = boxes.get(hit.b);
    if (!left || !right) return [];
    const mins = [0, 1, 2].map((axis) => Math.max(left.c[axis]! - [left.w, left.h, left.d][axis]! / 2, right.c[axis]! - [right.w, right.h, right.d][axis]! / 2));
    const maxs = [0, 1, 2].map((axis) => Math.min(left.c[axis]! + [left.w, left.h, left.d][axis]! / 2, right.c[axis]! + [right.w, right.h, right.d][axis]! / 2));
    if (maxs.some((value, axis) => value <= mins[axis]!)) return [];
    return [{
      id: `conflict.${hit.id}`,
      name: "包络相交",
      kind: "conflict" as const,
      box: { c: [0, 1, 2].map((axis) => (mins[axis]! + maxs[axis]!) / 2) as Vec3, w: maxs[0]! - mins[0]!, h: maxs[1]! - mins[1]!, d: maxs[2]! - mins[2]! },
      sizeEvidence: hit.evidence,
      anchorEvidence: "inferred" as const,
      dimsLabel: `相交 ${hit.overlapMm ?? 0}mm`,
      note: hit.message,
    }];
  });
}

function emptyWiring(config: BuildConfig): WiringPlan {
  return {
    caseId: config.caseId,
    bayPaths: [],
    backplanePower: [],
    backplaneHarness: {
      feedPsuId: config.selection.psuId,
      feedRole: "main",
      inlets: 0,
      required: { sata: 0, molex: 0 },
      confirmed: { sata: 0, molex: 0 },
      connectors: { sata: 0, molex: 0 },
      uniquePeripheralLeads: 0,
      oneLeadPerInlet: false,
      daisyChainOnly: false,
      peripheralSockets: 0,
      socketLimited: false,
      spinUp: { diskCount: config.selection.diskCount, perDiskA: 0, totalA: 0, perInletA: 0, perSharedLeadA: 0, leadLimitW: 0, evidence: "standard", notes: ["该机箱声明没有 case-managed backplane power topology。"] },
      verdict: "ok",
      evidence: "standard",
      notes: ["runtime model 明确声明无 case-managed cable/backplane requirements。"],
    },
    checklist: [],
    warnings: [],
  };
}

function genericBom(config: BuildConfig, profile: ValidatedPrimitiveCaseDocuments["profile"], catalog: SkuCatalog): BuildLineItem[] {
  const items: BuildLineItem[] = [
    { skuId: config.caseId, qty: 1, bucket: "owned" }, { skuId: config.boardId, qty: 1, bucket: "owned" }, { skuId: config.cpuId, qty: 1, bucket: "owned" },
    { skuId: config.selection.psuId, qty: 1, bucket: "buy_now" }, { skuId: config.selection.coolerId, qty: 1, bucket: "buy_now" }, { skuId: config.selection.memoryId, qty: 1, bucket: "buy_now" },
  ];
  if (config.selection.gpuId !== "gpu.none") items.push({ skuId: config.selection.gpuId, qty: 1, bucket: "upgrade_later" });
  const diskId = config.selection.diskSkuId ?? profile.defaults.diskSkuId;
  if (diskId && config.selection.diskCount > 0) items.push({ skuId: diskId, qty: config.selection.diskCount, bucket: "buy_now" });
  const nvmeCount = config.selection.nvmeCount ?? profile.defaults.ownedNvmeQty;
  if (profile.defaults.ownedNvmeSkuId && nvmeCount > 0) items.push({ skuId: profile.defaults.ownedNvmeSkuId, qty: nvmeCount, bucket: "owned" });
  const merged = new Map(items.map((item) => [item.skuId, item]));
  config.bom.forEach((item) => merged.set(item.skuId, item));
  const result = [...merged.values()];
  for (const item of result) if (!catalog.skus.some((sku) => sku.id === item.skuId)) throw new TypeError(`explicit BOM SKU is not in the evaluated catalog: ${item.skuId}`);
  return result;
}

export function createPrimitiveCaseRuntime(
  manifest: CaseAdapterManifest,
  model: CaseRuntimeModel,
  documents: ValidatedPrimitiveCaseDocuments,
  projectionHash: string,
): CaseRuntimeAdapter {
  const { profile, geometry, assembly, calibration } = documents;
  const interior: CenteredBox = { c: [...geometry.interior.centerMm] as Vec3, w: geometry.interior.sizeMm[0], h: geometry.interior.sizeMm[1], d: geometry.interior.sizeMm[2] };
  const effectiveFans = (config: BuildConfig): CaseFanGroupSelection[] => (config.selection.fanGroups ?? []).filter((group) => {
    const mount = profile.capabilities.fanMounts.find((entry) => entry.id === group.mountId);
    return Boolean(mount && mount.supportedSizes.includes(group.sizeMm) && group.count > 0 && group.count <= (mount.maxCountBySize[group.sizeMm] ?? 0));
  });
  const configuredFans = (config: BuildConfig): CaseRuntimeFans => {
    const result: CaseRuntimeFans = {};
    for (const mount of profile.capabilities.fanMounts) {
      const selected = effectiveFans(config).find((group) => group.mountId === mount.id);
      result[mount.geometryRole] = selected ? { size: selected.sizeMm, count: selected.count } : null;
    }
    return result;
  };
  const buildGeometry = (config: BuildConfig, catalog: SkuCatalog, environment: unknown): PlacedPart[] => {
    const env = environment as CaseRuntimeEnvironmentInput;
    const parts: PlacedPart[] = geometry.parts.flatMap((template) => {
      const count = countValue(template.repeat, config, profile, catalog);
      const skuId = template.skuSelector ? selectedSkuId(template.skuSelector, config, profile) : null;
      const sku = template.skuSelector ? selectedSku(template.skuSelector, config, profile, catalog) : null;
      return Array.from({ length: count }, (_, index) => {
        const offset = template.repeatOffsetMm ?? [0, 0, 0];
        const box: CenteredBox = {
          c: template.centerMm.map((value, axis) => value + offset[axis]! * index) as Vec3,
          w: dimensionValue(template.sizeMm[0], config, profile, catalog),
          h: dimensionValue(template.sizeMm[1], config, profile, catalog),
          d: dimensionValue(template.sizeMm[2], config, profile, catalog),
        };
        const id = replaceIndex(template.id, index)!;
        const slotId = template.slotId ? replaceIndex(template.slotId, index) : undefined;
        const mountedOn = template.mountedOn ? replaceIndex(template.mountedOn, index) : undefined;
        return {
          id,
          name: replaceIndex(template.name, index)?.replaceAll("{sku.name}", sku?.name ?? skuId ?? template.name) ?? template.name,
          kind: template.kind,
          box,
          sizeEvidence: template.sizeEvidence,
          anchorEvidence: template.anchorEvidence,
          dimsLabel: template.dimsLabel,
          chamber: template.chamber ?? chamberOf(box, geometry.thermalDeckY),
          ...(skuId ? { skuId } : {}),
          ...(slotId ? { slotId } : {}),
          ...(mountedOn ? { mountedOn } : {}),
          ...(template.group ? { group: template.group } : {}),
          ...(template.thermalId ? { thermalId: template.thermalId } : {}),
        } satisfies PlacedPart;
      });
    });
    for (const override of env.instanceOverrides?.overrides ?? []) {
      if (override.targetKind === "envelope") {
        const part = parts.find((entry) => entry.id === geometry.envelopePartId);
        if (!part) continue;
        if (override.property === "width") part.box.w = override.value;
        if (override.property === "height") part.box.h = override.value;
        if (override.property === "depth") part.box.d = override.value;
        continue;
      }
      const subject = override.subjectRef;
      const partId = subject.kind === "mount" ? geometry.mountPartIds[subject.mountId] : undefined;
      const part = partId ? parts.find((entry) => entry.id === partId) : undefined;
      if (!part) continue;
      if (override.property === "x") part.box.c[0] = override.value;
      if (override.property === "y") part.box.c[1] = override.value;
      if (override.property === "z") part.box.c[2] = override.value;
    }
    return parts;
  };
  const buildOccupancy = (config: BuildConfig, catalog: SkuCatalog, environment: unknown): OccupancyModel => ({
    caseId: config.caseId,
    slots: geometry.slots.map((slot) => ({
      id: slot.id,
      kind: slot.kind,
      box: toBoxMm({ c: [...slot.centerMm] as Vec3, w: slot.sizeMm[0], h: slot.sizeMm[1], d: slot.sizeMm[2] }),
      evidence: slot.evidence,
      ...(slot.exclusiveWith.length ? { exclusiveWith: [...slot.exclusiveWith] } : {}),
    })),
    occupants: occupants(buildGeometry(config, catalog, environment)),
  });
  const adapter: CaseRuntimeAdapter = {
    schemaVersion: "case-runtime-adapter-v1",
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    authorityStatus: model.authorityStatus,
    identity: { skuId: manifest.identity.skuId, region: manifest.identity.region, revision: manifest.identity.revision, manifestHash: manifest.contentHash, projectionHash },
    domains: {
      electronics: { status: "ready", reasonCodes: [] }, geometry: { status: "ready", reasonCodes: [] },
      wiring: { status: "ready", reasonCodes: [] }, routing: { status: "ready", reasonCodes: [] },
      assembly: { status: "ready", reasonCodes: [] }, thermal: { status: "ready", reasonCodes: [] },
      calibration: { status: "ready", reasonCodes: [] },
    },
    capabilities: {
      caseId: manifest.identity.skuId,
      trayCount: profile.capabilities.trayCount,
      backplane: { ...profile.capabilities.backplane },
      fanMounts: profile.capabilities.fanMounts.map(({ geometryRole: _role, ...mount }) => ({ ...mount, maxCountBySize: Object.fromEntries(Object.entries(mount.maxCountBySize).map(([size, count]) => [Number(size), count])) })),
      psuLimits: { ...profile.capabilities.psuLimits }, coolerLimits: { ...profile.capabilities.coolerLimits }, gpuLimits: { ...profile.capabilities.gpuLimits },
    },
    powerProfile: { ...profile.powerProfile },
    thermalProfile: { ...profile.thermalProfile },
    defaults: { ...profile.defaults, ownedNvmeQty: profile.defaults.ownedNvmeQty },
    thermalDeckY: geometry.thermalDeckY,
    effectiveFanSelections: effectiveFans,
    configuredFanGroups: configuredFans,
    geometryEnvironment: (input) => input,
    buildGeometry,
    buildOccupancy,
    planWiring: emptyWiring,
    deriveBom: (config, catalog) => genericBom(config, profile, catalog),
    buildRouting: () => ({ cables: [], ports: [], findings: [] }),
    buildAssembly: (parts, cables) => buildAssembly({ parts, cables, preinstalled: assembly.preinstalled as PreinstalledDecl[], install: assembly.install as InstallTravelDecl[], declared: assembly.declared as DeclaredRule[] }),
    domainFindings: () => [],
    conflictMarkerParts: conflictMarkers,
    evaluatePhysical: (config, catalog, parts, routing, wiring) => evaluatePhysicalConstraints(config, catalog, parts, routing, wiring, { interiorBox: interior, provenance: [...model.sourceRefs] }),
    evaluateCalibration: () => evaluateCalibration(calibration as CalibrationSnapshot),
    psuInLowerChamber: () => false,
    thermalFans: (_config, fans) => fans,
  };
  return Object.freeze(adapter);
}
