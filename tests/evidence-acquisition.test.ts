import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOfficial } from "../scripts/price-server/catalog/fetch.mjs";
import {
  acquireOfficialEvidence,
  DEFAULT_EVIDENCE_MAX_BYTES,
  EvidenceAcquisitionError,
} from "../src/evidence/acquire.mjs";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";

const roots: string[] = [];
const publicDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];

type AcquisitionFetchOptions = {
  includeBody: boolean;
  extractContent: boolean;
  expectedBrand: string;
  maxBytes: number;
  requestHeaders: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
};

async function tempRepository(): Promise<FileEvidenceRepository> {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-evidence-acquisition-"));
  roots.push(root);
  return new FileEvidenceRepository({ root });
}

function fetched(url: string, rawBody: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: "application/pdf",
    retrievedAt: "2026-08-27T00:00:00.000Z",
    body: "",
    rawBody,
    contentHash: createHash("sha256").update(rawBody).digest("hex"),
    redirects: [],
    ...overrides,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("official fetch byte opt-in", () => {
  it("keeps default results JSON-safe and forwards only bounded conditional headers", async () => {
    const bytes = Buffer.from("official manual bytes");
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => new Response(bytes, {
      status: 200,
      headers: { "content-type": "text/plain", etag: '"manual-v1"' },
    }));
    const url = "https://www.asus.com/support/manual.pdf";

    const regular = await fetchOfficial(url, {
      lookup: publicDnsLookup,
      fetchImpl,
      requestHeaders: { "If-None-Match": '"manual-v1"', authorization: "must-not-leave-process" },
    });
    expect(regular).not.toHaveProperty("rawBody");
    expect(regular.body).toBe(bytes.toString("utf8"));
    const sent = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(sent["if-none-match"]).toBe('"manual-v1"');
    expect(sent).not.toHaveProperty("authorization");

    const archived = await fetchOfficial(url, { lookup: publicDnsLookup, fetchImpl, includeBody: true });
    expect(Buffer.isBuffer(archived.rawBody)).toBe(true);
    expect(archived.rawBody).toEqual(bytes);

    const invalidPdf = Buffer.from("not actually a parseable PDF");
    const rawArchive = await fetchOfficial(url, {
      lookup: publicDnsLookup,
      fetchImpl: async () => new Response(invalidPdf, { status: 200, headers: { "content-type": "application/pdf" } }),
      includeBody: true,
      extractContent: false,
    });
    expect(rawArchive.rawBody).toEqual(invalidPdf);
    expect(rawArchive).not.toHaveProperty("pdfExtraction");

    const notModified = await fetchOfficial(url, {
      lookup: publicDnsLookup,
      includeBody: true,
      requestHeaders: { "If-None-Match": '"manual-v1"' },
      fetchImpl: async () => new Response(null, { status: 304, headers: { "content-type": "application/pdf" } }),
    });
    expect(notModified).toMatchObject({ status: 304, body: "" });
    expect(notModified.rawBody).toEqual(Buffer.alloc(0));
  });

  it("keeps the timeout active while the response body is still streaming", async () => {
    const url = "https://www.asus.com/support/slow-manual.pdf";
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }), { status: 200, headers: { "content-type": "application/octet-stream" } }));
    await expect(fetchOfficial(url, { lookup: publicDnsLookup, fetchImpl, timeoutMs: 25, includeBody: true })).rejects.toThrow(/timeout/);
  });

  it("rejects a cross-brand redirect before sending the redirected request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://www.jonsbo.com/other-brand.pdf" },
    }));
    await expect(fetchOfficial("https://www.asus.com/support/manual.pdf", {
      lookup: publicDnsLookup,
      fetchImpl,
      expectedBrand: "ASUS",
    })).rejects.toThrow(/expected manufacturer brand/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("official evidence acquisition", () => {
  it("archives bytes once and reuses a fresh URL-indexed capture", async () => {
    const repository = await tempRepository();
    const url = "https://www.asus.com/support/manual-cache.pdf";
    const bytes = Buffer.from("cacheable official manual");
    const fetcher = vi.fn(async () => fetched(url, bytes, { etag: '"cache-v1"' }));

    const first = await acquireOfficialEvidence(url, {
      repository,
      fetcher,
      clock: () => new Date("2026-08-27T00:00:00.000Z"),
      officialBrand: "ASUS",
      title: "Cache manual",
    });
    const second = await acquireOfficialEvidence(url, {
      repository,
      fetcher,
      clock: () => new Date("2026-08-27T01:00:00.000Z"),
      officialBrand: "ASUS",
      title: "Cache manual",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ cacheStatus: "miss", reusedDocument: false, reusedCapture: false });
    expect(first.capture).toMatchObject({ acquisitionMethod: "official-fetch", officialBrand: "ASUS", kindBasis: "user-asserted" });
    expect(second).toMatchObject({ cacheStatus: "fresh", reusedDocument: true, reusedCapture: true });
    expect(second.capture.id).toBe(first.capture.id);
    expect(await repository.readContent(first.document.id)).toEqual(bytes);
  });

  it("conditionally revalidates a stale URL and records a 304 against the existing document", async () => {
    const repository = await tempRepository();
    const url = "https://www.asus.com/support/manual-revalidate.pdf";
    const bytes = Buffer.from("conditionally cached manual");
    let now = "2026-08-27T00:00:00.000Z";
    const requests: AcquisitionFetchOptions[] = [];
    const fetcher = vi.fn(async (_url: string, request: AcquisitionFetchOptions) => {
      requests.push(request);
      return requests.length === 1
        ? fetched(url, bytes, { etag: '"manual-v1"', lastModified: "Wed, 26 Aug 2026 00:00:00 GMT" })
        : { requestedUrl: url, finalUrl: url, status: 304, contentType: "", retrievedAt: now, body: "", redirects: [] };
    });
    const common = {
      repository,
      fetcher,
      cacheTtlMs: 1_000,
      clock: () => new Date(now),
      officialBrand: "ASUS",
      title: "Revalidation manual",
      fetchOptions: { timeoutMs: 2_222, maxRedirects: 2, includeBody: false, maxBytes: 1, requestHeaders: { authorization: "blocked" } },
    };

    const first = await acquireOfficialEvidence(url, common);
    now = "2026-08-27T01:00:00.000Z";
    const revalidated = await acquireOfficialEvidence(url, common);

    expect(requests[0]).toMatchObject({
      includeBody: true,
      extractContent: false,
      expectedBrand: "ASUS",
      maxBytes: DEFAULT_EVIDENCE_MAX_BYTES,
      timeoutMs: 2_222,
      maxRedirects: 2,
      requestHeaders: {},
    });
    expect(requests[1]?.requestHeaders).toEqual({
      "if-none-match": '"manual-v1"',
      "if-modified-since": "Wed, 26 Aug 2026 00:00:00 GMT",
    });
    expect(revalidated).toMatchObject({ cacheStatus: "revalidated", notModified: true, reusedDocument: true });
    expect(revalidated.document.id).toBe(first.document.id);
    expect(revalidated.capture).toMatchObject({ status: 304, acquisitionMethod: "official-fetch", etag: '"manual-v1"' });
    expect(revalidated.capture.id).not.toBe(first.capture.id);
    expect(await repository.listCaptures(first.document.id)).toHaveLength(2);
  });

  it("deduplicates identical bytes acquired from different official URL aliases", async () => {
    const repository = await tempRepository();
    const firstUrl = "https://www.asus.com/support/manual-a.pdf";
    const secondUrl = "https://dlcdnets.asus.com/pub/manual-b.pdf";
    const bytes = Buffer.from("one immutable manual revision");
    let now = "2026-08-27T00:00:00.000Z";
    const fetcher = vi.fn(async (url: string) => fetched(url, bytes));
    const metadata = { repository, fetcher, cacheTtlMs: 0, clock: () => new Date(now), officialBrand: "ASUS", title: "Shared manual" };

    const first = await acquireOfficialEvidence(firstUrl, metadata);
    now = "2026-08-27T01:00:00.000Z";
    const second = await acquireOfficialEvidence(secondUrl, metadata);

    expect(second.document.id).toBe(first.document.id);
    expect(second.reusedDocument).toBe(true);
    expect(second.capture.id).not.toBe(first.capture.id);
    expect((await repository.getLatestCaptureForUrl(secondUrl))?.id).toBe(second.capture.id);
    expect(await repository.listCaptures(first.document.id)).toHaveLength(2);
  });

  it("accepts a 7.35 MB manual but rejects bytes above the 25 MB default", async () => {
    const repository = await tempRepository();
    const acceptedUrl = "https://www.asus.com/support/manual-7mb.pdf";
    const rejectedUrl = "https://www.asus.com/support/manual-oversize.pdf";
    const acceptedBytes = Buffer.alloc(7_348_280, 0x61);
    const rejectedBytes = Buffer.alloc(DEFAULT_EVIDENCE_MAX_BYTES + 1, 0x62);
    let expectedMaxBytes = DEFAULT_EVIDENCE_MAX_BYTES;
    const fetcher = vi.fn(async (url: string, request: AcquisitionFetchOptions) => {
      expect(request.maxBytes).toBe(expectedMaxBytes);
      return fetched(url, url === rejectedUrl ? rejectedBytes : acceptedBytes);
    });
    const metadata = { repository, fetcher, cacheTtlMs: 0, officialBrand: "ASUS", title: "Bounded manual" };

    const accepted = await acquireOfficialEvidence(acceptedUrl, metadata);
    expect(accepted.document.byteLength).toBe(7_348_280);
    await expect(acquireOfficialEvidence(rejectedUrl, metadata)).rejects.toMatchObject({ code: "manual_too_large" });
    expect(await repository.getLatestCaptureForUrl(rejectedUrl)).toBeNull();

    vi.stubEnv("EVIDENCE_FETCH_MAX_BYTES", "8000000");
    expectedMaxBytes = 8_000_000;
    const envOverride = await acquireOfficialEvidence("https://www.asus.com/support/manual-env-limit.pdf", metadata);
    expect(envOverride.document.byteLength).toBe(7_348_280);

    expectedMaxBytes = 9_000_000;
    const explicitOverride = await acquireOfficialEvidence("https://www.asus.com/support/manual-explicit-limit.pdf", { ...metadata, maxBytes: 9_000_000 });
    expect(explicitOverride.document.byteLength).toBe(7_348_280);
  });

  it("rejects untrusted URLs and keeps fetch failures bounded with a manual action", async () => {
    const repository = await tempRepository();
    const fetcher = vi.fn(async () => { throw new Error("sensitive-upstream-detail ".repeat(100)); });

    await expect(acquireOfficialEvidence("http://www.asus.com/manual.pdf", { repository, fetcher })).rejects.toMatchObject({
      code: "manual_url_invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();

    const error = await acquireOfficialEvidence("https://www.asus.com/support/manual-failure.pdf", {
      repository,
      fetcher,
      cacheTtlMs: 0,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvidenceAcquisitionError);
    expect(error).toMatchObject({ code: "manual_fetch_failed" });
    expect((error as EvidenceAcquisitionError).message.length).toBeLessThanOrEqual(240);
    expect((error as EvidenceAcquisitionError).manualAction).toMatch(/manually|manual/i);
  });

  it("rejects trusted cross-brand redirects and mismatched product identities before persistence", async () => {
    const repository = await tempRepository();
    const requestedUrl = "https://www.jonsbo.com/manual.pdf";
    const asusUrl = "https://www.asus.com/support/manual.pdf";
    const bytes = Buffer.from("wrong manufacturer bytes");
    const crossBrand = vi.fn(async () => fetched(requestedUrl, bytes, { finalUrl: asusUrl, redirects: [asusUrl] }));
    await expect(acquireOfficialEvidence(requestedUrl, {
      repository,
      fetcher: crossBrand,
      cacheTtlMs: 0,
      officialBrand: "JONSBO",
      productIdentities: [{ brand: "JONSBO", model: "N6" }],
    })).rejects.toMatchObject({ code: "manual_brand_mismatch" });
    expect(await repository.getLatestCaptureForUrl(requestedUrl)).toBeNull();

    const fetcher = vi.fn(async () => fetched(requestedUrl, bytes));
    await expect(acquireOfficialEvidence(requestedUrl, {
      repository,
      fetcher,
      productIdentities: [{ brand: "ASUS", model: "N6" }],
    })).rejects.toMatchObject({ code: "manual_brand_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
