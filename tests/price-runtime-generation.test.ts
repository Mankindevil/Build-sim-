import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile, privateMode } from "../src/runtime/fs.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { loadRuntimePriceSnapshot } from "../src/server/runtime-price-snapshot";
import {
  buildAndWriteLatest,
  loadLocalQuotes,
  upsertLocalQuote,
} from "../scripts/price-server/store.mjs";
import { configureAuthoritativeCatalogRepository, loadAuthoritativePriceSnapshot } from "../src/server/evaluation-service";
import { createBackup, restoreBackup } from "../src/backup/runtime.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureAuthoritativeCatalogRepository({ allowSeedPriceFallback: true });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function quote(variantLabel: string, priceCny: number) {
  return {
    skuId: "memory.runtime-fixture",
    platform: "jd",
    priceCny,
    currency: "CNY",
    listingUrl: `https://item.jd.com/runtime-${variantLabel}.html`,
    variantLabel,
    evidence: "audited",
    priceKind: "variant",
    fetchedAt: "2026-08-27T00:00:00.000Z",
  };
}

function priceSnapshot(priceCny: number, variantLabel: string) {
  const material = { schemaVersion: "1.0.0", asOf: "2026-08-27", quotes: [{ ...quote(variantLabel, priceCny) }] };
  return { ...material, contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
}

describe("U1 active-generation price repository", () => {
  it("serializes concurrent quote RMW operations under the coordinator lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-price-concurrent-"));
    roots.push(root);
    await Promise.all([
      upsertLocalQuote(quote("32GB", 529), { runtimeRoot: root }),
      upsertLocalQuote(quote("64GB", 899), { runtimeRoot: root }),
    ]);
    const rows = await loadLocalQuotes({ runtimeRoot: root });
    expect(rows.map((row: { variantLabel?: string }) => row.variantLabel).sort()).toEqual(["32GB", "64GB"]);
    const state = JSON.parse(await readFile(path.join(root, "control", "active-pointer.json"), "utf8"));
    expect(state.revision).toBeGreaterThanOrEqual(2); // both writes (initialization is revision 0)
    expect(await privateMode(path.join(root, "generations", "1", "prices", "local-quotes.json"))).toBe(0o600);
  });

  it("re-resolves the pointer after a generation switch for server and Agent reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-price-pointer-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const state = await coordinator.initialize("test");
    const first = priceSnapshot(100, "old");
    await atomicWriteFile(path.join(coordinator.activeRoot(state), "prices", "latest.json"), `${JSON.stringify(first)}\n`);
    configureAuthoritativeCatalogRepository({ priceRuntimeRoot: root, allowSeedPriceFallback: false });
    expect(loadAuthoritativePriceSnapshot().quotes[0]?.priceCny).toBe(100);

    const lease = await coordinator.acquireMaintenanceLease("price-pointer-test");
    const staging = await coordinator.createStagingGeneration(lease.token);
    const next = priceSnapshot(200, "new");
    await atomicWriteFile(path.join(staging, "prices", "latest.json"), `${JSON.stringify(next)}\n`);
    await coordinator.activateStagingGeneration(staging, state.runtimeGeneration, lease.token);
    expect(loadRuntimePriceSnapshot({ runtimeRoot: root, allowSeedFallback: false }).quotes[0]?.priceCny).toBe(200);
    expect(loadAuthoritativePriceSnapshot().quotes[0]?.priceCny).toBe(200);
    await coordinator.releaseMaintenanceLease(lease.token);
  });

  it("keeps the Agent on the restored price snapshot after a backup pointer switch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-price-restore-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const state = await coordinator.initialize("test");
    const first = priceSnapshot(321, "backup");
    await atomicWriteFile(path.join(coordinator.activeRoot(state), "prices", "latest.json"), `${JSON.stringify(first)}\n`);
    const backupFile = path.join(root, "price-backup.json");
    await createBackup({ coordinator, outputFile: backupFile, password: "runtime-price-test-password" });
    const changed = priceSnapshot(654, "changed");
    await atomicWriteFile(path.join(coordinator.activeRoot(await coordinator.readState()), "prices", "latest.json"), `${JSON.stringify(changed)}\n`);
    configureAuthoritativeCatalogRepository({ priceRuntimeRoot: root, allowSeedPriceFallback: false });
    expect(loadAuthoritativePriceSnapshot().quotes[0]?.priceCny).toBe(654);
    await restoreBackup({ coordinator, inputFile: backupFile, password: "runtime-price-test-password" });
    expect(loadAuthoritativePriceSnapshot().quotes[0]?.priceCny).toBe(321);
  });

  it("rolls back latest and dated snapshots together after a partial refresh", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-price-partial-"));
    roots.push(root);
    const catalog = { schemaVersion: "2.0.0", catalogVersion: "fixture", updatedAt: "2026-08-27", skus: [] };
    const initial = await buildAndWriteLatest("2026-08-27", "initial", {
      runtimeRoot: root,
      catalog,
      quotes: [quote("32GB", 529)],
    });
    const initialLatest = await readFile(path.join(root, "generations/1/prices/latest.json"), "utf8");
    const initialDated = await readFile(path.join(root, "generations/1/prices/snapshots/2026-08-27.json"), "utf8");
    await expect(buildAndWriteLatest("2026-08-27", "changed", {
      runtimeRoot: root,
      catalog,
      quotes: [quote("32GB", 599)],
      injectFailureAt: "after-latest",
    })).rejects.toThrow(/partial-write/);
    expect(await readFile(path.join(root, "generations/1/prices/latest.json"), "utf8")).toBe(initialLatest);
    expect(await readFile(path.join(root, "generations/1/prices/snapshots/2026-08-27.json"), "utf8")).toBe(initialDated);
    expect(initial.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps reads zero-write and rejects an unhashed or corrupt active snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-price-readonly-"));
    roots.push(root);
    await upsertLocalQuote(quote("read-only", 777), { runtimeRoot: root });
    const before = JSON.parse(await readFile(path.join(root, "control", "active-pointer.json"), "utf8"));
    await loadLocalQuotes({ runtimeRoot: root });
    const after = JSON.parse(await readFile(path.join(root, "control", "active-pointer.json"), "utf8"));
    expect(after).toEqual(before);

    await atomicWriteFile(path.join(root, before.activeRoot, "prices", "latest.json"), `${JSON.stringify({ schemaVersion: "1.0.0", asOf: "2026-08-27", quotes: [] })}\n`);
    expect(() => loadRuntimePriceSnapshot({ runtimeRoot: root, allowSeedFallback: false })).toThrow(/schema\/hash/);
  });
});
