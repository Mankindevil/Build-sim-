// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SkuCatalog, SkuRecord } from "../src/sku/types";
import {
  escapeRuntimeHtml,
  renderBackplaneHarnessSummary,
  renderRuntimeProductGallery,
  safeCatalogImageUrl,
  safeHttpsUrl,
} from "../src/lab/runtime-dom";

function fixtureSku(overrides: Partial<SkuRecord> = {}): SkuRecord {
  return {
    id: "gpu.runtime-xss",
    category: "gpu",
    brand: "Fixture",
    model: "Runtime XSS",
    name: "Runtime XSS",
    mpn: "RUNTIME-XSS",
    dims: { evidence: "unknown" },
    power: { evidence: "unknown" },
    price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    ...overrides,
  };
}

function catalogWith(sku: SkuRecord): SkuCatalog {
  return { schemaVersion: "2.0.0", updatedAt: "2026-08-26", skus: [sku] };
}

function expectNoExecutableMarkup(root: ParentNode): void {
  expect(root.querySelector("script, iframe, svg, [onerror], [onload], [onclick], [onmouseover]")).toBeNull();
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    expect(new URL(anchor.href).protocol).toBe("https:");
  }
}

describe("runtime catalog DOM security", () => {
  it("renders accepted SKU text literally and drops executable image/page URLs", () => {
    const injected = '<img src=x onerror="globalThis.pwned=1">';
    const sku = fixtureSku({
      name: injected,
      mpn: `RUNTIME-XSS\" onmouseover=\"globalThis.pwned=2`,
      appearance: {
        image: 'javascript:alert(1)\" onerror=\"globalThis.pwned=3',
        page: "javascript:alert(4)",
        note: '<svg onload="globalThis.pwned=5"></svg>',
      },
      price: {
        currency: "CNY",
        historicalLowEvidence: "unknown",
        currentEvidence: "unknown",
        note: '<img src=x onerror="globalThis.pwned=6">',
      },
    });
    const gallery = document.createElement("div");

    renderRuntimeProductGallery(gallery, [{ name: sku.name, status: "待购", skuId: sku.id }], catalogWith(sku));

    expect(gallery.querySelector("b")?.textContent).toBe(injected);
    expect(gallery.querySelector(".product-placeholder")?.textContent).toContain("<svg onload");
    expect(gallery.querySelector("img")).toBeNull();
    expect([...gallery.querySelectorAll("a")].some((anchor) => anchor.textContent === "查看厂商官方页")).toBe(false);
    expectNoExecutableMarkup(gallery);
  });

  it("keeps controlled images and quoted HTTPS URLs as inert attributes", () => {
    const sku = fixtureSku({
      appearance: {
        image: "public/assets/reference/gpu.png",
        page: 'https://vendor.example/products/%22?note=" onmouseover="alert(1)',
      },
    });
    const gallery = document.createElement("div");
    renderRuntimeProductGallery(gallery, [{ name: sku.name, status: "待购", skuId: sku.id }], catalogWith(sku));

    expect(gallery.querySelector("img")?.getAttribute("src")).toBe("/assets/reference/gpu.png");
    const official = [...gallery.querySelectorAll("a")].find((anchor) => anchor.textContent === "查看厂商官方页");
    expect(official?.href).toMatch(/^https:\/\/vendor\.example\//);
    expect(official?.hasAttribute("onmouseover")).toBe(false);
    expectNoExecutableMarkup(gallery);
  });

  it("rejects encoded traversal and encoded slash asset paths", () => {
    expect(safeCatalogImageUrl("assets/official/gpu.png")).toBe("/assets/official/gpu.png");
    expect(safeCatalogImageUrl("/assets/official/gpu.png")).toBe("/assets/official/gpu.png");
    expect(safeCatalogImageUrl("assets/%2e%2e/secrets.png")).toBeNull();
    expect(safeCatalogImageUrl("assets/official%2fgpu.png")).toBeNull();
    expect(safeCatalogImageUrl("assets/official/../gpu.png")).toBeNull();
    expect(safeCatalogImageUrl("//evil.example/gpu.png")).toBeNull();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://vendor.example/gpu")).toBeNull();
  });

  it("uses literal nodes for PSU names and the shared escape boundary for legacy price/finding text", async () => {
    const injected = '<img src=x onerror="globalThis.pwned=7">';
    const harness = document.createElement("div");
    renderBackplaneHarnessSummary(harness, "主电源", injected, "4/4 条线");
    expect(harness.querySelector("img")).toBeNull();
    expect(harness.querySelector("b")?.textContent).toBe(injected);

    const legacyCell = document.createElement("div");
    legacyCell.innerHTML = `<small>${escapeRuntimeHtml(injected)}</small>`;
    expect(legacyCell.querySelector("img")).toBeNull();
    expect(legacyCell.textContent).toBe(injected);

    const [runtime, pricePanel] = await Promise.all([
      readFile("src/lab/v1-runtime.js", "utf8"),
      readFile("src/lab/price-panel.ts", "utf8"),
    ]);
    expect(runtime).toContain("const esc = value => LAB.escapeText(value)");
    expect(runtime).toContain("${esc(x.official)}");
    expect(runtime).toContain("row.map(x=>`<td>${esc(x)}</td>`)");
    expect(runtime).toContain("LAB.renderProductGallery(ev.config)");
    expect(runtime).not.toContain("<img src=\"${ref.image}\"");
    expect(pricePanel).toContain("const href = safeHref(c.url)");
    expect(pricePanel).toContain("const href = safeHref(l.url)");
    expect(pricePanel).toContain("搜索词：${esc(l.query)}");
  });
});
