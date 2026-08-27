import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBackupCreateCli } from "../scripts/backup/create.mjs";
import { runBackupVerifyCli } from "../scripts/backup/verify.mjs";
import { initializeRuntimeCatalog } from "../scripts/price-server/catalog/repository.mjs";
import { createDomainProposal, decideDomainProposal } from "../scripts/price-server/catalog/domain-proposals.mjs";
import { buildAndWriteLatest, initializePriceRepository, saveCandidates, writePriceSearchArtifacts } from "../scripts/price-server/store.mjs";
import { archiveTransaction } from "../scripts/price-server/transactions/archive.mjs";
import { createBackup, openBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, readJson, sha256Bytes, sha256Json } from "../src/runtime/fs.mjs";
import { portableReferenceGraphHash } from "../src/runtime/reference-graph.mjs";
import {
  createProductionReferenceGraph,
  persistProductionReferenceGraph,
  PRODUCTION_REFERENCE_COMPOSITION_ID,
  PRODUCTION_REFERENCE_PROVIDER_IDS,
  verifyProductionReferenceGraph,
} from "../src/runtime/production-reference-graph.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function runtime(): Promise<{ root: string; coordinator: RuntimeCoordinator }> {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-production-ops-")); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
  return { root, coordinator };
}

describe("U1 production runtime composition and CLIs", () => {
  it("requires the exact production provider set and rejects a caller graph after a concurrent revision", async () => {
    const { root, coordinator } = await runtime();
    const graph = await createProductionReferenceGraph({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    expect(graph.compositionId).toBe(PRODUCTION_REFERENCE_COMPOSITION_ID);
    expect(graph.providerSnapshots.map((item: { providerId: string }) => item.providerId).sort()).toEqual([...PRODUCTION_REFERENCE_PROVIDER_IDS].sort());
    expect(verifyProductionReferenceGraph(graph, await coordinator.readState())).toEqual([]);

    const missingBase = { ...graph, providerSnapshots: graph.providerSnapshots.slice(1), graphHash: undefined };
    const missing = { ...missingBase, graphHash: portableReferenceGraphHash(missingBase) };
    expect(verifyProductionReferenceGraph(missing, await coordinator.readState())).toContain("reference graph production provider coverage incomplete");

    await coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => atomicWriteJson(confined(activeRoot, "facts", "revision.json"), { schemaVersion: "fixture-v1" }));
    await expect(createBackup({ coordinator, outputFile: path.join(root, "stale.backup"), password: "a sufficiently long password", referenceGraph: graph })).rejects.toThrow(/caller reference graph is stale/);
  });

  it("keeps the backup byte capture and generated graph under one writer barrier", async () => {
    const { root, coordinator: base } = await runtime();
    let release!: () => void; let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new RuntimeCoordinator({ root: base.root });
    const consistentSnapshot = coordinator.withConsistentSnapshot.bind(coordinator);
    coordinator.withConsistentSnapshot = (async (operation: (context: any) => Promise<any>) => consistentSnapshot(async (context: any) => { const result = await operation(context); entered(); await releasePromise; return result; })) as typeof coordinator.withConsistentSnapshot;
    const backup = createBackup({ coordinator, outputFile: path.join(root, "barrier.backup"), password: "a sufficiently long password" });
    await enteredPromise;
    let wrote = false;
    const writer = base.withWrite(async () => { wrote = true; });
    await Promise.resolve(); expect(wrote).toBe(false);
    release(); await backup; await writer; expect(wrote).toBe(true);
  });

  it("fails closed on checksum-valid malformed plans/prices and bad migration/control hashes", async () => {
    const first = await runtime(); const firstState = await first.coordinator.readState();
    const malformed = { schemaVersion: "1.0.0", id: "plan-bad-authority", name: "bad" };
    await atomicWriteJson(confined(first.coordinator.activeRoot(firstState), "plans", "plan-bad-authority", "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(malformed), payload: malformed });
    await expect(createBackup({ coordinator: first.coordinator, outputFile: path.join(first.root, "bad-plan.backup"), password: "a sufficiently long password" })).rejects.toThrow(/plan authority payload/);

    const second = await runtime(); const secondState = await second.coordinator.readState();
    await atomicWriteJson(confined(second.coordinator.activeRoot(secondState), "migrations", "legacy-runtime-v1", "manifest.json"), {
      schemaVersion: "legacy-runtime-migration-v1", migrationId: "legacy-runtime-v1", status: "committed",
      sourceManifestHash: "a".repeat(64), sourceInventoryHash: "b".repeat(64), baseInventoryHash: "c".repeat(64), stagedInventoryHash: "d".repeat(64),
      copied: [], baseCopied: [], manifestHash: "e".repeat(64),
    });
    await expect(createBackup({ coordinator: second.coordinator, outputFile: path.join(second.root, "bad-migration.backup"), password: "a sufficiently long password" })).rejects.toThrow(/migration marker\/hash/);
    await atomicWriteJson(confined(second.coordinator.controlRoot, "legacy-runtime-v1.json"), { schemaVersion: "legacy-runtime-migration-v1", migrationId: "legacy-runtime-v1", status: "committed", journalHash: "f".repeat(64) });
    const doctor = await runDoctor({ coordinator: second.coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    expect(doctor.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });

    const third = await runtime(); const thirdState = await third.coordinator.readState();
    const target = { targetId: "target-bad" };
    const targetBase = { schemaVersion: "price-repository-v1", kind: "target", revision: 0, payloadHash: sha256Json(target), payload: target };
    await atomicWriteJson(confined(third.coordinator.activeRoot(thirdState), "prices", "domain", "targets", "target-bad.json"), { ...targetBase, checksum: sha256Json(targetBase) });
    await expect(createBackup({ coordinator: third.coordinator, outputFile: path.join(third.root, "bad-price.backup"), password: "a sufficiently long password" })).rejects.toThrow(/price target semantics/);

    const fourth = await runtime(); const fourthState = await fourth.coordinator.readState();
    await atomicWriteJson(confined(fourth.coordinator.activeRoot(fourthState), "audit", "advice-jobs", "advice-bad-authority.json"), {
      requestId: "advice-bad-authority", status: "completed", provider: "deepseek",
    });
    await expect(createBackup({ coordinator: fourth.coordinator, outputFile: path.join(fourth.root, "bad-advice.backup"), password: "a sufficiently long password" })).rejects.toThrow(/legacy advice job record/);

    const fifth = await runtime(); const fifthState = await fifth.coordinator.readState();
    await atomicWriteJson(confined(fifth.coordinator.activeRoot(fifthState), "catalog-overlays", "product-catalog.json"), {
      schemaVersion: "forged", updatedAt: "not-a-date", skus: "not-an-array",
    });
    await expect(createBackup({ coordinator: fifth.coordinator, outputFile: path.join(fifth.root, "bad-catalog.backup"), password: "a sufficiently long password" })).rejects.toThrow(/runtime product catalog/);
    const catalogDoctor = await runDoctor({ coordinator: fifth.coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    expect(catalogDoctor.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });

    const sixth = await runtime(); const sixthState = await sixth.coordinator.readState();
    await atomicWriteJson(confined(sixth.coordinator.activeRoot(sixthState), "prices", "local-quotes.json"), {
      schemaVersion: "1.0.0", quotes: "not-an-array",
    });
    await expect(createBackup({ coordinator: sixth.coordinator, outputFile: path.join(sixth.root, "bad-price-runtime.backup"), password: "a sufficiently long password" })).rejects.toThrow(/runtime local price quotes/);
    const priceDoctor = await runDoctor({ coordinator: sixth.coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    expect(priceDoctor.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });

    const seventh = await runtime(); const seventhState = await seventh.coordinator.readState();
    const unknownCatalog = confined(seventh.coordinator.activeRoot(seventhState), "catalog-overlays", "unknown.json");
    await atomicWriteJson(unknownCatalog, { schemaVersion: "1.0.0" });
    await expect(createBackup({ coordinator: seventh.coordinator, outputFile: path.join(seventh.root, "unknown-catalog.backup"), password: "a sufficiently long password" })).rejects.toThrow(/unrecognized authority path/);
    await rm(unknownCatalog);
    await atomicWriteJson(confined(seventh.coordinator.activeRoot(seventhState), "prices", "unknown.json"), { schemaVersion: "1.0.0" });
    await expect(createBackup({ coordinator: seventh.coordinator, outputFile: path.join(seventh.root, "unknown-price.backup"), password: "a sufficiently long password" })).rejects.toThrow(/unrecognized runtime authority path/);

    const eighth = await runtime(); const eighthState = await eighth.coordinator.readState();
    const transaction = {
      schemaVersion: 2, receiptId: "receipt-forged-authority", storedAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
      item: {
        id: "item-forged-authority", skuId: null, name: "Fixture", category: "accessory", qty: 1, unitPriceCny: null, stage: "purchased", source: "transaction",
        transaction: { receiptId: "receipt-forged-authority", fileName: "", contentHash: "a".repeat(64), capturedAt: "2026-08-27T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: null, excerpt: "evidence", verification: "reviewed", catalogJobId: null, candidateId: null, draftId: null, officialUrl: null },
      },
      link: { schemaVersion: "1.0.0", planId: null, planVersionIdAtCapture: null, planItemId: null, linkStatus: "unlinked" },
      image: null,
      customerName: "private-forged-field",
    };
    await atomicWriteJson(confined(eighth.coordinator.activeRoot(eighthState), "transactions", "quarantine", `${transaction.receiptId}.json`), transaction);
    await expect(createBackup({ coordinator: eighth.coordinator, outputFile: path.join(eighth.root, "forged-transaction.backup"), password: "a sufficiently long password" })).rejects.toThrow(/not canonical or contains private/);

    const ninth = await runtime(); const ninthState = await ninth.coordinator.readState();
    const settledEntry = {
      id: "forged-private-rollback", operation: "transaction-archive", target: "quarantine/receipt-forged.json",
      previousHash: null, nextHash: "b".repeat(64), state: "committed",
      createdAt: "2026-08-27T00:00:00.000Z", committedAt: "2026-08-27T00:00:01.000Z",
    };
    const rollbackFile = confined(ninth.coordinator.activeRoot(ninthState), "transactions", "rollback", "transactions-manifest.json");
    const writeRollback = async (entry: object) => {
      const unsigned = { schemaVersion: "transactions-rollback-v2", entries: [entry] };
      await atomicWriteJson(rollbackFile, { ...unsigned, checksum: sha256Bytes(Buffer.from(JSON.stringify(unsigned), "utf8")) });
    };
    await writeRollback({ ...settledEntry, previousBase64: "cHJpdmF0ZQ==" });
    await expect(createBackup({ coordinator: ninth.coordinator, outputFile: path.join(ninth.root, "forged-transaction-rollback.backup"), password: "a sufficiently long password" })).rejects.toThrow(/private, or invalid/);
    await writeRollback({ ...settledEntry, source: "quarantine/receipt-private-source.json" });
    await expect(createBackup({ coordinator: ninth.coordinator, outputFile: path.join(ninth.root, "forged-transaction-source.backup"), password: "a sufficiently long password" })).rejects.toThrow(/private, or invalid/);
  });

  it("Doctor generates its own graph and rejects a persisted stale revision without writing", async () => {
    const { coordinator } = await runtime();
    await persistProductionReferenceGraph({ coordinator, now: () => "2026-08-27T00:00:00.000Z" });
    await coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => atomicWriteJson(confined(activeRoot, "facts", "after-graph.json"), { schemaVersion: "fixture-v1" }));
    const before = await readFile(coordinator.stateFile, "utf8");
    const result = await runDoctor({ coordinator, now: () => "2026-08-27T00:01:00.000Z" });
    expect(result.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure")).toMatchObject({ status: "fail" });
    expect(await readFile(coordinator.stateFile, "utf8")).toBe(before);
  });

  it("fails closed for every materialized legacy price-server directory", async () => {
    const { root, coordinator } = await runtime();
    const state = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(state);
    const cases: Array<{ logicalPath: string; value: unknown; error: RegExp }> = [
      { logicalPath: "manual-quotes.json", value: { schemaVersion: "1.0.0", quotes: "forged" }, error: /manual price quotes/ },
      { logicalPath: "snapshots/2026-08-27.json", value: { schemaVersion: "1.0.0", asOf: "2026-08-27", quotes: [], contentHash: "a".repeat(64) }, error: /dated price snapshot/ },
      { logicalPath: "listing-captures/listing-capture-aaaaaaaaaaaaaaaaaaaa.json", value: { schemaVersion: "1.0.0", contentHash: "a".repeat(64) }, error: /listing capture/ },
      { logicalPath: "candidates/2026-08-27.json", value: { schemaVersion: "1.0.0", asOf: "2026-08-27", candidates: [{}] }, error: /invalid candidate/ },
      { logicalPath: "history/forged.json", value: { schemaVersion: "1.0.0" }, error: /no current authority schema/ },
      { logicalPath: "targets/forged.json", value: { schemaVersion: "1.0.0" }, error: /no current authority schema/ },
      { logicalPath: "audit/2026-08-27.json", value: { schemaVersion: "1.0.0", events: [{}] }, error: /audit event/ },
      { logicalPath: "rollback/manifest.json", value: { schemaVersion: "price-rollback-manifest-v2", priceRoot: "..", entries: [{}] }, error: /rollback entry/ },
    ];
    for (const [index, fixture] of cases.entries()) {
      const file = confined(activeRoot, "prices", ...fixture.logicalPath.split("/"));
      await atomicWriteJson(file, fixture.value);
      await expect(createBackup({ coordinator, outputFile: path.join(root, `forged-price-path-${index}.backup`), password: "a sufficiently long password" })).rejects.toThrow(fixture.error);
      await rm(file);
    }
  });

  it("fails closed on malformed and unknown domain authorities and rollback bytes", async () => {
    const { root, coordinator } = await runtime();
    const state = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(state);
    const overlayPath = confined(activeRoot, "domain-overlays", "official-domains.overlay.json");
    await atomicWriteJson(overlayPath, { schemaVersion: "broken", brands: [] });
    await expect(createBackup({ coordinator, outputFile: path.join(root, "forged-domain-overlay.backup"), password: "a sufficiently long password" })).rejects.toThrow(/official domain overlay/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
    await rm(overlayPath);

    const proposalPath = confined(activeRoot, "domain-overlays", "proposals.json");
    await atomicWriteJson(proposalPath, { schemaVersion: "1.0.0", proposals: [{}], events: [] });
    await expect(createBackup({ coordinator, outputFile: path.join(root, "forged-domain-proposal.backup"), password: "a sufficiently long password" })).rejects.toThrow(/invalid proposal/);
    await rm(proposalPath);

    const unknownPath = confined(activeRoot, "domain-overlays", "unknown.json");
    await atomicWriteJson(unknownPath, { schemaVersion: "1.0.0" });
    await expect(createBackup({ coordinator, outputFile: path.join(root, "unknown-domain-authority.backup"), password: "a sufficiently long password" })).rejects.toThrow(/unrecognized authority path/);
    await rm(unknownPath);

    const unknownAuditPath = confined(activeRoot, "audit", "rollback", "domain", "unknown.json");
    await atomicWriteJson(unknownAuditPath, { schemaVersion: "1.0.0" });
    await expect(createBackup({ coordinator, outputFile: path.join(root, "unknown-domain-audit.backup"), password: "a sufficiently long password" })).rejects.toThrow(/unrecognized authority path/);
    await rm(unknownAuditPath);

    const proposal = await createDomainProposal({
      brand: "Rollback Closure Fixture", url: "https://rollback-closure.fixture.example.org/item", provider: "fixture",
    }, { coordinator, generationAware: true });
    await decideDomainProposal(proposal.proposalId, "approved", proposal.inputHash, { coordinator, generationAware: true });
    const committed = await coordinator.readState();
    const manifest = await readJson(confined(coordinator.activeRoot(committed), "audit", "rollback", "domain", "official-registry-manifest.json"));
    await atomicWriteJson(confined(coordinator.activeRoot(committed), ...manifest.transactions[0].files[0].backup.split("/")), { forged: true });
    await expect(createBackup({ coordinator, outputFile: path.join(root, "forged-domain-rollback.backup"), password: "a sufficiently long password" })).rejects.toThrow(/backup is missing or hash-mismatched/);
  });

  it("binds a price candidate to the full listing-capture hash", async () => {
    const { root, coordinator } = await runtime();
    const asOf = "2026-08-27";
    await saveCandidates({
      schemaVersion: "1.0.0", asOf, results: [], candidates: [{
        skuId: "memory.capture-binding", platform: "jd", channel: "jd", title: "Capture binding fixture",
        url: "https://item.jd.com/capture-binding.html", fetchedAt: "2026-08-27T00:00:00.000Z", variants: [],
      }],
    }, asOf, { coordinator, generationAware: true });
    const state = await coordinator.readState();
    const candidateFile = confined(coordinator.activeRoot(state), "prices", "candidates", `${asOf}.json`);
    const document = await readJson(candidateFile);
    const originalHash = document.candidates[0].captureContentHash as string;
    document.candidates[0].captureContentHash = `${originalHash.slice(0, -1)}${originalHash.endsWith("0") ? "1" : "0"}`;
    await atomicWriteJson(candidateFile, document);

    await expect(createBackup({
      coordinator,
      outputFile: path.join(root, "forged-candidate-capture-binding.backup"),
      password: "a sufficiently long password",
    })).rejects.toThrow(/missing or hash-mismatched listing capture/);
  });

  it("revalidates the materialized restore staging generation before pointer switch", async () => {
    const { root, coordinator } = await runtime();
    const backup = path.join(root, "restore-stage.backup");
    await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password" });
    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator,
      inputFile: backup,
      password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => atomicWriteJson(confined(staging, "catalog-overlays", "product-catalog.json"), {
        schemaVersion: "forged", updatedAt: "not-a-date", skus: "not-an-array",
      }),
    })).rejects.toThrow(/runtime product catalog/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("does not switch the restore pointer when staged domain authority is forged", async () => {
    const { root, coordinator } = await runtime();
    const backup = path.join(root, "restore-stage-domain.backup");
    await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password" });
    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator,
      inputFile: backup,
      password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => atomicWriteJson(confined(staging, "domain-overlays", "official-domains.json"), {
        schemaVersion: "1.0.0", updatedAt: "not-a-date", brands: [],
      }),
    })).rejects.toThrow(/official (?:domain )?registry/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("accepts and reproduces every materialized catalog and price-server authority path", async () => {
    const { root, coordinator } = await runtime();
    await initializeRuntimeCatalog({ coordinator, generationAware: true });
    await initializePriceRepository({ coordinator, generationAware: true });
    await buildAndWriteLatest("2026-08-27", "production composition fixture", {
      coordinator, generationAware: true,
      catalog: { schemaVersion: "2.0.0", catalogVersion: "2.0.0", updatedAt: "2026-08-27", skus: [] },
      quotes: [],
    });
    await saveCandidates({
      schemaVersion: "1.0.0", asOf: "2026-08-27", results: [], candidates: [{
        skuId: "memory.runtime-fixture", platform: "jd", channel: "jd", title: "Runtime fixture",
        url: "https://item.jd.com/runtime-fixture.html?utm_source=test", fetchedAt: "2026-08-27T00:00:00.000Z",
        variants: [{ skuId: "fixture-32", label: "32GB", amount: 529, currency: "CNY" }],
      }],
    }, "2026-08-27", { coordinator, generationAware: true });
    await writePriceSearchArtifacts({ schemaVersion: "1.0.0", asOf: "2026-08-27", results: [] }, "# fixture\n", "2026-08-27", { coordinator, generationAware: true });
    const domainProposal = await createDomainProposal({
      brand: "Production Domain Fixture", url: "https://production-domain.fixture.example.org/item", provider: "fixture",
    }, { coordinator, generationAware: true });
    await decideDomainProposal(domainProposal.proposalId, "approved", domainProposal.inputHash, { coordinator, generationAware: true });
    const receiptImage = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const receiptHash = sha256Bytes(receiptImage);
    await archiveTransaction({
      receiptId: `receipt-${receiptHash.slice(0, 20)}`,
      screenshotDataUrl: `data:image/png;base64,${receiptImage.toString("base64")}`,
      link: { schemaVersion: "1.0.0", planId: null, planVersionIdAtCapture: null, planItemId: null, linkStatus: "unlinked" },
      item: {
        id: `item-${receiptHash.slice(0, 20)}`, skuId: null, name: "Fixture", category: "accessory", qty: 1, unitPriceCny: 1, stage: "purchased", source: "transaction",
        transaction: { receiptId: `receipt-${receiptHash.slice(0, 20)}`, fileName: "fixture.png", contentHash: receiptHash, capturedAt: "2026-08-27T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: 1, excerpt: "fixture", verification: "reviewed" },
      },
    }, { coordinator });

    const backup = path.join(root, "materialized-authorities.backup");
    await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password" });
    await expect(verifyBackup({ inputFile: backup, password: "a sufficiently long password" })).resolves.toMatchObject({ valid: true });
  });

  it("backup create/verify CLIs use production composition and persist verifier-issued proof by default", async () => {
    const { root, coordinator } = await runtime();
    const backup = path.join(root, "cli.backup");
    const environment = { ...process.env, BUILDSIM_BACKUP_PASSWORD: "a sufficiently long password" };
    const created = await runBackupCreateCli(["--runtime-root", root, "--output", backup], environment);
    expect(created).toMatchObject({ ok: true, runtimeGeneration: 1 });
    const createdState = await coordinator.readState();
    const createdGraph = await readJson(confined(coordinator.activeRoot(createdState), "audit", "runtime-reference-graph.json"));
    const opened = await openBackup(backup, environment.BUILDSIM_BACKUP_PASSWORD);
    expect(opened.inner.referenceGraph.graphHash).toBe(created.referenceGraphHash);
    expect(createdGraph.graphHash).toBe(created.referenceGraphHash);
    const verified = await runBackupVerifyCli(["--runtime-root", root, "--input", backup], environment);
    expect(verified).toMatchObject({ ok: true, persisted: true, report: { result: "pass" } });
    const state = await coordinator.readState();
    const storedGraph = await readJson(confined(coordinator.activeRoot(state), "audit", "runtime-reference-graph.json"));
    expect(verifyProductionReferenceGraph(storedGraph, state)).toEqual([]);
    expect(await readJson(confined(coordinator.activeRoot(state), "backups", "verifications", `${created.manifestHash}.json`))).toMatchObject({ schemaVersion: "backup-verification-record-v1" });
    const doctor = await runDoctor({ coordinator, now: () => "2026-08-27T00:01:00.000Z" });
    expect(doctor.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure")).toMatchObject({ status: "pass" });
  });
});
