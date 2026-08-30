#!/usr/bin/env -S vite-node

import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeRuntimeCatalog } from "../price-server/catalog/repository.mjs";
import { migrateFactsV1, planFactsV1Migration } from "../migrations/migrate-facts-v1.mjs";
import { hashPlanConfig } from "../../src/plans/canonical";
import { createWorkspaceRepositories } from "../../src/server/workspace-server";
import { createEmptyBuildConfigV3, type BuildConfigV3, type ComponentInstance } from "../../src/topology/contracts";
import type { FactRecord } from "../../src/facts/contracts";
import { isProgressiveBuildEvaluation, type ProgressiveBuildEvaluation } from "../../src/compatibility/contracts";
import { projectCurrentChinaPrice, type CurrentPriceProjection } from "../../src/price/policy";
import type { PriceObservation } from "../../src/price/contracts";
import { loadRuntimePriceSnapshot } from "../../src/server/runtime-price-snapshot";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";

const CANARY_AT = "2026-08-30T12:00:00.000Z";

export type CanaryCheckStatus = "pass" | "blocked";

export interface UniversalCanaryCheck {
  checkId: string;
  status: CanaryCheckStatus;
  evidence: unknown;
}

export interface UniversalCanaryReport {
  schemaVersion: "universal-release-canary-v1";
  generatedAt: string;
  status: "pass" | "blocked";
  planId: string;
  planVersionId: string;
  configHash: string;
  evaluationHash: string;
  factSnapshotHash: string;
  checks: UniversalCanaryCheck[];
  blockers: string[];
}

const CANARY_COMPONENTS: ReadonlyArray<Pick<ComponentInstance, "instanceId" | "kind" | "role"> & { skuId: string }> = Object.freeze([
  { instanceId: "case-n6-canary", kind: "case", role: "chassis", skuId: "case.jonsbo-n6" },
  { instanceId: "board-w680m-canary", kind: "motherboard", role: "motherboard", skuId: "board.asus-w680m-ace-se" },
  { instanceId: "cpu-i5-14500-canary", kind: "cpu", role: "processor", skuId: "cpu.i5-14500" },
  { instanceId: "storage-980-pro-canary-a", kind: "storage_drive", role: "primary-storage", skuId: "storage.samsung-980-pro" },
  { instanceId: "storage-980-pro-canary-b", kind: "storage_drive", role: "secondary-storage", skuId: "storage.samsung-980-pro" },
  { instanceId: "psu-ssr-850fx-canary", kind: "psu", role: "primary-power", skuId: "psu.seasonic-focus-plus-gold-850-fx" },
]);

function canaryConfig(priceIdentityClaimsBySku: ReadonlyMap<string, readonly string[]> = new Map()): BuildConfigV3 {
  const config = createEmptyBuildConfigV3("plan-universal-release-canary", "Universal release canary", CANARY_AT);
  config.components = CANARY_COMPONENTS.map((component) => ({
    instanceId: component.instanceId,
    kind: component.kind,
    role: component.role,
    state: "planned",
    identity: {
      status: "resolved",
      skuId: component.skuId,
      identityClaimIds: [...(priceIdentityClaimsBySku.get(component.skuId) ?? [`canary-identity-${component.instanceId}`])],
    },
    source: "user",
  }));
  config.requirementSpec = {
    requirementSpecId: "requirements-universal-release-canary",
    schemaVersion: "1.0.0",
    workloads: [],
    constraints: [],
  };
  return config;
}

interface CanaryPriceSelection {
  readonly skuId: string;
  readonly variantIdentityFactIds: readonly string[];
  readonly projection: CurrentPriceProjection;
}

interface CanarySourcePriceAuthority {
  readonly priceSnapshotHash: string;
  readonly priceSnapshotId: string;
  readonly asOf: string;
  readonly selections: ReadonlyMap<string, CanaryPriceSelection>;
}

