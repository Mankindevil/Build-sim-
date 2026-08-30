import { describe, expect, it } from "vitest";
import { computeRequirementClosure, type RequirementClosureRule } from "../src/requirements/closure";
import type { RequirementNode } from "../src/requirements/contracts";
import {
  requirementArtifactContentHashRuntime,
  validateRequirementClosureRuntime,
  validateRequirementClosureReplayRuntime,
} from "../src/requirements/runtime.mjs";

function node(requirementId: string): RequirementNode {
  return {
    requirementId,
    kind: "accessory",
    predicates: [],
    quantity: 1,
    criticality: "normal",
    requiredBefore: "assembly",
    producedBy: { ruleId: "fixture.root", ruleVersion: "1.0.0", instanceIds: ["case-a"] },
    evidenceRefs: ["fact-fixture"],
  };
}

describe("requirement fixed-point closure", () => {
  it("runs candidate-induced requirements to a deterministic fixed point", () => {
    const rule: RequirementClosureRule = {
      ruleId: "fixture.chain",
      ruleVersion: "1.0.0",
      expand(requirement) {
        if (requirement.requirementId === "root") return [node("bracket")];
        if (requirement.requirementId === "bracket") return [node("fastener")];
        if (requirement.requirementId === "fastener") return [node("tool")];
        return [];
      },
    };
    const closure = computeRequirementClosure({ roots: [node("root")], rules: [rule] });
    expect(closure.reachedFixedPoint).toBe(true);
    expect(closure.requirements.map(({ requirementId }) => requirementId)).toEqual(["bracket", "fastener", "root", "tool"]);
    expect(closure.edges).toHaveLength(3);
    expect(closure.cycles).toEqual([]);
    expect(closure.blockedRequirementIds).toEqual([]);
    expect(validateRequirementClosureRuntime(closure)).toEqual([]);
  });

  it("records one concrete cycle per SCC and binds blocked IDs to it", () => {
    const root = node("a");
    const other = node("b");
    const rule: RequirementClosureRule = {
      ruleId: "fixture.cycle",
      ruleVersion: "1.0.0",
      expand(requirement) {
        return requirement.requirementId === "a" ? [other] : requirement.requirementId === "b" ? [root] : [];
      },
    };
    const closure = computeRequirementClosure({ roots: [root], rules: [rule] });
    expect(closure.cycles).toEqual([["a", "b"]]);
    expect(closure.blockedRequirementIds).toEqual(["a", "b"]);

    const forged = structuredClone(closure);
    forged.blockedRequirementIds = [];
    forged.contentHash = requirementArtifactContentHashRuntime(forged, forged.schemaVersion)!;
    expect(validateRequirementClosureRuntime(forged)).toContain("requirement closure blocked IDs are inconsistent with fixed-point/cycles");
  });

  it("rejects a checksum-correct alternate closed path inside the same SCC", () => {
    const nodes = new Map(["a", "b", "c"].map((requirementId) => [requirementId, node(requirementId)]));
    const rule: RequirementClosureRule = {
      ruleId: "fixture.multi-cycle",
      ruleVersion: "1.0.0",
      expand(requirement) {
        if (requirement.requirementId === "a") return [nodes.get("b")!];
        if (requirement.requirementId === "b") return [nodes.get("a")!, nodes.get("c")!];
        if (requirement.requirementId === "c") return [nodes.get("a")!];
        return [];
      },
    };
    const closure = computeRequirementClosure({ roots: [nodes.get("a")!], rules: [rule] });
    expect(closure.cycles).toEqual([["a", "b"]]);
    const forged = structuredClone(closure);
    forged.cycles = [["a", "b", "c"]];
    forged.contentHash = requirementArtifactContentHashRuntime(forged, forged.schemaVersion)!;
    expect(validateRequirementClosureRuntime(forged)).toContain("requirement closure cycles do not match canonical dependency paths");
  });

  it("fails on conflicting derivations and closes bounds without a false fixed point", () => {
    expect(() => computeRequirementClosure({ roots: [node("same"), { ...node("same"), quantity: 2 }], rules: [] }))
      .toThrow(/conflicting requirement derivations/);
    const rule: RequirementClosureRule = {
      ruleId: "fixture.unbounded",
      ruleVersion: "1.0.0",
      expand(requirement, snapshot) {
        return [node(`generated-${snapshot.iteration}-${requirement.requirementId}`)];
      },
    };
    const closure = computeRequirementClosure({ roots: [node("root")], rules: [rule], maxIterations: 1, maxRequirements: 8 });
    expect(closure.reachedFixedPoint).toBe(false);
    expect(closure.blockedRequirementIds).toEqual(closure.requirements.map(({ requirementId }) => requirementId).sort());
    expect(validateRequirementClosureReplayRuntime(closure, {
      roots: [node("root")], rules: [rule], maxIterations: 1, maxRequirements: 8,
    })).toEqual([]);

    const forged = structuredClone(closure);
    forged.reachedFixedPoint = true;
    forged.blockedRequirementIds = [];
    forged.contentHash = requirementArtifactContentHashRuntime(forged, forged.schemaVersion)!;
    // A structural artifact cannot prove executable convergence by itself.
    expect(validateRequirementClosureRuntime(forged)).toEqual([]);
    expect(validateRequirementClosureReplayRuntime(forged, {
      roots: [node("root")], rules: [rule], maxIterations: 1, maxRequirements: 8,
    })).toContain("requirement closure differs from locked fixed-point replay");
  });

  it("treats object property insertion order as semantically identical provenance", () => {
    const original = node("same");
    const reordered = {
      evidenceRefs: [...original.evidenceRefs],
      producedBy: {
        instanceIds: [...original.producedBy.instanceIds],
        ruleVersion: original.producedBy.ruleVersion,
        ruleId: original.producedBy.ruleId,
      },
      requiredBefore: "assembly" as const,
      criticality: original.criticality,
      quantity: original.quantity,
      predicates: [...original.predicates],
      kind: original.kind,
      requirementId: original.requirementId,
    } satisfies RequirementNode;
    const closure = computeRequirementClosure({ roots: [original, reordered], rules: [] });
    expect(closure.requirements).toHaveLength(1);
    expect(validateRequirementClosureRuntime(closure)).toEqual([]);
    expect(validateRequirementClosureReplayRuntime(closure, {
      roots: [original, reordered], rules: [],
    })).toContain("requirement closure replay roots must be unique and canonically ordered");
  });

  it("does not let an executable rule mutate the fixed-point snapshot authority", () => {
    const mutatingRule: RequirementClosureRule = {
      ruleId: "fixture.mutating",
      ruleVersion: "1.0.0",
      expand(_requirement, snapshot) {
        (snapshot.requirements[0] as RequirementNode).quantity = 99;
        return [];
      },
    };
    expect(() => computeRequirementClosure({ roots: [node("root")], rules: [mutatingRule] })).toThrow(TypeError);
  });
});
