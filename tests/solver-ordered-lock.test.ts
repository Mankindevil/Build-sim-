import { describe, expect, it } from "vitest";
import { validateLockedInstancesPreserved } from "../src/recommendation/ranking";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

describe("U10 ordered and user-selected topology locks", () => {
  it("automatically freezes component identity, placement, connection and logical-layout membership", () => {
    const base = createEmptyBuildConfigV3("plan", "Plan", "2026-08-29T00:00:00.000Z");
    base.components.push(
      { instanceId: "case", kind: "case", role: "case", state: "planned", identity: { status: "resolved", skuId: "case.a", identityClaimIds: ["fact.case"] }, source: "migration" },
      { instanceId: "disk", kind: "storage_drive", role: "data", state: "ordered", identity: { status: "resolved", skuId: "disk.a", identityClaimIds: ["fact.disk"] }, source: "agent" },
      { instanceId: "hba", kind: "hba", role: "hba", state: "planned", identity: { status: "resolved", skuId: "hba.a", identityClaimIds: ["fact.hba"] }, source: "user" },
    );
    base.placements.push({ placementId: "place-disk", componentInstanceId: "disk", mountOwnerInstanceId: "case", mountId: "bay-1" });
    base.connections.push({ connectionId: "connect-disk", from: { instanceId: "disk", portId: "sata" }, to: { instanceId: "hba", portId: "sata-1" }, status: "planned" });
    base.logicalLayouts.push({ layoutId: "pool", bootPoolDiskIds: [], vdevs: [{ vdevId: "vdev", topology: "stripe", diskInstanceIds: ["disk"] }], spareDiskIds: [] });

    const changed = structuredClone(base);
    changed.components.find(({ instanceId }) => instanceId === "disk")!.identity = { status: "resolved", skuId: "disk.b", identityClaimIds: ["fact.disk-b"] };
    changed.placements[0]!.mountId = "bay-2";
    changed.connections[0]!.status = "satisfied";
    changed.logicalLayouts[0]!.vdevs[0]!.diskInstanceIds = [];
    changed.components.find(({ instanceId }) => instanceId === "hba")!.role = "replacement";

    expect(validateLockedInstancesPreserved(base, changed, [])).toEqual(expect.arrayContaining([
      "locked-instance:disk:component-changed",
      "locked-instance:disk:placement-changed",
      "locked-instance:disk:connection-changed",
      "locked-instance:disk:logical-layout-changed",
      "locked-instance:hba:component-changed",
    ]));
  });
});
