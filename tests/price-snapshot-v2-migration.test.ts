import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import {
  applyPriceSnapshotV2Migration,
  planPriceSnapshotV2Migration,
} from "../scripts/migrations/migrate-price-snapshot-v2";
import { verifyBackup } from "../src/backup/runtime.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, pathExists } from "../src/runtime/fs.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";

const roots: string[] = [];
const NOW = "2026-08-30T13:00:00.000Z";
const AS_OF = "2026-08-30";
const PASSWORD = "price snapshot migration rehearsal password";

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function legacySnapshot() {
  const material = {
    schemaVersion: "1.0.0",
    asOf: "2026-08-21",
    note: "Legacy archive fixture; it must never become current without governed observations.",
    quotes: [{
      skuId: "case.jonsbo-n6",
      platform: "jd",
      priceCny: 799,
      currency: "CNY",
      evidence: "audited",
      priceKind: "variant",
      match: "manual",
      listingUrl: "https://example.invalid/legacy-price",
      variantLabel: "legacy-unbound",
      fetchedAt: "2026-08-21T00:00:00.000Z",
    }],
  };
  const contentHash = createHash("sha256").update(JSON.stringify(material)).digest("hex");
  return { ...material, contentHash };
}

async function fixture(prefix: string) {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(runtimeRoot);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => NOW });
  await coordinator.initialize("0.2.0-alpha");
  await initializeRuntimeCatalog({ coordinator, generationAware: true });
  const state = await coordinator.readState();
  const activeRoot = coordinator.activeRoot(state);
  const legacy = legacySnapshot();
  await coordinator.withWrite(async ({ activeRoot: root }: { activeRoot: string }) => {
    await atomicWriteJson(confined(root, "prices", "latest.json"), legacy);
  });
  return { runtimeRoot, coordinator, legacy, activeRoot };
}

