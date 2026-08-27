import { describe, expect, it } from "vitest";
import {
  deriveBuildReadiness,
  deriveBuildReadinessAuthoritatively,
  staleExecutionStepIds,
  validateBundleItem,
  validateBuildProcedure,
  validateBuildProcedureAuthoritatively,
  validateExecutionSession,
  validateExecutionSessionAuthoritatively,
  validateFirmwarePlan,
  type BuildProcedure,
  type ExecutionSession,
  type FirmwarePlan,
  type ProcedureDependencyContext,
} from "../src/build-execution/contracts";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";

const digest = (letter: string) => letter.repeat(64);
const procedure = (): BuildProcedure => ({
  procedureId: "procedure", inputEvaluationHash: digest("a"), procedureSafetyHash: digest("b"), phases: ["mechanical", "first_power"],
  steps: [
    { stepId: "mount", phase: "mechanical", action: "Mount board", dependsOn: [], instanceIds: ["board"], requirementIds: ["standoffs"], expectedResult: "Board is secure", failureAction: "Stop and inspect standoffs", riskLevel: "normal", stopConditions: ["wrong standoff"], failureBranchStepIds: [], confirmationPolicy: "user_confirm", safetyCritical: false, dependencyHashes: { spatialHash: digest("c") }, dependencyHash: digest("d"), evidenceRefs: ["manual"] },
    { stepId: "power", phase: "first_power", action: "Apply power", dependsOn: ["mount"], instanceIds: ["board", "psu"], requirementIds: ["eps"], expectedResult: "POST", failureAction: "Disconnect power", riskLevel: "safety_critical", stopConditions: ["smoke"], failureBranchStepIds: [], confirmationPolicy: "observation_required", safetyCritical: true, dependencyHashes: { procedureSafetyHash: digest("b") }, dependencyHash: digest("e"), evidenceRefs: ["manual"] },
  ],
});
const procedureContext = (value: BuildProcedure): ProcedureDependencyContext => ({
  evaluatorArtifactRef: "artifacts/evaluator", evaluatorArtifactHash: digest("f"), evaluatorVersion: "1",
  expectedInputEvaluationHash: value.inputEvaluationHash,
  expectedProcedureSafetyHash: value.procedureSafetyHash,
  expectedStepDependencyHashes: Object.fromEntries(value.steps.map((step) => [step.stepId, step.dependencyHash])),
});

