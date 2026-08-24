import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverOfficialUrls } from "../scripts/price-server/catalog/discovery.mjs";
import { normalizeModelQuery } from "../scripts/price-server/catalog/normalize.mjs";
import { createSearXngDiscoveryProvider, SearXngDiscoveryProvider, validateSearXngBaseUrl } from "../scripts/price-server/catalog/searxng-discovery.mjs";

const fixture = await readFile(new URL("./fixtures/catalog/searxng-response.json", import.meta.url), "utf8");
const query = normalizeModelQuery("ASUS-G4-001 motherboard", { brand: "ASUS", category: "motherboard" });

describe("C4 SearXNG discovery provider", () => {
  it("uses exact MPN site queries and keeps snippets as candidate evidence only", async () => {
    const fetchImpl = vi.fn(async (input: URL) => {
      expect(input.searchParams.get("q")).toBe("ASUS-G4-001 site:asus.com");
      expect(input.searchParams.get("format")).toBe("json");
      return new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new SearXngDiscoveryProvider({ fetchImpl, resultLimit: 10 });
    const result = await discoverOfficialUrls({ query, providers: [provider], limit: 10 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].provider).toBe("searxng");
    expect(result.candidates[0].snippet).toContain("2000 W");
    expect(result.candidates[0]).not.toHaveProperty("fields");
    expect(result.warnings.join(" ")).toContain("blocked");
  });

  it("rejects non-loopback endpoints and range-checks env configuration", () => {
    expect(() => validateSearXngBaseUrl("https://search.example.com")).toThrow(/loopback/);
    expect(() => createSearXngDiscoveryProvider({ SEARXNG_TIMEOUT_MS: "999999" })).toThrow(/between/);
  });

  it("rejects invalid schemas and oversized responses", async () => {
    const invalid = new SearXngDiscoveryProvider({ fetchImpl: async () => new Response("{}", { status: 200 }) });
    await expect(invalid.discover({ query, allowedDomains: ["asus.com"], limit: 1, signal: new AbortController().signal })).rejects.toThrow(/schema/);
    const large = new SearXngDiscoveryProvider({ fetchImpl: async () => new Response(JSON.stringify({ results: [], pad: "x".repeat(256) }), { status: 200 }), maxResponseBytes: 100 });
    await expect(large.discover({ query, allowedDomains: ["asus.com"], limit: 1, signal: new AbortController().signal })).rejects.toThrow(/size limit/);
  });

  it("reuses atomic disk cache without another SearXNG call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-searxng-"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [{ url: "https://www.asus.com/cached", title: "cached" }] }), { status: 200 }));
    try {
      const first = new SearXngDiscoveryProvider({ fetchImpl, cacheRoot: root, registryVersion: `fixture-${Date.now()}` });
      const input = { query, allowedDomains: ["asus.com"], limit: 1, signal: new AbortController().signal };
      expect(await first.discover(input)).toHaveLength(1);
      const second = new SearXngDiscoveryProvider({ fetchImpl, cacheRoot: root, registryVersion: first.registryVersion });
      expect(await second.discover(input)).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
