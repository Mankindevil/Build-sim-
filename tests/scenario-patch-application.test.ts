import { describe, expect, it } from "vitest";
import { applyTopologyV3Patch, ScenarioPatchError } from "../src/scenarios/patch";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";

const timestamp = "2026-08-27T00:00:00.000Z";

function component(instanceId: string, kind: "case" | "motherboard" | "cable" = "case") {
  return {
    instanceId,
    kind,
    role: kind,
    state: "planned" as const,
    identity: { status: "unresolved" as const, userText: instanceId },
    source: "user" as const,
  };
}

describe("U2 stable-selector topology patch application", () => {
  it("applies ordered entity operations without mutating the base or using array indexes", () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    const result = applyTopologyV3Patch(base, [
      { op: "add", selector: { collection: "components", id: "case-1" }, value: component("case-1") },
      { op: "add", selector: { collection: "components", id: "board-1" }, value: component("board-1", "motherboard") },
      { op: "add", selector: { collection: "placements", id: "placement-board" }, value: {
        placementId: "placement-board", componentInstanceId: "board-1", mountOwnerInstanceId: "case-1", mountId: "motherboard-tray",
      } },
      { op: "replace", selector: { collection: "components", id: "board-1", field: "state" }, value: "ordered" },
      { op: "replace", selector: { collection: "config", field: "name" }, value: "Scenario board" },
    ]);

    expect(base.components).toEqual([]);
    expect(result.components.map((value) => value.instanceId)).toEqual(["board-1", "case-1"]);
    expect(result.components.find((value) => value.instanceId === "board-1")?.state).toBe("ordered");
    expect(result.placements).toHaveLength(1);
    expect(result.name).toBe("Scenario board");
  });

  it("requires stable target existence and rejects duplicate adds", () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    expect(() => applyTopologyV3Patch(base, [
      { op: "replace", selector: { collection: "components", id: "missing", field: "state" }, value: "ordered" },
    ])).toThrowError(expect.objectContaining({ code: "target_missing" }));
    expect(() => applyTopologyV3Patch(base, [
      { op: "add", selector: { collection: "components", id: "case-1" }, value: component("case-1") },
      { op: "add", selector: { collection: "components", id: "case-1" }, value: component("case-1") },
    ])).toThrowError(expect.objectContaining({ code: "target_exists" }));
  });

  it("performs complete final validation and rejects dangling references", () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    expect(() => applyTopologyV3Patch(base, [{
      op: "add",
      selector: { collection: "connections", id: "power-1" },
      value: { connectionId: "power-1", from: { instanceId: "missing-a", portId: "a" }, to: { instanceId: "missing-b", portId: "b" }, status: "required" },
    }])).toThrowError(expect.objectContaining({ code: "invalid_result" }));
  });

  it("maps a null optional cable replacement to field removal", () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    base.components.push(component("a"), component("b"), component("cable-1", "cable"));
    base.connections.push({ connectionId: "connection-1", from: { instanceId: "a", portId: "out" }, to: { instanceId: "b", portId: "in" }, cableInstanceId: "cable-1", status: "planned" });
    const result = applyTopologyV3Patch(base, [{
      op: "replace", selector: { collection: "connections", id: "connection-1", field: "cableInstanceId" }, value: null,
    }]);
    expect(result.connections[0]).not.toHaveProperty("cableInstanceId");
  });

  it("does not let an Agent assert a user-only role decision", () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    expect(() => applyTopologyV3Patch(base, [{
      op: "add", selector: { collection: "roleDecisions", id: "no-gpu" },
      value: { roleDecisionId: "no-gpu", role: "discrete_gpu", decision: "not_needed", source: "user", confirmedAt: timestamp },
    }], { actor: "agent" })).toThrow(ScenarioPatchError);
  });

  it("applies the persisted actor provenance matrix at the TypeScript materializer boundary", () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    expect(() => applyTopologyV3Patch(base, [{
      op: "add", selector: { collection: "components", id: "gpu-agent-proposal" }, value: {
        ...component("gpu-agent-proposal"), kind: "gpu", role: "discrete_gpu", source: "agent",
      },
    }], { actor: "user" })).toThrowError(expect.objectContaining({ code: "invalid_operation" }));
    expect(() => applyTopologyV3Patch(base, [{
      op: "add", selector: { collection: "components", id: "gpu-migration" }, value: {
        ...component("gpu-migration"), kind: "gpu", role: "discrete_gpu", source: "migration",
      },
    }], { actor: "user" })).toThrowError(expect.objectContaining({ code: "invalid_operation" }));
    expect(() => applyTopologyV3Patch(base, [{
      op: "replace", selector: { collection: "config", field: "system" }, value: {
        profileId: "system.truenas-scale", versionFactId: "system-release.truenas-scale.25.04", source: "defaulted", lockedByUser: false,
      },
    }], { actor: "agent" })).toThrowError(expect.objectContaining({ code: "invalid_operation" }));
  });

  it("applies one canonical selector identically to NFC/NFD-equivalent bases", async () => {
    const nfc = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    const nfd = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    nfc.components.push(component("caf\u00e9"));
    nfd.components.push(component("cafe\u0301"));
    const patch = [{
      op: "replace" as const,
      selector: { collection: "components" as const, id: "caf\u00e9", field: "state" as const },
      value: "ordered",
    }];
    expect(await configV3Hash(nfc)).toBe(await configV3Hash(nfd));
    const fromNfc = applyTopologyV3Patch(nfc, patch);
    const fromNfd = applyTopologyV3Patch(nfd, patch);
    expect(fromNfd).toEqual(fromNfc);
    expect(fromNfd.components[0]?.instanceId).toBe("caf\u00e9");
  });

  it("updates budget and horizon independently without replacing prior requirements", async () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    base.requirementSpec = {
      requirementSpecId: "requirements-plan-1", schemaVersion: "1.0.0",
      budget: { state: "answered", value: { targetCny: 8000, hardCapCny: 9000 }, source: "user", confirmedByUser: true },
      horizonYears: { state: "answered", value: 3, source: "user", confirmedByUser: true },
      workloads: [{ workloadId: "workload-nas", name: "NAS", metrics: [], evidenceOrBenchmarkRefs: [] }],
      constraints: [],
    };
    const budget = { state: "answered" as const, value: { targetCny: 10000, hardCapCny: 12000 }, source: "user" as const, confirmedByUser: true };
    const horizon = { state: "answered" as const, value: 5, source: "user" as const, confirmedByUser: true };
    const afterBudget = applyTopologyV3Patch(base, [{ op: "replace", selector: { collection: "config", field: "requirementBudget" }, value: budget }]);
    const afterBoth = applyTopologyV3Patch(afterBudget, [{ op: "replace", selector: { collection: "config", field: "requirementHorizonYears" }, value: horizon }]);
    const combined = applyTopologyV3Patch(base, [
      { op: "replace", selector: { collection: "config", field: "requirementBudget" }, value: budget },
      { op: "replace", selector: { collection: "config", field: "requirementHorizonYears" }, value: horizon },
    ]);
    expect(afterBoth.requirementSpec).toMatchObject({ budget, horizonYears: horizon, workloads: base.requirementSpec.workloads });
    expect(await configV3Hash(afterBoth)).toBe(await configV3Hash(combined));
    expect(afterBoth).not.toHaveProperty("requirementBudget");
    expect(afterBoth).not.toHaveProperty("requirementHorizonYears");
  });

  it("rejects granular requirement updates until the first complete spec exists", () => {
    const base = createEmptyBuildConfigV3("plan-1", "Blank", timestamp);
    expect(() => applyTopologyV3Patch(base, [{
      op: "replace", selector: { collection: "config", field: "requirementBudget" },
      value: { state: "answered", value: { targetCny: 8000, hardCapCny: 9000 }, source: "user", confirmedByUser: true },
    }])).toThrowError(expect.objectContaining({ code: "target_missing" }));
  });
});
