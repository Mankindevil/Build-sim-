import { describe, expect, it } from "vitest";
import {
  allocateRequirementSupplies,
  deriveRequirementReadiness,
  type AllocatableRequirementSupply,
} from "../src/requirements/allocation";
import type { RequirementNode } from "../src/requirements/contracts";
import {
  allocateRequirementSuppliesRuntime,
  requirementArtifactContentHashRuntime,
  requirementAllocationReferencesRuntime,
  validateRequirementAllocationResultRuntime,
  validateRequirementAllocationCheckpointClosureRuntime,
  validateRequirementAllocationReplayRuntime,
  validateRequirementReadinessRuntime,
} from "../src/requirements/runtime.mjs";

function requirement(
  requirementId: string,
  thread?: string,
  overrides: Partial<RequirementNode> = {},
): RequirementNode {
  return {
    requirementId,
    kind: "fastener",
    predicates: thread === undefined ? [] : [{ facetId: "fastener.thread", operator: "eq", value: thread }],
    quantity: 1,
    criticality: "normal",
    requiredBefore: "assembly",
    producedBy: { ruleId: "fixture.mount", ruleVersion: "1.0.0", instanceIds: ["case-a", "board-a"] },
    evidenceRefs: ["fact-mount"],
    ...overrides,
  };
}

type UserResourceSupply = Extract<AllocatableRequirementSupply, { source: "user_resource" }>;

function supply(
  refId: string,
  thread: string,
  overrides: Partial<Omit<UserResourceSupply, "source" | "refId" | "ownerInstanceId">> = {},
): UserResourceSupply {
  return {
    source: "user_resource",
    refId,
    ownerInstanceId: "case-a",
    kind: "fastener",
    facets: [{ facetId: "fastener.thread", value: thread }],
    quantity: 1,
    availability: "present_verified",
    verificationStatus: "verified",
    satisfiesBefore: "assembly",
    evidenceRefs: ["fact-fastener"],
    observationRefs: [`observation:obs-${refId}`],
    ...overrides,
  };
}

