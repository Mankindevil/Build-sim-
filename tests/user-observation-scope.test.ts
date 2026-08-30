import { describe, expect, it } from "vitest";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { resolveObservationProjectionContext } from "../src/observations/subject-resolution";
import { createEmptyBuildConfig } from "../src/plans/default-plan";

function config() {
  const value = createEmptyBuildConfigV3("plan-a", "Observation scope", "2026-08-28T02:00:00.000Z");
  value.components = [
    { instanceId: "case-a", kind: "case", role: "case", state: "planned", identity: { status: "unresolved", userText: "case" }, source: "user" },
    { instanceId: "disk-a", kind: "storage_drive", role: "data", state: "planned", identity: { status: "unresolved", userText: "disk" }, source: "user" },
    { instanceId: "cable-a", kind: "cable", role: "data", state: "planned", identity: { status: "unresolved", userText: "cable" }, source: "user" },
  ];
  value.placements = [{ placementId: "placement-a", componentInstanceId: "disk-a", mountOwnerInstanceId: "case-a", mountId: "bay-1" }];
  value.connections = [{ connectionId: "route-a", from: { instanceId: "disk-a", portId: "sata" }, to: { instanceId: "case-a", portId: "backplane-1" }, cableInstanceId: "cable-a", status: "planned" }];
  return value;
}

describe("U3 user-observation subject scope", () => {
  it("changes only the affected subject revision when a slot, port, route or instance changes", async () => {
    const before = config();
    const placementBefore = await resolveObservationProjectionContext("plan-a", before, { kind: "placement", placementId: "placement-a" });
    const routeBefore = await resolveObservationProjectionContext("plan-a", before, { kind: "connection", connectionId: "route-a" });
    const otherBefore = await resolveObservationProjectionContext("plan-a", before, { kind: "instance", instanceId: "cable-a" });

    const moved = structuredClone(before);
    moved.placements[0]!.mountId = "bay-2";
    const placementAfter = await resolveObservationProjectionContext("plan-a", moved, { kind: "placement", placementId: "placement-a" });
    expect(placementAfter.currentSubjectRevisionHash).not.toBe(placementBefore.currentSubjectRevisionHash);
    expect((await resolveObservationProjectionContext("plan-a", moved, { kind: "connection", connectionId: "route-a" })).currentSubjectRevisionHash).toBe(routeBefore.currentSubjectRevisionHash);

    const rerouted = structuredClone(before);
    rerouted.connections[0]!.to.portId = "backplane-2";
    expect((await resolveObservationProjectionContext("plan-a", rerouted, { kind: "connection", connectionId: "route-a" })).currentSubjectRevisionHash).not.toBe(routeBefore.currentSubjectRevisionHash);
    expect((await resolveObservationProjectionContext("plan-a", rerouted, { kind: "instance", instanceId: "cable-a" })).currentSubjectRevisionHash).toBe(otherBefore.currentSubjectRevisionHash);
  });

  it("fails closed for a missing/cross-schema subject and binds all contexts to the current config", async () => {
    const value = config();
    const missing = await resolveObservationProjectionContext("plan-a", value, { kind: "port", instanceId: "disk-a", portId: "not-used" });
    expect(missing.subjectExists).toBe(false);
    const existing = await resolveObservationProjectionContext("plan-a", value, { kind: "port", instanceId: "disk-a", portId: "sata" });
    expect(existing.subjectExists).toBe(true);
    expect(existing.currentConfigHash).toHaveLength(64);
    const v2 = createEmptyBuildConfig("plan-a", "2026-08-28T02:00:00.000Z");
    await expect(resolveObservationProjectionContext("plan-a", v2, { kind: "instance", instanceId: "disk-a" }))
      .resolves.toMatchObject({ subjectExists: false });
  });
});
