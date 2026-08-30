import { evaluateGeometryClearance } from "./collision";
import { inflateAabb } from "./tolerance";
import type { GeometryClearanceResult, ResolvedGeometryEntity, Vec3Mm } from "./types";

export interface ServiceSpaceRequirement {
  readonly entityId: string;
  readonly obstacleEntityIds: readonly string[];
  readonly marginMm: number | Vec3Mm;
}

export function evaluateServiceSpace(
  entities: readonly ResolvedGeometryEntity[],
  requirement: ServiceSpaceRequirement,
): readonly GeometryClearanceResult[] {
  const byId = new Map(entities.map((entity) => [entity.entityId, entity]));
  const subject = byId.get(requirement.entityId);
  if (!subject) throw new TypeError("service-space subject is missing");
  const margin = typeof requirement.marginMm === "number"
    ? requirement.marginMm
    : Math.max(...requirement.marginMm);
  const serviceSubject: ResolvedGeometryEntity = {
    ...subject,
    nominalAabb: inflateAabb(subject.nominalAabb, requirement.marginMm),
    worstCaseAabb: inflateAabb(subject.worstCaseAabb, requirement.marginMm),
  };
  return requirement.obstacleEntityIds.map((obstacleId) => {
    const obstacle = byId.get(obstacleId);
    if (!obstacle) throw new TypeError("service-space obstacle is missing");
    const result = evaluateGeometryClearance(serviceSubject, obstacle);
    return { ...result, requiredServiceMarginMm: margin };
  });
}
