import type { BuildConfig } from "../../config/types";
import type { ConflictHit, OccupancyModel, Occupant } from "../../core/occupancy";
import type { EngineFinding } from "../../core/engine";
import type { EvidenceLevel } from "../../core/evidence";
import type { CenteredBox, PlacedPart, Vec3 } from "../../core/geometry";
import { toBoxMm } from "../../core/geometry";
import type { SkuCatalog } from "../../sku/types";
import { loadRawCatalog } from "../../sku/catalog";
import n6Profile from "../../../data/cases/jonsbo-n6/profile.json";
import geo from "../../../data/cases/jonsbo-n6/geometry.json";
import {
  buildN6Geometry,
  n6PsuPlacement,
  trayCageBox,
  unionBox,
  type GeometryEnv,
} from "./geometry";

/** Official N6 published envelope (mm) from constraint registry / manual. */
export const N6_ENVELOPE = {
  widthMm: geo.envelope.w,
  depthMm: geo.envelope.d,
  heightMm: geo.envelope.h,
} as const;

function looksLikeSfx(psuId: string): boolean {
  return /sfx|sf750|sf-750/i.test(psuId);
}

const box = (c: Vec3, w: number, h: number, d: number): CenteredBox => ({ c, w, h, d });

/**
 * Slot graph for N6, derived from `data/cases/jonsbo-n6/geometry.json` so the
 * mount volumes and the drawn parts cannot drift apart. Internal anchors that
 * are not in the manual stay `inferred` and must not be sold as CAD.
 */
