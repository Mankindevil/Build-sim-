import type { VdevTopology } from "../topology/contracts";

export interface DiskCapacityInput {
  readonly instanceId: string;
  readonly capacityBytes: number;
}

export interface VdevCapacityResult {
  readonly usableBytes: number;
  readonly rawBytes: number;
  readonly mixedCapacityLossBytes: number;
  readonly faultToleranceDiskFailures: number;
}

export function minimumDiskCount(topology: VdevTopology): number {
  return topology === "stripe" ? 1 : topology === "mirror" ? 2 : topology === "raidz1" ? 3 : topology === "raidz2" ? 4 : 5;
}

export function parityWidth(topology: VdevTopology, diskCount: number): number {
  if (topology === "stripe") return 0;
  if (topology === "mirror") return Math.max(0, diskCount - 1);
  return topology === "raidz1" ? 1 : topology === "raidz2" ? 2 : 3;
}

export function calculateVdevCapacity(topology: VdevTopology, disks: readonly DiskCapacityInput[]): VdevCapacityResult {
  if (disks.length < minimumDiskCount(topology)) throw new RangeError(`${topology} requires at least ${minimumDiskCount(topology)} disks`);
  if (disks.some(({ capacityBytes }) => !Number.isSafeInteger(capacityBytes) || capacityBytes <= 0)) throw new TypeError("disk capacity must be a positive safe integer");
  if (new Set(disks.map(({ instanceId }) => instanceId)).size !== disks.length) throw new TypeError("vdev disks must be unique");
  const smallest = Math.min(...disks.map(({ capacityBytes }) => capacityBytes));
  const rawBytes = disks.reduce((sum, { capacityBytes }) => sum + capacityBytes, 0);
  const parity = parityWidth(topology, disks.length);
  const usableBytes = topology === "mirror" ? smallest : smallest * (disks.length - parity);
  return {
    usableBytes,
    rawBytes,
    mixedCapacityLossBytes: rawBytes - smallest * disks.length,
    faultToleranceDiskFailures: topology === "mirror" ? disks.length - 1 : parity,
  };
}
