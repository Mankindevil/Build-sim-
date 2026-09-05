import { mkdtemp, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import catalog from "../../data/skus/catalog.json" with { type: "json" };
import { renderOfficialFallback } from "../price-server/catalog/browser-fallback.mjs";
import { CatalogCacheDiscoveryProvider } from "../price-server/catalog/discovery.mjs";
import { queueSearch, waitForJob } from "../price-server/catalog/service.mjs";
import { transactionCatalogSearchRequest } from "../price-server/transactions/catalog-search-request.mjs";

const skuId = "case.jonsbo-n6";
const sku = catalog.skus.find((entry) => entry.id === skuId);
if (!sku?.appearance?.page) throw new Error(`official catalog canary SKU is missing: ${skuId}`);

const persistRoot = await mkdtemp(path.join(os.tmpdir(), "build-sim-official-canary-"));
try {
  const request = transactionCatalogSearchRequest({
    query: `${sku.brand} ${sku.model}`,
    brand: sku.brand,
    model: sku.model,
    mpn: sku.mpn,
    category: sku.category,
    expectedSkuId: sku.id,
    requestId: "release-jonsbo-n6-official-canary",
    trigger: "user-confirmed-review",
  });
  const queued = await queueSearch(request, {
    persistRoot,
    catalog,
    discoveryProviders: [new CatalogCacheDiscoveryProvider(catalog)],
    inspect: true,
    // Force the same static-fetch -> missing fields -> browser fallback branch
    // used in production, and require Cloak itself rather than allowing a
    // successful Playwright substitution to masquerade as this canary.
    fetcher: async (url) => {
      if (url !== sku.appearance.page) throw new Error(`official canary followed an unexpected URL: ${url}`);
      const body = "<html><title>Forbidden</title><body>Access denied</body></html>";
      return {
        requestedUrl: url,
        finalUrl: url,
        status: 403,
        contentType: "text/html",
        retrievedAt: new Date().toISOString(),
        body,
        contentHash: crypto.createHash("sha256").update(body).digest("hex"),
        redirects: [],
      };
    },
    browserFallback: (url) => renderOfficialFallback(url, { renderer: "cloakbrowser" }),
  });
  const completed = await waitForJob(queued.jobId, 20_000, { persistRoot });
  const candidate = completed?.candidates?.find((entry) => entry.skuId === sku.id);
  const field = (name) => candidate?.fields?.find((entry) => entry.field === name)?.value;
  const valid = completed?.status === "completed"
    && candidate?.canonicalUrl === sku.appearance.page
    && candidate?.source?.fetchMode === "cloakbrowser"
    && candidate?.source?.rendererAttempts?.some((attempt) => attempt.renderer === "cloakbrowser" && attempt.outcome === "succeeded")
    && candidate?.identity?.verdict === "exact"
    && candidate?.extraction?.status === "ok"
    && field("model") === "N6"
    && field("dims.widthMm") === 305
    && field("dims.lengthMm") === 353
    && field("dims.heightMm") === 318;
  if (!valid) {
    throw new Error(`official catalog live canary failed: ${JSON.stringify({
      status: completed?.status,
      summary: completed?.summary,
      candidate: candidate && {
        canonicalUrl: candidate.canonicalUrl,
        fetchMode: candidate.source?.fetchMode,
        rendererAttempts: candidate.source?.rendererAttempts,
        identity: candidate.identity,
        extraction: candidate.extraction,
        fields: candidate.fields,
      },
    })}`);
  }
  console.log(JSON.stringify({
    status: "pass",
    skuId,
    canonicalUrl: candidate.canonicalUrl,
    fetchMode: candidate.source.fetchMode,
    rendererAttempts: candidate.source.rendererAttempts,
    fields: {
      model: field("model"),
      widthMm: field("dims.widthMm"),
      lengthMm: field("dims.lengthMm"),
      heightMm: field("dims.heightMm"),
    },
  }));
} finally {
  await rm(persistRoot, { recursive: true, force: true });
}
