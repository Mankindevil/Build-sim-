import { describe, expect, it } from "vitest";
import {
  createFirmwareCapability,
  findFirmwareUpgradePath,
  type FirmwareCapability,
  type FirmwareTransitionFacet,
} from "../src/capabilities/firmware";
import { evaluateFirmwarePath } from "../src/firmware/evaluate";
import {
  evaluateFirmwareRequirementBatchFixedPoint,
  evaluateFirmwareRequirementFixedPoint,
} from "../src/firmware/fixed-point";
import {
  evaluateFirmwareRequirementBatchFixedPointRuntime,
  validateFirmwareRequirementBatchFixedPointReplayRuntime,
} from "../src/firmware/fixed-point-runtime.mjs";
import { allocateRequirementSupplies, type AllocatableRequirementSupply } from "../src/requirements/allocation";
import {
  firmwareCapabilityContentHashRuntime,
  firmwarePathEvaluationContentHashRuntime,
  firmwarePathReferencesRuntime,
  firmwareRequirementIdRuntime,
  validateFirmwareCapabilityRuntime,
  validateFirmwarePathEvaluationRuntime,
  validateFirmwarePathRequirementClosureRuntime,
  verifyFirmwareCapabilityRuntime,
} from "../src/firmware/runtime.mjs";

const H = "a".repeat(64);
const powerFacts = ["fact-atx-power"];

function transition(overrides: Partial<FirmwareTransitionFacet> & Pick<FirmwareTransitionFacet, "transitionId" | "fromReleaseFactId" | "toReleaseFactId">): FirmwareTransitionFacet {
  return {
    purpose: "upgrade",
    method: "uefi",
    requiresWorkingCpu: true,
    requirementIds: ["req-media"],
    firmwareFileFactId: `fact-file-${overrides.transitionId}`,
    mediaFormat: "fat32",
    requiredFilename: "BOARD.CAP",
    checksumFactId: `fact-checksum-${overrides.transitionId}`,
    powerPrerequisiteFactIds: powerFacts,
    recoveryTransitionIds: [],
    resetsSettings: false,
    releaseFactIds: [overrides.fromReleaseFactId, overrides.toReleaseFactId],
    sourceFactIds: [`fact-procedure-${overrides.transitionId}`],
    ...overrides,
  };
}

async function capability(transitions: FirmwareTransitionFacet[]): Promise<FirmwareCapability> {
  return createFirmwareCapability({
    schemaVersion: "firmware-capability-v1",
    subjectSkuId: "board.alpha",
    subjectRevision: "rev-a",
    region: "CN",
    factSnapshotRef: { snapshotId: `fact-snapshot-sha256-${H}`, contentHash: H },
    versionIdentification: { method: "uefi_screen", sourceFactIds: ["fact-version-method"] },
    releases: [
      { releaseFactId: "release-1", label: "1", sourceFactIds: ["fact-release-1"] },
      { releaseFactId: "release-2", label: "2", sourceFactIds: ["fact-release-2"] },
      { releaseFactId: "release-3", label: "3", sourceFactIds: ["fact-release-3"] },
    ],
    cpuSupport: [{ cpuSkuId: "cpu-new", minimumReleaseFactId: "release-3", sourceFactIds: ["fact-cpu-support"] }],
    transitions,
    settings: [{ settingId: "tpm", supportedValues: ["enabled", "disabled"], sourceFactIds: ["fact-tpm-setting"] }],
    rollbackSupported: transitions.some(({ purpose }) => purpose === "rollback"),
    recoveryMethod: transitions.some(({ purpose, method }) => purpose !== "upgrade" && method === "bmc") ? "bmc" : "none",
    sourceFactIds: ["fact-board-firmware"],
  });
}

function observation(releaseFactId = "release-1") {
  return { observationId: `obs-${releaseFactId}`, releaseFactId, method: "uefi_screen" as const, evidenceRefs: [`evidence-${releaseFactId}`] };
}

function bridgeTransitions(): FirmwareTransitionFacet[] {
  return [
    transition({ transitionId: "direct", fromReleaseFactId: "release-1", toReleaseFactId: "release-3", requirementIds: ["req-direct"] }),
    transition({
      transitionId: "flashback-bridge", fromReleaseFactId: "release-1", toReleaseFactId: "release-2",
      method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-usb"], recoveryTransitionIds: ["recover-2-1"],
    }),
    transition({
      transitionId: "bmc-target", fromReleaseFactId: "release-2", toReleaseFactId: "release-3",
      method: "bmc", requiresWorkingCpu: false, requirementIds: ["req-bmc"], recoveryTransitionIds: ["recover-3-2"], resetsSettings: true,
    }),
    transition({
      transitionId: "recover-2-1", fromReleaseFactId: "release-2", toReleaseFactId: "release-1",
      purpose: "recovery", method: "bmc", requiresWorkingCpu: false, requirementIds: ["req-recovery"],
    }),
    transition({
      transitionId: "recover-3-2", fromReleaseFactId: "release-3", toReleaseFactId: "release-2",
      purpose: "recovery", method: "bmc", requiresWorkingCpu: false, requirementIds: ["req-recovery"],
    }),
  ];
}

