import { describe, expect, it } from "vitest";
import { commissioningChecks } from "../src/build-execution/commissioning";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY } from "../src/system-profiles/registry";

describe("U7 commissioning gates", () => {
  it("separates physical POST/temperature checks from system-specific install checks", () => {
    const windows = commissioningChecks(DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve("system.windows-11"));
    expect(windows.map(({ checkId }) => checkId)).toEqual(expect.arrayContaining(["post", "temperature", "windows-security", "bitlocker-recovery", "windows-drivers"]));
    const nas = commissioningChecks(DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve("system.truenas-scale"));
    expect(nas.map(({ checkId }) => checkId)).toEqual(expect.arrayContaining(["post", "temperature", "truenas-hba", "truenas-install-target", "truenas-data-protection"]));
  });
});
