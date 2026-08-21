import type { EvidenceLevel } from "./evidence";

export type { EvidenceLevel };

/** Axis-aligned box in mm, case-local coordinates (origin defined by adapter). */
export interface BoxMm {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export type SlotKind =
  | "drive_bay"
  | "pcie"
  | "fan"
  | "psu"
  | "radiator"
  | "cooler"
  | "memory"
  | "m2"
  | "cable_clearance"
  /** Chassis structure that owns volume without being a purchase. */
  | "structure";

export interface OccupancySlot {
  id: string;
  kind: SlotKind;
  box: BoxMm;
  exclusiveWith?: string[];
  evidence: EvidenceLevel;
  note?: string;
}

export interface Occupant {
  id: string;
  skuId: string;
  slotIds: string[];
  /** Optional exact envelope when SKU geometry is known. */
  envelope?: BoxMm;
  evidence: EvidenceLevel;
  /**
   * Evidence for *where* the envelope sits, as opposed to how big it is. Almost
   * always `inferred` for the N6: the manual publishes no internal anchors. A
   * conflict resting on a guessed anchor cannot be reported as a hard failure.
   */
  anchorEvidence?: EvidenceLevel;
  /** Parent occupant. A child is meant to sit inside its parent, so the pair is skipped. */
  mountedOn?: string;
  /** Occupants sharing a group are one assembly and never clash with each other. */
  group?: string;
  /** Reserved service / routing volume rather than a solid part. */
  clearance?: boolean;
  /** Display name for conflict messages; falls back to `skuId`. */
  label?: string;
}

export interface ConflictHit {
  id: string;
  a: string;
  b: string;
  verdict: "warn" | "bad";
  evidence: EvidenceLevel;
  message: string;
  /** Intersection depth in mm on the shallowest axis, when known. */
  overlapMm?: number;
}

export interface OccupancyModel {
  caseId: string;
  slots: OccupancySlot[];
  occupants: Occupant[];
}

export function boxesOverlap(a: BoxMm, b: BoxMm, epsilon = 0.5): boolean {
  return (
    a.x < b.x + b.w - epsilon &&
    a.x + a.w > b.x + epsilon &&
    a.y < b.y + b.h - epsilon &&
    a.y + a.h > b.y + epsilon &&
    a.z < b.z + b.d - epsilon &&
    a.z + a.d > b.z + epsilon
  );
}

/** Smallest per-axis intersection depth in mm; ≤ 0 when the boxes are clear. */
export function overlapDepthMm(a: BoxMm, b: BoxMm): number {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const dz = Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z);
  return Math.min(dx, dy, dz);
}

const ORDER: EvidenceLevel[] = ["official", "standard", "inferred", "unknown"];

function weakest(levels: (EvidenceLevel | undefined)[]): EvidenceLevel {
  return levels.reduce<EvidenceLevel>(
    (worst, l) => (l && ORDER.indexOf(l) > ORDER.indexOf(worst) ? l : worst),
    "official",
  );
}

/** True when either occupant is an ancestor of the other. */
function nested(a: Occupant, b: Occupant, byId: Map<string, Occupant>): boolean {
  const climbs = (from: Occupant, targetId: string): boolean => {
    let cur: Occupant | undefined = from;
    const seen = new Set<string>();
    while (cur?.mountedOn && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.mountedOn === targetId) return true;
      cur = byId.get(cur.mountedOn);
    }
    return false;
  };
  return climbs(a, b.id) || climbs(b, a.id);
}

const nameOf = (o: Occupant): string => o.label ?? o.skuId;

/**
 * Detect exclusive-slot clashes and envelope intersections.
 *
 * Envelope intersections are graded, not absolute. A box whose *anchor* is a
 * planning reconstruction cannot prove incompatibility, so those come back as
 * `warn` with the reason stated; only two parts whose size and placement are
 * both evidenced can produce a `bad`. Clearance volumes are always `warn`:
 * losing service space is a trade-off, not a failure to assemble.
 */
