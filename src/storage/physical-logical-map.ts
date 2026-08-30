import type { BuildConfigV3, LogicalLayoutSelection } from "../topology/contracts";
import type { StorageDiskAuthority } from "./truenas";

export type StorageLogicalRole =
  | { readonly kind: "boot_pool"; readonly index: number }
  | { readonly kind: "vdev_member"; readonly vdevId: string; readonly index: number }
  | { readonly kind: "spare"; readonly index: number };

export interface PhysicalLogicalDiskPath {
  readonly diskInstanceId: string;
  readonly roles: readonly StorageLogicalRole[];
  readonly placementId: string;
  readonly caseInstanceId: string;
  readonly bayMountId: string;
  readonly controllerInstanceId: string;
  readonly controllerPortId: string;
  readonly backplaneInstanceId: string | null;
  readonly connectionIds: readonly string[];
  readonly cableInstanceIds: readonly string[];
}

export interface NasPhysicalLogicalMap {
  readonly schemaVersion: "nas-physical-logical-map-v1";
  readonly layoutId: string;
  readonly disks: readonly PhysicalLogicalDiskPath[];
}

function rolesFor(selection: LogicalLayoutSelection, diskInstanceId: string): StorageLogicalRole[] {
  const roles: StorageLogicalRole[] = [];
  const bootIndex = selection.bootPoolDiskIds.indexOf(diskInstanceId);
  if (bootIndex >= 0) roles.push({ kind: "boot_pool", index: bootIndex });
  selection.vdevs.forEach((vdev) => {
    const index = vdev.diskInstanceIds.indexOf(diskInstanceId);
    if (index >= 0) roles.push({ kind: "vdev_member", vdevId: vdev.vdevId, index });
  });
  const spareIndex = selection.spareDiskIds.indexOf(diskInstanceId);
  if (spareIndex >= 0) roles.push({ kind: "spare", index: spareIndex });
  return roles;
}

export function buildNasPhysicalLogicalMap(
  config: BuildConfigV3,
  selection: LogicalLayoutSelection,
  authorities: readonly StorageDiskAuthority[],
): NasPhysicalLogicalMap {
  const selected = [...new Set([
    ...selection.bootPoolDiskIds,
    ...selection.vdevs.flatMap((vdev) => vdev.diskInstanceIds),
    ...selection.spareDiskIds,
  ])].sort();
  const authorityById = new Map(authorities.map((authority) => [authority.instanceId, authority]));
  if (authorityById.size !== authorities.length) throw new TypeError("physical/logical disk authorities contain duplicate instances");
  const disks = selected.map((diskInstanceId): PhysicalLogicalDiskPath => {
    const component = config.components.find((entry) => entry.instanceId === diskInstanceId);
    const placement = config.placements.find((entry) => entry.componentInstanceId === diskInstanceId);
    const authority = authorityById.get(diskInstanceId);
    if (!component || component.kind !== "storage_drive" || !placement || !authority) {
      throw new TypeError("selected logical disk lacks one physical component/bay authority");
    }
    const connectionIds = authority.path.connectionIds ?? [];
    const cableInstanceIds = authority.path.cableInstanceIds ?? [];
    if (connectionIds.length === 0 || cableInstanceIds.length === 0
      || connectionIds.some((connectionId) => !config.connections.some((entry) => entry.connectionId === connectionId))
      || cableInstanceIds.some((cableId) => !config.components.some((entry) => entry.instanceId === cableId && entry.kind === "cable"))) {
      throw new TypeError("selected logical disk physical path lacks exact connection/cable closure");
    }
    if (authority.path.backplaneInstanceId !== null && authority.path.backplaneInstanceId !== undefined
      && !config.components.some((entry) => entry.instanceId === authority.path.backplaneInstanceId && entry.kind === "backplane")) {
      throw new TypeError("selected logical disk backplane authority is invalid");
    }
    return {
      diskInstanceId,
      roles: rolesFor(selection, diskInstanceId),
      placementId: placement.placementId,
      caseInstanceId: placement.mountOwnerInstanceId,
      bayMountId: placement.mountId,
      controllerInstanceId: authority.path.controllerInstanceId,
      controllerPortId: authority.path.controllerPortId,
      backplaneInstanceId: authority.path.backplaneInstanceId ?? null,
      connectionIds: [...connectionIds].sort(),
      cableInstanceIds: [...cableInstanceIds].sort(),
    };
  });
  const bayKeys = disks.map((disk) => `${disk.caseInstanceId}:${disk.bayMountId}`);
  const controllerKeys = disks.map((disk) => `${disk.controllerInstanceId}:${disk.controllerPortId}`);
  if (new Set(bayKeys).size !== bayKeys.length || new Set(controllerKeys).size !== controllerKeys.length) {
    throw new TypeError("physical/logical disk map reuses a bay or controller port");
  }
  return { schemaVersion: "nas-physical-logical-map-v1", layoutId: selection.layoutId, disks };
}

export function disksForLogicalRole(
  map: NasPhysicalLogicalMap,
  query: { readonly kind: StorageLogicalRole["kind"]; readonly vdevId?: string },
): readonly PhysicalLogicalDiskPath[] {
  return map.disks.filter((disk) => disk.roles.some((role) => role.kind === query.kind
    && (role.kind !== "vdev_member" || query.vdevId === undefined || role.vdevId === query.vdevId)));
}

export function diskAtPhysicalBay(
  map: NasPhysicalLogicalMap,
  caseInstanceId: string,
  bayMountId: string,
): PhysicalLogicalDiskPath | null {
  return map.disks.find((disk) => disk.caseInstanceId === caseInstanceId && disk.bayMountId === bayMountId) ?? null;
}
