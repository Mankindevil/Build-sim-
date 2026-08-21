import type { EvidenceLevel } from "./evidence";
import type { CenteredBox, PlacedPart, ThermalNodeId, Vec3 } from "./geometry";
import type { ComponentNode, Range, ThermalResult } from "./thermal";

/**
 * Spatial interpolation of the 0D thermal result, in millimetres.
 *
 * This adds **no physics** to `computeThermal`. Every heat source's temperature
 * is the component temperature that model already produced; all this module does
 * is place that number at the part's real centroid and decay it with distance so
 * a picture can be drawn. Two consequences worth stating plainly:
 *
 * - The field can never be hotter than the hottest source, and never cooler than
 *   ambient. There is no conduction, no convection cell, no pressure field.
 * - The deck at `barrierY` blocks diffusion. The 0D model treats the case as two
 *   chambers coupled only through a bottom-mounted PSU, so a picture that smears
 *   CPU heat onto the drive cage would contradict the model it is drawing.
 *
 * It is an interpolation of a lumped model. It is not CFD and it is not measured.
 */

export interface HeatSource {
  id: string;
  label: string;
  nodeId: ThermalNodeId;
  /** Centroid in case-local mm, taken from the geometry source of truth. */
  at: Vec3;
  /** Gaussian σ per axis, derived from the part's own extents. */
  sigmaMm: Vec3;
  watts: number;
  tempC: Range;
  chamber: "lower" | "upper";
  evidence: EvidenceLevel;
}

export interface FieldBounds {
  ambientC: number;
  barrierY: number;
  /** Cross-chamber leak fraction; 0 when the chambers share no opening. */
  barrierLeak: number;
  sources: HeatSource[];
}

export type FieldBound = "lo" | "hi";

/**
 * A part's thermal footprint is its own size: σ is half the extent plus a fixed
 * spreading length, so a 147 mm drive reads as a bar and a 37 mm die as a point.
 * `SPREAD_MM` is the one free parameter here and it is a drawing choice.
 */
const SPREAD_MM = 26;

function sigmaFor(box: CenteredBox): Vec3 {
  return [box.w / 2 + SPREAD_MM, box.h / 2 + SPREAD_MM, box.d / 2 + SPREAD_MM];
}

/**
 * Fraction of a source's rise that reaches across the deck. The manual gives no
 * opening geometry, so this is a single declared coefficient rather than a model:
 * zero when nothing bridges the chambers, and a wide-open value when a
 * lower-chamber PSU draws board-chamber air.
 */
export const BARRIER_LEAK_COUPLED = 0.35;

export function buildHeatSources(parts: PlacedPart[], thermal: ThermalResult): HeatSource[] {
  const byNode = new Map<ThermalNodeId, ComponentNode>();
  for (const node of thermal.components) byNode.set(node.id, node);

  const withNode = parts.filter((p) => p.thermalId && byNode.has(p.thermalId));
  // Component watts are per-part for drives (each tray is one node) and total for
  // the singletons, so splitting is only ever needed within one thermal id.
  const countByNode = new Map<ThermalNodeId, number>();
  for (const p of withNode) {
    countByNode.set(p.thermalId!, (countByNode.get(p.thermalId!) ?? 0) + 1);
  }

  return withNode.map((part) => {
    const node = byNode.get(part.thermalId!)!;
    const share = node.id === "hdd" ? 1 : (countByNode.get(node.id) ?? 1);
    return {
      id: part.id,
      label: countByNode.get(node.id)! > 1 ? `${node.label} · ${part.name}` : node.label,
      nodeId: node.id,
      at: [...part.box.c] as Vec3,
      sigmaMm: sigmaFor(part.box),
      watts: node.watts / share,
      tempC: node.tempC,
      chamber: part.chamber ?? node.chamber,
      evidence: node.evidence,
    };
  });
}

export function buildFieldBounds(
  parts: PlacedPart[],
  thermal: ThermalResult,
  barrierY: number,
): FieldBounds {
  return {
    ambientC: thermal.ambientC,
    barrierY,
    barrierLeak: thermal.coupling.active ? BARRIER_LEAK_COUPLED : 0,
    sources: buildHeatSources(parts, thermal),
  };
}

