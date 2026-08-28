import { describe, expect, it } from "vitest";
import type { ComponentInstance } from "../src/topology/contracts";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";
import { createStableTopologyEdgeId, normalizeBuildConfigV3 } from "../src/topology/normalize";
import { validateBuildConfigV3 } from "../src/topology/validation";

const timestamp = "2026-08-27T00:00:00.000Z";

function disk(instanceId: string): ComponentInstance {
  return {
    instanceId, kind: "storage_drive", role: "data", state: "planned", source: "user",
    identity: { status: "resolved", skuId: "storage.same", identityClaimIds: [`claim-${instanceId}`] },
  };
}

describe("U2 logical storage topology", () => {
  it("keeps physical disks independent while a logical mirror references their IDs", async () => {
    const config = createEmptyBuildConfigV3("plan-layout", "Layout", timestamp);
    config.components = [disk("disk-2"), disk("disk-1")];
    config.logicalLayouts = [{
      layoutId: "layout-main", bootPoolDiskIds: [], spareDiskIds: [],
      vdevs: [{ vdevId: "vdev-data", topology: "mirror", diskInstanceIds: ["disk-2", "disk-1"] }],
    }];
    config.placements = [{
      placementId: await createStableTopologyEdgeId("placement", ["disk-1", "case-1", "bay-1"]),
      componentInstanceId: "disk-1", mountOwnerInstanceId: "disk-2", mountId: "fixture-bay",
    }];
    expect(validateBuildConfigV3(config)).toEqual([]);
    expect(config.components).toHaveLength(2);
    expect(normalizeBuildConfigV3(config).logicalLayouts[0]!.vdevs[0]!.diskInstanceIds).toEqual(["disk-1", "disk-2"]);
  });

  it("rejects a disk assigned to mutually exclusive vdevs or logical roles", () => {
    const config = createEmptyBuildConfigV3("plan-duplicate", "Duplicate", timestamp);
    config.components = [disk("disk-1"), disk("disk-2"), disk("disk-3")];
    config.logicalLayouts = [{
      layoutId: "layout-main", bootPoolDiskIds: ["disk-1"], spareDiskIds: [],
      vdevs: [
        { vdevId: "vdev-a", topology: "mirror", diskInstanceIds: ["disk-1", "disk-2"] },
        { vdevId: "vdev-b", topology: "stripe", diskInstanceIds: ["disk-3"] },
      ],
    }];
    expect(validateBuildConfigV3(config)).toContain("logicalLayouts.0 assigns a disk more than once");
  });

  it("rejects non-disk references and impossible vdev cardinality", () => {
    const config = createEmptyBuildConfigV3("plan-invalid-layout", "Invalid", timestamp);
    config.components = [disk("disk-1"), {
      instanceId: "board-1", kind: "motherboard", role: "mainboard", state: "planned", source: "user",
      identity: { status: "unresolved", userText: "主板" },
    }];
    config.logicalLayouts = [{
      layoutId: "layout-main", bootPoolDiskIds: [], spareDiskIds: [],
      vdevs: [{ vdevId: "vdev-a", topology: "mirror", diskInstanceIds: ["board-1"] }],
    }];
    expect(validateBuildConfigV3(config)).toEqual(expect.arrayContaining([
      "logicalLayouts.0.vdevs.0 topology mirror requires at least 2 disks",
      "logicalLayouts.0 references a non-storage-drive component",
    ]));
  });

  it("normalizes layout/set order before hashing", async () => {
    const left = createEmptyBuildConfigV3("plan-layout-hash", "Layout hash", timestamp);
    left.components = [disk("disk-1"), disk("disk-2"), disk("disk-3")];
    left.logicalLayouts = [{
      layoutId: "layout-main", bootPoolDiskIds: [], spareDiskIds: ["disk-3"],
      vdevs: [{ vdevId: "vdev-data", topology: "mirror", diskInstanceIds: ["disk-1", "disk-2"] }],
    }];
    const right = structuredClone(left);
    right.components.reverse();
    right.logicalLayouts[0]!.vdevs[0]!.diskInstanceIds.reverse();
    await expect(configV3Hash(right)).resolves.toBe(await configV3Hash(left));
  });
});
