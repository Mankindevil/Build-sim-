import type { AttachmentAnnotation } from "../attachments/annotations";
import type { GeometryEntity, Vec3Mm } from "./types";

export interface GeometryObservationOverride {
  readonly observationId: string;
  readonly planId: string;
  readonly instanceId: string;
  readonly entityId: string;
  readonly property: "position_x" | "position_y" | "position_z" | "width" | "height" | "depth";
  readonly valueMm: number;
  readonly plusMinusMm: number;
  readonly method: "measurement" | "photo";
  readonly annotationId: string | null;
  readonly status: "active" | "retracted";
}

export interface AppliedGeometryObservation {
  readonly observationId: string;
  readonly entityId: string;
  readonly property: GeometryObservationOverride["property"];
  readonly dependentEntityId: string;
}

function annotationSupportsAbsoluteMeasurement(
  value: GeometryObservationOverride,
  annotations: ReadonlyMap<string, AttachmentAnnotation>,
): boolean {
  if (value.method !== "photo") return true;
  if (value.annotationId === null) return false;
  const annotation = annotations.get(value.annotationId);
  return Boolean(annotation && annotation.planId === value.planId
    && annotation.measurement.status === "absolute" && annotation.measurement.valueMm !== null);
}

export function applyGeometryObservationOverrides(
  entities: readonly GeometryEntity[],
  overrides: readonly GeometryObservationOverride[],
  annotations: ReadonlyMap<string, AttachmentAnnotation> = new Map(),
): { readonly entities: readonly GeometryEntity[]; readonly applied: readonly AppliedGeometryObservation[] } {
  const byId = new Map(entities.map((entity) => [entity.entityId, structuredClone(entity)]));
  const occupied = new Set<string>();
  const applied: AppliedGeometryObservation[] = [];
  for (const value of [...overrides].sort((left, right) => left.observationId.localeCompare(right.observationId))) {
    if (value.status === "retracted") continue;
    const entity = byId.get(value.entityId);
    if (!entity || entity.instanceId !== value.instanceId || !Number.isFinite(value.valueMm)
      || !Number.isFinite(value.plusMinusMm) || value.plusMinusMm < 0) {
      throw new TypeError("geometry observation override is invalid or out of scope");
    }
    if (!annotationSupportsAbsoluteMeasurement(value, annotations)) {
      throw new TypeError("unscaled photo cannot produce an absolute geometry value");
    }
    const slot = `${value.entityId}:${value.property}`;
    if (occupied.has(slot)) throw new TypeError("multiple active observations target the same geometry property");
    occupied.add(slot);
    const axis = value.property.endsWith("_x") || value.property === "width" ? 0
      : value.property.endsWith("_y") || value.property === "height" ? 1 : 2;
    let next: GeometryEntity;
    if (value.property.startsWith("position_")) {
      const position = [...entity.localPose.positionMm] as [number, number, number];
      position[axis] = value.valueMm;
      next = { ...entity, localPose: { ...entity.localPose, positionMm: position } };
    } else {
      if (value.valueMm <= 0) throw new TypeError("observed geometry dimension must be positive");
      const size = [...entity.envelope.sizeMm] as [number, number, number];
      size[axis] = value.valueMm;
      next = { ...entity, envelope: { ...entity.envelope, sizeMm: size } };
    }
    const translation = [...next.tolerance.translationPlusMinusMm] as [number, number, number];
    translation[axis] = Math.max(translation[axis], value.plusMinusMm);
    next = {
      ...next,
      tolerance: { ...next.tolerance, translationPlusMinusMm: translation },
      provenance: {
      authority: "user_observation",
      sourceRefs: [...new Set([...next.provenance.sourceRefs, `observation:${value.observationId}`])].sort(),
      derivationIds: [...next.provenance.derivationIds],
      scope: "observation",
      },
    };
    byId.set(value.entityId, next);
    applied.push({ observationId: value.observationId, entityId: value.entityId, property: value.property, dependentEntityId: value.entityId });
  }
  return { entities: [...byId.values()].sort((left, right) => left.entityId.localeCompare(right.entityId)), applied };
}
