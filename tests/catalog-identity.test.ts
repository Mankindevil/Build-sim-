import { describe, expect, it } from "vitest";
import { assessCatalogIdentity, classifyOfficialPage, summarizeCatalogCandidates } from "../scripts/price-server/catalog/identity.mjs";

function candidate(raw: string, category: string, brand?: string) {
  return {
    title: "",
    url: "https://vendor.example/product",
    category,
    query: { raw, category, ...(brand ? { brand } : {}), tokens: raw.toLocaleLowerCase().split(/\s+/), locale: "zh-CN" },
  };
}

function extracted(title: string, fields: Array<{ field: string; value: unknown; provenanceId?: string }> = []) {
  return {
    title,
    fields: fields.map((field, index) => ({ provenanceId: field.provenanceId ?? `prov-${index}`, ...field })),
  };
}

describe("catalog identity assessment", () => {
  it("treats PSU generation differences as hard conflicts", () => {
    const result = assessCatalogIdentity(
      candidate("Seasonic FOCUS GX-850 V5", "psu", "Seasonic"),
      extracted("Seasonic FOCUS GX-850 V4"),
      { brand: "Seasonic" },
    );
    expect(result.verdict).toBe("conflict");
    expect(result.criticalConflicts).toContainEqual(expect.objectContaining({ field: "generation", input: "v5", candidate: "v4" }));
  });

  it("does not collapse an older FX-labelled PSU identity into a V5 page", () => {
    const result = assessCatalogIdentity(
      candidate("Seasonic FOCUS GX-850 FX", "psu", "Seasonic"),
      extracted("Seasonic FOCUS GX-850 V5"),
      { brand: "Seasonic" },
    );
    expect(result.verdict).toBe("same-family");
    expect(result.unknowns).toContain("psuMpnSuffix");
  });

  it("proves the legacy FOCUS PLUS Gold identity without requiring the user to enter its MPN", () => {
    const result = assessCatalogIdentity(
      candidate("Seasonic FOCUS PLUS Gold 850 FX", "psu", "Seasonic"),
      extracted("Seasonic FOCUS PLUS Gold 850 SSR-850FX", [
        { field: "model", value: "FOCUS PLUS Gold 850" },
        { field: "mpn", value: "SSR-850FX" },
      ]),
      { brand: "Seasonic" },
    );
    expect(result.verdict).toBe("exact");
    expect(result.queryFingerprint.mpn).toBeUndefined();
    expect(result.candidateFingerprint.mpn).toBe("ssr850fx");
  });

  it("does not treat the canonical FOCUS PLUS Gold 850 identity as a V5 ATX 3.1 unit", () => {
    const result = assessCatalogIdentity(
      candidate("Seasonic FOCUS PLUS Gold 850", "psu", "Seasonic"),
      extracted("Seasonic FOCUS GX-850 V5 ATX 3.1"),
      { brand: "Seasonic" },
    );
    expect(result.verdict).not.toBe("exact");
    expect(result.agentReviewRequired).toBe(true);
  });

  it("does not confuse WD Red Plus with WD Red Pro", () => {
    const result = assessCatalogIdentity(
      candidate("Western Digital WD Red Plus 8TB", "storage", "Western Digital"),
      extracted("Western Digital WD Red Pro 8TB"),
      { brand: "Western Digital" },
    );
    expect(result.verdict).toBe("conflict");
    expect(result.criticalConflicts).toContainEqual(expect.objectContaining({ field: "storageTier", input: "plus", candidate: "pro" }));
  });

  it("accepts matching category discriminators without inventing a missing MPN", () => {
    const result = assessCatalogIdentity(
      candidate("Western Digital WD Red Plus 8TB", "storage", "Western Digital"),
      extracted("Western Digital WD Red Plus 8TB NAS Hard Drive"),
      { brand: "Western Digital" },
    );
    expect(result.verdict).toBe("exact");
    expect(result.criticalConflicts).toHaveLength(0);
  });

  it("compares GPU capacity without treating the memory technology as part of its size", () => {
    const base = candidate("MSI RTX 3070 Ventus 2X OC 8GB GDDR6", "gpu", "MSI");
    const input = { ...base, query: { ...base.query, model: "RTX 3070 Ventus 2X OC", capacity: "8GB" } };
    const result = assessCatalogIdentity(
      input,
      extracted("GeForce RTX 3070 VENTUS 2X OC", [
        { field: "model", value: "GeForce RTX 3070 VENTUS 2X OC", provenanceId: "prov-model" },
        { field: "attrs.capacity", value: "8GB GDDR6", provenanceId: "prov-capacity" },
      ]),
      { brand: "MSI" },
    );
    expect(result.verdict).toBe("exact");
    expect(result.candidateFingerprint.capacity).toBe("8GB");
    expect(result.criticalMatches).toContainEqual(expect.objectContaining({ field: "capacity", input: "8GB", candidate: "8GB", evidenceId: "prov-capacity" }));
    expect(result.criticalMatches).toContainEqual(expect.objectContaining({ field: "memoryTechnology", input: "gddr6", candidate: "gddr6", evidenceId: "prov-capacity" }));
    expect(result.criticalConflicts).toHaveLength(0);
  });

  it("still rejects a genuinely different GPU memory capacity", () => {
    const base = candidate("MSI RTX 3070 Ventus 2X OC 8GB GDDR6", "gpu", "MSI");
    const input = { ...base, query: { ...base.query, model: "RTX 3070 Ventus 2X OC", capacity: "8GB" } };
    const result = assessCatalogIdentity(
      input,
      extracted("GeForce RTX 3070 VENTUS 2X OC", [
        { field: "model", value: "GeForce RTX 3070 VENTUS 2X OC" },
        { field: "attrs.capacity", value: "12GB GDDR6" },
      ]),
      { brand: "MSI" },
    );
    expect(result.verdict).toBe("conflict");
    expect(result.criticalConflicts).toContainEqual(expect.objectContaining({ field: "capacity", input: "8GB", candidate: "12GB" }));
  });

  it("rejects an ambiguous multi-capacity GPU page instead of taking its first value", () => {
    const base = candidate("MSI RTX 3070 Ventus 2X OC 8GB GDDR6", "gpu", "MSI");
    const input = { ...base, query: { ...base.query, model: "RTX 3070 Ventus 2X OC", capacity: "8GB" } };
    const result = assessCatalogIdentity(
      input,
      extracted("GeForce RTX 3070 VENTUS 2X OC", [
        { field: "model", value: "GeForce RTX 3070 VENTUS 2X OC" },
        { field: "attrs.capacity", value: "8GB GDDR6 / 12GB GDDR6" },
      ]),
      { brand: "MSI" },
    );
    expect(result.verdict).toBe("conflict");
    expect(result.criticalConflicts).toContainEqual(expect.objectContaining({ field: "capacity", input: "8GB", candidate: "8GBGDDR6/12GBGDDR6" }));
  });

  it("keeps GPU memory technology as a separate variant discriminator", () => {
    const base = candidate("MSI RTX 3070 Ventus 2X OC 8GB GDDR6", "gpu", "MSI");
    const input = { ...base, query: { ...base.query, model: "RTX 3070 Ventus 2X OC", capacity: "8GB" } };
    const result = assessCatalogIdentity(
      input,
      extracted("GeForce RTX 3070 VENTUS 2X OC", [
        { field: "model", value: "GeForce RTX 3070 VENTUS 2X OC" },
        { field: "attrs.capacity", value: "8GB GDDR5" },
      ]),
      { brand: "MSI" },
    );
    expect(result.verdict).toBe("conflict");
    expect(result.criticalConflicts).toContainEqual(expect.objectContaining({ field: "memoryTechnology", input: "gddr6", candidate: "gddr5", evidenceId: "prov-1" }));
  });

  it("keeps a related family unknown when a requested tier is absent", () => {
    const result = assessCatalogIdentity(
      candidate("Western Digital WD Red Plus 8TB", "storage", "Western Digital"),
      extracted("Western Digital WD Red 8TB NAS Hard Drive"),
      { brand: "Western Digital" },
    );
    expect(result.verdict).toBe("same-family");
    expect(result.unknowns).toContain("storageTier");
    expect(result.agentReviewRequired).toBe(true);
  });

  it("uses exact official MPN evidence as the strongest identity proof", () => {
    const base = candidate("WD80EFPX", "storage", "Western Digital");
    const input = { ...base, query: { ...base.query, mpn: "WD80EFPX" } };
    const result = assessCatalogIdentity(input, extracted("WD Red Plus", [{ field: "mpn", value: "WD80EFPX", provenanceId: "prov-mpn" }]), { brand: "Western Digital" });
    expect(result).toMatchObject({ verdict: "exact", score: 1, reasons: ["official MPN exactly matches"] });
    expect(result.criticalMatches).toContainEqual(expect.objectContaining({ field: "mpn", evidenceId: "prov-mpn" }));
  });
});

