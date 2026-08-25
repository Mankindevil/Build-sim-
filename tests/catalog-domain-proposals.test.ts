import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDomainProposal, decideDomainProposal, listDomainProposals, rollbackDomainApproval } from "../scripts/price-server/catalog/domain-proposals.mjs";
import { loadOfficialRegistry } from "../scripts/price-server/catalog/registry.mjs";
import { queueSearch, waitForJob } from "../scripts/price-server/catalog/service.mjs";
import { loadRuntimeFlags } from "../scripts/runtime/flags.mjs";

async function tempRegistryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-domain-proposal-"));
  const registryPath = path.join(root, "data/catalog/official-domains.json");
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, await readFile(new URL("../data/catalog/official-domains.json", import.meta.url)), "utf8");
  return { root, registryPath };
}

describe("C5 governed domain proposals", () => {
  it("persists untrusted discovery as an idempotent proposal without inspecting it", async () => {
    const { root } = await tempRegistryRoot();
    const stamp = Date.now();
    const provider = { id: `proposal-fixture-${stamp}`, discover: async () => [{ url: `https://products.example.org/${stamp}`, title: "Example exact product", snippet: "candidate only", retrievedAt: "2026-08-24T00:00:00.000Z", rank: 0 }] };
    try {
      const job = queueSearch({ query: `EXAMPLE-${stamp}`, brand: "ExampleBrand", category: "storage" }, { discoveryProviders: [provider], persistRoot: root, inspect: false });
      const result = await waitForJob(job.jobId);
      expect(result?.candidates).toHaveLength(0);
      expect(result?.domainProposals).toHaveLength(1);
      expect(result?.domainProposals[0].trustStatus).toBe("proposed");
      const listed = await listDomainProposals({ persistRoot: root });
      expect(listed.proposals).toHaveLength(1);
      expect(listed.events).toHaveLength(1);
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
      await rollbackDomainApproval({ persistRoot: root });
      const restored = JSON.parse(await readFile(registryPath, "utf8"));
      expect(restored.brands.find((entry: { brand: string }) => entry.brand === "ASUS").domains).not.toContain("specs.asus-example.com");
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
