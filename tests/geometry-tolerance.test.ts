import { describe, expect, it } from "vitest";
import {
  evaluateGeometryClearance,
  instantiateGeometry,
  resolveCoordinateFrames,
  signedAabbClearanceMm,
  type GeometryEntity,
  type GeometryProvenance,
  type LocalCoordinateFrame,
  type PoseTolerance,
  type Vec3Mm,
} from "../src/geometry";

const SOURCE: GeometryProvenance = {
  authority: "official",
  sourceRefs: ["fact:case.geometry"],
  derivationIds: [],
  scope: "product",
};

const zeroTolerance = (): PoseTolerance => ({
  translationPlusMinusMm: [0, 0, 0],
  rotationPlusMinusDeg: [0, 0, 0],
});

function frame(
  frameId: string,
  parentFrameId: string | null,
  positionMm: Vec3Mm,
  rotationDeg: Vec3Mm = [0, 0, 0],
  translationToleranceMm: Vec3Mm = [0, 0, 0],
): LocalCoordinateFrame {
  return {
    frameId,
    parentFrameId,
    pose: { positionMm, rotationDeg },
    tolerance: { translationPlusMinusMm: translationToleranceMm, rotationPlusMinusDeg: [0, 0, 0] },
    provenance: SOURCE,
  };
}

function entity(
  entityId: string,
  positionMm: Vec3Mm,
  sizeMm: Vec3Mm = [10, 10, 10],
  tolerance: PoseTolerance = zeroTolerance(),
  parentMountEntityId: string | null = null,
  instanceId: string | null = entityId,
): GeometryEntity {
  return {
    entityId,
    instanceId,
    kind: "component",
    frameId: "case",
    parentMountEntityId,
    localPose: { positionMm, rotationDeg: [0, 0, 0] },
    envelope: { centerMm: [0, 0, 0], sizeMm },
    insertionSweeps: [{ centerMm: [0, 0, -5], sizeMm: [10, 10, 20] }],
    tolerance,
    provenance: SOURCE,
  };
}

describe("generic 6DoF geometry and tolerance", () => {
  it("resolves nested coordinate frames and parent mounts without fixed case coordinates", () => {
    const frames = [
      frame("world", null, [10, 0, 0], [0, 0, 90]),
      frame("case", "world", [5, 0, 0], [0, 0, 0], [0.5, 0.5, 0.5]),
    ];
    const resolvedFrames = resolveCoordinateFrames(frames);
    expect(resolvedFrames.get("case")?.worldPose.positionMm[0]).toBeCloseTo(10, 6);
    expect(resolvedFrames.get("case")?.worldPose.positionMm[1]).toBeCloseTo(5, 6);

    const values = instantiateGeometry(frames, [
      entity("mount", [10, 0, 0], [4, 4, 4]),
      entity("device", [0, 5, 0], [6, 8, 10], {
        translationPlusMinusMm: [0.25, 0.25, 0.25],
        rotationPlusMinusDeg: [0, 0, 1],
      }, "mount"),
    ], new Set(["mount", "device"]));
    const device = values.find(({ entityId }) => entityId === "device")!;
    expect(device.worldPose.positionMm).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(device.worldTolerance.translationPlusMinusMm).toEqual([0.75, 0.75, 0.75]);
    expect(device.nominalInsertionSweeps).toHaveLength(1);
    expect(device.worstCaseInsertionSweeps[0]!.sizeMm[0]).toBeGreaterThan(10);
  });

  it("passes only when worst-case clearance exceeds the service margin", () => {
    const frames = [frame("case", null, [0, 0, 0])];
    const values = instantiateGeometry(frames, [
      entity("left", [0, 0, 0]),
      entity("right", [17, 0, 0]),
    ], new Set(["left", "right"]));
    expect(evaluateGeometryClearance(values[0]!, values[1]!, { requiredServiceMarginMm: 5 })).toMatchObject({
      nominalClearanceMm: 7,
      worstCaseClearanceMm: 7,
      verdict: "pass",
      reason: "clear_with_margin",
    });
  });

  it("blocks a nominally clear placement when uncertainty crosses the service boundary", () => {
    const frames = [frame("case", null, [0, 0, 0])];
    const tolerance = { translationPlusMinusMm: [1.5, 0, 0] as Vec3Mm, rotationPlusMinusDeg: [0, 0, 0] as Vec3Mm };
    const values = instantiateGeometry(frames, [
      entity("left", [0, 0, 0], [10, 10, 10], tolerance),
      entity("right", [13, 0, 0], [10, 10, 10], tolerance),
    ], new Set(["left", "right"]));
    expect(evaluateGeometryClearance(values[0]!, values[1]!)).toMatchObject({
      nominalClearanceMm: 3,
      worstCaseClearanceMm: 0,
      verdict: "blocked",
      reason: "tolerance_or_service_overlap",
    });
  });

  it("fails a nominal collision", () => {
    const frames = [frame("case", null, [0, 0, 0])];
    const values = instantiateGeometry(frames, [entity("left", [0, 0, 0]), entity("right", [8, 0, 0])]);
    expect(signedAabbClearanceMm(values[0]!.nominalAabb, values[1]!.nominalAabb)).toBe(-2);
    expect(evaluateGeometryClearance(values[0]!, values[1]!)).toMatchObject({ verdict: "fail", reason: "nominal_collision" });
  });

  it("rejects undeclared topology instances and cyclic mount/frame hierarchies", () => {
    const frames = [frame("case", null, [0, 0, 0])];
    expect(() => instantiateGeometry(frames, [entity("ghost", [0, 0, 0], [1, 1, 1], zeroTolerance(), null, "missing")], new Set())).toThrow(/absent topology instance/);
    expect(() => instantiateGeometry(frames, [
      entity("a", [0, 0, 0], [1, 1, 1], zeroTolerance(), "b"),
      entity("b", [0, 0, 0], [1, 1, 1], zeroTolerance(), "a"),
    ])).toThrow(/cycle/);
    expect(() => resolveCoordinateFrames([
      frame("a", "b", [0, 0, 0]),
      frame("b", "a", [0, 0, 0]),
    ])).toThrow(/cycle/);
  });
});
