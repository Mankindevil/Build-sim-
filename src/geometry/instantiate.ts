import { matrixPose, multiplyMatrix, poseMatrix, resolveCoordinateFrames, transformPoint, type Matrix4 } from "./frames";
import {
  assertValidAabb,
  assertValidPose,
  assertValidTolerance,
  type Aabb3Mm,
  type GeometryEntity,
  type PoseTolerance,
  type ResolvedGeometryEntity,
  type Vec3Mm,
} from "./types";

function corners(box: Aabb3Mm): Vec3Mm[] {
  const half = box.sizeMm.map((entry) => entry / 2);
  return [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [
    box.centerMm[0] + x * half[0]!,
    box.centerMm[1] + y * half[1]!,
    box.centerMm[2] + z * half[2]!,
  ] as Vec3Mm)));
}

function aabbForPoints(points: readonly Vec3Mm[]): Aabb3Mm {
  const minimum: number[] = [Infinity, Infinity, Infinity];
  const maximum: number[] = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis += 1) {
    minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
    maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
  }
  return {
    centerMm: minimum.map((entry, axis) => (entry + maximum[axis]!) / 2) as unknown as Vec3Mm,
    sizeMm: minimum.map((entry, axis) => maximum[axis]! - entry) as unknown as Vec3Mm,
  };
}

export function transformAabb(matrix: Matrix4, box: Aabb3Mm): Aabb3Mm {
  assertValidAabb(box);
  return aabbForPoints(corners(box).map((point) => transformPoint(matrix, point)));
}

function addTolerance(...values: PoseTolerance[]): PoseTolerance {
  return {
    translationPlusMinusMm: [0, 1, 2].map((axis) => values.reduce((total, value) => total + value.translationPlusMinusMm[axis]!, 0)) as unknown as Vec3Mm,
    rotationPlusMinusDeg: [0, 1, 2].map((axis) => values.reduce((total, value) => total + value.rotationPlusMinusDeg[axis]!, 0)) as unknown as Vec3Mm,
  };
}

/** Conservative AABB: translation expands per axis; angular error expands by the entity bounding radius. */
export function expandAabbForTolerance(box: Aabb3Mm, tolerance: PoseTolerance): Aabb3Mm {
  assertValidAabb(box); assertValidTolerance(tolerance);
  const radius = Math.hypot(...box.sizeMm.map((entry) => entry / 2));
  const angularRadians = Math.min(Math.PI / 2, tolerance.rotationPlusMinusDeg.reduce((sum, value) => sum + value, 0) * Math.PI / 180);
  const rotationalExpansion = radius * Math.sin(angularRadians);
  return {
    centerMm: [...box.centerMm] as unknown as Vec3Mm,
    sizeMm: box.sizeMm.map((entry, axis) => entry + 2 * (tolerance.translationPlusMinusMm[axis]! + rotationalExpansion)) as unknown as Vec3Mm,
  };
}

/** Instantiates only declared entities; topology callers cannot smuggle undeclared/absent instances. */
export function instantiateGeometry(
  frames: Parameters<typeof resolveCoordinateFrames>[0],
  entities: readonly GeometryEntity[],
  presentInstanceIds?: ReadonlySet<string>,
): readonly ResolvedGeometryEntity[] {
  const resolvedFrames = resolveCoordinateFrames(frames);
  const byId = new Map<string, GeometryEntity>();
  for (const entity of entities) {
    if (!entity.entityId || byId.has(entity.entityId)) throw new TypeError("geometry entity identity is invalid");
    if (entity.instanceId !== null && presentInstanceIds && !presentInstanceIds.has(entity.instanceId)) {
      throw new TypeError(`geometry entity ${entity.entityId} references an absent topology instance`);
    }
    if (!resolvedFrames.has(entity.frameId)) throw new TypeError(`geometry entity ${entity.entityId} frame is missing`);
    assertValidPose(entity.localPose, `entity ${entity.entityId} pose`);
    assertValidAabb(entity.envelope, `entity ${entity.entityId} envelope`);
    assertValidTolerance(entity.tolerance, `entity ${entity.entityId} tolerance`);
    entity.insertionSweeps.forEach((sweep) => assertValidAabb(sweep, `entity ${entity.entityId} insertion sweep`));
    byId.set(entity.entityId, entity);
  }
  const result = new Map<string, ResolvedGeometryEntity>();
  const visiting = new Set<string>();
  const resolve = (entityId: string): ResolvedGeometryEntity => {
    const cached = result.get(entityId); if (cached) return cached;
    const entity = byId.get(entityId); if (!entity) throw new TypeError(`parent mount entity ${entityId} is missing`);
    if (visiting.has(entityId)) throw new TypeError("geometry parent mount hierarchy contains a cycle");
    visiting.add(entityId);
    const frame = resolvedFrames.get(entity.frameId)!;
    const parent = entity.parentMountEntityId === null ? null : resolve(entity.parentMountEntityId);
    const baseMatrix = parent ? poseMatrix(parent.worldPose) : frame.worldMatrix;
    const worldMatrix = multiplyMatrix(baseMatrix, poseMatrix(entity.localPose));
    const nominalAabb = transformAabb(worldMatrix, entity.envelope);
    const accumulatedTolerance = parent
      ? addTolerance(parent.worldTolerance, entity.tolerance)
      : addTolerance(frame.accumulatedTolerance, entity.tolerance);
    const nominalInsertionSweeps = entity.insertionSweeps.map((sweep) => transformAabb(worldMatrix, sweep));
    const value: ResolvedGeometryEntity = {
      ...structuredClone(entity),
      worldPose: matrixPose(worldMatrix),
      worldTolerance: accumulatedTolerance,
      nominalAabb,
      worstCaseAabb: expandAabbForTolerance(nominalAabb, accumulatedTolerance),
      nominalInsertionSweeps,
      worstCaseInsertionSweeps: nominalInsertionSweeps.map((sweep) => expandAabbForTolerance(sweep, accumulatedTolerance)),
    };
    result.set(entityId, value); visiting.delete(entityId); return value;
  };
  for (const entityId of byId.keys()) resolve(entityId);
  return [...result.values()].sort((left, right) => left.entityId.localeCompare(right.entityId));
}
