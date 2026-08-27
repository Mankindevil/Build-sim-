import { describe, expect, it, vi } from "vitest";
import { discoverOfficialDocumentLinks, EvidenceDiscoveryError } from "../src/evidence/discovery.mjs";

function result(url: string, body: string, contentType = "text/html") {
  return { requestedUrl: url, finalUrl: url, status: 200, contentType, retrievedAt: "2026-08-27T00:00:00.000Z", body, contentHash: "a".repeat(64), redirects: [] };
}

describe("official evidence document discovery", () => {
  it("ranks same-brand manual PDFs and rejects unrelated or cross-brand links", async () => {
    const start = "https://www.jonsbo.com/en/products/N6Black.html";
    const fetcher = vi.fn(async (_url: string, _options: Record<string, unknown>) => result(start, `
      <a href="/Upfiles/down/N6%20Installation%20Manual.pdf">N6 Installation Manual</a>
      <a href="/en/products/N6-support">N6 Support</a>
      <a href="/images/N6.jpg">Gallery</a>
      <a href="https://www.asus.com/manual.pdf">Other vendor manual</a>
    `));
    const discovered = await discoverOfficialDocumentLinks(start, { fetcher, queryTokens: ["JONSBO", "N6"], followPageLimit: 0 });
    expect(discovered).toMatchObject({ officialBrand: "JONSBO", pagesInspected: 1 });
    expect(discovered.candidates).toEqual([
      expect.objectContaining({ url: "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf", kindHint: "manufacturer-manual", mediaTypeHint: "application/pdf" }),
    ]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ expectedBrand: "JONSBO", includeBody: false });
  });

  it("follows a bounded official support page once to find a CDN subdomain PDF", async () => {
    const product = "https://www.asus.com/motherboards/example";
    const support = "https://www.asus.com/supportonly/example/helpdesk_manual/";
    const manual = "https://dlcdnets.asus.com/pub/ASUS/example/E0001_manual.pdf";
    const fetcher = vi.fn(async (url: string) => url === product
      ? result(product, `<a href="${support}">Manual & documents</a>`)
      : result(support, `<a href="${manual}">English User Manual</a>`));
    const discovered = await discoverOfficialDocumentLinks(product, { fetcher, queryTokens: ["example"], followPageLimit: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(discovered.pagesInspected).toBe(2);
    expect(discovered.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ url: manual, score: expect.any(Number) })]));
  });

  it("accepts a direct trusted PDF without crawling", async () => {
    const url = "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf";
    const fetcher = vi.fn(async () => result(url, "extracted text", "application/pdf"));
    const discovered = await discoverOfficialDocumentLinks(url, { fetcher, title: "N6 User Guide" });
    expect(discovered.candidates[0]).toMatchObject({ url, title: "N6 User Guide", kindHint: "manufacturer-manual" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects non-success responses with a typed upstream error", async () => {
    const url = "https://www.jonsbo.com/en/products/missing.html";
    const fetcher = vi.fn(async () => ({ ...result(url, '<a href="/manual.pdf">N6 manual</a>'), status: 404 }));
    const error = await discoverOfficialDocumentLinks(url, { fetcher }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvidenceDiscoveryError);
    expect(error).toMatchObject({ code: "document_discovery_http_status" });
  });

  it("rejects malformed bounds instead of silently returning an empty candidate set", async () => {
    const url = "https://www.jonsbo.com/en/products/N6Black.html";
    const fetcher = vi.fn(async () => result(url, '<a href="/manual.pdf">N6 manual</a>'));
    await expect(discoverOfficialDocumentLinks(url, { fetcher, limit: "not-a-number" as unknown as number })).rejects.toMatchObject({
      code: "document_discovery_options_invalid",
    });
    await expect(discoverOfficialDocumentLinks(url, { fetcher, followPageLimit: 4 })).rejects.toMatchObject({
      code: "document_discovery_options_invalid",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies bounded fetch failures and prevents fetch options from weakening brand/body controls", async () => {
    const url = "https://www.jonsbo.com/en/products/N6Black.html";
    const timeoutFetcher = vi.fn(async (_url: string, _options: Record<string, unknown>) => { throw new Error("official fetch timeout"); });
    await expect(discoverOfficialDocumentLinks(url, {
      fetcher: timeoutFetcher,
      fetchOptions: { expectedBrand: "ASUS", includeBody: true },
    })).rejects.toMatchObject({ code: "document_discovery_timeout" });
    expect(timeoutFetcher.mock.calls[0]?.[1]).toMatchObject({ expectedBrand: "JONSBO", includeBody: false });
  });

  it("finds bounded official PDFs embedded in data attributes and escaped HTML/JSON", async () => {
    const start = "https://www.jonsbo.com/en/products/N6Black.html";
    const dataPdf = "https://www.jonsbo.com/Upfiles/down/N6-data-manual.pdf";
    const jsonPdf = "https://www.jonsbo.com/Upfiles/down/N6-json-datasheet.pdf?lang=en&rev=2";
    const relativePdf = "https://www.jonsbo.com/en/products/downloads/N6-relative-guide.pdf";
    const fetcher = vi.fn(async (_url: string, _options: Record<string, unknown>) => result(start, `
      <button aria-label="Download N6 manual" data-download="https:\\/\\/www.jonsbo.com\\/Upfiles\\/down\\/N6-data-manual.pdf"></button>
      <div data-file="downloads/N6-relative-guide.pdf" title="N6 User Guide"></div>
      <script type="application/json">
        {"manual":"https:\\/\\/www.jonsbo.com\\/Upfiles\\/down\\/N6-json-datasheet.pdf?lang=en&amp;rev=2"}
      </script>
      <button data-url="/Upfiles/down/N6-QIG.pdf" aria-label="Download N6 Quick Installation Guide"></button>
      <button data-url="/Upfiles/down/N6-RoHS.pdf" aria-label="Download N6 RoHS certificate"></button>
      <button data-url="/en/products/N6/modal" aria-label="Download N6 Datasheet"></button>
      <div data-file="https://www.asus.com/cross-brand.pdf" title="Other manual"></div>
    `));

    const discovered = await discoverOfficialDocumentLinks(start, { fetcher, queryTokens: ["JONSBO", "N6"], followPageLimit: 0 });
    expect(discovered.candidates.map((candidate) => candidate.url)).toEqual(expect.arrayContaining([dataPdf, jsonPdf, relativePdf, "https://www.jonsbo.com/Upfiles/down/N6-QIG.pdf"]));
    expect(discovered.candidates.find((candidate) => candidate.url.endsWith("N6-QIG.pdf"))?.kindHint).toBe("support-document");
    expect(discovered.candidates).toHaveLength(4);
  });
});