describe("U12 current price snapshot v2 migration", () => {
  it("dry-runs without writes, requires the reviewed source, archives legacy bytes, and rebuilds only from governed observations", async () => {
    const { runtimeRoot, coordinator, legacy } = await fixture("buildsim-price-v2-migration-");
    const stateBefore = await coordinator.readState();
    const rootBefore = coordinator.activeRoot(stateBefore);
    const latestPath = confined(rootBefore, "prices", "latest.json");
    const legacyBytes = await readFile(latestPath);
    const graphBefore = await createProductionReferenceGraph({ coordinator, now: () => NOW });

    const preview = await planPriceSnapshotV2Migration({ runtimeRoot, asOf: AS_OF, now: () => NOW });
    expect(preview).toMatchObject({
      mode: "dry-run",
      status: "ready",
      asOf: AS_OF,
      source: { latestStatus: "legacy_v1", contentHash: legacy.contentHash, quoteCount: 1 },
      plan: {
        action: "archive_and_rebuild",
        archiveRef: `prices/snapshots/legacy-${legacy.contentHash}.json`,
        governedCaptureCount: 0,
        governedObservationCount: 0,
        selectedObservationIds: [],
        projectedQuoteCount: 0,
      },
      backup: null,
      result: null,
    });
    expect(await coordinator.readState()).toEqual(stateBefore);
    expect(await readFile(latestPath)).toEqual(legacyBytes);
    expect(await createProductionReferenceGraph({ coordinator, now: () => NOW })).toEqual(graphBefore);

    const backupRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-price-v2-backup-"));
    roots.push(backupRoot);
    const wrongBackup = path.join(backupRoot, "wrong-source.backup");
    await expect(applyPriceSnapshotV2Migration({
      runtimeRoot,
      asOf: AS_OF,
      expectedSourceManifestHash: "0".repeat(64),
      backupOutput: wrongBackup,
      password: PASSWORD,
      now: () => NOW,
    })).rejects.toThrow(/source manifest changed/);
    expect(await pathExists(wrongBackup)).toBe(false);
    expect(await readFile(latestPath)).toEqual(legacyBytes);

    const backupOutput = path.join(backupRoot, `price-v2-${preview.sourceManifestHash.slice(0, 12)}.backup`);
    const applied = await applyPriceSnapshotV2Migration({
      runtimeRoot,
      asOf: AS_OF,
      expectedSourceManifestHash: preview.sourceManifestHash,
      backupOutput,
      password: PASSWORD,
      now: () => NOW,
    });
    expect(applied).toMatchObject({
      mode: "apply",
      status: "completed",
      backup: { verificationResult: "pass" },
      result: {
        snapshotId: expect.stringMatching(/^price-snapshot-[a-f0-9]{20}$/),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        quoteCount: 0,
        archiveRef: `prices/snapshots/legacy-${legacy.contentHash}.json`,
      },
    });
    const afterState = await coordinator.readState();
    const afterRoot = coordinator.activeRoot(afterState);
    const current = JSON.parse(await readFile(confined(afterRoot, "prices", "latest.json"), "utf8"));
    expect(current).toMatchObject({ priceVersion: "price-snapshot-v2", asOf: AS_OF, quotes: [] });
    expect(await readFile(confined(afterRoot, "prices", "snapshots", `legacy-${legacy.contentHash}.json`))).toEqual(legacyBytes);
    await expect(verifyBackup({ inputFile: backupOutput, password: PASSWORD, now: () => NOW }))
      .resolves.toMatchObject({ valid: true, report: { result: "pass" } });
    await expect(createProductionReferenceGraph({ coordinator, now: () => NOW })).resolves.toMatchObject({
      nodes: expect.arrayContaining([`price-snapshot:legacy-${legacy.contentHash}`, `price-snapshot:${current.snapshotId}`]),
    });

    const replayPreview = await planPriceSnapshotV2Migration({ runtimeRoot, asOf: AS_OF, now: () => NOW });
    expect(replayPreview).toMatchObject({ source: { latestStatus: "current_v2" }, plan: { action: "no_change" } });
    const unusedBackup = path.join(backupRoot, "idempotent-noop.backup");
    await expect(applyPriceSnapshotV2Migration({
      runtimeRoot,
      asOf: AS_OF,
      expectedSourceManifestHash: replayPreview.sourceManifestHash,
      backupOutput: unusedBackup,
      password: PASSWORD,
      now: () => NOW,
    })).resolves.toMatchObject({ status: "completed", backup: null, result: { snapshotId: current.snapshotId } });
    expect(await pathExists(unusedBackup)).toBe(false);
  }, 60_000);

  it("restores the verified pre-migration runtime when a write-stage failure is injected", async () => {
    const { runtimeRoot, coordinator, legacy } = await fixture("buildsim-price-v2-rollback-");
    const beforeState = await coordinator.readState();
    const beforeRoot = coordinator.activeRoot(beforeState);
    const beforeLatest = await readFile(confined(beforeRoot, "prices", "latest.json"));
    const preview = await planPriceSnapshotV2Migration({ runtimeRoot, asOf: AS_OF, now: () => NOW });
    const backupRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-price-v2-failed-backup-"));
    roots.push(backupRoot);
    const backupOutput = path.join(backupRoot, "failed-apply.backup");

    await expect(applyPriceSnapshotV2Migration({
      runtimeRoot,
      asOf: AS_OF,
      expectedSourceManifestHash: preview.sourceManifestHash,
      backupOutput,
      password: PASSWORD,
      now: () => NOW,
      injectFailureAt: "after_rebuild",
    })).rejects.toThrow(/verified backup was restored/);

    const afterState = await coordinator.readState();
    expect(afterState.runtimeGeneration).toBeGreaterThan(beforeState.runtimeGeneration);
    const afterRoot = coordinator.activeRoot(afterState);
    expect(await readFile(confined(afterRoot, "prices", "latest.json"))).toEqual(beforeLatest);
    expect(await pathExists(confined(afterRoot, "prices", "snapshots", `legacy-${legacy.contentHash}.json`))).toBe(false);
    await expect(createProductionReferenceGraph({ coordinator, now: () => NOW })).resolves.toBeDefined();
    await expect(verifyBackup({ inputFile: backupOutput, password: PASSWORD, now: () => NOW }))
      .resolves.toMatchObject({ valid: true, report: { result: "pass" } });
  }, 60_000);

  it("does not restore over an unrelated writer when the runtime changes after backup", async () => {
    const { runtimeRoot, coordinator, legacy } = await fixture("buildsim-price-v2-race-");
    const preview = await planPriceSnapshotV2Migration({ runtimeRoot, asOf: AS_OF, now: () => NOW });
    const before = await coordinator.readState();
    const backupRoot = await mkdtemp(path.join(os.tmpdir(), "buildsim-price-v2-race-backup-"));
    roots.push(backupRoot);

    await expect(applyPriceSnapshotV2Migration({
      runtimeRoot,
      asOf: AS_OF,
      expectedSourceManifestHash: preview.sourceManifestHash,
      backupOutput: path.join(backupRoot, "race.backup"),
      password: PASSWORD,
      now: () => NOW,
      afterBackup: async () => {
        await coordinator.withWrite(async () => undefined);
      },
    })).rejects.toThrow(/source changed before commit/);

    const after = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(after);
    expect(after.runtimeGeneration).toBe(before.runtimeGeneration);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(JSON.parse(await readFile(confined(activeRoot, "prices", "latest.json"), "utf8"))).toEqual(legacy);
    expect(await pathExists(confined(activeRoot, "prices", "snapshots", `legacy-${legacy.contentHash}.json`))).toBe(false);
  }, 60_000);
});
