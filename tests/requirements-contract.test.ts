import { describe, expect, it } from "vitest";
import {
  validateRequirementAllocationConservation,
  validateRequirementNode,
  validateRequirementSatisfaction,
  validateSafetyCheckpointRecord,
  validateSafetyCheckpointRecordAuthoritatively,
  verdictForMissingRequirement,
  type RequirementNode,
  type RequirementSatisfaction,
} from "../src/requirements/contracts";
import { createEmptyBuildConfigV3, validateBuildConfigV3 } from "../src/topology/contracts";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";

describe("U0 topology and derived requirement contracts", () => {
  const digest = (letter: string) => letter.repeat(64);
  it("keeps a requirement-only blank plan at zero topology nodes", () => {
    const config = createEmptyBuildConfigV3("plan-blank", "Blank", "2026-08-27T00:00:00.000Z");
    config.intent = { state: "answered", value: "nas", source: "user", confirmedByUser: true };
    config.requirementSpec = { requirementSpecId: "req-spec", schemaVersion: "1.0.0", workloads: [], constraints: [] };
    expect(validateBuildConfigV3(config)).toEqual([]);
    expect(config.components).toEqual([]);
    expect(config.roleDecisions).toEqual([]);
    expect(config.connections).toEqual([]);
  });

  it("models not-needed as an explicit decision without a fake SKU", () => {
    const config = createEmptyBuildConfigV3("plan-office", "Office", "2026-08-27T00:00:00.000Z");
    config.roleDecisions.push({ roleDecisionId: "rd-gpu", role: "discrete_gpu", decision: "not_needed", source: "user", confirmedAt: "2026-08-27T00:01:00.000Z" });
    expect(validateBuildConfigV3(config)).toEqual([]);
    expect(config.components).toHaveLength(0);
    expect(validateBuildConfigV3({ ...config, derivedRequirements: [] })).toContain("build config contains derived or unknown fields");
  });

  it("rejects nested unknown topology fields and fully validates firmware settings", () => {
    const config = createEmptyBuildConfigV3("plan-strict", "Strict", "2026-08-27T00:00:00.000Z");
    config.system = { profileId: "system.windows-11", versionFactId: "fact-system-v1", source: "user", lockedByUser: true };
    config.components.push({
      instanceId: "board-1",
      kind: "motherboard",
      role: "mainboard",
      state: "planned",
      identity: { status: "resolved", skuId: "board.example", identityClaimIds: ["claim-board"] },
      source: "user",
    });
    config.components.push({
      instanceId: "disk-1", kind: "storage_drive", role: "data_disk", state: "planned",
      identity: { status: "resolved", skuId: "disk.example", identityClaimIds: ["claim-disk"] }, source: "user",
    });
    config.components.push({
      instanceId: "cable-1", kind: "cable", role: "data_cable", state: "planned",
      identity: { status: "resolved", skuId: "cable.example", identityClaimIds: ["claim-cable"] }, source: "user",
    });
    config.roleDecisions.push({ roleDecisionId: "rd-gpu", role: "discrete_gpu", decision: "not_needed", source: "user", confirmedAt: "2026-08-27T00:01:00.000Z" });
    config.placements.push({ placementId: "place-board", componentInstanceId: "board-1", mountOwnerInstanceId: "board-1", mountId: "self-test-mount" });
    config.connections.push({ connectionId: "conn-loop", from: { instanceId: "board-1", portId: "a" }, to: { instanceId: "disk-1", portId: "b" }, cableInstanceId: "cable-1", status: "planned" });
    config.logicalLayouts.push({ layoutId: "layout", bootPoolDiskIds: [], vdevs: [{ vdevId: "vdev", topology: "stripe", diskInstanceIds: ["disk-1"] }], spareDiskIds: [] });
    config.firmwareTargets.push({ instanceId: "board-1", targetReleaseFactId: "fact-bios-v2", requestedSettings: [{ settingId: "iommu", desiredValue: "enabled" }], source: "user" });
    expect(validateBuildConfigV3(config)).toEqual([]);

    const mutations: Array<[string, (draft: any) => void]> = [
      ["system selection contains unknown fields", (draft) => { draft.system.currentVersion = "old"; }],
      ["components.0 contains unknown fields", (draft) => { draft.components[0].quantity = 2; }],
      ["components.0.identity contains unknown fields", (draft) => { draft.components[0].identity.confidence = 1; }],
      ["roleDecisions.0 contains unknown fields", (draft) => { draft.roleDecisions[0].derived = true; }],
      ["placements.0 contains unknown fields", (draft) => { draft.placements[0].clearanceMm = 5; }],
      ["connections.0 contains unknown fields", (draft) => { draft.connections[0].evaluation = "pass"; }],
      ["connections.0.from contains unknown fields", (draft) => { draft.connections[0].from.pinout = "guessed"; }],
      ["logicalLayouts.0.vdevs.0 contains unknown fields", (draft) => { draft.logicalLayouts[0].vdevs[0].usableBytes = 1; }],
      ["firmwareTargets.0 contains unknown fields", (draft) => { draft.firmwareTargets[0].currentVersion = "old"; }],
      ["firmwareTargets.0.requestedSettings.0 contains unknown fields", (draft) => { draft.firmwareTargets[0].requestedSettings[0].observedValue = "disabled"; }],
    ];
    for (const [expectedError, mutate] of mutations) {
      const draft = structuredClone(config);
      mutate(draft);
      expect(validateBuildConfigV3(draft), expectedError).toContain(expectedError);
    }

    const emptySetting = structuredClone(config);
    emptySetting.firmwareTargets[0]!.requestedSettings[0]!.desiredValue = "";
    expect(validateBuildConfigV3(emptySetting)).toContain("firmwareTargets.0.requestedSettings.0 invalid");
    const unknownSetting = structuredClone(config) as any;
    unknownSetting.firmwareTargets[0].requestedSettings[0].settingId = "agent_magic";
    expect(validateBuildConfigV3(unknownSetting)).toContain("firmwareTargets.0.requestedSettings.0 invalid");
    const duplicateSetting = structuredClone(config);
    duplicateSetting.firmwareTargets[0]!.requestedSettings.push({ settingId: "iommu", desiredValue: "disabled" });
    expect(validateBuildConfigV3(duplicateSetting)).toContain("firmwareTargets.0 has duplicate requested settingId");

    const unknownKind = structuredClone(config) as any;
    unknownKind.components[0].kind = "agent_magic";
    expect(validateBuildConfigV3(unknownKind)).toContain("components.0 identity fields missing or kind is not registered");
    const unknownSystem = structuredClone(config) as any;
    unknownSystem.system.profileId = "system.agent-magic";
    expect(validateBuildConfigV3(unknownSystem)).toContain("system selection invalid");
    const nonDiskLayout = structuredClone(config);
    nonDiskLayout.logicalLayouts[0]!.vdevs[0]!.diskInstanceIds = ["board-1"];
    expect(validateBuildConfigV3(nonDiskLayout)).toContain("logicalLayouts.0 references a non-storage-drive component");
    const nonCableConnection = structuredClone(config);
    nonCableConnection.connections[0]!.cableInstanceId = "board-1";
    expect(validateBuildConfigV3(nonCableConnection)).toContain("connections.0.cableInstanceId must reference a cable component");
    const reusedDisk = structuredClone(config);
    reusedDisk.logicalLayouts.push({ layoutId: "layout-2", bootPoolDiskIds: ["disk-1"], vdevs: [], spareDiskIds: [] });
    expect(validateBuildConfigV3(reusedDisk)).toContain("logicalLayouts.1 reuses a disk assigned by another logical layout");
  });

  it("treats a missing item as blocked and conserves non-shareable allocations", () => {
    const requirement: RequirementNode = {
      requirementId: "req-screw-a",
      kind: "fastener",
      predicates: [],
      quantity: 1,
      criticality: "normal",
      requiredBefore: "assembly",
      producedBy: { ruleId: "mount", ruleVersion: "1", instanceIds: ["board"] },
      evidenceRefs: [],
    };
    expect(verdictForMissingRequirement(requirement)).toBe("blocked");
    expect(validateRequirementNode(requirement)).toEqual([]);
    expect(validateRequirementNode({ ...requirement, state: "answered", planId: "plan" })).toContain("derived requirement contains persisted-draft, observation, procedure or unknown fields");
    expect(validateRequirementNode({ ...requirement, producedBy: { ...requirement.producedBy, hiddenExpression: "true" } })).toContain("requirement producedBy invalid");
    const satisfaction = (requirementId: string): RequirementSatisfaction => ({
      requirementId,
      status: "satisfied",
      allocations: [{ source: "package_content", refId: "one-screw", ownerInstanceId: "case", quantity: 1, availability: "present_verified", verificationStatus: "verified", evidenceRefs: [], observationRefs: ["obs-count"] }],
      residualQuantity: 0,
    });
    expect(validateRequirementSatisfaction(requirement, satisfaction(requirement.requirementId))).toEqual([]);
    expect(validateRequirementAllocationConservation(
      [satisfaction("req-screw-a"), satisfaction("req-screw-b")],
      [{ source: "package_content", refId: "one-screw", ownerInstanceId: "case", quantity: 1 }],
    ).some((error) => error.includes("allocation exceeds"))).toBe(true);
  });

  it("does not let ordered inventory green a pre-power safety requirement", async () => {
    const requirement: RequirementNode = {
      requirementId: "req-eps",
      kind: "cable",
      predicates: [],
      quantity: 1,
      criticality: "safety",
      requiredBefore: "pre_power",
      producedBy: { ruleId: "eps", ruleVersion: "1", instanceIds: ["psu", "board"] },
      evidenceRefs: [],
    };
    const satisfaction: RequirementSatisfaction = {
      requirementId: "req-eps",
      status: "satisfied",
      allocations: [{ source: "purchase", refId: "eps-order", quantity: 1, availability: "ordered", verificationStatus: "unverified", evidenceRefs: [], observationRefs: [] }],
      residualQuantity: 0,
    };
    expect(validateRequirementSatisfaction(requirement, satisfaction)).toContain("boot/safety allocation must be present_verified or covered by a safety checkpoint");
    const checkpoint = {
      checkpointId: "checkpoint-eps", requirementId: "req-eps", planVersionId: "plan-v1", procedureId: "procedure-v1",
      dependencyHash: digest("a"), procedureSafetyHash: digest("b"), confirmedAt: "2026-08-27T00:00:00.000Z", actor: "user" as const,
    };
    const context = { planVersionId: "plan-v1", procedureId: "procedure-v1", expectedDependencyHash: digest("a"), expectedProcedureSafetyHash: digest("b") };
    expect(validateSafetyCheckpointRecord(checkpoint, requirement, context)).toEqual([]);
    expect(validateRequirementSatisfaction(requirement, satisfaction, checkpoint, context)).not.toContain("boot/safety allocation must be present_verified or covered by a safety checkpoint");
    expect(validateRequirementSatisfaction(requirement, satisfaction, { ...checkpoint, dependencyHash: digest("c") }, context)).toContain("boot/safety allocation must be present_verified or covered by a safety checkpoint");
    expect(validateRequirementSatisfaction(requirement, satisfaction, true as never, context)).toContain("boot/safety allocation must be present_verified or covered by a safety checkpoint");

    const resolver = createAuthoritativeResolver("safety-checkpoint-context", (ref) => ref === "checkpoint-context" ? context : undefined);
    await expect(validateSafetyCheckpointRecordAuthoritatively(checkpoint, requirement, "checkpoint-context", resolver)).resolves.toEqual([]);
    await expect(validateSafetyCheckpointRecordAuthoritatively(checkpoint, requirement, "checkpoint-context", context as never)).resolves.toEqual([
      expect.stringContaining("resolver was not issued by the server composition root"),
    ]);
    const staleResolver = createAuthoritativeResolver("safety-checkpoint-context", () => ({ ...context, expectedDependencyHash: digest("c") }));
    await expect(validateSafetyCheckpointRecordAuthoritatively(checkpoint, requirement, "checkpoint-context", staleResolver))
      .resolves.toContain("safety checkpoint dependency binding is stale or invalid");
  });
});
