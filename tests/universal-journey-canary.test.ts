import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import { verifyUniversalJourneyEvidence } from "../scripts/release/universal-journey-canary";
import { hashPlanConfig } from "../src/plans/canonical";
import {
  createUniversalJourneyEvidenceManifest,
  type UniversalJourneyPlanBinding,
} from "../src/release/universal-journey";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
const at = "2026-08-30T13:30:00.000Z";

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function environment(runtimeRoot: string) {
  return {
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
    BUILD_SIM_PRICE_TARGETS_ENABLED: "true",
    BUILD_SIM_WHOLE_BUILD_SOLVER_ENABLED: "true",
    BUILD_SIM_SCENARIO_WHAT_IF_ENABLED: "true",
    BUILD_SIM_STORAGE_LAYOUT_ENABLED: "true",
    BUILD_SIM_USER_OBSERVATIONS_ENABLED: "true",
    BUILD_SIM_RECOMMENDATIONS_ENABLED: "true",
    BUILD_SIM_BACKUP_RESTORE_ENABLED: "true",
    BUILD_SIM_DOCTOR_REPAIR_ENABLED: "true",
    BUILD_SIM_PORTABILITY_ENABLED: "true",
  };
}

async function writeEmptyPrice(runtime: ReturnType<typeof createWorkspaceRepositories<BuildConfigV3>>): Promise<void> {
  const inputHash = createHash("sha256").update("universal-journey-empty-price").digest("hex");
  const material = {
    schemaVersion: "1.1.0", asOf: "2026-08-30", snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: at, catalogVersion: "universal-journey-canary", inputHash, priceVersion: "price-snapshot-v2", quotes: [],
  };
  await runtime.coordinator!.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    await mkdir(path.join(activeRoot, "prices"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify({
      ...material,
      contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
    })}\n`, { mode: 0o600 });
  });
}

function binding(version: {
  planId: string;
  id: string;
  configHash: string;
  evaluationHash?: string;
  evaluationLock?: { contentHash: string; snapshotHashes: { factSnapshotHash: string } };
}): UniversalJourneyPlanBinding {
  if (!version.evaluationHash || !version.evaluationLock) throw new Error("test version is not governed");
  return {
    planId: version.planId,
    planVersionId: version.id,
    configHash: version.configHash,
    evaluationHash: version.evaluationHash,
    evaluationLockHash: version.evaluationLock.contentHash,
    factSnapshotHash: version.evaluationLock.snapshotHashes.factSnapshotHash,
  };
}

describe("universal journey production canary", () => {
  it("replays the manifest-selected plan through complete portable export, verified backup, empty restore and strict Doctor", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "buildsim-universal-journey-canary-"));
    roots.push(runtimeRoot);
    const services = createWorkspaceRepositories<BuildConfigV3>(environment(runtimeRoot));
    await services.coordinator!.initialize("universal-journey-canary");
    await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    await services.artifactRepository.initialize();
    await writeEmptyPrice(services);

    const config = createEmptyBuildConfigV3("plan-universal-journey-replay", "Blank intent", at);
    config.intent = { state: "answered", value: "pc", source: "user", confirmedByUser: true };
    config.requirementSpec = {
      requirementSpecId: "requirements-universal-journey-replay",
      schemaVersion: "1.0.0",
      budget: { state: "answered", value: { targetCny: 9000 }, source: "user", confirmedByUser: true },
      workloads: [{
        workloadId: "workload-universal-journey",
        state: "answered",
        name: "Local workstation workload",
        metrics: [],
        source: "user",
        confirmedByUser: true,
      }],
      constraints: [],
    };
    const created = await services.repository.create({ name: config.name, config });
    const blankHash = await hashPlanConfig(created.draft.config);
    const blankReceipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: created.id,
      target: { kind: "draft", expectedDraftRevision: created.draftRevision, expectedConfigHash: blankHash },
    });
    const blankVersion = await services.repository.saveVersion(created.id, {
      expectedRevision: created.draftRevision,
      expectedConfigHash: blankHash,
      reason: "initial",
      evaluationHash: blankReceipt.evaluationHash,
      evaluatedAt: blankReceipt.evaluatedAt,
      evaluationLock: blankReceipt.evaluationLock,
    });
    const updated = await services.repository.updateDraft(created.id, {
      expectedRevision: created.draftRevision,
      config: { ...created.draft.config, name: "Accepted local replay candidate", updatedAt: "2026-08-30T13:31:00.000Z" },
    });
    const acceptedHash = await hashPlanConfig(updated.draft.config);
    const acceptedReceipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: updated.id,
      target: { kind: "draft", expectedDraftRevision: updated.draftRevision, expectedConfigHash: acceptedHash },
    });
    const acceptedVersion = await services.repository.saveVersion(updated.id, {
      expectedRevision: updated.draftRevision,
      expectedConfigHash: acceptedHash,
      reason: "manual-save",
      evaluationHash: acceptedReceipt.evaluationHash,
      evaluatedAt: acceptedReceipt.evaluatedAt,
      evaluationLock: acceptedReceipt.evaluationLock,
    });

    const job = (digit: string) => `job-${digit.repeat(64)}`;
    const manifest = await createUniversalJourneyEvidenceManifest({
      schemaVersion: "universal-journey-evidence-v1",
      runtimeGeneration: (await services.coordinator!.readState()).runtimeGeneration,
      createdAt: at,
      stageB: {
        plan: binding(acceptedVersion),
        solverJobId: job("1"),
        recommendationSetRef: `sha256:${"2".repeat(64)}`,
        executionSessionId: "execution-universal-journey",
        nasPlan: binding(acceptedVersion),
      },
      journey: {
        blankPlan: binding(blankVersion),
        acceptedPlan: binding(acceptedVersion),
        feasibleSolverJobId: job("3"),
        unsatSolverJobId: job("4"),
        scenarios: { case: "scenario-case", system: "scenario-system", storage: "scenario-storage", nas: "scenario-nas" },
        provisionalCase: {
          planId: created.id,
          caseInstanceId: "case-runtime-discovered",
          candidateId: `provisional-case-adapter-sha256-${"5".repeat(64)}`,
          registryRef: `sha256:${"6".repeat(64)}`,
          skuId: "case.runtime-discovered",
          region: "CN",
          revision: "rev-a",
        },
        priceTargetIds: ["price-target-local"],
        recoveryJobs: [
          { role: "evidence_download", jobId: job("7"), expectedType: "evidence.pipeline" },
          { role: "ocr", jobId: job("8"), expectedType: "evidence.pipeline" },
          { role: "solver", jobId: job("9"), expectedType: "solver.whole-build" },
          { role: "price_recheck", jobId: job("a"), expectedType: "price.target-recheck" },
          { role: "adapter_generation", jobId: job("b"), expectedType: "evidence.pipeline" },
        ],
      },
    });
    const evidenceDirectory = path.join(runtimeRoot, "release-evidence");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const { contentHash: _contentHash, ...manifestMaterial } = manifest;
    const staleGenerationManifest = await createUniversalJourneyEvidenceManifest({
      ...manifestMaterial,
      runtimeGeneration: manifest.runtimeGeneration + 1,
    });
    await writeFile(path.join(evidenceDirectory, "universal-journey.json"), `${JSON.stringify(staleGenerationManifest, null, 2)}\n`, { mode: 0o600 });
    const staleChecks = await verifyUniversalJourneyEvidence({ services, evidenceRuntimeRoot: runtimeRoot });
    expect(staleChecks).toHaveLength(12);
    expect(staleChecks.every(({ status, evidence }) => status === "blocked"
      && (evidence as { reason?: string }).reason === "runtime_generation_mismatch")).toBe(true);
    await writeFile(path.join(evidenceDirectory, "universal-journey.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restarted = createWorkspaceRepositories<BuildConfigV3>(environment(runtimeRoot));
    await restarted.coordinator!.initialize();
    const checks = await verifyUniversalJourneyEvidence({ services: restarted, evidenceRuntimeRoot: runtimeRoot });
    expect(checks.find(({ checkId }) => checkId === "stage-b.evidence-manifest")).toMatchObject({ status: "pass" });
    expect(checks.find(({ checkId }) => checkId === "journey.portable-backup-restore-doctor")).toMatchObject({
      status: "pass",
      evidence: {
        portableDryRunAction: "copy_as_new_plan",
        portableResultMode: "exact_replay",
        backupVerificationResult: "pass",
        doctorOverall: "healthy",
        replayedPlanHashTuples: [
          expect.objectContaining({ configHash: acceptedVersion.configHash, evaluationHash: acceptedVersion.evaluationHash }),
          expect.objectContaining({ configHash: acceptedVersion.configHash, evaluationHash: acceptedVersion.evaluationHash }),
        ],
      },
    });
    expect(checks.find(({ checkId }) => checkId === "stage-b.complete-governed-plan")?.status).toBe("blocked");
  }, 120_000);
});
