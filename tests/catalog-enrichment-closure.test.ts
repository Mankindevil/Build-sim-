import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import bundledCatalog from "../data/skus/catalog.json";
import { evaluateBuild } from "../src/core/evaluate";
import type { BuildConfig } from "../src/config/types";
import type { SkuCatalog } from "../src/sku/types";
import { runAutoEnrichment } from "../scripts/price-server/catalog/auto-enrichment.mjs";
import { queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
import { confirmDraft, rollbackCatalogAcceptance } from "../scripts/price-server/catalog/write.mjs";

describe("C7 official enrichment delivery closure", () => {
  it("runs exact-MPN discovery, inspection, enrichment, evaluation and rollback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-c7-closure-"));
    const catalogPath = path.join(root, "catalog.json");
    const rollbackRoot = path.join(root, "rollback");
    const rollbackManifestPath = path.join(rollbackRoot, "catalog-manifest.json");
    const html = await readFile(new URL("./fixtures/catalog/asus-product.html", import.meta.url), "utf8");
    const url = "https://www.asus.com/example/g4";
    const stamp = Date.now();
    const provider = {
      id: `c7-closure-${stamp}`,
      discover: async () => [{ url, title: "ASUS Pro WS G4", snippet: "untrusted snippet number 9999 W", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 0 }],
    };
    const fetcher = async () => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      retrievedAt: "2026-08-24T00:00:00.000Z",
      body: html,
      contentHash: crypto.createHash("sha256").update(html).digest("hex"),
      redirects: [],
    });

    try {
      await writeFile(catalogPath, `${JSON.stringify(bundledCatalog)}\n`, "utf8");
      const job = queueSearch({ query: "ASUS-G4-001", brand: "ASUS", category: "motherboard", officialOnly: true }, { discoveryProviders: [provider], fetcher, inspect: true });
      const completed = await waitForJob(job.jobId);
      const candidate = completed?.candidates[0];
      expect(completed).toMatchObject({ status: "completed", discovery: { providerIds: [provider.id] } });
      if (!candidate) throw new Error("C7 fixture discovery did not produce a candidate");
      expect(candidate).toMatchObject({ source: { kind: "official", finalUrl: url }, match: { kind: "exact-mpn" }, extraction: { status: "ok" } });
      expect(candidate?.fields.some((field: { value: unknown }) => field.value === "9999 W")).toBe(false);

      const accepted = await runAutoEnrichment(candidate.candidateId, {
        candidate,
        expectedHash: candidate.expectedHash,
        autoEnrichTrustedOfficial: true,
        autoAcceptExactMpn: true,
        catalogWriteEnabled: true,
        catalogPath,
        rollbackRoot,
        rollbackManifestPath,
        auditRoot: path.join(root, "audit"),
        draftRoot: path.join(root, "drafts"),
      });
      expect(accepted).toMatchObject({ status: "draft", writeEnabled: true, proposed: expect.any(Object), fields: expect.any(Array), missing: [] });
      const confirmed = await confirmDraft(accepted.draftId, {
        approved: true,
        expectedHash: accepted.expectedHash,
        catalogWriteEnabled: true,
        catalogPath,
        draftRoot: path.join(root, "drafts"),
        rollbackRoot,
        rollbackManifestPath,
        auditRoot: path.join(root, "audit"),
      });
      expect(confirmed).toMatchObject({ status: "confirmed", rollbackManifest: rollbackManifestPath, sku: expect.any(Object) });

      const enriched = JSON.parse(await readFile(catalogPath, "utf8")) as SkuCatalog;
      expect(enriched.skus.some((sku) => sku.mpn === "ASUS-G4-001")).toBe(true);
      const evaluation = evaluateBuild(baseline as BuildConfig, enriched);
      expect(evaluation.findings.length).toBeGreaterThan(0);
      expect(evaluation.bom.some((line) => line.skuId === "board.asus-w680m-ace-se")).toBe(true);

      await rollbackCatalogAcceptance(catalogPath, { rollbackManifestPath });
      const restored = JSON.parse(await readFile(catalogPath, "utf8")) as SkuCatalog;
      expect(restored).toEqual(bundledCatalog);
      expect(evaluateBuild(baseline as BuildConfig, restored)).toEqual(evaluateBuild(baseline as BuildConfig, bundledCatalog as SkuCatalog));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
