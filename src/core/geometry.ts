import type { EvidenceLevel } from "./evidence";
import type { BoxMm } from "./occupancy";

/**
 * Millimetre geometry primitives shared by the occupancy engine, the thermal
 * field and the spatial preview.
 *
 * ## Case-local frame (the single convention in this repo)
 *
 * Origin is the **geometric centre of the case envelope**. Axes:
 *
 * - `x` — width, positive toward the case's right side
 * - `y` — height, positive up
 * - `z` — depth, positive toward the rear
 *
 * So for the N6 (305 × 353 × 318) every point of the outer envelope satisfies
 * `|x| ≤ 152.5`, `|y| ≤ 159`, `|z| ≤ 176.5`.
 *
 * Boxes are stored centred (`{ c, w, h, d }`) because that is how a part's
 * anchor is actually reasoned about ("the tray stack is centred 96 mm forward of
 * the middle"). `toBoxMm` converts to the min-corner form `BoxMm` that
 * `boxesOverlap` wants, so there is exactly one place where the two
 * representations meet.
 */

export type Vec3 = [number, number, number];
export type Axis = "x" | "y" | "z";

export const AXES: Axis[] = ["x", "y", "z"];

/** Axis-aligned box given by its centre and full extents, all in mm. */
export interface CenteredBox {
  c: Vec3;
  w: number;
  h: number;
  d: number;
}

/** Components the thermal model can put a temperature on. */
export type ThermalNodeId = "cpu" | "gpu" | "hba" | "psu" | "hdd";

/** Render/collision class of a placed part. Drives `.spatial-*` CSS in the lab. */
export type PartKind =
  | "deck"
  | "board"
  | "cpu"
  | "ram"
  | "m2"
  | "psu"
  | "cooler"
  | "radiator"
  | "gpu"
  | "hba"
  | "drive"
  | "empty"
  | "boot"
  | "usb"
  | "fan"
  | "chassis"
  | "pcb"
  | "connector"
  | "reserve"
  | "clearance"
  /** Marks the intersection volume the conflict engine objected to. */
  | "conflict";

/**
 * One part placed in the case. This is the single geometry record the whole app
 * reads: the occupancy engine turns it into slots/occupants, the thermal field
 * takes its centroid, and the spatial preview draws it.
 */
export interface PlacedPart {
  id: string;
  name: string;
  kind: PartKind;
  box: CenteredBox;
  /** Evidence for the *size* of the box (vendor spec, standard, or guess). */
  sizeEvidence: EvidenceLevel;
  /** Evidence for *where* it sits. Almost always `inferred` — the manual has no anchors. */
  anchorEvidence: EvidenceLevel;
  /** Human-readable dimension provenance shown in the preview. */
  dimsLabel: string;
  /** SKU this part represents, when it is a purchase rather than chassis structure. */
  skuId?: string;
  /** Occupancy slot this part claims, when it maps to one. */
  slotId?: string;
  /**
   * Parent part id. A child is expected to interpenetrate its parent (a cooler
   * bolts onto the CPU, a drive slides into the cage), so those pairs are not
   * reported as conflicts.
   */
  mountedOn?: string;
  /** Parts sharing a group are one assembly; they never clash with each other. */
  group?: string;
  /**
   * Thermal node this part represents. The field builder joins on this to place
   * a heat source at the part's real centroid instead of a hand-typed coordinate.
   */
  thermalId?: ThermalNodeId;
  /** Chamber the part breathes in; the deck splits the case at `N6_DECK_Y`. */
  chamber?: "lower" | "upper";
  /** Free-form note surfaced in the preview callout. */
  note?: string;
}

export function toBoxMm(box: CenteredBox): BoxMm {
  return {
    x: box.c[0] - box.w / 2,
    y: box.c[1] - box.h / 2,
    z: box.c[2] - box.d / 2,
    w: box.w,
    h: box.h,
    d: box.d,
  };
}

export function toCentered(box: BoxMm): CenteredBox {
  return {
    c: [box.x + box.w / 2, box.y + box.h / 2, box.z + box.d / 2],
    w: box.w,
    h: box.h,
    d: box.d,
  };
}

