import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactLockfile, createLockedArtifactRef, type ArtifactLockEntries, type SnapshotHashes } from "../src/hash";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { FilePlanRepository, type IssuedEvaluationProof } from "../src/plans/file-repository";
import { hashPlanConfig } from "../src/plans/canonical";
import { createWorkspaceRepositories } from "../src/server/workspace-server";

const roots: string[] = [];
const digest = (letter: string): string => letter.repeat(64);
const hashes = (configHash: string): SnapshotHashes => ({
  configHash, requirementSpecHash: digest("b"), factSnapshotHash: digest("c"), userObservationSnapshotHash: digest("d"), priceSnapshotHash: digest("e"),
  ruleSetHash: digest("f"), systemProfileHash: digest("1"), adapterSnapshotHash: digest("2"), engineHash: digest("3"), simulationModelHash: digest("4"), simulationInputHash: digest("5"),
});

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("U3 PlanVersion evaluation locks", () => {
  it("requires and preserves exact fact/observation/artifact snapshots when fact graph is enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-plan-fact-lock-")); roots.push(root);
    const accepted = new Set<string>();
    let issued: IssuedEvaluationProof | null = null;
    const repository = new FilePlanRepository({
      root,
      factGraphEnabled: true,
      verifyEvaluationLock: (lock) => accepted.has(lock.contentHash),
      verifyIssuedEvaluation: (proof) => JSON.stringify(proof) === JSON.stringify(issued),
      id: (prefix) => `${prefix}-12345678`,
    });
    const plan = await repository.create({ name: "Locked", config: createDefaultN6Config("draft", "2026-08-28T00:00:00.000Z") });
    const configHash = await hashPlanConfig(plan.draft.config);
    await expect(repository.saveVersion(plan.id, { expectedRevision: 0, expectedConfigHash: configHash, reason: "initial" })).rejects.toMatchObject({ code: "invalid_input" });
    const lock = await createPlanEvaluationLock({ planId: plan.id, snapshotHashes: hashes(configHash), factSnapshotId: "fact-snapshot-sha256-c", userObservationSnapshotId: "observation-snapshot-sha256-d", artifactLockfileHash: digest("6") });
    accepted.add(lock.contentHash);
    issued = {
      planId: plan.id,
      target: { kind: "draft", draftRevision: 0 },
      configHash,
      evaluationHash: digest("7"),
      evaluatedAt: "2026-08-28T00:01:00.000Z",
      evaluationLock: lock,
    };
    await expect(repository.saveVersion(plan.id, { expectedRevision: 0, expectedConfigHash: configHash, reason: "initial", evaluationHash: digest("8"), evaluatedAt: issued.evaluatedAt, evaluationLock: lock })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.saveVersion(plan.id, { expectedRevision: 0, expectedConfigHash: configHash, reason: "initial", evaluationHash: issued.evaluationHash, evaluatedAt: "2026-08-28T00:02:00.000Z", evaluationLock: lock })).rejects.toMatchObject({ code: "invalid_input" });
    const version = await repository.saveVersion(plan.id, { expectedRevision: 0, expectedConfigHash: configHash, reason: "initial", evaluationHash: issued.evaluationHash, evaluatedAt: issued.evaluatedAt, evaluationLock: lock });
    expect(version.evaluationLock).toEqual(lock);
    const restarted = new FilePlanRepository({ root, factGraphEnabled: true, verifyEvaluationLock: (candidate) => accepted.has(candidate.contentHash), verifyIssuedEvaluation: (proof) => JSON.stringify(proof) === JSON.stringify(issued) });
    await expect(restarted.listVersions(plan.id)).resolves.toMatchObject([{ evaluationLock: lock }]);
    accepted.clear();
    await expect(restarted.listVersions(plan.id)).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("composes the real fact, observation and evaluation-lock repositories on one runtime generation", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-plan-fact-runtime-")); roots.push(runtimeRoot);
    const authority = {
      evaluator: async (input: import("../src/server/evaluation-service").GovernedEvaluationInput) => ({
        evaluation: { config: structuredClone(input.config), findings: [], price: { knownCny: 0, unknownSkuIds: [] } } as never,
        catalogVersion: "test-issued-catalog-v1",
        priceSnapshotVersion: "1.1.0:2026-08-28",
      }),
      verifyArtifact: async () => true, verifyArtifactAtRoot: async () => true,
      verifyExternalSnapshotHashes: async () => true, verifyExternalSnapshotHashesAtRoot: async () => true,
    };
    const services = createWorkspaceRepositories({
      RUNTIME_ROOT: runtimeRoot, BUILD_SIM_FACT_GRAPH_ENABLED: "true", BUILD_SIM_TOPOLOGY_V3_ENABLED: "false",
    }, authority);
    const plan = await services.repository.create({ name: "Locked runtime", config: createDefaultN6Config("draft-runtime", "2026-08-28T00:00:00.000Z") });
    const configHash = await hashPlanConfig(plan.draft.config);
    const inputHash = createHash("sha256").update("plan-fact-issued-price").digest("hex");
    const priceMaterial = {
      schemaVersion: "1.1.0", asOf: "2026-08-28", snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
      generatedAt: "2026-08-28T00:00:00.000Z", catalogVersion: "test", inputHash, priceVersion: "price-snapshot-v2", quotes: [],
    };
    const state = await services.coordinator!.readState();
    const activeRoot = services.coordinator!.activeRoot(state);
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices/latest.json"), `${JSON.stringify({ ...priceMaterial, contentHash: createHash("sha256").update(JSON.stringify(priceMaterial)).digest("hex") })}\n`, "utf8");
    const receipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "draft", expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    });
    expect(services.factUpdateNoticeService).toBeDefined();
    await expect(services.factUpdateNoticeService!.list(plan.id)).resolves.toEqual([]);
    const secondInputHash = createHash("sha256").update("plan-fact-issued-price-2").digest("hex");
    const secondPriceMaterial = {
      ...priceMaterial,
      snapshotId: `price-snapshot-${secondInputHash.slice(0, 20)}`,
      inputHash: secondInputHash,
    };
    await writeFile(path.join(activeRoot, "prices/latest.json"), `${JSON.stringify({
      ...secondPriceMaterial,
      contentHash: createHash("sha256").update(JSON.stringify(secondPriceMaterial)).digest("hex"),
    })}\n`, "utf8");
    const currentReceipt = await services.evaluationPipeline!.evaluateCurrent({
      planId: plan.id,
      target: { kind: "draft", expectedDraftRevision: plan.draftRevision, expectedConfigHash: configHash },
    });
    await expect(services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision, expectedConfigHash: configHash, reason: "initial",
      evaluationHash: digest("7"), evaluatedAt: currentReceipt.evaluatedAt, evaluationLock: currentReceipt.evaluationLock,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision, expectedConfigHash: configHash, reason: "initial",
      evaluationHash: currentReceipt.evaluationHash, evaluatedAt: "2026-08-28T00:01:00.000Z", evaluationLock: currentReceipt.evaluationLock,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision, expectedConfigHash: configHash, reason: "initial",
      evaluationHash: receipt.evaluationHash, evaluatedAt: receipt.evaluatedAt, evaluationLock: currentReceipt.evaluationLock,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(services.repository.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision, expectedConfigHash: configHash, reason: "initial",
      evaluationHash: currentReceipt.evaluationHash, evaluatedAt: currentReceipt.evaluatedAt, evaluationLock: currentReceipt.evaluationLock,
    })).resolves.toMatchObject({ evaluationLock: currentReceipt.evaluationLock });

    const restarted = createWorkspaceRepositories({
      RUNTIME_ROOT: runtimeRoot, BUILD_SIM_FACT_GRAPH_ENABLED: "true", BUILD_SIM_TOPOLOGY_V3_ENABLED: "false",
    }, authority);
    await expect(restarted.repository.listVersions(plan.id)).resolves.toMatchObject([{ evaluationLock: currentReceipt.evaluationLock }]);
    await expect(restarted.factUpdateNoticeService!.list(plan.id)).resolves.toEqual([]);
  });
});
