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
  | "cable_clearance";

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
}

export interface ConflictHit {
  id: string;
  a: string;
  b: string;
  verdict: "warn" | "bad";
  evidence: EvidenceLevel;
  message: string;
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

/** Detect exclusive-slot clashes and optional AABB overlaps. */
export function detectConflicts(model: OccupancyModel): ConflictHit[] {
  const hits: ConflictHit[] = [];
  const slotById = new Map(model.slots.map((s) => [s.id, s]));

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

  for (let i = 0; i < model.occupants.length; i++) {
    for (let j = i + 1; j < model.occupants.length; j++) {
      const a = model.occupants[i]!;
      const b = model.occupants[j]!;
      if (!a.envelope || !b.envelope) continue;
      if (!boxesOverlap(a.envelope, b.envelope)) continue;
      const weakest: EvidenceLevel =
        a.evidence === "unknown" || b.evidence === "unknown"
          ? "unknown"
          : a.evidence === "inferred" || b.evidence === "inferred"
            ? "inferred"
            : a.evidence === "standard" || b.evidence === "standard"
              ? "standard"
              : "official";
      hits.push({
        id: `aabb:${a.id}:${b.id}`,
        a: a.id,
        b: b.id,
        verdict: weakest === "unknown" ? "warn" : "bad",
        evidence: weakest,
        message: `Envelope intersection between ${a.skuId} and ${b.skuId}`,
      });
    }
  }

  return hits;
}
