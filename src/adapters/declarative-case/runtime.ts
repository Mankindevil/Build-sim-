import {
  buildAssembly,
  type AssemblyPlan,
  type DeclaredRule,
  type InstallTravelDecl,
  type PreinstalledDecl,
} from "../../core/assembly";
import type { PlacedPart } from "../../core/geometry";
import type { RoutedCable } from "../../core/routing";
import type { BuildConfig, BuildLineItem, CaseFanGroupSelection } from "../../config/types";
import type { SkuCatalog } from "../../sku/types";
import { requireSku } from "../../sku/catalog";
import { buildSataPorts, needsHba } from "../../core/policy";
import type {
  CaseRuntimeAdapter,
  CaseRuntimeEnvironmentInput,
  CaseRuntimeFans,
} from "../runtime";
import { createDeclarativeCaseGeometry, type DeclarativeDocument, type GeometryEnv } from "./geometry";
import { createDeclarativeCaseOccupancy } from "./occupancy";
import { createDeclarativeCaseRouting } from "./routing";
import {
  checkBackplaneHarness as checkCaseBackplaneHarness,
  planCaseWiring,
  type CaseWiringProfile,
} from "../../wiring/plan";
import { planPanelWiring } from "../../wiring/panel";
import { evaluatePhysicalConstraints } from "../../core/physical";
import { evaluateCalibration, type CalibrationSnapshot } from "../../core/calibration";
import type { CaseAdapterManifest } from "../contracts";
import type { CaseRuntimeModel } from "../runtime-model";

const evidence = (value: unknown): "official" | "standard" | "inferred" | "unknown" =>
  value === "official" || value === "standard" || value === "inferred" || value === "unknown"
    ? value
    : value === "planning" ? "inferred" : "unknown";

const fanSize = (value: unknown): 120 | 140 => value === 140 ? 140 : 120;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export interface DeclarativeCaseRuntime {
  adapter: CaseRuntimeAdapter;
  wiringProfile: CaseWiringProfile;
  buildAssembly(parts: PlacedPart[], cables: RoutedCable[]): AssemblyPlan;
  checkBackplaneHarness(config: BuildConfig, catalog: SkuCatalog): ReturnType<typeof checkCaseBackplaneHarness>;
  planWiring(config: BuildConfig, catalog: SkuCatalog): ReturnType<typeof planCaseWiring>;
  planPanelWiring(config: BuildConfig, catalog: SkuCatalog): ReturnType<typeof planPanelWiring>;
}

