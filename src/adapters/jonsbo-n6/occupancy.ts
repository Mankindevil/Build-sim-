import type { BuildConfig } from "../../config/types";
import type { OccupancyModel, Occupant } from "../../core/occupancy";
import type { EngineFinding } from "../../core/engine";
import type { EvidenceLevel } from "../../core/evidence";
import { needsHba } from "../../core/policy";
import n6Profile from "../../../data/cases/jonsbo-n6/profile.json";

/** Official N6 published envelope (mm) from constraint registry / manual. */
export const N6_ENVELOPE = {
  widthMm: 305,
  depthMm: 353,
  heightMm: 318,
} as const;

function looksLikeSfx(psuId: string): boolean {
  return /sfx|sf750|sf-750/i.test(psuId);
}

/**
 * Slot graph for N6. Internal AABB anchors that are not in the manual
 * are marked `inferred` or `unknown` and must not be sold as CAD.
 */
export function buildN6Slots(): OccupancyModel["slots"] {
  return [
    {
      id: "psu.rear_upper",
      kind: "psu",
      box: { x: 0, y: 220, z: 250, w: 150, h: 86, d: 140 },
      evidence: "inferred",
      note: "ATX rear-upper placement reconstructed from manual topology — not registered CAD",
    },
    {
      id: "psu.front_sfx",
      kind: "psu",
      box: { x: 0, y: 0, z: 0, w: 125, h: 63, d: 100 },
      exclusiveWith: ["fan.front", "radiator.front_240"],
      evidence: "inferred",
      note: "Front SFX vs front fans / 240 rad coexistence is unknown in local registry",
    },
    {
      id: "psu.bottom_sfx",
      kind: "psu",
      box: { x: 0, y: 0, z: 120, w: 125, h: 63, d: 100 },
      evidence: "inferred",
    },
    {
      id: "fan.front",
      kind: "fan",
      box: { x: 0, y: 0, z: 0, w: 140, h: 140, d: 25 },
      evidence: "official",
      note: "Front fan mounts exist; purchased ¥629 SKU fan inclusion is unknown",
    },
    {
      id: "radiator.front_240",
      kind: "radiator",
      box: { x: 0, y: 0, z: 0, w: 140, h: 280, d: 30 },
      evidence: "official",
    },
    {
      id: "pcie.slot1",
      kind: "pcie",
      box: { x: 40, y: 40, z: 40, w: 20, h: 120, d: 300 },
      evidence: "inferred",
    },
    {
      id: "pcie.slot2",
      kind: "pcie",
      box: { x: 60, y: 40, z: 40, w: 20, h: 120, d: 300 },
      evidence: "inferred",
    },
    {
      id: "cooler.cpu",
      kind: "cooler",
      box: { x: 90, y: 80, z: 80, w: 100, h: 65, d: 100 },
      evidence: "inferred",
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `bay.${i + 1}`,
      kind: "drive_bay" as const,
      box: { x: 180, y: 20 + i * 28, z: 20, w: 110, h: 26, d: 150 },
      evidence: "inferred" as EvidenceLevel,
      note: "Tray pitch reconstructed for planning — verify against manual photos",
    })),
    // Lower-chamber structure. These are chassis parts, not purchases, but they own
    // real volume: leaving them out of the slot graph made the lower half read as
    // free space it is not.
    {
      id: "backplane.pcb",
      kind: "structure",
      box: { x: 180, y: 20, z: 172, w: 250, h: 102, d: 8 },
      evidence: "inferred",
      note: "Backplane sits behind the tray stack with the four power inlets in a row (manual §13 p.14); exact PCB outline is a planning envelope",
    },
    {
      id: "tray.frame",
      kind: "structure",
      box: { x: 175, y: 16, z: 18, w: 258, h: 110, d: 152 },
      evidence: "inferred",
      note: "Steel cage around the nine trays — envelope reconstructed from the tray pitch, not CAD",
    },
    {
      id: "fan.left_bracket",
      kind: "structure",
      box: { x: 2, y: 16, z: 40, w: 4, h: 124, d: 272 },
      exclusiveWith: ["psu.bottom_sfx"],
      evidence: "official",
      note: "Removable 4-screw bracket carrying the left 120×2; must come off to reach the backplane inlets (§13.1) and stays off when the bottom PSU rack takes its place (§8.1)",
    },
  ];
}