export function buildN6Slots(): OccupancyModel["slots"] {
  const boardTop = geo.board.topY;
  const atxMax = n6Profile.psuLimits.atxMaxLengthMm;
  const sfxMax = n6Profile.psuLimits.sfxMaxLengthMm;
  const atx = geo.psu.rearUpperAtx;
  const front = geo.psu.frontSfx;
  const bottom = geo.psu.bottomSfx;
  const front140 = geo.fanMounts.front140;
  const rad240 = geo.fanMounts.radiator240Front;

  return [
    {
      id: "psu.rear_upper",
      kind: "psu",
      box: toBoxMm(box([atx.c[0]!, atx.c[1]!, atx.zRear - atxMax / 2], atx.w, atx.h, atxMax)),
      evidence: "inferred",
      note: "ATX 后上位：截面为 ATX 规范，深度用机箱 220mm 上限；机箱内锚点为按手册重建的推算值，不是注册 CAD",
    },
    {
      id: "psu.front_sfx",
      kind: "psu",
      box: toBoxMm(
        box([front.c[0]!, front.c[1]!, front.zFront + sfxMax / 2], front.w, front.h, sfxMax),
      ),
      exclusiveWith: ["fan.front", "radiator.front_240"],
      evidence: "inferred",
      note: "前置 SFX 与前风扇 / 240 冷排的共存关系手册未给出，按保守互斥处理",
    },
    {
      id: "psu.bottom_sfx",
      kind: "psu",
      box: toBoxMm(
        box([bottom.c[0]!, bottom.c[1]!, bottom.zRear - sfxMax / 2], bottom.w, bottom.h, sfxMax),
      ),
      evidence: "inferred",
    },
    {
      id: "fan.front",
      kind: "fan",
      box: toBoxMm(
        unionBox(
          front140.xOffsets.map((x) =>
            box([x, front140.c[1]!, front140.c[2]!], front140.frameMm, front140.frameMm, front140.thicknessMm),
          ),
        ),
      ),
      evidence: "official",
      note: "手册 §14 证明前部有 120×2 / 140×2 安装位；¥629 SKU 是否随箱附送风扇未知",
    },
    {
      id: "radiator.front_240",
      kind: "radiator",
      box: toBoxMm(box(rad240.c as Vec3, rad240.w, rad240.h, rad240.d)),
      evidence: "official",
    },
    {
      id: "pcie.slot1",
      kind: "pcie",
      box: toBoxMm(
        box(
          [geo.gpu.x, boardTop + geo.gpu.heightConsumerMm / 2, geo.gpu.zRear - n6Profile.gpuLimits.publishedMaxMm / 2],
          geo.gpu.slotPitchMm * 2,
          geo.gpu.heightConsumerMm,
          n6Profile.gpuLimits.publishedMaxMm,
        ),
      ),
      evidence: "inferred",
    },
    {
      id: "pcie.slot2",
      kind: "pcie",
      box: toBoxMm(box([geo.hba.c[0]!, boardTop + geo.hba.h / 2, geo.hba.c[1]!], geo.hba.w, geo.hba.h, geo.hba.d)),
      evidence: "inferred",
    },
    {
      id: "cooler.cpu",
      kind: "cooler",
      box: toBoxMm(
        box(
          [geo.socket.c[0]!, boardTop + n6Profile.coolerLimits.openTopMm / 2, geo.socket.c[1]!],
          geo.socket.keepoutMm,
          n6Profile.coolerLimits.openTopMm,
          geo.socket.keepoutMm,
        ),
      ),
      evidence: "inferred",
    },
    ...Array.from({ length: geo.trays.count }, (_, i) => ({
      id: `bay.${i + 1}`,
      kind: "drive_bay" as const,
      box: toBoxMm(
        box(
          [(i - 4) * geo.trays.pitchMm, geo.trays.c[1]!, geo.trays.c[2]!],
          geo.trays.pitchMm,
          geo.trays.drive35.h + 2,
          geo.trays.drive35.d + 2,
        ),
      ),
      evidence: "inferred" as EvidenceLevel,
      note: "托架间距按手册 p.19 的九位横向单排反推；手册不给间距",
    })),
    // Lower-chamber structure. These are chassis parts, not purchases, but they own
    // real volume: leaving them out of the slot graph made the lower half read as
    // free space it is not.
    {
      id: "backplane.pcb",
      kind: "structure",
      box: toBoxMm(
        box(geo.backplane.pcb.c as Vec3, geo.backplane.pcb.w, geo.backplane.pcb.h, geo.backplane.pcb.d),
      ),
      evidence: "inferred",
      note: geo.backplane.source,
    },
    {
      id: "tray.frame",
      kind: "structure",
      box: toBoxMm(trayCageBox()),
      evidence: "inferred",
      note: geo.trayFrame.source,
    },
    {
      id: "fan.left_bracket",
      kind: "structure",
      box: toBoxMm(
        box(
          geo.lowerLeftWall.fanBracket.c as Vec3,
          geo.lowerLeftWall.fanBracket.w,
          geo.lowerLeftWall.fanBracket.h,
          geo.lowerLeftWall.fanBracket.d,
        ),
      ),
      exclusiveWith: ["psu.bottom_sfx"],
      evidence: "official",
      note: geo.lowerLeftWall.fanBracket.source,
    },
    ...geo.clearances.map((c) => ({
      id: c.id,
      kind: "cable_clearance" as const,
      box: toBoxMm(box(c.c as Vec3, c.w, c.h, c.d)),
      evidence: "inferred" as EvidenceLevel,
      note: c.source,
    })),
  ];
}

const occIdFor = (part: PlacedPart): string =>
  `occ-${(part.slotId ?? part.id).replace(/\./g, "-")}`;

/**
 * Turn the geometry list into occupancy claims. Parts that share a slot become
 * one occupant carrying the union of their envelopes (a fan wall is one claim on
 * `fan.front`), and every occupant carries a real envelope so the AABB pass has
 * something to work with instead of being dead code.
 */
