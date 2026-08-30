export interface CableBundleMember {
  readonly cableInstanceId: string;
  readonly outerDiameterMm: number;
}

export interface BundleCapacityResult {
  readonly capacityAreaMm2: number;
  readonly allowedFillAreaMm2: number;
  readonly occupiedAreaMm2: number;
  readonly verdict: "pass" | "fail";
}

export function evaluateBundleCapacity(
  capacityAreaMm2: number,
  members: readonly CableBundleMember[],
  maximumFillRatio = 0.6,
): BundleCapacityResult {
  if (!Number.isFinite(capacityAreaMm2) || capacityAreaMm2 <= 0
    || !Number.isFinite(maximumFillRatio) || maximumFillRatio <= 0 || maximumFillRatio > 1) {
    throw new TypeError("bundle capacity parameters are invalid");
  }
  const ids = new Set<string>();
  let occupiedAreaMm2 = 0;
  for (const member of members) {
    if (!member.cableInstanceId || ids.has(member.cableInstanceId)
      || !Number.isFinite(member.outerDiameterMm) || member.outerDiameterMm <= 0) {
      throw new TypeError("bundle member is invalid");
    }
    ids.add(member.cableInstanceId);
    occupiedAreaMm2 += Math.PI * (member.outerDiameterMm / 2) ** 2;
  }
  const allowedFillAreaMm2 = capacityAreaMm2 * maximumFillRatio;
  return {
    capacityAreaMm2,
    allowedFillAreaMm2,
    occupiedAreaMm2,
    verdict: occupiedAreaMm2 <= allowedFillAreaMm2 ? "pass" : "fail",
  };
}