export function occupantsFromConfig(config: BuildConfig): Occupant[] {
  const occ: Occupant[] = [];
  const topo = config.selection.psuTopology;
  const psuFormHint = looksLikeSfx(config.selection.psuId);
  const caseId = config.caseId || "case.jonsbo-n6";

  // Chassis structure is always in the box; the bracket is the one piece that comes
  // and goes, and it leaves precisely when the bottom PSU rack takes its place.
  occ.push({ id: "occ-backplane", skuId: caseId, slotIds: ["backplane.pcb"], evidence: "inferred" });
  occ.push({ id: "occ-tray-frame", skuId: caseId, slotIds: ["tray.frame"], evidence: "inferred" });
  if (topo !== "bottom" && topo !== "dual") {
    occ.push({
      id: "occ-left-fan-bracket",
      skuId: caseId,
      slotIds: ["fan.left_bracket"],
      evidence: "official",
    });
  }

  if (topo === "dual") {
    occ.push({
      id: "occ-psu-primary",
      skuId: config.selection.psuId,
      slotIds: psuFormHint ? ["psu.front_sfx"] : ["psu.rear_upper"],
      evidence: "inferred",
    });
    occ.push({
      id: "occ-psu-secondary",
      skuId: config.selection.secondaryPsuId ?? "psu.sfx-450-unlocked",
      slotIds: ["psu.bottom_sfx"],
      evidence: "inferred",
    });
  } else if (topo === "bottom") {
    occ.push({
      id: "occ-psu",
      skuId: config.selection.psuId,
      slotIds: ["psu.bottom_sfx"],
      evidence: "inferred",
    });
  } else {
    occ.push({
      id: "occ-psu",
      skuId: config.selection.psuId,
      slotIds: psuFormHint ? ["psu.front_sfx"] : ["psu.rear_upper"],
      evidence: "inferred",
    });
  }

  occ.push({
    id: "occ-cooler",
    skuId: config.selection.coolerId,
    slotIds: ["cooler.cpu"],
    evidence: "inferred",
  });

  if (config.selection.coolerId.includes("aio-240") || config.selection.coolerId.includes("aio240")) {
    occ.push({
      id: "occ-rad-240",
      skuId: config.selection.coolerId,
      slotIds: ["radiator.front_240", "fan.front"],
      evidence: "official",
    });
  }

  if (config.selection.gpuId !== "gpu.none") {
    occ.push({
      id: "occ-gpu",
      skuId: config.selection.gpuId,
      slotIds: ["pcie.slot1"],
      evidence: "unknown",
    });
  }

  const hbaNeeded = needsHba(config.selection, n6Profile.hba);
  if (hbaNeeded) {
    occ.push({
      id: "occ-hba",
      skuId: config.selection.hbaSkuId ?? n6Profile.hba.defaultSkuId,
      slotIds: ["pcie.slot2"],
      evidence: "inferred",
    });
  }

  for (let i = 1; i <= config.selection.diskCount; i++) {
    if (config.selection.boot === "bay" && i === 9) break;
    occ.push({
      id: `occ-disk-${i}`,
      skuId: config.selection.diskSkuId ?? n6Profile.defaults.diskSkuId,
      slotIds: [`bay.${i}`],
      evidence: "official",
    });
  }

  if (config.selection.boot === "bay") {
    occ.push({
      id: "occ-boot-bay",
      skuId: n6Profile.defaults.bootBaySkuId,
      slotIds: ["bay.9"],
      evidence: "inferred",
    });
  }

  return occ;
}

export function n6DomainFindings(config: BuildConfig): EngineFinding[] {
  const findings: EngineFinding[] = [];
  const frontSfx =
    config.selection.psuTopology === "auto" && looksLikeSfx(config.selection.psuId);
  const dualFront =
    config.selection.psuTopology === "dual" && looksLikeSfx(config.selection.psuId);

  if (frontSfx || dualFront) {
    findings.push({
      id: "n6.front-sfx-fan",
      verdict: "warn",
      evidence: "unknown",
      message: "Front SFX vs front fan / 240 radiator coexistence is not confirmed in the local registry",
      related: ["psu.front_sfx", "fan.front"],
    });
  }

  if (config.selection.boot === "bay" && config.selection.diskCount === 9) {
    findings.push({
      id: "n6.bay9-boot-vs-9hdd",
      verdict: "bad",
      evidence: "inferred",
      message: "Tray 9 cannot be both SATA boot and the 9th data HDD",
      related: ["bay.9"],
    });
  }

  if (config.selection.gpuId.includes("a4000") && config.selection.hbaMode === "always") {
    findings.push({
      id: "n6.a4000-hba",
      verdict: "warn",
      evidence: "unknown",
      message: "A4000 + HBA physical coexistence is not fully verified for a locked A4000 SKU",
      related: ["pcie.slot1", "pcie.slot2"],
    });
  }

  if (config.selection.psuTopology === "bottom") {
    findings.push({
      id: "n6.bottom-sfx-bracket",
      verdict: "warn",
      evidence: "official",
      message: "Bottom SFX requires removal of the left-side fan bracket (N6 manual)",
      related: ["psu.bottom_sfx"],
    });
  }

  return findings;
}

export function buildN6Occupancy(config: BuildConfig): OccupancyModel {
  return {
    caseId: config.caseId || "case.jonsbo-n6",
    slots: buildN6Slots(),
    occupants: occupantsFromConfig(config),
  };
}
