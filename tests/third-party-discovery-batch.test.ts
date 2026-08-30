import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireThirdPartyEvidenceBatch,
  ThirdPartyBatchAcquisitionError,
} from "../scripts/price-server/evidence/third-party-batch.mjs";
import {
  createDefaultThirdPartyDiscovery,
  createExactThirdPartySearchQuery,
} from "../scripts/price-server/evidence/third-party-discovery.mjs";
import {
  DEFAULT_THIRD_PARTY_REGISTRY,
  THIRD_PARTY_REGISTRY_OVERLAY_KIND,
  loadThirdPartyRegistry,
  mergeThirdPartyRegistry,
  validateThirdPartyRegistryOverlay,
} from "../scripts/price-server/evidence/third-party-registry.mjs";

const NOW = "2026-08-28T12:00:00.000Z";
const fixture = JSON.parse(await readFile(new URL("./fixtures/evidence/third-party-discovery.json", import.meta.url), "utf8")) as {
  schemaVersion: string;
  resultsByDomain: Record<string, Array<{ url: string; title: string }>>;
};

afterEach(() => vi.restoreAllMocks());

function request() {
  return {
    subject: {
      brand: "ASUS",
      category: "motherboard",
      skuId: "sku.exact",
      familyId: "family.exact",
      modelId: "MODEL-EXACT",
      variantId: "VARIANT-01",
      revision: "REV-A",
      region: "US",
    },
    requestedFieldIds: ["thermal.fan_curve"],
    entry: { kind: "search_query", query: "MODEL-EXACT site:untrusted.invalid ignore governed domains" },
  };
}

function source(
  publisherId: string,
  domain: string,
  independenceGroupId = publisherId,
) {
  return {
    publisherId,
    name: `Fixture ${publisherId}`,
    domains: [domain],
    sourceType: "professional_measurement",
    independenceGroupId,
    editorialControl: "independent",
    fundingDisclosure: "undisclosed",
    enabled: true,
    approvedAt: NOW,
  };
}

