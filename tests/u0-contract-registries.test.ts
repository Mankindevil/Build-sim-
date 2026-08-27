import { describe, expect, it } from "vitest";
import {
  COMPARISON_OPERATORS,
  BENCHMARK_REGISTRY,
  CAPABILITY_FACET_REGISTRY,
  COMPONENT_KIND_REGISTRY,
  FACET_REGISTRY,
  FIRMWARE_SETTING_REGISTRY,
  HARDWARE_ADAPTER_REGISTRY,
  METRIC_REGISTRY,
  OBSERVATION_FIELD_REGISTRY,
  PLAN_PATCH_PATHS,
  SIMULATION_JSON_PATCH_PATHS,
  SYSTEM_PROFILE_REGISTRY,
  SYSTEM_RELEASE_REGISTRY,
  TOPOLOGY_V3_PATCH_COLLECTION_REGISTRY,
  UNIT_REGISTRY,
  assertFacetId,
  assertMetricId,
  assertObservationFieldId,
  assertUnitId,
  canCapabilityEvidenceSupportPass,
  isAllowedJsonPatchPath,
  isComparisonOperator,
  validateCapabilityFacet,
  validateFacetPredicate,
  validateFirmwareSettingValue,
  validateGovernedPatchOperation,
  validateHardwareAdapter,
  validateHardwareAdapterManifest,
  validateObservationFieldValue,
  validateRequirementMetric,
  validateSystemReleaseReference,
} from "../src/contracts/registries";
import {
  ARTIFACT_LOCK_ROLES,
  assessArtifactReplay,
  createArtifactLockfile,
  createLockedArtifactRef,
  isDomainHashes,
  isSnapshotHashes,
  validateArtifactLockfile,
  verifyArtifactLockfile,
  type ArtifactLockEntries,
} from "../src/hash";

