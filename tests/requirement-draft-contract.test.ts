import { describe, expect, it } from "vitest";
import {
  solverActiveConstraints,
  solverHardMetrics,
  validateRequirementDraftField,
  validateRequirementSpec,
  type RequirementSpec,
} from "../src/requirements/contracts";

describe("U0 progressive requirement drafts", () => {
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
      workloads: [{ workloadId: "gaming", name: "1440p", metrics: [{ metricId: "performance.gpu.frame_rate", operator: "gte", value: 90, unitId: "fps", priority: "must", benchmarkId: "benchmark.game.fps", benchmarkContext: { title: "fixture-game", titleVersion: "1.0", resolution: "2560x1440", qualityPreset: "high", graphicsApi: "dx12" } }] }],
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
      workloads: [{ workloadId: "game", name: "Game", metrics: [{ metricId: "performance.gpu.frame_rate", operator: "gte", value: 90, unitId: "fps", priority: "must", benchmarkId: "benchmark.game.fps", benchmarkContext: { title: "fixture-game", titleVersion: "1.0", resolution: "2560x1440", qualityPreset: "high", graphicsApi: "dx12" } }] }],
      constraints: [],
    };
    expect(validateRequirementSpec(spec)).toEqual([]);
    expect(solverHardMetrics(spec)).toEqual([]);
    spec.workloads[0]!.metrics[0] = { ...spec.workloads[0]!.metrics[0]!, source: "user", confirmedByUser: true };
    expect(solverHardMetrics(spec).map(({ workloadId }) => workloadId)).toEqual(["game"]);
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
