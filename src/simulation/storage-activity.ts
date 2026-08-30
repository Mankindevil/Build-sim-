import type { SimulationInputHashClosure } from "./contracts";
import type { BuildConfigV3 } from "../topology/contracts";

export interface ResolvedStorageActivity {
  readonly status: "ready";
  readonly logicalLayoutId: string;
  readonly memberCount: number;
  readonly concurrentDiskCount: number;
  /** Worst-case simultaneous spin-up count derived from exact layout membership. */
  readonly spinUpDiskCount: number;
  readonly dutyCycle: number;
  /** Time-averaged fraction of one drive's active load represented by the locked scenario. */
  readonly activeFraction: number;
  readonly assumption: string;
}

export interface BlockedStorageActivity {
  readonly status: "blocked";
  readonly reasonCode: string;
}

export type StorageActivityResolution = ResolvedStorageActivity | BlockedStorageActivity;

function layoutMembers(layout: BuildConfigV3["logicalLayouts"][number]): string[] {
  return [
    ...layout.bootPoolDiskIds,
    ...layout.vdevs.flatMap(({ diskInstanceIds }) => diskInstanceIds),
    ...layout.spareDiskIds,
  ];
}

/**
 * Resolves one storage instance against the exact logical-layout and activity
 * closure. No SKU, price, label, or case-specific fallback participates.
 */
export function resolveStorageActivity(input: {
  readonly config: BuildConfigV3;
  readonly closure: SimulationInputHashClosure;
  readonly componentInstanceId: string;
}): StorageActivityResolution {
  const component = input.config.components.find(({ instanceId }) => instanceId === input.componentInstanceId);
  if (component?.kind !== "storage_drive") return { status: "blocked", reasonCode: `storage-instance:${input.componentInstanceId}` };

  const memberships = input.config.logicalLayouts.flatMap((layout) => {
    const members = layoutMembers(layout);
    return members.includes(input.componentInstanceId) ? [{ layout, members }] : [];
  });
  if (memberships.length !== 1) {
    return { status: "blocked", reasonCode: `storage-layout-membership:${input.componentInstanceId}` };
  }
  const { layout, members } = memberships[0]!;
  if (members.length === 0 || new Set(members).size !== members.length) {
    return { status: "blocked", reasonCode: `storage-layout-members:${layout.layoutId}` };
  }
  const activities = input.closure.sourcedInput.input.storageActivity.filter(({ logicalLayoutId }) => logicalLayoutId === layout.layoutId);
  const layoutClosures = input.closure.logicalLayouts.filter(({ logicalLayoutId }) => logicalLayoutId === layout.layoutId);
  if (activities.length !== 1 || layoutClosures.length !== 1) {
    return { status: "blocked", reasonCode: `storage-activity:${layout.layoutId}` };
  }
  const activity = activities[0]!;
  if (activity.concurrentDiskCount > members.length || activity.concurrentDiskCount < 1 || activity.dutyCycle <= 0) {
    return { status: "blocked", reasonCode: `storage-activity-capacity:${layout.layoutId}` };
  }
  const activeFraction = activity.dutyCycle * activity.concurrentDiskCount / members.length;
  if (!Number.isFinite(activeFraction) || activeFraction <= 0 || activeFraction > 1) {
    return { status: "blocked", reasonCode: `storage-activity-fraction:${layout.layoutId}` };
  }
  return {
    status: "ready",
    logicalLayoutId: layout.layoutId,
    memberCount: members.length,
    concurrentDiskCount: activity.concurrentDiskCount,
    spinUpDiskCount: members.length,
    dutyCycle: activity.dutyCycle,
    activeFraction,
    assumption: `locked storage activity ${layout.layoutId}: duty ${activity.dutyCycle}, concurrent ${activity.concurrentDiskCount}/${members.length}, spin-up ${members.length}`,
  };
}
