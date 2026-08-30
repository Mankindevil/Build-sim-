import { describe, expect, it } from "vitest";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { recommendSystemForIntent, userSystemSelection, withRecommendedSystem } from "../src/system-profiles/defaults";
import { DEFAULT_SYSTEM_PROFILE_REGISTRY, validateSystemProfileRegistry } from "../src/system-profiles/registry";
import { validateWorkspaceSystemProfilePayloadRuntime } from "../src/system-profiles/runtime.mjs";

describe("U7 system choice", () => {
  it("defaults PC/workstation to Windows and NAS to TrueNAS without adding hardware", () => {
    expect(recommendSystemForIntent("pc").selection).toMatchObject({ profileId: "system.windows-11", source: "defaulted", lockedByUser: false });
    expect(recommendSystemForIntent("nas").selection).toMatchObject({ profileId: "system.truenas-scale", source: "defaulted", lockedByUser: false });
    const config = createEmptyBuildConfigV3("p", "NAS", "2026-08-29T00:00:00.000Z");
    config.intent = { state: "answered", value: "nas", source: "user", confirmedByUser: true };
    const result = withRecommendedSystem(config);
    expect(result.config.system?.profileId).toBe("system.truenas-scale");
    expect(result.config.components).toEqual([]);
  });

  it("records a user choice as locked and never overwrites it", () => {
    const config = createEmptyBuildConfigV3("p", "PC", "2026-08-29T00:00:00.000Z");
    config.intent = { state: "answered", value: "pc", source: "user", confirmedByUser: true };
    config.system = userSystemSelection(DEFAULT_SYSTEM_PROFILE_REGISTRY.resolve("system.linux-desktop"));
    const result = withRecommendedSystem(config);
    expect(result.recommendation).toBeNull();
    expect(result.config.system).toMatchObject({ profileId: "system.linux-desktop", source: "user", lockedByUser: true });
  });

  it("rejects unknown or duplicated governed profiles", () => {
    const valid = DEFAULT_SYSTEM_PROFILE_REGISTRY.document;
    expect(validateSystemProfileRegistry(valid)).toEqual([]);
    expect(validateSystemProfileRegistry({ ...valid, profiles: [...valid.profiles, valid.profiles[0]] })).toContain("system profile registry IDs must be unique");
  });

  it("locks the exact system registry bytes into the replay artifact", () => {
    const registry = structuredClone(DEFAULT_SYSTEM_PROFILE_REGISTRY.document);
    const payload = {
      schemaVersion: "workspace-system-profile-v2",
      registry,
      registryHash: DEFAULT_SYSTEM_PROFILE_REGISTRY.contentHash,
      supportedPlanSchemas: ["2.0.0", "3.0.0"],
      sources: [{ moduleId: "data/systems/profiles", bytes: JSON.stringify(registry) }],
    };
    expect(validateWorkspaceSystemProfilePayloadRuntime(payload)).toEqual([]);
    const forged = structuredClone(payload);
    (forged.registry.profiles[0] as unknown as { requiredChecks: string[] }).requiredChecks = ["firmware_path"];
    expect(validateWorkspaceSystemProfilePayloadRuntime(forged)).toContain("workspace system profile registry hash invalid");
  });
});