describe("official page classification and diagnostics", () => {
  it("never treats an access-denied page as a product page", () => {
    expect(classifyOfficialPage({ status: 403, finalUrl: "https://seasonic.com/vertex-gx", contentType: "text/html" }, { fields: [], accessBarrier: { kind: "access-denied" } })).toMatchObject({ kind: "blocked" });
  });

  it("distinguishes official forums, searches and product pages", () => {
    expect(classifyOfficialPage({ status: 200, finalUrl: "https://rog-forum.asus.com/t5/gpu/topic", contentType: "text/html" }, { fields: [] }).kind).toBe("forum");
    expect(classifyOfficialPage({ status: 200, finalUrl: "https://www.asus.com/search/result/", contentType: "text/html" }, { fields: [] }).kind).toBe("search");
    expect(classifyOfficialPage({ status: 200, finalUrl: "https://www.asus.com/motherboards/example", contentType: "text/html" }, { fields: [{ field: "brand" }, { field: "model" }, { field: "dims.lengthMm" }] }).kind).toBe("product");
  });

  it("summarizes rejected and related candidates instead of collapsing everything to zero", () => {
    expect(summarizeCatalogCandidates([
      { extraction: { status: "failed" }, source: { httpStatus: 403 }, official: { pageKind: "blocked" }, identity: { verdict: "insufficient-evidence" } },
      { extraction: { status: "partial" }, source: { httpStatus: 200 }, official: { pageKind: "product" }, identity: { verdict: "same-family" } },
      { extraction: { status: "ok" }, source: { httpStatus: 200 }, official: { pageKind: "product" }, identity: { verdict: "exact" } },
    ], 4)).toEqual({ discovered: 4, inspected: 3, fetchSucceeded: 2, productPages: 2, exact: 1, sameFamily: 1, conflicts: 0, insufficientEvidence: 1, blocked: 1, searchLinks: 0 });
  });
});