/**
 * Root-sum-square superposition of Gaussian rises above ambient, clipped to the
 * hottest declared source. RSS rather than a plain sum because two independent
 * hot parts do not add their full temperature rises; clipping because nothing in
 * the 0D model can justify a point hotter than its hottest input.
 */
export function sampleField(field: FieldBounds, at: Vec3, bound: FieldBound): number {
  let sumSquares = 0;
  let maxRise = 0;
  const sampleSide = at[1] < field.barrierY ? "lower" : "upper";

  for (const source of field.sources) {
    const rise = source.tempC[bound] - field.ambientC;
    if (rise <= 0) continue;
    maxRise = Math.max(maxRise, rise);
    const crossing = source.chamber !== sampleSide;
    const gate = crossing ? field.barrierLeak : 1;
    if (gate <= 0) continue;
    let exponent = 0;
    for (let i = 0; i < 3; i++) {
      const d = (at[i]! - source.at[i]!) / source.sigmaMm[i]!;
      exponent += d * d;
    }
    const q = rise * gate * Math.exp(-0.5 * exponent);
    sumSquares += q * q;
  }

  return field.ambientC + Math.min(maxRise, Math.sqrt(sumSquares));
}

export type SlicePlane = "xy" | "xz" | "yz";

export interface FieldSlice {
  plane: SlicePlane;
  /** Coordinate of the fixed axis, in mm. */
  offsetMm: number;
  /** Extent of the two varying axes; `[uMin, uMax, vMin, vMax]` in mm. */
  extentMm: [number, number, number, number];
  cols: number;
  rows: number;
  gridMm: number;
  /** Row-major temperatures at the `lo` bound. */
  lo: Float32Array;
  /** Row-major temperatures at the `hi` bound. */
  hi: Float32Array;
  minC: number;
  maxC: number;
}

const AXIS_OF: Record<SlicePlane, [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]> = {
  // [u axis, v axis, fixed axis]
  xy: [0, 1, 2],
  xz: [0, 2, 1],
  yz: [2, 1, 0],
};

/**
 * Orthographic slice on a millimetre-registered grid. Because the same geometry
 * that produced the sources also produces the outlines drawn on top, the
 * structure and the temperatures are in the same coordinate system for the first
 * time — a millimetre on the canvas is a millimetre in the case.
 */
export function sampleSlice(
  field: FieldBounds,
  plane: SlicePlane,
  offsetMm: number,
  extentMm: [number, number, number, number],
  gridMm: number,
): FieldSlice {
  const [uAxis, vAxis, fixedAxis] = AXIS_OF[plane];
  const [uMin, uMax, vMin, vMax] = extentMm;
  const cols = Math.max(1, Math.ceil((uMax - uMin) / gridMm));
  const rows = Math.max(1, Math.ceil((vMax - vMin) / gridMm));
  const lo = new Float32Array(cols * rows);
  const hi = new Float32Array(cols * rows);
  let minC = Infinity;
  let maxC = -Infinity;

  const at: Vec3 = [0, 0, 0];
  at[fixedAxis] = offsetMm;
  for (let r = 0; r < rows; r++) {
    at[vAxis] = vMin + (r + 0.5) * gridMm;
    for (let c = 0; c < cols; c++) {
      at[uAxis] = uMin + (c + 0.5) * gridMm;
      const i = r * cols + c;
      lo[i] = sampleField(field, at, "lo");
      hi[i] = sampleField(field, at, "hi");
      if (lo[i]! < minC) minC = lo[i]!;
      if (hi[i]! > maxC) maxC = hi[i]!;
    }
  }

  return { plane, offsetMm, extentMm, cols, rows, gridMm, lo, hi, minC, maxC };
}

/** Peak of a bound across the slice, for badges and captions. */
export function slicePeakC(slice: FieldSlice, bound: FieldBound): number {
  const data = bound === "lo" ? slice.lo : slice.hi;
  let peak = -Infinity;
  for (const v of data) if (v > peak) peak = v;
  return peak;
}
