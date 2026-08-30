import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import {
  ARTIFACT_LOCK_ROLES,
  canonicalize,
  createArtifactLockfile,
  createLockedArtifactRef,
  legacySha256Hex,
  type ArtifactLockEntries,
  type ArtifactLockRole,
  type ArtifactLockfile,
  type LockedArtifactRef,
  type SnapshotHashes,
} from "../src/hash";
import {
  CaseAdapterRegistry,
  caseRuntimeModelCanonicalBytes,
  caseRuntimeModelContentHash,
  createCaseAdapterManifest,
  createCaseRuntimeModel,
  verifyCaseAdapterSnapshotPayload,
  type CaseAdapterArtifactPayload,
} from "../src/adapters";
import {
  bundledHardwareStandardSeedBytes,
  createWorkspaceStandardSetPayload,
  verifyWorkspaceStandardSetPayload,
} from "../src/standards";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { authoritativeEvaluationHash, createPlanPartialEvaluationV3, EvaluationCoordinator } from "../src/plans/evaluation";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { hashPlanConfig } from "../src/plans/canonical";
import { EvaluationLockRepository, EvaluationReplayUnavailableError } from "../src/plans/evaluation-lock-repository";
import {
  builtinArtifactInputs,
  createRepositoryBackedEvaluationSnapshotAuthority,
  createWorkspaceRepositories,
} from "../src/server/workspace-server";
import {
  AuthoritativeEvaluationSnapshotPipeline,
  type LoadedArtifactInput,
  type LoadedArtifactInputs,
  type LoadedExternalSnapshot,
} from "../src/server/evaluation-service";
import { resolveObservationProjectionContext } from "../src/observations/subject-resolution";
import type { UserObservation } from "../src/observations/contracts";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import type { CaseInstanceOverrides } from "../src/adapters/instance-overrides";
import { verifyCaseInstanceOverridesRuntime } from "../src/observations/canonical-runtime.mjs";
import type { BuildConfigDocument } from "../src/config/types";
import { createRuntimeCaseAdapterRegistryFixture } from "./helpers/runtime-case-adapter-registry-fixture";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { sha256Json } from "../src/runtime/fs.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { appendJsonAuthorityToEncryptedBackup } from "./helpers/rewrite-encrypted-backup";

const roots: string[] = [];
const digest = (letter: string): string => letter.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeArtifacts(genericAdaptersEnabled: boolean): Promise<{
  runtimeRoot: string;
  coordinator: RuntimeCoordinator;
  activeRoot: string;
  artifacts: LoadedArtifactInputs;
}> {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u5-artifacts-"));
  roots.push(runtimeRoot);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
  await coordinator.initialize();
  await initializeRuntimeCatalog({ coordinator, generationAware: true });
  const captured = await coordinator.withConsistentSnapshot(async ({ activeRoot, state }: {
    activeRoot: string;
    state: { runtimeGeneration: number };
  }) => ({
    activeRoot,
    artifacts: await builtinArtifactInputs(activeRoot, runtimeRoot, {
      genericAdaptersEnabled,
      ...(genericAdaptersEnabled ? { activeRuntimeGeneration: state.runtimeGeneration } : {}),
    }),
  }));
  return { runtimeRoot, coordinator, activeRoot: captured.result.activeRoot, artifacts: captured.result.artifacts };
}

async function relock(role: ArtifactLockRole, payload: unknown, template: LockedArtifactRef): Promise<LockedArtifactRef> {
  return createLockedArtifactRef(payload, role, template.artifactId, template.mediaType, {
    domain: template.domain,
    schemaVersion: template.schemaVersion,
    canonicalizationPolicyId: template.canonicalizationPolicyId,
  });
}

function replaceSource(payload: unknown, moduleId: string, bytes: string): unknown {
  const changed = structuredClone(payload) as { sources: Array<{ moduleId: string; bytes: string }> };
  const source = changed.sources.find((candidate) => candidate.moduleId === moduleId);
  if (!source) throw new Error(`missing artifact source ${moduleId}`);
  source.bytes = bytes;
  return changed;
}

async function lockfileWith(
  base: LoadedArtifactInputs,
  replacements: Partial<Record<ArtifactLockRole, { ref: LockedArtifactRef; payload: unknown }>>,
): Promise<{ artifacts: LoadedArtifactInputs; lockfile: ArtifactLockfile }> {
  const artifacts = Object.fromEntries(ARTIFACT_LOCK_ROLES.map((role) => [
    role,
    replacements[role] ?? base[role],
  ])) as unknown as LoadedArtifactInputs;
  const entries = Object.fromEntries(ARTIFACT_LOCK_ROLES.map((role) => [role, artifacts[role].ref])) as unknown as ArtifactLockEntries;
  return { artifacts, lockfile: await createArtifactLockfile(entries) };
}

function snapshotHashes(configHash: string, artifacts: LoadedArtifactInputs): SnapshotHashes {
  return {
    configHash,
    requirementSpecHash: digest("1"),
    factSnapshotHash: digest("2"),
    userObservationSnapshotHash: digest("3"),
    priceSnapshotHash: digest("4"),
    ruleSetHash: artifacts.ruleSet.ref.contentHash,
    systemProfileHash: artifacts.systemProfile.ref.contentHash,
    adapterSnapshotHash: artifacts.adapterSnapshot.ref.contentHash,
    engineHash: artifacts.engine.ref.contentHash,
    simulationModelHash: artifacts.simulationModel.ref.contentHash,
    simulationInputHash: digest("5"),
  };
}

function twoCaseConfig(name: string): BuildConfigV3 {
  const config = createEmptyBuildConfigV3(`draft-${name}`, name, "2026-08-28T00:00:00.000Z");
  config.components = ["case-a", "case-b"].map((instanceId) => ({
    instanceId,
    kind: "case" as const,
    role: instanceId,
    state: "planned" as const,
    identity: {
      status: "resolved" as const,
      skuId: "case.jonsbo-n6",
      identityClaimIds: [`claim-${name}-${instanceId}`],
    },
    source: "user" as const,
  }));
  return config;
}

