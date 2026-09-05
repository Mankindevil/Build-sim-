import { describe, expect, it } from "vitest";
import { assessCatalogIdentity, classifyOfficialPage } from "../scripts/price-server/catalog/identity.mjs";

function identityCandidate({
  raw,
  brand,
  model,
  category,
  ...queryFields
}: {
  raw: string;
  brand: string;
  model: string;
  category: string;
  mpn?: string;
  capacity?: string;
  interface?: string;
}) {
  return {
    category,
    canonicalUrl: "https://www.asus.com/product/example",
    query: {
      raw,
      brand,
      model,
      category,
      ...queryFields,
      tokens: raw.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
      locale: "zh-CN",
    },
  };
}

function officialFields(brand: string, model: string) {
  return {
    title: model,
    fields: [
      { field: "brand", value: brand, provenanceId: "prov-brand", extractor: "fixture", locator: "Brand" },
      { field: "model", value: model, provenanceId: "prov-model", extractor: "fixture", locator: "Model" },
    ],
  };
}

describe("catalog identity hardening", () => {
  it("does not let an exact model bypass a missing distinct user-supplied MPN", () => {
    const result = assessCatalogIdentity(
      identityCandidate({ raw: "ASUS Pro WS X1 EX-BOARD-X1", brand: "ASUS", model: "Pro WS X1", mpn: "EX-BOARD-X1", category: "motherboard" }),
      officialFields("ASUS", "Pro WS X1"),
      { brand: "ASUS", trustStatus: "trusted" },
    );
    expect(result.verdict).toBe("same-family");
    expect(result.unknowns).toContain("mpn");
  });

  it.each([
    {
      label: "capacity",
      candidate: identityCandidate({ raw: "ASUS RTX 3070 Dual 8GB", brand: "ASUS", model: "RTX 3070 Dual", capacity: "8GB", category: "gpu" }),
      extracted: officialFields("ASUS", "RTX 3070 Dual"),
      unknown: "capacity",
    },
    {
      label: "interface",
      candidate: identityCandidate({ raw: "ASUS Storage X24 SATA", brand: "ASUS", model: "Storage X24", interface: "sata", category: "storage" }),
      extracted: officialFields("ASUS", "Storage X24"),
      unknown: "interface",
    },
    {
      label: "generation",
      candidate: identityCandidate({ raw: "ASUS FOCUS GX-850 V5", brand: "ASUS", model: "FOCUS GX-850", category: "psu" }),
      extracted: officialFields("ASUS", "FOCUS GX-850"),
      unknown: "generation",
    },
  ])("does not let exact model bypass a missing $label discriminator", ({ candidate, extracted, unknown }) => {
    const result = assessCatalogIdentity(candidate, extracted, { brand: "ASUS", trustStatus: "trusted" });
    expect(result.verdict).not.toBe("exact");
    expect(result.unknowns).toContain(unknown);
    expect(result.agentReviewRequired).toBe(true);
  });

  it("treats a trusted domain owned by another brand as an identity conflict", () => {
    const result = assessCatalogIdentity(
      identityCandidate({ raw: "JONSBO N6", brand: "JONSBO", model: "N6", category: "case" }),
      officialFields("JONSBO", "N6"),
      { brand: "ASUS", trustStatus: "trusted" },
    );
    expect(result.verdict).toBe("conflict");
    expect(result.criticalConflicts).toContainEqual(expect.objectContaining({ field: "officialDomainBrand", input: "jonsbo", candidate: "asus" }));
  });

  it("does not collapse unrelated non-ASCII brand names into an empty match", () => {
    const result = assessCatalogIdentity(
      identityCandidate({ raw: "乔思伯 N6", brand: "乔思伯", model: "N6", category: "case" }),
      officialFields("华硕", "N6"),
      undefined,
    );
    expect(result.verdict).toBe("conflict");
    expect(result.criticalConflicts).toContainEqual(expect.objectContaining({ field: "brand" }));
  });

  it("does not count a registry-injected brand as explicit page identity", () => {
    const page = classifyOfficialPage(
      { status: 200, finalUrl: "https://www.asus.com/product/example", contentType: "text/html", body: "<html><body>Example</body></html>" },
      { fields: [
        { field: "brand", value: "ASUS", extractor: "official-domain-registry-v1", locator: "trusted official domain: asus.com" },
        { field: "model", value: "Pro WS X1", extractor: "fixture", locator: "Model" },
      ] },
    );
    expect(page.kind).toBe("unknown");
  });

  it("does not use an HTML title fallback as the only explicit model proof", () => {
    const extracted = {
      title: "Pro WS X1",
      fields: [
        { field: "brand", value: "ASUS", provenanceId: "prov-brand", extractor: "fixture", locator: "Brand" },
        { field: "model", value: "Pro WS X1", provenanceId: "prov-title", extractor: "generic-official-html-v1", locator: "HTML title fallback" },
      ],
    };
    expect(classifyOfficialPage(
      { status: 200, finalUrl: "https://www.asus.com/product/example", contentType: "text/html", body: "<html><title>Pro WS X1</title></html>" },
      extracted,
    ).kind).toBe("unknown");
    const identity = assessCatalogIdentity(
      identityCandidate({ raw: "ASUS Pro WS X1", brand: "ASUS", model: "Pro WS X1", category: "motherboard" }),
      extracted,
      { brand: "ASUS", trustStatus: "trusted" },
    );
    expect(identity.verdict).not.toBe("exact");
  });

  it("blocks a short HTTP 200 soft-not-found body before product classification", () => {
    const page = classifyOfficialPage(
      { status: 200, finalUrl: "https://www.asus.com/product/missing", contentType: "text/html", body: "<html><title>404 Not Found</title><body>Page not found</body></html>" },
      { title: "404 Not Found", fields: [
        { field: "brand", value: "ASUS", extractor: "fixture", locator: "Brand" },
        { field: "model", value: "Missing Model", extractor: "fixture", locator: "Model" },
        { field: "dims.lengthMm", value: 244, extractor: "fixture", locator: "Length" },
      ] },
    );
    expect(page).toMatchObject({ kind: "blocked", reasons: ["official page is a soft not-found response"] });
  });
});
