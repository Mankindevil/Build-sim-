import { describe, expect, it } from "vitest";
import { createAttachmentAnnotation, decisionsAffectedByAnnotation } from "../src/attachments/annotations";

const base = {
  annotationId: "annotation-1",
  attachmentId: "attachment-1",
  planId: "plan-1",
  subject: { kind: "port" as const, instanceId: "case-1", portId: "grommet-1" },
  imageSizePx: { width: 1000, height: 800 },
  firstPx: { x: 100, y: 200 },
  secondPx: { x: 300, y: 200 },
  capturedAt: "2026-08-29T10:00:00.000Z",
};

describe("attachment spatial annotations", () => {
  it("keeps an unscaled photograph relative and never emits absolute millimetres", async () => {
    const annotation = await createAttachmentAnnotation({
      ...base, kind: "two_point_distance", scale: null,
    });
    expect(annotation).toMatchObject({
      pixelDistance: 200,
      measurement: { status: "relative_only", valueMm: null, plusMinusMm: null },
    });
    expect(annotation.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("derives a bounded distance only from an explicit scale reference", async () => {
    const annotation = await createAttachmentAnnotation({
      ...base,
      kind: "two_point_distance",
      scale: {
        firstPx: { x: 0, y: 0 }, secondPx: { x: 100, y: 0 },
        knownDistanceMm: 50, plusMinusMm: 0.5, authorityRef: "observation:scale-1",
      },
    });
    expect(annotation.measurement.status).toBe("absolute");
    expect(annotation.measurement.valueMm).toBe(100);
    expect(annotation.measurement.plusMinusMm).toBeGreaterThan(1);
    expect(annotation.measurement.plusMinusMm).toBeLessThan(3);
  });

  it("records interface direction without falsely attaching a distance scale", async () => {
    const annotation = await createAttachmentAnnotation({
      ...base, kind: "interface_direction", scale: null,
      firstPx: { x: 20, y: 20 }, secondPx: { x: 20, y: 120 },
    });
    expect(annotation.directionImageUnit).toEqual([0, 1]);
    expect(annotation.measurement).toEqual({ status: "direction_only", valueMm: null, plusMinusMm: null });
    await expect(createAttachmentAnnotation({
      ...base, kind: "interface_direction",
      scale: { firstPx: { x: 0, y: 0 }, secondPx: { x: 10, y: 0 }, knownDistanceMm: 10, plusMinusMm: 0, authorityRef: "obs" },
    })).rejects.toThrow(/must not claim a distance scale/);
  });

  it("invalidates only decisions bound to the changed annotation", () => {
    expect(decisionsAffectedByAnnotation([
      { decisionId: "clearance-a", annotationIds: ["annotation-1"] },
      { decisionId: "route-b", annotationIds: ["annotation-2"] },
      { decisionId: "route-c", annotationIds: ["annotation-1", "annotation-3"] },
    ], "annotation-1")).toEqual(["clearance-a", "route-c"]);
  });
});
