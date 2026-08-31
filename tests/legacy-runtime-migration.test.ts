import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLegacyRuntimeMigration,
  cliSummary,
  mapLegacyRuntimePath,
  planLegacyRuntimeMigration,
  planLegacyRuntimeRollback,
  preflightLegacyRuntimeMigration,
  rollbackLegacyRuntimeMigration,
  verifyLegacyRuntimeMigration,
} from "../scripts/migrations/migrate-runtime-v1.mjs";
import { createBackup } from "../src/backup/runtime.mjs";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanRepository } from "../src/plans/file-repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Bytes, sha256Json } from "../src/runtime/fs.mjs";
import { FileAgentSessionStore } from "../src/server/file-session-store";
import { listTransactionArchives } from "../scripts/price-server/transactions/archive.mjs";

const roots: string[] = [];
const LEGACY_CATALOG_HASH = "faccd64f63a9483862777ec032d175955e63598152da6457aba547ec98d5cc99";

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-legacy-runtime-v1-"));
  roots.push(root);
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function privateTextAtRoot(root: string): Promise<string> {
  const chunks: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) chunks.push((await readFile(target)).toString("utf8"));
    }
  }
  await visit(root);
  return chunks.join("\n");
}

function historicalCatalog(): Buffer {
  // 0a29861:data/skus/catalog.json is blob 5293e2e…. Reading the loose
  // object first keeps sandboxed tests from spawning a subprocess; normal CI
  // clones may fall back to git when the same object is packed.
  const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
  const looseObject = path.join(repositoryRoot, ".git/objects/52/93e2ea0d6a1cbebb153bafc0d1c40232016e77");
  try {
    const inflated = inflateSync(readFileSync(looseObject));
    const separator = inflated.indexOf(0);
    if (inflated.subarray(0, separator).toString("utf8") !== "blob 59495") throw new Error("historical catalog blob header mismatch");
    return inflated.subarray(separator + 1);
  } catch {
    // Packed-object fallback for ordinary CI runners.
  }
  return execFileSync("git", ["show", "0a29861:data/skus/catalog.json"], {
    cwd: repositoryRoot,
  });
}

