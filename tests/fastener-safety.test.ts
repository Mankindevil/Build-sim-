import { describe, expect, it } from "vitest";
import {
  evaluateAssemblySafety,
  projectVerifiedAssemblySupplies,
} from "../src/requirements/assembly-safety";
import {
  assemblySafetyReferencesRuntime,
  validateRequirementAllocationGeneratedSupplyClosureRuntime,
  validateAssemblySafetyEvaluationRuntime,
} from "../src/requirements/assembly-safety-runtime.mjs";
import {
  allocateRequirementSupplies,
  deriveRequirementReadiness,
  type AllocatableRequirementSupply,
} from "../src/requirements/allocation";
import { requirementArtifactContentHashRuntime } from "../src/requirements/runtime.mjs";

const authority = {
  ownerInstanceId: "case-a",
  instanceIds: ["case-a", "board-a"],
  factIds: ["fact-case-mount"],
};

describe("assembly and fastener safety", () => {
  it("fails known missing/extra/wrong standoffs and blocks an unobserved layout", () => {
    const extra = evaluateAssemblySafety({
      assemblyId: "build-a",
      checks: [{
        ...authority,
        checkId: "board-standoffs",
        checkType: "standoff_layout",
        observationIds: ["obs-standoffs"],
        expectedPositionIds: ["a", "b"],
        expectedThread: "6-32",
        expectedHeightMm: 6.5,
        heightToleranceMm: 0.2,
        observed: [
          { positionId: "a", thread: "6-32", heightMm: 6.5 },
          { positionId: "b", thread: "m3", heightMm: 9 },
          { positionId: "extra", thread: "6-32", heightMm: 6.5 },
        ],
      }],
    });
    expect(extra.decisions[0]).toMatchObject({ verdict: "fail", domain: "assembly" });
    expect(extra.decisions[0]?.message).toContain("1 extra");
    expect(extra.requirements.map(({ requirementId }) => requirementId)).toEqual([
      "requirement.assembly.build-a.board-standoffs.layout-checkpoint",
      "requirement.assembly.build-a.board-standoffs.standoffs",
    ]);

    const unknown = evaluateAssemblySafety({
      assemblyId: "build-a",
      checks: [{
        ...authority,
        checkId: "unknown-standoffs",
        checkType: "standoff_layout",
        observationIds: [],
        expectedPositionIds: ["a"], expectedThread: "6-32", expectedHeightMm: 6.5, heightToleranceMm: 0.2,
        observed: null,
      }],
    });
    expect(unknown.decisions[0]?.verdict).toBe("blocked");
  });

  it("distinguishes missing resources from known mismatches", () => {
    const result = evaluateAssemblySafety({
      assemblyId: "build-a",
      checks: [
        {
          ...authority, checkId: "board-screws", checkType: "resource", resourceId: "board-screws", observationIds: ["obs-wrong-screws"],
          role: "motherboard_screw", kind: "fastener", predicates: [{ facetId: "fastener.thread", operator: "eq", value: "6-32" }],
          quantity: 4, criticality: "safety", requiredBefore: "assembly", state: "mismatch_verified",
        },
        {
          ...authority, checkId: "driver", checkType: "resource", resourceId: "driver", observationIds: [],
          role: "tool", kind: "tool", predicates: [{ facetId: "tool.drive", operator: "eq", value: "phillips-2" }],
          quantity: 1, criticality: "normal", requiredBefore: "assembly", state: "unknown",
        },
      ],
    });
    expect(result.decisions.map(({ verdict }) => verdict)).toEqual(["fail", "blocked"]);
  });

  it("covers actual power connections, 12V-2x6 bend, film and loose metal", () => {
    const result = evaluateAssemblySafety({
      assemblyId: "build-a",
      checks: [
        { ...authority, checkId: "atx24", checkType: "connection", observationIds: [], connectionKind: "atx24", connectorStandard: "atx24", state: "unknown" },
        { ...authority, checkId: "eps", checkType: "connection", observationIds: ["obs-eps"], connectionKind: "eps", connectorStandard: "eps8", state: "connected_verified" },
        { ...authority, checkId: "gpu-power", checkType: "connection", observationIds: ["obs-gpu"], connectionKind: "gpu_power", connectorStandard: "pcie8", state: "wrong_connector_verified" },
        { ...authority, checkId: "cpu-fan", checkType: "connection", observationIds: ["obs-fan"], connectionKind: "cpu_fan", connectorStandard: "fan.pwm-4pin", state: "connected_verified" },
        { ...authority, checkId: "pump", checkType: "connection", observationIds: [], connectionKind: "pump", connectorStandard: "fan.pump-4pin", state: "unknown" },
        {
          ...authority, checkId: "gpu-12v2x6", checkType: "12v2x6", observationIds: ["obs-12v2x6"], connectorStandard: "12v2x6",
          state: "connected_verified", fullySeated: true, bendDistanceMm: 20, minimumBendDistanceMm: 35,
        },
        { ...authority, checkId: "cooler-film", checkType: "protective_film", observationIds: ["obs-film"], state: "present_verified" },
        { ...authority, checkId: "loose-metal", checkType: "loose_metal", observationIds: ["obs-metal"], state: "found_verified" },
      ],
    });
    const verdict = Object.fromEntries(result.decisions.map((item) => [item.decisionId.split(".").at(-1), item.verdict]));
    expect(verdict).toMatchObject({ atx24: "blocked", eps: "pass", "gpu-power": "fail", "cpu-fan": "pass", pump: "blocked", "gpu-12v2x6": "fail", "cooler-film": "fail", "loose-metal": "fail" });
  });

  it("projects only strict-replayed pass observations and closes their requirements", () => {
    const evaluation = evaluateAssemblySafety({
      assemblyId: "build-a",
      checks: [{
        ...authority, checkId: "board-screws", checkType: "resource", resourceId: "board-screws", observationIds: ["obs-screws"],
        role: "motherboard_screw", kind: "fastener", predicates: [{ facetId: "fastener.thread", operator: "eq", value: "6-32" }],
        quantity: 4, criticality: "safety", requiredBefore: "assembly", state: "present_verified",
      }],
    });
    const supplies = projectVerifiedAssemblySupplies(evaluation);
    expect(supplies).toHaveLength(1);
    expect(supplies[0]).toMatchObject({ ownerInstanceId: "case-a", quantity: 4, observationRefs: ["observation:obs-screws"] });
    const allocation = allocateRequirementSupplies(evaluation.requirements, supplies);
    expect(allocation.requirements).toEqual([]);
    expect(allocation.remainingSupplies[0]?.quantity).toBe(4);
    expect(deriveRequirementReadiness(allocation).powerReady).toBe(true);
    expect(assemblySafetyReferencesRuntime(evaluation)?.observationIds).toEqual(["observation:obs-screws"]);
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(allocation, {
      packageBindings: [], assemblyEvaluations: [evaluation],
    })).toEqual([]);

    const observedSupply = supplies[0];
    if (observedSupply?.source !== "user_resource") throw new Error("fixture assembly supply missing");
    const { source: _source, ownerInstanceId: _owner, ...unscopedObservedSupply } = observedSupply;
    const forgedPurchaseSupply: AllocatableRequirementSupply = {
      ...unscopedObservedSupply, source: "purchase", refId: "forged-purchase",
    };
    const forgedPurchase = allocateRequirementSupplies(evaluation.requirements, [forgedPurchaseSupply]);
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(forgedPurchase, {
      packageBindings: [], assemblyEvaluations: [evaluation],
    }).some((error) => error.includes("lacks locked generator authority"))).toBe(true);

    const forgedUserResource = allocateRequirementSupplies(evaluation.requirements, [{
      ...supplies[0]!, refId: "forged-observation-resource",
    }]);
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(forgedUserResource, {
      packageBindings: [], assemblyEvaluations: [evaluation],
    }).some((error) => error.includes("differ from strict assembly observation projection"))).toBe(true);
  });

  it("does not project a dotted child check through a passing ID prefix", () => {
    const evaluation = evaluateAssemblySafety({
      assemblyId: "build-a",
      checks: [
        {
          ...authority, checkId: "resource", checkType: "resource", resourceId: "safe-resource", observationIds: ["obs-safe"],
          role: "motherboard_screw", kind: "fastener", predicates: [{ facetId: "fastener.thread", operator: "eq", value: "6-32" }],
          quantity: 1, criticality: "safety", requiredBefore: "assembly", state: "present_verified",
        },
        {
          ...authority, checkId: "resource.child", checkType: "resource", resourceId: "child-resource", observationIds: [],
          role: "tool", kind: "tool", predicates: [{ facetId: "tool.drive", operator: "eq", value: "phillips-2" }],
          quantity: 1, criticality: "normal", requiredBefore: "assembly", state: "unknown",
        },
      ],
    });
    const supplies = projectVerifiedAssemblySupplies(evaluation);
    expect(supplies).toHaveLength(1);
    expect(supplies[0]?.kind).toBe("fastener");
    expect(supplies[0]?.refId).toBe("assembly-resource.case-a.safe-resource");
  });

  it("projects verified temporary components and firmware actions from the same strict authority", () => {
    const evaluation = evaluateAssemblySafety({
      assemblyId: "firmware-preflight",
      checks: [
        {
          ...authority, ownerInstanceId: "board-a", checkId: "working-cpu", checkType: "resource", resourceId: "working-cpu",
          observationIds: ["obs-working-cpu"], role: "temporary_component", kind: "component",
          predicates: [{ facetId: "identity.category", operator: "eq", value: "cpu" }],
          quantity: 1, criticality: "boot", requiredBefore: "first_boot", state: "present_verified",
        },
        {
          ...authority, ownerInstanceId: "board-a", checkId: "firmware-media", checkType: "resource", resourceId: "firmware-media",
          observationIds: ["obs-firmware-media"], role: "firmware_medium", kind: "firmware_action",
          predicates: [{ facetId: "firmware.upgrade_path_refs", operator: "includes", value: "req-media" }],
          quantity: 1, criticality: "boot", requiredBefore: "first_boot", state: "present_verified",
        },
      ],
    });
    const supplies = projectVerifiedAssemblySupplies(evaluation);
    expect(supplies.map(({ kind }) => kind)).toEqual(["firmware_action", "component"]);
    expect(supplies.every(({ ownerInstanceId }) => ownerInstanceId === "board-a")).toBe(true);
    const allocation = allocateRequirementSupplies(evaluation.requirements, supplies);
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(allocation, {
      packageBindings: [], assemblyEvaluations: [evaluation],
    })).toEqual([]);
  });

  it("rejects reusing one observation as multiple independent resource quantities", () => {
    expect(() => evaluateAssemblySafety({
      assemblyId: "duplicate-observation",
      checks: ["a", "b"].map((checkId) => ({
        ...authority, checkId, checkType: "resource" as const, resourceId: `resource-${checkId}`, observationIds: ["obs-one-count"],
        role: "motherboard_screw" as const, kind: "fastener" as const,
        predicates: [{ facetId: "fastener.thread" as const, operator: "eq" as const, value: "6-32" }],
        quantity: 4, criticality: "safety" as const, requiredBefore: "assembly" as const, state: "present_verified" as const,
      })),
    })).toThrow(/cannot be reused across checks/);
  });

  it("rejects overlapping physical standoff positions across assembly projections", () => {
    const standoffs = (assemblyId: string, expectedPositionIds: string[]) => evaluateAssemblySafety({
      assemblyId,
      checks: [{
        ...authority,
        checkId: "board-standoffs",
        checkType: "standoff_layout" as const,
        observationIds: [`obs-${assemblyId}`],
        expectedPositionIds,
        expectedThread: "6-32",
        expectedHeightMm: 6.5,
        heightToleranceMm: 0.2,
        observed: expectedPositionIds.map((positionId) => ({ positionId, thread: "6-32", heightMm: 6.5 })),
      }],
    });
    const first = standoffs("build-a", ["a", "b"]);
    const second = standoffs("build-b", ["b", "c"]);
    const allocation = allocateRequirementSupplies(
      [...first.requirements, ...second.requirements],
      [...projectVerifiedAssemblySupplies(first), ...projectVerifiedAssemblySupplies(second)],
    );
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(allocation, {
      packageBindings: [], assemblyEvaluations: [first, second],
    })).toContain("assembly projected standoff repeats a physical owner/position: case-a\u0000b");
  });

  it("rejects duplicating one observed non-resource assertion across assemblies", () => {
    const connection = (assemblyId: string) => evaluateAssemblySafety({
      assemblyId,
      checks: [{
        ...authority,
        checkId: "eps-connected",
        checkType: "connection" as const,
        observationIds: ["obs-eps-assertion"],
        connectionKind: "eps" as const,
        connectorStandard: "power.eps-8pin",
        state: "connected_verified" as const,
      }],
    });
    const first = connection("build-a");
    const second = connection("build-b");
    const allocation = allocateRequirementSupplies(
      [...first.requirements, ...second.requirements],
      [...projectVerifiedAssemblySupplies(first), ...projectVerifiedAssemblySupplies(second)],
    );
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(allocation, {
      packageBindings: [], assemblyEvaluations: [first, second],
    }).some((error) => error.includes("repeats an owner/semantic assertion"))).toBe(true);
  });

  it("strictly replays checksum-correct nested mutations", () => {
    const evaluation = evaluateAssemblySafety({
      assemblyId: "build-a",
      checks: [{ ...authority, checkId: "metal", checkType: "loose_metal", observationIds: [], state: "unknown" }],
    });
    expect(validateAssemblySafetyEvaluationRuntime(evaluation)).toEqual([]);
    const forged = structuredClone(evaluation);
    forged.decisions[0]!.verdict = "pass";
    forged.contentHash = requirementArtifactContentHashRuntime(forged, forged.schemaVersion)!;
    expect(validateAssemblySafetyEvaluationRuntime(forged)).toContain("assembly safety evaluation differs from authoritative replay");
    expect(validateAssemblySafetyEvaluationRuntime({ ...evaluation, trusted: true })).toContain("assembly safety evaluation shape/schema invalid");
  });
});