/** Compile verified declarative documents into deterministic case-domain interpreters. */
export function createDeclarativeCaseRuntime(
  manifest: CaseAdapterManifest,
  model: CaseRuntimeModel,
  projectionHash: string,
): DeclarativeCaseRuntime {
  const documents = model.documents as unknown as {
    profile: DeclarativeDocument;
    geometry: DeclarativeDocument;
    routing: DeclarativeDocument;
    assembly: DeclarativeDocument;
    calibration: DeclarativeDocument;
  };
  const { profile, geometry: geometryDocument, routing: routingDocument, assembly, calibration } = documents;
  const geometry = createDeclarativeCaseGeometry(profile, geometryDocument);
  const occupancy = createDeclarativeCaseOccupancy(profile, geometryDocument, geometry);
  const routing = createDeclarativeCaseRouting(routingDocument, profile.trayCount as number);
  const runtimeProfile = profile.runtime as DeclarativeDocument;

  const buildAssemblyPlan = (parts: PlacedPart[], cables: RoutedCable[]): AssemblyPlan => buildAssembly({
    parts,
    cables,
    preinstalled: assembly.preinstalled as PreinstalledDecl[],
    install: assembly.install as InstallTravelDecl[],
    declared: assembly.declared as DeclaredRule[],
  });

  const capabilities: CaseRuntimeAdapter["capabilities"] = {
    caseId: profile.caseId as string,
    trayCount: profile.trayCount as number,
    backplane: {
      sataPowerInlets: profile.backplanePower.connectors.sataPower as number,
      molexInlets: profile.backplanePower.connectors.molex as number,
      evidence: evidence(profile.backplanePower.evidence),
    },
    fanMounts: (runtimeProfile.fanMounts as DeclarativeDocument[]).map((mount) => ({
      id: mount.id as string,
      label: mount.label as string,
      size: fanSize(mount.size),
      count: mount.count as number,
      supportedSizes: [...mount.supportedSizes as (120 | 140)[]],
      maxCountBySize: { ...mount.maxCountBySize as Record<number, number> },
      direction: mount.direction as "intake" | "exhaust",
      chamber: mount.chamber as "upper" | "lower",
      evidence: evidence(mount.evidence),
      source: mount.source as string,
    })),
    psuLimits: {
      atxMaxLengthMm: numberOrNull(profile.psuLimits.atxMaxLengthMm),
      sfxMaxLengthMm: numberOrNull(profile.psuLimits.sfxMaxLengthMm),
    },
    coolerLimits: {
      overheadAtxMm: numberOrNull(profile.coolerLimits.overheadAtxMm),
      openTopMm: numberOrNull(profile.coolerLimits.openTopMm),
    },
    gpuLimits: {
      planningMinMm: numberOrNull(profile.gpuLimits.planningMinMm),
      publishedMaxMm: numberOrNull(profile.gpuLimits.publishedMaxMm),
    },
  };

  const defaults: CaseRuntimeAdapter["defaults"] = {
    diskSkuId: profile.defaults.diskSkuId as string,
    bootBaySkuId: profile.defaults.bootBaySkuId as string,
    ownedNvmeSkuId: profile.defaults.ownedNvmeSkuId as string,
    ownedNvmeQty: profile.defaults.ownedNvmeQty as number,
    hbaSkuId: profile.hba.defaultSkuId as string,
    hbaBreakoutSkuId: profile.defaults.hbaBreakoutSkuId as string,
    slimsasCableSkuId: profile.defaults.slimsasCableSkuId as string,
    dualSyncSkuId: profile.defaults.dualSyncSkuId as string,
    secondaryPsuSkuId: profile.defaults.secondaryPsuSkuId as string,
  };

  const wiringProfile: CaseWiringProfile = {
    trayCount: profile.trayCount as number,
    backplanePower: {
      inlets: profile.backplanePower.inlets as number,
      connectors: {
        sataPower: profile.backplanePower.connectors.sataPower as number,
        molex: profile.backplanePower.connectors.molex as number,
      },
      inletOrder: [...profile.lowerChamber.backplane.inletRowOrder] as Array<"sata" | "molex">,
    },
    defaults: {
      secondaryPsuSkuId: profile.defaults.secondaryPsuSkuId as string,
      bootBaySkuId: profile.defaults.bootBaySkuId as string,
      ownedNvmeQty: profile.defaults.ownedNvmeQty as number,
    },
    hba: { defaultSkuId: profile.hba.defaultSkuId as string },
  };

  const checkHarness = (config: BuildConfig, catalog: SkuCatalog) => checkCaseBackplaneHarness(config, catalog, wiringProfile);
  const planWiring = (config: BuildConfig, catalog: SkuCatalog) => planCaseWiring(config, catalog, wiringProfile);
  const planPanel = (config: BuildConfig, catalog: SkuCatalog) => planPanelWiring(config, catalog, wiringProfile);

  const isSfx = (psuId: string, catalog: SkuCatalog): boolean => {
    try { return requireSku(catalog, psuId).attrs?.form === "SFX"; }
    catch { return false; }
  };

  const excludedFanMount = (mountId: string, config: BuildConfig, catalog: SkuCatalog): boolean => {
    const selection = config.selection as unknown as Record<string, unknown>;
    const cooler = catalog.skus.find((sku) => sku.id === config.selection.coolerId);
    for (const rule of runtimeProfile.fanAvailabilityRules as DeclarativeDocument[]) {
      if (rule.mountId !== mountId) continue;
      if (rule.kind === "selection-in" && (rule.values as unknown[]).includes(selection[rule.field as string])) return true;
      if (rule.kind === "psu-form-and-selection-in") {
        const formMatches = isSfx(config.selection.psuId, catalog) === (rule.form === "SFX");
        if (formMatches && (rule.values as unknown[]).includes(selection[rule.field as string])) return true;
      }
      if (rule.kind === "cooler-attribute-equals" && cooler?.attrs?.[rule.attribute as string] === rule.value) return true;
    }
    return false;
  };

  const effectiveFanGroups = (config: BuildConfig, catalog?: SkuCatalog): CaseFanGroupSelection[] => {
    const groups = config.selection.fanGroups ?? [];
    return groups.filter((found) => {
      const mount = capabilities.fanMounts.find((entry) => entry.id === found.mountId);
      const max = mount?.maxCountBySize[found.sizeMm];
      if (!mount || !mount.supportedSizes.includes(found.sizeMm) || max === undefined || found.count < 1 || found.count > max) return false;
      return !catalog || !excludedFanMount(found.mountId, config, catalog);
    });
  };

  const configuredFans = (config: BuildConfig, catalog?: SkuCatalog): CaseRuntimeFans => {
    const groups = effectiveFanGroups(config, catalog);
    const fans: CaseRuntimeFans = {};
    for (const mount of runtimeProfile.fanMounts as DeclarativeDocument[]) {
      const role = mount.geometryRole as keyof CaseRuntimeFans;
      const found = groups.find((entry) => entry.mountId === mount.id);
      fans[role] = found ? { size: found.sizeMm, count: found.count } : null;
    }
    const cooler = catalog?.skus.find((sku) => sku.id === config.selection.coolerId);
    for (const assignment of runtimeProfile.coolerFanAssignments as DeclarativeDocument[]) {
      if (cooler?.attrs?.type === assignment.coolerType && cooler?.attrs?.radiatorMm === assignment.radiatorMm) {
        fans[assignment.geometryRole as keyof CaseRuntimeFans] = {
          size: assignment.size as 120 | 140,
          count: assignment.count as number,
        };
      }
    }
    return fans;
  };

  const geometryEnvironment = (input: CaseRuntimeEnvironmentInput): GeometryEnv => {
    const { fans } = input;
    return {
      frontFans: fans.front ? (fans.front.size === 140 ? "140x2" : "120x2") : "none",
      frontFanCount: fans.front?.count ?? 0,
      rearFan: Boolean(fans.rear?.count),
      rearFanCount: fans.rear?.count ?? 0,
      driveFans: Boolean(fans.left?.count),
      driveFanCount: fans.left?.count ?? 0,
      sideFans: Boolean(fans.right?.count),
      sideFanCount: fans.right?.count ?? 0,
      ...(input.reserveHbaSlot ? { reserveHbaSlot: true } : {}),
      ...(input.gpuOverride ? { gpuOverride: input.gpuOverride } : {}),
      ...(input.instanceOverrides ? { instanceOverrides: input.instanceOverrides } : {}),
    };
  };

  const deriveBom = (config: BuildConfig, catalog: SkuCatalog): BuildLineItem[] => {
    const items: BuildLineItem[] = [
      { skuId: config.caseId, qty: 1, bucket: "owned" },
      { skuId: config.boardId, qty: 1, bucket: "owned" },
      { skuId: config.cpuId, qty: 1, bucket: "owned" },
      { skuId: config.selection.psuId, qty: 1, bucket: "buy_now" },
      { skuId: config.selection.coolerId, qty: 1, bucket: "buy_now" },
      { skuId: config.selection.memoryId, qty: 1, bucket: "buy_now" },
    ];
    const nvmeQty = config.selection.nvmeCount ?? defaults.ownedNvmeQty;
    if (nvmeQty > 0 && defaults.ownedNvmeSkuId) items.splice(3, 0, { skuId: defaults.ownedNvmeSkuId, qty: nvmeQty, bucket: "owned" });
    if (config.selection.gpuId !== "gpu.none") items.push({ skuId: config.selection.gpuId, qty: 1, bucket: "upgrade_later" });
    const diskSku = config.selection.diskSkuId ?? defaults.diskSkuId;
    if (config.selection.diskCount > 0 && diskSku) items.push({ skuId: diskSku, qty: config.selection.diskCount, bucket: "buy_now" });
    if (config.selection.boot === "bay" && defaults.bootBaySkuId) items.push({ skuId: defaults.bootBaySkuId, qty: 1, bucket: "buy_now" });
    if (needsHba(config.selection, buildSataPorts(catalog, config))) {
      const hbaSkuId = config.selection.hbaSkuId ?? defaults.hbaSkuId;
      if (hbaSkuId) items.push({ skuId: hbaSkuId, qty: 1, bucket: "buy_now" });
    }
    const checklist = planWiring(config, catalog).checklist;
    const qtyOf = (id: string): number => checklist.find((entry) => entry.id === id)?.requiredQty ?? 0;
    const slimQty = qtyOf("slimsas-breakout");
    if (slimQty > 0 && defaults.slimsasCableSkuId) items.push({ skuId: defaults.slimsasCableSkuId, qty: slimQty, bucket: "buy_now" });
    const minisasQty = qtyOf("hba-minisas");
    if (minisasQty > 0 && defaults.hbaBreakoutSkuId) items.push({ skuId: defaults.hbaBreakoutSkuId, qty: minisasQty, bucket: "buy_now" });
    if (config.selection.psuTopology === "dual") {
      const secondaryPsuSkuId = config.selection.secondaryPsuId ?? defaults.secondaryPsuSkuId;
      if (secondaryPsuSkuId) items.push({ skuId: secondaryPsuSkuId, qty: 1, bucket: "optional" });
      if (config.selection.dualStart === "sync" && defaults.dualSyncSkuId) items.push({ skuId: defaults.dualSyncSkuId, qty: 1, bucket: "buy_now" });
    }
    if (config.bom.length > 0) {
      const byId = new Map(items.map((item) => [item.skuId, item]));
      for (const line of config.bom) byId.set(line.skuId, line);
      return [...byId.values()];
    }
    for (const line of items) requireSku(catalog, line.skuId);
    return items;
  };

  const lowerPolicy = runtimeProfile.lowerChamberPolicy as DeclarativeDocument;
  const lowerTopologies = [...lowerPolicy.unavailableWithPsuTopologies as BuildConfig["selection"]["psuTopology"][]];
  const adapter: CaseRuntimeAdapter = {
    schemaVersion: "case-runtime-adapter-v1",
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    authorityStatus: model.authorityStatus,
    identity: {
      skuId: manifest.identity.skuId,
      region: manifest.identity.region,
      revision: manifest.identity.revision,
      manifestHash: manifest.contentHash,
      projectionHash,
    },
    domains: {
      electronics: { status: "ready", reasonCodes: [] },
      geometry: { status: "ready", reasonCodes: [] },
      wiring: { status: "ready", reasonCodes: [] },
      routing: { status: "ready", reasonCodes: [] },
      assembly: { status: "ready", reasonCodes: [] },
      thermal: { status: "ready", reasonCodes: [] },
      calibration: { status: "ready", reasonCodes: [] },
    },
    capabilities,
    powerProfile: {
      boardBaseW: numberOrNull(profile.powerProfile.boardBaseW),
      fanBaseW: numberOrNull(profile.powerProfile.fanBaseW),
      fan120W: numberOrNull(profile.powerProfile.fan120W),
      fan140W: numberOrNull(profile.powerProfile.fan140W),
      dualSyncW: numberOrNull(profile.powerProfile.dualSyncW),
      cpuIdleW: numberOrNull(profile.powerProfile.cpuIdleW),
      cpuReadW: numberOrNull(profile.powerProfile.cpuReadW),
      cpuQuickSyncW: numberOrNull(profile.powerProfile.cpuQuickSyncW),
      hbaW: numberOrNull(profile.powerProfile.hbaW),
      driveSpinUpExtraW: numberOrNull(profile.powerProfile.driveSpinUpExtraW),
      evidence: evidence(profile.powerProfile.evidence),
      source: profile.powerProfile.source as string,
    },
    thermalProfile: {
      airDensityKgM3: profile.thermalProfile.airDensityKgM3 as number,
      airCpJPerKgK: profile.thermalProfile.airCpJPerKgK as number,
      systemDerate: profile.thermalProfile.systemDerate as { lo: number; hi: number },
      passiveCfm: profile.thermalProfile.passiveCfm as { lo: number; hi: number },
      evidence: evidence(profile.thermalProfile.evidence),
    },
    defaults,
    thermalDeckY: geometry.deckY,
    lowerChamberPolicy: {
      fanMountId: lowerPolicy.fanMountId as string,
      unavailableWithPsuTopologies: lowerTopologies,
      effectDescription: lowerPolicy.effectDescription as string,
    },
    effectiveFanSelections: effectiveFanGroups,
    configuredFanGroups: configuredFans,
    geometryEnvironment,
    buildGeometry: (config, catalog, environment) => geometry.buildGeometry(config, catalog, environment as GeometryEnv),
    buildOccupancy: (config, catalog, environment) => occupancy.buildOccupancy(config, catalog, environment as GeometryEnv),
    planWiring,
    deriveBom,
    buildRouting: routing.buildRouting,
    buildAssembly: buildAssemblyPlan,
    domainFindings: occupancy.domainFindings,
    conflictMarkerParts: occupancy.conflictMarkerParts,
    evaluatePhysical: (config, catalog, parts, routeResult, wiring) => evaluatePhysicalConstraints(
      config,
      catalog,
      parts,
      routeResult,
      wiring,
      { interiorBox: geometry.interiorBox, provenance: [...model.sourceRefs] },
    ),
    evaluateCalibration: () => evaluateCalibration(calibration as unknown as CalibrationSnapshot),
    psuInLowerChamber: (config) => lowerTopologies.includes(config.selection.psuTopology),
    thermalFans: (config, fans) => lowerTopologies.includes(config.selection.psuTopology)
      ? { ...fans, [lowerPolicy.geometryRole as keyof CaseRuntimeFans]: null }
      : fans,
  };

  return {
    adapter: Object.freeze(adapter),
    wiringProfile,
    buildAssembly: buildAssemblyPlan,
    checkBackplaneHarness: checkHarness,
    planWiring,
    planPanelWiring: planPanel,
  };
}
