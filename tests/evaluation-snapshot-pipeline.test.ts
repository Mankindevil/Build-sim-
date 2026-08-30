import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_LOCK_ROLES,
  createContentAddressedRef,
  createLockedArtifactRef,
  hashContent,
  type ArtifactPayload,
  type ArtifactLockRole,
  type ContentAddressedRef,
  type SnapshotHashes,
} from "../src/hash";
import { createFactSnapshot } from "../src/facts/snapshots";
import type { FactSnapshot } from "../src/facts/contracts";
import type { UserObservationSnapshot } from "../src/observations/contracts";
import type { RequirementSpec } from "../src/requirements/contracts";
import type { PriceSnapshotFile } from "../src/price/types";
import type { SourcedSimulationInput } from "../src/simulation/contracts";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { hashPlanConfig } from "../src/plans/canonical";
import { PLAN_SCHEMA_VERSION, type PlanEvaluationLock, type PlanEvaluationSnapshot } from "../src/plans/contracts";
import { EvaluationLockRepository } from "../src/plans/evaluation-lock-repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { handleAgentRoute } from "../src/server/agent-server";
import {
  builtinGovernedEvaluator,
  createRepositoryBackedEvaluationSnapshotAuthority,
  createWorkspaceServer,
} from "../src/server/workspace-server";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import {
  AuthoritativeEvaluationSnapshotPipeline,
  factUpdateSnapshotReceipt,
  sha256AgentValue,
  type AuthoritativeEvaluationSnapshotPipelineOptions,
  type EvaluationSnapshotAuthority,
  type EvaluationTargetAuthority,
  type LoadedArtifactInputs,
  type LoadedExternalEvaluationInputs,
} from "../src/server/evaluation-service";

const roots: string[] = [];
const digest = (letter: string): string => letter.repeat(64);
const now = "2026-08-28T03:00:00.000Z";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function observationSnapshot(
  planId: string,
  marker: string,
  observationRecordHashes: Record<string, string> = {},
): Promise<UserObservationSnapshot> {
  const material = {
    schemaVersion: "user-observation-snapshot-v1" as const,
    snapshotId: `snapshot-${marker}`,
    planId,
    observationIds: Object.keys(observationRecordHashes).sort(),
    observationRecordHashes,
    createdAt: now,
  };
  return {
    ...material,
    contentHash: await hashContent(material, { domain: "user-observation-snapshot", schemaVersion: "user-observation-snapshot-v1" }),
  };
}

function externalKey(hashes: SnapshotHashes): string {
  return [hashes.configHash, hashes.requirementSpecHash, hashes.priceSnapshotHash, hashes.simulationInputHash].join(":");
}

