import {
  assertValidPose,
  assertValidTolerance,
  type EulerDegrees,
  type LocalCoordinateFrame,
  type Pose6D,
  type PoseTolerance,
  type Vec3Mm,
} from "./types";

export type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

const radians = (degrees: number): number => degrees * Math.PI / 180;

export function poseMatrix(pose: Pose6D): Matrix4 {
  assertValidPose(pose);
  const rx = radians(pose.rotationDeg[0]);
  const ry = radians(pose.rotationDeg[1]);
  const rz = radians(pose.rotationDeg[2]);
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  // Rz * Ry * Rx, stored row-major.
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, pose.positionMm[0],
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, pose.positionMm[1],
    -sy, cy * sx, cy * cx, pose.positionMm[2],
    0, 0, 0, 1,
  ];
}

export function multiplyMatrix(left: Matrix4, right: Matrix4): Matrix4 {
  const output = Array.from({ length: 16 }, () => 0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) value += left[row * 4 + index]! * right[index * 4 + column]!;
      output[row * 4 + column] = value;
    }
  }
  return output as unknown as Matrix4;
}

export function transformPoint(matrix: Matrix4, point: Vec3Mm): Vec3Mm {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2] + matrix[3],
    matrix[4] * point[0] + matrix[5] * point[1] + matrix[6] * point[2] + matrix[7],
    matrix[8] * point[0] + matrix[9] * point[1] + matrix[10] * point[2] + matrix[11],
  ];
}

function matrixEuler(matrix: Matrix4): EulerDegrees {
  const sy = Math.max(-1, Math.min(1, -matrix[8]));
  const ry = Math.asin(sy);
  const cy = Math.cos(ry);
  let rx: number;
  let rz: number;
  if (Math.abs(cy) > 1e-9) {
    rx = Math.atan2(matrix[9], matrix[10]);
    rz = Math.atan2(matrix[4], matrix[0]);
  } else {
    rx = Math.atan2(-matrix[6], matrix[5]);
    rz = 0;
  }
  return [rx * 180 / Math.PI, ry * 180 / Math.PI, rz * 180 / Math.PI];
}

export function matrixPose(matrix: Matrix4): Pose6D {
  return { positionMm: [matrix[3], matrix[7], matrix[11]], rotationDeg: matrixEuler(matrix) };
}

function addTolerance(left: PoseTolerance, right: PoseTolerance): PoseTolerance {
  return {
    translationPlusMinusMm: left.translationPlusMinusMm.map((value, index) => value + right.translationPlusMinusMm[index]!) as unknown as Vec3Mm,
    rotationPlusMinusDeg: left.rotationPlusMinusDeg.map((value, index) => value + right.rotationPlusMinusDeg[index]!) as unknown as EulerDegrees,
  };
}

export interface ResolvedCoordinateFrame {
  readonly frameId: string;
  readonly worldMatrix: Matrix4;
  readonly worldPose: Pose6D;
  readonly accumulatedTolerance: PoseTolerance;
}

/** Resolves a strict acyclic frame hierarchy. Missing parents and cycles fail closed. */
export function resolveCoordinateFrames(frames: readonly LocalCoordinateFrame[]): ReadonlyMap<string, ResolvedCoordinateFrame> {
  const byId = new Map<string, LocalCoordinateFrame>();
  for (const frame of frames) {
    if (!frame.frameId || byId.has(frame.frameId) || frame.parentFrameId === frame.frameId) throw new TypeError("coordinate frame identity is invalid");
    assertValidPose(frame.pose, `frame ${frame.frameId} pose`);
    assertValidTolerance(frame.tolerance, `frame ${frame.frameId} tolerance`);
    byId.set(frame.frameId, frame);
  }
  const result = new Map<string, ResolvedCoordinateFrame>();
  const visiting = new Set<string>();
  const resolve = (frameId: string): ResolvedCoordinateFrame => {
    const cached = result.get(frameId); if (cached) return cached;
    const frame = byId.get(frameId); if (!frame) throw new TypeError(`coordinate frame ${frameId} is missing`);
    if (visiting.has(frameId)) throw new TypeError("coordinate frame hierarchy contains a cycle");
    visiting.add(frameId);
    const parent = frame.parentFrameId === null ? null : resolve(frame.parentFrameId);
    const worldMatrix = parent ? multiplyMatrix(parent.worldMatrix, poseMatrix(frame.pose)) : poseMatrix(frame.pose);
    const accumulatedTolerance = parent ? addTolerance(parent.accumulatedTolerance, frame.tolerance) : structuredClone(frame.tolerance);
    const value = { frameId, worldMatrix, worldPose: matrixPose(worldMatrix), accumulatedTolerance };
    result.set(frameId, value); visiting.delete(frameId); return value;
  };
  for (const frameId of byId.keys()) resolve(frameId);
  return result;
}
