import { describe, expect, it } from "vitest";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { projectTopologyBom } from "../src/topology/projections";
import { validateBuildConfigV3 } from "../src/topology/validation";

const timestamp = "2026-08-27T00:00:00.000Z";

describe("U2 topology role decisions", () => {
  it("models an explicit no-GPU decision without a fake component or BOM row", () => {
    const config = createEmptyBuildConfigV3("plan-no-gpu", "No GPU", timestamp);
    config.roleDecisions.push({
      roleDecisionId: "role-gpu-none", role: "discrete_gpu", decision: "not_needed",
      source: "user", confirmedAt: timestamp,
    });
    expect(validateBuildConfigV3(config)).toEqual([]);
    expect(config.components.filter((component) => component.kind === "gpu")).toHaveLength(0);
    expect(projectTopologyBom(config)).toEqual([]);
  });

  it("keeps a true blank distinct from an explicit no-GPU decision", () => {
    const blank = createEmptyBuildConfigV3("plan-blank", "Blank", timestamp);
    expect(blank.components).toEqual([]);
    expect(blank.roleDecisions).toEqual([]);
    expect(validateBuildConfigV3(blank)).toEqual([]);
  });

  it("rejects role conflicts, fake component states and unaudited confirmations", () => {
    const config = createEmptyBuildConfigV3("plan-conflict", "Conflict", timestamp);
    config.components.push({
      instanceId: "gpu-1", kind: "gpu", role: "discrete_gpu", state: "planned", source: "user",
      identity: { status: "unresolved", userText: "用户还没确认型号" },
    });
    config.roleDecisions.push({
      roleDecisionId: "role-gpu-none", role: "discrete_gpu", decision: "not_needed",
      source: "user", confirmedAt: "today",
    });
    expect(validateBuildConfigV3(config)).toEqual(expect.arrayContaining([
      "roleDecisions.0.confirmedAt must be an ISO UTC timestamp",
      "roleDecisions.0 conflicts with an existing component role",
    ]));

    const impossible = structuredClone(config) as any;
    impossible.components[0].state = "installed";
    expect(validateBuildConfigV3(impossible)).toContain("components.0.state invalid");
    impossible.components[0].state = "not_needed";
    expect(validateBuildConfigV3(impossible)).toContain("components.0.state invalid");
  });
});
