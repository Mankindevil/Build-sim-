import { describe, expect, it } from "vitest";
import { evaluateSystemProfile } from "../src/system-profiles/evaluate";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY } from "../src/system-profiles/registry";
import { configFor, firmwarePath, passChecks } from "./helpers/u7-fixtures";

describe("U7 system compatibility", () => {
  it("passes only when firmware and every selected-profile support path are governed", () => {
    const profileId = "system.windows-11" as const;
    const profile = DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(profileId);
    const result = evaluateSystemProfile({ config: configFor(profileId), profile, firmwareEvaluations: [firmwarePath()], checks: passChecks(profileId) });
    expect(result.verdict).toBe("pass");
    expect(result.requirements).toEqual([]);
    expect(result.decisions.map(({ verdict }) => verdict)).not.toContain("blocked");
  });

  it("blocks an unknown driver and fails a known unsupported boot path", () => {
    const profileId = "system.truenas-scale" as const;
    const profile = DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(profileId);
    const unknown = passChecks(profileId).filter(({ checkId }) => checkId !== "network_driver");
    const blocked = evaluateSystemProfile({ config: configFor(profileId), profile, firmwareEvaluations: [firmwarePath()], checks: unknown });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.requirements.map(({ requirementId }) => requirementId)).toContain("requirement.system.system.truenas-scale.network_driver");
    const failedChecks = passChecks(profileId).map((check) => check.checkId === "hba_it_mode" ? { ...check, status: "fail" as const, message: "controller is RAID-only" } : check);
    expect(evaluateSystemProfile({ config: configFor(profileId), profile, firmwareEvaluations: [firmwarePath()], checks: failedChecks }).verdict).toBe("fail");
  });

  it("requires a current firmware observation/path instead of treating a target release as boot proof", () => {
    const profileId = "system.windows-11" as const;
    const profile = DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve(profileId);
    const result = evaluateSystemProfile({ config: configFor(profileId), profile, firmwareEvaluations: [], checks: passChecks(profileId) });
    expect(result.verdict).toBe("blocked");
    expect(result.decisions.find(({ decisionId }) => decisionId.endsWith("firmware_path"))?.message).toMatch(/not proven/);
  });
});