async function cloneActiveRuntimeReadOnly(sourceRuntimeRootValue: string, targetRuntimeRootValue: string): Promise<void> {
  const sourceRuntimeRoot = path.resolve(sourceRuntimeRootValue);
  const targetRuntimeRoot = path.resolve(targetRuntimeRootValue);
  const relative = path.relative(sourceRuntimeRoot, targetRuntimeRoot);
  const inverse = path.relative(targetRuntimeRoot, sourceRuntimeRoot);
  if (sourceRuntimeRoot === targetRuntimeRoot
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
    || (!inverse.startsWith("..") && !path.isAbsolute(inverse))) {
    throw new TypeError("release canary source and temporary runtime roots must be disjoint");
  }
  const source = new RuntimeCoordinator({ root: sourceRuntimeRoot });
  await source.withReadOnlySnapshot(async ({ state, activeRoot }: {
    state: { activeRoot: string };
    activeRoot: string;
  }) => {
    const pointerSource = path.join(sourceRuntimeRoot, "control", "active-pointer.json");
    const pointerStat = await lstat(pointerSource);
    if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) throw new Error("release canary source runtime pointer is not a regular file");
    const targetActiveRoot = path.join(targetRuntimeRoot, state.activeRoot);
    await mkdir(path.dirname(targetActiveRoot), { recursive: true, mode: 0o700 });
    await cp(activeRoot, targetActiveRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (sourcePath) => {
        const sourceRelative = path.relative(activeRoot, sourcePath);
        if (sourceRelative.split(path.sep).includes(".locks")) return false;
        const sourceStat = await lstat(sourcePath);
        if (sourceStat.isSymbolicLink()) throw new Error(`release canary source runtime contains a symbolic link: ${sourcePath}`);
        return true;
      },
    });
    await mkdir(path.join(targetRuntimeRoot, "control"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(targetRuntimeRoot, "staging"), { recursive: true, mode: 0o700 });
    await copyFile(pointerSource, path.join(targetRuntimeRoot, "control", "active-pointer.json"));
  });
}

function priceStatusRank(status: CurrentPriceProjection["status"]): number {
  return status === "range" ? 0 : status === "single" ? 1 : status === "conflict" ? 2 : 3;
}

async function selectCanarySourcePrices(
  services: ReturnType<typeof createWorkspaceRepositories<BuildConfigV3>>,
  runtimeRoot: string,
): Promise<CanarySourcePriceAuthority> {
  await services.priceRepository.initialize("universal-release-canary-price-read-v1");
  const snapshot = loadRuntimePriceSnapshot({ runtimeRoot, allowSeedFallback: false });
  if (snapshot.schemaVersion !== "1.1.0" || snapshot.priceVersion !== "price-snapshot-v2"
    || typeof snapshot.snapshotId !== "string" || typeof snapshot.inputHash !== "string"
    || typeof snapshot.generatedAt !== "string") {
    throw new Error("release canary source requires a governed current-price snapshot v2; legacy price archives remain history-only");
  }
  if (typeof snapshot.contentHash !== "string") throw new Error("release canary source price snapshot is not content-addressed");
  const boundObservationIds = new Set(snapshot.quotes.flatMap(({ provenanceId }) => (
    typeof provenanceId === "string" ? [provenanceId] : []
  )));
  const observations = (await services.priceRepository.listObservations())
    .filter(({ observationId }) => boundObservationIds.has(observationId));
  const selections = new Map<string, CanaryPriceSelection>();
  for (const skuId of [...new Set(CANARY_COMPONENTS.map((component) => component.skuId))].sort()) {
    const groups = new Map<string, PriceObservation[]>();
    for (const observation of observations.filter((candidate) => candidate.skuId === skuId)) {
      const variantIdentityFactIds = [...observation.variantIdentityFactIds].sort();
      const key = JSON.stringify(variantIdentityFactIds);
      const group = groups.get(key) ?? [];
      group.push(observation);
      groups.set(key, group);
    }
    const candidates = [...groups.entries()].map(([key, group]) => {
      const variantIdentityFactIds = JSON.parse(key) as string[];
      const projection = projectCurrentChinaPrice({
        skuId,
        variantIdentityFactIds,
        observations: group,
        now: `${snapshot.asOf}T23:59:59.999Z`,
      });
      return { skuId, variantIdentityFactIds, projection } satisfies CanaryPriceSelection;
    }).filter(({ projection }) => projection.status === "single" || projection.status === "range")
      .sort((left, right) => priceStatusRank(left.projection.status) - priceStatusRank(right.projection.status)
        || right.projection.sellerCount - left.projection.sellerCount
        || JSON.stringify(left.variantIdentityFactIds).localeCompare(JSON.stringify(right.variantIdentityFactIds)));
    if (candidates[0]) selections.set(skuId, candidates[0]);
  }
  return { priceSnapshotHash: snapshot.contentHash, priceSnapshotId: snapshot.snapshotId, asOf: snapshot.asOf, selections };
}