describe("requirement allocation conservation", () => {
  it("uses max flow so a flexible requirement cannot consume the only specific supply", () => {
    const result = allocateRequirementSupplies(
      [requirement("specific", "m3"), requirement("flexible")],
      [supply("m3", "m3"), supply("m4", "m4")],
    );
    expect(result.satisfactions.every(({ status }) => status === "satisfied")).toBe(true);
    expect(result.satisfactions.find(({ requirementId }) => requirementId === "specific")?.allocations[0]?.refId).toBe("m3");
    expect(result.remainingSupplies.map(({ quantity }) => quantity)).toEqual([0, 0]);
    expect(validateRequirementAllocationResultRuntime(result)).toEqual([]);
    expect(allocateRequirementSuppliesRuntime(
      [requirement("specific", "m3"), requirement("flexible")],
      [supply("m3", "m3"), supply("m4", "m4")],
    )).toEqual(result);
  });

  it("replays the deterministic allocation and rejects a checksum-correct returned supply", () => {
    const result = allocateRequirementSupplies([requirement("specific", "m3")], [supply("m3", "m3")]);
    expect(validateRequirementAllocationReplayRuntime(result, {
      blockedRequirementIds: [], checkpointBindings: [],
    })).toEqual([]);

    // Conservation and metadata remain internally valid, but this is not the
    // canonical maximum-flow result for the embedded requirement and supply.
    const returned = structuredClone(result);
    returned.satisfactions[0]!.status = "open";
    returned.satisfactions[0]!.residualQuantity = 1;
    returned.satisfactions[0]!.allocations = [];
    returned.remainingSupplies[0]!.quantity = 1;
    returned.contentHash = requirementArtifactContentHashRuntime(returned, returned.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(returned)).toEqual([]);
    expect(validateRequirementAllocationReplayRuntime(returned, {
      blockedRequirementIds: [], checkpointBindings: [],
    })).toContain("requirement allocation differs from deterministic authoritative replay");
  });

  it("normalizes concrete string sets and rejects non-canonical persisted order", () => {
    const target = requirement("firmware-medium", undefined, {
      kind: "firmware_action",
      predicates: [{ facetId: "firmware.upgrade_path_refs", operator: "includes", value: "a" }],
      requiredBefore: "first_boot",
    });
    const medium: AllocatableRequirementSupply = {
      source: "user_resource", refId: "medium", ownerInstanceId: "case-a", kind: "firmware_action",
      facets: [{ facetId: "firmware.upgrade_path_refs", value: ["b", "a"] }], quantity: 1,
      availability: "present_verified", verificationStatus: "verified", satisfiesBefore: "first_boot",
      evidenceRefs: ["fact-medium"], observationRefs: ["observation:obs-medium"],
    };
    const result = allocateRequirementSupplies([target], [medium]);
    expect(result.supplies[0]?.facets[0]?.value).toEqual(["a", "b"]);

    const reversed = structuredClone(result);
    reversed.supplies[0]!.facets[0]!.value = ["b", "a"];
    reversed.contentHash = requirementArtifactContentHashRuntime(reversed, reversed.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(reversed)
      .some((error) => error.includes("facet value invalid"))).toBe(true);
  });

  it("never double allocates a non-shareable item", () => {
    const result = allocateRequirementSupplies(
      [requirement("first", "m3"), requirement("second", "m3")],
      [supply("only-one", "m3")],
    );
    expect(result.satisfactions.filter(({ status }) => status === "satisfied")).toHaveLength(1);
    expect(result.satisfactions.reduce((sum, item) => sum + item.allocations.reduce((inner, allocation) => inner + allocation.quantity, 0), 0)).toBe(1);
    expect(result.remainingSupplies).toEqual([{ source: "user_resource", refId: "only-one", ownerInstanceId: "case-a", quantity: 0 }]);
  });

  it("rejects checksum-correct facet and owner forgeries", () => {
    const result = allocateRequirementSupplies([requirement("specific", "m3")], [supply("m3", "m3")]);
    const wrongFacet = structuredClone(result);
    wrongFacet.supplies[0]!.facets = [{ facetId: "fastener.thread", value: "m4" }];
    wrongFacet.contentHash = requirementArtifactContentHashRuntime(wrongFacet, wrongFacet.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(wrongFacet).some((error) => error.includes("does not satisfy requirement kind/facets"))).toBe(true);

    const wrongOwner = structuredClone(result);
    wrongOwner.supplies[0]!.ownerInstanceId = "case-b";
    wrongOwner.satisfactions[0]!.allocations[0]!.ownerInstanceId = "case-b";
    wrongOwner.remainingSupplies[0]!.ownerInstanceId = "case-b";
    wrongOwner.contentHash = requirementArtifactContentHashRuntime(wrongOwner, wrongOwner.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(wrongOwner).some((error) => error.includes("outside requirement target scope"))).toBe(true);

    const missingOwner = structuredClone(result);
    delete missingOwner.supplies[0]!.ownerInstanceId;
    delete missingOwner.satisfactions[0]!.allocations[0]!.ownerInstanceId;
    delete missingOwner.remainingSupplies[0]!.ownerInstanceId;
    missingOwner.contentHash = requirementArtifactContentHashRuntime(missingOwner, missingOwner.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(missingOwner).some((error) => error.includes("requires ownerInstanceId"))).toBe(true);

    const unscopedObservation = structuredClone(result);
    unscopedObservation.supplies[0]!.observationRefs = ["obs-m3"];
    unscopedObservation.satisfactions[0]!.allocations[0]!.observationRefs = ["obs-m3"];
    unscopedObservation.contentHash = requirementArtifactContentHashRuntime(unscopedObservation, unscopedObservation.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(unscopedObservation)
      .some((error) => error.includes("references invalid"))).toBe(true);
  });

  it("derives readiness only from validated satisfactions", () => {
    const safety = requirement("atx-connected", undefined, { kind: "measurement", predicates: [], criticality: "safety", requiredBefore: "pre_power" });
    const open = allocateRequirementSupplies([safety], []);
    const blocked = deriveRequirementReadiness(open);
    expect(blocked.powerReady).toBe(false);
    expect(blocked.firstBootReady).toBe(false);

    const observed: AllocatableRequirementSupply = {
      ...supply("atx-observation", "m3"),
      kind: "measurement",
      facets: [],
      satisfiesBefore: "pre_power",
    };
    const readyAllocation = allocateRequirementSupplies([safety], [observed]);
    const ready = deriveRequirementReadiness(readyAllocation);
    expect(ready.powerReady).toBe(true);
    expect(validateRequirementReadinessRuntime(ready, readyAllocation)).toEqual([]);
  });

  it("binds blocked satisfaction status to explicit allocation authority", () => {
    const target = requirement("cycle-blocked", "m3");
    const available = supply("matching-but-blocked", "m3");
    const allocation = allocateRequirementSupplies([target], [available], { blockedRequirementIds: [target.requirementId] });
    expect(allocation.satisfactions[0]?.status).toBe("blocked");
    expect(allocation.satisfactions[0]?.allocations).toEqual([]);
    expect(allocation.satisfactions[0]?.residualQuantity).toBe(1);
    expect(allocation.remainingSupplies[0]?.quantity).toBe(1);
    expect(allocation.blockedRequirementIds).toEqual([target.requirementId]);
    expect(deriveRequirementReadiness(allocation).assemblyReady).toBe(false);
    const forged = structuredClone(allocation);
    forged.satisfactions[0]!.status = "open";
    forged.contentHash = requirementArtifactContentHashRuntime(forged, forged.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(forged)
      .some((error) => error.includes("status differs from blocked requirement authority"))).toBe(true);

    const forceSatisfied = structuredClone(allocation);
    forceSatisfied.satisfactions[0]!.status = "satisfied";
    forceSatisfied.satisfactions[0]!.residualQuantity = 0;
    forceSatisfied.satisfactions[0]!.allocations = [{
      source: available.source,
      refId: available.refId,
      ownerInstanceId: available.ownerInstanceId,
      quantity: 1,
      availability: available.availability,
      verificationStatus: available.verificationStatus,
      ...(available.satisfiesBefore === undefined ? {} : { satisfiesBefore: available.satisfiesBefore }),
      evidenceRefs: available.evidenceRefs,
      observationRefs: available.observationRefs,
    }];
    forceSatisfied.remainingSupplies[0]!.quantity = 0;
    forceSatisfied.contentHash = requirementArtifactContentHashRuntime(forceSatisfied, forceSatisfied.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(forceSatisfied)
      .some((error) => error.includes("blocked requirement cannot consume supply"))).toBe(true);
  });

  it("accepts only a complete current safety checkpoint and exposes its closure fields", () => {
    const safety = requirement("checkpointed", undefined, { kind: "measurement", predicates: [], criticality: "safety", requiredBefore: "pre_power" });
    const planned: AllocatableRequirementSupply = {
      source: "user_resource", refId: "pending-check", ownerInstanceId: "case-a", kind: "measurement", facets: [], quantity: 1,
      availability: "planned", verificationStatus: "unverified", satisfiesBefore: "pre_power",
      evidenceRefs: ["fact-procedure"], observationRefs: [],
    };
    const dependencyHash = "a".repeat(64);
    const procedureSafetyHash = "b".repeat(64);
    const checkpoint = {
      checkpointId: "checkpoint-prepower",
      requirementId: safety.requirementId,
      planVersionId: "plan-version-a",
      procedureId: "procedure-a",
      dependencyHash,
      procedureSafetyHash,
      confirmedAt: "2026-08-28T12:00:00.000Z",
      actor: "user" as const,
    };
    const context = { planVersionId: "plan-version-a", procedureId: "procedure-a", expectedDependencyHash: dependencyHash, expectedProcedureSafetyHash: procedureSafetyHash };
    const accepted = allocateRequirementSupplies([safety], [planned], { safetyCheckpoints: [{ checkpoint, context }] });
    expect(accepted.satisfactions[0]?.status).toBe("satisfied");
    expect(requirementAllocationReferencesRuntime(accepted)?.checkpointRefs).toEqual([checkpoint]);
    expect(validateRequirementAllocationCheckpointClosureRuntime(accepted, [{ checkpoint, context }])).toEqual([]);

    const forged = structuredClone(accepted);
    forged.checkpointRefs[0]!.dependencyHash = "d".repeat(64);
    forged.contentHash = requirementArtifactContentHashRuntime(forged, forged.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(forged)).toEqual([]);
    expect(validateRequirementAllocationCheckpointClosureRuntime(forged, [{ checkpoint, context }])
      .some((error) => error.includes("differs from execution authority"))).toBe(true);
    expect(validateRequirementAllocationCheckpointClosureRuntime(accepted, [{
      checkpoint,
      context: { ...context, expectedProcedureSafetyHash: "d".repeat(64) },
    }]).some((error) => error.includes("stale or scope-mismatched"))).toBe(true);

    const reorderedCheckpoint = {
      actor: checkpoint.actor,
      confirmedAt: checkpoint.confirmedAt,
      procedureSafetyHash: checkpoint.procedureSafetyHash,
      dependencyHash: checkpoint.dependencyHash,
      procedureId: checkpoint.procedureId,
      planVersionId: checkpoint.planVersionId,
      requirementId: checkpoint.requirementId,
      checkpointId: checkpoint.checkpointId,
    };
    expect(() => allocateRequirementSupplies([safety], [planned], {
      safetyCheckpoints: [{ checkpoint, context }],
      checkpointByRequirement: new Map([[safety.requirementId, { checkpoint: reorderedCheckpoint, context: { ...context } }]]),
    })).not.toThrow();

    const conflicting = { ...checkpoint, confirmedAt: "2026-08-28T12:01:00.000Z" };
    for (const authorities of [
      [{ checkpoint, context }, { checkpoint: conflicting, context }],
      [{ checkpoint: conflicting, context }, { checkpoint, context }],
    ]) {
      expect(() => allocateRequirementSupplies([safety], [planned], { safetyCheckpoints: authorities }))
        .toThrow(/conflicting safety checkpoint authority/);
    }

    const otherSafety = requirement("checkpointed-other", undefined, {
      kind: "measurement", predicates: [], criticality: "safety", requiredBefore: "pre_power",
    });
    const otherPlanned: AllocatableRequirementSupply = {
      ...planned, refId: "pending-check-other",
    };
    const reusedIdentity = { ...checkpoint, requirementId: otherSafety.requirementId };
    for (const authorities of [
      [{ checkpoint, context }, { checkpoint: reusedIdentity, context }],
      [{ checkpoint: reusedIdentity, context }, { checkpoint, context }],
    ]) {
      expect(() => allocateRequirementSupplies([safety, otherSafety], [planned, otherPlanned], {
        safetyCheckpoints: authorities,
      })).toThrow(/conflicting safety checkpoint authority/);
    }

    const stale = allocateRequirementSupplies([safety], [planned], {
      safetyCheckpoints: [{ checkpoint, context: { ...context, expectedDependencyHash: "c".repeat(64) } }],
    });
    expect(stale.satisfactions[0]?.status).toBe("open");
    expect(stale.checkpointRefs).toEqual([]);
  });
});
