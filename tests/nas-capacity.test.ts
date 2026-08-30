import { describe, expect, it } from "vitest";
import { calculateVdevCapacity, minimumDiskCount } from "../src/storage/capacity";

describe("U7 NAS capacity", () => {
  const disks = (...sizes: number[]) => sizes.map((capacityBytes, index) => ({ instanceId: `disk-${index}`, capacityBytes }));

  it("derives mirror and RAIDZ capacity from the smallest member", () => {
    expect(calculateVdevCapacity("mirror", disks(1_000, 900))).toEqual({ usableBytes: 900, rawBytes: 1_900, mixedCapacityLossBytes: 100, faultToleranceDiskFailures: 1 });
    expect(calculateVdevCapacity("raidz1", disks(1_000, 1_000, 900))).toEqual({ usableBytes: 1_800, rawBytes: 2_900, mixedCapacityLossBytes: 200, faultToleranceDiskFailures: 1 });
    expect(calculateVdevCapacity("raidz2", disks(1_000, 1_000, 1_000, 1_000)).usableBytes).toBe(2_000);
  });

  it("fails closed below the topology minimum", () => {
    expect(minimumDiskCount("raidz3")).toBe(5);
    expect(() => calculateVdevCapacity("raidz2", disks(1_000, 1_000, 1_000))).toThrow(/requires at least 4 disks/);
  });
});
