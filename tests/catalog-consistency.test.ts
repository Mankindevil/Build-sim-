import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogConsistencyIssues, indexSkus, loadRawCatalog } from "../src/sku/catalog";
import type { SkuRecord } from "../src/sku/types";

const catalog = loadRawCatalog();

function optionValues(html: string, selectId: string): string[] {
  const select = html.match(new RegExp(`<select id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`));
  expect(select, `missing #${selectId}`).not.toBeNull();
  return [...(select?.[1] ?? "").matchAll(/<option\s+value=["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
}

describe("catalog consistency", () => {
  it("has no contradictory cross-field counts", () => {
    expect(catalogConsistencyIssues(catalog)).toEqual([]);
  });

  it("locks the reviewed PSU-side peripheral socket counts", () => {
    const expected = new Map<string, number>([
      ["psu.seasonic-focus-plus-gold-850-fx", 4],
      ["psu.seasonic-focus-gx-850-v5", 3],
      ["psu.seasonic-focus-gx-750-v5", 3],
      ["psu.corsair-sf750-atx31", 3],
      ["psu.corsair-sf1000-atx31", 3],
      ["psu.fsp-dagger-pro-850-atx31", 2],
    ]);

    for (const [id, sockets] of expected) {
      const sku = catalog.skus.find((candidate) => candidate.id === id);
      expect(sku?.attrs?.peripheralSockets, id).toBe(sockets);
      expect(
        sku?.modularPanel?.groups.find((group) => group.id === "peripheral")?.sockets,
        id,
      ).toBe(sockets);
    }
  });

  it("keeps core component selectors unique and backed by the correct catalog category", () => {
    const html = readFileSync(new URL("../src/lab/app-document.html", import.meta.url), "utf8");
    const skus = indexSkus(catalog);
    const selectors: Array<[string, SkuRecord["category"]]> = [
      ["psu-select", "psu"],
      ["secondary-psu-select", "psu"],
      ["cooler-select", "cooler"],
      ["gpu-select", "gpu"],
      ["ram-select", "memory"],
    ];

    for (const [selectId, category] of selectors) {
      const values = optionValues(html, selectId).filter((value) => value !== "custom");
      expect(new Set(values).size, `duplicate value in #${selectId}`).toBe(values.length);
      for (const value of values) expect(skus.get(value)?.category, `${selectId}: ${value}`).toBe(category);
    }
  });
});