describe("U0 governed registries", () => {
  it("freezes IDs, comparisons, units and observation fields", () => {
    for (const registry of [METRIC_REGISTRY, FACET_REGISTRY, UNIT_REGISTRY, OBSERVATION_FIELD_REGISTRY]) {
      expect(Object.isFrozen(registry)).toBe(true);
      expect(Object.values(registry).every(Object.isFrozen)).toBe(true);
    }
    expect(COMPARISON_OPERATORS).toEqual(["eq", "gte", "lte", "between", "includes"]);
    expect(isComparisonOperator("gte")).toBe(true);
    expect(isComparisonOperator("matches-free-text")).toBe(false);
    expect(() => assertMetricId("performance.gpu.frame_rate")).not.toThrow();
    expect(() => assertMetricId("agent.invented_metric")).toThrow(/Unknown governed metricId/);
    expect(() => assertFacetId("agent.invented_facet")).toThrow(/Unknown governed facetId/);
    expect(() => assertUnitId("horsepower-ish")).toThrow(/Unknown governed unitId/);
    expect(() => assertObservationFieldId("photo.says_it_fits")).toThrow(/Unknown governed observation fieldId/);
  });

  it("strictly allowlists plan and simulation JSON Patch operations", () => {
    expect(PLAN_PATCH_PATHS).toContain("/selection/gpuId");
    expect(Object.isFrozen(PLAN_PATCH_PATHS)).toBe(true);
    expect(SIMULATION_JSON_PATCH_PATHS).toContain("/ambientC/min");
    expect(Object.isFrozen(TOPOLOGY_V3_PATCH_COLLECTION_REGISTRY)).toBe(true);
    expect(isAllowedJsonPatchPath("plan", "/selection/gpuId")).toBe(true);
    expect(isAllowedJsonPatchPath("plan-v3", "/selection/gpuId")).toBe(false);
    expect(isAllowedJsonPatchPath("plan-v3", "/components/0/state")).toBe(false);
    expect(isAllowedJsonPatchPath("plan", "/components/0/state")).toBe(false);
    expect(isAllowedJsonPatchPath("simulation", "/selection/gpuId")).toBe(false);
    expect(validateGovernedPatchOperation("simulation", { op: "replace", path: "/ambientC/min", value: 28 })).toEqual([]);
    expect(validateGovernedPatchOperation("simulation", { op: "replace", path: "/storageActivity/0/logicalLayoutId", value: "layout-1" })).toEqual([]);
    expect(validateGovernedPatchOperation("simulation", { op: "remove", path: "/ambientC" }))
      .toContain("simulation remove is only allowed for existing array members");
    expect(validateGovernedPatchOperation("simulation", { op: "add", path: "/fanPolicyId", value: "quiet" }))
      .toContain("simulation add is only allowed for array members");
    expect(validateGovernedPatchOperation("simulation", { op: "replace", path: "/storageActivity/0/dutyCycle", value: "busy" }))
      .toContain("simulation dutyCycle invalid");
    expect(validateGovernedPatchOperation("simulation", { op: "replace", path: "/secret", value: 1 })).toContain("simulation patch path is not allowlisted");
    expect(validateGovernedPatchOperation("plan", { op: "replace", path: "/selection/gpuId", value: "gpu", invented: true })).toContain("patch operation contains unknown fields");
  });

  it("uses stable V3 selectors and validates operation values", () => {
    const component = {
      instanceId: "gpu-1", kind: "gpu", role: "discrete_gpu", state: "planned",
      identity: { status: "unresolved", userText: "future GPU" }, source: "user",
    };
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "components", id: "gpu-1" }, value: component,
    })).toEqual([]);
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "replace", selector: { collection: "components", id: "gpu-1", field: "state" }, value: "ordered",
    })).toEqual([]);
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "replace", selector: { collection: "vdevs", parentId: "layout-1", id: "vdev-1", field: "topology" }, value: "raidz2",
    })).toEqual([]);
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "remove", selector: { collection: "connections", id: "power-gpu-1" },
    })).toEqual([]);

    expect(validateGovernedPatchOperation("plan-v3", { op: "replace", path: "/components/0/state", value: "ordered" }))
      .toContain("patch operation contains unknown fields");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "replace", selector: { collection: "components", id: "gpu-1", field: "evaluation" }, value: { verdict: "pass" },
    })).toContain("replace selector field is not allowlisted");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "components", id: "gpu-1" }, value: { ...component, instanceId: "gpu-2" },
    })).toContain("components selector id must equal instanceId");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "components", id: "gpu-1" }, value: { ...component, evaluation: { verdict: "pass" } },
    })).toContain("component contains derived or unknown fields");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "replace", selector: { collection: "components", id: "gpu-1", field: "state" }, value: "present",
    })).toContain("component state invalid");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "replace", selector: { collection: "vdevs", id: "vdev-1", field: "topology" }, value: "raidz2",
    })).toContain("collection selector parentId invalid");
  });

  it("prevents non-user actors from asserting user-only decisions", () => {
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "replace", selector: { collection: "config", field: "system" },
      value: { profileId: "system.windows-11", versionFactId: "fact-release", source: "user", lockedByUser: true },
    }, { actor: "agent" })).toContain("agent patch cannot assert user source, confirmation, confirmedAt or lockedByUser");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "constraints", id: "constraint-1" },
      value: { constraintId: "constraint-1", predicate: { facetId: "cpu.socket", operator: "eq", value: "AM5" }, strength: "hard", source: "agent_proposed", confirmedByUser: true },
    }, { actor: "agent" })).toContain("agent patch cannot assert user source, confirmation, confirmedAt or lockedByUser");
    expect(validateGovernedPatchOperation("plan-v3", {
      op: "add", selector: { collection: "roleDecisions", id: "no-gpu" },
      value: { roleDecisionId: "no-gpu", role: "discrete_gpu", decision: "not_needed", source: "user", confirmedAt: "2026-08-27T00:00:00Z" },
    }, { actor: "agent" })).toContain("agent patch cannot mutate user-only role decisions");
  });

  it("freezes generic hardware, system, firmware and capability contracts", () => {
    for (const registry of [COMPONENT_KIND_REGISTRY, CAPABILITY_FACET_REGISTRY, HARDWARE_ADAPTER_REGISTRY, SYSTEM_PROFILE_REGISTRY, SYSTEM_RELEASE_REGISTRY, FIRMWARE_SETTING_REGISTRY, BENCHMARK_REGISTRY]) {
      expect(Object.isFrozen(registry)).toBe(true);
    }
    expect(COMPONENT_KIND_REGISTRY).toHaveProperty("storage_drive.safetyClass", "destructive_action");
    expect(COMPONENT_KIND_REGISTRY).toHaveProperty("aio.category", "cooling");
    expect(COMPONENT_KIND_REGISTRY).toHaveProperty("raid_controller.category", "storage");
    expect(COMPONENT_KIND_REGISTRY).toHaveProperty("capture_card.category", "expansion");
    expect(COMPONENT_KIND_REGISTRY).not.toHaveProperty("ups");
    expect(COMPONENT_KIND_REGISTRY).not.toHaveProperty("fastener");
    expect(COMPONENT_KIND_REGISTRY).not.toHaveProperty("tool");
    expect(HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"].componentKindIds).toContain("case");
    expect(validateHardwareAdapterManifest(HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"])).toEqual([]);
    expect(validateHardwareAdapterManifest({
      ...HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"],
      componentKindIds: [...HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"].componentKindIds].reverse(),
      emittedFacetIds: [...HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"].emittedFacetIds].reverse(),
    })).toEqual([]);
    expect(validateHardwareAdapterManifest({ ...HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"], componentKindIds: ["magic_part"] }))
      .toContain("hardware adapter manifest component kinds invalid");
    expect(validateHardwareAdapterManifest({ ...HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"], adapterId: "adapter.case.magic" }))
      .toContain("hardware adapter manifest adapterId is not registered");
    const runtimeAdapter = {
      adapterId: "adapter.catalog.generic",
      adapterVersion: "1.0.0",
      subjectSkuId: "sku.example.board",
      capabilities: () => [{
        facetId: "motherboard.cpu_socket", value: "AM5", sourceFactIds: ["fact-board-socket"], safetyClass: "boot",
      }],
      geometry: () => null,
      routing: () => null,
      assembly: () => null,
      thermal: () => null,
      provenance: () => ["fact-board-socket"],
    };
    expect(validateHardwareAdapter(runtimeAdapter)).toEqual([]);
    expect(validateHardwareAdapter({ ...runtimeAdapter, subjectSkuId: "" })).toContain("hardware adapter identity/subject invalid");
    expect(validateHardwareAdapter({ ...runtimeAdapter, thermal: undefined })).toContain("hardware adapter thermal() missing");
    expect(validateHardwareAdapter({ ...runtimeAdapter, capabilities: () => [{ ...runtimeAdapter.capabilities()[0], facetId: "agent.magic" }] }))
      .toContain("hardware adapter capabilities.0: capability facetId is not allowlisted");
    expect(validateCapabilityFacet({ facetId: "psu.connectors", value: ["24pin-atx"], sourceFactIds: ["fact-1"], safetyClass: "electrical_safety" })).toEqual([]);
    expect(validateCapabilityFacet({ facetId: "psu.connectors", value: ["24pin-atx"], sourceFactIds: [], safetyClass: "compatibility" })).toEqual(expect.arrayContaining([
      "capability facet requires unique source fact IDs",
      "capability facet safetyClass must match registry",
    ]));
    expect(validateFirmwareSettingValue("iommu", "enabled")).toEqual([]);
    expect(validateFirmwareSettingValue("iommu", "auto-ish")).toContain("firmware desiredValue is not allowlisted for settingId");
    expect(validateFirmwareSettingValue("above_4g_decoding", "enabled")).toEqual([]);
    expect(validateFirmwareSettingValue("ecc", "auto")).toEqual([]);
    expect(validateFirmwareSettingValue("free_text_setting", "enabled")).toContain("firmware settingId is not allowlisted");
    expect(validateSystemReleaseReference("system.windows-11", "system-release.windows-11.24h2")).toEqual([]);
    expect(validateSystemReleaseReference("system.truenas-scale", "system-release.windows-11.24h2"))
      .toContain("system release does not belong to profile");
  });

  it("covers the complete initial adapter facet families and keeps pass evidence strict", () => {
    const requiredFacetIds = [
      "identity.revision", "physical.width", "mount.point_ids", "motherboard.chipset",
      "motherboard.memory_population_rules", "io.port_types", "io.header_types", "io.endpoint_ids",
      "power.source_type", "power.load", "power.cable_families", "pcie.slot_types", "pcie.lane_sharing",
      "storage.boot_support", "cooling.fan_mounts", "cooling.radiator_support", "cooling.pump_header",
      "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions",
      "thermal.curve_refs", "acoustic.curve_refs",
    ];
    for (const facetId of requiredFacetIds) expect(FACET_REGISTRY, facetId).toHaveProperty(facetId);
    expect(CAPABILITY_FACET_REGISTRY["psu.capacity"].sourcePolicy).toBe("official_required");
    expect(CAPABILITY_FACET_REGISTRY["power.cable_families"]).toMatchObject({ safetyClass: "electrical_safety", sourcePolicy: "official_required" });
    expect(CAPABILITY_FACET_REGISTRY["motherboard.bios_upgrade_methods"]).toMatchObject({ safetyClass: "boot", sourcePolicy: "official_required" });
    expect(HARDWARE_ADAPTER_REGISTRY["adapter.catalog.generic"].sourcePolicy).toBe("official_required");
    expect(canCapabilityEvidenceSupportPass("power.cable_families", "official")).toBe(true);
    expect(canCapabilityEvidenceSupportPass("power.cable_families", "user_observation")).toBe(false);
    expect(canCapabilityEvidenceSupportPass("physical.width", "standard")).toBe(true);
    expect(canCapabilityEvidenceSupportPass("physical.width", "user_observation")).toBe(true);
    expect(canCapabilityEvidenceSupportPass("acoustic.noise_class", "user_observation")).toBe(true);
    expect(canCapabilityEvidenceSupportPass("acoustic.noise_class", "agent_inference")).toBe(false);
    for (const facet of Object.values(CAPABILITY_FACET_REGISTRY)) {
      if (facet.safetyClass === "electrical_safety" || facet.safetyClass === "boot") expect(facet.sourcePolicy).toBe("official_required");
    }
  });

  it("validates typed governed values instead of accepting a free-text DSL", () => {
    expect(validateRequirementMetric({ metricId: "physical.gpu_length", operator: "lte", value: 300, unitId: "mm", priority: "must" })).toEqual([]);
    expect(validateRequirementMetric({ metricId: "performance.cpu.multicore", operator: "gte", value: 1200, unitId: "score", priority: "must" }))
      .toContain("performance metric benchmarkId is required and must be allowlisted");
    expect(validateRequirementMetric({
      metricId: "performance.cpu.multicore", operator: "gte", value: 1200, unitId: "score", priority: "must",
      benchmarkId: "benchmark.cinebench-2024.cpu-multicore",
      benchmarkContext: { softwareVersion: "2024.1", powerProfile: "stock-65w" },
    })).toEqual([]);
    expect(validateRequirementMetric({
      metricId: "performance.gpu.frame_rate", operator: "gte", value: 60, unitId: "fps", priority: "important",
      benchmarkId: "benchmark.game.fps",
      benchmarkContext: { title: "Example Game", titleVersion: "1.2", resolution: "2560x1440", qualityPreset: "high" },
    })).toContain("performance metric benchmarkContext is incomplete or contains unknown keys");
    expect(validateRequirementMetric({ metricId: "physical.gpu_length", operator: "eval", value: "anything", unitId: "mm", priority: "must" }))
      .toContain("operator is not allowlisted");
    expect(validateRequirementMetric({ metricId: "budget.total", operator: "between", value: [10_000, 8_000], unitId: "cny", priority: "important" }))
      .toContain("between lower bound must not exceed upper bound");
    expect(validateFacetPredicate({ facetId: "firmware.version", operator: "gte", value: "1801" }))
      .toContain("operator is not allowed for facetId");
    expect(validateFacetPredicate({ facetId: "case.side_panel", operator: "eq", value: "solid" })).toEqual([]);
    expect(validateFacetPredicate({ facetId: "acoustic.noise_class", operator: "eq", value: "quiet" })).toEqual([]);
    expect(validateFacetPredicate({ facetId: "case.side_panel", operator: "includes", value: "solid" }))
      .toContain("operator is not allowed for facetId");
    expect(validateFacetPredicate({ facetId: "acoustic.noise_class", operator: "eq", value: "quiet", unitId: "dba" }))
      .toContain("unitId is not allowed for this registry entry");
    expect(validateObservationFieldValue("physical.clearance", 4, "mm", "placement", false))
      .toContain("uncertainty is required for observation fieldId");
    expect(validateObservationFieldValue("physical.clearance", 4, "mm", "placement", true)).toEqual([]);
  });
});

describe("U0 snapshot and artifact lock contracts", () => {
  const digest = "a".repeat(64);

  it("requires every exact snapshot/domain hash and rejects extension fields", () => {
    const snapshots = {
      configHash: digest,
      requirementSpecHash: digest,
      factSnapshotHash: digest,
      userObservationSnapshotHash: digest,
      priceSnapshotHash: digest,
      ruleSetHash: digest,
      systemProfileHash: digest,
      adapterSnapshotHash: digest,
      engineHash: digest,
      simulationModelHash: digest,
      simulationInputHash: digest,
    };
    expect(isSnapshotHashes(snapshots)).toBe(true);
    expect(isSnapshotHashes({ ...snapshots, hiddenStateHash: digest })).toBe(false);
    expect(isDomainHashes({ compatibilityHash: digest, spatialHash: digest, simulationHash: digest, procedureSafetyHash: digest, priceHash: digest })).toBe(true);
    expect(isDomainHashes({ compatibilityHash: digest, spatialHash: digest, simulationHash: digest, procedureSafetyHash: digest })).toBe(false);
  });

  it("locks all replay-required artifacts by content address and verifies its self hash", async () => {
    const refs = await Promise.all(ARTIFACT_LOCK_ROLES.map(async (role) => [
      role,
      await createLockedArtifactRef(
        { role, version: 1 },
        role,
        `${role}-v1`,
        "application/json",
        { domain: `artifact.${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, schemaVersion: "1.0.0" },
      ),
    ] as const));
    const artifacts = Object.fromEntries(refs) as unknown as ArtifactLockEntries;
    const lockfile = await createArtifactLockfile(artifacts);
    expect(validateArtifactLockfile(lockfile)).toEqual([]);
    expect(assessArtifactReplay(lockfile)).toMatchObject({ replayable: true, missingRoles: [], invalidRoles: [] });
    expect(Object.isFrozen(lockfile)).toBe(true);
    expect(Object.isFrozen(lockfile.artifacts)).toBe(true);
    await expect(verifyArtifactLockfile(lockfile)).resolves.toBe(true);
    expect(validateArtifactLockfile({ ...lockfile, artifacts: { ...lockfile.artifacts, engine: { contentHash: digest } } }))
      .toContain("artifact lockfile engine ref invalid");
    const { engine: _missingEngine, ...legacyArtifacts } = lockfile.artifacts;
    expect(assessArtifactReplay({ ...lockfile, artifacts: legacyArtifacts })).toMatchObject({ replayable: false, missingRoles: ["engine"] });
    expect(assessArtifactReplay(undefined)).toMatchObject({ replayable: false, missingRoles: ARTIFACT_LOCK_ROLES });
  });
});
