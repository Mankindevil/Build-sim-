import type { Vec3Mm } from "../geometry";

export interface BendCheck {
  readonly vertexIndex: number;
  readonly angleDeg: number;
  readonly requiredTangentMm: number;
  readonly availableBeforeMm: number;
  readonly availableAfterMm: number;
  readonly pass: boolean;
}

const distance = (left: Vec3Mm, right: Vec3Mm): number => Math.hypot(
  right[0] - left[0], right[1] - left[1], right[2] - left[2],
);

export function evaluatePolylineBends(points: readonly Vec3Mm[], minimumBendRadiusMm: number): readonly BendCheck[] {
  if (!Number.isFinite(minimumBendRadiusMm) || minimumBendRadiusMm <= 0) throw new TypeError("minimum bend radius is invalid");
  if (points.length < 2) throw new TypeError("route polyline requires two endpoints");
  const checks: BendCheck[] = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const before = [previous[0] - current[0], previous[1] - current[1], previous[2] - current[2]] as Vec3Mm;
    const after = [next[0] - current[0], next[1] - current[1], next[2] - current[2]] as Vec3Mm;
    const beforeLength = distance(previous, current);
    const afterLength = distance(current, next);
    if (beforeLength <= 0 || afterLength <= 0) throw new TypeError("route polyline contains a zero-length segment");
    const cosine = Math.max(-1, Math.min(1, (
      before[0] * after[0] + before[1] * after[1] + before[2] * after[2]
    ) / (beforeLength * afterLength)));
    const angle = Math.acos(cosine);
    const turnAngle = Math.PI - angle;
    const requiredTangentMm = minimumBendRadiusMm * Math.tan(turnAngle / 2);
    checks.push({
      vertexIndex: index,
      angleDeg: turnAngle * 180 / Math.PI,
      requiredTangentMm,
      availableBeforeMm: beforeLength,
      availableAfterMm: afterLength,
      pass: requiredTangentMm <= beforeLength && requiredTangentMm <= afterLength,
    });
  }
  return checks;
}
