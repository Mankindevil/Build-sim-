import { describe, expect, it } from "vitest";
import { buildNasPhysicalLogicalMap, diskAtPhysicalBay, disksForLogicalRole } from "../src/storage/physical-logical-map";
import type { StorageDiskAuthority } from "../src/storage/truenas";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

function fixture() {
  const config = createEmptyBuildConfigV3("plan-nas-map", "NAS map", "2026-08-29T10:00:00.000Z");
  config.components = [
    { instanceId: "case", kind: "case", role: "case", state: "planned", identity: { status: "resolved", skuId: "case.fixture", identityClaimIds: ["claim-case"] }, source: "user" },
    { instanceId: "hba", kind: "hba", role: "storage-controller", state: "planned", identity: { status: "resolved", skuId: "hba.fixture", identityClaimIds: ["claim-hba"] }, source: "user" },
    ...[1, 2].map((index) => ({
      instanceId: `disk-${index}`, kind: "storage_drive" as const, role: "data", state: "planned" as const,
      identity: { status: "resolved" as const, skuId: `disk.fixture.${index}`, identityClaimIds: [`claim-disk-${index}`] }, source: "user" as const,
    })),
    ...[1, 2].map((index) => ({
      instanceId: `cable-${index}`, kind: "cable" as const, role: "storage-data", state: "planned" as const,
      identity: { status: "resolved" as const, skuId: "cable.sata", identityClaimIds: [`claim-cable-${index}`] }, source: "user" as const,
    })),
  ];
  config.placements = [1, 2].map((index) => ({
    placementId: `placement-${index}`, componentInstanceId: `disk-${index}`, mountOwnerInstanceId: "case", mountId: `bay-${index}`,
  }));
  config.connections = [1, 2].map((index) => ({
    connectionId: `connection-${index}`,
    from: { instanceId: `disk-${index}`, portId: "data" },
    to: { instanceId: "hba", portId: `port-${index}` },
    cableInstanceId: `cable-${index}`,
    status: "planned" as const,
  }));
  const selection = {
    layoutId: "layout-1", bootPoolDiskIds: [],
    vdevs: [{ vdevId: "data-vdev", topology: "mirror" as const, diskInstanceIds: ["disk-1", "disk-2"] }], spareDiskIds: [],
  };
  const authorities: StorageDiskAuthority[] = [1, 2].map((index) => ({
    instanceId: `disk-${index}`, capacityBytes: 1_000_000, media: "CMR", faultDomain: `bay-${index}`,
    revisionHash: `${index}`.repeat(64), factIds: [`fact-disk-${index}`], locatorObservationId: `observation-disk-${index}`,
    path: {
      controllerInstanceId: "hba", controllerPortId: `port-${index}`, backplaneInstanceId: null,
      connectionIds: [`connection-${index}`], cableInstanceIds: [`cable-${index}`],
      transport: "sata", controllerMode: "it", factIds: ["fact-hba-mode"],
    },
  }));
  return { config, selection, authorities };
}

describe("NAS physical/logical bidirectional mapping", () => {
  it("maps each logical member to one bay, controller port and cable and navigates both ways", () => {
    const { config, selection, authorities } = fixture();
    const map = buildNasPhysicalLogicalMap(config, selection, authorities);
    expect(map.disks).toHaveLength(2);
    expect(disksForLogicalRole(map, { kind: "vdev_member", vdevId: "data-vdev" }).map(({ diskInstanceId }) => diskInstanceId)).toEqual(["disk-1", "disk-2"]);
    expect(diskAtPhysicalBay(map, "case", "bay-2")).toMatchObject({
      diskInstanceId: "disk-2", controllerPortId: "port-2", cableInstanceIds: ["cable-2"],
      roles: [{ kind: "vdev_member", vdevId: "data-vdev", index: 1 }],
    });
  });

  it("fails closed on a missing cable closure or reused physical bay", () => {
    const missing = fixture();
    const { cableInstanceIds: _removed, ...pathWithoutCables } = missing.authorities[0]!.path;
    missing.authorities[0] = { ...missing.authorities[0]!, path: pathWithoutCables };
    expect(() => buildNasPhysicalLogicalMap(missing.config, missing.selection, missing.authorities)).toThrow(/connection\/cable closure/);
    const reused = fixture();
    reused.config.placements[1]!.mountId = "bay-1";
    expect(() => buildNasPhysicalLogicalMap(reused.config, reused.selection, reused.authorities)).toThrow(/reuses a bay/);
  });

  it("does not create rows for empty bays or absent disks", () => {
    const { config, selection, authorities } = fixture();
    config.placements.push({ placementId: "empty-bay-marker", componentInstanceId: "case", mountOwnerInstanceId: "case", mountId: "bay-3" });
    const map = buildNasPhysicalLogicalMap(config, selection, authorities);
    expect(map.disks.map(({ bayMountId }) => bayMountId)).toEqual(["bay-1", "bay-2"]);
    expect(diskAtPhysicalBay(map, "case", "bay-3")).toBeNull();
  });
});