export function occupantsFromGeometry(parts: PlacedPart[]): Occupant[] {
  const byOccId = new Map<string, { occ: Occupant; boxes: CenteredBox[] }>();
  const occIdByPartId = new Map<string, string>();

  for (const part of parts) {
    const id = occIdFor(part);
    occIdByPartId.set(part.id, id);
    const existing = byOccId.get(id);
    if (existing) {
      existing.boxes.push(part.box);
      continue;
    }
    byOccId.set(id, {
      boxes: [part.box],
      occ: {
        id,
        skuId: part.skuId ?? part.id,
        label: part.name,
        slotIds: part.slotId ? [part.slotId] : [],
        evidence: part.sizeEvidence,
        anchorEvidence: part.anchorEvidence,
        envelope: toBoxMm(part.box),
        ...(part.group ? { group: part.group } : {}),
        ...(part.kind === "clearance" ? { clearance: true } : {}),
        ...(part.mountedOn ? { mountedOn: part.mountedOn } : {}),
      },
    });
  }

  const out: Occupant[] = [];
  for (const { occ, boxes } of byOccId.values()) {
    if (boxes.length > 1) occ.envelope = toBoxMm(unionBox(boxes));
    // Re-point parent references at the parent's *occupant* id.
    if (occ.mountedOn) {
      const parent = occIdByPartId.get(occ.mountedOn);
      if (parent && parent !== occ.id) occ.mountedOn = parent;
      else delete occ.mountedOn;
    }
    out.push(occ);
  }
  return out;
}

/**
 * Turn engine conflict hits back into boxes so the preview marks the volume the
 * engine actually objected to, instead of carrying its own hardcoded red boxes
 * that could disagree with the verdict list.
 */
export function conflictMarkerParts(parts: PlacedPart[], hits: ConflictHit[]): PlacedPart[] {
  const boxesByOcc = new Map<string, CenteredBox[]>();
  for (const part of parts) {
    const id = occIdFor(part);
    const list = boxesByOcc.get(id) ?? [];
    list.push(part.box);
    boxesByOcc.set(id, list);
  }

  const out: PlacedPart[] = [];
  for (const hit of hits) {
    const a = boxesByOcc.get(hit.a);
    const b = boxesByOcc.get(hit.b);
    if (!a || !b) continue;
    const overlap = intersectBox(unionBox(a), unionBox(b));
    if (!overlap) continue;
    out.push({
      id: `conflict.${hit.id}`,
      name: hit.verdict === "bad" ? "包络相交（判定不兼容）" : "包络相交（需实测）",
      kind: "conflict",
      box: overlap,
      sizeEvidence: hit.evidence,
      anchorEvidence: "inferred",
      dimsLabel: `相交 ${hit.overlapMm ?? 0}mm · ${hit.verdict}`,
      note: hit.message,
    });
  }
  return out;
}

function intersectBox(a: CenteredBox, b: CenteredBox): CenteredBox | null {
  const lo: number[] = [];
  const size: number[] = [];
  const half = [a.w / 2, a.h / 2, a.d / 2];
  const halfB = [b.w / 2, b.h / 2, b.d / 2];
  for (let i = 0; i < 3; i++) {
    const min = Math.max(a.c[i]! - half[i]!, b.c[i]! - halfB[i]!);
    const max = Math.min(a.c[i]! + half[i]!, b.c[i]! + halfB[i]!);
    if (max - min <= 0) return null;
    lo.push(min);
    size.push(max - min);
  }
  return {
    c: [lo[0]! + size[0]! / 2, lo[1]! + size[1]! / 2, lo[2]! + size[2]! / 2],
    w: size[0]!,
    h: size[1]!,
    d: size[2]!,
  };
}

export function occupantsFromConfig(
  config: BuildConfig,
  catalog: SkuCatalog = loadRawCatalog(),
  env: GeometryEnv = {},
): Occupant[] {
  return occupantsFromGeometry(buildN6Geometry(config, catalog, env));
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

export function buildN6Occupancy(
  config: BuildConfig,
  catalog: SkuCatalog = loadRawCatalog(),
  env: GeometryEnv = {},
): OccupancyModel {
  return {
    caseId: config.caseId,
    slots: buildN6Slots(),
    occupants: occupantsFromConfig(config, catalog, env),
  };
}

export { n6PsuPlacement };
