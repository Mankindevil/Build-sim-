import { describe, expect, it } from "vitest";
import { createFirmwareCapability } from "../src/capabilities/firmware";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import { evaluateFirmwarePath } from "../src/firmware/evaluate";
import {
  progressiveEvaluationReferences,
  validateProgressiveBuildEvaluation,
  validateProgressiveBuildEvaluationClosure,
} from "../src/compatibility/contracts";
import {
  validateProgressiveBuildEvaluationAuthorityRuntime,
  validateProgressiveBuildEvaluationRuntime,
} from "../src/compatibility/runtime.mjs";
import {
  allocateRequirementSupplies,
  deriveRequirementReadiness,
} from "../src/requirements/allocation";
import {
  assemblyCheckAssertionHashRuntime,
  assemblyResourceAssertionHashRuntime,
  type AssemblySafetyInput,
} from "../src/requirements/assembly-safety";
import { requirementArtifactContentHashRuntime } from "../src/requirements/runtime.mjs";
import { contentHashRuntime, legacySha256Runtime } from "../src/facts/canonical-runtime.mjs";
import { hashPlanConfig } from "../src/plans/canonical";
import type { ResolvedObservationRecord } from "../src/server/evaluation-service";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import type { FactRecord } from "../src/facts/contracts";
import {
  fact,
  PROGRESSIVE_FIXTURE_NOW,
  progressiveInput,
  progressivePriceSnapshot,
  resolvedComponent,
} from "./helpers/progressive-evaluation-fixture";

async function firmwareObservation(
  config: ReturnType<typeof createEmptyBuildConfigV3>,
  observationId: string,
  instanceId: string,
  releaseFactId: string,
): Promise<ResolvedObservationRecord> {
  const configHash = await hashPlanConfig(config);
  const subjectRevisionHash = "b".repeat(64);
  const material = {
    observationId,
    planId: config.id,
    subjectRef: { kind: "firmware_instance" as const, instanceId },
    fieldId: "firmware.bios_version" as const,
    value: releaseFactId,
    method: "visual_confirmation" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: configHash,
    subjectRevisionHash,
    capturedAt: PROGRESSIVE_FIXTURE_NOW,
    validatedAt: PROGRESSIVE_FIXTURE_NOW,
    status: "active" as const,
  };
  const observation = { ...material, contentHash: legacySha256Runtime(material)! };
  return {
    recordHash: legacySha256Runtime(observation)!,
    observation,
    projectionContext: {
      planId: config.id,
      subjectExists: true,
      currentConfigHash: configHash,
      currentSubjectRevisionHash: subjectRevisionHash,
    },
    attachmentClosureVerified: true,
  };
}

async function resourceObservation(
  config: ReturnType<typeof createEmptyBuildConfigV3>,
  observationId: string,
  check: AssemblySafetyInput["checks"][number],
): Promise<ResolvedObservationRecord> {
  if (check.checkType !== "resource") throw new TypeError("resource observation requires a resource check");
  const configHash = await hashPlanConfig(config);
  const subjectRevisionHash = legacySha256Runtime({ observationId, instanceId: check.ownerInstanceId })!;
  const assertionHash = assemblyResourceAssertionHashRuntime(check);
  if (assertionHash === null) throw new TypeError("resource observation requires a valid governed assertion");
  const material = {
    observationId,
    planId: config.id,
    subjectRef: { kind: "instance" as const, instanceId: check.ownerInstanceId },
    fieldId: "assembly.resource_assertion_hash" as const,
    value: assertionHash,
    method: "visual_confirmation" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: configHash,
    subjectRevisionHash,
    capturedAt: PROGRESSIVE_FIXTURE_NOW,
    validatedAt: PROGRESSIVE_FIXTURE_NOW,
    status: "active" as const,
  };
  const observation = { ...material, contentHash: legacySha256Runtime(material)! };
  return {
    recordHash: legacySha256Runtime(observation)!,
    observation,
    projectionContext: {
      planId: config.id,
      subjectExists: true,
      currentConfigHash: configHash,
      currentSubjectRevisionHash: subjectRevisionHash,
    },
    attachmentClosureVerified: true,
  };
}

async function assemblyCheckObservation(
  config: ReturnType<typeof createEmptyBuildConfigV3>,
  observationId: string,
  check: Exclude<AssemblySafetyInput["checks"][number], { checkType: "resource" }>,
): Promise<ResolvedObservationRecord> {
  const configHash = await hashPlanConfig(config);
  const subjectRevisionHash = legacySha256Runtime({ observationId, instanceId: check.ownerInstanceId })!;
  const assertionHash = assemblyCheckAssertionHashRuntime(check);
  if (assertionHash === null) throw new TypeError("assembly observation requires a valid governed assertion");
  const material = {
    observationId,
    planId: config.id,
    subjectRef: { kind: "instance" as const, instanceId: check.ownerInstanceId },
    fieldId: "assembly.check_assertion_hash" as const,
    value: assertionHash,
    method: "visual_confirmation" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: configHash,
    subjectRevisionHash,
    capturedAt: PROGRESSIVE_FIXTURE_NOW,
    validatedAt: PROGRESSIVE_FIXTURE_NOW,
    status: "active" as const,
  };
  const observation = { ...material, contentHash: legacySha256Runtime(material)! };
  return {
    recordHash: legacySha256Runtime(observation)!,
    observation,
    projectionContext: {
      planId: config.id,
      subjectExists: true,
      currentConfigHash: configHash,
      currentSubjectRevisionHash: subjectRevisionHash,
    },
    attachmentClosureVerified: true,
  };
}

function authoritativeRoots(evaluation: Awaited<ReturnType<typeof evaluateProgressiveCompatibility>>) {
  const roots = new Set(evaluation.requirementClosure.rootRequirementIds);
  return evaluation.requirements.filter(({ requirementId }) => roots.has(requirementId));
}