function verifiedFirmwareSupply(requirementId: string, sourceRequirementId = requirementId): AllocatableRequirementSupply {
  return {
    source: "user_resource",
    refId: `resource-${requirementId}`,
    ownerInstanceId: "board-instance",
    kind: "firmware_action",
    facets: [{ facetId: "firmware.upgrade_path_refs", value: [sourceRequirementId] }],
    quantity: 1,
    availability: "present_verified",
    verificationStatus: "verified",
    satisfiesBefore: "first_boot",
    evidenceRefs: ["fact-firmware-test"],
    observationRefs: [`observation:obs-${requirementId}`],
  };
}

function verifiedComponentSupply(refId: string, category: string): AllocatableRequirementSupply {
  return {
    source: "user_resource",
    refId,
    ownerInstanceId: "board-instance",
    kind: "component",
    facets: [{ facetId: "identity.category", value: category }],
    quantity: 1,
    availability: "present_verified",
    verificationStatus: "verified",
    satisfiesBefore: "first_boot",
    evidenceRefs: ["fact-working-platform"],
    observationRefs: [`observation:obs-${refId}`],
  };
}

const workingPlatformRequirementIds = [
  "requirement.firmware.board-instance.display-path",
  "requirement.firmware.board-instance.temporary-cpu",
  "requirement.firmware.board-instance.temporary-memory",
];

function scoped(sourceRequirementId: string, instanceId = "board-instance"): string {
  const requirementId = firmwareRequirementIdRuntime(instanceId, sourceRequirementId);
  if (requirementId === null) throw new Error("fixture requirement ID cannot be scoped");
  return requirementId;
}

