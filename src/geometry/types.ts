import type { FactAuthority } from "../facts/field-registry";

export type Vec3Mm = readonly [number, number, number];
export type EulerDegrees = readonly [number, number, number];

export interface Pose6D {
  readonly positionMm: Vec3Mm;
  /** Intrinsic XYZ rotation in degrees. */
  readonly rotationDeg: EulerDegrees;
}

export interface PoseTolerance {
  readonly translationPlusMinusMm: Vec3Mm;
  readonly rotationPlusMinusDeg: EulerDegrees;
}

export interface Aabb3Mm {
  readonly centerMm: Vec3Mm;
  readonly sizeMm: Vec3Mm;
}

export interface GeometryProvenance {
  readonly authority: FactAuthority | "standard" | "derived";
  readonly sourceRefs: readonly string[];
  readonly derivationIds: readonly string[];
  readonly scope: "product" | "plan_instance" | "observation";
}

export interface LocalCoordinateFrame {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly pose: Pose6D;
  readonly tolerance: PoseTolerance;
  readonly provenance: GeometryProvenance;
}

export interface GeometryEntity {
  readonly entityId: string;
  readonly instanceId: string | null;
  readonly kind: "case" | "component" | "mount" | "port" | "cable" | "clearance" | "service" | "forbidden";
  readonly frameId: string;
  readonly parentMountEntityId: string | null;
  readonly localPose: Pose6D;
  readonly envelope: Aabb3Mm;
  readonly insertionSweeps: readonly Aabb3Mm[];
  readonly tolerance: PoseTolerance;
  readonly provenance: GeometryProvenance;
}

export interface ResolvedGeometryEntity extends GeometryEntity {
  readonly worldPose: Pose6D;
  readonly worldTolerance: PoseTolerance;
  readonly nominalAabb: Aabb3Mm;
  /** Conservative envelope over all translation/rotation tolerance extremes. */
  readonly worstCaseAabb: Aabb3Mm;
  readonly nominalInsertionSweeps: readonly Aabb3Mm[];
  readonly worstCaseInsertionSweeps: readonly Aabb3Mm[];
}

export interface GeometryClearanceResult {
  readonly schemaVersion: "geometry-clearance-v1";
  readonly leftEntityId: string;
  readonly rightEntityId: string;
  readonly nominalClearanceMm: number;
  readonly worstCaseClearanceMm: number;
  readonly requiredServiceMarginMm: number;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly reason: "clear_with_margin" | "nominal_collision" | "tolerance_or_service_overlap";
}

export const ZERO_POSE: Pose6D = Object.freeze({
  positionMm: Object.freeze([0, 0, 0] as const),
  rotationDeg: Object.freeze([0, 0, 0] as const),
});

export const ZERO_TOLERANCE: PoseTolerance = Object.freeze({
  translationPlusMinusMm: Object.freeze([0, 0, 0] as const),
  rotationPlusMinusDeg: Object.freeze([0, 0, 0] as const),
});

export function validFiniteVec3(value: unknown, nonnegative = false): value is Vec3Mm {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => (
    typeof entry === "number" && Number.isFinite(entry) && (!nonnegative || entry >= 0)
  ));
}

export function assertValidAabb(value: Aabb3Mm, label = "geometry AABB"): void {
  if (!validFiniteVec3(value.centerMm) || !validFiniteVec3(value.sizeMm)
    || value.sizeMm.some((entry) => entry <= 0)) throw new TypeError(`${label} is invalid`);
}

export function assertValidPose(value: Pose6D, label = "geometry pose"): void {
  if (!validFiniteVec3(value.positionMm) || !validFiniteVec3(value.rotationDeg)) {
    throw new TypeError(`${label} is invalid`);
  }
}

export function assertValidTolerance(value: PoseTolerance, label = "geometry tolerance"): void {
  if (!validFiniteVec3(value.translationPlusMinusMm, true)
    || !validFiniteVec3(value.rotationPlusMinusDeg, true)) throw new TypeError(`${label} is invalid`);
}