async function writeEmptyPriceSnapshot(services: ReturnType<typeof createWorkspaceRepositories<BuildConfigV3>>): Promise<void> {
  const inputHash = createHash("sha256").update("universal-release-canary-empty-price").digest("hex");
  const material = {
    schemaVersion: "1.1.0",
    asOf: "2026-08-30",
    snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: CANARY_AT,
    catalogVersion: "universal-release-canary",
    inputHash,
    priceVersion: "price-snapshot-v2",
    quotes: [],
  };
  await services.coordinator!.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify({
      ...material,
      contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
    })}\n`, "utf8");
  });
}

function officialFactSummary(facts: readonly FactRecord[]): Record<string, { factIds: string[]; fields: string[] }> {
  const summary: Record<string, { factIds: string[]; fields: string[] }> = {};
  for (const component of CANARY_COMPONENTS) {
    const matched = facts.filter((fact) => fact.subject.kind === "product"
      && fact.subject.skuId === component.skuId && fact.authority === "official" && fact.status === "active");
    summary[component.skuId] = {
      factIds: [...new Set(matched.map(({ factId }) => factId))].sort(),
      fields: [...new Set(matched.map(({ field }) => field))].sort(),
    };
  }
  return summary;
}

function check(checkId: string, condition: boolean, evidence: unknown): UniversalCanaryCheck {
  return { checkId, status: condition ? "pass" : "blocked", evidence };
}

export async function runUniversalReleaseCanary(options: {
  runtimeRoot?: string;
  /**
   * Read-only source for a production-data canary. The active generation is
   * copied to a disposable root before the canary creates its plan/version.
   */
  sourceRuntimeRoot?: string;
  keepRuntime?: boolean;
} = {}): Promise<UniversalCanaryReport> {
  if (options.runtimeRoot !== undefined && options.sourceRuntimeRoot !== undefined) {
    throw new TypeError("release canary accepts either runtimeRoot or sourceRuntimeRoot, not both");
  }
  const sourceMode = options.sourceRuntimeRoot !== undefined;
  const ownedRoot = options.runtimeRoot === undefined;
  const runtimeRoot = options.runtimeRoot ?? await mkdtemp(path.join(tmpdir(), "buildsim-universal-release-canary-"));
  try {
    if (options.sourceRuntimeRoot !== undefined) {
      await cloneActiveRuntimeReadOnly(options.sourceRuntimeRoot, runtimeRoot);
    } else {
      const migrationPlan = await planFactsV1Migration();
      await migrateFactsV1({
        dryRun: false,
        expectedSourceHash: migrationPlan.sourceHash,
        runtimeRoot,
        now: () => CANARY_AT,
      });
    }
    const services = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: runtimeRoot,
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
      BUILD_SIM_SPATIAL_ROUTING_ENABLED: "true",
      BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
      BUILD_SIM_THERMAL_V3_ENABLED: "true",
      BUILD_SIM_ACOUSTIC_V3_ENABLED: "true",
      BUILD_SIM_SYSTEM_PROFILES_ENABLED: "true",
      BUILD_SIM_BUILD_EXECUTION_V3_ENABLED: "true",
      BUILD_SIM_DURABLE_JOBS_ENABLED: "true",
      BUILD_SIM_PRICE_HISTORY_ENABLED: "true",
    });
    await services.coordinator!.initialize();
    if (!sourceMode) {
      await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
      await writeEmptyPriceSnapshot(services);
    }
    const sourcePriceAuthority = sourceMode
      ? await selectCanarySourcePrices(services, runtimeRoot)
      : null;

    const config = canaryConfig(new Map([...sourcePriceAuthority?.selections.entries() ?? []]
      .map(([skuId, selection]) => [skuId, selection.variantIdentityFactIds] as const)));
    const plan = await services.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(plan.draft.config);
    const receipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "draft", expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    });
    if (!isProgressiveBuildEvaluation(receipt.evaluation)) throw new Error("release canary requires progressive evaluation");
    const evaluation = receipt.evaluation as ProgressiveBuildEvaluation;
    const version = await services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision,
      expectedConfigHash: configHash,
      reason: "manual-save",
      evaluationHash: receipt.evaluationHash,
      evaluatedAt: receipt.evaluatedAt,
      evaluationLock: receipt.evaluationLock,
    });
    const scene = await services.spatialScene!.get(plan.id, version.id);
    const procedurePreview = await services.systemExecution!.preview(plan.id, version.id);
    const resolutionSummary = await services.planResolutionSummary!.forPlan(plan.id);
    const priceView = await services.planPrices!.forPlan(plan.id);
    const facts = await services.factRepository.listCurrentFacts();
    const official = officialFactSummary(facts);
    const storageInstances = config.components.filter(({ kind }) => kind === "storage_drive");
    const implicitKinds = config.components.filter(({ instanceId }) => !CANARY_COMPONENTS.some((entry) => entry.instanceId === instanceId));
    const missingOfficial = [...new Set(CANARY_COMPONENTS.map(({ skuId }) => skuId))]
      .filter((skuId) => (official[skuId]?.factIds.length ?? 0) === 0);
    const cpuTurboFacts = facts.filter((fact) => fact.subject.kind === "product"
      && fact.subject.skuId === "cpu.i5-14500" && fact.field === "power.load" && fact.status === "active");
    const unknownPriceIds = evaluation.priceProjection.lines
      .filter(({ status }) => status === "unknown")
      .map(({ instanceId }) => instanceId).sort();
    const governedCurrentPrices = priceView.components.map(({ instanceId, skuId, current, currentObservations }) => ({
      instanceId,
      skuId,
      status: current.status,
      confidence: current.confidence,
      minCny: current.minCny,
      maxCny: current.maxCny,
      sampleCount: current.sampleCount,
      sellerCount: current.sellerCount,
      observationIds: currentObservations.map(({ observationId }) => observationId),
    }));
    const sourcePriceReady = sourceMode
      && sourcePriceAuthority !== null
      && sourcePriceAuthority.priceSnapshotId === priceView.priceSnapshotId
      && sourcePriceAuthority.asOf === priceView.asOf
      && governedCurrentPrices.length === config.components.length
      && governedCurrentPrices.every(({ status, confidence, minCny, maxCny, observationIds }) => (
        (status === "single" && confidence === "low" && minCny !== null && minCny === maxCny && observationIds.length === 1)
        || (status === "range" && ["medium", "high"].includes(confidence)
          && minCny !== null && maxCny !== null && minCny <= maxCny && observationIds.length >= 2)
      ))
      && evaluation.priceProjection.complete === true
      && evaluation.priceProjection.unknownInstanceIds.length === 0;
    const backplaneCapacity = procedurePreview.backplaneCapacities.find(({ caseInstanceId }) => caseInstanceId === "case-n6-canary") ?? null;
    const checks = [
      check("stage-a.two-distinct-ssd-instances", storageInstances.length === 2
        && new Set(storageInstances.map(({ instanceId }) => instanceId)).size === 2,
      storageInstances.map(({ instanceId, identity }) => ({ instanceId, identity }))),
      check("stage-a.no-profile-default-components", implicitKinds.length === 0,
        { configuredInstanceIds: config.components.map(({ instanceId }) => instanceId), implicitInstanceIds: implicitKinds.map(({ instanceId }) => instanceId) }),
      check("stage-a.agent-claim-scopes-are-explicit", resolutionSummary.claimScopeCount > 0
        && resolutionSummary.claimScopes.length > 0
        && resolutionSummary.claimScopes.every(({ scope, subject }) => {
          if (scope === "family") return subject.familyId.length > 0;
          if (scope === "model") return typeof subject.modelId === "string" && subject.modelId.length > 0;
          if (scope === "variant") return typeof subject.variantId === "string" && subject.variantId.length > 0;
          return typeof subject.revision === "string" && subject.revision.length > 0;
        }),
      {
        claimScopeCount: resolutionSummary.claimScopeCount,
        claimScopes: resolutionSummary.claimScopes.map(({ claimId, authority, fieldId, scope, subject }) => ({
          claimId, authority, fieldId, scope, subject,
        })),
        presentation: "Agent appends a deterministic Claim 适用范围 section from this server-issued projection.",
      }),
      check("stage-a.official-fact-closure", missingOfficial.length === 0,
        { products: official, missingSkuIds: missingOfficial }),
      check("stage-a.cpu-max-turbo-power-is-official", cpuTurboFacts.length === 1
        && cpuTurboFacts[0]!.authority === "official",
      { matchingFacts: cpuTurboFacts.map(({ factId, authority, value, unit }) => ({ factId, authority, value, unit })), guessedFallbackUsed: false }),
      check("stage-a.partial-remains-not-power-ready", evaluation.readiness.profileCompleteness === "partial"
        && evaluation.readiness.powerReady === false && evaluation.requirements.length > 0,
      { readiness: evaluation.readiness, requirementIds: evaluation.requirements.map(({ requirementId }) => requirementId) }),
      check("stage-a.no-empty-bay-data-cables", config.components.every(({ kind }) => kind !== "cable")
        && config.connections.length === 0,
      { cableInstanceIds: config.components.filter(({ kind }) => kind === "cable").map(({ instanceId }) => instanceId), connections: config.connections }),
      check("stage-a.backplane-current-and-future-scopes-are-distinct", backplaneCapacity !== null
        && backplaneCapacity.currentDemand.scope === "current_plan"
        && backplaneCapacity.currentDemand.occupiedBayCount === 0
        && backplaneCapacity.currentDemand.pendingStorageInstanceIds.join(",") === "storage-980-pro-canary-a,storage-980-pro-canary-b"
        && backplaneCapacity.currentDemand.requiredPowerLeads === null
        && backplaneCapacity.currentDemand.status === "unknown"
        && backplaneCapacity.fullBackplaneCapability.scope === "full_backplane"
        && backplaneCapacity.fullBackplaneCapability.occupiedBayCount === 9
        && backplaneCapacity.fullBackplaneCapability.requiredPowerLeads?.total === 4
        && backplaneCapacity.fullBackplaneCapability.status === "unknown"
        && backplaneCapacity.sourceFactIds.length === 0,
      backplaneCapacity),
      check("stage-a.spatial-scene-is-locked-and-blocked", scene.evaluationHash === receipt.evaluationHash
        && scene.executionStatus === "partial"
        && scene.blockedDomains.join(",") === "component_placement,routing,assembly"
        && scene.model.nodes.some(({ id }) => id === "case-shell")
        && scene.model.nodes.some(({ evidence, note }) => evidence === "inferred" && note?.includes("±"))
        && evaluation.domainEvaluations.some(({ verdict }) => verdict === "blocked" || verdict === "unknown"),
      {
        adapterSnapshotHash: scene.adapterSnapshotHash,
        evaluationHash: scene.evaluationHash,
        executionStatus: scene.executionStatus,
        blockedDomains: scene.blockedDomains,
        inferredToleranceNodeIds: scene.model.nodes
          .filter(({ evidence, note }) => evidence === "inferred" && note?.includes("±"))
          .map(({ id }) => id),
        nodeCount: scene.model.nodes.length,
      }),
      check("stage-a.thermal-acoustic-remains-blocked", evaluation.thermalAcousticEvaluation.thermal.verdict === "blocked"
        && evaluation.thermalAcousticEvaluation.thermal.peakTemperatureC === null
        && evaluation.thermalAcousticEvaluation.acoustic.verdict === "blocked"
        && evaluation.thermalAcousticEvaluation.acoustic.totalDba === null
        && evaluation.readiness.powerReady === false,
      {
        thermal: evaluation.thermalAcousticEvaluation.thermal,
        acoustic: evaluation.thermalAcousticEvaluation.acoustic,
        powerReady: evaluation.readiness.powerReady,
      }),
      sourceMode
        ? check("stage-a.china-new-price-is-governed", sourcePriceReady, {
          sourcePriceSnapshotHash: sourcePriceAuthority?.priceSnapshotHash ?? null,
          sourcePriceSnapshotId: sourcePriceAuthority?.priceSnapshotId ?? null,
          lockedPriceArtifactHash: receipt.evaluationLock.snapshotHashes.priceSnapshotHash,
          selectedVariantIdentityFactIds: Object.fromEntries([...sourcePriceAuthority?.selections.entries() ?? []]
            .map(([skuId, selection]) => [skuId, selection.variantIdentityFactIds])),
          components: governedCurrentPrices,
          progressiveKnownSubtotalCny: evaluation.priceProjection.knownSubtotalCny,
          progressiveUnknownInstanceIds: evaluation.priceProjection.unknownInstanceIds,
        })
        : check("stage-a.price-is-not-invented", evaluation.priceProjection.complete === false
          && unknownPriceIds.length === config.components.length
          && priceView.components.every(({ current }) => current.status === "unavailable"),
        {
          knownSubtotalCny: evaluation.priceProjection.knownSubtotalCny,
          unknownInstanceIds: unknownPriceIds,
          governedCurrentPrices,
        }),
      check("stage-a.no-executable-first-power-completion", evaluation.readiness.powerReady === false
        && evaluation.readiness.firstBootReady === false && evaluation.readiness.osInstallReady === false,
      { readiness: evaluation.readiness }),
      check("stage-a.procedure-is-preparation-only", procedurePreview.mode === "preparation_only"
        && procedurePreview.generated !== null
        && procedurePreview.generated.procedure.phases.join(",") === "prepare"
        && procedurePreview.generated.procedure.steps.length > 0
        && procedurePreview.generated.procedure.steps.every(({ phase, safetyCritical, riskLevel }) => (
          phase === "prepare" && safetyCritical === false && !["safety_critical", "destructive"].includes(riskLevel)
        ))
        && procedurePreview.generated.procedure.steps.some(({ action }) => action.includes("测量"))
        && procedurePreview.generated.procedure.steps.some(({ action }) => action.includes("首次通电许可")),
      {
        mode: procedurePreview.mode,
        blockers: procedurePreview.blockers,
        phases: procedurePreview.generated?.procedure.phases ?? [],
        steps: procedurePreview.generated?.procedure.steps.map(({ stepId, phase, action, riskLevel }) => ({
          stepId, phase, action, riskLevel,
        })) ?? [],
      }),
    ];
    const blockers = checks.filter(({ status }) => status === "blocked").map(({ checkId }) => checkId);
    return {
      schemaVersion: "universal-release-canary-v1",
      generatedAt: CANARY_AT,
      status: blockers.length === 0 ? "pass" : "blocked",
      planId: plan.id,
      planVersionId: version.id,
      configHash,
      evaluationHash: receipt.evaluationHash,
      factSnapshotHash: receipt.evaluationLock.snapshotHashes.factSnapshotHash,
      checks,
      blockers,
    };
  } finally {
    if (ownedRoot && options.keepRuntime !== true) await rm(runtimeRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let sourceRuntimeRoot: string | undefined;
  let keepRuntime = false;
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--source-runtime-root") {
      const value = args.shift();
      if (!value) throw new TypeError("--source-runtime-root requires a path");
      sourceRuntimeRoot = value;
    } else if (argument === "--keep-runtime") {
      keepRuntime = true;
    } else {
      throw new TypeError(`unknown release canary argument: ${argument}`);
    }
  }
  const report = await runUniversalReleaseCanary({
    ...(sourceRuntimeRoot === undefined ? {} : { sourceRuntimeRoot }),
    ...(keepRuntime ? { keepRuntime: true } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}
