import type { BuildConfig } from "../../config/types";
import type { ConflictHit, OccupancyModel, Occupant } from "../../core/occupancy";
import type { EngineFinding } from "../../core/engine";
import type { EvidenceLevel } from "../../core/evidence";
import type { CenteredBox, PlacedPart, Vec3 } from "../../core/geometry";
import { toBoxMm } from "../../core/geometry";
import type { SkuCatalog } from "../../sku/types";
import {
  type DeclarativeCaseGeometry,
  type DeclarativeDocument,
  type GeometryEnv,
} from "./geometry";

export interface DeclarativeCaseOccupancy {
  envelope: { widthMm: number; depthMm: number; heightMm: number };
  buildSlots(): OccupancyModel["slots"];
  occupantsFromGeometry(parts: PlacedPart[]): Occupant[];
  conflictMarkerParts(parts: PlacedPart[], hits: ConflictHit[]): PlacedPart[];
  occupantsFromConfig(config: BuildConfig, catalog: SkuCatalog, env?: GeometryEnv): Occupant[];
  domainFindings(config: BuildConfig, catalog: SkuCatalog): EngineFinding[];
  buildOccupancy(config: BuildConfig, catalog: SkuCatalog, env?: GeometryEnv): OccupancyModel;
}

export function createDeclarativeCaseOccupancy(
  profile: DeclarativeDocument,
  geo: DeclarativeDocument,
  geometry: DeclarativeCaseGeometry,
): DeclarativeCaseOccupancy {
const envelope = {
  widthMm: geo.envelope.w as number,
  depthMm: geo.envelope.d as number,
  heightMm: geo.envelope.h as number,
};

const box = (c: Vec3, w: number, h: number, d: number): CenteredBox => ({ c, w, h, d });

/**
 * Slot graph derived from the same governed geometry document used to draw the
 * parts, so mount volumes and the preview cannot drift apart.
 */
function buildSlots(): OccupancyModel["slots"] {
  const boardTop = geo.board.topY;
  const atxMax = profile.psuLimits.atxMaxLengthMm;
  const sfxMax = profile.psuLimits.sfxMaxLengthMm;
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
        geometry.unionBox(
          (front140.xOffsets as number[]).map((x) =>
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
          [geo.gpu.x, boardTop + geo.gpu.heightConsumerMm / 2, geo.gpu.zRear - profile.gpuLimits.publishedMaxMm / 2],
          geo.gpu.slotPitchMm * 2,
          geo.gpu.heightConsumerMm,
          profile.gpuLimits.publishedMaxMm,
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
          [geo.socket.c[0]!, boardTop + profile.coolerLimits.openTopMm / 2, geo.socket.c[1]!],
          geo.socket.keepoutMm,
          profile.coolerLimits.openTopMm,
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
      box: toBoxMm(geometry.trayCageBox()),
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
    ...(geo.clearances as DeclarativeDocument[]).map((c) => ({
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
function occupantsFromGeometry(parts: PlacedPart[]): Occupant[] {
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
    if (boxes.length > 1) occ.envelope = toBoxMm(geometry.unionBox(boxes));
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
function conflictMarkerParts(parts: PlacedPart[], hits: ConflictHit[]): PlacedPart[] {
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
    const overlap = intersectBox(geometry.unionBox(a), geometry.unionBox(b));
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

function occupantsFromConfig(
  config: BuildConfig,
  catalog: SkuCatalog,
  env: GeometryEnv = {},
): Occupant[] {
  return occupantsFromGeometry(geometry.buildGeometry(config, catalog, env));
}

function domainFindings(config: BuildConfig, catalog: SkuCatalog): EngineFinding[] {
  const findings: EngineFinding[] = [];
  const placement = geometry.psuPlacement(config, catalog);
  const gpu = catalog.skus.find((sku) => sku.id === config.selection.gpuId);
  const selection = config.selection as unknown as Record<string, unknown>;
  for (const rule of profile.domainFindings as DeclarativeDocument[]) {
    let matches = false;
    if (rule.kind === "placement-in") matches = (rule.placements as unknown[]).includes(placement);
    if (rule.kind === "boot-bay-full") matches = config.selection.boot === "bay" && config.selection.diskCount === profile.trayCount;
    if (rule.kind === "selection-equals") matches = selection[rule.field as string] === rule.value;
    if (rule.kind === "selected-sku-boolean") {
      matches = gpu?.attrs?.[rule.attribute as string] === rule.value
        && selection[rule.andField as string] === rule.andValue;
    }
    if (!matches) continue;
    const finding = rule.finding as DeclarativeDocument;
    findings.push({
      id: finding.id as string,
      verdict: finding.verdict as EngineFinding["verdict"],
      evidence: finding.evidence as EngineFinding["evidence"],
      message: (finding.message as string).replaceAll("{selectedSku.name}", gpu?.name ?? config.selection.gpuId),
      related: [...finding.related as string[]],
    });
  }

  return findings;
}

function buildOccupancy(
  config: BuildConfig,
  catalog: SkuCatalog,
  env: GeometryEnv = {},
): OccupancyModel {
  return {
    caseId: config.caseId,
    slots: buildSlots(),
    occupants: occupantsFromConfig(config, catalog, env),
  };
}

return { envelope, buildSlots, occupantsFromGeometry, conflictMarkerParts, occupantsFromConfig, domainFindings, buildOccupancy };
}