function renameFactId(source: FactRecord, factId: string): FactRecord {
  const { contentHash: _contentHash, ...material } = source;
  const renamed = { ...material, factId };
  const contentHash = contentHashRuntime(renamed, "fact-record", "fact-record-v1", "factRecord");
  if (contentHash === null) throw new TypeError("renamed fact fixture hash failed");
  return { ...renamed, contentHash };
}

describe("U6 progressive evaluation authority", () => {
  it("keeps an empty V3 plan honest instead of reporting power-ready", async () => {
    const config = createEmptyBuildConfigV3("plan-empty-progressive", "Empty", PROGRESSIVE_FIXTURE_NOW);
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input);

    expect(evaluation.topologyBom).toEqual([]);
    expect(evaluation.readiness).toMatchObject({
      profileCompleteness: "empty",
      identityCompleteness: "empty",
      assemblyReady: false,
      powerReady: false,
      firstBootReady: false,
      osInstallReady: false,
    });
    expect(evaluation.requirements.filter(({ kind }) => kind === "component")).toHaveLength(7);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.core-profile")).toMatchObject({
      applicability: "applicable",
      verdict: "unknown",
      inputStatus: "missing",
    });
    expect(validateProgressiveBuildEvaluation(evaluation)).toEqual([]);
    expect(validateProgressiveBuildEvaluationRuntime(evaluation)).toEqual([]);
    expect(validateProgressiveBuildEvaluationAuthorityRuntime(evaluation, {
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
    })).toEqual([]);
    expect(validateProgressiveBuildEvaluationClosure(evaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [],
      requirementRoots: authoritativeRoots(evaluation),
    })).toEqual([]);
    expect(progressiveEvaluationReferences(evaluation)).toMatchObject({
      authorityRefs: expect.arrayContaining([evaluation.authority.ruleSet.ref, evaluation.authority.engine.ref]),
      instanceIds: [],
    });
  });

  it("continues exact known prices on a partial topology and binds them to the locked snapshot", async () => {
    const config = createEmptyBuildConfigV3("plan-progressive-price", "Progressive price", PROGRESSIVE_FIXTURE_NOW);
    config.components = [
      {
        instanceId: "memory-progressive-price-1",
        kind: "memory_module",
        role: "system-memory",
        state: "planned",
        identity: { status: "unresolved", userText: "32GB memory" },
        source: "user",
      },
      resolvedComponent("psu-progressive-price-0001", "psu", "psu.fixture.850w"),
    ];
    const priceSnapshot = progressivePriceSnapshot([
      {
        skuId: "psu.fixture.850w", platform: "jd", priceCny: 999, currency: "CNY",
        listingUrl: "https://example.invalid/jd/psu.fixture.850w", match: "mpn", evidence: "audited",
        priceKind: "variant", variantLabel: "850W",
      },
      {
        skuId: "psu.fixture.850w", platform: "official", priceCny: 899, currency: "CNY",
        listingUrl: "https://example.invalid/official/psu.fixture.850w", match: "mpn", evidence: "audited",
        priceKind: "variant", variantLabel: "850W",
      },
    ]);
    const input = await progressiveInput(config, [], [], [], priceSnapshot);
    const evaluation = await evaluateProgressiveCompatibility(input);
    expect(evaluation.priceProjection).toMatchObject({
      snapshotId: priceSnapshot.snapshotId,
      knownSubtotalCny: 899,
      unknownInstanceIds: ["memory-progressive-price-1"],
      complete: false,
      lines: [
        { instanceId: "memory-progressive-price-1", status: "unknown", reason: "identity_unresolved" },
        { instanceId: "psu-progressive-price-0001", status: "known", priceCny: 899, platform: "official" },
      ],
    });
    expect(progressiveEvaluationReferences(evaluation)?.authorityRefs).toContain(evaluation.priceProjection.priceSnapshotRef);

    const tampered = structuredClone(evaluation);
    tampered.priceProjection.lines = tampered.priceProjection.lines.map((line) => line.status === "known"
      ? { ...line, priceCny: 1 } : line);
    tampered.priceProjection.knownSubtotalCny = 1;
    expect(validateProgressiveBuildEvaluationRuntime(tampered)).toEqual([]);
    expect(validateProgressiveBuildEvaluationClosure(tampered, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [],
      requirementRoots: authoritativeRoots(evaluation),
    })).toContain("priceProjection differs from the locked governed price snapshot");
  });

  it("binds a portable result to the exact locked rule manifest and executable sources", async () => {
    const config = createEmptyBuildConfigV3("plan-progressive-authority", "Authority", PROGRESSIVE_FIXTURE_NOW);
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input);
    const context = {
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
    };

    expect(validateProgressiveBuildEvaluationAuthorityRuntime(evaluation, context)).toEqual([]);
    const incompleteEngine = structuredClone(input.artifacts.engine.payload) as { sources: unknown[] };
    incompleteEngine.sources = incompleteEngine.sources.slice(1);
    expect(validateProgressiveBuildEvaluationAuthorityRuntime(evaluation, {
      ...context,
      enginePayload: incompleteEngine,
    })).not.toEqual([]);
    const changedAuthority = structuredClone(evaluation);
    changedAuthority.authority.evaluationLockHash = "0".repeat(64);
    expect(validateProgressiveBuildEvaluationAuthorityRuntime(changedAuthority, context)).not.toEqual([]);
  });

  it("reports a case-only plan as partial and preserves non-applicable rule coverage", async () => {
    const config = createEmptyBuildConfigV3("plan-case-only", "Case only", PROGRESSIVE_FIXTURE_NOW);
    config.components = [resolvedComponent("case-1", "case", "case.fixture")];
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input);

    expect(evaluation.readiness.profileCompleteness).toBe("partial");
    expect(evaluation.readiness.powerReady).toBe(false);
    expect(evaluation.coverage.registeredRuleCount).toBe(evaluation.ruleEvaluations.length);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.gpu-length-clearance")).toMatchObject({
      applicability: "not_applicable",
      verdict: "not_applicable",
    });
    expect(evaluation.domainEvaluations).toHaveLength(12);
  });

  it("keeps identity, evidence, exact prices, and local conclusions for the U6 partial-build gate", async () => {
    const config = createEmptyBuildConfigV3("plan-u6-partial-gate", "U6 partial gate", PROGRESSIVE_FIXTURE_NOW);
    const caseComponent = resolvedComponent("case-1", "case", "case.fixture");
    const board = resolvedComponent("board-1", "motherboard", "board.fixture");
    const cpu = resolvedComponent("cpu-1", "cpu", "cpu.fixture");
    const firstDrive = resolvedComponent("drive-1", "storage_drive", "drive.fixture.1");
    const secondDrive = resolvedComponent("drive-2", "storage_drive", "drive.fixture.2");
    const psu = resolvedComponent("psu-1", "psu", "psu.fixture");
    config.components = [caseComponent, board, cpu, firstDrive, secondDrive, psu];
    config.placements = [{
      placementId: "board-in-case",
      componentInstanceId: board.instanceId,
      mountOwnerInstanceId: caseComponent.instanceId,
      mountId: "motherboard-tray",
    }];
    const quotes = config.components.map((component, index) => ({
      skuId: component.identity.status === "resolved" ? component.identity.skuId : "unreachable",
      platform: "official" as const,
      priceCny: (index + 1) * 100,
      currency: "CNY" as const,
      listingUrl: `https://example.invalid/${component.instanceId}`,
      match: "mpn" as const,
      evidence: "audited" as const,
      priceKind: "variant" as const,
      variantLabel: component.instanceId,
    }));
    const input = await progressiveInput(config, [
      fact(caseComponent, "case.motherboard_form_factors", ["ATX"]),
      fact(board, "motherboard.form_factor", "ATX"),
      fact(board, "motherboard.cpu_socket", "AM5"),
      fact(cpu, "cpu.socket", "AM5"),
      fact(firstDrive, "storage.boot_support", true),
      fact(secondDrive, "storage.boot_support", true),
    ], [], [], progressivePriceSnapshot(quotes));
    const evaluation = await evaluateProgressiveCompatibility(input);

    expect(evaluation.readiness).toMatchObject({
      profileCompleteness: "partial",
      powerReady: false,
      firstBootReady: false,
    });
    expect(evaluation.topologyBom).toHaveLength(6);
    expect(evaluation.topologyBom.every((line) => line.identityStatus === "resolved"
      && line.identityClaimIds.length > 0)).toBe(true);
    expect(evaluation.priceProjection).toMatchObject({ knownSubtotalCny: 2100, unknownInstanceIds: [], complete: true });
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.cpu-socket"))
      .toMatchObject({ verdict: "pass", inputStatus: "complete" });
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.case-board-form-factor"))
      .toMatchObject({ verdict: "pass", inputStatus: "complete" });
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.storage-boot-support"))
      .toMatchObject({ verdict: "pass", inputStatus: "complete" });
    const missingCoreKinds = evaluation.requirements
      .filter(({ producedBy }) => producedBy.ruleId === "compat.core-profile")
      .flatMap(({ predicates }) => predicates
        .filter(({ facetId }) => facetId === "identity.category")
        .map(({ value }) => value));
    expect(missingCoreKinds).toEqual(["cpu_cooler", "memory_module"]);
    const absent = new Set(["gpu", "hba", "case_fan", "cable"]);
    expect(evaluation.topologyBom.some(({ kind }) => absent.has(kind))).toBe(false);
    expect(evaluation.requirements.some((requirement) => requirement.predicates.some((predicate) => (
      predicate.facetId === "identity.category" && typeof predicate.value === "string" && absent.has(predicate.value)
    )))).toBe(false);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.assembly-safety"))
      .toMatchObject({ verdict: "blocked" });
  });

  it("rejects checksum-independent mutations of coverage, authority, rule pairs, and readiness", async () => {
    const config = createEmptyBuildConfigV3("plan-runtime-mutations", "Mutations", PROGRESSIVE_FIXTURE_NOW);
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input);
    const mutate = (operation: (candidate: any) => void): string[] => {
      const candidate = structuredClone(evaluation) as any;
      operation(candidate);
      const runtimeErrors = validateProgressiveBuildEvaluationRuntime(candidate);
      expect(validateProgressiveBuildEvaluation(candidate)).toEqual(runtimeErrors);
      return runtimeErrors;
    };

    expect(mutate((candidate) => { candidate.coverage.applicableRuleCount += 1; })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.authority.engine.ref = `sha256:${"0".repeat(64)}`; })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.ruleEvaluations[0].ruleVersion = "9.9.9"; })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.requirementReadiness.powerReady = true; })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.readiness.powerReady = true; })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.ruleEvaluations.reverse(); })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.thermalAcousticEvaluation.simulationInputHash = "0".repeat(64); })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.thermalAcousticEvaluation.thermal.ambientC = { lo: 30, hi: 20 }; })).not.toEqual([]);
    expect(mutate((candidate) => { candidate.thermalAcousticEvaluation.thermal.verdict = "pass"; })).not.toEqual([]);

    const forgedObservation = structuredClone(evaluation) as any;
    forgedObservation.thermalAcousticEvaluation.calibration.appliedAcousticObservationIds = ["observation-not-locked"];
    expect(validateProgressiveBuildEvaluation(forgedObservation)).toEqual([]);
    expect(validateProgressiveBuildEvaluationClosure(forgedObservation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [],
      requirementRoots: authoritativeRoots(forgedObservation),
    })).toContain("progressive evaluation references an observation outside the locked closure");

    const alternateRuleSet = structuredClone(input.artifacts.ruleSet.payload) as {
      sources: Array<{ moduleId: string; bytes: string }>;
    };
    const manifestSource = alternateRuleSet.sources.find(({ moduleId }) => moduleId === "compatibility/rule-manifest")!;
    const alternateManifest = JSON.parse(manifestSource.bytes) as Array<{ definitionHash: string }>;
    alternateManifest[0]!.definitionHash = "0".repeat(64);
    manifestSource.bytes = JSON.stringify(alternateManifest);
    expect(validateProgressiveBuildEvaluationClosure(evaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: alternateRuleSet,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [],
      requirementRoots: authoritativeRoots(evaluation),
    })).toContain("locked compatibility manifest differs from the executable builtin manifest");
  });

  it("rejects a checksum-correct supply without a locked generator authority", async () => {
    const config = createEmptyBuildConfigV3("plan-forged-supply", "Forged supply", PROGRESSIVE_FIXTURE_NOW);
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input);
    const forged = structuredClone(evaluation);
    forged.requirementAllocation = allocateRequirementSupplies(forged.requirements, [{
      source: "purchase",
      refId: "forged-purchase-tool",
      kind: "tool",
      facets: [],
      quantity: 1,
      availability: "planned",
      verificationStatus: "unverified",
      evidenceRefs: [],
      observationRefs: [],
    }], { blockedRequirementIds: forged.requirementClosure.blockedRequirementIds });
    forged.requirementReadiness = deriveRequirementReadiness(forged.requirementAllocation);

    expect(validateProgressiveBuildEvaluation(forged)).toEqual([]);
    expect(validateProgressiveBuildEvaluationClosure(forged, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [],
      requirementRoots: authoritativeRoots(forged),
    })).toContain("generated allocation closure: requirement supply source lacks locked generator authority: purchase\u0000\u0000forged-purchase-tool");
  });

  it("replays fixed-point progress instead of trusting a checksum-correct closure", async () => {
    const config = createEmptyBuildConfigV3("plan-forged-fixed-point", "Forged fixed point", PROGRESSIVE_FIXTURE_NOW);
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input);
    const roots = authoritativeRoots(evaluation);
    const forged = structuredClone(evaluation);
    forged.requirementClosure.iterations = 1;
    forged.requirementClosure.contentHash = requirementArtifactContentHashRuntime(
      forged.requirementClosure,
      forged.requirementClosure.schemaVersion,
    )!;

    expect(validateProgressiveBuildEvaluation(forged)).toEqual([]);
    expect(validateProgressiveBuildEvaluationClosure(forged, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [],
      requirementRoots: roots,
    })).toContain("requirement fixed-point closure: requirement closure differs from locked fixed-point replay");
  });

  it("keeps unobserved assembly checks blocked and rejects duplicated physical authorities", async () => {
    const config = createEmptyBuildConfigV3("plan-assembly-observation-authority", "Assembly", PROGRESSIVE_FIXTURE_NOW);
    const board = resolvedComponent("board-1", "motherboard", "board.fixture");
    config.components = [board];
    const authority = { ownerInstanceId: board.instanceId, instanceIds: [board.instanceId], factIds: [], observationIds: [] };
    const unknownAssembly: AssemblySafetyInput = {
      assemblyId: "unknown-checks",
      checks: [
        {
          ...authority,
          checkId: "standoffs",
          checkType: "standoff_layout",
          expectedPositionIds: ["a"],
          expectedThread: "M3",
          expectedHeightMm: 6,
          heightToleranceMm: 0.5,
          observed: null,
        },
        { ...authority, checkId: "atx24", checkType: "connection", connectionKind: "atx24", connectorStandard: "atx24", state: "unknown" },
        {
          ...authority,
          checkId: "gpu-power",
          checkType: "12v2x6",
          connectorStandard: "12v2x6",
          state: "unknown",
          fullySeated: null,
          bendDistanceMm: null,
          minimumBendDistanceMm: 35,
        },
        { ...authority, checkId: "film", checkType: "protective_film", state: "unknown" },
        { ...authority, checkId: "metal", checkType: "loose_metal", state: "unknown" },
      ],
    };
    const input = await progressiveInput(config);
    const evaluation = await evaluateProgressiveCompatibility(input, {
      authorityResolver: { resolveAssemblySafetyInputs: async () => [unknownAssembly] },
    });
    expect(evaluation.assemblySafetyEvaluations[0]?.decisions.every(({ verdict }) => verdict === "blocked")).toBe(true);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.assembly-safety"))
      .toMatchObject({ verdict: "blocked" });

    const standoffCheck = unknownAssembly.checks[0]!;
    if (standoffCheck.checkType !== "standoff_layout") throw new TypeError("fixture standoff check missing");
    const overlapping: AssemblySafetyInput = {
      assemblyId: "overlap",
      checks: [
        standoffCheck,
        { ...standoffCheck, checkId: "standoffs-two", expectedPositionIds: ["a", "b"] },
      ],
    };
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: { resolveAssemblySafetyInputs: async () => [overlapping] },
    })).rejects.toThrow(/repeats a physical owner\/standoff position/);

    const observedCheck = {
      ...authority,
      checkId: "eps",
      checkType: "connection" as const,
      connectionKind: "eps" as const,
      connectorStandard: "eps8",
      state: "connected_verified" as const,
      observationIds: ["obs-eps-assertion"],
    };
    const observation = await assemblyCheckObservation(config, "obs-eps-assertion", observedCheck);
    const observedInput = await progressiveInput(config, [], [observation]);
    await expect(evaluateProgressiveCompatibility(observedInput, {
      authorityResolver: {
        resolveAssemblySafetyInputs: async () => [
          { assemblyId: "assembly-a", checks: [observedCheck] },
          { assemblyId: "assembly-b", checks: [observedCheck] },
        ],
      },
    })).rejects.toThrow(/repeats an owner\/semantic assembly check|reuses an exact check assertion observation/);
  });

  it("replays a firmware target from locked capability, CPU, fact, and observation authority", async () => {
    const config = createEmptyBuildConfigV3("plan-firmware-progressive", "Firmware", PROGRESSIVE_FIXTURE_NOW);
    const board = resolvedComponent("board-1", "motherboard", "board.fixture");
    const cpu = resolvedComponent("cpu-1", "cpu", "cpu.fixture");
    config.components = [board, cpu];
    config.placements = [{
      placementId: "cpu-on-board",
      componentInstanceId: cpu.instanceId,
      mountOwnerInstanceId: board.instanceId,
      mountId: "cpu-socket",
    }];
    const release = fact(board, "firmware.bridge_version", "release-current", { subjectRegion: "CN" });
    const cpuSupport = fact(board, "firmware.cpu_support", {
      cpuSkuId: "cpu.fixture",
      boardRevision: "fixture",
      region: "CN",
      sinceVersion: release.factId,
    }, { subjectRegion: "CN" });
    config.firmwareTargets = [{
      instanceId: board.instanceId,
      targetReleaseFactId: release.factId,
      requestedSettings: [],
      source: "user",
    }];
    const observed = await firmwareObservation(config, "obs-firmware-current", board.instanceId, release.factId);
    const historical = fact(board, "firmware.file_hash", "d".repeat(64), { authority: "third_party" });
    const input = await progressiveInput(config, [release, historical, cpuSupport], [observed]);
    const capabilitySources = [cpuSupport.factId, historical.factId, release.factId].sort();
    const capability = await createFirmwareCapability({
      schemaVersion: "firmware-capability-v1",
      subjectSkuId: "board.fixture",
      subjectRevision: "fixture",
      region: "CN",
      factSnapshotRef: {
        snapshotId: input.factClosure.snapshot.snapshotId,
        contentHash: input.factClosure.snapshot.contentHash,
      },
      versionIdentification: { method: "uefi_screen", sourceFactIds: [release.factId] },
      releases: [
        { releaseFactId: historical.factId, label: "Historical", sourceFactIds: [historical.factId] },
        { releaseFactId: release.factId, label: "Current", sourceFactIds: [release.factId] },
      ].sort((left, right) => left.releaseFactId.localeCompare(right.releaseFactId)),
      cpuSupport: [{ cpuSkuId: "cpu.fixture", minimumReleaseFactId: release.factId, sourceFactIds: [cpuSupport.factId] }],
      transitions: [],
      settings: [],
      rollbackSupported: false,
      recoveryMethod: "none",
      sourceFactIds: capabilitySources,
    });
    const pathInput = {
      capability,
      instanceId: board.instanceId,
    };
    const evaluation = await evaluateProgressiveCompatibility(input, {
      authorityResolver: { resolveFirmwarePathInput: async () => pathInput },
    });
    expect(evaluation.firmwareEvaluations).toMatchObject([{
      instanceId: board.instanceId,
      verdict: "pass",
      reason: "already_at_target",
      searchAuthority: { availableRequirementIds: [] },
    }]);
    expect(progressiveEvaluationReferences(evaluation)?.observationRefs)
      .toContain(`observation:${observed.observation.observationId}`);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.firmware-path"))
      .toMatchObject({ verdict: "pass", inputStatus: "complete" });
    expect(validateProgressiveBuildEvaluationClosure(evaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [capability],
      firmwarePathInputs: [{
        ...pathInput,
        preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
      }],
      firmwareFixedPointRootRequirements: authoritativeRoots(evaluation).filter(({ requirementId }) => (
        !evaluation.firmwareEvaluations.some(({ derivedRequirements }) => (
          derivedRequirements.some((requirement) => requirement.requirementId === requirementId)
        ))
      )),
      requirementRoots: authoritativeRoots(evaluation),
    })).toContain("firmwarePathInputs.0 preflight differs from verified assembly supplies");
    expect(validateProgressiveBuildEvaluationClosure(evaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [capability],
      firmwarePathInputs: [{
        ...pathInput,
        currentObservation: {
          observationId: "obs-firmware-forged",
          releaseFactId: release.factId,
          method: "uefi_screen",
          evidenceRefs: [],
        },
      }],
      firmwareFixedPointRootRequirements: authoritativeRoots(evaluation),
      requirementRoots: authoritativeRoots(evaluation),
    })).toContain("firmwarePathInputs.0 current observation differs from locked unique projection");

    const { contentHash: _capabilityHash, ...capabilityMaterial } = capability;
    const otherBoardCapability = await createFirmwareCapability({
      ...capabilityMaterial,
      subjectSkuId: "other-board.fixture",
    });
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({ ...pathInput, capability: otherBoardCapability }),
      },
    })).rejects.toThrow(/locked target\/component\/snapshot/);
    const otherBoardPath = await evaluateFirmwarePath({
      ...pathInput,
      capability: otherBoardCapability,
      currentObservation: evaluation.firmwareEvaluations[0]!.currentObservation,
      cpuSkuId: "cpu.fixture",
      targetReleaseFactId: release.factId,
      availableRequirementIds: [],
      availableFactIds: [],
      preflight: { workingCpuAvailable: null, workingMemoryAvailable: null, displayPathAvailable: null },
      transitionTemporaryHardwareRequirements: [],
      requestedSettings: [],
      requireRecovery: false,
    });
    const restoredWithOtherBoard = structuredClone(evaluation);
    restoredWithOtherBoard.firmwareCapabilities = [otherBoardCapability];
    restoredWithOtherBoard.firmwareEvaluations = [otherBoardPath];
    expect(validateProgressiveBuildEvaluation(restoredWithOtherBoard)).toEqual([]);
    expect(validateProgressiveBuildEvaluationClosure(restoredWithOtherBoard, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [otherBoardCapability],
      firmwarePathInputs: [{ ...pathInput, capability: otherBoardCapability }],
      firmwareFixedPointRootRequirements: authoritativeRoots(evaluation),
      requirementRoots: authoritativeRoots(evaluation),
    })).toContain("firmwareEvaluations.0 capability subject differs from locked target identity");

    const unrelatedBoard = resolvedComponent("board-unrelated", "motherboard", "board.unrelated");
    const unrelatedRelease = fact(unrelatedBoard, "firmware.bridge_version", "release-current", { subjectRegion: "CN" });
    const { contentHash: _unrelatedHash, ...unrelatedReleaseMaterial } = unrelatedRelease;
    const renamedUnrelatedMaterial = { ...unrelatedReleaseMaterial, factId: release.factId };
    const renamedUnrelatedHash = contentHashRuntime(
      renamedUnrelatedMaterial,
      "fact-record",
      "fact-record-v1",
      "factRecord",
    );
    if (renamedUnrelatedHash === null) throw new TypeError("unrelated firmware fact fixture hash failed");
    const renamedUnrelatedRelease = { ...renamedUnrelatedMaterial, contentHash: renamedUnrelatedHash };
    const unrelatedFactClosure = {
      ...structuredClone(input.factClosure),
      facts: input.factClosure.facts.map((entry) => (
        entry.factId === release.factId ? renamedUnrelatedRelease : entry
      )),
    };
    expect(validateProgressiveBuildEvaluationClosure(evaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: unrelatedFactClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [capability],
      firmwarePathInputs: [pathInput],
      firmwareFixedPointRootRequirements: authoritativeRoots(evaluation),
      requirementRoots: authoritativeRoots(evaluation),
    })).toContain(`firmwareEvaluations.0 executable fact ${release.factId} subject differs from firmware capability subject`);
    const unrelatedInput = await progressiveInput(
      config,
      [renamedUnrelatedRelease, historical, cpuSupport],
      [observed],
    );
    const unrelatedCapability = await createFirmwareCapability({
      ...capabilityMaterial,
      factSnapshotRef: {
        snapshotId: unrelatedInput.factClosure.snapshot.snapshotId,
        contentHash: unrelatedInput.factClosure.snapshot.contentHash,
      },
    });
    await expect(evaluateProgressiveCompatibility(unrelatedInput, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({ capability: unrelatedCapability, instanceId: board.instanceId }),
      },
    })).rejects.toThrow(/subject differs from firmware capability subject/);

    const thirdPartyRelease = fact(board, "firmware.bridge_version", "release-current", {
      authority: "third_party",
      subjectRegion: "CN",
    });
    const untrustedFactClosure = {
      ...structuredClone(input.factClosure),
      facts: input.factClosure.facts.map((entry) => (
        entry.factId === thirdPartyRelease.factId ? thirdPartyRelease : entry
      )),
    };
    expect(validateProgressiveBuildEvaluationClosure(evaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: untrustedFactClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [capability],
      firmwarePathInputs: [pathInput],
      firmwareFixedPointRootRequirements: authoritativeRoots(evaluation),
      requirementRoots: authoritativeRoots(evaluation),
    })).toContain(`firmwareEvaluations.0 executable fact ${release.factId} lacks active official authority`);
    const untrustedInput = await progressiveInput(config, [thirdPartyRelease, historical, cpuSupport], [observed]);
    const untrustedCapability = await createFirmwareCapability({
      ...capabilityMaterial,
      factSnapshotRef: {
        snapshotId: untrustedInput.factClosure.snapshot.snapshotId,
        contentHash: untrustedInput.factClosure.snapshot.contentHash,
      },
    });
    await expect(evaluateProgressiveCompatibility(untrustedInput, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({ ...pathInput, capability: untrustedCapability }),
      },
    })).rejects.toThrow(/lack active official authority/);

    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({ ...pathInput, availableRequirementIds: ["requirement.forged"] }),
      },
    })).rejects.toThrow(/self-author requirement availability/);
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({
          ...pathInput,
          preflight: { workingCpuAvailable: true },
        }),
      },
    })).rejects.toThrow(/preflight differs from verified assembly supplies/);
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({ ...pathInput, requireRecovery: true }),
      },
    })).rejects.toThrow(/recovery policy differs from the locked capability/);
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({
          ...pathInput,
          currentObservation: {
            observationId: "obs-firmware-forged",
            releaseFactId: release.factId,
            method: "uefi_screen" as const,
            evidenceRefs: [],
          },
        }),
      },
    })).rejects.toThrow(/current observation differs from the locked unique projection/);
    const duplicateObserved = await firmwareObservation(
      config,
      "obs-firmware-current-duplicate",
      board.instanceId,
      release.factId,
    );
    const ambiguousInput = await progressiveInput(config, [release, historical, cpuSupport], [observed, duplicateObserved]);
    await expect(evaluateProgressiveCompatibility(ambiguousInput, {
      authorityResolver: { resolveFirmwarePathInput: async () => pathInput },
    })).rejects.toThrow(/current observation .* is ambiguous/);
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveFirmwarePathInput: async () => ({
          ...pathInput,
          transitionTemporaryHardwareRequirements: [{ transitionId: "caller-transition", requirementIds: ["caller-requirement"] }],
        }),
      },
    })).rejects.toThrow(/self-author transition hardware requirements/);
  });

  it("derives omitted firmware optionals and canonicalizes requested setting order", async () => {
    const config = createEmptyBuildConfigV3("plan-firmware-optionals", "Firmware optionals", PROGRESSIVE_FIXTURE_NOW);
    const board = resolvedComponent("board-1", "motherboard", "board.fixture");
    const cpu = resolvedComponent("cpu-1", "cpu", "cpu.fixture");
    config.components = [board, cpu];
    config.placements = [{
      placementId: "cpu-on-board",
      componentInstanceId: cpu.instanceId,
      mountOwnerInstanceId: board.instanceId,
      mountId: "cpu-socket",
    }];
    const release = fact(board, "firmware.bridge_version", "release-current", { subjectRegion: "CN" });
    const cpuSupport = fact(board, "firmware.cpu_support", {
      cpuSkuId: "cpu.fixture",
      boardRevision: "fixture",
      region: "CN",
      sinceVersion: release.factId,
    }, { subjectRegion: "CN" });
    config.firmwareTargets = [{
      instanceId: board.instanceId,
      targetReleaseFactId: release.factId,
      requestedSettings: [
        { settingId: "tpm", desiredValue: "enabled" },
        { settingId: "iommu", desiredValue: "disabled" },
      ],
      source: "user",
    }];
    const observed = await firmwareObservation(config, "obs-firmware-optionals", board.instanceId, release.factId);
    const input = await progressiveInput(config, [release, cpuSupport], [observed]);
    const capability = await createFirmwareCapability({
      schemaVersion: "firmware-capability-v1",
      subjectSkuId: "board.fixture",
      subjectRevision: "fixture",
      region: "CN",
      factSnapshotRef: {
        snapshotId: input.factClosure.snapshot.snapshotId,
        contentHash: input.factClosure.snapshot.contentHash,
      },
      versionIdentification: { method: "uefi_screen", sourceFactIds: [release.factId] },
      releases: [{ releaseFactId: release.factId, label: "Current", sourceFactIds: [release.factId] }],
      cpuSupport: [{ cpuSkuId: "cpu.fixture", minimumReleaseFactId: release.factId, sourceFactIds: [cpuSupport.factId] }],
      transitions: [],
      settings: [
        { settingId: "iommu", supportedValues: ["disabled", "enabled"], sourceFactIds: [release.factId] },
        { settingId: "tpm", supportedValues: ["disabled", "enabled"], sourceFactIds: [release.factId] },
      ],
      rollbackSupported: false,
      recoveryMethod: "none",
      sourceFactIds: [cpuSupport.factId, release.factId].sort(),
    });
    const pathInput = { capability, instanceId: board.instanceId };
    const evaluation = await evaluateProgressiveCompatibility(input, {
      authorityResolver: { resolveFirmwarePathInput: async () => pathInput },
    });
    expect(evaluation.firmwareEvaluations).toMatchObject([{
      cpuSkuId: "cpu.fixture",
      targetReleaseFactId: release.factId,
      verdict: "blocked",
      reason: "requirements_missing",
      searchAuthority: {
        requestedTargetReleaseFactId: release.factId,
        requestedSettings: [
          { settingId: "iommu", desiredValue: "disabled", evidenceRefs: [release.factId] },
          { settingId: "tpm", desiredValue: "enabled", evidenceRefs: [release.factId] },
        ],
      },
    }]);
    expect(validateProgressiveBuildEvaluationClosure(evaluation, {
      config,
      evaluationLock: input.evaluationLock,
      artifactLockfile: input.artifactLockfile,
      ruleSetPayload: input.artifacts.ruleSet.payload,
      enginePayload: input.artifacts.engine.payload,
      adapterSnapshotPayload: input.artifacts.adapterSnapshot.payload,
      priceSnapshot: input.externalInputs.priceSnapshot,
      factClosure: input.factClosure,
      observationClosure: input.observationClosure,
      firmwareCapabilities: [capability],
      firmwarePathInputs: [pathInput],
      firmwareFixedPointRootRequirements: authoritativeRoots(evaluation).filter(({ requirementId }) => (
        !evaluation.firmwareEvaluations.some(({ derivedRequirements }) => (
          derivedRequirements.some((requirement) => requirement.requirementId === requirementId)
        ))
      )),
      requirementRoots: authoritativeRoots(evaluation),
    })).toEqual([]);
  });

  it("allocates verified temporary hardware and media into an executable UEFI path", async () => {
    const config = createEmptyBuildConfigV3("plan-firmware-fixed-point", "Firmware resources", PROGRESSIVE_FIXTURE_NOW);
    const board = resolvedComponent("board-1", "motherboard", "board.fixture");
    const cpu = resolvedComponent("cpu-1", "cpu", "cpu.fixture");
    config.components = [board, cpu];
    config.placements = [{
      placementId: "cpu-on-board",
      componentInstanceId: cpu.instanceId,
      mountOwnerInstanceId: board.instanceId,
      mountId: "cpu-socket",
    }];
    const current = fact(board, "firmware.bridge_version", "release-1", { subjectRegion: "CN" });
    const target = renameFactId(
      fact(board, "firmware.bridge_version", "release-2", { subjectRegion: "CN" }),
      "fact.board-1.firmware.bridge-version.target",
    );
    const firmwareFile = fact(board, "firmware.file_hash", "c".repeat(64), { subjectRegion: "CN" });
    const power = fact(board, "firmware.rollback_support", true, { subjectRegion: "CN" });
    const cpuSupport = fact(board, "firmware.cpu_support", {
      cpuSkuId: "cpu.fixture",
      boardRevision: "fixture",
      region: "CN",
      sinceVersion: target.factId,
    }, { subjectRegion: "CN" });
    config.firmwareTargets = [{
      instanceId: board.instanceId,
      targetReleaseFactId: target.factId,
      requestedSettings: [],
      source: "user",
    }];
    const assemblyInput: AssemblySafetyInput = {
      assemblyId: "firmware-resources",
      checks: [
        {
          checkId: "display", checkType: "resource", ownerInstanceId: board.instanceId,
          instanceIds: [board.instanceId], factIds: [], observationIds: ["obs-display"],
          resourceId: "temporary-display",
          role: "temporary_component", kind: "component",
          predicates: [{ facetId: "identity.category", operator: "eq", value: "gpu" }],
          quantity: 1, criticality: "boot", requiredBefore: "first_boot", state: "present_verified",
        },
        {
          checkId: "firmware-medium", checkType: "resource", ownerInstanceId: board.instanceId,
          instanceIds: [board.instanceId], factIds: [], observationIds: ["obs-firmware-medium"],
          resourceId: "firmware-medium",
          role: "firmware_medium", kind: "firmware_action",
          predicates: [{ facetId: "firmware.upgrade_path_refs", operator: "includes", value: "req-media" }],
          quantity: 1, criticality: "boot", requiredBefore: "first_boot", state: "present_verified",
        },
        {
          checkId: "temporary-cpu", checkType: "resource", ownerInstanceId: board.instanceId,
          instanceIds: [board.instanceId], factIds: [], observationIds: ["obs-temp-cpu"],
          resourceId: "temporary-cpu",
          role: "temporary_component", kind: "component",
          predicates: [{ facetId: "identity.category", operator: "eq", value: "cpu" }],
          quantity: 1, criticality: "boot", requiredBefore: "first_boot", state: "present_verified",
        },
        {
          checkId: "temporary-memory", checkType: "resource", ownerInstanceId: board.instanceId,
          instanceIds: [board.instanceId], factIds: [], observationIds: ["obs-temp-memory"],
          resourceId: "temporary-memory",
          role: "temporary_component", kind: "component",
          predicates: [{ facetId: "identity.category", operator: "eq", value: "memory_module" }],
          quantity: 1, criticality: "boot", requiredBefore: "first_boot", state: "present_verified",
        },
      ],
    };
    const resourceCheck = (checkId: string) => {
      const check = assemblyInput.checks.find((candidate) => candidate.checkId === checkId);
      if (check === undefined) throw new TypeError(`missing assembly resource check ${checkId}`);
      return check;
    };
    const currentObservation = await firmwareObservation(config, "obs-firmware-release-1", board.instanceId, current.factId);
    const resourceObservations = await Promise.all([
      resourceObservation(config, "obs-temp-cpu", resourceCheck("temporary-cpu")),
      resourceObservation(config, "obs-temp-memory", resourceCheck("temporary-memory")),
      resourceObservation(config, "obs-display", resourceCheck("display")),
      resourceObservation(config, "obs-firmware-medium", resourceCheck("firmware-medium")),
    ]);
    const input = await progressiveInput(config, [current, target, firmwareFile, power, cpuSupport], [currentObservation, ...resourceObservations]);
    const sources = [cpuSupport.factId, current.factId, firmwareFile.factId, power.factId, target.factId].sort();
    const capability = await createFirmwareCapability({
      schemaVersion: "firmware-capability-v1",
      subjectSkuId: "board.fixture",
      subjectRevision: "fixture",
      region: "CN",
      factSnapshotRef: {
        snapshotId: input.factClosure.snapshot.snapshotId,
        contentHash: input.factClosure.snapshot.contentHash,
      },
      versionIdentification: { method: "uefi_screen", sourceFactIds: [current.factId] },
      releases: [
        { releaseFactId: current.factId, label: "1", sourceFactIds: [current.factId] },
        { releaseFactId: target.factId, label: "2", sourceFactIds: [target.factId] },
      ],
      cpuSupport: [{ cpuSkuId: "cpu.fixture", minimumReleaseFactId: target.factId, sourceFactIds: [cpuSupport.factId] }],
      transitions: [{
        transitionId: "uefi-update",
        fromReleaseFactId: current.factId,
        toReleaseFactId: target.factId,
        purpose: "upgrade",
        method: "uefi",
        requiresWorkingCpu: true,
        requirementIds: ["req-media"],
        firmwareFileFactId: firmwareFile.factId,
        mediaFormat: "fat32",
        requiredFilename: "BOARD.CAP",
        checksumFactId: firmwareFile.factId,
        powerPrerequisiteFactIds: [power.factId],
        recoveryTransitionIds: [],
        resetsSettings: false,
        releaseFactIds: [current.factId, target.factId],
        sourceFactIds: sources,
      }],
      settings: [],
      rollbackSupported: false,
      recoveryMethod: "none",
      sourceFactIds: sources,
    });
    const pathInput = {
      capability,
      instanceId: board.instanceId,
      currentObservation: {
        observationId: currentObservation.observation.observationId,
        releaseFactId: current.factId,
        method: "uefi_screen" as const,
        evidenceRefs: [`observation:${currentObservation.observation.observationId}@sha256:${currentObservation.recordHash}`],
      },
      cpuSkuId: "cpu.fixture",
      targetReleaseFactId: target.factId,
    };
    const evaluation = await evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveAssemblySafetyInputs: async () => [assemblyInput],
        resolveFirmwarePathInput: async () => pathInput,
      },
    });
    expect(evaluation.firmwareEvaluations).toMatchObject([{
      verdict: "pass",
      reason: "path_available",
      searchAuthority: {
        availableFactIds: [power.factId],
        preflight: { workingCpuAvailable: true, workingMemoryAvailable: true, displayPathAvailable: true },
        availableRequirementIds: expect.arrayContaining([
          "requirement.firmware.board-1.display-path",
          "requirement.firmware.board-1.temporary-cpu",
          "requirement.firmware.board-1.temporary-memory",
        ]),
      },
    }]);
    const firmwareRequirementIds = new Set(evaluation.firmwareEvaluations[0]!.derivedRequirements
      .map(({ requirementId }) => requirementId));
    expect(evaluation.requirementAllocation.satisfactions
      .filter(({ requirementId }) => firmwareRequirementIds.has(requirementId))
      .every(({ status }) => status === "satisfied")).toBe(true);
    expect(evaluation.requirements.some(({ requirementId }) => requirementId.startsWith("requirement.assembly.firmware-resources"))).toBe(false);
    expect(evaluation.ruleEvaluations.find(({ ruleId }) => ruleId === "compat.firmware-path"))
      .toMatchObject({ verdict: "pass", inputStatus: "complete" });
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveAssemblySafetyInputs: async () => [assemblyInput],
        resolveFirmwarePathInput: async () => ({ ...pathInput, availableFactIds: [] }),
      },
    })).rejects.toThrow(/available facts differ from the locked exact projection/);
    const { contentHash: _capabilityHash, ...capabilityMaterial } = capability;
    const forgedFileCapability = await createFirmwareCapability({
      ...capabilityMaterial,
      transitions: capabilityMaterial.transitions.map((transition) => ({
        ...transition,
        firmwareFileFactId: power.factId,
        checksumFactId: power.factId,
      })),
    });
    await expect(evaluateProgressiveCompatibility(input, {
      authorityResolver: {
        resolveAssemblySafetyInputs: async () => [assemblyInput],
        resolveFirmwarePathInput: async () => ({ ...pathInput, capability: forgedFileCapability }),
      },
    })).rejects.toThrow(/is not a governed firmware file hash/);
  });
});
