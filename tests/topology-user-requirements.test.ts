import { describe, expect, it } from "vitest";
import { createEmptyBuildConfigV3, validateBuildConfigV3 } from "../src/topology/contracts";
import { solverActiveMetrics, type RequirementSpec } from "../src/requirements/contracts";

describe("U2 requirement-only topology", () => {
  it("persists budget, workload, capacity, throughput, noise, case volume and horizon with zero hardware", () => {
    const config = createEmptyBuildConfigV3("requirements-only", "Requirements only", "2026-08-27T12:00:00.000Z");
    const requirementSpec: RequirementSpec = {
      requirementSpecId: "req-workstation-001",
      schemaVersion: "1.0.0",
      budget: {
        state: "answered", value: { targetCny: 12_000, hardCapCny: 15_000, reserveCny: 1_000 },
        source: "user", confirmedByUser: true,
      },
      workloads: [{
        workloadId: "creator-workload", state: "answered", name: "Creator and NAS workload",
        source: "user", confirmedByUser: true,
        metrics: [
          { metricId: "storage.usable_capacity", state: "answered", operator: "gte", value: 20, unitId: "tib", priority: "must", source: "user", confirmedByUser: true },
          { metricId: "network.throughput", state: "answered", operator: "gte", value: 10, unitId: "gbps", priority: "important", source: "user", confirmedByUser: true },
          { metricId: "acoustics.noise", state: "answered", operator: "lte", value: 35, unitId: "dba", priority: "important", source: "user", confirmedByUser: true },
          { metricId: "physical.case_volume", state: "answered", operator: "lte", value: 30, unitId: "liter", priority: "nice_to_have", source: "user", confirmedByUser: true },
        ],
      }],
      constraints: [],
      horizonYears: { state: "answered", value: 6, source: "user", confirmedByUser: true },
    };
    config.requirementSpec = requirementSpec;

    expect(validateBuildConfigV3(config)).toEqual([]);
    expect(config.components).toEqual([]);
    expect(config.placements).toEqual([]);
    expect(config.connections).toEqual([]);
    expect(solverActiveMetrics(requirementSpec).map(({ metric, strength }) => [metric.metricId, strength])).toEqual([
      ["storage.usable_capacity", "hard"],
      ["network.throughput", "soft"],
      ["acoustics.noise", "soft"],
      ["physical.case_volume", "soft"],
    ]);
  });

  it("does not permit evaluator-derived RequirementNode state anywhere in config", () => {
    const config = createEmptyBuildConfigV3("derived-boundary", "Derived boundary", "2026-08-27T12:00:00.000Z");
    config.requirementSpec = {
      requirementSpecId: "requirements", schemaVersion: "1.0.0", workloads: [], constraints: [],
    };

    expect(validateBuildConfigV3({ ...config, derivedRequirements: [] }))
      .toContain("build config contains derived or unknown fields");
    expect(validateBuildConfigV3({
      ...config,
      requirementSpec: { ...config.requirementSpec, requirementNodes: [] },
    })).toContain("requirementSpec: requirement spec contains derived or unknown fields");
  });
});
