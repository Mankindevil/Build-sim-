import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { saveCandidates } from "../scripts/price-server/store.mjs";

const roots: string[] = [];
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`price server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/price/health`);
      if (response.ok) return;
    } catch {
      // Startup may still be importing modules or initializing the catalog.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("price server did not become ready");
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("price catalog runtime routes", () => {
  it("serves a sanitized merged catalog and keeps transaction draft aliases governed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-price-catalog-"));
    roots.push(root);
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/price-server/server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PRICE_SERVER_PORT: String(port),
        CATALOG_PERSIST_ROOT: root,
        PRICE_RUNTIME_ROOT: root,
        EVIDENCE_REPOSITORY_ROOT: path.join(root, "evidence"),
        TRANSACTION_ARCHIVE_ROOT: path.join(root, "transactions"),
        BUILD_SIM_CATALOG_WRITE_ENABLED: "false",
      },
      stdio: "ignore",
    });
    children.push(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitUntilReady(baseUrl, child);

    const catalogResponse = await fetch(`${baseUrl}/api/price/catalog`);
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json() as { skus: unknown[]; writeEnabled: boolean; runtimeCatalog?: unknown };
    expect(catalog.skus.length).toBeGreaterThan(0);
    expect(catalog.writeEnabled).toBe(false);
    expect(catalog.runtimeCatalog).toBeUndefined();
    const pointer = JSON.parse(await readFile(path.join(root, "control/active-pointer.json"), "utf8"));
    const persisted = JSON.parse(await readFile(path.join(root, pointer.activeRoot, "catalog-overlays/product-catalog.json"), "utf8"));
    expect(persisted.runtimeCatalog).toMatchObject({ acceptedSkuIds: [] });

    const confirm = await fetch(`${baseUrl}/api/price/transactions/catalog-drafts/missing/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedHash: "a".repeat(64), approved: true }),
    });
    expect(confirm.status).toBe(409);
    expect(await confirm.json()).toMatchObject({ status: "blocked", draftId: "missing" });

    const review = await fetch(`${baseUrl}/api/price/catalog/candidates/missing/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedHash: "a".repeat(64) }),
    });
    expect(review.status).toBe(409);
    expect(await review.json()).toMatchObject({ status: "blocked", candidateId: "missing" });

    const draft = await fetch(`${baseUrl}/api/price/catalog/candidates/missing/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedHash: "a".repeat(64) }),
    });
    expect(draft.status).toBe(409);
    expect(await draft.json()).toMatchObject({ status: "blocked", candidateId: "missing" });

    const directConfirm = await fetch(`${baseUrl}/api/price/catalog-drafts/missing/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedHash: "a".repeat(64), approved: true }),
    });
    expect(directConfirm.status).toBe(409);
    expect(await directConfirm.json()).toMatchObject({ status: "blocked", draftId: "missing" });

    const reject = await fetch(`${baseUrl}/api/price/transactions/catalog-drafts/missing/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedHash: "a".repeat(64), approved: false }),
    });
    expect(reject.status).toBe(409);
    expect(await reject.json()).toMatchObject({ status: "blocked", draftId: "missing" });
  });

  it("rejects forged audit fields and serves the same durable snapshot after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-price-runtime-"));
    roots.push(root);
    const start = async () => {
      const port = await freePort();
      const child = spawn(process.execPath, ["scripts/price-server/server.mjs"], {
        cwd: process.cwd(),
        env: { ...process.env, PRICE_SERVER_PORT: String(port), CATALOG_PERSIST_ROOT: root, PRICE_RUNTIME_ROOT: root, EVIDENCE_REPOSITORY_ROOT: path.join(root, "evidence"), BUILD_SIM_CATALOG_WRITE_ENABLED: "false" },
        stdio: "ignore",
      });
      children.push(child);
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitUntilReady(baseUrl, child);
      return { child, baseUrl };
    };
    const first = await start();
    const arbitraryVariantUrl = await fetch(`${first.baseUrl}/api/price/variants`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "jd", url: "https://item.jd.com/999999.html" }),
    });
    expect(arbitraryVariantUrl.status).toBe(400);
    expect(await arbitraryVariantUrl.json()).toMatchObject({ error: expect.stringMatching(/server-captured/) });
    const saved = await saveCandidates({ candidates: [{
      skuId: "memory.kingston-kf564c32rsk2-32", platform: "jd", channel: "jd", title: "Kingston FURY 32GB", url: "https://item.jd.com/123456.html", fetchedAt: "2026-08-27T00:00:00.000Z",
      variants: [{ skuId: "123456", label: "32GB", amount: 529, currency: "CNY", stock: 1 }],
    }] }, "2026-08-27", { runtimeRoot: root });
    const candidate = saved.candidates[0]!;
    const forged = await fetch(`${first.baseUrl}/api/price/audit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listingCaptureId: candidate.listingCaptureId, candidateId: candidate.candidateId, skuId: candidate.skuId, variantLabel: "32GB", priceCny: 1 }),
    });
    expect(forged.status).toBe(400);
    const audited = await fetch(`${first.baseUrl}/api/price/audit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listingCaptureId: candidate.listingCaptureId, candidateId: candidate.candidateId, skuId: candidate.skuId, variantLabel: "32GB" }),
    });
    expect(audited.status).toBe(200);
    expect(await audited.json()).toMatchObject({ saved: { priceCny: 529, listingUrl: "https://item.jd.com/123456.html" } });
    await new Promise<void>((resolve) => { first.child.once("exit", () => resolve()); first.child.kill("SIGTERM"); });
    const second = await start();
    const state = await fetch(`${second.baseUrl}/api/price/state`);
    expect(state.status).toBe(200);
    const restarted = await state.json() as { counts: { local: number; latest: number }; localQuotes: { skuId: string; priceCny: number }[] };
    expect(restarted.counts.local).toBeGreaterThanOrEqual(1);
    expect(restarted.counts.latest).toBeGreaterThanOrEqual(1);
    expect(restarted.localQuotes).toContainEqual(expect.objectContaining({ skuId: candidate.skuId, priceCny: 529 }));
  });
});
