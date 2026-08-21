import type { BootMode, BuildSelection } from "../config/types";

export interface HbaPolicy {
  autoWhenSataDevicesOver: number;
}

export function sataDeviceCount(diskCount: number, boot: BootMode): number {
  return diskCount + (boot === "bay" ? 1 : 0);
}

/** Shared HBA trigger — used by evaluate, occupancy, and wiring. */
export function needsHba(
  selection: Pick<BuildSelection, "hbaMode" | "diskCount" | "boot">,
  policy: HbaPolicy,
): boolean {
  if (selection.hbaMode === "always") return true;
  return sataDeviceCount(selection.diskCount, selection.boot) > policy.autoWhenSataDevicesOver;
}