describe("U0 build execution contracts", () => {
  it("requires executable safety steps and forbids skipping them", () => {
    const value = procedure();
    const context = procedureContext(value);
    expect(validateBuildProcedure(value, context)).toEqual([]);
    const session: ExecutionSession = { executionSessionId: "session", planVersionId: "v1", procedureId: "procedure", evaluationHash: digest("a"), procedureSafetyHash: digest("b"), status: "active", results: [{ stepId: "power", result: "skipped_non_safety", at: "2026-08-27T00:00:00.000Z", actor: "user", confirmedAgainstDependencyHash: digest("e") }] };
    expect(validateExecutionSession(session, value, context)).toContain("power: safety step cannot be skipped");
  });

  it("resolves procedure and execution dependencies outside request JSON", async () => {
    const value = procedure();
    const context = procedureContext(value);
    const procedureResolver = createAuthoritativeResolver("procedure-dependency-context", (ref) => ref === "procedure/context" ? context : undefined);
    await expect(validateBuildProcedureAuthoritatively(value, "procedure/context", procedureResolver)).resolves.toEqual([]);
    await expect(validateBuildProcedureAuthoritatively(value, "procedure/context", JSON.parse(JSON.stringify(context)) as never)).resolves.toEqual([
      expect.stringContaining("resolver was not issued by the server composition root"),
    ]);
    const staleProcedureResolver = createAuthoritativeResolver("procedure-dependency-context", () => ({ ...context, expectedProcedureSafetyHash: digest("9") }));
    await expect(validateBuildProcedureAuthoritatively(value, "procedure/context", staleProcedureResolver))
      .resolves.toContain("procedureSafetyHash differs from authoritative safety artifact");

    const session: ExecutionSession = {
      executionSessionId: "session", planVersionId: "v1", procedureId: value.procedureId,
      evaluationHash: value.inputEvaluationHash, procedureSafetyHash: value.procedureSafetyHash,
      status: "active", results: [],
    };
    const executionResolver = createAuthoritativeResolver("execution-validation-context", (ref) => ref === "execution/context" ? { procedure: value, dependencyContext: context } : undefined);
    await expect(validateExecutionSessionAuthoritatively(session, "execution/context", executionResolver)).resolves.toEqual([]);
    await expect(validateExecutionSessionAuthoritatively(session, "missing", executionResolver)).resolves.toEqual([
      expect.stringContaining("execution authoritative context resolution failed"),
    ]);
  });

  it("requires governed, evidenced package contents", () => {
    const item = { bundleItemId: "eps-cable", ownerSkuId: "psu", kind: "cable" as const, specification: [{ facetId: "package.contents" as const, operator: "includes" as const, value: "eps-8pin" }], quantity: 1, variantScopeFactIds: ["variant"], evidenceFactIds: ["manual-fact"] };
    expect(validateBundleItem(item)).toEqual([]);
    expect(validateBundleItem({ ...item, quantity: 0, evidenceFactIds: [] })).toEqual(expect.arrayContaining(["bundle item quantity must be a positive integer", "bundle item requires unique evidence facts"]));
    expect(validateBundleItem({ ...item, kind: "component", region: 7, revision: "" })).toEqual(expect.arrayContaining([
      "bundle item kind invalid",
      "bundle item region invalid",
      "bundle item revision invalid",
    ]));
  });

  it("invalidates only results whose selective dependency hash changed", () => {
    const oldProcedure = procedure();
    const session: ExecutionSession = {
      executionSessionId: "session", planVersionId: "v1", procedureId: "procedure", evaluationHash: digest("a"), procedureSafetyHash: digest("b"), status: "active",
      results: [
        { stepId: "mount", result: "confirmed", at: "2026-08-27T00:00:00.000Z", actor: "user", confirmedAgainstDependencyHash: digest("d") },
        { stepId: "power", result: "confirmed", at: "2026-08-27T00:01:00.000Z", actor: "user", confirmedAgainstDependencyHash: digest("e") },
      ],
    };
    const priceOnlyRefresh = { ...oldProcedure, inputEvaluationHash: digest("f") };
    expect(staleExecutionStepIds(session, priceOnlyRefresh)).toEqual([]);
    const changedMount = procedure();
    changedMount.steps[0]!.dependencyHash = digest("0");
    expect(staleExecutionStepIds(session, changedMount)).toEqual(["mount"]);
  });

  it("derives readiness from requirements/checkpoints instead of accepting booleans", () => {
    const readiness = deriveBuildReadiness({
      requirementNodes: [{ requirementId: "eps", kind: "cable", predicates: [], quantity: 1, criticality: "safety", requiredBefore: "pre_power", producedBy: { ruleId: "eps", ruleVersion: "1", instanceIds: [] }, evidenceRefs: [] }],
      satisfactions: [{ requirementId: "eps", status: "open", allocations: [], residualQuantity: 1 }],
      checkpointRecords: [{ checkpointId: "mounted", requirementId: "mounted", planVersionId: "v1", procedureId: "procedure", dependencyHash: digest("7"), procedureSafetyHash: digest("b"), confirmedAt: "2026-08-27T00:00:00.000Z", actor: "user" }],
      checkpointContext: { planVersionId: "v1", procedureId: "procedure", procedureSafetyHash: digest("b"), expectedDependencyHashes: { mounted: digest("7") } },
      requiredCheckpointIds: { assembly: ["mounted"], power: [], post: [], systemInstall: [], workload: [], destructive: ["disk-locators"] },
    });
    expect(readiness).toMatchObject({ assemblyReady: true, powerReady: false, postReady: false, destructiveActionReady: false });
    const unscopedSafety = deriveBuildReadiness({
      requirementNodes: [{ requirementId: "unknown-eps", kind: "cable", predicates: [], quantity: 1, criticality: "safety", producedBy: { ruleId: "eps", ruleVersion: "1", instanceIds: [] }, evidenceRefs: [] }],
      satisfactions: [{ requirementId: "unknown-eps", status: "open", allocations: [], residualQuantity: 1 }],
      checkpointRecords: [], checkpointContext: { planVersionId: "v1", procedureId: "procedure", procedureSafetyHash: digest("b"), expectedDependencyHashes: {} },
      requiredCheckpointIds: { assembly: [], power: [], post: [], systemInstall: [], workload: [], destructive: [] },
    });
    expect(unscopedSafety.powerReady).toBe(false);
  });

  it("derives readiness only from a resolver-issued evaluator snapshot", async () => {
    const inputs = {
      requirementNodes: [], satisfactions: [], checkpointRecords: [],
      checkpointContext: { planVersionId: "v1", procedureId: "procedure", procedureSafetyHash: digest("b"), expectedDependencyHashes: {} },
      requiredCheckpointIds: { assembly: [], power: [], post: [], systemInstall: [], workload: [], destructive: [] },
    };
    const resolver = createAuthoritativeResolver("readiness-inputs", (ref) => ref === "readiness/current" ? inputs : undefined);
    await expect(deriveBuildReadinessAuthoritatively("readiness/current", resolver)).resolves.toEqual({
      readiness: { assemblyReady: true, powerReady: true, postReady: true, systemInstallReady: true, workloadReady: true, destructiveActionReady: true },
      errors: [],
    });
    await expect(deriveBuildReadinessAuthoritatively("readiness/current", inputs as never)).resolves.toEqual({
      errors: [expect.stringContaining("resolver was not issued by the server composition root")],
    });
  });

  it("blocks theoretical firmware support without an executable transition", () => {
    const plan: FirmwarePlan = {
      firmwarePlanId: "bios", instanceId: "board", status: "pass", inputHash: digest("1"), versionIdentification: { method: "bios_screen", observationFieldId: "firmware.bios_version", evidenceRefs: ["manual"] }, minimumVersionFactIds: ["min"], targetVersionFactIds: ["target"], transitions: [], derivedRequirementIds: [], requiredSettings: [],
    };
    expect(validateFirmwarePlan(plan)).toContain("passing firmware plan requires a currently observed release");
    expect(validateFirmwarePlan({ ...plan, status: "blocked", requiredSettings: [{ key: "agent_free_text", value: "enabled", reason: "invented", evidenceRefs: ["claim"] }] }))
      .toContain("firmware requiredSettings.0 invalid");
    expect(validateFirmwarePlan({ ...plan, status: "blocked", requiredSettings: [{ key: "above_4g_decoding", value: "enabled", reason: "PCIe address space", evidenceRefs: ["manual"] }] }))
      .not.toContain("firmware requiredSettings.0 invalid");
  });

  it("returns contract errors instead of throwing on malformed nested input", () => {
    expect(validateFirmwarePlan({})).toEqual(expect.arrayContaining([
      "firmware plan identity/inputHash invalid",
      "firmware version identification requires observation field and evidence",
      "firmware transitions must be an array",
    ]));
    expect(validateFirmwarePlan({ firmwarePlanId: "bios", instanceId: "board", inputHash: digest("1"), versionIdentification: null, transitions: [null] })).toEqual(expect.arrayContaining([
      "firmware version identification requires observation field and evidence",
      "firmware transitions must contain objects",
    ]));
    expect(validateBuildProcedure({ phases: ["mechanical"], steps: [{}] })).toContain("procedure step collections/dependencyHashes invalid");
    expect(validateExecutionSession({}, {})).toContain("execution session procedure is invalid");
    expect(validateBundleItem({})).toEqual(expect.arrayContaining(["bundle item specification must be an array", "bundle item variant scope IDs invalid"]));
  });

  it("cannot complete around failed, unresolved, or stale step confirmations", () => {
    const value = procedure();
    const context = procedureContext(value);
    const base: ExecutionSession = { executionSessionId: "session", planVersionId: "v1", procedureId: "procedure", evaluationHash: digest("a"), procedureSafetyHash: digest("b"), status: "completed", results: [
      { stepId: "mount", result: "confirmed", at: "2026-08-27T00:00:00.000Z", actor: "user", confirmedAgainstDependencyHash: digest("d") },
      { stepId: "power", result: "confirmed", at: "2026-08-27T00:01:00.000Z", actor: "user", confirmedAgainstDependencyHash: digest("e") },
    ] };
    expect(validateExecutionSession(base, value, context)).toEqual([]);
    expect(validateExecutionSession({ ...base, results: base.results.slice(0, 1) }, value, context)).toContain("completed session has an unresolved procedure step");
    expect(validateExecutionSession({ ...base, results: [{ ...base.results[0]!, confirmedAgainstDependencyHash: digest("9") }, base.results[1]!] }, value, context)).toContain("mount: current session result has a stale dependency hash");
    expect(validateExecutionSession({ ...base, results: [{ ...base.results[0]!, result: "failed" }, base.results[1]!] }, value, context)).toContain("completed session cannot contain failed results");
    expect(validateExecutionSession({ ...base, results: [{ ...base.results[0]!, at: "2026-08-27T00:02:00.000Z" }, base.results[1]!] }, value, context)).toContain("power: dependency mount was confirmed later");
  });

  it("rejects caller-authored procedure hashes and requires directed firmware reachability", () => {
    const value = procedure();
    const context = procedureContext(value);
    value.steps[0]!.dependencyHash = digest("9");
    expect(validateBuildProcedure(value, context)).toContain("mount: dependencyHash differs from authoritative recomputation");
    const firmware: FirmwarePlan = {
      firmwarePlanId: "bios", instanceId: "board", status: "pass", inputHash: digest("1"),
      currentVersionObservationId: "obs-current", currentReleaseFactId: "release-current",
      versionIdentification: { method: "bios_screen", observationFieldId: "firmware.bios_version", evidenceRefs: ["manual"] },
      minimumVersionFactIds: ["release-min"], targetVersionFactIds: ["release-target"],
      transitions: [{
        transitionId: "unrelated", fromReleaseFactId: "release-other", toReleaseFactId: "release-target", method: "uefi", requiresWorkingCpu: true,
        requirementIds: [], temporaryHardwareRequirementIds: [], firmwareFileFactId: "file", media: { format: "FAT32", fileName: "BIOS.CAP", checksumFactId: "checksum", mediaRequirementIds: [] },
        powerPrerequisiteRequirementIds: [], recoveryTransitionIds: [], resetsSettings: true, releaseFactIds: ["release-target"], officialProcedureEvidenceRefs: ["manual"],
      }], derivedRequirementIds: [], requiredSettings: [],
    };
    expect(validateFirmwarePlan(firmware)).toContain("target firmware release is not reachable from the currently observed release");
  });
});