async function legacyFixture(root: string, includeCatalog = true): Promise<string | undefined> {
  const now = "2026-08-27T00:00:00.000Z";
  const rawReceiptImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
  const planPayload = {
    schemaVersion: "1.0.0", id: "plan-fixture", name: "Migration fixture", status: "active",
    createdAt: now, updatedAt: now, activeVersionId: null, draftRevision: 0,
    draft: { schemaVersion: "1.0.0", baseVersionId: null, config: createDefaultN6Config("draft", now), evidenceBindings: [], dirty: true, updatedAt: now },
    metadata: {},
  };
  await writeJson(path.join(root, "plans/plan-fixture/plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(planPayload), payload: planPayload });
  const invalidConfigPlanPayload = {
    ...planPayload,
    id: "plan-invalid-config",
    draft: { ...planPayload.draft, config: {} },
  };
  await writeJson(path.join(root, "plans/plan-invalid-config/plan.json"), {
    schemaVersion: "1.0.0",
    kind: "plan",
    checksum: sha256Json(invalidConfigPlanPayload),
    payload: invalidConfigPlanPayload,
  });
  await writeJson(path.join(root, "plans/bogus-plan/plan.json"), { schemaVersion: "1.0.0", planId: "bogus-plan" });
  await writeJson(path.join(root, "plans/.agent-context-audit/context.json"), { schemaVersion: "1.0.0", eventHash: "a".repeat(64) });
  await writeJson(path.join(root, "evidence/captures/capture.json"), { schemaVersion: "1.0.0", captureId: "capture-fixture" });
  await writeJson(path.join(root, "evidence/backups/legacy.json"), { schemaVersion: "1.0.0", status: "old" });
  const sessionPayload = { id: "session-fixture", contractVersion: "1.0.0", provider: "deepseek", model: "fixture", messages: [{ id: "message-fixture", role: "user", content: "private fixture", createdAt: now }], buildConfig: null, createdAt: now, updatedAt: now };
  await writeJson(path.join(root, "agent/sessions/session-fixture.json"), { schemaVersion: "agent-session-v1", payload: sessionPayload, contentHash: sha256Bytes(JSON.stringify(sessionPayload)) });
  await writeJson(path.join(root, "agent/sessions/bogus-session.json"), { schemaVersion: "1.0.0", messages: [] });
  await writeJson(path.join(root, "audit/events.json"), { schemaVersion: "1.0.0", events: [] });
  const transactionItem = (receiptId: string, overrides: Record<string, unknown> = {}) => ({
    id: `item-${receiptId}`,
    skuId: null,
    name: "Migration fixture item",
    category: "accessory",
    qty: 1,
    unitPriceCny: null,
    stage: "purchased",
    source: "transaction",
    transaction: {
      receiptId,
      fileName: "",
      contentHash: "a".repeat(64),
      capturedAt: now,
      ocrEngine: "legacy-fixture",
      ocrConfidence: null,
      excerpt: "migration evidence",
      verification: "identity-review-required",
      catalogJobId: null,
      candidateId: null,
      draftId: null,
      officialUrl: null,
    },
    ...overrides,
  });
  await writeJson(path.join(root, "transactions/tx-fixture.json"), {
    schemaVersion: 1, receiptId: "tx-fixture", storedAt: now, updatedAt: now,
    item: transactionItem("tx-fixture"), image: null,
  });
  await writeJson(path.join(root, "transactions/tx-image-summary.json"), {
    schemaVersion: 1, receiptId: "tx-image-summary", storedAt: now, updatedAt: now,
    customerName: "fixture-person",
    item: transactionItem("tx-image-summary", {
      id: "item-image",
      transaction: {
        ...transactionItem("tx-image-summary").transaction,
        fileName: "legacy-receipt.png",
        contentHash: sha256Bytes(rawReceiptImage),
        excerpt: "evidence",
        imageBase64: `data:image/png;base64,${rawReceiptImage.toString("base64")}`,
      },
    }),
    image: { storageName: "legacy-receipt.png", mimeType: "image/png", bytes: rawReceiptImage.length, contentHash: sha256Bytes(rawReceiptImage) },
  });
  await writeJson(path.join(root, "transactions/tx-private-null.json"), {
    schemaVersion: 1, receiptId: "tx-private-null", storedAt: now, updatedAt: now,
    customerName: "张三", phone: "13812345678", email: "private@example.com",
    shippingAddress: "北京市朝阳区测试路88号",
    item: transactionItem("tx-private-null", { name: "联系人张三 电话13812345678" }),
    image: null,
  });
  await writeFile(path.join(root, "transactions/legacy-receipt.png"), rawReceiptImage);
  await writeJson(path.join(root, "transactions/bogus.json"), { schemaVersion: "1.0.0", planId: null });
  await writeJson(path.join(root, "advice/jobs/advice.json"), { schemaVersion: "1.0.0", status: "complete" });
  await writeJson(path.join(root, "advice/jobs/advice-fixture.json"), {
    requestId: "advice-fixture", status: "completed", provider: "deepseek", model: "fixture",
    promptVersion: "deepseek-advice-v1", inputHash: "b".repeat(64), engineHash: "c".repeat(64),
    deterministic: { verdict: "unknown" }, calls: [], generatedAt: now,
  });
  await writeJson(path.join(root, "data/catalog-drafts/candidate.json"), { schemaVersion: "1.0.0", candidateId: "candidate-fixture" });
  await writeJson(path.join(root, "data/catalog-candidates/unverified.json"), { schemaVersion: "legacy", candidateId: "unverified" });
  await writeJson(path.join(root, "config/provider.json"), { apiKey: "fixture" });
  await writeFile(path.join(root, ".env"), Buffer.from("ignored=true\n"));
  if (!includeCatalog) return undefined;
  const catalogPath = path.join(root, "data/skus/catalog.json");
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, historicalCatalog());
  return catalogPath;
}

function catalogOptions(legacyCatalogPath: string | undefined): Record<string, string> {
  return legacyCatalogPath ? {
    legacyCatalogPath,
    expectedLegacyCatalogHash: LEGACY_CATALOG_HASH,
    catalogStaticManifestPath: path.resolve(new URL("../data/migrations/catalog-user-data-v1.json", import.meta.url).pathname),
  } : {};
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U1 explicit legacy runtime migration", () => {
  it("uses an explicit authority map and quarantines ambiguous legacy paths", () => {
    expect(mapLegacyRuntimePath("plans/plan-a/plan.json")).toEqual({ disposition: "repository", destination: "plans/plan-a/plan.json" });
    expect(mapLegacyRuntimePath("data/catalog-drafts/candidate.json")).toEqual({ disposition: "repository", destination: "catalog-overlays/drafts/candidate.json" });
    expect(mapLegacyRuntimePath("data/catalog-domain-proposals/proposals.json")).toEqual({ disposition: "repository", destination: "domain-overlays/proposals.json" });
    expect(mapLegacyRuntimePath("advice/jobs/job.json")).toEqual({ disposition: "repository", destination: "audit/advice-jobs/job.json" });
    expect(mapLegacyRuntimePath("plans/.agent-context-audit/event.json")).toMatchObject({ disposition: "quarantine" });
    expect(mapLegacyRuntimePath("evidence/backups/old.json")).toMatchObject({ disposition: "quarantine" });
    expect(mapLegacyRuntimePath("data/catalog-candidates/old.json")).toMatchObject({ disposition: "quarantine" });
    expect(mapLegacyRuntimePath(".env")).toEqual({ disposition: "excluded_secret", destination: null });
  });

  it("provides a zero-write fail-closed service preflight", async () => {
    const root = await tempRoot();
    await expect(preflightLegacyRuntimeMigration({ runtimeRoot: root })).resolves.toMatchObject({ status: "ready_fresh" });
    await writeJson(path.join(root, "audit/legacy.json"), { schemaVersion: "1.0.0", events: [] });
    await expect(preflightLegacyRuntimeMigration({ runtimeRoot: root })).rejects.toThrow(/migration is required/);
    const plan = await planLegacyRuntimeMigration({ runtimeRoot: root });
    await applyLegacyRuntimeMigration({ runtimeRoot: root, expectedSourceManifestHash: plan.sourceManifestHash });
    await expect(preflightLegacyRuntimeMigration({ runtimeRoot: root })).resolves.toMatchObject({ status: "ready_migrated", runtimeGeneration: 2 });
    const migratedCoordinator = new RuntimeCoordinator({ root });
    await migratedCoordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => atomicWriteJson(confined(activeRoot, "audit/ordinary-write.json"), { current: true }));
    await expect(preflightLegacyRuntimeMigration({ runtimeRoot: root })).resolves.toMatchObject({ status: "ready_migrated", runtimeGeneration: 2 });
    await writeJson(path.join(root, "audit/new-legacy-write.json"), { schemaVersion: "1.0.0", events: [] });
    await expect(preflightLegacyRuntimeMigration({ runtimeRoot: root })).rejects.toThrow(/verification is required/);

    const activeRoot = await tempRoot();
    await new RuntimeCoordinator({ root: activeRoot }).initialize();
    await writeJson(path.join(activeRoot, "release-evidence/external-reviews/review.json"), { immutable: true });
    await expect(preflightLegacyRuntimeMigration({ runtimeRoot: activeRoot })).resolves.toMatchObject({ status: "ready_active", runtimeGeneration: 1 });
  });

  it("is zero-write by default and binds apply to an exact inventory and governed historical catalog", async () => {
    const root = await tempRoot();
    const catalogPath = await legacyFixture(root);
    const plan = await planLegacyRuntimeMigration({ runtimeRoot: root, ...catalogOptions(catalogPath) });
    const repeated = await planLegacyRuntimeMigration({ runtimeRoot: root, ...catalogOptions(catalogPath) });

    expect(plan).toMatchObject({
      mode: "dry-run",
      status: "ready",
      catalog: { sourceHash: LEGACY_CATALOG_HASH, removedFieldCount: 23, quarantineCount: 10 },
    });
    expect(plan.sourceManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.summary).toMatchObject({ secretPathCount: 1, symlinkCount: 0 });
    expect(repeated.sourceManifestHash).toBe(plan.sourceManifestHash);
    expect(await stat(path.join(root, "control")).catch(() => null)).toBeNull();
    const publicOutput = JSON.stringify(cliSummary(plan));
    expect(JSON.parse(publicOutput)).not.toHaveProperty("sourceManifest");
    for (const sensitive of [".env", "config/provider.json", "fixture-person", "private fixture", root]) {
      expect(publicOutput).not.toContain(sensitive);
    }

    await writeJson(path.join(root, "plans/newer-write.json"), { changed: true });
    await expect(applyLegacyRuntimeMigration({
      runtimeRoot: root,
      expectedSourceManifestHash: plan.sourceManifestHash,
      ...catalogOptions(catalogPath),
    })).rejects.toThrow(/source manifest hash mismatch/);
  });

  it("copies through staging, commits one pointer, preserves legacy bytes, and includes private catalog quarantine in full backup", async () => {
    const root = await tempRoot();
    const catalogPath = await legacyFixture(root);
    const plan = await planLegacyRuntimeMigration({ runtimeRoot: root, ...catalogOptions(catalogPath) });
    const sourcePlanBytes = await readFile(path.join(root, "plans/plan-fixture/plan.json"));
    const sourceCatalogBytes = await readFile(catalogPath!);
    const committed = await applyLegacyRuntimeMigration({
      runtimeRoot: root,
      expectedSourceManifestHash: plan.sourceManifestHash,
      ...catalogOptions(catalogPath),
    });
    const coordinator = new RuntimeCoordinator({ root });
    const state = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(state);

    expect(committed).toMatchObject({ status: "committed", targetActiveRoot: "generations/2", targetRuntimeGeneration: 2 });
    expect(await readFile(path.join(root, "plans/plan-fixture/plan.json"))).toEqual(sourcePlanBytes);
    expect(await readFile(catalogPath!)).toEqual(sourceCatalogBytes);
    expect(await readFile(confined(activeRoot, "plans/plan-fixture/plan.json"))).toEqual(sourcePlanBytes);
    expect(await stat(confined(activeRoot, "plans/plan-fixture/plan.json")).then((value) => value.mode & 0o777)).toBe(0o600);
    expect(await stat(confined(activeRoot, "plans/plan-fixture")).then((value) => value.mode & 0o777)).toBe(0o700);
    expect(await stat(confined(activeRoot, ".env")).catch(() => null)).toBeNull();
    expect(await stat(confined(activeRoot, "config/provider.json")).catch(() => null)).toBeNull();
    expect(await stat(confined(activeRoot, "catalog-overlays/drafts/candidate.json")).catch(() => null)).toBeNull();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/data/catalog-drafts/candidate.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "audit/advice-jobs/advice-fixture.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "audit/advice-jobs/advice.json")).catch(() => null)).toBeNull();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/advice/jobs/advice.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "agent/sessions/session-fixture.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "transactions/tx-fixture.json"))).toBeTruthy();
    const projectedTransaction = JSON.parse(await readFile(confined(activeRoot, "transactions/tx-image-summary.json"), "utf8"));
    expect(projectedTransaction).toMatchObject({ image: null, imageEvidence: { persistence: "legacy_source_retained_not_copied" } });
    expect(projectedTransaction).not.toHaveProperty("screenshotDataUrl");
    expect(projectedTransaction).not.toHaveProperty("customerName");
    expect(projectedTransaction.item.transaction.fileName).toBe("");
    expect(projectedTransaction.item.transaction).not.toHaveProperty("imageBase64");
    expect(JSON.stringify(projectedTransaction)).not.toContain("legacy-receipt.png");
    expect(await stat(confined(activeRoot, "transactions/legacy-receipt.png")).catch(() => null)).toBeNull();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/transactions/legacy-receipt.png")).catch(() => null)).toBeNull();
    expect(await stat(path.join(root, "transactions/legacy-receipt.png"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "transactions/tx-private-null.json")).catch(() => null)).toBeNull();
    const privateNullQuarantine = await readFile(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/transactions/tx-private-null.json"), "utf8");
    expect(privateNullQuarantine).not.toMatch(/张三|13812345678|private@example\.com|北京市朝阳区测试路88号/);
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/evidence/captures/capture.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/plans/bogus-plan/plan.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "plans/plan-invalid-config/plan.json")).catch(() => null)).toBeNull();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/plans/plan-invalid-config/plan.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/agent/sessions/bogus-session.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/transactions/bogus.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/evidence/backups/legacy.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/plans/.agent-context-audit/context.json"))).toBeTruthy();
    expect(await stat(confined(activeRoot, "migrations/quarantine/legacy-runtime-v1/data/catalog-candidates/unverified.json"))).toBeTruthy();
    const migratedPlans = new FilePlanRepository({ root: confined(activeRoot, "plans") });
    await expect(migratedPlans.get("plan-fixture")).resolves.toMatchObject({ id: "plan-fixture" });
    await expect(migratedPlans.list()).resolves.toEqual([
      expect.objectContaining({ id: "plan-fixture" }),
    ]);
    await expect(new FileAgentSessionStore({ root: confined(activeRoot, "agent/sessions") }).get("session-fixture")).resolves.toMatchObject({ id: "session-fixture" });
    await expect(listTransactionArchives({ root: confined(activeRoot, "transactions") })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: "tx-fixture" }),
      expect.objectContaining({ receiptId: "tx-image-summary", image: null }),
    ]));
    const activePrivateText = await privateTextAtRoot(activeRoot);
    for (const canary of ["张三", "13812345678", "private@example.com", "北京市朝阳区测试路88号"]) {
      expect(activePrivateText).not.toContain(canary);
    }

    const privateCatalogPath = confined(activeRoot, "migrations/catalog-user-data-v1/quarantine/catalog-user-data.json");
    const privateCatalog = JSON.parse(await readFile(privateCatalogPath, "utf8"));
    expect(privateCatalog).toMatchObject({
      schemaVersion: "catalog-user-data-quarantine-envelope-v1",
      kind: "catalog-user-data-quarantine",
      payload: { sourceCatalogHash: LEGACY_CATALOG_HASH, removedFieldCount: 23 },
    });
    expect(privateCatalog.payload.entries).toHaveLength(10);
    expect(privateCatalog.checksum).toBe(sha256Json(privateCatalog.payload));
    expect(await stat(privateCatalogPath).then((value) => value.mode & 0o777)).toBe(0o600);

    await expect(verifyLegacyRuntimeMigration({ runtimeRoot: root, ...catalogOptions(catalogPath) })).resolves.toMatchObject({
      status: "verified",
      runtimeGeneration: 2,
      sourcePreserved: true,
      excludedSecretCount: 3,
    });
    const backup = await createBackup({
      coordinator,
      outputFile: path.join(root, "migration.backup"),
      password: "migration fixture backup password",
      backupId: "backup-legacy-runtime-migration",
    });
    expect(backup.manifest.entries.map((entry: { logicalPath: string }) => entry.logicalPath)).toContain(
      "migrations/catalog-user-data-v1/quarantine/catalog-user-data.json",
    );
  });

  it("recovers prepared and post-pointer crashes without exposing a partial generation", async () => {
    for (const testFault of ["after_prepare", "after_pointer_commit"] as const) {
      const root = await tempRoot();
      await legacyFixture(root, false);
      const plan = await planLegacyRuntimeMigration({ runtimeRoot: root });
      await expect(applyLegacyRuntimeMigration({
        runtimeRoot: root,
        expectedSourceManifestHash: plan.sourceManifestHash,
        testFault,
      })).rejects.toThrow(/injected migration failure/);
      const recovered = await applyLegacyRuntimeMigration({
        runtimeRoot: root,
        expectedSourceManifestHash: plan.sourceManifestHash,
      });
      expect(recovered.status).toBe("committed");
      await expect(verifyLegacyRuntimeMigration({ runtimeRoot: root })).resolves.toMatchObject({ status: "verified" });
    }
  });

  it("serializes concurrent apply and fails closed on corrupt records, symlinks, and destination conflicts", async () => {
    const root = await tempRoot();
    await legacyFixture(root, false);
    const plan = await planLegacyRuntimeMigration({ runtimeRoot: root });
    const [left, right] = await Promise.all([
      applyLegacyRuntimeMigration({ runtimeRoot: root, expectedSourceManifestHash: plan.sourceManifestHash }),
      applyLegacyRuntimeMigration({ runtimeRoot: root, expectedSourceManifestHash: plan.sourceManifestHash }),
    ]);
    expect(left.status).toBe("committed");
    expect(right.status).toBe("committed");
    expect((await new RuntimeCoordinator({ root }).readState()).runtimeGeneration).toBe(2);

    const corruptRoot = await tempRoot();
    await mkdir(path.join(corruptRoot, "plans"), { recursive: true });
    await writeFile(path.join(corruptRoot, "plans/bad.json"), "{");
    const corruptPlan = await planLegacyRuntimeMigration({ runtimeRoot: corruptRoot });
    await expect(applyLegacyRuntimeMigration({ runtimeRoot: corruptRoot, expectedSourceManifestHash: corruptPlan.sourceManifestHash })).rejects.toThrow(/unreadable/);
    expect(await stat(path.join(corruptRoot, "control/active-pointer.json")).then(() => true).catch(() => false)).toBe(true);
    expect((await new RuntimeCoordinator({ root: corruptRoot }).readState()).runtimeGeneration).toBe(1);

    const symlinkRoot = await tempRoot();
    await mkdir(path.join(symlinkRoot, "plans"), { recursive: true });
    await symlink("missing", path.join(symlinkRoot, "plans/link"));
    const symlinkPlan = await planLegacyRuntimeMigration({ runtimeRoot: symlinkRoot });
    expect(symlinkPlan.status).toBe("blocked");
    await expect(applyLegacyRuntimeMigration({ runtimeRoot: symlinkRoot, expectedSourceManifestHash: symlinkPlan.sourceManifestHash })).rejects.toThrow(/symbolic link/);

    const conflictRoot = await tempRoot();
    const coordinator = new RuntimeCoordinator({ root: conflictRoot });
    const state = await coordinator.initialize();
    await atomicWriteJson(confined(coordinator.activeRoot(state), "audit/conflict.json"), { current: true });
    await writeJson(path.join(conflictRoot, "audit/conflict.json"), { legacy: true });
    const conflictPlan = await planLegacyRuntimeMigration({ runtimeRoot: conflictRoot });
    await expect(applyLegacyRuntimeMigration({ runtimeRoot: conflictRoot, expectedSourceManifestHash: conflictPlan.sourceManifestHash })).rejects.toThrow(/conflicts/);
    expect((await coordinator.readState()).runtimeGeneration).toBe(1);

    const unsafeActiveRoot = await tempRoot();
    const unsafeCoordinator = new RuntimeCoordinator({ root: unsafeActiveRoot });
    const unsafeState = await unsafeCoordinator.initialize();
    await mkdir(confined(unsafeCoordinator.activeRoot(unsafeState), "transactions"), { recursive: true });
    await writeFile(confined(unsafeCoordinator.activeRoot(unsafeState), "transactions/private.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeJson(path.join(unsafeActiveRoot, "audit/legacy.json"), { schemaVersion: "1.0.0", events: [] });
    const unsafePlan = await planLegacyRuntimeMigration({ runtimeRoot: unsafeActiveRoot });
    await expect(applyLegacyRuntimeMigration({ runtimeRoot: unsafeActiveRoot, expectedSourceManifestHash: unsafePlan.sourceManifestHash })).rejects.toThrow(/transaction image data/);
    expect((await unsafeCoordinator.readState()).runtimeGeneration).toBe(1);
  });

  it("dry-runs rollback, reactivates a verified prior generation, and rejects data-loss rollback after a newer write", async () => {
    const root = await tempRoot();
    const coordinator = new RuntimeCoordinator({ root });
    const original = await coordinator.initialize();
    await atomicWriteJson(confined(coordinator.activeRoot(original), "plans/original.json"), { original: true });
    await writeJson(path.join(root, "plans/legacy.json"), { legacy: true });
    const plan = await planLegacyRuntimeMigration({ runtimeRoot: root });
    await applyLegacyRuntimeMigration({ runtimeRoot: root, expectedSourceManifestHash: plan.sourceManifestHash });

    expect(await planLegacyRuntimeRollback({ runtimeRoot: root })).toMatchObject({
      mode: "dry-run",
      status: "ready",
      strategy: "reactivate_verified_generation",
    });
    const rolledBack = await rollbackLegacyRuntimeMigration({ runtimeRoot: root, apply: true });
    expect(rolledBack).toMatchObject({ status: "rolled_back", strategy: "reactivate_verified_generation", runtimeGeneration: 3 });
    const rollbackState = await coordinator.readState();
    expect(await stat(confined(coordinator.activeRoot(rollbackState), "plans/original.json"))).toBeTruthy();
    expect(await stat(confined(coordinator.activeRoot(rollbackState), "plans/legacy.json")).catch(() => null)).toBeNull();
    expect(await stat(path.join(root, "plans/legacy.json"))).toBeTruthy();

    const pointerOnlyRoot = await tempRoot();
    await writeJson(path.join(pointerOnlyRoot, "audit/legacy.json"), { schemaVersion: "1.0.0", events: [] });
    const pointerOnlyPlan = await planLegacyRuntimeMigration({ runtimeRoot: pointerOnlyRoot });
    await applyLegacyRuntimeMigration({ runtimeRoot: pointerOnlyRoot, expectedSourceManifestHash: pointerOnlyPlan.sourceManifestHash });
    expect(await planLegacyRuntimeRollback({ runtimeRoot: pointerOnlyRoot })).toMatchObject({ strategy: "remove_pointer_only", status: "ready" });
    await expect(rollbackLegacyRuntimeMigration({ runtimeRoot: pointerOnlyRoot, apply: true })).resolves.toMatchObject({ strategy: "remove_pointer_only", status: "rolled_back" });
    expect(await stat(path.join(pointerOnlyRoot, "control/active-pointer.json")).catch(() => null)).toBeNull();
    expect(await stat(path.join(pointerOnlyRoot, "audit/legacy.json"))).toBeTruthy();
    const reappliedPlan = await planLegacyRuntimeMigration({ runtimeRoot: pointerOnlyRoot });
    const reapplied = await applyLegacyRuntimeMigration({ runtimeRoot: pointerOnlyRoot, expectedSourceManifestHash: reappliedPlan.sourceManifestHash });
    expect(reapplied.targetRuntimeGeneration).toBe(3);

    const newerRoot = await tempRoot();
    await legacyFixture(newerRoot, false);
    const newerPlan = await planLegacyRuntimeMigration({ runtimeRoot: newerRoot });
    await applyLegacyRuntimeMigration({ runtimeRoot: newerRoot, expectedSourceManifestHash: newerPlan.sourceManifestHash });
    const newerCoordinator = new RuntimeCoordinator({ root: newerRoot });
    await newerCoordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => atomicWriteJson(confined(activeRoot, "plans/new.json"), { newer: true }));
    expect(await planLegacyRuntimeRollback({ runtimeRoot: newerRoot })).toMatchObject({ status: "blocked" });
    await expect(rollbackLegacyRuntimeMigration({ runtimeRoot: newerRoot, apply: true })).rejects.toThrow(/newer writes/);
  });
});
