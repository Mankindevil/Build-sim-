import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortablePlanPackage, openPortablePlanPackage, planPortableImport } from "../src/portability";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json } from "../src/runtime/fs.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import { createPlanPartialEvaluationV3 } from "../src/plans/evaluation";
import { hashPlanConfig } from "../src/plans/canonical";
import type { BuildConfigV3 } from "../src/topology/contracts";
import { rewriteEncryptedPortablePackage } from "./helpers/rewrite-encrypted-backup";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 portable package offline envelope", () => {
  it("authenticates all bytes and contains no plaintext plan fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-portable-envelope-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => "2026-08-30T00:00:00.000Z" }); const state = await coordinator.initialize("test");
    const planId = "plan-private"; const config = createEmptyBuildConfigV3(planId, "PRIVATE_PORTABLE_NAME", "2026-08-30T00:00:00.000Z");
    const plan = { schemaVersion: "1.0.0", id: planId, name: "PRIVATE_PORTABLE_NAME", status: "active", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", activeVersionId: null, draftRevision: 0, draft: { schemaVersion: "1.0.0", baseVersionId: null, config, evidenceBindings: [], dirty: true, updatedAt: "2026-08-30T00:00:00.000Z" }, metadata: {} };
    await atomicWriteJson(confined(coordinator.activeRoot(state), "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
    const output = path.join(root, "private.buildsim"); const password = "portable private password";
    await createPortablePlanPackage({ coordinator, outputFile: output, password, planId, portableProfile: "slim", now: () => "2026-08-30T00:00:00.000Z" });
    const bytes = await readFile(output, "utf8"); expect(bytes).not.toContain("PRIVATE_PORTABLE_NAME");
    await expect(openPortablePlanPackage(output, "wrong portable password")).rejects.toThrow("authentication failed");
    const parsed = JSON.parse(bytes); parsed.ciphertextBase64 = `${parsed.ciphertextBase64.slice(0, -4)}AAAA`;
    const tampered = path.join(root, "tampered.buildsim"); await writeFile(tampered, JSON.stringify(parsed), { mode: 0o600 });
    await expect(openPortablePlanPackage(tampered, password)).rejects.toThrow("ciphertext is invalid");
  });

  it("exports a complete governed closure and replays it in an otherwise empty installation", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "buildsim-portable-complete-source-")); roots.push(sourceRoot);
    const services = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: sourceRoot,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
    }, {
      evaluator: vi.fn(async (input) => ({ evaluation: createPlanPartialEvaluationV3(input.config as BuildConfigV3), catalogVersion: "portable-complete", priceSnapshotVersion: null })),
      verifyArtifact: async () => true,
      verifyArtifactAtRoot: async () => true,
      verifyExternalSnapshotHashes: async () => true,
      verifyExternalSnapshotHashesAtRoot: async () => true,
    });
    await services.coordinator!.initialize(); await initializeRuntimeCatalog({ coordinator: services.coordinator!, generationAware: true });
    const priceInputHash = createHash("sha256").update("portable-complete-price").digest("hex");
    const priceMaterial = { schemaVersion: "1.1.0", asOf: "2026-08-30", snapshotId: `price-snapshot-${priceInputHash.slice(0, 20)}`, generatedAt: "2026-08-30T00:00:00.000Z", catalogVersion: "portable", inputHash: priceInputHash, priceVersion: "price-snapshot-v2", quotes: [] };
    await services.coordinator!.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await mkdir(path.join(activeRoot, "prices"), { recursive: true });
      await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify({ ...priceMaterial, contentHash: createHash("sha256").update(JSON.stringify(priceMaterial)).digest("hex") })}\n`);
    });
    const config = createEmptyBuildConfigV3("plan-complete", "Complete portable", "2026-08-30T00:00:00.000Z");
    const created = await services.repository.create({ name: config.name, config });
    const configHash = await hashPlanConfig(created.draft.config);
    const receipt = await services.evaluationPipeline!.evaluateCurrent({ planId: created.id, target: { kind: "draft", expectedDraftRevision: created.draftRevision, expectedConfigHash: configHash } });
    const sourceVersion = await services.repository.saveVersion(created.id, { expectedRevision: created.draftRevision, expectedConfigHash: configHash, reason: "initial", evaluationHash: receipt.evaluationHash, evaluatedAt: receipt.evaluatedAt, evaluationLock: receipt.evaluationLock });
    const pinnedReceipt = await services.evaluationPipeline!.evaluateCurrent({ planId: created.id, target: { kind: "version", versionId: sourceVersion.id, expectedConfigHash: sourceVersion.configHash } });

    const output = path.join(sourceRoot, "complete.buildsim"); const password = "complete portable password";
    const exported = await createPortablePlanPackage({ coordinator: services.coordinator!, outputFile: output, password, planId: created.id, portableProfile: "complete", redacted: true, now: () => "2026-08-30T00:00:00.000Z" });
    expect(exported.exactReplayReady).toBe(true);
    const opened = await openPortablePlanPackage(output, password);
    expect(opened).toMatchObject({ exactReplayReady: true, payload: { manifest: { portableProfile: "complete", evaluationHashes: [receipt.evaluationHash] } } });
    const missingArtifact = path.join(sourceRoot, "complete-missing-artifact.buildsim");
    await rewriteEncryptedPortablePackage({
      inputFile: output,
      outputFile: missingArtifact,
      password,
      mutate(payload) {
        const files = payload.files as Array<{ logicalPath: string }>;
        const victim = files.find(({ logicalPath }) => logicalPath.startsWith("snapshots/evaluation-artifacts/") || logicalPath.startsWith("artifacts/blobs/"));
        if (!victim) throw new Error("complete fixture has no replay artifact file");
        payload.files = files.filter(({ logicalPath }) => logicalPath !== victim.logicalPath);
        const manifest = payload.manifest as { entries: Array<{ logicalPath: string }> };
        manifest.entries = manifest.entries.filter(({ logicalPath }) => logicalPath !== victim.logicalPath);
      },
    });
    await expect(openPortablePlanPackage(missingArtifact, password)).rejects.toThrow("staged authority validation failed");

    const targetRoot = await mkdtemp(path.join(tmpdir(), "buildsim-portable-complete-target-")); roots.push(targetRoot);
    const target = new RuntimeCoordinator({ root: targetRoot, now: () => "2026-08-30T00:00:01.000Z" }); await target.initialize("test");
    const imported = await planPortableImport({ coordinator: target, inputFile: output, password, mode: "apply" });
    expect(imported).toMatchObject({ importedPlanId: created.id, plan: { resultMode: "exact_replay" }, state: { runtimeGeneration: 2 } });
    const restored = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: targetRoot,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
    }, {
      evaluator: vi.fn(async () => { throw new Error("offline exact replay must not execute the evaluator"); }),
      verifyArtifact: async () => true,
      verifyArtifactAtRoot: async () => true,
      verifyExternalSnapshotHashes: async () => true,
      verifyExternalSnapshotHashesAtRoot: async () => true,
    });
    const saved = (await restored.repository.listVersions(created.id))[0]!;
    const replay = await restored.evaluationPipeline!.evaluateCurrent({ planId: created.id, target: { kind: "version", versionId: saved.id, expectedConfigHash: saved.configHash } });
    expect(replay).toMatchObject({ cacheStatus: "hit", evaluationHash: pinnedReceipt.evaluationHash });
  }, 30_000);
});
