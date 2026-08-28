import { describe, expect, it } from "vitest";
import type { RequirementSpec } from "../src/requirements/contracts";
import {
  createEmptyBuildConfigV3,
  type BuildConfigV3,
  type ComponentInstance,
} from "../src/topology/contracts";
import {
  configV3Hash,
  spatialTopologyHash,
} from "../src/topology/hash";
import {
  createStableComponentInstanceId,
  createStableTopologyEdgeId,
  normalizeBuildConfigV3,
} from "../src/topology/normalize";
import {
  projectGeometrySubjects,
  projectSpatialTopology,
  projectTopologyBom,
} from "../src/topology/projections";
import { validateBuildConfigV3 } from "../src/topology/validation";

const timestamp = "2026-08-27T00:00:00.000Z";

function resolvedComponent(input: Pick<ComponentInstance, "instanceId" | "kind" | "role" | "state"> & { skuId: string; claims?: string[] }): ComponentInstance {
  return {
    instanceId: input.instanceId,
    kind: input.kind,
    role: input.role,
    state: input.state,
    identity: { status: "resolved", skuId: input.skuId, identityClaimIds: input.claims ?? [`claim-${input.instanceId}`] },
    source: "user",
  };
}

describe("U2 BuildConfigV3 topology core", () => {
  it("keeps blank and requirements-only plans at zero physical topology, BOM and geometry", () => {
    const blank = createEmptyBuildConfigV3("plan-blank", "Blank", timestamp);
    expect(validateBuildConfigV3(blank)).toEqual([]);
    expect(projectTopologyBom(blank)).toEqual([]);
    expect(projectGeometrySubjects(blank)).toEqual([]);
    expect(projectSpatialTopology(blank)).toEqual({ components: [], placements: [], connections: [] });

    const requirementSpec: RequirementSpec = {
      requirementSpecId: "requirements-only",
      schemaVersion: "1.0.0",
      budget: { state: "answered", value: { hardCapCny: 10_000 }, source: "user", confirmedByUser: true },
      workloads: [],
      constraints: [],
    };
    const requirementsOnly: BuildConfigV3 = {
      ...blank,
      intent: { state: "answered", value: "workstation", source: "user", confirmedByUser: true },
      requirementSpec,
    };
    expect(validateBuildConfigV3(requirementsOnly)).toEqual([]);
    expect(projectTopologyBom(requirementsOnly)).toEqual([]);
    expect(projectGeometrySubjects(requirementsOnly)).toEqual([]);
    expect(projectSpatialTopology(requirementsOnly)).toEqual({ components: [], placements: [], connections: [] });
  });

  it("keeps repeated identical SKUs as independent instances and BOM rows", () => {
    const config = createEmptyBuildConfigV3("plan-disks", "Two disks", timestamp);
    config.components = [
      resolvedComponent({ instanceId: "board-1", kind: "motherboard", role: "motherboard", state: "planned", skuId: "motherboard.fixture" }),
      resolvedComponent({ instanceId: "disk-b", kind: "storage_drive", role: "cache", state: "ordered", skuId: "storage.same" }),
      resolvedComponent({ instanceId: "disk-a", kind: "storage_drive", role: "boot", state: "planned", skuId: "storage.same" }),
    ];
    config.placements = [
      { placementId: "placement-disk-b", componentInstanceId: "disk-b", mountOwnerInstanceId: "board-1", mountId: "m2-2" },
      { placementId: "placement-disk-a", componentInstanceId: "disk-a", mountOwnerInstanceId: "board-1", mountId: "m2-1" },
    ];
    expect(validateBuildConfigV3(config)).toEqual([]);
    expect(projectTopologyBom(config).filter((line) => line.kind === "storage_drive")).toEqual([
      expect.objectContaining({ instanceId: "disk-a", skuId: "storage.same", role: "boot", state: "planned", quantity: 1 }),
      expect.objectContaining({ instanceId: "disk-b", skuId: "storage.same", role: "cache", state: "ordered", quantity: 1 }),
    ]);
    expect(config.placements.map(({ componentInstanceId, mountId }) => [componentInstanceId, mountId])).toEqual([
      ["disk-b", "m2-2"], ["disk-a", "m2-1"],
    ]);
  });

  it("expresses multiple GPUs, NICs, HBAs, DIMMs and heterogeneous drives at once", () => {
    const config = createEmptyBuildConfigV3("plan-workstation", "Dense workstation", timestamp);
    config.components = [
      resolvedComponent({ instanceId: "gpu-1", kind: "gpu", role: "compute_primary", state: "ordered", skuId: "gpu.fixture-a" }),
      resolvedComponent({ instanceId: "gpu-2", kind: "gpu", role: "compute_secondary", state: "planned", skuId: "gpu.fixture-b" }),
      resolvedComponent({ instanceId: "nic-1", kind: "nic", role: "network_10gbe", state: "planned", skuId: "nic.fixture" }),
      resolvedComponent({ instanceId: "hba-1", kind: "hba", role: "storage_controller", state: "ordered", skuId: "hba.fixture" }),
      ...Array.from({ length: 4 }, (_, index) => resolvedComponent({
        instanceId: `dimm-${index + 1}`, kind: "memory_module", role: `memory_slot_${index + 1}`,
        state: index < 2 ? "ordered" as const : "planned" as const,
        skuId: index % 2 === 0 ? "memory.fixture-a" : "memory.fixture-b",
      })),
      resolvedComponent({ instanceId: "ssd-1", kind: "storage_drive", role: "boot", state: "ordered", skuId: "storage.ssd" }),
      resolvedComponent({ instanceId: "hdd-1", kind: "storage_drive", role: "archive", state: "planned", skuId: "storage.hdd" }),
    ];

    expect(validateBuildConfigV3(config)).toEqual([]);
    expect(config.components.filter((component) => component.kind === "gpu")).toHaveLength(2);
    expect(config.components.filter((component) => component.kind === "memory_module")).toHaveLength(4);
    expect(new Set(projectTopologyBom(config).map((line) => line.instanceId))).toHaveLength(config.components.length);
  });

  it("derives deterministic stable IDs without exposing the source text", async () => {
    const first = await createStableComponentInstanceId({ planId: "plan-1", kind: "storage_drive", sourceKey: "用户的两块同型号 SSD", ordinal: 0 });
    const replay = await createStableComponentInstanceId({ planId: "plan-1", kind: "storage_drive", sourceKey: "用户的两块同型号 SSD", ordinal: 0 });
    const second = await createStableComponentInstanceId({ planId: "plan-1", kind: "storage_drive", sourceKey: "用户的两块同型号 SSD", ordinal: 1 });
    const edge = await createStableTopologyEdgeId("placement", [first, "board-1", "m2-1"]);
    const reversedEdge = await createStableTopologyEdgeId("placement", ["m2-1", "board-1", first]);
    expect(replay).toBe(first);
    expect(second).not.toBe(first);
    expect(first).toMatch(/^storage-drive-[a-f0-9]{24}$/);
    expect(edge).toMatch(/^placement-[a-f0-9]{24}$/);
    expect(reversedEdge).not.toBe(edge);
    expect(first).not.toContain("SSD");
  });

  it("normalizes every governed set and produces stable domain hashes", async () => {
    const left = createEmptyBuildConfigV3("plan-hash", "Hash", timestamp);
    left.components = [
      resolvedComponent({ instanceId: "gpu-2", kind: "gpu", role: "compute-2", state: "planned", skuId: "gpu.same", claims: ["claim-z", "claim-a"] }),
      {
        instanceId: "gpu-1", kind: "gpu", role: "compute-1", state: "planned", source: "user",
        identity: { status: "unresolved", userText: "另一块显卡", candidateIds: ["candidate-z", "candidate-a"] },
      },
    ];
    left.firmwareTargets = [{
      instanceId: "gpu-2", targetReleaseFactId: "firmware-target",
      requestedSettings: [{ settingId: "resizable_bar", desiredValue: "enabled" }, { settingId: "above_4g_decoding", desiredValue: "enabled" }],
      source: "user",
    }];
    left.requirementSpec = {
      requirementSpecId: "requirements", schemaVersion: "1.0.0", constraints: [],
      workloads: [{ workloadId: "workload", name: "Compute", evidenceOrBenchmarkRefs: ["ref-z", "ref-a"], metrics: [
        { metricId: "memory.capacity", operator: "gte", value: 64, unitId: "gib", priority: "important" },
        { metricId: "power.capacity", operator: "gte", value: 750, unitId: "w", priority: "nice_to_have" },
      ] }],
    };
    const right = structuredClone(left);
    right.components.reverse();
    const resolved = right.components.find((component) => component.identity.status === "resolved")!;
    if (resolved.identity.status === "resolved") resolved.identity.identityClaimIds.reverse();
    const unresolved = right.components.find((component) => component.identity.status === "unresolved")!;
    if (unresolved.identity.status === "unresolved") unresolved.identity.candidateIds?.reverse();
    right.firmwareTargets[0]!.requestedSettings.reverse();
    const rightWorkload = right.requirementSpec!.workloads[0]!;
    if ("metrics" in rightWorkload) rightWorkload.metrics.reverse();
    if ("evidenceOrBenchmarkRefs" in rightWorkload) rightWorkload.evidenceOrBenchmarkRefs?.reverse();

    expect(normalizeBuildConfigV3(right)).toEqual(normalizeBuildConfigV3(left));
    await expect(configV3Hash(right)).resolves.toBe(await configV3Hash(left));
    await expect(spatialTopologyHash(right)).resolves.toBe(await spatialTopologyHash(left));
    await expect(spatialTopologyHash(left)).resolves.not.toBe(await configV3Hash(left));
    await expect(configV3Hash({ ...right, name: "Different" })).resolves.not.toBe(await configV3Hash(left));
    await expect(spatialTopologyHash({ ...right, name: "Different" })).resolves.toBe(await spatialTopologyHash(left));
    const purchaseOnly = structuredClone(right);
    purchaseOnly.components[0]!.state = purchaseOnly.components[0]!.state === "planned" ? "ordered" : "planned";
    purchaseOnly.components[0]!.source = "migration";
    await expect(configV3Hash(purchaseOnly)).resolves.not.toBe(await configV3Hash(right));
    await expect(spatialTopologyHash(purchaseOnly)).resolves.toBe(await spatialTopologyHash(right));
  });

  it("is total for malformed nested input and reports errors instead of throwing", () => {
    const malformed = {
      schemaVersion: "3.0.0", id: "bad", name: "Bad", updatedAt: "not-a-date",
      intent: null, requirementSpec: null, system: null,
      components: [null, { instanceId: "x", kind: "unknown", identity: null }],
      roleDecisions: [null], placements: [null], connections: [null],
      logicalLayouts: [{ layoutId: "layout", bootPoolDiskIds: null, vdevs: [null], spareDiskIds: [] }],
      firmwareTargets: [{ instanceId: "x", requestedSettings: [null] }],
    };
    expect(() => validateBuildConfigV3(malformed)).not.toThrow();
    expect(validateBuildConfigV3(malformed)).toEqual(expect.arrayContaining(["updatedAt must be an ISO UTC timestamp"]));
  });

  it("uses NFC identity for graph uniqueness, references and governed identity sets", async () => {
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    const collision = createEmptyBuildConfigV3("plan-unicode", "Unicode", timestamp);
    collision.components = [
      resolvedComponent({ instanceId: composed, kind: "storage_drive", role: "disk-a", state: "planned", skuId: "storage.same" }),
      resolvedComponent({ instanceId: decomposed, kind: "storage_drive", role: "disk-b", state: "planned", skuId: "storage.same" }),
    ];
    expect(validateBuildConfigV3(collision)).toContain("component instanceId must be unique");

    const identityCollision = createEmptyBuildConfigV3("plan-claims", "Claims", timestamp);
    identityCollision.components = [
      resolvedComponent({
        instanceId: "disk-1", kind: "storage_drive", role: "disk", state: "planned", skuId: "storage.same",
        claims: [`claim-${composed}`, `claim-${decomposed}`],
      }),
      {
        instanceId: "gpu-1", kind: "gpu", role: "display", state: "planned", source: "user",
        identity: { status: "unresolved", userText: "GPU", candidateIds: [`candidate-${composed}`, `candidate-${decomposed}`] },
      },
    ];
    expect(validateBuildConfigV3(identityCollision)).toEqual(expect.arrayContaining([
      "components.0 resolved identity requires unique skuId and identity claims",
      "components.1.identity.candidateIds invalid",
    ]));

    const canonicalRefs = createEmptyBuildConfigV3("plan-refs", "Refs", timestamp);
    canonicalRefs.components = [
      resolvedComponent({ instanceId: composed, kind: "storage_drive", role: "disk", state: "planned", skuId: "storage.same" }),
      resolvedComponent({ instanceId: "case-1", kind: "case", role: "chassis", state: "planned", skuId: "case.generic" }),
    ];
    canonicalRefs.placements = [{ placementId: "placement-1", componentInstanceId: decomposed, mountOwnerInstanceId: "case-1", mountId: decomposed }];
    canonicalRefs.logicalLayouts = [{ layoutId: "layout-1", bootPoolDiskIds: [decomposed], vdevs: [], spareDiskIds: [] }];
    expect(validateBuildConfigV3(canonicalRefs)).toEqual([]);
    const normalized = normalizeBuildConfigV3(canonicalRefs);
    expect(normalized.components.map((component) => component.instanceId).sort()).toEqual([composed, "case-1"].sort());
    expect(normalized.placements[0]!.componentInstanceId).toBe(composed);
    expect(normalized.logicalLayouts[0]!.bootPoolDiskIds).toEqual([composed]);
    await expect(configV3Hash(canonicalRefs)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects ill-formed Unicode before canonical hashing", async () => {
    const config = createEmptyBuildConfigV3("plan-unicode-invalid", "Unicode", timestamp);
    config.notes = ["broken-\ud800"];
    const errors = validateBuildConfigV3(config);
    expect(errors).toContain("build config contains ill-formed Unicode text");
    await expect(configV3Hash(config)).rejects.toThrow(/ill-formed Unicode/);
  });
});
