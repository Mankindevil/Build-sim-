import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceRepositoryError, FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { EvidenceAcquisitionError } from "../src/evidence/acquire.mjs";
import { EvidenceDiscoveryError } from "../src/evidence/discovery.mjs";
import { checkEvidencePostRequest, handleEvidenceRoute, matchesEvidenceEtag } from "../src/evidence/http-routes.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evidence-api-"));
  roots.push(root);
  const repository = new FileEvidenceRepository({ root, now: () => "2026-08-27T00:00:00.000Z" });
  const stored = await repository.importBuffer(Buffer.from("official manual bytes"), {
    mediaType: "application/pdf",
    kind: "manufacturer-manual",
    title: "JONSBO N6 User Guide",
    productIdentities: [{ brand: "JONSBO", model: "N6", category: "case", skuId: "case.jonsbo-n6" }],
    capture: {
      requestedUrl: "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf",
      finalUrl: "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf",
      retrievedAt: "2026-08-27T00:00:00.000Z",
      status: 200,
      redirects: [],
      officialBrand: "JONSBO",
      acquisitionMethod: "bundled-import",
    },
  });
  return { repository, stored };
}

describe("official evidence API contract", () => {
  it("returns immutable metadata and exact bytes with content headers", async () => {
    const { repository, stored } = await fixture();
    const metadata = await handleEvidenceRoute("GET", `/api/evidence/documents/${stored.document.id}`, {}, repository);
    expect(metadata).toMatchObject({ handled: true, status: 200, payload: { document: { id: stored.document.id }, captures: [{ id: stored.capture.id }] } });
    const combinedRead = vi.spyOn(repository, "getDocumentContent");
    const metadataRead = vi.spyOn(repository, "getDocument");
    const byteRead = vi.spyOn(repository, "readContent");
    const content = await handleEvidenceRoute("GET", `/api/evidence/documents/${stored.document.id}/content`, {}, repository);
    expect(content).toMatchObject({ handled: true, status: 200, headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": expect.stringContaining("attachment"),
      "Content-Security-Policy": "sandbox; default-src 'none'",
      ETag: `"${stored.document.sha256}"`,
    } });
    expect(Buffer.isBuffer(content.binary)).toBe(true);
    expect(content.binary?.toString("utf8")).toBe("official manual bytes");
    expect(combinedRead).toHaveBeenCalledOnce();
    expect(metadataRead).not.toHaveBeenCalled();
    expect(byteRead).not.toHaveBeenCalled();
  });

  it("derives acquisition identity from the governed SKU instead of client-authored metadata", async () => {
    const { repository } = await fixture();
    const acquire = vi.fn(async (_url, options) => ({ document: { id: "doc" }, capture: { id: "capture" }, reusedCapture: false, received: options }));
    const catalog = { skus: [{ id: "case.jonsbo-n6", brand: "JONSBO", model: "N6", name: "JONSBO N6", category: "case", appearance: { page: "https://www.jonsbo.com/en/products/N6Black.html" } }] };
    const response = await handleEvidenceRoute("POST", "/api/evidence/acquisitions", {
      url: "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf",
      skuId: "case.jonsbo-n6",
      identity: { brand: "ASUS", model: "spoofed" },
    }, repository, { acquire, catalog });
    expect(response.status).toBe(201);
    expect(acquire.mock.calls[0]?.[1]).toMatchObject({
      officialBrand: "JONSBO",
      productIdentities: [{ brand: "JONSBO", model: "N6", skuId: "case.jonsbo-n6", basis: "governed-sku-user-asserted" }],
    });
  });

  it("discovers from the SKU page, falls back to governed site search, and reports a missing governed seed", async () => {
    const { repository } = await fixture();
    const discover = vi.fn(async (url, options) => ({ startUrl: url, candidates: [], queryTokens: options.queryTokens }));
    const catalog = { skus: [
      { id: "case.jonsbo-n6", brand: "JONSBO", model: "N6", name: "JONSBO N6", category: "case", appearance: { page: "https://www.jonsbo.com/en/products/N6Black.html" } },
      { id: "gpu.no-page", brand: "NVIDIA", model: "No Page", name: "No Page", category: "gpu" },
      { id: "gpu.no-registry", brand: "Fixture Brand", model: "No Registry", name: "No Registry", category: "gpu" },
    ] };
    const found = await handleEvidenceRoute("POST", "/api/evidence/discover", { skuId: "case.jonsbo-n6" }, repository, { discover, catalog });
    expect(found).toMatchObject({ status: 200, payload: { startUrl: "https://www.jonsbo.com/en/products/N6Black.html" } });
    const fallback = await handleEvidenceRoute("POST", "/api/evidence/discover", { skuId: "gpu.no-page" }, repository, { discover, catalog });
    expect(fallback).toMatchObject({ status: 200, payload: { startUrl: expect.stringMatching(/^https:\/\/www\.nvidia\.com\/en-us\/search\//) } });
    expect(decodeURIComponent(fallback.payload.startUrl)).toContain("NVIDIA No Page manual user guide datasheet");
    const missing = await handleEvidenceRoute("POST", "/api/evidence/discover", { skuId: "gpu.no-registry" }, repository, { discover, catalog });
    expect(missing).toMatchObject({ status: 422, payload: { error: "document_start_url_missing", manualAction: expect.stringContaining("official catalog search") } });
  });

  it("rejects a client identity whose brand conflicts with the trusted domain", async () => {
    const { repository } = await fixture();
    const response = await handleEvidenceRoute("POST", "/api/evidence/acquisitions", {
      url: "https://www.jonsbo.com/manual.pdf",
      identity: { brand: "ASUS", model: "N6" },
    }, repository, { acquire: vi.fn() });
    expect(response).toMatchObject({ status: 409, payload: { error: "identity_brand_mismatch" } });
  });

  it("does not accept a client-authored precise model without a governed SKU", async () => {
    const { repository } = await fixture();
    const response = await handleEvidenceRoute("POST", "/api/evidence/acquisitions", {
      url: "https://www.jonsbo.com/manual.pdf",
      identity: { brand: "JONSBO", model: "Unreviewed model" },
    }, repository, { acquire: vi.fn() });
    expect(response).toMatchObject({ status: 422, payload: { error: "ungoverned_product_identity" } });
  });

  it("labels a brand-only association as official-domain-only", async () => {
    const acquire = vi.fn(async (_url, options) => ({ document: { id: "doc" }, capture: { id: "capture" }, reusedCapture: false, received: options }));
    const response = await handleEvidenceRoute("POST", "/api/evidence/acquisitions", {
      url: "https://www.jonsbo.com/manual.pdf",
    }, {}, { acquire });
    expect(response.status).toBe(201);
    expect(acquire.mock.calls[0]?.[1]).toMatchObject({ productIdentities: [{ brand: "JONSBO", basis: "official-domain-only" }] });
  });

  it("maps acquisition and discovery failures to explicit HTTP statuses", async () => {
    const acquisitionCases = [
      ["manual_body_missing", 502],
      ["manual_persist_failed", 500],
      ["manual_cache_read_failed", 500],
      ["manual_response_invalid", 502],
      ["manual_hash_mismatch", 502],
      ["manual_not_modified_without_cache", 409],
      ["manual_too_large", 413],
      ["manual_brand_mismatch", 409],
    ];
    for (const [code, status] of acquisitionCases) {
      const response = await handleEvidenceRoute("POST", "/api/evidence/acquisitions", {
        url: "https://www.jonsbo.com/manual.pdf",
      }, {}, {
        acquire: async () => { throw new EvidenceAcquisitionError(code, "fixture failure", "fixture action"); },
      });
      expect(response).toMatchObject({ status, payload: { error: code } });
    }

    const discoveryCases = [
      ["document_discovery_options_invalid", 400],
      ["document_discovery_brand_mismatch", 409],
      ["document_discovery_too_large", 413],
      ["document_discovery_http_status", 502],
      ["document_discovery_fetch_failed", 502],
      ["document_discovery_response_invalid", 502],
      ["document_discovery_timeout", 504],
    ];
    for (const [code, status] of discoveryCases) {
      const response = await handleEvidenceRoute("POST", "/api/evidence/discover", {
        url: "https://www.jonsbo.com/products/N6.html",
      }, {}, {
        discover: async () => { throw new EvidenceDiscoveryError(code, "fixture failure", "fixture action"); },
      });
      expect(response).toMatchObject({ status, payload: { error: code } });
    }

    const integrity = await handleEvidenceRoute("GET", `/api/evidence/documents/doc-sha256-${"a".repeat(64)}`, {}, {
      getDocument: async () => { throw new EvidenceRepositoryError("integrity_error", "fixture corruption"); },
    });
    expect(integrity).toMatchObject({ status: 500, payload: { error: "integrity_error" } });
  });

  it("requires JSON and rejects browser cross-site evidence writes", () => {
    expect(checkEvidencePostRequest({ "content-type": "application/json" })).toBeNull();
    expect(checkEvidencePostRequest({
      "content-type": "application/json; charset=utf-8",
      host: "127.0.0.1:5173",
      origin: "http://127.0.0.1:5173",
      "sec-fetch-site": "same-origin",
    })).toBeNull();
    expect(checkEvidencePostRequest({
      "content-type": "application/json",
      host: "build.example",
      origin: "https://build.example",
      "sec-fetch-site": "same-origin",
      "x-forwarded-proto": "https",
    })).toBeNull();

    expect(checkEvidencePostRequest({ "content-type": "text/plain" })).toMatchObject({ status: 415, payload: { error: "evidence_content_type_required" } });
    expect(checkEvidencePostRequest({
      "content-type": "application/json",
      host: "127.0.0.1:5174",
      origin: "https://attacker.example",
    })).toMatchObject({ status: 403, payload: { error: "evidence_origin_forbidden" } });
    expect(checkEvidencePostRequest({
      "content-type": "application/json",
      host: "127.0.0.1:5174",
      "sec-fetch-site": "cross-site",
    })).toMatchObject({ status: 403, payload: { error: "evidence_cross_site_forbidden" } });
    expect(checkEvidencePostRequest({
      "content-type": "application/json",
      host: "attacker.example",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-origin",
    })).toMatchObject({ status: 403, payload: { error: "evidence_origin_forbidden" } });
  });

  it("matches standard If-None-Match lists, weak validators, and wildcard", () => {
    const current = '"abc123"';
    expect(matchesEvidenceEtag(current, current)).toBe(true);
    expect(matchesEvidenceEtag('W/"abc123"', current)).toBe(true);
    expect(matchesEvidenceEtag('"other", W/"abc123"', current)).toBe(true);
    expect(matchesEvidenceEtag('"tag,with,commas", "abc123"', current)).toBe(true);
    expect(matchesEvidenceEtag("*", current)).toBe(true);
    expect(matchesEvidenceEtag('"other"', current)).toBe(false);
    expect(matchesEvidenceEtag('W/"other"', current)).toBe(false);
    expect(matchesEvidenceEtag('"unterminated', current)).toBe(false);
  });
});
