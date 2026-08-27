import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProductCatalogSeed, mergeProductCatalogOverlay } from "../src/sku/catalog";
import { validateProductCatalogOverlay, validateProductCatalogSeed } from "../src/sku/types";
import { buildMigrationPlan, isCatalogUserDataMigrationCliEntry, runMigration, rollbackMigration } from "../scripts/migrations/isolate-user-data-v1.mjs";
import { createDomainProposal, decideDomainProposal, rollbackDomainApproval } from "../scripts/price-server/catalog/domain-proposals.mjs";
import { registryForUrl } from "../scripts/price-server/catalog/registry.mjs";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-catalog-seed-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("U1 product seed and runtime overlay isolation", () => {
  it("loads the bundled catalog as a product-only seed", () => {
    const seed = loadProductCatalogSeed();
    expect(validateProductCatalogSeed(seed)).toEqual([]);
    expect(seed.skus).toHaveLength(38);
    expect(seed.skus.some((sku) => "paid" in sku.price)).toBe(false);
    expect(seed.skus.some((sku) => sku.tags?.some((tag) => /owned|purchase|transaction/i.test(tag)))).toBe(false);
  });

  it("rejects user data in both seed and runtime overlay", () => {
    const seed = loadProductCatalogSeed();
    const first = seed.skus[0]!;
    const badSeed = { ...seed, skus: [{ ...first, price: { ...first.price, paid: 1 }, tags: ["owned"] }] };
    expect(validateProductCatalogSeed(badSeed)).toEqual(expect.arrayContaining([expect.stringContaining("price.paid"), expect.stringContaining("ownership") ]));
    expect(validateProductCatalogSeed({ ...seed, skus: [{ ...first, price: { ...first.price, note: "User transaction receipt #123" } }] }))
      .toEqual(expect.arrayContaining([expect.stringContaining("price.note") ]));
    const overlay = { schemaVersion: "1.0.0", overlayKind: "product_catalog_overlay", overlayVersion: "2.0.1", baseCatalogVersion: seed.catalogVersion ?? seed.schemaVersion, baseUpdatedAt: seed.updatedAt, updatedAt: "2026-08-27T00:00:00.000Z", skus: [{ ...first, id: "gpu.runtime", price: { ...first.price, paid: 99 } }], acceptedSkuIds: ["gpu.runtime"] };
    expect(validateProductCatalogOverlay(overlay)).toEqual(expect.arrayContaining([expect.stringContaining("price.paid") ]));
  });

  it("merges an accepted product overlay without changing the seed", () => {
    const seed = loadProductCatalogSeed();
    const original = seed.skus.find((sku) => sku.id === "gpu.rtx-a2000-12gb")!;
    const replacement = { ...structuredClone(original), model: "Runtime revision" };
    const overlay = { schemaVersion: "1.0.0", overlayKind: "product_catalog_overlay" as const, overlayVersion: "2.0.1", baseCatalogVersion: seed.catalogVersion ?? seed.schemaVersion, baseUpdatedAt: seed.updatedAt, updatedAt: "2026-08-27T00:00:00.000Z", skus: [replacement], acceptedSkuIds: [replacement.id] };
    const merged = mergeProductCatalogOverlay(seed, overlay);
    expect(merged.skus.find((sku) => sku.id === replacement.id)?.model).toBe("Runtime revision");
    expect(seed.skus.find((sku) => sku.id === replacement.id)?.model).toBe(original.model);
  });
});

