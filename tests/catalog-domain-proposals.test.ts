import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDomainProposal, decideDomainProposal, listDomainProposals, rollbackDomainApproval } from "../scripts/price-server/catalog/domain-proposals.mjs";
import { activateOfficialRegistry, activateOfficialRegistryRepository, loadOfficialRegistry, loadOfficialRegistryRepository, registryForUrl } from "../scripts/price-server/catalog/registry.mjs";
import { queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
import { loadRuntimeFlags } from "../scripts/runtime/flags.mjs";

async function tempRegistryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-domain-proposal-"));
  const registryPath = path.join(root, "data/catalog/official-domains.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, await readFile(new URL("../data/catalog/official-domains.json", import.meta.url)), "utf8");
  return { root, registryPath };
}

afterEach(async () => {
  activateOfficialRegistry(loadOfficialRegistry(JSON.parse(await readFile(new URL("../data/catalog/official-domains.json", import.meta.url), "utf8"))));
});

describe("C5 governed domain proposals", () => {
  it("persists untrusted discovery as an idempotent proposal without inspecting it", async () => {
    const { root } = await tempRegistryRoot();
    const stamp = Date.now();
    const provider = { id: `proposal-fixture-${stamp}`, discover: async () => [{ url: `https://products.example.org/${stamp}`, title: "Example exact product", snippet: "candidate only", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 0 }] };
    try {
      const job = await queueSearch({ query: `EXAMPLE-${stamp}`, brand: "ExampleBrand", category: "storage" }, { discoveryProviders: [provider], persistRoot: root, inspect: false });
      const result = await waitForJob(job.jobId);
      expect(result?.candidates).toHaveLength(0);
      expect(result?.domainProposals).toHaveLength(1);
      expect(result?.domainProposals[0].trustStatus).toBe("proposed");
      expect(result?.officialSiteSuggestions).toEqual([
        expect.objectContaining({
          proposalId: result?.domainProposals[0].proposalId,
          inputHash: result?.domainProposals[0].inputHash,
          brand: "ExampleBrand",
          domain: "products.example.org",
          url: `https://products.example.org/${stamp}`,
        }),
      ]);
      expect(result?.summary.suggestedSites).toBe(1);
      const listed = await listDomainProposals({ persistRoot: root });
      expect(listed.proposals).toHaveLength(1);
      expect(listed.events).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("turns a user-entered official URL into a reviewable proposal before any fetch", async () => {
    const { root } = await tempRegistryRoot();
    const stamp = Date.now();
    const officialUrl = `https://support-${stamp}.example.org/products/model-x#specifications`;
    try {
      const job = await queueSearch({
        query: "ExampleBrand Model X",
        brand: "ExampleBrand",
        category: "storage",
        officialUrl,
      }, { discoveryProviders: [], persistRoot: root, inspect: false });
      const result = await waitForJob(job.jobId);
      expect(result?.candidates).toHaveLength(0);
      expect(result?.officialSiteSuggestions).toEqual([
        expect.objectContaining({
          brand: "ExampleBrand",
          domain: `support-${stamp}.example.org`,
          url: `https://support-${stamp}.example.org/products/model-x`,
          submittedByUser: true,
        }),
      ]);
      await expect(queueSearch({ query: "ExampleBrand Model X", brand: "ExampleBrand", category: "storage", officialUrl: "https://127.0.0.1/private" }, { persistRoot: root })).rejects.toThrow(/private|local/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires an expected hash for explicit approval and can roll registry back", async () => {
    const { root, registryPath } = await tempRegistryRoot();
    try {
      const proposal = await createDomainProposal({ brand: "ASUS", url: "https://specs.asus-example.com/board", provider: "fixture", mpn: "ASUS-X1" }, { persistRoot: root });
      expect((await decideDomainProposal(proposal.proposalId, "approved", "wrong", { persistRoot: root })).status).toBe("blocked");
      const approved = await decideDomainProposal(proposal.proposalId, "approved", proposal.inputHash, { persistRoot: root });
      expect(approved.status).toBe("trusted");
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      expect(loadOfficialRegistry(registry).brands.find((entry: { brand: string }) => entry.brand === "ASUS")?.domains).toContain("specs.asus-example.com");
      expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(root, "data/catalog/official-domains.overlay.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(root, "data/catalog"))).mode & 0o777).toBe(0o700);
      await rollbackDomainApproval({ persistRoot: root });
      const restored = JSON.parse(await readFile(registryPath, "utf8"));
      expect(restored.brands.find((entry: { brand: string }) => entry.brand === "ASUS").domains).not.toContain("specs.asus-example.com");
      const overlay = JSON.parse(await readFile(path.join(root, "data/catalog/official-domains.overlay.json"), "utf8"));
      expect(overlay.brands.find((entry: { brand: string }) => entry.brand === "ASUS")).toBeUndefined();
      expect(registryForUrl(new URL("https://specs.asus-example.com/board"))).toBeNull();
      expect((await decideDomainProposal(proposal.proposalId, "approved", proposal.inputHash, { persistRoot: root })).status).toBe("trusted");
      expect(registryForUrl(new URL("https://specs.asus-example.com/board"))?.brand).toBe("ASUS");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("persists every approval in the seed + overlay repository and reloads them after restart", async () => {
    const { root, registryPath } = await tempRegistryRoot();
    const overlayPath = path.join(root, "data/catalog/official-domains.overlay.json");
    try {
      const suffix = Date.now();
      const firstDomain = `first-${suffix}.fixture.example.org`;
      const secondDomain = `second-${suffix}.fixture.example.net`;
      const first = await createDomainProposal({ brand: "First Runtime Brand", url: `https://${firstDomain}/item`, provider: "fixture" }, { persistRoot: root });
      const second = await createDomainProposal({ brand: "Second Runtime Brand", url: `https://${secondDomain}/item`, provider: "fixture" }, { persistRoot: root });
      await decideDomainProposal(first.proposalId, "approved", first.inputHash, { persistRoot: root });
      await decideDomainProposal(second.proposalId, "approved", second.inputHash, { persistRoot: root });

      const overlay = JSON.parse(await readFile(overlayPath, "utf8"));
      expect(overlay.brands.map((entry: { brand: string }) => entry.brand)).toEqual(expect.arrayContaining(["First Runtime Brand", "Second Runtime Brand"]));
      const repository = await loadOfficialRegistryRepository({ overlayPath });
      expect(registryForUrl(new URL(`https://${firstDomain}/item`), repository)?.brand).toBe("First Runtime Brand");
      expect(registryForUrl(new URL(`https://${secondDomain}/item`), repository)?.brand).toBe("Second Runtime Brand");
      expect(loadOfficialRegistry(JSON.parse(await readFile(registryPath, "utf8"))).version).toBe(repository.version);

      activateOfficialRegistry(loadOfficialRegistry(JSON.parse(await readFile(new URL("../data/catalog/official-domains.json", import.meta.url), "utf8"))));
      expect(registryForUrl(new URL(`https://${firstDomain}/item`))).toBeNull();
      await activateOfficialRegistryRepository({ overlayPath });
      expect(registryForUrl(new URL(`https://${firstDomain}/item`))?.brand).toBe("First Runtime Brand");
      expect(registryForUrl(new URL(`https://${secondDomain}/item`))?.brand).toBe("Second Runtime Brand");

      await rollbackDomainApproval({ persistRoot: root });
      expect(registryForUrl(new URL(`https://${firstDomain}/item`))?.brand).toBe("First Runtime Brand");
      expect(registryForUrl(new URL(`https://${secondDomain}/item`))).toBeNull();
      const rolledBackOverlay = JSON.parse(await readFile(overlayPath, "utf8"));
      expect(rolledBackOverlay.brands.map((entry: { brand: string }) => entry.brand)).toContain("First Runtime Brand");
      expect(rolledBackOverlay.brands.map((entry: { brand: string }) => entry.brand)).not.toContain("Second Runtime Brand");
      const rolledBackRegistry = loadOfficialRegistry(JSON.parse(await readFile(registryPath, "utf8")));
      expect(registryForUrl(new URL(`https://${firstDomain}/item`), rolledBackRegistry)?.brand).toBe("First Runtime Brand");
      expect(registryForUrl(new URL(`https://${secondDomain}/item`), rolledBackRegistry)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses rollback when either materialized registry file has a newer write", async () => {
    const { root, registryPath } = await tempRegistryRoot();
    try {
      const domain = `newer-${Date.now()}.fixture.example.org`;
      const proposal = await createDomainProposal({ brand: "Newer Write Fixture", url: `https://${domain}/item`, provider: "fixture" }, { persistRoot: root });
      await decideDomainProposal(proposal.proposalId, "approved", proposal.inputHash, { persistRoot: root });
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      await writeFile(registryPath, `${JSON.stringify({ ...registry, updatedAt: "2026-08-27T23:59:59.000Z" }, null, 2)}\n`);
      await expect(rollbackDomainApproval({ persistRoot: root })).rejects.toThrow(/newer write/);
      expect(JSON.parse(await readFile(registryPath, "utf8")).updatedAt).toBe("2026-08-27T23:59:59.000Z");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects proposals without touching registry and hard-rejects auto trust", async () => {
    const { root, registryPath } = await tempRegistryRoot();
    try {
      const before = await readFile(registryPath, "utf8");
      const proposal = await createDomainProposal({ brand: "Example", url: "https://example-products.org/item", provider: "fixture" }, { persistRoot: root });
      expect((await decideDomainProposal(proposal.proposalId, "rejected", proposal.inputHash, { persistRoot: root })).status).toBe("rejected");
      expect(await readFile(registryPath, "utf8")).toBe(before);
      await expect(loadRuntimeFlags({ CATALOG_AUTO_TRUST_NEW_DOMAINS: "true" })).rejects.toThrow(/must remain false/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