describe("firmware executable path evaluation", () => {
  it("rejects recovery edges hidden behind a disabled global recovery policy", async () => {
    const firmware = await capability(bridgeTransitions());
    const inconsistent = structuredClone(firmware);
    inconsistent.recoveryMethod = "none";
    inconsistent.contentHash = firmwareCapabilityContentHashRuntime(inconsistent)!;
    expect(validateFirmwareCapabilityRuntime(inconsistent)).toContain(
      "firmware transition recovery references require an enabled recovery policy",
    );
  });

  it("chooses an executable flashback+BMC bridge over a shorter blocked path", async () => {
    const firmware = await capability(bridgeTransitions());
    const result = await evaluateFirmwarePath({
      capability: firmware,
      instanceId: "board-instance",
      currentObservation: observation(),
      cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3",
      availableRequirementIds: ["req-usb", "req-bmc"],
      availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: false, workingMemoryAvailable: false, displayPathAvailable: false },
    });
    expect(result.verdict).toBe("pass");
    expect(result.selectedTransitions.map(({ transitionId }) => transitionId)).toEqual(["flashback-bridge", "bmc-target"]);
    expect(result.selectedTransitions.map(({ method }) => method)).toEqual(["usb_flashback", "bmc"]);
    expect(result.bridgeReleaseFactIds).toEqual(["release-2"]);
    expect(result.selectedTransitions.flatMap(({ temporaryHardwareRequirementIds }) => temporaryHardwareRequirementIds)).toEqual([]);
    expect(result.pathAlternativesExamined).toBe(2);
    expect(validateFirmwarePathEvaluationRuntime(result, firmware)).toEqual([]);
  });

  it("derives temporary CPU/RAM/display requirements for an ordinary UEFI path", async () => {
    const firmware = await capability([transition({ transitionId: "uefi-only", fromReleaseFactId: "release-1", toReleaseFactId: "release-3" })]);
    const result = await evaluateFirmwarePath({
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableRequirementIds: ["req-media"], availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: false, workingMemoryAvailable: null, displayPathAvailable: false },
    });
    expect(result.verdict).toBe("blocked");
    expect(result.missingRequirementIds).toEqual([
      "requirement.firmware.board-instance.display-path",
      "requirement.firmware.board-instance.temporary-cpu",
      "requirement.firmware.board-instance.temporary-memory",
    ]);
    expect(result.derivedRequirements.map(({ requirementId, kind }) => ({ requirementId, kind }))).toEqual([
      { requirementId: "requirement.firmware.board-instance.display-path", kind: "component" },
      { requirementId: "requirement.firmware.board-instance.temporary-cpu", kind: "component" },
      { requirementId: "requirement.firmware.board-instance.temporary-memory", kind: "component" },
      { requirementId: scoped("req-media"), kind: "firmware_action" },
    ]);
  });

  it("does not let naked preflight booleans bypass working-platform requirements", async () => {
    const firmware = await capability([transition({ transitionId: "uefi-only", fromReleaseFactId: "release-1", toReleaseFactId: "release-3" })]);
    const naked = await evaluateFirmwarePath({
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableRequirementIds: ["req-media"], availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
    });
    expect(naked).toMatchObject({ verdict: "blocked", reason: "requirements_missing" });
    expect(naked.missingRequirementIds).toEqual(workingPlatformRequirementIds);

    const backed = await evaluateFirmwarePath({
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableRequirementIds: ["req-media", ...workingPlatformRequirementIds], availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
    });
    expect(backed.verdict).toBe("pass");
    expect(backed.derivedRequirements.map(({ requirementId }) => requirementId)).toEqual([
      ...workingPlatformRequirementIds,
      scoped("req-media"),
    ].sort());
  });

  it("derives, allocates and replays an ordinary UEFI path to a fixed point", async () => {
    const firmware = await capability([transition({
      transitionId: "uefi-only", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
    })]);
    const mediaRequirementId = scoped("req-media");
    const result = await evaluateFirmwareRequirementFixedPoint({
      baseInput: {
        capability: firmware,
        instanceId: "board-instance",
        currentObservation: observation(),
        cpuSkuId: "cpu-new",
        targetReleaseFactId: "release-3",
        availableFactIds: powerFacts,
        preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
      },
      rootRequirements: [],
      supplies: [
        verifiedFirmwareSupply(mediaRequirementId, "req-media"),
        verifiedComponentSupply("working-cpu", "cpu"),
        verifiedComponentSupply("working-memory", "memory_module"),
        verifiedComponentSupply("working-display", "gpu"),
      ],
    });
    expect(result).toMatchObject({ reachedFixedPoint: true, evaluation: { verdict: "pass", reason: "path_available" } });
    expect(result.availableRequirementIds).toEqual([
      ...workingPlatformRequirementIds,
      mediaRequirementId,
    ].sort());
    expect(result.requirementAllocation.satisfactions.every(({ status }) => status === "satisfied")).toBe(true);
    expect(validateFirmwarePathRequirementClosureRuntime(result.evaluation, result.requirementAllocation)).toEqual([]);
  });

  it("allocates a non-shareable medium to an executable alternative instead of requiring every path", async () => {
    const firmware = await capability([
      transition({ transitionId: "flashback-a", fromReleaseFactId: "release-1", toReleaseFactId: "release-3", method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-a"] }),
      transition({ transitionId: "flashback-b", fromReleaseFactId: "release-1", toReleaseFactId: "release-3", method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-b"] }),
    ]);
    const fixedPointInput: Parameters<typeof evaluateFirmwareRequirementFixedPoint>[0] = {
      baseInput: {
        capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
        targetReleaseFactId: "release-3", availableFactIds: powerFacts,
      },
      rootRequirements: [],
      supplies: [{
        source: "user_resource",
        refId: "one-medium",
        ownerInstanceId: "board-instance",
        kind: "firmware_action",
        facets: [{ facetId: "firmware.upgrade_path_refs", value: ["req-a", "req-b"] }],
        quantity: 1,
        availability: "present_verified",
        verificationStatus: "verified",
        satisfiesBefore: "first_boot",
        evidenceRefs: ["fact-one-medium"],
        observationRefs: ["observation:obs-one-medium"],
      }],
    };
    const result = await evaluateFirmwareRequirementFixedPoint(fixedPointInput);
    expect(result.evaluation.verdict).toBe("pass");
    expect(result.availableRequirementIds).toHaveLength(1);
    expect(result.evaluation.selectedTransitions).toHaveLength(1);
    expect(result.evaluation.selectedTransitions[0]!.requirementIds).toEqual(result.availableRequirementIds);
    await expect(evaluateFirmwareRequirementFixedPoint({ ...fixedPointInput, maxIterations: 1 }))
      .rejects.toThrow(/exceeded maxIterations/);
  });

  it("jointly selects a route and allocation instead of stranding a shared medium on a dead end", async () => {
    const sourceIds = ["req-a", "req-b"].sort((left, right) => scoped(left).localeCompare(scoped(right)));
    const [deadEndSource, executableSource] = sourceIds as [string, string];
    const firmware = await capability([
      transition({
        transitionId: "bad-first", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
        method: "usb_flashback", requiresWorkingCpu: false, requirementIds: [deadEndSource, "req-z"],
      }),
      transition({
        transitionId: "good-second", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
        method: "usb_flashback", requiresWorkingCpu: false, requirementIds: [executableSource],
      }),
    ]);
    const result = await evaluateFirmwareRequirementFixedPoint({
      baseInput: {
        capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
        targetReleaseFactId: "release-3", availableFactIds: powerFacts,
      },
      rootRequirements: [],
      supplies: [{
        source: "user_resource", refId: "one-flexible-medium", ownerInstanceId: "board-instance",
        kind: "firmware_action",
        facets: [{ facetId: "firmware.upgrade_path_refs", value: sourceIds }],
        quantity: 1, availability: "present_verified", verificationStatus: "verified", satisfiesBefore: "first_boot",
        evidenceRefs: ["fact-flexible-medium"], observationRefs: ["observation:obs-flexible-medium"],
      }],
    });
    expect(result.evaluation).toMatchObject({ verdict: "pass", reason: "path_available" });
    expect(result.evaluation.selectedTransitions.map(({ transitionId }) => transitionId)).toEqual(["good-second"]);
    expect(result.requirementAllocation.requirements.map(({ requirementId }) => requirementId)).toEqual([scoped(executableSource)]);
  });

  it("uses one JS batch authority and rejects a self-consistent but non-canonical persisted allocation", async () => {
    const firmware = await capability([transition({
      transitionId: "flashback", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
      method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-medium"],
    })]);
    const baseInput = {
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableFactIds: powerFacts,
    };
    const input = {
      baseInputs: [baseInput], rootRequirements: [],
      supplies: [verifiedFirmwareSupply(scoped("req-medium"), "req-medium")],
    };
    const typed = await evaluateFirmwareRequirementBatchFixedPoint(input);
    const runtime = evaluateFirmwareRequirementBatchFixedPointRuntime(input);
    expect(runtime).toEqual(typed);
    expect(validateFirmwareRequirementBatchFixedPointReplayRuntime({
      evaluations: typed.evaluations,
      requirementAllocation: typed.requirementAllocation,
    }, input)).toEqual([]);

    // Both nested artifacts are structurally valid and internally agree that
    // the requirement is open; only global replay proves the verified medium
    // must have been allocated and the executable route selected.
    const blockedEvaluation = await evaluateFirmwarePath({ ...baseInput, availableRequirementIds: [] });
    const blockedAllocation = allocateRequirementSupplies(blockedEvaluation.derivedRequirements, []);
    const nonCanonical = { evaluations: [blockedEvaluation], requirementAllocation: blockedAllocation };
    expect(validateFirmwarePathEvaluationRuntime(blockedEvaluation, firmware)).toEqual([]);
    expect(validateFirmwareRequirementBatchFixedPointReplayRuntime(nonCanonical, input))
      .toContain("firmware batch fixed-point differs from authoritative global replay");
    expect(validateFirmwareRequirementBatchFixedPointReplayRuntime(nonCanonical, {
      ...input,
      unexpected: true,
    } as typeof input)).toContain("firmware batch fixed-point replay validation failed closed");
    expect(validateFirmwareRequirementBatchFixedPointReplayRuntime(nonCanonical, {
      ...input,
      baseInputs: [{ ...baseInput, preflight: { workingCpuAvailable: false, unexpected: true } }],
    } as unknown as typeof input)).toContain("firmware batch fixed-point replay validation failed closed");
    expect(() => evaluateFirmwareRequirementBatchFixedPointRuntime({
      ...input,
      rootRequirements: [blockedEvaluation.derivedRequirements[0]!],
    })).toThrow(/static roots contain a route-derived requirement/);
    const staticRoot: typeof blockedEvaluation.derivedRequirements[number] = {
      requirementId: "requirement.static.audit", kind: "evidence", predicates: [], quantity: 1,
      criticality: "normal", producedBy: {
        ruleId: "fixture.static", ruleVersion: "1.0.0", instanceIds: ["board-instance"],
      }, evidenceRefs: ["fact-static"],
    };
    expect(() => evaluateFirmwareRequirementBatchFixedPointRuntime({
      ...input,
      rootRequirements: [staticRoot, structuredClone(staticRoot)],
    })).toThrow(/roots must be unique and canonically ordered/);
  });

  it("bounds fixed-point exclusion scheduling before a large candidate queue can grow", async () => {
    const requirementIds = Array.from({ length: 4_097 }, (_, index) => `req-${String(index).padStart(4, "0")}`);
    const firmware = await capability([transition({
      transitionId: "many-prerequisites", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
      method: "usb_flashback", requiresWorkingCpu: false, requirementIds,
    })]);
    expect(() => evaluateFirmwareRequirementBatchFixedPointRuntime({
      baseInputs: [{
        capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: null,
        targetReleaseFactId: "release-3", availableFactIds: powerFacts,
      }],
      rootRequirements: [], supplies: [],
    })).toThrow(/route candidate search truncated/);
  });

  it("conserves a shared supply globally across multiple firmware targets", async () => {
    const firmware = await capability([transition({
      transitionId: "flashback", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
      method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-shared"],
    })]);
    const base = (instanceId: string) => ({
      capability: firmware, instanceId, currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableFactIds: powerFacts,
    });
    const result = await evaluateFirmwareRequirementBatchFixedPoint({
      baseInputs: [base("board-a"), base("board-b")],
      rootRequirements: [],
      supplies: [{
        source: "component",
        refId: "shared-programmer",
        kind: "firmware_action",
        facets: [{ facetId: "firmware.upgrade_path_refs", value: ["req-shared"] }],
        quantity: 1,
        availability: "present_verified",
        verificationStatus: "verified",
        satisfiesBefore: "first_boot",
        evidenceRefs: ["fact-shared-programmer"],
        observationRefs: ["observation:obs-shared-programmer"],
      }],
    });
    expect(result.evaluations.filter(({ verdict }) => verdict === "pass")).toHaveLength(1);
    expect(result.evaluations.filter(({ verdict }) => verdict === "blocked")).toHaveLength(1);
    expect(result.availabilityByInstance.flatMap(({ requirementIds }) => requirementIds)).toHaveLength(1);
    expect(result.requirementAllocation.satisfactions.filter(({ status }) => status === "satisfied")).toHaveLength(1);
  });

  it("rejects duplicate transition detail and requested-setting keys independent of order", async () => {
    const firmware = await capability([transition({ transitionId: "uefi-only", fromReleaseFactId: "release-1", toReleaseFactId: "release-3" })]);
    const base = {
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableRequirementIds: ["req-media", "req-temp", ...workingPlatformRequirementIds],
      availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
    };
    const duplicateDetails = [
      { transitionId: "uefi-only", requirementIds: ["req-temp"] },
      { transitionId: "uefi-only", requirementIds: [] },
    ];
    await expect(evaluateFirmwarePath({ ...base, transitionTemporaryHardwareRequirements: duplicateDetails }))
      .rejects.toThrow(/transition IDs must be unique/);
    await expect(evaluateFirmwarePath({ ...base, transitionTemporaryHardwareRequirements: [...duplicateDetails].reverse() }))
      .rejects.toThrow(/transition IDs must be unique/);
    await expect(evaluateFirmwarePath({
      ...base,
      requestedSettings: [
        { settingId: "tpm", desiredValue: "enabled", evidenceRefs: ["fact-tpm-a"] },
        { settingId: "tpm", desiredValue: "disabled", evidenceRefs: ["fact-tpm-b"] },
      ],
    })).rejects.toThrow(/setting IDs must be unique/);
  });

  it("instantiates shared capability prerequisite IDs per firmware target instance", async () => {
    const firmware = await capability([transition({
      transitionId: "flashback", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
      method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-shared-media"],
    })]);
    const evaluate = (instanceId: string) => evaluateFirmwarePath({
      capability: firmware, instanceId, currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableRequirementIds: ["req-shared-media"], availableFactIds: powerFacts,
    });
    const [left, right] = await Promise.all([evaluate("board-a"), evaluate("board-b")]);
    expect(left.verdict).toBe("pass");
    expect(right.verdict).toBe("pass");
    expect(left.derivedRequirements[0]?.requirementId).toBe(scoped("req-shared-media", "board-a"));
    expect(right.derivedRequirements[0]?.requirementId).toBe(scoped("req-shared-media", "board-b"));
    expect(left.derivedRequirements[0]?.requirementId).not.toBe(right.derivedRequirements[0]?.requirementId);
    expect(left.derivedRequirements[0]?.predicates[0]?.value).toBe("req-shared-media");
  });

  it("evaluates recovery and settings reset as executable requirements", async () => {
    const firmware = await capability(bridgeTransitions());
    const base = {
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3", availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: false, workingMemoryAvailable: false, displayPathAvailable: false },
      requestedSettings: [{ settingId: "tpm" as const, desiredValue: "enabled", evidenceRefs: ["fact-desired-tpm"] }],
      requireRecovery: true,
    };
    const blocked = await evaluateFirmwarePath({ ...base, availableRequirementIds: ["req-usb", "req-bmc", "req-recovery"] });
    expect(blocked.settingsReset).toBe(true);
    expect(blocked.recovery).toMatchObject({ status: "available", transitionIds: ["recover-3-2", "recover-2-1"] });
    expect(blocked.missingRequirementIds).toContain("requirement.firmware.board-instance.restore-settings");

    const ready = await evaluateFirmwarePath({
      ...base,
      availableRequirementIds: ["req-usb", "req-bmc", "req-recovery", "requirement.firmware.board-instance.restore-settings"],
    });
    expect(ready.verdict).toBe("pass");
    expect(ready.recovery.status).toBe("available");
  });

  it("requires settings restoration when the recovery procedure resets settings", async () => {
    const firmware = await capability([
      transition({
        transitionId: "up-no-reset", fromReleaseFactId: "release-1", toReleaseFactId: "release-2",
        method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-up"],
        recoveryTransitionIds: ["recover-with-reset"], resetsSettings: false,
      }),
      transition({
        transitionId: "recover-with-reset", fromReleaseFactId: "release-2", toReleaseFactId: "release-1",
        purpose: "recovery", method: "bmc", requiresWorkingCpu: false, requirementIds: ["req-recovery"],
        resetsSettings: true,
      }),
    ]);
    const base = {
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: null,
      targetReleaseFactId: "release-2", availableRequirementIds: ["req-up", "req-recovery"], availableFactIds: powerFacts,
      requestedSettings: [{ settingId: "tpm" as const, desiredValue: "enabled", evidenceRefs: ["fact-desired-tpm"] }],
      requireRecovery: true,
    };
    const blocked = await evaluateFirmwarePath(base);
    expect(blocked).toMatchObject({ verdict: "blocked", settingsReset: true });
    expect(blocked.missingRequirementIds).toContain("requirement.firmware.board-instance.restore-settings");
    await expect(evaluateFirmwarePath({
      ...base,
      availableRequirementIds: [...base.availableRequirementIds, "requirement.firmware.board-instance.restore-settings"],
    })).resolves.toMatchObject({ verdict: "pass", settingsReset: true, recovery: { status: "available" } });
  });

  it("ranks recovery while choosing the path and requires a governed settings action", async () => {
    const recoveryFirmware = await capability(bridgeTransitions());
    const recoverable = await evaluateFirmwarePath({
      capability: recoveryFirmware,
      instanceId: "board-instance",
      currentObservation: observation(),
      cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3",
      availableRequirementIds: ["req-direct", "req-usb", "req-bmc", "req-recovery"],
      availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: false, workingMemoryAvailable: false, displayPathAvailable: false },
      requireRecovery: true,
    });
    expect(recoverable.verdict).toBe("pass");
    expect(recoverable.selectedTransitions.map(({ transitionId }) => transitionId))
      .toEqual(["flashback-bridge", "bmc-target"]);
    expect(recoverable.recovery.status).toBe("available");

    const settingsFirmware = await capability([
      transition({ transitionId: "direct-reset", fromReleaseFactId: "release-1", toReleaseFactId: "release-3", requirementIds: ["req-direct"], resetsSettings: true }),
      transition({ transitionId: "bridge-no-reset", fromReleaseFactId: "release-1", toReleaseFactId: "release-2", method: "usb_flashback", requiresWorkingCpu: false, requirementIds: ["req-usb"] }),
      transition({ transitionId: "target-no-reset", fromReleaseFactId: "release-2", toReleaseFactId: "release-3", method: "bmc", requiresWorkingCpu: false, requirementIds: ["req-bmc"] }),
    ]);
    const settingsSafe = await evaluateFirmwarePath({
      capability: settingsFirmware,
      instanceId: "board-instance",
      currentObservation: observation(),
      cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3",
      availableRequirementIds: ["req-direct", "req-usb", "req-bmc", "requirement.firmware.board-instance.restore-settings"],
      availableFactIds: powerFacts,
      requestedSettings: [{ settingId: "tpm", desiredValue: "enabled", evidenceRefs: ["fact-desired-tpm"] }],
    });
    expect(settingsSafe.verdict).toBe("pass");
    expect(settingsSafe.settingsReset).toBe(false);
    expect(settingsSafe.selectedTransitions.map(({ transitionId }) => transitionId))
      .toEqual(["bridge-no-reset", "target-no-reset"]);

    const noRecovery = await capability([
      transition({ transitionId: "direct-only", fromReleaseFactId: "release-1", toReleaseFactId: "release-3", requirementIds: ["req-direct"] }),
    ]);
    await expect(evaluateFirmwarePath({
      capability: noRecovery,
      instanceId: "board-instance",
      currentObservation: observation(),
      cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3",
      availableRequirementIds: ["req-direct", "requirement.firmware.board-instance.recovery-plan"],
      availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
      requireRecovery: true,
    })).resolves.toMatchObject({ verdict: "blocked", reason: "recovery_unavailable", recovery: { status: "unavailable" } });
  });

  it("does not treat already-at-target as proof that requested settings were applied", async () => {
    const firmware = await capability([transition({
      transitionId: "unused", fromReleaseFactId: "release-1", toReleaseFactId: "release-3",
    })]);
    const base = {
      capability: firmware, instanceId: "board-instance", currentObservation: observation("release-3"), cpuSkuId: null,
      targetReleaseFactId: "release-3", requestedSettings: [{
        settingId: "tpm" as const, desiredValue: "enabled", evidenceRefs: ["fact-desired-tpm"],
      }],
    };
    const blocked = await evaluateFirmwarePath(base);
    expect(blocked).toMatchObject({ verdict: "blocked", reason: "requirements_missing", settingsReset: false });
    expect(blocked.derivedRequirements[0]?.predicates).toEqual([{
      facetId: "firmware.upgrade_path_refs", operator: "includes", value: "setting:tpm=enabled",
    }]);
    await expect(evaluateFirmwarePath({
      ...base,
      availableRequirementIds: ["requirement.firmware.board-instance.restore-settings"],
    })).resolves.toMatchObject({ verdict: "pass", reason: "already_at_target" });
  });

  it("blocks missing observations, absent directed paths and prerequisite-only paths", async () => {
    const firmware = await capability([transition({ transitionId: "uefi-only", fromReleaseFactId: "release-1", toReleaseFactId: "release-3" })]);
    await expect(evaluateFirmwarePath({ capability: firmware, instanceId: "board-instance", cpuSkuId: "cpu-new", targetReleaseFactId: "release-3" }))
      .resolves.toMatchObject({ verdict: "blocked", reason: "current_release_observation_missing" });
    await expect(evaluateFirmwarePath({
      capability: firmware, instanceId: "board-instance", currentObservation: observation("release-3"),
      cpuSkuId: null, targetReleaseFactId: "release-1",
    })).resolves.toMatchObject({ verdict: "blocked", reason: "no_directed_path" });
    await expect(evaluateFirmwarePath({
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new", targetReleaseFactId: "release-3",
      preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
      availableRequirementIds: workingPlatformRequirementIds,
      availableFactIds: powerFacts,
    })).resolves.toMatchObject({ verdict: "blocked", reason: "requirements_missing", missingRequirementIds: [scoped("req-media")] });
  });

  it("fails closed when the directed path universe exceeds the complete-search bound", async () => {
    const releaseIds = ["release-00", "release-01"];
    const transitions: FirmwareTransitionFacet[] = Array.from({ length: 4_097 }, (_, index) => transition({
      transitionId: `parallel-${String(index).padStart(4, "0")}`,
      fromReleaseFactId: releaseIds[0]!, toReleaseFactId: releaseIds[1]!,
      method: "usb_flashback", requiresWorkingCpu: false, requirementIds: [],
      powerPrerequisiteFactIds: powerFacts, releaseFactIds: releaseIds,
    }));
    const branching = await createFirmwareCapability({
      schemaVersion: "firmware-capability-v1",
      subjectSkuId: "board.branching", subjectRevision: "rev-a", region: "CN",
      factSnapshotRef: { snapshotId: `fact-snapshot-sha256-${H}`, contentHash: H },
      versionIdentification: { method: "uefi_screen", sourceFactIds: ["fact-version-method"] },
      releases: releaseIds.map((releaseFactId) => ({ releaseFactId, label: releaseFactId, sourceFactIds: [`fact-${releaseFactId}`] })),
      cpuSupport: [{ cpuSkuId: "cpu-many", minimumReleaseFactId: releaseIds.at(-1)!, sourceFactIds: ["fact-cpu-many"] }],
      transitions,
      settings: [], rollbackSupported: false, recoveryMethod: "none", sourceFactIds: ["fact-branching-firmware"],
    });
    await expect(evaluateFirmwarePath({
      capability: branching, instanceId: "branching-board", currentObservation: {
        observationId: "obs-branching", releaseFactId: releaseIds[0]!, method: "uefi_screen", evidenceRefs: ["evidence-branching"],
      }, cpuSkuId: "cpu-many", targetReleaseFactId: releaseIds.at(-1)!,
    })).rejects.toThrow(/complete-search limit/);
    await expect(findFirmwareUpgradePath(
      branching, releaseIds[0]!, releaseIds.at(-1)!, new Set(),
    )).rejects.toThrow(/complete-search limit/);

    const layerIds = Array.from({ length: 18 }, (_, index) => [
      `release-layer-${String(index).padStart(2, "0")}-a`,
      `release-layer-${String(index).padStart(2, "0")}-b`,
    ]);
    const deadEndReleases = ["release-dead-start", ...layerIds.flat(), "release-dead-target"];
    const deadEndTransitions: FirmwareTransitionFacet[] = [];
    for (const target of layerIds[0]!) deadEndTransitions.push(transition({
      transitionId: `dead-start-${target.at(-1)}`, fromReleaseFactId: "release-dead-start", toReleaseFactId: target,
      method: "usb_flashback", requiresWorkingCpu: false, requirementIds: [], powerPrerequisiteFactIds: powerFacts,
      releaseFactIds: ["release-dead-start", target].sort(),
    }));
    for (let index = 0; index < layerIds.length - 1; index += 1) {
      for (const from of layerIds[index]!) for (const target of layerIds[index + 1]!) {
        deadEndTransitions.push(transition({
          transitionId: `dead-${String(index).padStart(2, "0")}-${from.at(-1)}-${target.at(-1)}`,
          fromReleaseFactId: from, toReleaseFactId: target,
          method: "usb_flashback", requiresWorkingCpu: false, requirementIds: [], powerPrerequisiteFactIds: powerFacts,
          releaseFactIds: [from, target].sort(),
        }));
      }
    }
    const deadEnds = await createFirmwareCapability({
      schemaVersion: "firmware-capability-v1",
      subjectSkuId: "board.dead-ends", subjectRevision: "rev-a", region: "CN",
      factSnapshotRef: { snapshotId: `fact-snapshot-sha256-${H}`, contentHash: H },
      versionIdentification: { method: "uefi_screen", sourceFactIds: ["fact-version-method"] },
      releases: deadEndReleases.map((releaseFactId) => ({ releaseFactId, label: releaseFactId, sourceFactIds: [`fact-${releaseFactId}`] })),
      cpuSupport: [{ cpuSkuId: "cpu-dead", minimumReleaseFactId: "release-dead-target", sourceFactIds: ["fact-cpu-dead"] }],
      transitions: deadEndTransitions,
      settings: [], rollbackSupported: false, recoveryMethod: "none", sourceFactIds: ["fact-dead-firmware"],
    });
    await expect(evaluateFirmwarePath({
      capability: deadEnds, instanceId: "dead-board", currentObservation: {
        observationId: "obs-dead", releaseFactId: "release-dead-start", method: "uefi_screen", evidenceRefs: ["evidence-dead"],
      }, cpuSkuId: null, targetReleaseFactId: "release-dead-target",
    })).rejects.toThrow(/complete-search limit/);
  });

  it("executes an explicit supported rollback and orders multi-step recovery from target to start", async () => {
    const firmware = await capability([
      transition({ transitionId: "up-1-2", fromReleaseFactId: "release-1", toReleaseFactId: "release-2", requirementIds: ["req-up"] }),
      transition({
        transitionId: "rollback-2-1", fromReleaseFactId: "release-2", toReleaseFactId: "release-1",
        purpose: "rollback", method: "bmc", requiresWorkingCpu: false, requirementIds: ["req-rollback"],
      }),
    ]);
    const result = await evaluateFirmwarePath({
      capability: firmware, instanceId: "board-instance", currentObservation: observation("release-2"),
      cpuSkuId: null, targetReleaseFactId: "release-1", availableRequirementIds: ["req-rollback"], availableFactIds: powerFacts,
    });
    expect(result).toMatchObject({ verdict: "pass", reason: "path_available" });
    expect(result.selectedTransitions.map(({ transitionId }) => transitionId)).toEqual(["rollback-2-1"]);
  });

  it("strictly validates capability authority and checksum-correct path mutations", async () => {
    const firmware = await capability(bridgeTransitions());
    expect(validateFirmwareCapabilityRuntime(firmware)).toEqual([]);
    expect(verifyFirmwareCapabilityRuntime(firmware)).toBe(true);
    expect(firmwareCapabilityContentHashRuntime(firmware)).toBe(firmware.contentHash);

    const fakeCapability = structuredClone(firmware);
    fakeCapability.transitions[0]!.method = "usb_flashback";
    fakeCapability.transitions[0]!.requiresWorkingCpu = true;
    fakeCapability.contentHash = firmwareCapabilityContentHashRuntime(fakeCapability)!;
    expect(validateFirmwareCapabilityRuntime(fakeCapability)).toContain("firmware transitions invalid");

    const result = await evaluateFirmwarePath({
      capability: firmware, instanceId: "board-instance", currentObservation: observation(), cpuSkuId: "cpu-new", targetReleaseFactId: "release-3",
      availableRequirementIds: ["req-usb", "req-bmc"], availableFactIds: powerFacts,
    });
    const forged = structuredClone(result);
    forged.selectedTransitions[0]!.transitionId = "forged-transition";
    forged.contentHash = firmwarePathEvaluationContentHashRuntime(forged)!;
    expect(validateFirmwarePathEvaluationRuntime(forged, firmware)).toContain("firmware path evaluation differs from authoritative graph replay");
    expect(validateFirmwarePathEvaluationRuntime(result, undefined)).toContain("firmware path locked capability authority is required for replay");

    const refs = firmwarePathReferencesRuntime(result, firmware)!;
    expect(refs.factSnapshotRef).toEqual(firmware.factSnapshotRef);
    expect(refs.observationIds).toEqual(["observation:obs-release-1"]);
    expect(refs.factIds).toEqual(expect.arrayContaining(["fact-board-firmware", "fact-version-method", "fact-cpu-support", "fact-procedure-flashback-bridge"]));
  });

  it("binds claimed available prerequisites to canonical RequirementSatisfaction authority", async () => {
    const firmware = await capability(bridgeTransitions());
    const result = await evaluateFirmwarePath({
      capability: firmware,
      instanceId: "board-instance",
      currentObservation: observation(),
      cpuSkuId: "cpu-new",
      targetReleaseFactId: "release-3",
      availableRequirementIds: ["req-usb", "req-bmc"],
      availableFactIds: powerFacts,
      preflight: { workingCpuAvailable: false, workingMemoryAvailable: false, displayPathAvailable: false },
    });
    const requirements = result.derivedRequirements;
    const reqUsb = scoped("req-usb");
    const reqBmc = scoped("req-bmc");
    const closed = allocateRequirementSupplies(requirements, [
      verifiedFirmwareSupply(reqUsb, "req-usb"),
      verifiedFirmwareSupply(reqBmc, "req-bmc"),
    ]);
    expect(validateFirmwarePathRequirementClosureRuntime(result, closed)).toEqual([]);

    // This allocation is internally valid and checksum-correct, but req-bmc is
    // open. A path cannot turn it into authority merely by persisting its ID.
    const missingBmc = allocateRequirementSupplies(requirements, [verifiedFirmwareSupply(reqUsb, "req-usb")]);
    expect(validateFirmwarePathRequirementClosureRuntime(result, missingBmc)).toContain(
      `firmware available requirement lacks satisfied allocation authority: ${reqBmc}`,
    );

    const withoutCanonicalNode = allocateRequirementSupplies(
      requirements.filter(({ requirementId }) => requirementId === reqUsb),
      [verifiedFirmwareSupply(reqUsb, "req-usb")],
    );
    expect(validateFirmwarePathRequirementClosureRuntime(result, withoutCanonicalNode)).toContain(
      `firmware available requirement lacks satisfied allocation authority: ${reqBmc}`,
    );
  });
});
