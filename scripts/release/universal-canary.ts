#!/usr/bin/env -S vite-node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function canaryConfig(): BuildConfigV3 {
  const config = createEmptyBuildConfigV3("plan-universal-release-canary", "Universal release canary", CANARY_AT);
  config.components = CANARY_COMPONENTS.map((component) => ({
    instanceId: component.instanceId,
    kind: component.kind,
    role: component.role,
    state: "planned",
    identity: {
      status: "resolved",
      skuId: component.skuId,
      identityClaimIds: [`canary-identity-${component.instanceId}`],
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

export async function runUniversalReleaseCanary(options: { runtimeRoot?: string; keepRuntime?: boolean } = {}): Promise<UniversalCanaryReport> {
  const ownedRoot = options.runtimeRoot === undefined;
  const runtimeRoot = options.runtimeRoot ?? await mkdtemp(path.join(tmpdir(), "buildsim-universal-release-canary-"));
  try {
    const migrationPlan = await planFactsV1Migration();
    await migrateFactsV1({
      dryRun: false,
      expectedSourceHash: migrationPlan.sourceHash,
      runtimeRoot,
      now: () => CANARY_AT,
    });
    const services = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: runtimeRoot,
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
      BUILD_SIM_SPATIAL_ROUTING_ENABLED: "true",
      BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
      BUILD_SIM_THERMAL_V3_ENABLED: "true",
      BUILD_SIM_ACOUSTIC_V3_ENABLED: "true",
    });
    await services.coordinator!.initialize();
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await writeEmptyPriceSnapshot(services);

    const config = canaryConfig();
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
    const checks = [
      check("stage-a.two-distinct-ssd-instances", storageInstances.length === 2
        && new Set(storageInstances.map(({ instanceId }) => instanceId)).size === 2,
      storageInstances.map(({ instanceId, identity }) => ({ instanceId, identity }))),
      check("stage-a.no-profile-default-components", implicitKinds.length === 0,
        { configuredInstanceIds: config.components.map(({ instanceId }) => instanceId), implicitInstanceIds: implicitKinds.map(({ instanceId }) => instanceId) }),
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
      check("stage-a.price-is-not-invented", evaluation.priceProjection.complete === false
        && unknownPriceIds.length === config.components.length,
      { knownSubtotalCny: evaluation.priceProjection.knownSubtotalCny, unknownInstanceIds: unknownPriceIds }),
      check("stage-a.no-executable-first-power-completion", evaluation.readiness.powerReady === false
        && evaluation.readiness.firstBootReady === false && evaluation.readiness.osInstallReady === false,
      { readiness: evaluation.readiness }),
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
  const report = await runUniversalReleaseCanary();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}
