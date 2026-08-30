import { describe, expect, it } from "vitest";
import { createAttachmentAnnotation } from "../src/attachments/annotations";
import {
  applyGeometryObservationOverrides,
  evaluateGeometryClearance,
  instantiateGeometry,
  type GeometryEntity,
  type GeometryProvenance,
  type Vec3Mm,
} from "../src/geometry";

const SOURCE: GeometryProvenance = { authority: "official", sourceRefs: ["fact:geometry"], derivationIds: [], scope: "product" };
const ZERO = { translationPlusMinusMm: [0, 0, 0] as Vec3Mm, rotationPlusMinusDeg: [0, 0, 0] as Vec3Mm };
const frames = [{
  frameId: "case", parentFrameId: null,
  pose: { positionMm: [0, 0, 0] as Vec3Mm, rotationDeg: [0, 0, 0] as Vec3Mm }, tolerance: ZERO, provenance: SOURCE,
}];
const component = (entityId: string, positionX: number): GeometryEntity => ({
  entityId, instanceId: entityId, kind: "component", frameId: "case", parentMountEntityId: null,
  localPose: { positionMm: [positionX, 0, 0], rotationDeg: [0, 0, 0] },
  envelope: { centerMm: [0, 0, 0], sizeMm: [10, 10, 10] }, insertionSweeps: [], tolerance: ZERO, provenance: SOURCE,
});

describe("plan-scoped geometry observation projection", () => {
  it("keeps a boundary-crossing observation blocked and returns to the base state after retraction", () => {
    const baseline = [component("left", 0), component("right", 15)];
    const override = {
      observationId: "observation-1", planId: "plan-1", instanceId: "right", entityId: "right",
      property: "position_x" as const, valueMm: 12, plusMinusMm: 2, method: "measurement" as const,
      annotationId: null, status: "active" as const,
    };
    const observed = applyGeometryObservationOverrides(baseline, [override]);
    const resolved = instantiateGeometry(frames, observed.entities, new Set(["left", "right"]));
    expect(evaluateGeometryClearance(resolved[0]!, resolved[1]!)).toMatchObject({
      nominalClearanceMm: 2, verdict: "blocked", reason: "tolerance_or_service_overlap",
    });
    const retracted = applyGeometryObservationOverrides(baseline, [{ ...override, status: "retracted" }]);
    const baseResolved = instantiateGeometry(frames, retracted.entities, new Set(["left", "right"]));
    expect(evaluateGeometryClearance(baseResolved[0]!, baseResolved[1]!)).toMatchObject({ verdict: "pass" });
    expect(retracted.applied).toEqual([]);
  });

  it("rejects a photo-derived absolute position unless the bound annotation has a scale", async () => {
    const baseline = [component("right", 15)];
    const relative = await createAttachmentAnnotation({
      annotationId: "relative", attachmentId: "attachment", planId: "plan-1",
      subject: { kind: "instance", instanceId: "right" }, kind: "two_point_distance",
      imageSizePx: { width: 100, height: 100 }, firstPx: { x: 0, y: 0 }, secondPx: { x: 50, y: 0 },
      scale: null, capturedAt: "2026-08-29T10:00:00.000Z",
    });
    const override = {
      observationId: "observation-photo", planId: "plan-1", instanceId: "right", entityId: "right",
      property: "position_x" as const, valueMm: 12, plusMinusMm: 1, method: "photo" as const,
      annotationId: relative.annotationId, status: "active" as const,
    };
    expect(() => applyGeometryObservationOverrides(baseline, [override], new Map([[relative.annotationId, relative]]))).toThrow(/unscaled photo/);
    const scaled = await createAttachmentAnnotation({
      annotationId: "scaled", attachmentId: "attachment", planId: "plan-1",
      subject: { kind: "instance", instanceId: "right" }, kind: "two_point_distance",
      imageSizePx: { width: 100, height: 100 }, firstPx: { x: 0, y: 0 }, secondPx: { x: 50, y: 0 },
      scale: { firstPx: { x: 0, y: 0 }, secondPx: { x: 25, y: 0 }, knownDistanceMm: 10, plusMinusMm: 0.5, authorityRef: "observation:scale" },
      capturedAt: "2026-08-29T10:00:00.000Z",
    });
    expect(applyGeometryObservationOverrides(baseline, [{ ...override, annotationId: scaled.annotationId }], new Map([[scaled.annotationId, scaled]])).applied).toHaveLength(1);
  });

  it("rejects observation scope swaps and concurrent values for one property", () => {
    const baseline = [component("right", 15)];
    const exact = {
      observationId: "one", planId: "plan-1", instanceId: "right", entityId: "right",
      property: "width" as const, valueMm: 12, plusMinusMm: 0.5, method: "measurement" as const,
      annotationId: null, status: "active" as const,
    };
    expect(() => applyGeometryObservationOverrides(baseline, [{ ...exact, instanceId: "other" }])).toThrow(/out of scope/);
    expect(() => applyGeometryObservationOverrides(baseline, [exact, { ...exact, observationId: "two" }])).toThrow(/same geometry property/);
  });
});