export function detectConflicts(model: OccupancyModel): ConflictHit[] {
  const hits: ConflictHit[] = [];
  const slotById = new Map(model.slots.map((s) => [s.id, s]));
  const occById = new Map(model.occupants.map((o) => [o.id, o]));

  const occupantsBySlot = new Map<string, Occupant[]>();
  for (const occ of model.occupants) {
    for (const slotId of occ.slotIds) {
      const list = occupantsBySlot.get(slotId) ?? [];
      list.push(occ);
      occupantsBySlot.set(slotId, list);
    }
  }

  for (const [slotId, occs] of occupantsBySlot) {
    if (occs.length < 2) continue;
    const slot = slotById.get(slotId);
    for (let i = 0; i < occs.length; i++) {
      for (let j = i + 1; j < occs.length; j++) {
        const a = occs[i]!;
        const b = occs[j]!;
        hits.push({
          id: `slot:${slotId}:${a.id}:${b.id}`,
          a: a.id,
          b: b.id,
          verdict: "bad",
          evidence: slot?.evidence ?? "inferred",
          message: `Slot ${slotId} claimed by both ${a.skuId} and ${b.skuId}`,
        });
      }
    }
  }

  // exclusiveWith: if slot A is occupied and any exclusive sibling slot is also occupied
  for (const slot of model.slots) {
    if (!slot.exclusiveWith?.length) continue;
    const here = occupantsBySlot.get(slot.id) ?? [];
    if (here.length === 0) continue;
    for (const otherId of slot.exclusiveWith) {
      const there = occupantsBySlot.get(otherId) ?? [];
      if (there.length === 0) continue;
      for (const a of here) {
        for (const b of there) {
          hits.push({
            id: `excl:${slot.id}:${otherId}:${a.id}:${b.id}`,
            a: a.id,
            b: b.id,
            verdict: "warn",
            evidence:
              slot.evidence === "official" || slotById.get(otherId)?.evidence === "official"
                ? "inferred"
                : (slot.evidence ?? "unknown"),
            message: `Slot ${slot.id} is exclusive with ${otherId} (${a.skuId} vs ${b.skuId})`,
          });
        }
      }
    }
  }

  for (let i = 0; i < model.occupants.length; i++) {
    for (let j = i + 1; j < model.occupants.length; j++) {
      const a = model.occupants[i]!;
      const b = model.occupants[j]!;
      if (!a.envelope || !b.envelope) continue;
      if (a.group && a.group === b.group) continue;
      if (nested(a, b, occById)) continue;
      if (!boxesOverlap(a.envelope, b.envelope)) continue;

      const overlapMm = Math.round(overlapDepthMm(a.envelope, b.envelope) * 10) / 10;
      const sizeEvidence = weakest([a.evidence, b.evidence]);
      const anchorEvidence = weakest([a.anchorEvidence, b.anchorEvidence]);
      const evidence = weakest([sizeEvidence, anchorEvidence]);

      if (a.clearance || b.clearance) {
        const zone = a.clearance ? a : b;
        const part = a.clearance ? b : a;
        hits.push({
          id: `clear:${zone.id}:${part.id}`,
          a: zone.id,
          b: part.id,
          verdict: "warn",
          evidence,
          message: `${nameOf(part)} 侵入「${nameOf(zone)}」预留净空 ${overlapMm}mm；净空区本身是规划包络，需按实物核对走线与维护空间。`,
          overlapMm,
        });
        continue;
      }

      // Only an evidenced size *and* an evidenced anchor can prove interference.
      const provable = anchorEvidence === "official" || anchorEvidence === "standard";
      hits.push({
        id: `aabb:${a.id}:${b.id}`,
        a: a.id,
        b: b.id,
        verdict: provable && sizeEvidence !== "unknown" ? "bad" : "warn",
        evidence,
        message: provable
          ? `${nameOf(a)} 与 ${nameOf(b)} 包络相交 ${overlapMm}mm。`
          : `${nameOf(a)} 与 ${nameOf(b)} 的规划包络相交 ${overlapMm}mm；锚点为按手册重建的推算值，不能据此断定不兼容，需实物核对。`,
        overlapMm,
      });
    }
  }

  return hits;
}
