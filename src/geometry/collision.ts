import { signedAabbClearanceMm } from "./tolerance";
import type { GeometryClearanceResult, ResolvedGeometryEntity } from "./types";

export interface ClearanceCheckOptions {
  readonly requiredServiceMarginMm?: number;
}

/**
 * A compatibility pass requires the worst-case envelopes to retain the full
 * service margin. A nominal collision is a hard failure; uncertainty crossing
 * the boundary is blocked pending better evidence.
 */
export function evaluateGeometryClearance(
  left: ResolvedGeometryEntity,
  right: ResolvedGeometryEntity,
  options: ClearanceCheckOptions = {},
): GeometryClearanceResult {
  const requiredServiceMarginMm = options.requiredServiceMarginMm ?? 0;
  if (!Number.isFinite(requiredServiceMarginMm) || requiredServiceMarginMm < 0) {
    throw new TypeError("required service margin must be finite and nonnegative");
  }
  const nominalClearanceMm = signedAabbClearanceMm(left.nominalAabb, right.nominalAabb);
  const worstCaseClearanceMm = signedAabbClearanceMm(left.worstCaseAabb, right.worstCaseAabb);
  if (nominalClearanceMm < 0) {
    return {
      schemaVersion: "geometry-clearance-v1",
      leftEntityId: left.entityId,
      rightEntityId: right.entityId,
      nominalClearanceMm,
      worstCaseClearanceMm,
      requiredServiceMarginMm,
      verdict: "fail",
      reason: "nominal_collision",
    };
  }
  if (worstCaseClearanceMm <= requiredServiceMarginMm) {
    return {
      schemaVersion: "geometry-clearance-v1",
      leftEntityId: left.entityId,
      rightEntityId: right.entityId,
      nominalClearanceMm,
      worstCaseClearanceMm,
      requiredServiceMarginMm,
      verdict: "blocked",
      reason: "tolerance_or_service_overlap",
    };
  }
  return {
    schemaVersion: "geometry-clearance-v1",
    leftEntityId: left.entityId,
    rightEntityId: right.entityId,
    nominalClearanceMm,
    worstCaseClearanceMm,
    requiredServiceMarginMm,
    verdict: "pass",
    reason: "clear_with_margin",
  };
}

export interface CollisionPair {
  readonly leftEntityId: string;
  readonly rightEntityId: string;
  readonly requiredServiceMarginMm?: number;
}

export function evaluateCollisionPairs(
  entities: readonly ResolvedGeometryEntity[],
  pairs: readonly CollisionPair[],
): readonly GeometryClearanceResult[] {
  const byId = new Map(entities.map((entity) => [entity.entityId, entity]));
  return pairs.map((pair) => {
    const left = byId.get(pair.leftEntityId);
    const right = byId.get(pair.rightEntityId);
    if (!left || !right) throw new TypeError("collision pair references an undeclared geometry entity");
    return evaluateGeometryClearance(left, right, pair.requiredServiceMarginMm === undefined
      ? {}
      : { requiredServiceMarginMm: pair.requiredServiceMarginMm });
  });
}