async function artifactSnapshot(artifactId: string, mediaType: string, payload: unknown): Promise<{ ref: ContentAddressedRef; payload: ArtifactPayload }> {
  const candidate = {
    schemaVersion: "artifact-payload-v1" as const,
    artifactId,
    mediaType,
    payload,
    contentHash: digest("0"),
  };
  const contentHash = await hashContent(candidate, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  const artifact = { ...candidate, contentHash } as ArtifactPayload;
  return {
    ref: await createContentAddressedRef(artifact, { domain: "artifact", schemaVersion: "artifact-payload-v1" }),
    payload: artifact,
  };
}

function governedPriceSnapshot(version: number): PriceSnapshotFile {
  const inputHash = createHash("sha256").update(`price-input-${version}`).digest("hex");
  const material = {
    schemaVersion: "1.1.0" as const,
    asOf: "2026-08-28",
    note: `fixture-${version}`,
    snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: now,
    catalogVersion: `catalog-${version}`,
    inputHash,
    priceVersion: "price-snapshot-v2",
    quotes: [],
  };
  return { ...material, contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
}

function sourcedSimulationInput(version: number): SourcedSimulationInput {
  const input = {
    workloadMetricRefs: [],
    ambientC: { min: 20, max: 30 },
    fanPolicyId: `fan-policy-${version}`,
    storageActivity: [],
    placementIds: [],
    routeIds: [],
    modelVersion: `model-${version}`,
  };
  const paths = [
    "/workloadMetricRefs", "/ambientC/min", "/ambientC/max", "/fanPolicyId", "/storageActivity",
    "/placementIds", "/routeIds", "/modelVersion",
  ];
  return {
    input,
    sources: paths.map((fieldPath) => ({
      fieldPath,
      source: "system_profile_default" as const,
      userOverridable: true as const,
      sourceRef: `system-profile-${version}`,
    })),
  };
}

async function fixture() {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-evaluation-pipeline-"));
  roots.push(runtimeRoot);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => now });
  await coordinator.initialize();
  let config = createDefaultN6Config("plan-pipeline", now);
  let draftRevision = 0;
  let currentFactSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2", factRefs: [], conflictRefs: [], createdAt: now,
  });
  let candidateFactSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2", factRefs: [], conflictRefs: [], createdAt: "2026-08-28T03:00:01.000Z",
  });
  let currentObservationSnapshot = await observationSnapshot("plan-pipeline", "a");
  const factSnapshots = new Map([
    [currentFactSnapshot.snapshotId, currentFactSnapshot],
    [candidateFactSnapshot.snapshotId, candidateFactSnapshot],
  ]);
  const observationSnapshots = new Map([[currentObservationSnapshot.snapshotId, currentObservationSnapshot]]);
  const artifactVersions = Object.fromEntries(ARTIFACT_LOCK_ROLES.map((role) => [role, 1])) as Record<ArtifactLockRole, number>;
  const externalVersions = { requirementSpec: 1, priceSnapshot: 1, simulationInput: 1 };
  const artifactRefs = new Set<string>();
  const externalClosures = new Set<string>();
  const activeRoots = new Set<string>();
  let externalAttack: "none" | "forged" | "swapped" | "semantic" = "none";
  let artifactDomainAttack = false;
  let artifactSemanticAttack = false;
  let danglingFactClosure = false;
  let observationAttack: "none" | "proposed" | "retracted" | "invalidated" | "stale" | "attachment" = "none";
  let observationRepositoryClosureValid = true;
  let candidateAuthorized = true;
  let pinnedVersionLock: PlanEvaluationLock | undefined;
  let evaluatorHook: (() => Promise<void>) | undefined;
  let evaluatorCalls = 0;

  const targetAuthority: EvaluationTargetAuthority = {
    readTargetAtRoot: async (activeRoot, planId, target) => {
      activeRoots.add(activeRoot);
      return {
        planId,
        planVersionId: target.kind === "version" ? target.versionId : null,
        draftRevision,
        config: structuredClone(config),
        ...(target.kind === "version" && pinnedVersionLock
          ? { pinnedEvaluationLock: structuredClone(pinnedVersionLock) }
          : {}),
      };
    },
  };

  async function loadedArtifacts(): Promise<LoadedArtifactInputs> {
    const entries = await Promise.all(ARTIFACT_LOCK_ROLES.map(async (role) => {
      const kebabRole = role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const payloadSchema = role === "ruleSet" ? "workspace-rule-set-v1"
        : role === "standardSet" ? "workspace-standard-set-v1"
          : role === "systemProfile" ? "workspace-system-profile-v1"
            : role === "adapterSnapshot" ? "workspace-adapter-snapshot-v1"
              : role === "engine" ? "workspace-engine-v1"
                : "workspace-simulation-model-binding-v1";
      const sources = artifactSemanticAttack && role === "ruleSet" ? [] : [{ moduleId: `${role}-fixture`, bytes: `${role}-v${artifactVersions[role]}` }];
      const payload = role === "ruleSet"
        ? { schemaVersion: payloadSchema, ruleIds: [`rule-v${artifactVersions[role]}`], sources }
        : role === "standardSet"
          ? { schemaVersion: payloadSchema, standardIds: [`standard-v${artifactVersions[role]}`], sources }
          : role === "systemProfile"
            ? { schemaVersion: payloadSchema, profileId: `profile-v${artifactVersions[role]}`, supportedPlanSchemas: ["2.0.0", "3.0.0"], sources }
            : role === "adapterSnapshot"
              ? { schemaVersion: payloadSchema, catalog: { schemaVersion: "2.0.0", updatedAt: now, skus: [] }, sources }
              : role === "engine"
                ? { schemaVersion: payloadSchema, engineId: "fixture-engine", engineVersion: String(artifactVersions[role]), sources }
                : { schemaVersion: payloadSchema, modelId: "fixture-model", modelVersion: String(artifactVersions[role]), claims: "unknown", sources };
      const ref = await createLockedArtifactRef(payload, role, `${role}-v${artifactVersions[role]}`, `application/vnd.buildsim.${kebabRole}+json`, {
        domain: artifactDomainAttack && role === "ruleSet" ? "artifact.standard-set" : `artifact.${kebabRole}`,
        schemaVersion: "1.0.0",
      });
      artifactRefs.add(ref.ref);
      return [role, { ref, payload }] as const;
    }));
    return Object.fromEntries(entries) as unknown as LoadedArtifactInputs;
  }

  async function externalInputs(targetConfig: typeof config): Promise<LoadedExternalEvaluationInputs> {
    const requirementSpec: RequirementSpec = {
      requirementSpecId: `requirement-spec-${externalVersions.requirementSpec}`,
      schemaVersion: "1.0.0",
      workloads: [],
      constraints: [],
    };
    const result: LoadedExternalEvaluationInputs = {
      requirementSpec: {
        ref: await createContentAddressedRef(requirementSpec, { domain: "requirement-spec", schemaVersion: "1.0.0" }),
        payload: requirementSpec,
      },
      priceSnapshot: await artifactSnapshot(
        `price-snapshot-${externalVersions.priceSnapshot}`,
        "application/vnd.buildsim.price-snapshot+json",
        governedPriceSnapshot(externalVersions.priceSnapshot),
      ),
      simulationInput: await artifactSnapshot(
        `simulation-input-${externalVersions.simulationInput}`,
        "application/vnd.buildsim.sourced-simulation-input+json",
        sourcedSimulationInput(externalVersions.simulationInput),
      ),
    };
    if (externalAttack === "forged") {
      result.priceSnapshot = {
        ...result.priceSnapshot,
        payload: { ...(result.priceSnapshot.payload as ArtifactPayload), artifactId: "forged" },
      };
    } else if (externalAttack === "swapped") {
      [result.priceSnapshot, result.simulationInput] = [result.simulationInput, result.priceSnapshot];
    } else if (externalAttack === "semantic") {
      result.priceSnapshot = await artifactSnapshot(
        "self-hashed-invalid-price",
        "application/vnd.buildsim.price-snapshot+json",
        { schemaVersion: "1.1.0", quotes: [{ priceCny: -1 }] },
      );
    }
    externalClosures.add([
      await hashPlanConfig(targetConfig), result.requirementSpec.ref.contentHash,
      result.priceSnapshot.ref.contentHash, result.simulationInput.ref.contentHash,
    ].join(":"));
    return result;
  }

  const snapshotAuthority: EvaluationSnapshotAuthority = {
    resolveFactSnapshotAtRoot: async (activeRoot) => {
      activeRoots.add(activeRoot);
      if (danglingFactClosure) {
        const snapshot = await createFactSnapshot({
          schemaVersion: "fact-snapshot-v2",
          factRefs: [{ factId: "fact-dangling", contentHash: digest("a") }],
          conflictRefs: [], createdAt: now,
        });
        factSnapshots.set(snapshot.snapshotId, snapshot);
        return { snapshot, facts: [], conflicts: [], decisions: [] };
      }
      return { snapshot: structuredClone(currentFactSnapshot), facts: [], conflicts: [], decisions: [] };
    },
    resolveObservationSnapshotAtRoot: async (activeRoot, target) => {
      activeRoots.add(activeRoot);
      if (observationAttack !== "none") {
        const configHash = await hashPlanConfig(target.config);
        const base = {
          observationId: `observation-${observationAttack}`,
          planId: "plan-pipeline",
          subjectRef: { kind: "plan" as const },
          fieldId: "boot.result" as const,
          value: "passed",
          method: "user_assertion" as const,
          attachmentRefs: [] as string[],
          confirmedByUser: observationAttack !== "proposed",
          observedAgainstConfigHash: configHash,
          subjectRevisionHash: digest("b"),
          capturedAt: now,
          ...(observationAttack !== "proposed" ? { validatedAt: now } : {}),
          ...(observationAttack === "invalidated" ? { invalidatedAt: now, invalidationReason: "invalidated fixture" } : {}),
          status: observationAttack === "proposed" ? "proposed" as const
            : observationAttack === "retracted" ? "retracted" as const : "active" as const,
        };
        const observation = { ...base, contentHash: sha256AgentValue(base) };
        const recordHash = sha256AgentValue(observation);
        const snapshot = await observationSnapshot("plan-pipeline", observationAttack, { [observation.observationId]: recordHash });
        return {
          snapshot,
          observations: [{
            observation,
            recordHash,
            projectionContext: {
              planId: "plan-pipeline",
              subjectExists: true,
              currentConfigHash: configHash,
              currentSubjectRevisionHash: observationAttack === "stale" ? digest("c") : digest("b"),
            },
            attachmentClosureVerified: (observationAttack !== "attachment") as true,
          }],
        };
      }
      return { snapshot: structuredClone(currentObservationSnapshot), observations: [] };
    },
    loadArtifactsAtRoot: async (activeRoot) => {
      activeRoots.add(activeRoot);
      return loadedArtifacts();
    },
    loadExternalInputsAtRoot: async (activeRoot, target) => {
      activeRoots.add(activeRoot);
      return externalInputs(target.config as typeof config);
    },
  };

  const locks = new EvaluationLockRepository({
    coordinator, runtimeRoot,
    facts: {
      getSnapshot: async (id) => {
        const snapshot = factSnapshots.get(id);
        if (!snapshot) throw Object.assign(new Error("missing"), { code: "not_found" });
        return structuredClone(snapshot);
      },
      getSnapshotAtRoot: async (activeRoot, id) => {
        activeRoots.add(activeRoot);
        return structuredClone(factSnapshots.get(id) ?? null);
      },
    },
    observations: {
      getSnapshot: async (_planId, id) => {
        const snapshot = observationSnapshots.get(id);
        if (!snapshot) throw Object.assign(new Error("missing"), { code: "not_found" });
        return structuredClone(snapshot);
      },
      getSnapshotAtRoot: async (activeRoot, _planId, id) => {
        activeRoots.add(activeRoot);
        return structuredClone(observationSnapshots.get(id) ?? null);
      },
    },
    verifyFactSnapshotClosureAtRoot: async () => !danglingFactClosure,
    verifyObservationSnapshotClosureAtRoot: async () => observationRepositoryClosureValid,
    verifyArtifact: (ref) => artifactRefs.has(ref.ref),
    verifyArtifactAtRoot: (activeRoot, ref) => { activeRoots.add(activeRoot); return artifactRefs.has(ref.ref); },
    verifyExternalSnapshotHashes: (hashes) => externalClosures.has(externalKey(hashes)),
    verifyExternalSnapshotHashesAtRoot: (activeRoot, hashes) => { activeRoots.add(activeRoot); return externalClosures.has(externalKey(hashes)); },
  });

  const options: AuthoritativeEvaluationSnapshotPipelineOptions = {
    runtimeRoot, coordinator, factGraphEnabled: true,
    targets: targetAuthority, snapshots: snapshotAuthority, locks, receipts: locks,
    factCandidates: {
      resolveAtRoot: async (activeRoot, input) => {
        activeRoots.add(activeRoot);
        if (!candidateAuthorized || input.updateNoticeId !== "notice-pipeline") throw new Error("candidate notice is no longer authorized");
        const snapshot = input.phase === "before" ? currentFactSnapshot : candidateFactSnapshot;
        return { snapshot: structuredClone(snapshot), facts: [], conflicts: [], decisions: [] };
      },
    },
    evaluator: async (input) => {
      evaluatorCalls += 1;
      expect(input.evaluationLock.snapshotHashes).toEqual(input.snapshotHashes);
      expect(input.factClosure.snapshot.contentHash).toBe(input.snapshotHashes.factSnapshotHash);
      expect(input.observationClosure.snapshot.contentHash).toBe(input.snapshotHashes.userObservationSnapshotHash);
      await evaluatorHook?.();
      return {
        evaluation: { config: structuredClone(input.config), findings: [], price: { knownCny: 0, unknownSkuIds: [] } } as never,
        catalogVersion: "catalog-test-v1",
        priceSnapshotVersion: "price-test-v1",
      };
    },
    now: () => now,
  };
  const pipeline = new AuthoritativeEvaluationSnapshotPipeline(options);

  return {
    runtimeRoot, coordinator, locks, options, pipeline, activeRoots,
    request: async () => ({
      planId: "plan-pipeline",
      target: { kind: "draft" as const, expectedDraftRevision: draftRevision, expectedConfigHash: await hashPlanConfig(config) },
    }),
    evaluatorCalls: () => evaluatorCalls,
    setArtifactVersion: (role: ArtifactLockRole, version: number) => { artifactVersions[role] = version; },
    setExternalVersion: (field: keyof typeof externalVersions, version: number) => { externalVersions[field] = version; },
    setFactSnapshot: async (marker: string) => {
      currentFactSnapshot = await createFactSnapshot({ schemaVersion: "fact-snapshot-v2", factRefs: [], conflictRefs: [], createdAt: `2026-08-28T03:00:0${marker}.000Z` });
      factSnapshots.set(currentFactSnapshot.snapshotId, currentFactSnapshot);
    },
    setObservationSnapshot: async (marker: string) => {
      currentObservationSnapshot = await observationSnapshot("plan-pipeline", marker);
      observationSnapshots.set(currentObservationSnapshot.snapshotId, currentObservationSnapshot);
    },
    changeConfig: () => { config = { ...config, name: `${config.name}-changed` }; draftRevision += 1; },
    setExternalAttack: (value: typeof externalAttack) => { externalAttack = value; },
    setArtifactDomainAttack: (value: boolean) => { artifactDomainAttack = value; },
    setArtifactSemanticAttack: (value: boolean) => { artifactSemanticAttack = value; },
    setDanglingFact: (value: boolean) => { danglingFactClosure = value; },
    setObservationAttack: (value: typeof observationAttack) => { observationAttack = value; },
    setObservationRepositoryClosureValid: (value: boolean) => { observationRepositoryClosureValid = value; },
    setCandidateAuthorized: (value: boolean) => { candidateAuthorized = value; },
    setPinnedVersionLock: (lock: PlanEvaluationLock | undefined) => { pinnedVersionLock = lock && structuredClone(lock); },
    setCandidateSnapshot: async (marker: string) => {
      candidateFactSnapshot = await createFactSnapshot({
        schemaVersion: "fact-snapshot-v2", factRefs: [], conflictRefs: [], createdAt: `2026-08-28T03:00:0${marker}.000Z`,
      });
      factSnapshots.set(candidateFactSnapshot.snapshotId, candidateFactSnapshot);
    },
    acceptCandidate: () => { currentFactSnapshot = candidateFactSnapshot; },
    setEvaluatorHook: (hook: (() => Promise<void>) | undefined) => { evaluatorHook = hook; },
  };
}