const SIZE: Record<Axis, "w" | "h" | "d"> = { x: "w", y: "h", z: "d" };
const INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export function minOn(box: CenteredBox, axis: Axis): number {
  return box.c[INDEX[axis]] - box[SIZE[axis]] / 2;
}

export function maxOn(box: CenteredBox, axis: Axis): number {
  return box.c[INDEX[axis]] + box[SIZE[axis]] / 2;
}

/** True when `inner` lies entirely inside `outer`, allowing `tol` mm of slop. */
export function containsBox(outer: CenteredBox, inner: CenteredBox, tol = 0): boolean {
  return AXES.every(
    (a) => minOn(inner, a) >= minOn(outer, a) - tol && maxOn(inner, a) <= maxOn(outer, a) + tol,
  );
}

/**
 * Signed gap between two boxes along one axis: positive is clear air between
 * them, negative is interpenetration. This is what replaces subtracting two
 * hardcoded constants to get "12 mm of intake left".
 */
export function clearanceGap(a: CenteredBox, b: CenteredBox, axis: Axis): number {
  const aMin = minOn(a, axis);
  const bMin = minOn(b, axis);
  return aMin <= bMin ? bMin - maxOn(a, axis) : aMin - maxOn(b, axis);
}

/** Overlap depth of two boxes on one axis; ≤ 0 means they are clear on that axis. */
export function overlapOn(a: CenteredBox, b: CenteredBox, axis: Axis): number {
  return Math.min(maxOn(a, axis), maxOn(b, axis)) - Math.max(minOn(a, axis), minOn(b, axis));
}

/** Volume of the intersection in mm³; 0 when the boxes are clear. */
export function intersectionVolumeMm3(a: CenteredBox, b: CenteredBox): number {
  let v = 1;
  for (const axis of AXES) {
    const o = overlapOn(a, b, axis);
    if (o <= 0) return 0;
    v *= o;
  }
  return v;
}

export function partVolumeMm3(box: CenteredBox): number {
  return box.w * box.h * box.d;
}

/**
 * Whether the segment `a`→`b` passes through `box`, by the slab method. Cables
 * are polylines, so "does this run cut through the drive cage" is a segment test
 * rather than a box test; `tol` shrinks the box so a run that merely grazes a
 * face is not reported.
 */
export function segmentHitsBox(a: Vec3, b: Vec3, box: CenteredBox, tol = 0): boolean {
  let tMin = 0;
  let tMax = 1;
  for (const axis of AXES) {
    const i = INDEX[axis];
    // Clamp the tolerance per axis: a 4 mm deck would otherwise vanish entirely
    // under a 2 mm shrink and stop blocking anything at all.
    const t = Math.min(tol, box[SIZE[axis]] / 4);
    const lo = minOn(box, axis) + t;
    const hi = maxOn(box, axis) - t;
    if (lo >= hi) return false;
    const origin = a[i]!;
    const delta = b[i]! - origin;
    if (Math.abs(delta) < 1e-9) {
      if (origin < lo || origin > hi) return false;
      continue;
    }
    const t1 = (lo - origin) / delta;
    const t2 = (hi - origin) / delta;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return false;
  }
  return true;
}

export function boxContainsPoint(box: CenteredBox, p: Vec3, tol = 0): boolean {
  return AXES.every(
    (a) => p[INDEX[a]]! >= minOn(box, a) - tol && p[INDEX[a]]! <= maxOn(box, a) + tol,
  );
}

export function distanceMm(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Which side of a horizontal divider the box's centre falls on. */
export function chamberOf(box: CenteredBox, deckY: number): "lower" | "upper" {
  return box.c[1] < deckY ? "lower" : "upper";
}

/** Weakest evidence of a set — a placement is only as trustworthy as its softest input. */
export function weakestEvidence(levels: EvidenceLevel[]): EvidenceLevel {
  const order: EvidenceLevel[] = ["official", "standard", "inferred", "unknown"];
  return levels.reduce(
    (worst, l) => (order.indexOf(l) > order.indexOf(worst) ? l : worst),
    "official" as EvidenceLevel,
  );
}
