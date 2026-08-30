import { assertValidAabb, type Aabb3Mm, type Vec3Mm } from "./types";

export interface AabbBounds {
  readonly minimumMm: Vec3Mm;
  readonly maximumMm: Vec3Mm;
}

export function aabbBounds(box: Aabb3Mm): AabbBounds {
  assertValidAabb(box);
  return {
    minimumMm: [
      box.centerMm[0] - box.sizeMm[0] / 2,
      box.centerMm[1] - box.sizeMm[1] / 2,
      box.centerMm[2] - box.sizeMm[2] / 2,
    ],
    maximumMm: [
      box.centerMm[0] + box.sizeMm[0] / 2,
      box.centerMm[1] + box.sizeMm[1] / 2,
      box.centerMm[2] + box.sizeMm[2] / 2,
    ],
  };
}

export function inflateAabb(box: Aabb3Mm, marginMm: number | Vec3Mm): Aabb3Mm {
  assertValidAabb(box);
  const margin = typeof marginMm === "number" ? [marginMm, marginMm, marginMm] as const : marginMm;
  if (margin.some((entry) => !Number.isFinite(entry) || entry < 0)) {
    throw new TypeError("geometry margin must contain finite nonnegative millimetres");
  }
  return {
    centerMm: [...box.centerMm] as Vec3Mm,
    sizeMm: [
      box.sizeMm[0] + margin[0] * 2,
      box.sizeMm[1] + margin[1] * 2,
      box.sizeMm[2] + margin[2] * 2,
    ],
  };
}

export function aabbIntersectionDepths(left: Aabb3Mm, right: Aabb3Mm): Vec3Mm {
  const a = aabbBounds(left);
  const b = aabbBounds(right);
  return [
    Math.min(a.maximumMm[0], b.maximumMm[0]) - Math.max(a.minimumMm[0], b.minimumMm[0]),
    Math.min(a.maximumMm[1], b.maximumMm[1]) - Math.max(a.minimumMm[1], b.minimumMm[1]),
    Math.min(a.maximumMm[2], b.maximumMm[2]) - Math.max(a.minimumMm[2], b.minimumMm[2]),
  ];
}

/**
 * Signed shortest AABB clearance. Positive values are free air, zero is contact,
 * and negative values are the shallowest penetration depth.
 */
export function signedAabbClearanceMm(left: Aabb3Mm, right: Aabb3Mm): number {
  const overlap = aabbIntersectionDepths(left, right);
  const separated = overlap.map((entry) => Math.max(0, -entry));
  if (separated.some((entry) => entry > 0)) return Math.hypot(...separated);
  const penetrationMm = Math.min(...overlap);
  return penetrationMm === 0 ? 0 : -penetrationMm;
}

export function aabbContains(outer: Aabb3Mm, inner: Aabb3Mm, marginMm = 0): boolean {
  if (!Number.isFinite(marginMm) || marginMm < 0) throw new TypeError("containment margin is invalid");
  const outerBounds = aabbBounds(outer);
  const innerBounds = aabbBounds(inner);
  return [0, 1, 2].every((axis) => (
    innerBounds.minimumMm[axis]! >= outerBounds.minimumMm[axis]! + marginMm
      && innerBounds.maximumMm[axis]! <= outerBounds.maximumMm[axis]! - marginMm
  ));
}