async function putEnvelopeObservation(
  observations: ReturnType<typeof createWorkspaceRepositories>["observationRepository"],
  config: BuildConfigV3,
  instanceId: string,
  observationId: string,
  value: number,
): Promise<{ observation: UserObservation; context: Awaited<ReturnType<typeof resolveObservationProjectionContext>> }> {
  const subjectRef = { kind: "instance" as const, instanceId };
  const context = await resolveObservationProjectionContext(config.id, config, subjectRef);
  const base = {
    observationId,
    planId: config.id,
    subjectRef,
    fieldId: "case.envelope.width" as const,
    value,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "measurement" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: context.currentConfigHash,
    subjectRevisionHash: context.currentSubjectRevisionHash,
    capturedAt: "2026-08-28T00:01:00.000Z",
    validatedAt: "2026-08-28T00:02:00.000Z",
    status: "active" as const,
  };
  const observation: UserObservation = { ...base, contentHash: await legacySha256Hex(base) };
  await observations.put({ observation });
  return { observation, context };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overridesFrom(snapshot: LoadedExternalSnapshot): CaseInstanceOverrides[] {
  if (!record(snapshot.payload) || !record(snapshot.payload.payload)
    || !Array.isArray(snapshot.payload.payload.caseInstanceOverrides)
    || snapshot.payload.payload.caseInstanceOverrides.some((entry) => !verifyCaseInstanceOverridesRuntime(entry))) {
    throw new Error("simulation input has no valid case instance override closure");
  }
  return structuredClone(snapshot.payload.payload.caseInstanceOverrides);
}

function v3Config(config: BuildConfigDocument): BuildConfigV3 {
  if (config.schemaVersion !== "3.0.0") throw new Error("test requires a topology V3 config");
  return config;
}

async function writeGovernedPrice(coordinator: RuntimeCoordinator, marker: string): Promise<void> {
  const inputHash = createHash("sha256").update(`u5-price-${marker}`).digest("hex");
  const material = {
    schemaVersion: "1.1.0",
    asOf: "2026-08-28",
    snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: "2026-08-28T00:00:00.000Z",
    catalogVersion: "u5-artifact-authority",
    inputHash,
    priceVersion: "price-snapshot-v2",
    quotes: [],
  };
  await coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify({
      ...material,
      contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
    })}\n`, "utf8");
  });
}

async function hydrateExternal(
  coordinator: RuntimeCoordinator,
  repository: EvaluationLockRepository,
  lock: Awaited<ReturnType<typeof createPlanEvaluationLock>>,
) {
  return (await coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) =>
    repository.hydrateExternalInputsAtRoot(activeRoot, lock))).result;
}

describe("U5 production artifact authority", () => {
  it("keeps the generic registry behind a strict flag and closes real manifest/provider/standard bytes", async () => {
    expect(() => createWorkspaceRepositories({ BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "sometimes" }))
      .toThrow(/BUILD_SIM_GENERIC_ADAPTERS_ENABLED must be true or false/);

    const legacy = await runtimeArtifacts(false);
    const legacyAdapter = legacy.artifacts.adapterSnapshot.payload as Record<string, unknown>;
    expect(Object.keys(legacyAdapter).sort()).toEqual(["catalog", "schemaVersion", "sources"]);

    const legacyEvaluator = vi.fn(async (input: import("../src/server/evaluation-service").GovernedEvaluationInput) => ({
      evaluation: createPlanPartialEvaluationV3(v3Config(input.config)),
      catalogVersion: "u5-legacy-rollback",
      priceSnapshotVersion: null,
    }));
    const legacyServices = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: legacy.runtimeRoot,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "false",
    }, {
      evaluator: legacyEvaluator,
      verifyArtifact: async () => true,
      verifyArtifactAtRoot: async () => true,
      verifyExternalSnapshotHashes: async () => true,
      verifyExternalSnapshotHashesAtRoot: async () => true,
    });
    await initializeRuntimeCatalog({ coordinator: legacyServices.coordinator!, generationAware: true });
    await writeGovernedPrice(legacyServices.coordinator!, "legacy-rollback");
    const legacyPlan = await legacyServices.repository.create({
      name: "U5 legacy rollback",
      config: twoCaseConfig("u5-legacy-rollback"),
    });
    await legacyServices.evaluationPipeline!.evaluateCurrent({
      planId: legacyPlan.id,
      target: {
        kind: "draft",
        expectedDraftRevision: legacyPlan.draftRevision,
        expectedConfigHash: await hashPlanConfig(legacyPlan.draft.config),
      },
    });
    await expect(createProductionReferenceGraph({
      coordinator: legacyServices.coordinator!,
      now: () => "2026-08-28T00:00:00.000Z",
    })).resolves.toBeDefined();
    expect((await runDoctor({ coordinator: legacyServices.coordinator! })).report.checks.find((check: { checkId: string }) =>
      check.checkId === "integrity.reference_closure")).toMatchObject({ status: "pass" });
    await expect(createBackup({
      coordinator: legacyServices.coordinator!,
      outputFile: path.join(legacy.runtimeRoot, "legacy-rollback.backup"),
      password: "a sufficiently long legacy rollback password",
    })).resolves.toBeDefined();

    const current = await runtimeArtifacts(true);
    await expect(builtinArtifactInputs(current.activeRoot, current.runtimeRoot, {
      genericAdaptersEnabled: true,
    })).rejects.toThrow(/requires the active runtime generation/);
    const adapter = current.artifacts.adapterSnapshot.payload as CaseAdapterArtifactPayload;
    expect(adapter.caseManifests.map((manifest) => manifest.identity.skuId)).toContain("case.jonsbo-n6");
    expect(adapter.runtimeAdapters).toHaveLength(adapter.caseManifests.length);
    const n6Manifest = adapter.caseManifests.find((manifest) => manifest.identity.skuId === "case.jonsbo-n6")!;
    const n6Runtime = adapter.runtimeAdapters.find((runtime) => runtime.manifestHash === n6Manifest.contentHash)!;
    const n6Model = adapter.runtimeModels.find((model) => model.manifestHash === n6Manifest.contentHash)!;
    expect(n6Runtime).toMatchObject({
      executionStatus: "ready",
      runtimeId: n6Model.runtimeId,
      runtimeVersion: n6Model.runtimeVersion,
      interpreterId: "declarative-case-v1",
      modelHash: n6Model.contentHash,
      partialReason: null,
      interpreterImplementationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(adapter.sources).toContainEqual({
      moduleId: n6Runtime.modelSourceModuleId,
      bytes: caseRuntimeModelCanonicalBytes(n6Model),
    });
    expect(n6Model).toMatchObject({
      authorityStatus: "legacy_unverified",
      authorityRefs: { factIds: [], derivationIds: [], evidenceContentHashes: [] },
    });
    expect(n6Runtime.authorityStatus).toBe("legacy_unverified");
    expect(n6Runtime.implementationModuleIds).toEqual(expect.arrayContaining([
      "adapters/runtime-compiler",
      "adapters/runtime-model-schema",
      "adapters/declarative-case/runtime",
      "core/assembly",
      "wiring/plan",
    ]));
    expect(adapter.capabilityProviderManifests.map((manifest) => manifest.providerId))
      .toContain("buildsim.fact-capability-provider");
    await expect(verifyCaseAdapterSnapshotPayload(adapter)).resolves.toBe(true);
    await expect(verifyWorkspaceStandardSetPayload(current.artifacts.standardSet.payload)).resolves.toBe(true);
    expect((current.artifacts.standardSet.payload as { sources: Array<{ moduleId: string; bytes: string }> }).sources)
      .toContainEqual({ moduleId: "data/standards/hardware-standards.json", bytes: bundledHardwareStandardSeedBytes() });

    const ruleClosure = JSON.parse((current.artifacts.ruleSet.payload as { sources: Array<{ moduleId: string; bytes: string }> })
      .sources.find((source) => source.moduleId === "artifact/standard-set-transitive-closure")!.bytes);
    expect(canonicalize(ruleClosure)).toBe(canonicalize(current.artifacts.standardSet.payload));
    const engineClosure = JSON.parse((current.artifacts.engine.payload as { sources: Array<{ moduleId: string; bytes: string }> })
      .sources.find((source) => source.moduleId === "artifact/evaluation-transitive-closure")!.bytes);
    expect(canonicalize(engineClosure)).toBe(canonicalize({
      ruleSet: current.artifacts.ruleSet.payload,
      standardSet: current.artifacts.standardSet.payload,
      adapterSnapshot: current.artifacts.adapterSnapshot.payload,
    }));
  });

  it("closes receipts over adapter generations, immutable version targets, and the engine transitive tuple", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u5-receipt-generation-"));
    roots.push(runtimeRoot);
    const evaluator = vi.fn(async (input: import("../src/server/evaluation-service").GovernedEvaluationInput) => ({
      evaluation: createPlanPartialEvaluationV3(v3Config(input.config)),
      catalogVersion: "u5-receipt-generation",
      priceSnapshotVersion: null,
    }));
    const services = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: runtimeRoot,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
    }, {
      evaluator,
      verifyArtifact: async () => true,
      verifyArtifactAtRoot: async () => true,
      verifyExternalSnapshotHashes: async () => true,
      verifyExternalSnapshotHashesAtRoot: async () => true,
    });
    const coordinator = services.coordinator!;
    await coordinator.initialize();
    await initializeRuntimeCatalog({ coordinator, generationAware: true });
    await writeGovernedPrice(coordinator, "receipt-generation");
    const created = await services.repository.create({
      name: "U5 receipt generation",
      config: twoCaseConfig("u5-receipt-generation"),
    });
    const draftRequest = async (plan: typeof created) => ({
      planId: plan.id,
      target: {
        kind: "draft" as const,
        expectedDraftRevision: plan.draftRevision,
        expectedConfigHash: await hashPlanConfig(plan.draft.config),
      },
    });
    const initialReceipt = await services.evaluationPipeline!.evaluateCurrent(await draftRequest(created));
    const saved = await services.repository.saveVersion(created.id, {
      expectedRevision: created.draftRevision,
      expectedConfigHash: initialReceipt.configHash,
      reason: "initial",
      evaluationHash: initialReceipt.evaluationHash,
      evaluatedAt: initialReceipt.evaluatedAt,
      evaluationLock: initialReceipt.evaluationLock,
    });
    const cleanBackup = path.join(runtimeRoot, "receipt-generation-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long U5 generation password" });
    await restoreBackup({ coordinator, inputFile: cleanBackup, password: "a sufficiently long U5 generation password" });
    expect((await coordinator.readState()).runtimeGeneration).toBe(2);

    const pinnedReceipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: created.id,
      target: { kind: "version", versionId: saved.id, expectedConfigHash: saved.configHash },
    });
    expect(pinnedReceipt.runtimeGeneration).toBe(2);
    const restoredRoot = coordinator.activeRoot(await coordinator.readState());
    const pinnedArtifacts = await services.evaluationLockRepository.hydrateArtifactInputsAtRoot(
      restoredRoot,
      pinnedReceipt.evaluationLock,
    );
    expect((pinnedArtifacts.adapterSnapshot.payload as CaseAdapterArtifactPayload).runtimeRegistry.activeRuntimeGeneration).toBe(1);
    await expect(createBackup({
      coordinator,
      outputFile: path.join(runtimeRoot, "pinned-old-adapter.backup"),
      password: "a sufficiently long U5 generation password",
    })).resolves.toBeDefined();

    type ReceiptTarget = typeof pinnedReceipt.target;
    const targetKey = (target: ReceiptTarget) => target.kind === "draft"
      ? `draft-${target.draftRevision}` : `version-${target.versionId}`;
    const currentFile = (target: ReceiptTarget) => path.join(
      restoredRoot, "snapshots", "evaluation-current", created.id, `${targetKey(target)}.json`,
    );
    const receiptFile = (target: ReceiptTarget, receiptHash: string) => path.join(
      restoredRoot, "snapshots", "evaluation-receipts", created.id, targetKey(target), `${receiptHash}.json`,
    );
    const expectRejectedReceipt = async (
      receipt: typeof pinnedReceipt,
      message: RegExp,
      marker: string,
    ) => {
      const pointerPath = currentFile(receipt.target);
      const previousPointer = await readFile(pointerPath, "utf8").catch(() => null);
      await services.evaluationLockRepository.commitAtRoot(restoredRoot, receipt);
      const receiptHash = sha256Json(receipt);
      await expect(createBackup({
        coordinator,
        outputFile: path.join(runtimeRoot, `${marker}.backup`),
        password: "a sufficiently long U5 generation password",
      })).rejects.toThrow(message);
      expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) =>
        check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
      await rm(receiptFile(receipt.target, receiptHash));
      if (previousPointer === null) await rm(pointerPath, { force: true });
      else await writeFile(pointerPath, previousPointer, "utf8");
    };

    const generationMismatch = structuredClone(pinnedReceipt);
    generationMismatch.target = { kind: "draft", draftRevision: created.draftRevision };
    await expectRejectedReceipt(
      generationMismatch,
      /draft evaluation receipt does not bind its active adapter generation/,
      "draft-generation-forge",
    );

    const currentArtifacts = await builtinArtifactInputs(restoredRoot, runtimeRoot, {
      genericAdaptersEnabled: true,
      activeRuntimeGeneration: 2,
    });
    const staleEngineClosure = await lockfileWith(pinnedArtifacts, {
      adapterSnapshot: currentArtifacts.adapterSnapshot,
    });
    await services.evaluationLockRepository.putArtifactPayloadAtRoot(restoredRoot, currentArtifacts.adapterSnapshot);
    await services.evaluationLockRepository.putArtifactLockfileAtRoot(restoredRoot, staleEngineClosure.lockfile);
    const staleEngineLock = await createPlanEvaluationLock({
      planId: created.id,
      snapshotHashes: {
        ...pinnedReceipt.evaluationLock.snapshotHashes,
        adapterSnapshotHash: currentArtifacts.adapterSnapshot.ref.contentHash,
      },
      factSnapshotId: pinnedReceipt.evaluationLock.factSnapshotId,
      userObservationSnapshotId: pinnedReceipt.evaluationLock.userObservationSnapshotId,
      artifactLockfileHash: staleEngineClosure.lockfile.lockfileHash,
    });
    await services.evaluationLockRepository.putEvaluationLockAtRoot(restoredRoot, staleEngineLock);
    const staleEngineReceipt = {
      ...structuredClone(pinnedReceipt),
      target: { kind: "draft" as const, draftRevision: created.draftRevision },
      evaluationLock: staleEngineLock,
      evaluationHash: await authoritativeEvaluationHash(pinnedReceipt.evaluation, staleEngineLock),
    };
    await expectRejectedReceipt(
      staleEngineReceipt,
      /engine transitive closure does not bind the locked adapter/,
      "stale-engine-forge",
    );

    const missingRegistryPayload = structuredClone(currentArtifacts.adapterSnapshot.payload) as Record<string, unknown>;
    delete missingRegistryPayload.runtimeRegistry;
    const missingRegistryRef = await relock("adapterSnapshot", missingRegistryPayload, currentArtifacts.adapterSnapshot.ref);
    await services.evaluationLockRepository.putArtifactPayloadAtRoot(restoredRoot, {
      ref: missingRegistryRef,
      payload: missingRegistryPayload,
    });
    await expect(createBackup({
      coordinator,
      outputFile: path.join(runtimeRoot, "missing-generic-discriminator.backup"),
      password: "a sufficiently long U5 generation password",
    })).rejects.toThrow(/workspace case adapter snapshot semantic authority is invalid/);
    await rm(path.join(restoredRoot, "snapshots", "evaluation-artifacts", `${missingRegistryRef.contentHash}.json`));

    const genericPayload = currentArtifacts.adapterSnapshot.payload as CaseAdapterArtifactPayload;
    const downgradedPayload = {
      schemaVersion: genericPayload.schemaVersion,
      catalog: structuredClone(genericPayload.catalog),
      sources: structuredClone(genericPayload.sources),
    };
    const downgradedRef = await relock("adapterSnapshot", downgradedPayload, currentArtifacts.adapterSnapshot.ref);
    const downgradedClosure = await lockfileWith(staleEngineClosure.artifacts, {
      adapterSnapshot: { ref: downgradedRef, payload: downgradedPayload },
    });
    await services.evaluationLockRepository.putArtifactPayloadAtRoot(restoredRoot, {
      ref: downgradedRef,
      payload: downgradedPayload,
    });
    await services.evaluationLockRepository.putArtifactLockfileAtRoot(restoredRoot, downgradedClosure.lockfile);
    const downgradedLock = await createPlanEvaluationLock({
      planId: created.id,
      snapshotHashes: {
        ...pinnedReceipt.evaluationLock.snapshotHashes,
        ruleSetHash: downgradedClosure.lockfile.artifacts.ruleSet.contentHash,
        systemProfileHash: downgradedClosure.lockfile.artifacts.systemProfile.contentHash,
        adapterSnapshotHash: downgradedClosure.lockfile.artifacts.adapterSnapshot.contentHash,
        engineHash: downgradedClosure.lockfile.artifacts.engine.contentHash,
        simulationModelHash: downgradedClosure.lockfile.artifacts.simulationModel.contentHash,
      },
      factSnapshotId: pinnedReceipt.evaluationLock.factSnapshotId,
      userObservationSnapshotId: pinnedReceipt.evaluationLock.userObservationSnapshotId,
      artifactLockfileHash: downgradedClosure.lockfile.lockfileHash,
    });
    await services.evaluationLockRepository.putEvaluationLockAtRoot(restoredRoot, downgradedLock);
    const downgradedReceipt = {
      ...structuredClone(pinnedReceipt),
      target: { kind: "draft" as const, draftRevision: created.draftRevision },
      evaluationLock: downgradedLock,
      evaluationHash: await authoritativeEvaluationHash(pinnedReceipt.evaluation, downgradedLock),
    };
    await expectRejectedReceipt(
      downgradedReceipt,
      /generic adapter semantic authority is invalid/,
      "generic-downgrade-forge",
    );

    const currentPlan = await services.repository.get(created.id);
    const changedConfig = structuredClone(v3Config(currentPlan.draft.config));
    changedConfig.components[0]!.role = "case-a-cross-config";
    const changedPlan = await services.repository.updateDraft(created.id, {
      expectedRevision: currentPlan.draftRevision,
      config: changedConfig,
    });
    const changedReceipt = await services.evaluationPipeline!.evaluateCurrent(await draftRequest(changedPlan));
    const crossConfigReceipt = {
      ...structuredClone(changedReceipt),
      target: { kind: "version" as const, versionId: saved.id },
    };
    await expectRejectedReceipt(
      crossConfigReceipt,
      /version evaluation receipt config does not match its immutable version/,
      "cross-config-version-forge",
    );

    const beforeRejectedRestore = await coordinator.readState();
    await expect(restoreBackup({
      coordinator,
      inputFile: cleanBackup,
      password: "a sufficiently long U5 generation password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        const forged = {
          ...structuredClone(initialReceipt),
          runtimeGeneration: beforeRejectedRestore.runtimeGeneration + 1,
        };
        await services.evaluationLockRepository.commitAtRoot(staging, forged);
      },
    })).rejects.toThrow(/draft evaluation receipt does not bind its active adapter generation/);
    expect(await coordinator.readState()).toEqual(beforeRejectedRestore);
  }, 30_000);

  it("changes ArtifactLockfile, PlanEvaluationLock, and cache identity for real manifest, model, standard, and provider changes", async () => {
    const { artifacts: base } = await runtimeArtifacts(true);
    const adapterPayload = base.adapterSnapshot.payload as CaseAdapterArtifactPayload;
    const baseRegistry = await CaseAdapterRegistry.create(adapterPayload.caseManifests);

    const changedManifest = await createCaseAdapterManifest({
      ...structuredClone(adapterPayload.caseManifests[0]!),
      adapterVersion: "1.0.1",
    });
    const manifestRegistry = await CaseAdapterRegistry.create([changedManifest]);
    const manifestAdapter = await manifestRegistry.createArtifact({
      catalog: adapterPayload.catalog,
      capabilityProviderManifests: adapterPayload.capabilityProviderManifests,
    });

    const changedProviders = structuredClone(adapterPayload.capabilityProviderManifests);
    changedProviders[0] = { ...changedProviders[0]!, providerVersion: "1.0.1" };
    const providerAdapter = await baseRegistry.createArtifact({
      catalog: adapterPayload.catalog,
      capabilityProviderManifests: changedProviders,
    });
    const originalModel = adapterPayload.runtimeModels[0]!;
    const changedModelInput = structuredClone(originalModel) as Omit<typeof originalModel, "contentHash"> & { contentHash?: string };
    delete changedModelInput.contentHash;
    const changedProfile = changedModelInput.documents.profile as Record<string, unknown>;
    const changedPowerProfile = changedProfile.powerProfile as Record<string, unknown>;
    changedPowerProfile.source = `${String(changedPowerProfile.source)} · artifact invalidation fixture`;
    const changedModel = await createCaseRuntimeModel(
      adapterPayload.caseManifests.find((manifest) => manifest.contentHash === originalModel.manifestHash)!,
      changedModelInput,
    );
    const generatedSourceIds = new Set([
      "adapters/manifest-registration.json",
      "capabilities/provider-registration.json",
      "adapters/catalog-registration.json",
      "adapters/runtime-case-adapter-registry.json",
      "adapters/runtime-model-registration.json",
      ...adapterPayload.runtimeAdapters.flatMap((runtime) => runtime.modelSourceModuleId ? [runtime.modelSourceModuleId] : []),
    ]);
    const modelBaselineSources = adapterPayload.sources
      .filter((source) => !generatedSourceIds.has(source.moduleId))
      .map((source) => structuredClone(source));
    const changedModelSources = structuredClone(modelBaselineSources);
    const profileSourceId = originalModel.sourceRefs.find((ref) => ref.endsWith("/profile.json"))!;
    const changedProfileSource = changedModelSources.find((source) => source.moduleId === profileSourceId)!;
    const changedProfileBytes = JSON.parse(changedProfileSource.bytes) as Record<string, unknown>;
    (changedProfileBytes.powerProfile as Record<string, unknown>).source = changedPowerProfile.source;
    changedProfileSource.bytes = JSON.stringify(changedProfileBytes);
    const runtimeRegistrySource = adapterPayload.sources.find((source) =>
      source.moduleId === adapterPayload.runtimeRegistry.sourceModuleId);
    const runtimeRegistryInput = {
      registryRef: adapterPayload.runtimeRegistry.registryRef,
      registryBytes: adapterPayload.runtimeRegistry.registryRef ? runtimeRegistrySource!.bytes : null,
      activeRuntimeGeneration: adapterPayload.runtimeRegistry.activeRuntimeGeneration,
      registrySourceRuntimeGeneration: adapterPayload.runtimeRegistry.registrySourceRuntimeGeneration,
      registryGeneration: adapterPayload.runtimeRegistry.registryGeneration,
      manifests: adapterPayload.caseManifests.filter((manifest) =>
        adapterPayload.runtimeRegistry.manifestHashes.includes(manifest.contentHash)),
    };
    const adapterImplementationModuleIds = adapterPayload.runtimeAdapters.find((runtime) =>
      runtime.executionStatus === "ready")!.implementationModuleIds;
    const capabilityProviderImplementationModuleIds = adapterPayload.capabilityProviderRuntimes[0]!.implementationModuleIds;
    const modelBaselineAdapter = await baseRegistry.createArtifact({
      catalog: adapterPayload.catalog,
      capabilityProviderManifests: adapterPayload.capabilityProviderManifests,
      runtimeModels: adapterPayload.runtimeModels,
      runtimeRegistry: runtimeRegistryInput,
      sources: modelBaselineSources,
      adapterImplementationModuleIds,
      capabilityProviderImplementationModuleIds,
    });
    const emptyRegistryRestoredAtGen2Adapter = await baseRegistry.createArtifact({
      catalog: adapterPayload.catalog,
      capabilityProviderManifests: adapterPayload.capabilityProviderManifests,
      runtimeModels: adapterPayload.runtimeModels,
      runtimeRegistry: {
        ...runtimeRegistryInput,
        activeRuntimeGeneration: 2,
      },
      sources: modelBaselineSources,
      adapterImplementationModuleIds,
      capabilityProviderImplementationModuleIds,
    });
    const modelAdapter = await baseRegistry.createArtifact({
      catalog: adapterPayload.catalog,
      capabilityProviderManifests: adapterPayload.capabilityProviderManifests,
      runtimeModels: adapterPayload.runtimeModels.map((model) => model.contentHash === originalModel.contentHash ? changedModel : model),
      runtimeRegistry: runtimeRegistryInput,
      sources: changedModelSources,
      adapterImplementationModuleIds,
      capabilityProviderImplementationModuleIds,
    });
    const changedInterpreterSources = structuredClone(modelBaselineSources);
    const changedInterpreterSource = changedInterpreterSources.find((source) =>
      source.moduleId === "adapters/declarative-case/runtime")!;
    changedInterpreterSource.bytes = `${changedInterpreterSource.bytes}\n// U5 interpreter invalidation fixture\n`;
    const interpreterAdapter = await baseRegistry.createArtifact({
      catalog: adapterPayload.catalog,
      capabilityProviderManifests: adapterPayload.capabilityProviderManifests,
      runtimeModels: adapterPayload.runtimeModels,
      runtimeRegistry: runtimeRegistryInput,
      sources: changedInterpreterSources,
      adapterImplementationModuleIds,
      capabilityProviderImplementationModuleIds,
    });
    const runtimeRegistryFixture = await createRuntimeCaseAdapterRegistryFixture();
    const collidingRuntimeManifest = await createCaseAdapterManifest({
      ...structuredClone(runtimeRegistryFixture.first.manifests[0]!),
      identity: structuredClone(adapterPayload.caseManifests[0]!.identity),
    });
    await expect(CaseAdapterRegistry.create([
      ...adapterPayload.caseManifests, collidingRuntimeManifest,
    ])).rejects.toThrow(/case adapter already registered/);
    const runtimeCatalog = structuredClone(adapterPayload.catalog);
    runtimeCatalog.skus.push({
      id: runtimeRegistryFixture.first.manifests[0]!.identity.skuId,
      category: "case",
      name: runtimeRegistryFixture.first.manifests[0]!.identity.skuId,
    });
    const createRuntimeRegistryAdapter = async (
      fixture: typeof runtimeRegistryFixture.first,
      activeRuntimeGeneration = fixture.runtimeGeneration,
    ) => (await CaseAdapterRegistry.create([...adapterPayload.caseManifests, ...fixture.manifests])).createArtifact({
      catalog: runtimeCatalog,
      capabilityProviderManifests: adapterPayload.capabilityProviderManifests,
      runtimeModels: adapterPayload.runtimeModels,
      runtimeRegistry: {
        registryRef: fixture.registryRef,
        registryBytes: fixture.registryBytes,
        activeRuntimeGeneration,
        registrySourceRuntimeGeneration: fixture.runtimeGeneration,
        registryGeneration: fixture.registryGeneration,
        manifests: fixture.manifests,
      },
      sources: modelBaselineSources,
      adapterImplementationModuleIds,
      capabilityProviderImplementationModuleIds,
    });
    const runtimeRegistryFirstAdapter = await createRuntimeRegistryAdapter(runtimeRegistryFixture.first);
    const runtimeRegistrySecondAdapter = await createRuntimeRegistryAdapter(runtimeRegistryFixture.second);
    const populatedRegistryRestoredAtGen2Adapter = await createRuntimeRegistryAdapter(
      runtimeRegistryFixture.first,
      2,
    );
    expect(manifestAdapter.snapshotHash).not.toBe(base.adapterSnapshot.ref.contentHash);
    expect(providerAdapter.snapshotHash).not.toBe(base.adapterSnapshot.ref.contentHash);
    expect(modelAdapter.snapshotHash).not.toBe(modelBaselineAdapter.snapshotHash);
    expect(modelAdapter.payload.runtimeModels[0]!.contentHash).not.toBe(originalModel.contentHash);
    expect(interpreterAdapter.snapshotHash).not.toBe(modelBaselineAdapter.snapshotHash);
    expect(interpreterAdapter.payload.runtimeAdapters[0]!.interpreterImplementationHash)
      .not.toBe(modelBaselineAdapter.payload.runtimeAdapters[0]!.interpreterImplementationHash);
    expect(runtimeRegistrySecondAdapter.snapshotHash).not.toBe(runtimeRegistryFirstAdapter.snapshotHash);
    expect(emptyRegistryRestoredAtGen2Adapter.snapshotHash).not.toBe(modelBaselineAdapter.snapshotHash);
    expect(populatedRegistryRestoredAtGen2Adapter.snapshotHash).not.toBe(runtimeRegistryFirstAdapter.snapshotHash);
    expect(emptyRegistryRestoredAtGen2Adapter.payload.runtimeRegistry).toMatchObject({
      activeRuntimeGeneration: 2,
      registrySourceRuntimeGeneration: null,
    });
    expect(populatedRegistryRestoredAtGen2Adapter.payload.runtimeRegistry).toMatchObject({
      registryRef: runtimeRegistryFixture.first.registryRef,
      activeRuntimeGeneration: 2,
      registrySourceRuntimeGeneration: 1,
    });
    expect(runtimeRegistryFirstAdapter.payload.runtimeRegistry).toMatchObject({
      registryRef: runtimeRegistryFixture.first.registryRef,
      registryGeneration: 1,
    });
    expect(runtimeRegistrySecondAdapter.payload.runtimeRegistry).toMatchObject({
      registryRef: runtimeRegistryFixture.second.registryRef,
      registryGeneration: 2,
    });
    expect(runtimeRegistrySecondAdapter.payload.runtimeAdapters.find((runtime) =>
      runtime.manifestHash === runtimeRegistryFixture.second.manifests[0]!.contentHash)).toMatchObject({
      executionStatus: "partial",
      runtimeId: null,
      authorityStatus: null,
      partialReason: "runtime-model-unavailable",
    });

    const standardSeed = JSON.parse(bundledHardwareStandardSeedBytes()) as { libraryVersion: string };
    standardSeed.libraryVersion = `${standardSeed.libraryVersion}.changed`;
    const changedStandardPayload = await createWorkspaceStandardSetPayload(JSON.stringify(standardSeed));
    const changedStandardRef = await relock("standardSet", changedStandardPayload, base.standardSet.ref);
    expect(changedStandardRef.contentHash).not.toBe(base.standardSet.ref.contentHash);

    const manifestEnginePayload = replaceSource(base.engine.payload, "artifact/evaluation-transitive-closure", canonicalize({
      ruleSet: base.ruleSet.payload,
      standardSet: base.standardSet.payload,
      adapterSnapshot: manifestAdapter.payload,
    }));
    const manifestEngineRef = await relock("engine", manifestEnginePayload, base.engine.ref);
    const manifestClosure = await lockfileWith(base, {
      adapterSnapshot: { ref: manifestAdapter.ref, payload: manifestAdapter.payload },
      engine: { ref: manifestEngineRef, payload: manifestEnginePayload },
    });

    const providerEnginePayload = replaceSource(base.engine.payload, "artifact/evaluation-transitive-closure", canonicalize({
      ruleSet: base.ruleSet.payload,
      standardSet: base.standardSet.payload,
      adapterSnapshot: providerAdapter.payload,
    }));
    const providerEngineRef = await relock("engine", providerEnginePayload, base.engine.ref);
    const providerClosure = await lockfileWith(base, {
      adapterSnapshot: { ref: providerAdapter.ref, payload: providerAdapter.payload },
      engine: { ref: providerEngineRef, payload: providerEnginePayload },
    });

    const modelEnginePayload = replaceSource(base.engine.payload, "artifact/evaluation-transitive-closure", canonicalize({
      ruleSet: base.ruleSet.payload,
      standardSet: base.standardSet.payload,
      adapterSnapshot: modelAdapter.payload,
    }));
    const modelEngineRef = await relock("engine", modelEnginePayload, base.engine.ref);
    const modelClosure = await lockfileWith(base, {
      adapterSnapshot: { ref: modelAdapter.ref, payload: modelAdapter.payload },
      engine: { ref: modelEngineRef, payload: modelEnginePayload },
    });

    const interpreterEnginePayload = replaceSource(base.engine.payload, "artifact/evaluation-transitive-closure", canonicalize({
      ruleSet: base.ruleSet.payload,
      standardSet: base.standardSet.payload,
      adapterSnapshot: interpreterAdapter.payload,
    }));
    const interpreterEngineRef = await relock("engine", interpreterEnginePayload, base.engine.ref);
    const interpreterClosure = await lockfileWith(base, {
      adapterSnapshot: { ref: interpreterAdapter.ref, payload: interpreterAdapter.payload },
      engine: { ref: interpreterEngineRef, payload: interpreterEnginePayload },
    });

    const runtimeRegistryClosures = await Promise.all([
      runtimeRegistryFirstAdapter,
      runtimeRegistrySecondAdapter,
      emptyRegistryRestoredAtGen2Adapter,
      populatedRegistryRestoredAtGen2Adapter,
    ].map(async (adapterSnapshot) => {
      const enginePayload = replaceSource(base.engine.payload, "artifact/evaluation-transitive-closure", canonicalize({
        ruleSet: base.ruleSet.payload,
        standardSet: base.standardSet.payload,
        adapterSnapshot: adapterSnapshot.payload,
      }));
      const engineRef = await relock("engine", enginePayload, base.engine.ref);
      return lockfileWith(base, {
        adapterSnapshot: { ref: adapterSnapshot.ref, payload: adapterSnapshot.payload },
        engine: { ref: engineRef, payload: enginePayload },
      });
    }));

    const standardRulePayload = replaceSource(
      base.ruleSet.payload,
      "artifact/standard-set-transitive-closure",
      canonicalize(changedStandardPayload),
    );
    const standardRuleRef = await relock("ruleSet", standardRulePayload, base.ruleSet.ref);
    const standardEnginePayload = replaceSource(base.engine.payload, "artifact/evaluation-transitive-closure", canonicalize({
      ruleSet: standardRulePayload,
      standardSet: changedStandardPayload,
      adapterSnapshot: base.adapterSnapshot.payload,
    }));
    const standardEngineRef = await relock("engine", standardEnginePayload, base.engine.ref);
    const standardClosure = await lockfileWith(base, {
      standardSet: { ref: changedStandardRef, payload: changedStandardPayload },
      ruleSet: { ref: standardRuleRef, payload: standardRulePayload },
      engine: { ref: standardEngineRef, payload: standardEnginePayload },
    });

    const baseClosure = await lockfileWith(base, {});
    for (const changed of [
      manifestClosure, providerClosure, standardClosure, modelClosure, interpreterClosure, ...runtimeRegistryClosures,
    ]) {
      expect(changed.lockfile.lockfileHash).not.toBe(baseClosure.lockfile.lockfileHash);
    }
    expect(standardClosure.artifacts.ruleSet.ref.contentHash).not.toBe(base.ruleSet.ref.contentHash);
    expect(manifestClosure.artifacts.engine.ref.contentHash).not.toBe(base.engine.ref.contentHash);

    const config = createDefaultN6Config("plan-u5-artifact-cache", "2026-08-28T00:00:00.000Z");
    const configHash = await hashPlanConfig(config);
    const createLock = (closure: Awaited<ReturnType<typeof lockfileWith>>) => createPlanEvaluationLock({
      planId: config.id,
      snapshotHashes: snapshotHashes(configHash, closure.artifacts),
      factSnapshotId: "fact-snapshot-u5",
      userObservationSnapshotId: "observation-snapshot-u5",
      artifactLockfileHash: closure.lockfile.lockfileHash,
    });
    const locks = await Promise.all([
      baseClosure, manifestClosure, providerClosure, standardClosure, modelClosure, interpreterClosure,
      ...runtimeRegistryClosures,
    ].map(createLock));
    expect(new Set(locks.map((lock) => lock.contentHash)).size).toBe(locks.length);

    const evaluator = vi.fn((lockedConfig) => ({ config: lockedConfig, findings: [], price: { knownCny: 0, unknownSkuIds: [] } }) as never);
    const cache = new EvaluationCoordinator(evaluator);
    await cache.evaluate({ planId: config.id, planVersionId: null, draftRevision: 0, config, evaluationLock: locks[0]! });
    await cache.evaluate({ planId: config.id, planVersionId: null, draftRevision: 0, config, evaluationLock: structuredClone(locks[0]!) });
    for (const lock of locks.slice(1)) {
      await cache.evaluate({ planId: config.id, planVersionId: null, draftRevision: 0, config, evaluationLock: lock });
    }
    expect(evaluator).toHaveBeenCalledTimes(locks.length);
  });

  it("partitions repository-backed case measurements by plan and instance and replays the pinned simulation input", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-u5-instance-input-"));
    roots.push(runtimeRoot);
    const evaluator = vi.fn(async (input: import("../src/server/evaluation-service").GovernedEvaluationInput) => {
      if (input.config.schemaVersion !== "3.0.0") throw new Error("U5 fixture requires topology V3");
      return {
        evaluation: createPlanPartialEvaluationV3(input.config),
        catalogVersion: "u5-topology-v3",
        priceSnapshotVersion: null,
      };
    });
    const services = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: runtimeRoot,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_USER_OBSERVATIONS_ENABLED: "true",
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
    }, {
      evaluator,
      verifyArtifact: async () => true,
      verifyArtifactAtRoot: async () => true,
      verifyExternalSnapshotHashes: async () => true,
      verifyExternalSnapshotHashesAtRoot: async () => true,
    });
    await services.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await writeGovernedPrice(services.coordinator!, "partition");

    const planA = await services.repository.create({ name: "U5 plan A", config: twoCaseConfig("u5-plan-a") });
    const planB = await services.repository.create({ name: "U5 plan B", config: twoCaseConfig("u5-plan-b") });
    const request = async (plan: typeof planA) => ({
      planId: plan.id,
      target: {
        kind: "draft" as const,
        expectedDraftRevision: plan.draftRevision,
        expectedConfigHash: await hashPlanConfig(plan.draft.config),
      },
    });

    const beforeA = await services.evaluationPipeline!.evaluateCurrent(await request(planA));
    const beforeB = await services.evaluationPipeline!.evaluateCurrent(await request(planB));
    expect(beforeA.cacheStatus).toBe("miss");
    expect(beforeB.cacheStatus).toBe("miss");
    const oldVersion = await services.repository.saveVersion(planA.id, {
      expectedRevision: planA.draftRevision,
      expectedConfigHash: beforeA.configHash,
      reason: "initial",
      evaluationHash: beforeA.evaluationHash,
      evaluatedAt: beforeA.evaluatedAt,
      evaluationLock: beforeA.evaluationLock,
    });
    const beforeAExternal = await hydrateExternal(services.coordinator!, services.evaluationLockRepository, beforeA.evaluationLock);
    const beforeBExternal = await hydrateExternal(services.coordinator!, services.evaluationLockRepository, beforeB.evaluationLock);
    const beforeAOverrides = overridesFrom(beforeAExternal.simulationInput);
    const beforeBOverrides = overridesFrom(beforeBExternal.simulationInput);
    expect(beforeAOverrides.map((entry) => entry.instanceId)).toEqual(["case-a", "case-b"]);
    expect(beforeAOverrides.every((entry) => entry.overrides.length === 0)).toBe(true);

    const currentA = await services.repository.get(planA.id);
    const measured = await putEnvelopeObservation(
      services.observationRepository,
      v3Config(currentA.draft.config),
      "case-a",
      "observation-plan-a-case-a-width",
      247,
    );
    const afterA = await services.evaluationPipeline!.evaluateCurrent(await request(currentA));
    const afterB = await services.evaluationPipeline!.evaluateCurrent(await request(planB));
    expect(afterA.cacheStatus).toBe("miss");
    expect(afterB.cacheStatus).toBe("hit");
    expect(afterA.evaluationLock.contentHash).not.toBe(beforeA.evaluationLock.contentHash);
    expect(afterB.evaluationLock.contentHash).toBe(beforeB.evaluationLock.contentHash);
    expect(afterA.evaluationLock.snapshotHashes.simulationInputHash)
      .not.toBe(beforeA.evaluationLock.snapshotHashes.simulationInputHash);
    expect(afterB.evaluationLock.snapshotHashes.simulationInputHash)
      .toBe(beforeB.evaluationLock.snapshotHashes.simulationInputHash);
    expect(afterA.evaluationLock.snapshotHashes.adapterSnapshotHash)
      .toBe(beforeA.evaluationLock.snapshotHashes.adapterSnapshotHash);
    expect(afterB.evaluationLock.snapshotHashes.adapterSnapshotHash)
      .toBe(beforeB.evaluationLock.snapshotHashes.adapterSnapshotHash);

    const afterAExternal = await hydrateExternal(services.coordinator!, services.evaluationLockRepository, afterA.evaluationLock);
    const afterBExternal = await hydrateExternal(services.coordinator!, services.evaluationLockRepository, afterB.evaluationLock);
    const afterAOverrides = overridesFrom(afterAExternal.simulationInput);
    const afterBOverrides = overridesFrom(afterBExternal.simulationInput);
    const byId = (values: CaseInstanceOverrides[]) => new Map(values.map((entry) => [entry.instanceId, entry]));
    expect(byId(afterAOverrides).get("case-a")?.overrides).toMatchObject([{ value: 247, fieldId: "case.envelope.width" }]);
    expect(byId(afterAOverrides).get("case-a")?.spatialHash).not.toBe(byId(beforeAOverrides).get("case-a")?.spatialHash);
    expect(byId(afterAOverrides).get("case-b")?.contentHash).toBe(byId(beforeAOverrides).get("case-b")?.contentHash);
    expect(afterBOverrides).toEqual(beforeBOverrides);

    const replay = await services.evaluationPipeline!.evaluateCurrent({
      planId: planA.id,
      target: { kind: "version", versionId: oldVersion.id, expectedConfigHash: beforeA.configHash },
    });
    expect(replay.evaluationLock.contentHash).toBe(beforeA.evaluationLock.contentHash);
    const replayExternal = await hydrateExternal(services.coordinator!, services.evaluationLockRepository, replay.evaluationLock);
    expect(replayExternal.simulationInput.ref.contentHash).toBe(beforeAExternal.simulationInput.ref.contentHash);
    expect(overridesFrom(replayExternal.simulationInput)).toEqual(beforeAOverrides);
    expect(evaluator).toHaveBeenCalledTimes(3);

    await services.observationRepository.retract({
      planId: planA.id,
      observationId: measured.observation.observationId,
      expectedHash: await legacySha256Hex(measured.observation),
      replacementObservationId: "observation-plan-a-case-a-width-retracted",
      context: measured.context,
    });
    const afterRetraction = await services.evaluationPipeline!.evaluateCurrent(await request(currentA));
    const afterRetractionExternal = await hydrateExternal(
      services.coordinator!,
      services.evaluationLockRepository,
      afterRetraction.evaluationLock,
    );
    expect(byId(overridesFrom(afterRetractionExternal.simulationInput)).get("case-a")?.overrides).toEqual([]);
    expect(afterRetraction.evaluationLock.snapshotHashes.adapterSnapshotHash)
      .toBe(beforeA.evaluationLock.snapshotHashes.adapterSnapshotHash);

    const currentB = await services.repository.get(planB.id);
    await putEnvelopeObservation(
      services.observationRepository,
      v3Config(currentB.draft.config),
      "case-a",
      "observation-plan-b-case-a-stale",
      249,
    );
    const staleConfig = structuredClone(v3Config(currentB.draft.config));
    staleConfig.components.find((component) => component.instanceId === "case-a")!.role = "case-a-rebound";
    const stalePlan = await services.repository.updateDraft(planB.id, {
      expectedRevision: currentB.draftRevision,
      config: staleConfig,
    });
    const afterStale = await services.evaluationPipeline!.evaluateCurrent(await request(stalePlan));
    const afterStaleExternal = await hydrateExternal(services.coordinator!, services.evaluationLockRepository, afterStale.evaluationLock);
    expect(byId(overridesFrom(afterStaleExternal.simulationInput)).get("case-a")?.overrides).toEqual([]);
    expect(afterStale.evaluationLock.snapshotHashes.adapterSnapshotHash)
      .toBe(beforeB.evaluationLock.snapshotHashes.adapterSnapshotHash);

    const missingManifestArtifacts = (await services.coordinator!.withConsistentSnapshot(async ({ activeRoot, state }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => {
      const base = await builtinArtifactInputs(activeRoot, runtimeRoot, {
        genericAdaptersEnabled: true,
        activeRuntimeGeneration: state.runtimeGeneration,
      });
      const payload = base.adapterSnapshot.payload as CaseAdapterArtifactPayload;
      const unboundManifest = await createCaseAdapterManifest({
        ...structuredClone(payload.caseManifests[0]!),
        adapterId: "adapter.case.fixture-unbound",
        identity: {
          ...structuredClone(payload.caseManifests[0]!.identity),
          skuId: "fixture.case.unbound",
        },
        bundleItems: payload.caseManifests[0]!.bundleItems.map((item) => ({
          ...structuredClone(item),
          ownerSkuId: "fixture.case.unbound",
        })),
      });
      const registry = await CaseAdapterRegistry.create([unboundManifest]);
      const catalog: CaseAdapterArtifactPayload["catalog"] = {
        schemaVersion: "case-adapter-identity-catalog-v1",
        skus: [{ id: "fixture.case.unbound", category: "case", name: "fixture.case.unbound" }],
      };
      const adapterSnapshot = await registry.createArtifact({
        catalog,
        capabilityProviderManifests: payload.capabilityProviderManifests,
      });
      const enginePayload = replaceSource(base.engine.payload, "artifact/evaluation-transitive-closure", canonicalize({
        ruleSet: base.ruleSet.payload,
        standardSet: base.standardSet.payload,
        adapterSnapshot: adapterSnapshot.payload,
      }));
      const engineRef = await relock("engine", enginePayload, base.engine.ref);
      return (await lockfileWith(base, {
        adapterSnapshot: { ref: adapterSnapshot.ref, payload: adapterSnapshot.payload },
        engine: { ref: engineRef, payload: enginePayload },
      })).artifacts;
    })).result;
    const missingManifestSnapshots = createRepositoryBackedEvaluationSnapshotAuthority({
      runtimeRoot,
      facts: services.factRepository,
      observations: services.observationRepository,
      decisions: services.updateDecisionRepository,
      locks: services.evaluationLockRepository,
      genericAdaptersEnabled: true,
      loadArtifactsAtRoot: async () => structuredClone(missingManifestArtifacts),
    });
    const missingManifestPipeline = new AuthoritativeEvaluationSnapshotPipeline({
      runtimeRoot,
      coordinator: services.coordinator!,
      factGraphEnabled: true,
      genericAdaptersEnabled: true,
      targets: {
        readTargetAtRoot: async (activeRoot, planId, target) => {
          if (target.kind !== "draft") throw new Error("missing-manifest fixture accepts drafts only");
          const plan = await services.repository.getAtRoot(activeRoot, planId);
          return {
            planId,
            planVersionId: null,
            draftRevision: plan.draftRevision,
            config: structuredClone(plan.draft.config),
          };
        },
      },
      snapshots: missingManifestSnapshots,
      locks: services.evaluationLockRepository,
      receipts: services.evaluationLockRepository,
      evaluator,
    });
    const missingManifestTarget = await services.repository.get(planA.id);
    await expect(missingManifestPipeline.evaluateCurrent(await request(missingManifestTarget)))
      .rejects.toThrow(/locked case adapter manifest is unavailable for case-a/);
  }, 15_000);

  it("rejects self-hashed forged or unregistered manifests and replays old role bytes without consulting the active catalog", async () => {
    const { runtimeRoot, coordinator, activeRoot, artifacts } = await runtimeArtifacts(true);
    const payload = artifacts.adapterSnapshot.payload as CaseAdapterArtifactPayload;
    const forged = structuredClone(payload) as unknown as { caseManifests: Array<Record<string, unknown>> };
    forged.caseManifests[0]!.callerTrusted = true;
    await relock("adapterSnapshot", forged, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(forged)).resolves.toBe(false);

    const forgedRegistryBytes = structuredClone(payload);
    forgedRegistryBytes.sources.find((source) => source.moduleId === "adapters/runtime-case-adapter-registry.json")!.bytes
      = canonicalize({ domain: "forged-runtime-registry", binding: forgedRegistryBytes.runtimeRegistry });
    // Re-locking the outer payload is not authority: the embedded immutable
    // registry ref/bytes/manifest closure must independently verify.
    const forgedRegistryRef = await relock("adapterSnapshot", forgedRegistryBytes, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(forgedRegistryBytes)).resolves.toBe(false);

    const mismatchedExecutor = structuredClone(payload);
    mismatchedExecutor.runtimeAdapters[0]!.runtimeId = "runtime.case.forged";
    await relock("adapterSnapshot", mismatchedExecutor, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(mismatchedExecutor)).resolves.toBe(false);

    const forgedCatalogAuthority = structuredClone(payload);
    (forgedCatalogAuthority.catalog.skus[0] as unknown as Record<string, unknown>).physicalWidthMm = 999;
    forgedCatalogAuthority.sources.find((source) => source.moduleId === "adapters/catalog-registration.json")!.bytes
      = canonicalize(forgedCatalogAuthority.catalog);
    await relock("adapterSnapshot", forgedCatalogAuthority, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(forgedCatalogAuthority)).resolves.toBe(false);

    const forgedNestedModel = structuredClone(payload);
    const forgedModel = forgedNestedModel.runtimeModels[0]!;
    const forgedRouting = forgedModel.documents.routing as { edges: Array<{ from: string; to: string }> };
    forgedRouting.edges[0]!.to = "waypoint.forged-unregistered";
    forgedModel.contentHash = await caseRuntimeModelContentHash(forgedModel);
    const forgedDescriptor = forgedNestedModel.runtimeAdapters.find((runtime) =>
      runtime.manifestHash === forgedModel.manifestHash)!;
    const oldModelSourceModuleId = forgedDescriptor.modelSourceModuleId!;
    const newModelSourceModuleId = `adapters/runtime-model/${forgedModel.contentHash}.json`;
    forgedDescriptor.modelHash = forgedModel.contentHash;
    forgedDescriptor.modelSourceModuleId = newModelSourceModuleId;
    const storedModelSource = forgedNestedModel.sources.find((source) => source.moduleId === oldModelSourceModuleId)!;
    storedModelSource.moduleId = newModelSourceModuleId;
    storedModelSource.bytes = caseRuntimeModelCanonicalBytes(forgedModel);
    const routingSourceModuleId = forgedModel.sourceRefs.find((ref) => ref.endsWith("/routing.json"))!;
    forgedNestedModel.sources.find((source) => source.moduleId === routingSourceModuleId)!.bytes
      = JSON.stringify(forgedRouting);
    forgedNestedModel.sources.find((source) => source.moduleId === "adapters/runtime-model-registration.json")!.bytes
      = canonicalize(forgedNestedModel.runtimeModels);
    const forgedNestedModelRef = await relock("adapterSnapshot", forgedNestedModel, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(forgedNestedModel)).resolves.toBe(false);

    const smuggledGovernedModel = structuredClone(payload);
    const smuggledModel = smuggledGovernedModel.runtimeModels[0]!;
    smuggledModel.authorityStatus = "governed_fact_derivation_bound";
    smuggledModel.authorityRefs = {
      factIds: ["fact.unrelated-smuggled-authority"],
      derivationIds: [`inference-sha256-${digest("a")}`],
      evidenceContentHashes: [digest("b")],
    };
    smuggledModel.contentHash = await caseRuntimeModelContentHash(smuggledModel);
    const smuggledDescriptor = smuggledGovernedModel.runtimeAdapters.find((runtime) =>
      runtime.manifestHash === smuggledModel.manifestHash)!;
    const oldSmuggledModelSourceId = smuggledDescriptor.modelSourceModuleId!;
    const newSmuggledModelSourceId = `adapters/runtime-model/${smuggledModel.contentHash}.json`;
    smuggledDescriptor.modelHash = smuggledModel.contentHash;
    smuggledDescriptor.modelSourceModuleId = newSmuggledModelSourceId;
    smuggledDescriptor.authorityStatus = "governed_fact_derivation_bound";
    const smuggledModelSource = smuggledGovernedModel.sources.find((source) =>
      source.moduleId === oldSmuggledModelSourceId)!;
    smuggledModelSource.moduleId = newSmuggledModelSourceId;
    smuggledModelSource.bytes = caseRuntimeModelCanonicalBytes(smuggledModel);
    const smuggledSeedSource = smuggledGovernedModel.sources.find((source) =>
      smuggledModel.sourceRefs.includes(source.moduleId) && source.moduleId.endsWith("/runtime-model.json"))!;
    const smuggledSeed = JSON.parse(smuggledSeedSource.bytes) as Record<string, unknown>;
    smuggledSeed.authorityStatus = smuggledModel.authorityStatus;
    smuggledSeed.authorityRefs = structuredClone(smuggledModel.authorityRefs);
    smuggledSeedSource.bytes = JSON.stringify(smuggledSeed);
    smuggledGovernedModel.sources.find((source) => source.moduleId === "adapters/runtime-model-registration.json")!.bytes
      = canonicalize(smuggledGovernedModel.runtimeModels);
    await relock("adapterSnapshot", smuggledGovernedModel, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(smuggledGovernedModel)).resolves.toBe(false);

    const missingLockedModel = structuredClone(payload);
    const removedModel = missingLockedModel.runtimeModels.shift()!;
    missingLockedModel.sources = missingLockedModel.sources.filter((source) =>
      source.moduleId !== missingLockedModel.runtimeAdapters[0]!.modelSourceModuleId);
    missingLockedModel.sources.find((source) => source.moduleId === "adapters/runtime-model-registration.json")!.bytes
      = canonicalize(missingLockedModel.runtimeModels);
    expect(missingLockedModel.runtimeAdapters.some((runtime) => runtime.modelHash === removedModel.contentHash)).toBe(true);
    await relock("adapterSnapshot", missingLockedModel, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(missingLockedModel)).resolves.toBe(false);

    const unknown = await createCaseAdapterManifest({
      ...structuredClone(payload.caseManifests[0]!),
      adapterId: "adapter.case.unregistered",
      adapterVersion: "9.9.9",
    });
    const unregistered = structuredClone(payload);
    unregistered.caseManifests.push(unknown);
    await relock("adapterSnapshot", unregistered, artifacts.adapterSnapshot.ref);
    await expect(verifyCaseAdapterSnapshotPayload(unregistered)).resolves.toBe(false);

    const repository = new EvaluationLockRepository({
      coordinator,
      runtimeRoot,
      facts: { getSnapshot: async () => { throw new Error("not used"); } },
      observations: { getSnapshot: async () => { throw new Error("not used"); } },
      verifyArtifact: () => false,
      verifyArtifactAtRoot: () => false,
      verifyExternalSnapshotHashes: () => false,
      verifyExternalSnapshotHashesAtRoot: () => false,
    });
    await coordinator.withWrite(async ({ activeRoot: writeRoot }: { activeRoot: string }) => {
      await repository.putArtifactPayloadAtRoot(writeRoot, {
        ref: forgedNestedModelRef,
        payload: forgedNestedModel,
      });
    });
    const poisonedArtifactFile = path.join(
      activeRoot,
      "snapshots",
      "evaluation-artifacts",
      `${forgedNestedModelRef.contentHash}.json`,
    );
    await expect(createBackup({
      coordinator,
      outputFile: path.join(runtimeRoot, "forged-adapter.backup"),
      password: "a sufficiently long U5 fixture password",
    })).rejects.toThrow(/workspace case (?:runtime model|adapter snapshot) semantic/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) =>
      check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
    await rm(poisonedArtifactFile);
    await coordinator.withWrite(async ({ activeRoot: writeRoot }: { activeRoot: string }) => {
      await repository.putArtifactPayloadAtRoot(writeRoot, {
        ref: forgedRegistryRef,
        payload: forgedRegistryBytes,
      });
    });
    const poisonedRegistryArtifactFile = path.join(
      activeRoot,
      "snapshots",
      "evaluation-artifacts",
      `${forgedRegistryRef.contentHash}.json`,
    );
    await expect(createBackup({
      coordinator,
      outputFile: path.join(runtimeRoot, "forged-registry.backup"),
      password: "a sufficiently long U5 fixture password",
    })).rejects.toThrow(/workspace (?:runtime case adapter registry|case adapter snapshot) semantic/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) =>
      check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
    await rm(poisonedRegistryArtifactFile);

    const closure = await lockfileWith(artifacts, {});
    const config = createDefaultN6Config("plan-u5-replay", "2026-08-28T00:00:00.000Z");
    const lock = await createPlanEvaluationLock({
      planId: config.id,
      snapshotHashes: snapshotHashes(await hashPlanConfig(config), artifacts),
      factSnapshotId: "fact-snapshot-u5-replay",
      userObservationSnapshotId: "observation-snapshot-u5-replay",
      artifactLockfileHash: closure.lockfile.lockfileHash,
    });
    await coordinator.withWrite(async ({ activeRoot: writeRoot }: { activeRoot: string }) => {
      for (const role of ARTIFACT_LOCK_ROLES) await repository.putArtifactPayloadAtRoot(writeRoot, artifacts[role]);
      await repository.putArtifactLockfileAtRoot(writeRoot, closure.lockfile);
    });

    const cleanBackup = path.join(runtimeRoot, "clean-adapter-authority.backup");
    await createBackup({
      coordinator,
      outputFile: cleanBackup,
      password: "a sufficiently long U5 fixture password",
    });
    const forgedEncryptedBackup = path.join(runtimeRoot, "forged-encrypted-adapter-authority.backup");
    const forgedEncryptedPayload = {
      ref: forgedNestedModelRef,
      payload: forgedNestedModel,
    };
    await appendJsonAuthorityToEncryptedBackup({
      inputFile: cleanBackup,
      outputFile: forgedEncryptedBackup,
      password: "a sufficiently long U5 fixture password",
      logicalPath: `snapshots/evaluation-artifacts/${forgedNestedModelRef.contentHash}.json`,
      templateLogicalPath: `snapshots/evaluation-artifacts/${artifacts.adapterSnapshot.ref.contentHash}.json`,
      value: {
        schemaVersion: "evaluation-lock-envelope-v1",
        kind: "evaluation-artifact",
        checksum: sha256Json(forgedEncryptedPayload),
        payload: forgedEncryptedPayload,
      },
    });
    await expect(verifyBackup({
      inputFile: forgedEncryptedBackup,
      password: "a sufficiently long U5 fixture password",
    })).rejects.toThrow(/workspace case (?:runtime model|adapter snapshot) semantic/);
    const beforeForgedRestore = await coordinator.readState();
    await expect(restoreBackup({
      coordinator,
      inputFile: cleanBackup,
      password: "a sufficiently long U5 fixture password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        await repository.putArtifactPayloadAtRoot(staging, {
          ref: forgedNestedModelRef,
          payload: forgedNestedModel,
        });
      },
    })).rejects.toThrow(/workspace case (?:runtime model|adapter snapshot) semantic/);
    expect(await coordinator.readState()).toEqual(beforeForgedRestore);

    const replayed = await repository.hydrateArtifactInputsAtRoot(activeRoot, lock);
    expect(replayed.adapterSnapshot.ref.contentHash).toBe(artifacts.adapterSnapshot.ref.contentHash);
    const productionAuthority = createRepositoryBackedEvaluationSnapshotAuthority({
      runtimeRoot,
      facts: {} as never,
      observations: {} as never,
      decisions: {} as never,
      locks: repository,
      genericAdaptersEnabled: true,
    });
    const replayedThroughProductionAuthority = await productionAuthority.loadArtifactsAtRoot(activeRoot, {
      planId: config.id,
      planVersionId: "version-u5-replay",
      draftRevision: 0,
      config,
      pinnedEvaluationLock: lock,
    }, 1);
    expect(replayedThroughProductionAuthority.adapterSnapshot.ref.contentHash)
      .toBe(artifacts.adapterSnapshot.ref.contentHash);
    const missingRole: ArtifactLockRole = "engine";
    const missingFile = path.join(activeRoot, "snapshots", "evaluation-artifacts", `${artifacts[missingRole].ref.contentHash}.json`);
    await rename(missingFile, `${missingFile}.missing`);
    await expect(repository.hydrateArtifactInputsAtRoot(activeRoot, lock)).rejects.toMatchObject({
      code: "non_replayable",
      missingRoles: [missingRole],
    } satisfies Partial<EvaluationReplayUnavailableError>);
  });
});