describe("U1 catalog user-data migration", () => {
  it("stays inert when bundled into an Agent or Workspace server entrypoint", () => {
    expect(isCatalogUserDataMigrationCliEntry(
      "file:///srv/build-sim/dist-agent/agent-server.js",
      "/srv/build-sim/dist-agent/agent-server.js",
    )).toBe(false);
    expect(isCatalogUserDataMigrationCliEntry(
      "file:///srv/build-sim/scripts/migrations/isolate-user-data-v1.mjs",
      "/srv/build-sim/scripts/migrations/isolate-user-data-v1.mjs",
    )).toBe(true);
  });

  it("is a zero-change dry-run for the sanitized seed and does not quarantine product price notes", () => {
    const seed = loadProductCatalogSeed();
    const result = buildMigrationPlan(seed, { sourceBytes: Buffer.from(JSON.stringify(seed)) });
    expect(result.entries).toHaveLength(38);
    expect(result.removedFieldCount).toBe(0);
    expect(result.quarantine).toEqual([]);
    expect(result.entries.find((entry: { legacySkuId: string }) => entry.legacySkuId === "case.jonsbo-n6")?.sourceFields).toEqual([]);
    expect(result.entries.find((entry: { legacySkuId: string }) => entry.legacySkuId === "accessory.dual-psu-sync")?.sourceFields).toEqual([]);
  });

  it("is dry-run by default and quarantines unattributed fields", async () => {
    const root = await tempRoot();
    const catalogPath = path.join(root, "catalog.json");
    const manifestPath = path.join(root, "manifest.json");
    const fixture = { schemaVersion: "2.0.0", updatedAt: "2026-08-27", skus: [{ id: "gpu.fixture", price: { paid: 100 }, tags: ["owned", "workstation"], name: "Fixture (owned x1)" }] };
    await writeFile(catalogPath, JSON.stringify(fixture));
    const result = await runMigration({ catalogPath, manifestPath });
    expect(result.status).toBe("dry_run");
    expect(JSON.parse(await readFile(catalogPath, "utf8"))).toEqual(fixture);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0].planId).toBeNull();
  });

  it("applies atomically, writes an audit manifest, and restores from rollback", async () => {
    const root = await tempRoot();
    const catalogPath = path.join(root, "catalog.json");
    const manifestPath = path.join(root, "migration.json");
    const fixture = { schemaVersion: "2.0.0", updatedAt: "2026-08-27", skus: [{ id: "gpu.fixture", price: { paid: 100 }, tags: ["owned", "workstation"] }] };
    await writeFile(catalogPath, JSON.stringify(fixture));
    await runMigration({ catalogPath, manifestPath });
    const result = await runMigration({ catalogPath, manifestPath, dryRun: false });
    const sanitized = JSON.parse(await readFile(catalogPath, "utf8"));
    expect(result.status).toBe("applied");
    expect(result.audit).toMatchObject({ status: "applied", entriesExpected: 1, entriesObserved: 1, catalogHash: result.sourceHashAfter });
    expect(result.rollback.backupHash).toBe(result.sourceHashBefore);
    expect((await stat(catalogPath)).mode & 0o777).toBe(0o600);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    expect((await stat(result.rollback.backupPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(result.rollback.backupPath))).mode & 0o777).toBe(0o700);
    expect(sanitized.skus[0].price).not.toHaveProperty("paid");
    expect(sanitized.skus[0].tags).toEqual(["workstation"]);
    const rollback = await rollbackMigration(manifestPath);
    const productOnlyRollback = JSON.parse(await readFile(catalogPath, "utf8"));
    expect(productOnlyRollback.skus[0].price).not.toHaveProperty("paid");
    expect(productOnlyRollback.skus[0].tags).toEqual(["workstation"]);
    expect(rollback).toMatchObject({ restoredProductOnly: true, originalBackupHash: result.sourceHashBefore, sanitizedRollbackHash: result.sourceHashAfter });
    const rolledBackManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(rolledBackManifest.audit).toMatchObject({ status: "rolled_back", originalBackupHash: result.sourceHashBefore, sanitizedRollbackHash: result.sourceHashAfter, catalogHash: result.sourceHashAfter });
    const quarantine = JSON.parse(await readFile(path.join(path.dirname(manifestPath), "quarantine/catalog-user-data-v1/catalog-user-data.json"), "utf8"));
    expect(quarantine.entries[0].values).toMatchObject({ "price.paid": 100, "tags.owned": "owned" });
  });

  it("never reintroduces isolated user fields when rolling a product seed back", async () => {
    const root = await tempRoot();
    const catalogPath = path.join(root, "catalog.json");
    const manifestPath = path.join(root, "migration.json");
    const seed = loadProductCatalogSeed();
    const first = seed.skus[0]!;
    const contaminated = {
      ...structuredClone(seed),
      skus: [{ ...structuredClone(first), price: { ...structuredClone(first.price), paid: 629, note: "User transaction" }, tags: [...(first.tags ?? []), "owned"] }, ...structuredClone(seed.skus.slice(1))],
    };
    await writeFile(catalogPath, JSON.stringify(contaminated));
    await runMigration({ catalogPath, manifestPath });
    await runMigration({ catalogPath, manifestPath, dryRun: false });
    const rollback = await rollbackMigration(manifestPath);
    const productOnly = JSON.parse(await readFile(catalogPath, "utf8"));
    expect(validateProductCatalogSeed(productOnly)).toEqual([]);
    expect(productOnly.skus.some((sku: { price: Record<string, unknown>; tags?: string[] }) => "paid" in sku.price || sku.tags?.some((tag) => /^(?:owned|paid|user|purchase|transaction)(?:$|[-_])/i.test(tag)))).toBe(false);
    expect(rollback.originalBackupHash).not.toBe(rollback.sanitizedRollbackHash);
  });

  it("binds apply to its dry-run source hash and refuses to overwrite a newer write on rollback", async () => {
    const root = await tempRoot();
    const catalogPath = path.join(root, "catalog.json");
    const manifestPath = path.join(root, "migration.json");
    const fixture = { schemaVersion: "2.0.0", updatedAt: "2026-08-27", skus: [{ id: "gpu.fixture", price: { paid: 100 }, tags: ["owned"] }] };
    await writeFile(catalogPath, JSON.stringify(fixture));
    await expect(runMigration({ catalogPath, manifestPath, dryRun: false })).rejects.toThrow(/requires an expected source hash/);
    const dryRun = await runMigration({ catalogPath, manifestPath });
    await writeFile(catalogPath, JSON.stringify({ ...fixture, updatedAt: "newer-write" }));
    await expect(runMigration({ catalogPath, manifestPath, dryRun: false })).rejects.toThrow(/source hash mismatch/);

    await writeFile(catalogPath, JSON.stringify(fixture));
    const applied = await runMigration({ catalogPath, manifestPath, dryRun: false, expectedSourceHash: dryRun.sourceHashBefore });
    const newer = { ...JSON.parse(await readFile(catalogPath, "utf8")), updatedAt: "after-migration" };
    await writeFile(catalogPath, JSON.stringify(newer));
    await expect(rollbackMigration(manifestPath)).rejects.toThrow(/newer write/);
    expect(JSON.parse(await readFile(catalogPath, "utf8"))).toEqual(newer);
    expect(applied.status).toBe("applied");
  });

  it("uses a cross-process lock and keeps the static 38-SKU audit vocabulary aligned", async () => {
    const root = await tempRoot();
    const catalogPath = path.join(root, "catalog.json");
    const manifestPath = path.join(root, "migration.json");
    await writeFile(catalogPath, JSON.stringify({ schemaVersion: "2.0.0", skus: [{ id: "fixture", price: {} }] }));
    await mkdir(`${manifestPath}.lock`, { mode: 0o700 });
    await expect(runMigration({ catalogPath, manifestPath, lockTimeoutMs: 20, lockStaleMs: 60_000 })).rejects.toThrow(/lock timeout/);

    const staticManifest = JSON.parse(await readFile(new URL("../data/migrations/catalog-user-data-v1.json", import.meta.url), "utf8"));
    const seed = loadProductCatalogSeed();
    expect(staticManifest.entries).toHaveLength(38);
    expect(new Set(staticManifest.entries.map((entry: { legacySkuId: string }) => entry.legacySkuId))).toEqual(new Set(seed.skus.map((sku) => sku.id)));
    expect(staticManifest.audit).toMatchObject({ status: "planned", entriesExpected: 38, entriesObserved: 38, removedFieldCount: 23 });
    const allowedFields = /^(?:price\.paid|price\.user-note|tags\.[\w-]+|name\.user-marker|harness\.note\.user-observation|harness\.crossCheck\.user-attachment|attrs\.peripheralSocketsNote\.user-observation|portMap\.source\.user-observation)$/;
    expect(staticManifest.entries.flatMap((entry: { sourceFields: string[] }) => entry.sourceFields).every((field: string) => allowedFields.test(field))).toBe(true);
  });

  it("makes an approved official domain visible to this process without restart", async () => {
    const root = await tempRoot();
    const registryPath = path.join(root, "data/catalog/official-domains.json");
    const bundled = await readFile(new URL("../data/catalog/official-domains.json", import.meta.url), "utf8");
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(path.dirname(registryPath), { recursive: true }).then(() => writeFile(registryPath, bundled)));
    const domain = `runtime-approved-${Date.now()}.example.org`;
    const proposal = await createDomainProposal({ brand: "Runtime Fixture", url: `https://${domain}/product`, provider: "fixture" }, { persistRoot: root, registryPath });
    await decideDomainProposal(proposal.proposalId, "approved", proposal.inputHash, { persistRoot: root, registryPath });
    expect(registryForUrl(new URL(`https://${domain}/product`))?.brand).toBe("Runtime Fixture");
    await rollbackDomainApproval({ persistRoot: root, registryPath });
    expect(registryForUrl(new URL(`https://${domain}/product`))).toBeNull();
  });
});