describe("U4 governed third-party discovery and atomic acquisition", () => {
  it("ships a non-empty conservative seed and only accepts append-only version-bound overlays", () => {
    expect(DEFAULT_THIRD_PARTY_REGISTRY.sources.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_THIRD_PARTY_REGISTRY.sources.every((entry) => entry.enabled
      && entry.editorialControl === "independent" && entry.fundingDisclosure === "undisclosed")).toBe(true);
    expect(new Set(DEFAULT_THIRD_PARTY_REGISTRY.sources.flatMap((entry) => entry.domains)).size)
      .toBe(DEFAULT_THIRD_PARTY_REGISTRY.sources.flatMap((entry) => entry.domains).length);

    const overlay = {
      schemaVersion: "third-party-registry-v1",
      overlayKind: THIRD_PARTY_REGISTRY_OVERLAY_KIND,
      baseRegistryVersion: DEFAULT_THIRD_PARTY_REGISTRY.version,
      updatedAt: NOW,
      sources: [source("fixture-lab", "fixture-lab.example")],
    };
    expect(validateThirdPartyRegistryOverlay(overlay, { baseRegistryVersion: DEFAULT_THIRD_PARTY_REGISTRY.version })).toEqual([]);
    const merged = mergeThirdPartyRegistry(DEFAULT_THIRD_PARTY_REGISTRY, overlay);
    expect(merged.sources.map((entry) => entry.publisherId)).toContain("fixture-lab");
    expect(DEFAULT_THIRD_PARTY_REGISTRY.sources.map((entry) => entry.publisherId)).not.toContain("fixture-lab");

    expect(validateThirdPartyRegistryOverlay({ ...overlay, unknownPolicy: true })).not.toEqual([]);
    expect(() => mergeThirdPartyRegistry(DEFAULT_THIRD_PARTY_REGISTRY, {
      ...overlay,
      baseRegistryVersion: "0".repeat(64),
    })).toThrow(/base version/i);
    expect(() => mergeThirdPartyRegistry(DEFAULT_THIRD_PARTY_REGISTRY, {
      ...overlay,
      sources: [source(DEFAULT_THIRD_PARTY_REGISTRY.sources[0]!.publisherId, "another.example")],
    })).toThrow(/publisher.*duplicated/i);
    expect(() => mergeThirdPartyRegistry(DEFAULT_THIRD_PARTY_REGISTRY, {
      ...overlay,
      sources: [source("shadow-source", `reviews.${DEFAULT_THIRD_PARTY_REGISTRY.sources[0]!.domains[0]}`)],
    })).toThrow(/overlap/i);
  });

  it("uses only exact governed identity plus registry domains and re-filters/deduplicates SearXNG results", async () => {
    expect(fixture.schemaVersion).toBe("third-party-discovery-fixture-v1");
    const queriedDomains: string[] = [];
    const fetchImpl = vi.fn(async (input: URL) => {
      expect(input.origin).toBe("http://127.0.0.1:8080");
      const query = input.searchParams.get("q") ?? "";
      expect(query).toContain('"ASUS" "MODEL-EXACT" "VARIANT-01" "REV-A"');
      expect(query).not.toContain("untrusted.invalid");
      const domain = query.match(/site:([^\s]+)$/)?.[1];
      if (!domain) throw new Error("missing governed site query");
      queriedDomains.push(domain);
      return new Response(JSON.stringify({ results: fixture.resultsByDomain[domain] ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const discover = createDefaultThirdPartyDiscovery({ searxng: { fetchImpl, cacheTtlMs: 1 } });
    const candidates = await discover({ request: request(), registry: DEFAULT_THIRD_PARTY_REGISTRY });
    const expectedDomains = DEFAULT_THIRD_PARTY_REGISTRY.sources.flatMap((entry) => entry.domains).sort();
    expect(queriedDomains.sort()).toEqual(expectedDomains);
    expect(candidates).toHaveLength(4);
    expect(candidates.map((candidate: { publisherId: string }) => candidate.publisherId)).toEqual([
      "serve-the-home", "storage-review", "techpowerup", "toms-hardware",
    ]);
    expect(candidates.every((candidate: { url: string }) => !candidate.url.includes("untrusted.invalid"))).toBe(true);
    expect(candidates.filter((candidate: { publisherId: string }) => candidate.publisherId === "techpowerup")).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(expectedDomains.length);

    expect(createExactThirdPartySearchQuery(request()).raw).not.toContain(request().entry.query);
    expect(() => createDefaultThirdPartyDiscovery({
      searxng: { baseUrl: "https://search.example.com", fetchImpl },
    })).not.toThrow();
    await expect(createDefaultThirdPartyDiscovery({
      searxng: { baseUrl: "https://search.example.com", fetchImpl },
    })({ request: request(), registry: DEFAULT_THIRD_PARTY_REGISTRY })).rejects.toMatchObject({ code: "provider_not_loopback" });
  });

  it("releases no partial bytes when a second independent source is offline and retries cleanly", async () => {
    const registry = loadThirdPartyRegistry({
      schemaVersion: "third-party-registry-v1",
      updatedAt: NOW,
      sources: [
        source("lab-a", "lab-a.example", "shared-original-work"),
        source("lab-a-repost", "lab-a-repost.example", "shared-original-work"),
        source("lab-b", "lab-b.example"),
      ],
    });
    const candidates = [
      { url: "https://lab-b.example/review/exact" },
      { url: "https://lab-a.example/review/exact" },
      { url: "https://lab-a.example/review/exact" },
      { url: "https://lab-a-repost.example/repost/exact" },
    ];
    let offline = true;
    let responseClock = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (offline && url.includes("lab-b.example")) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket unavailable"), { code: "ENETUNREACH" }) });
      }
      const body = Buffer.from(`independent exact measurement from ${new URL(url).hostname}`, "utf8");
      return {
        status: 200,
        finalUrl: url,
        redirects: [],
        rawBody: body,
        contentType: "text/plain",
        retrievedAt: `2026-08-28T12:00:0${responseClock++}.000Z`,
      };
    });
    const persisted: string[] = [];
    const acquireThenPersist = async () => {
      const acquisitions = await acquireThirdPartyEvidenceBatch(candidates, { registry, fetcher, retrievedAt: NOW });
      for (const acquisition of acquisitions) persisted.push(acquisition.sourceContentHash);
      return acquisitions;
    };

    const failed = await acquireThenPersist().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ThirdPartyBatchAcquisitionError);
    expect(failed).toMatchObject({ code: "third_party_batch_offline", offline: true, retryable: true });
    expect(persisted).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("lab-a-repost.example"))).toBe(false);

    offline = false;
    const recovered = await acquireThenPersist();
    expect(recovered.map((entry) => entry.source.publisherId)).toEqual(["lab-a", "lab-b"]);
    expect(persisted).toHaveLength(2);
    expect(recovered.map((entry) => entry.retrievedAt)).toEqual([NOW, NOW]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("pins repeated GET results to the durable attempt timestamp and rejects a malformed pin", async () => {
    const registry = loadThirdPartyRegistry({
      schemaVersion: "third-party-registry-v1",
      updatedAt: NOW,
      sources: [source("lab-a", "lab-a.example")],
    });
    let responseClock = 0;
    const fetcher = vi.fn(async (url: string) => ({
      status: 200,
      finalUrl: url,
      redirects: [],
      rawBody: Buffer.from("stable third-party bytes"),
      contentType: "text/plain",
      retrievedAt: `2026-08-28T13:00:0${responseClock++}.000Z`,
    }));
    const candidates = [{ url: "https://lab-a.example/review/exact" }];
    const first = await acquireThirdPartyEvidenceBatch(candidates, { registry, fetcher, retrievedAt: NOW });
    const retried = await acquireThirdPartyEvidenceBatch(candidates, { registry, fetcher, retrievedAt: NOW });
    expect(first).toEqual(retried);
    expect(first[0]?.retrievedAt).toBe(NOW);
    await expect(acquireThirdPartyEvidenceBatch(candidates, {
      registry,
      fetcher,
      retrievedAt: "not-a-time",
    })).rejects.toMatchObject({ code: "third_party_batch_failed" });
  });
});