function snapshotFromReceipt(receipt: Awaited<ReturnType<AuthoritativeEvaluationSnapshotPipeline["evaluateCurrent"]>>): PlanEvaluationSnapshot {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: receipt.planId,
    planVersionId: receipt.target.kind === "version" ? receipt.target.versionId : null,
    draftRevision: receipt.target.kind === "draft" ? receipt.target.draftRevision : 0,
    configHash: receipt.configHash,
    evaluationHash: receipt.evaluationHash,
    evaluationLock: receipt.evaluationLock,
    evaluatedAt: receipt.evaluatedAt,
    evaluation: receipt.evaluation,
  };
}

describe("U3 authoritative evaluation snapshot pipeline", () => {
  it("resolves every hash server-side, consumes the exact closure, and misses on every snapshot/artifact change", async () => {
    const context = await fixture();
    const first = await context.pipeline.evaluateCurrent(await context.request());
    expect(first.cacheStatus).toBe("miss");
    const second = await context.pipeline.evaluateCurrent(await context.request());
    expect(second.cacheStatus).toBe("hit");
    expect(second.evaluationHash).toBe(first.evaluationHash);
    expect(context.evaluatorCalls()).toBe(1);

    let version = 2;
    let previousEvaluationHash = second.evaluationHash;
    for (const role of ARTIFACT_LOCK_ROLES) {
      context.setArtifactVersion(role, version++);
      const changed = await context.pipeline.evaluateCurrent(await context.request());
      expect(changed.cacheStatus).toBe("miss");
      expect(changed.evaluationHash).not.toBe(previousEvaluationHash);
      previousEvaluationHash = changed.evaluationHash;
    }
    for (const field of ["requirementSpec", "priceSnapshot", "simulationInput"] as const) {
      context.setExternalVersion(field, version++);
      const changed = await context.pipeline.evaluateCurrent(await context.request());
      expect(changed.cacheStatus).toBe("miss");
      expect(changed.evaluationHash).not.toBe(previousEvaluationHash);
      previousEvaluationHash = changed.evaluationHash;
    }
    await context.setFactSnapshot("1");
    const factChanged = await context.pipeline.evaluateCurrent(await context.request());
    expect(factChanged).toMatchObject({ cacheStatus: "miss" });
    expect(factChanged.evaluationHash).not.toBe(previousEvaluationHash);
    previousEvaluationHash = factChanged.evaluationHash;
    await context.setObservationSnapshot("b");
    const observationChanged = await context.pipeline.evaluateCurrent(await context.request());
    expect(observationChanged).toMatchObject({ cacheStatus: "miss" });
    expect(observationChanged.evaluationHash).not.toBe(previousEvaluationHash);
    previousEvaluationHash = observationChanged.evaluationHash;
    context.changeConfig();
    const configChanged = await context.pipeline.evaluateCurrent(await context.request());
    expect(configChanged).toMatchObject({ cacheStatus: "miss" });
    expect(configChanged.evaluationHash).not.toBe(previousEvaluationHash);
    expect(context.activeRoots.size).toBe(1);
  });

  it("rejects caller hashes/locks, forged external payloads, dangling facts, and missing authorities", async () => {
    const context = await fixture();
    const request = await context.request();
    await expect(context.pipeline.evaluateCurrent({ ...request, evaluationLock: { contentHash: digest("a") } })).rejects.toThrow(/exactly planId and target/);
    context.setExternalAttack("forged");
    await expect(context.pipeline.evaluateCurrent(request)).rejects.toThrow(/external priceSnapshot snapshot payload\/ref invalid/);
    context.setExternalAttack("swapped");
    await expect(context.pipeline.evaluateCurrent(request)).rejects.toThrow(/external priceSnapshot artifact role binding invalid/);
    context.setExternalAttack("semantic");
    await expect(context.pipeline.evaluateCurrent(request)).rejects.toThrow(/external priceSnapshot semantic payload invalid/);
    context.setExternalAttack("none");
    context.setArtifactDomainAttack(true);
    await expect(context.pipeline.evaluateCurrent(request)).rejects.toThrow(/artifact ruleSet payload\/ref closure invalid/);
    context.setArtifactDomainAttack(false);
    context.setArtifactSemanticAttack(true);
    await expect(context.pipeline.evaluateCurrent(request)).rejects.toThrow(/artifact ruleSet payload\/ref closure invalid/);
    context.setArtifactSemanticAttack(false);
    context.setDanglingFact(true);
    await expect(context.pipeline.evaluateCurrent(request)).rejects.toThrow(/fact snapshot payload closure is invalid or dangling/);
    context.setDanglingFact(false);
    for (const attack of ["proposed", "retracted", "invalidated", "stale", "attachment"] as const) {
      context.setObservationAttack(attack);
      await expect(context.pipeline.evaluateCurrent(request)).rejects.toThrow(/observation snapshot payload closure is invalid or dangling/);
    }
    const memberClosure = await fixture();
    memberClosure.setObservationRepositoryClosureValid(false);
    await expect(memberClosure.pipeline.evaluateCurrent(await memberClosure.request())).rejects.toThrow(/member payload closure invalid/);
    const unavailable = new AuthoritativeEvaluationSnapshotPipeline({ runtimeRoot: context.runtimeRoot, factGraphEnabled: true });
    await expect(unavailable.evaluateCurrent(request)).rejects.toThrow(/authority is unavailable/);
  });

  it("persists authorized candidate receipts without switching current before accept", async () => {
    const context = await fixture();
    const request = await context.request();
    const current = await context.pipeline.evaluateCurrent(request);
    const readCurrent = async () => (await context.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) =>
      context.locks.currentLockAtRoot(activeRoot, "plan-pipeline", { kind: "draft", draftRevision: 0 }))).result;

    const [beforeCandidate, candidate] = await Promise.all([
      context.pipeline.evaluateAuthorizedFactCandidate({
        ...request,
        updateNoticeId: "notice-pipeline",
        phase: "before",
      }),
      context.pipeline.evaluateAuthorizedFactCandidate({
        ...request,
        updateNoticeId: "notice-pipeline",
        phase: "after",
      }),
    ]);
    expect(beforeCandidate.evaluationLock.contentHash).toBe(current.evaluationLock.contentHash);
    expect(candidate.evaluationLock.contentHash).not.toBe(current.evaluationLock.contentHash);
    expect(factUpdateSnapshotReceipt(candidate, ["mechanical"]).domainHashes.mechanical)
      .not.toBe(factUpdateSnapshotReceipt(current, ["mechanical"]).domainHashes.mechanical);
    expect((await readCurrent())?.contentHash).toBe(current.evaluationLock.contentHash);

    context.acceptCandidate();
    const accepted = await context.pipeline.evaluateCurrent(request);
    expect(accepted).toMatchObject({ cacheStatus: "hit", evaluationHash: candidate.evaluationHash });
    expect((await readCurrent())?.contentHash).toBe(candidate.evaluationLock.contentHash);

    await context.setCandidateSnapshot("9");
    context.setEvaluatorHook(async () => { context.setCandidateAuthorized(false); });
    await expect(context.pipeline.evaluateAuthorizedFactCandidate({
      ...request,
      updateNoticeId: "notice-pipeline",
      phase: "after",
    })).rejects.toThrow(/candidate notice is no longer authorized/);
    expect((await readCurrent())?.contentHash).toBe(candidate.evaluationLock.contentHash);
  });

  it("pins plan-relevant facts until plan-scoped accept/undo and preserves the selection after restart", async () => {
    const closures = new Map<string, { snapshot: FactSnapshot; facts: never[]; conflicts: never[] }>();
    const factsById = new Map([
      ["fact-sku-a-v1", { factId: "fact-sku-a-v1", contentHash: digest("1"), subject: { kind: "product", skuId: "sku-a" } }],
      ["fact-sku-b-v1", { factId: "fact-sku-b-v1", contentHash: digest("2"), subject: { kind: "product", skuId: "sku-b" } }],
      ["fact-plan-a", { factId: "fact-plan-a", contentHash: digest("3"), subject: { kind: "plan_subject", planId: "plan-a" } }],
      ["fact-plan-b", { factId: "fact-plan-b", contentHash: digest("4"), subject: { kind: "plan_subject", planId: "plan-b" } }],
    ]);
    let currentFacts = [...factsById.values()];
    let created = 0;
    const makeClosure = async (factIds: string[], marker: string) => {
      const snapshot = await createFactSnapshot({
        schemaVersion: "fact-snapshot-v2",
        factRefs: factIds.map((factId) => ({ factId, contentHash: factsById.get(factId)?.contentHash ?? digest("f") })),
        conflictRefs: [],
        createdAt: `2026-08-28T05:00:${marker}.000Z`,
      });
      const closure = { snapshot, facts: [] as never[], conflicts: [] as never[] };
      closures.set(snapshot.snapshotId, closure);
      return closure;
    };
    const selected = new Map<string, { snapshotId: string; contentHash: string }>();
    const currentLocks = new Map<string, { factSnapshotId: string; snapshotHashes: { factSnapshotHash: string } }>();
    const fakeFacts = {
      listCurrentFactsAtRoot: async () => structuredClone(currentFacts),
      createSnapshotAtRoot: async (_root: string, input: { factIds?: string[] }) =>
        (await makeClosure(input.factIds ?? [], String(++created).padStart(2, "0"))).snapshot,
      getSnapshotClosureAtRoot: async (_root: string, snapshotId: string) => structuredClone(closures.get(snapshotId) ?? null),
    };
    const fakeDecisions = {
      getSelectedSnapshotForPlanAtRoot: async (_root: string, planId: string) => structuredClone(selected.get(planId) ?? null),
      getDecisionAtRoot: async () => null,
    };
    const fakeLocks = {
      currentLockAtRoot: async (_root: string, planId: string) => structuredClone(currentLocks.get(planId) ?? null),
    };
    const authority = () => createRepositoryBackedEvaluationSnapshotAuthority({
      runtimeRoot: "/authority-fixture",
      facts: fakeFacts as never,
      observations: {} as never,
      decisions: fakeDecisions as never,
      locks: fakeLocks as never,
      loadArtifactsAtRoot: async () => { throw new Error("not used"); },
      loadExternalInputsAtRoot: async () => { throw new Error("not used"); },
    });
    const target = (planId: string, skuId: string) => {
      const config = createEmptyBuildConfigV3(planId, planId, now);
      config.components.push({
        instanceId: `${planId}-component`, kind: "case", role: "case", state: "planned",
        identity: { status: "resolved", skuId, identityClaimIds: [] }, source: "user",
      });
      return { planId, planVersionId: null, draftRevision: 0, config };
    };

    const firstA = await authority().resolveFactSnapshotAtRoot("/root", target("plan-a", "sku-a"));
    expect(firstA.snapshot.factRefs.map((ref) => ref.factId).sort()).toEqual(["fact-plan-a", "fact-sku-a-v1"]);
    currentLocks.set("plan-a", {
      factSnapshotId: firstA.snapshot.snapshotId,
      snapshotHashes: { factSnapshotHash: firstA.snapshot.contentHash },
    });
    factsById.set("fact-sku-a-v2", { factId: "fact-sku-a-v2", contentHash: digest("5"), subject: { kind: "product", skuId: "sku-a" } });
    currentFacts = [...factsById.values()];
    const stillPinned = await authority().resolveFactSnapshotAtRoot("/root", target("plan-a", "sku-a"));
    expect(stillPinned.snapshot.contentHash).toBe(firstA.snapshot.contentHash);

    const acceptedA = await makeClosure(["fact-plan-a", "fact-sku-a-v2"], "20");
    selected.set("plan-a", { snapshotId: acceptedA.snapshot.snapshotId, contentHash: acceptedA.snapshot.contentHash });
    expect((await authority().resolveFactSnapshotAtRoot("/root", target("plan-a", "sku-a"))).snapshot.contentHash)
      .toBe(acceptedA.snapshot.contentHash);
    selected.set("plan-a", { snapshotId: firstA.snapshot.snapshotId, contentHash: firstA.snapshot.contentHash });
    expect((await authority().resolveFactSnapshotAtRoot("/root", target("plan-a", "sku-a"))).snapshot.contentHash)
      .toBe(firstA.snapshot.contentHash);

    const firstB = await authority().resolveFactSnapshotAtRoot("/root", target("plan-b", "sku-b"));
    expect(firstB.snapshot.factRefs.map((ref) => ref.factId).sort()).toEqual(["fact-plan-b", "fact-sku-b-v1"]);
    expect(firstB.snapshot.contentHash).not.toBe(firstA.snapshot.contentHash);
    expect((await authority().resolveFactSnapshotAtRoot("/root", target("plan-a", "sku-a"))).snapshot.contentHash)
      .toBe(firstA.snapshot.contentHash);
  });

  it("CAS-fences runtime drift, installs cache only after commit, and restores freshness from persisted receipts", async () => {
    const context = await fixture();
    context.setEvaluatorHook(() => context.coordinator.withWrite(async () => undefined).then(() => undefined));
    await expect(context.pipeline.evaluateCurrent(await context.request())).rejects.toThrow(/expected revision conflict/);
    expect(context.evaluatorCalls()).toBe(1);
    context.setEvaluatorHook(undefined);
    const committed = await context.pipeline.evaluateCurrent(await context.request());
    expect(committed.cacheStatus).toBe("miss");
    expect(context.evaluatorCalls()).toBe(2);

    const restarted = new AuthoritativeEvaluationSnapshotPipeline(context.options);
    await expect(restarted.evaluateCurrent(await context.request())).resolves.toMatchObject({ cacheStatus: "hit" });
    expect(context.evaluatorCalls()).toBe(2);
    await expect(restarted.assessFreshness(snapshotFromReceipt(committed), committed.target)).resolves.toEqual({
      status: "current", reason: "lock_matches",
    });
    context.setArtifactVersion("standardSet", 9);
    await context.pipeline.evaluateCurrent(await context.request());
    await expect(restarted.assessFreshness(snapshotFromReceipt(committed), committed.target)).resolves.toEqual({
      status: "stale", reason: "snapshot_inputs_changed",
    });
  });

  it("never lets an immutable PlanVersion drift to newer artifact or snapshot inputs", async () => {
    const context = await fixture();
    const draft = await context.pipeline.evaluateCurrent(await context.request());
    context.setPinnedVersionLock(draft.evaluationLock);
    const versionRequest = {
      planId: draft.planId,
      target: { kind: "version" as const, versionId: "version-pipeline", expectedConfigHash: draft.configHash },
    };
    await expect(context.pipeline.evaluateCurrent(versionRequest)).resolves.toMatchObject({
      evaluationLock: { contentHash: draft.evaluationLock.contentHash },
    });
    context.setArtifactVersion("engine", 99);
    await expect(context.pipeline.evaluateCurrent(versionRequest)).rejects.toThrow(/immutable PlanVersion evaluation lock closure changed/);
  });

  it("fails the deployed legacy buildConfig route closed when the fact graph flag is on", async () => {
    const context = await fixture();
    vi.stubEnv("BUILD_SIM_FACT_GRAPH_ENABLED", "true");
    expect(() => handleAgentRoute("POST", "/api/agent/evaluate", { buildConfig: createDefaultN6Config("legacy", now) }))
      .toThrow(/AuthoritativeEvaluationSnapshotPipeline/);
    expect(context.runtimeRoot).toBeTruthy();
  });

  it("does not emit legacy catalog-attribute conclusions from the fact-on V2 builtin engine", async () => {
    const config = createDefaultN6Config("legacy-fact-on", now);
    await expect(Promise.resolve().then(() => builtinGovernedEvaluator({ config, factClosure: { conflicts: [], facts: [] } } as never)))
      .rejects.toThrow(/governed fact-driven engine/);
    vi.stubEnv("BUILD_SIM_FACT_GRAPH_ENABLED", "false");
    expect(handleAgentRoute("POST", "/api/agent/evaluate", { buildConfig: config })).toMatchObject({
      status: 200,
      payload: { evaluation: { config: { id: config.id } } },
    });
  });

  it("serves only a target request over the real workspace HTTP route and replays after restart", async () => {
    const context = await fixture();
    const request = await context.request();
    const post = async (pipeline: AuthoritativeEvaluationSnapshotPipeline, body: unknown, enabled = true) => {
      const server = createWorkspaceServer({} as never, { evaluationPipeline: pipeline, factGraphEnabled: enabled });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("workspace test server address unavailable");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/plans/${request.planId}/evaluations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, payload: await response.json() as Record<string, unknown> };
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    };

    await expect(post(context.pipeline, { target: request.target })).resolves.toMatchObject({
      status: 201,
      payload: { cacheStatus: "miss", planId: request.planId },
    });
    const restarted = new AuthoritativeEvaluationSnapshotPipeline(context.options);
    await expect(post(restarted, { target: request.target })).resolves.toMatchObject({
      status: 201,
      payload: { cacheStatus: "hit", planId: request.planId },
    });
    expect(context.evaluatorCalls()).toBe(1);
    await expect(post(restarted, { target: request.target, evaluationLock: { contentHash: digest("a") } })).resolves.toMatchObject({
      status: 400,
      payload: { error: "invalid_request" },
    });
    context.setExternalAttack("semantic");
    await expect(post(restarted, { target: request.target })).resolves.toMatchObject({
      status: 503,
      payload: { error: "evaluation_authority_failed" },
    });
    await expect(post(restarted, { target: request.target }, false)).resolves.toMatchObject({
      status: 404,
      payload: { error: "fact_graph_evaluation_disabled" },
    });
  });
});
