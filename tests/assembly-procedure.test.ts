import { describe, expect, it } from "vitest";
import { generateAssemblyProcedure } from "../src/assembly/plan";
import type { DomainHashes } from "../src/hash";
import type { RequirementNode, RequirementSatisfaction } from "../src/requirements/contracts";
import type { CableRouteResult } from "../src/routing";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const HASH = "a".repeat(64);
const domains: DomainHashes = {
  compatibilityHash: "1".repeat(64), spatialHash: "2".repeat(64), simulationHash: "3".repeat(64),
  procedureSafetyHash: "4".repeat(64), priceHash: "5".repeat(64),
};

function input() {
  const config = createEmptyBuildConfigV3("plan-assembly", "Assembly", "2026-08-29T10:00:00.000Z");
  config.components = [
    { instanceId: "case", kind: "case", role: "case", state: "planned", identity: { status: "resolved", skuId: "case.fixture", identityClaimIds: ["claim-case"] }, source: "user" },
    { instanceId: "board", kind: "motherboard", role: "board", state: "planned", identity: { status: "resolved", skuId: "board.fixture", identityClaimIds: ["claim-board"] }, source: "user" },
    { instanceId: "cable", kind: "cable", role: "power", state: "planned", identity: { status: "resolved", skuId: "cable.fixture", identityClaimIds: ["claim-cable"] }, source: "user" },
  ];
  config.placements = [{ placementId: "board-placement", componentInstanceId: "board", mountOwnerInstanceId: "case", mountId: "board-tray" }];
  const requirements: RequirementNode[] = [
    {
      requirementId: "requirement-board-tool", kind: "tool", predicates: [], quantity: 1, criticality: "safety", requiredBefore: "assembly",
      producedBy: { ruleId: "assembly.board", ruleVersion: "1", instanceIds: ["board", "case"] }, evidenceRefs: ["evidence:manual"],
    },
    {
      requirementId: "requirement-cable", kind: "cable", predicates: [], quantity: 1, criticality: "safety", requiredBefore: "pre_power",
      producedBy: { ruleId: "assembly.cable", ruleVersion: "1", instanceIds: ["cable"] }, evidenceRefs: ["evidence:cable"],
    },
  ];
  const satisfactions: RequirementSatisfaction[] = requirements.map((requirement) => ({
    requirementId: requirement.requirementId, status: "satisfied", residualQuantity: 0,
    allocations: [{
      refId: requirement.kind === "tool" ? "tool:driver" : "component:cable", quantity: 1,
      source: "purchase", availability: "present_verified", verificationStatus: "verified",
      ...(requirement.requiredBefore ? { satisfiesBefore: requirement.requiredBefore } : {}),
      evidenceRefs: [...requirement.evidenceRefs], observationRefs: ["observation:inventory"],
    }],
  }));
  const routes: CableRouteResult[] = [{
    schemaVersion: "cable-route-result-v1", cableInstanceId: "cable",
    fromPortKey: "case:source", toPortKey: "board:input",
    nodeIds: ["zone:rear", "opening:grommet", "zone:board"], edgeIds: ["edge:1", "edge:2"],
    polylineMm: [[0, 0, 0], [20, 0, 0], [40, 10, 0]], geometricLengthMm: 42.36,
    requiredLengthMm: 60, availableLengthMm: 300, bends: [], verdict: "pass", reason: "route_clear",
  }];
  return {
    planVersionId: "version-1", config, evaluationHash: HASH, domainHashes: domains,
    requirements, satisfactions, routes, constraints: [],
    evaluatorArtifactRef: `sha256:${HASH}` as const, evaluatorArtifactHash: HASH, evaluatorVersion: "u8",
  };
}

describe("topology/requirement/route driven assembly procedure", () => {
  it("creates mechanical and wiring phases with central verified resources and stop conditions", () => {
    const generated = generateAssemblyProcedure(input());
    expect(generated.procedure.phases).toEqual(["mechanical", "wiring"]);
    expect(generated.procedure.steps.map(({ stepId }) => stepId)).toEqual(["mechanical:board-placement", "wiring:cable"]);
    expect(generated.resources.find(({ stepId }) => stepId === "mechanical:board-placement")).toMatchObject({
      ready: true, toolRefs: ["tool:driver"], unresolvedRequirementIds: [],
    });
    expect(generated.resources.find(({ stepId }) => stepId === "wiring:cable")).toMatchObject({
      ready: true, cableRefs: ["component:cable"], unresolvedRequirementIds: [],
    });
    expect(generated.procedure.steps[1]).toMatchObject({
      dependsOn: ["mechanical:board-placement"], confirmationPolicy: "observation_required", safetyCritical: true,
    });
    expect(generated.procedure.steps[1]!.action).toContain("opening:grommet");
  });

  it("changes only the affected wiring dependency when route geometry changes", () => {
    const before = generateAssemblyProcedure(input());
    const changed = input();
    changed.routes[0] = { ...changed.routes[0]!, geometricLengthMm: 55, requiredLengthMm: 75 };
    const after = generateAssemblyProcedure(changed);
    const hashByStep = (value: typeof before) => Object.fromEntries(value.procedure.steps.map((step) => [step.stepId, step.dependencyHash]));
    expect(hashByStep(after)["mechanical:board-placement"]).toBe(hashByStep(before)["mechanical:board-placement"]);
    expect(hashByStep(after)["wiring:cable"]).not.toBe(hashByStep(before)["wiring:cable"]);
  });

  it("keeps unresolved resources visible and offers a governed route alternative", () => {
    const value = input();
    value.satisfactions[1] = { requirementId: "requirement-cable", status: "blocked", allocations: [], residualQuantity: 1 };
    value.routes[0] = { ...value.routes[0]!, verdict: "blocked", reason: "no_route", nodeIds: [], edgeIds: [], polylineMm: [], geometricLengthMm: 0, requiredLengthMm: 0 };
    const generated = generateAssemblyProcedure({ ...value, alternativeRouteNodeIds: { cable: ["zone:side", "opening:side"] } });
    expect(generated.resources.find(({ stepId }) => stepId === "wiring:cable")).toMatchObject({
      ready: false, unresolvedRequirementIds: ["requirement-cable"],
    });
    expect(generated.procedure.steps.find(({ stepId }) => stepId === "wiring:cable")?.failureAction).toContain("opening:side");
  });

  it("rejects cyclic declared assembly order instead of inventing an order", () => {
    const value = input();
    expect(() => generateAssemblyProcedure({
      ...value,
      constraints: [
        { constraintId: "a", beforeStepId: "mechanical:board-placement", afterStepId: "wiring:cable", evidenceRefs: ["manual:a"] },
        { constraintId: "b", beforeStepId: "wiring:cable", afterStepId: "mechanical:board-placement", evidenceRefs: ["manual:b"] },
      ],
    })).toThrow(/cycle/);
  });
});
