import { describe, expect, it } from "vitest";
import {
  solverActiveConstraints,
  solverActiveMetrics,
  solverAnsweredDraftValue,
  solverHardMetrics,
  validateRequirementDraftField,
  validateRequirementSpec,
  type RequirementSpec,
} from "../src/requirements/contracts";
import { normalizeRequirementSpec, requirementMetricIdentity } from "../src/requirements/normalize";
import { validateGovernedPatchOperation } from "../src/contracts/registries";

describe("U2 progressive requirement drafts", () => {
  it("saves deferred, budget-only, workload-only and empty-array specs", () => {
    expect(validateRequirementDraftField({ state: "deferred", source: "user", confirmedByUser: false }, (_): _ is number => true)).toEqual([]);
    expect(validateRequirementDraftField({ state: "deferred", value: 5, source: "user", confirmedByUser: false }, (_): _ is number => true)).toContain("deferred draft field must not contain value");

    const budgetOnly: RequirementSpec = {
      requirementSpecId: "budget-only",
      schemaVersion: "1.0.0",
      budget: { state: "answered", value: { hardCapCny: 8_000 }, source: "user", confirmedByUser: true },
      workloads: [],
      constraints: [],
      horizonYears: { state: "deferred", source: "user", confirmedByUser: false },
    };
    expect(validateRequirementSpec(budgetOnly)).toEqual([]);
    expect(validateRequirementSpec({ ...budgetOnly, budget: undefined })).not.toEqual([]);

    const workloadOnly: RequirementSpec = {
      requirementSpecId: "workload-only",
      schemaVersion: "1.0.0",
      workloads: [{
        workloadId: "gaming", state: "answered", source: "user", confirmedByUser: true,
        name: "1440p",
        metrics: [{
          metricId: "performance.gpu.frame_rate", state: "answered", operator: "gte", value: 90,
          unitId: "fps", priority: "must", source: "user", confirmedByUser: true,
          benchmarkId: "benchmark.game.fps",
          benchmarkContext: { title: "fixture-game", titleVersion: "1.0", resolution: "2560x1440", qualityPreset: "high", graphicsApi: "dx12" },
        }],
      }],
      constraints: [],
    };
    expect(validateRequirementSpec(workloadOnly)).toEqual([]);
    expect(validateRequirementSpec({
      ...workloadOnly,
      workloads: [{ ...workloadOnly.workloads[0]!, metrics: [workloadOnly.workloads[0]!.metrics[0]!, { ...workloadOnly.workloads[0]!.metrics[0]! }] }],
    })).toContain("workloads.0.metricId must be unique for stable selection");

    const allDeferred: RequirementSpec = {
      requirementSpecId: "all-deferred",
      schemaVersion: "1.0.0",
      budget: { state: "deferred", source: "user", confirmedByUser: false },
      workloads: [],
      constraints: [],
      horizonYears: { state: "deferred", source: "user", confirmedByUser: false },
    };
    expect(validateRequirementSpec(allDeferred)).toEqual([]);
    expect(validateRequirementSpec({ requirementSpecId: "empty-optional", schemaVersion: "1.0.0", workloads: [], constraints: [] })).toEqual([]);
  });

  it("persists but does not activate an unconfirmed Agent hard constraint", () => {
    const spec: RequirementSpec = {
      requirementSpecId: "agent-proposal",
      schemaVersion: "1.0.0",
      workloads: [],
      constraints: [{
        constraintId: "small-case",
        state: "answered",
        predicate: { facetId: "case.motherboard_form_factors", operator: "includes", value: "mini-itx" },
        strength: "hard",
        source: "agent_proposed",
        confirmedByUser: false,
      }],
    };
    expect(validateRequirementSpec(spec)).toEqual([]);
    expect(solverActiveConstraints(spec)).toEqual([]);
    spec.constraints[0]!.confirmedByUser = true;
    expect(solverActiveConstraints(spec).map((item) => item.constraintId)).toEqual(["small-case"]);
  });

  it("never activates any hard constraint before explicit user confirmation", () => {
    const spec: RequirementSpec = {
      requirementSpecId: "unconfirmed-hard",
      schemaVersion: "1.0.0",
      workloads: [],
      constraints: (["user", "migration", "agent_proposed"] as const).map((source) => ({
        constraintId: `constraint-${source}`,
        state: "answered" as const,
        predicate: { facetId: "cpu.socket", operator: "eq", value: "AM5" },
        strength: "hard",
        source,
        confirmedByUser: false,
      })),
    };
    expect(validateRequirementSpec(spec)).toEqual([]);
    expect(solverActiveConstraints(spec)).toEqual([]);
    spec.constraints[1]!.confirmedByUser = true;
    expect(solverActiveConstraints(spec).map(({ constraintId }) => constraintId)).toEqual(["constraint-migration"]);
  });

  it("maps must metrics to hard constraints only after explicit user confirmation", () => {
    const spec: RequirementSpec = {
      requirementSpecId: "workload",
      schemaVersion: "1.0.0",
      workloads: [{
        workloadId: "game", state: "answered", name: "Game", source: "user", confirmedByUser: true,
        metrics: [{
          metricId: "performance.gpu.frame_rate", state: "answered", operator: "gte", value: 90,
          unitId: "fps", priority: "must", source: "agent_proposed", confirmedByUser: false,
          benchmarkId: "benchmark.game.fps",
          benchmarkContext: { title: "fixture-game", titleVersion: "1.0", resolution: "2560x1440", qualityPreset: "high", graphicsApi: "dx12" },
        }],
      }],
      constraints: [],
    };
    expect(validateRequirementSpec(spec)).toEqual([]);
    expect(solverHardMetrics(spec)).toEqual([]);
    const workload = spec.workloads[0]!;
    if (workload.state !== "answered") throw new Error("fixture workload must be answered");
    workload.metrics[0] = { ...workload.metrics[0]!, source: "agent_proposed", confirmedByUser: true };
    expect(solverHardMetrics(spec).map(({ workloadId }) => workloadId)).toEqual(["game"]);
  });

  it("persists per-field answered, deferred and not-applicable states without activating proposals", () => {
    const spec: RequirementSpec = {
      requirementSpecId: "progressive-fields",
      schemaVersion: "1.0.0",
      budget: { state: "answered", value: { hardCapCny: 9_000 }, source: "agent_proposed", confirmedByUser: false },
      workloads: [{
        workloadId: "whole-build", state: "answered", name: "Whole build goals",
        source: "user", confirmedByUser: true,
        metrics: [
          { metricId: "storage.usable_capacity", state: "answered", operator: "gte", value: 16, unitId: "tib", priority: "must", source: "user", confirmedByUser: true },
          { metricId: "network.throughput", state: "deferred", source: "user", confirmedByUser: false },
          { metricId: "acoustics.noise", state: "not_applicable", source: "user", confirmedByUser: true },
          { metricId: "physical.case_volume", state: "answered", operator: "lte", value: 25, unitId: "liter", priority: "important", source: "agent_proposed", confirmedByUser: false },
        ],
      }, {
        workloadId: "future-workload", metrics: [], state: "deferred", source: "user", confirmedByUser: false,
      }],
      constraints: [
        { constraintId: "agent-hard", state: "answered", predicate: { facetId: "cpu.socket", operator: "eq", value: "AM5" }, strength: "hard", source: "agent_proposed", confirmedByUser: false },
        { constraintId: "agent-soft", state: "answered", predicate: { facetId: "case.side_panel", operator: "eq", value: "solid" }, strength: "soft", source: "agent_proposed", confirmedByUser: false },
        { constraintId: "later", state: "deferred", source: "user", confirmedByUser: false },
      ],
      horizonYears: { state: "not_applicable", source: "user", confirmedByUser: true },
    };
    expect(validateRequirementSpec(spec)).toEqual([]);
    expect(solverAnsweredDraftValue(spec.budget)).toBeNull();
    expect(solverAnsweredDraftValue(spec.horizonYears)).toBeNull();
    expect(solverActiveConstraints(spec)).toEqual([]);
    expect(solverActiveMetrics(spec)).toEqual([
      expect.objectContaining({ workloadId: "whole-build", strength: "hard", metric: expect.objectContaining({ metricId: "storage.usable_capacity" }) }),
    ]);
    const confirmedSoft = structuredClone(spec);
    confirmedSoft.constraints[1]!.confirmedByUser = true;
    expect(solverActiveConstraints(confirmedSoft).map(({ constraintId, strength }) => [constraintId, strength]))
      .toEqual([["agent-soft", "soft"]]);

    const badDeferredMetric = structuredClone(spec) as any;
    badDeferredMetric.workloads[0].metrics[1].operator = "gte";
    expect(validateRequirementSpec(badDeferredMetric))
      .toContain("workloads.0.metrics.1: deferred requirement metric must not contain an answered value");
  });

  it("normalizes set ordering without changing stable parent-scoped identities", () => {
    const first: RequirementSpec = {
      requirementSpecId: "canonical-spec", schemaVersion: "1.0.0",
      workloads: [{
        workloadId: "z-workload", state: "answered", name: "Zulu", source: "user", confirmedByUser: true,
        evidenceOrBenchmarkRefs: ["ref-z", "ref-a"],
        metrics: [
          { metricId: "physical.case_volume", state: "answered", operator: "lte", value: 30, unitId: "liter", priority: "nice_to_have", source: "user", confirmedByUser: true },
          { metricId: "network.throughput", state: "answered", operator: "gte", value: 10, unitId: "gbps", priority: "important", source: "user", confirmedByUser: true },
        ],
      }, { workloadId: "a-workload", metrics: [], state: "not_applicable", source: "user", confirmedByUser: true }],
      constraints: [
        { constraintId: "z-constraint", state: "not_applicable", source: "user", confirmedByUser: true },
        { constraintId: "a-constraint", state: "deferred", source: "user", confirmedByUser: false },
      ],
    };
    const second = structuredClone(first);
    second.workloads.reverse();
    second.constraints.reverse();
    const answered = second.workloads.find((item) => item.workloadId === "z-workload");
    if (answered?.state !== "answered") throw new Error("fixture workload must be answered");
    answered.metrics.reverse();
    answered.evidenceOrBenchmarkRefs?.reverse();

    expect(normalizeRequirementSpec(first)).toEqual(normalizeRequirementSpec(second));
    expect(first.workloads[0]!.workloadId).toBe("z-workload");
    expect(requirementMetricIdentity("z-workload", "network.throughput"))
      .toBe('["z-workload","network.throughput"]');
    expect(requirementMetricIdentity("other-workload", "network.throughput"))
      .not.toBe(requirementMetricIdentity("z-workload", "network.throughput"));
    expect(validateRequirementSpec({
      requirementSpecId: "unicode-collision", schemaVersion: "1.0.0", constraints: [],
      workloads: [
        { workloadId: "caf\u00e9", metrics: [], state: "deferred", source: "user", confirmedByUser: false },
        { workloadId: "cafe\u0301", metrics: [], state: "deferred", source: "user", confirmedByUser: false },
      ],
    })).toContain("workloads.1.workloadId invalid or duplicate");
  });

  it("keeps governed proposal validation aligned with canonical draft entities", () => {
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "workloads", id: "agent-workload" },
      value: { workloadId: "agent-workload", metrics: [], state: "deferred", source: "agent_proposed", confirmedByUser: false },
    }, { actor: "agent" })).toEqual([]);
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "metrics", parentId: "agent-workload", id: "physical.case_volume" },
      value: { metricId: "physical.case_volume", state: "answered", operator: "lte", value: 25, unitId: "liter", priority: "important", source: "agent_proposed", confirmedByUser: false },
    }, { actor: "agent" })).toEqual([]);
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "constraints", id: "agent-soft" },
      value: { constraintId: "agent-soft", state: "answered", predicate: { facetId: "case.side_panel", operator: "eq", value: "solid" }, strength: "soft", source: "agent_proposed", confirmedByUser: true },
    }, { actor: "agent" })).toContain("agent patch cannot assert user source, confirmation, confirmedAt or lockedByUser");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "metrics", parentId: "agent-workload", id: "network.throughput" },
      value: { metricId: "network.throughput", state: "deferred", operator: "gte", source: "agent_proposed", confirmedByUser: false },
    }, { actor: "agent" })).toContain("deferred metric must not contain answered fields");
  });

  it("rejects derived RequirementNode fields inside a persisted RequirementSpec", () => {
    expect(validateRequirementSpec({
      requirementSpecId: "bad",
      schemaVersion: "1.0.0",
      workloads: [],
      constraints: [],
      remediation: [{ requirementId: "derived" }],
    })).toContain("requirement spec contains derived or unknown fields");
  });
});
