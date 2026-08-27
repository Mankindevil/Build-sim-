import path from "node:path";
import os from "node:os";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Bytes } from "../src/runtime/fs.mjs";
import {
  initializeRuntimeCatalog,
  loadMergedCatalog,
  migrateLegacyCatalogRepository,
  withCatalogWrite,
} from "../scripts/price-server/catalog/repository.mjs";
import {
  activateOfficialRegistry,
  activateOfficialRegistryRepository,
  activeOfficialRegistry,
  OFFICIAL_DOMAIN_REGISTRY,
  registryForUrl,
} from "../scripts/price-server/catalog/registry.mjs";
import { createDomainProposal, decideDomainProposal, listDomainProposals, migrateLegacyDomainRepository, rollbackDomainApproval } from "../scripts/price-server/catalog/domain-proposals.mjs";
import { validateOfficialUrl } from "../scripts/price-server/catalog/security.mjs";
import { discoverOfficialUrls } from "../scripts/price-server/catalog/discovery.mjs";

const roots: string[] = [];
async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-catalog-generation-"));
  roots.push(root);
  const coordinator = new RuntimeCoordinator({ root });
  await coordinator.initialize();
  return { root, coordinator };
}

afterEach(async () => {
  activateOfficialRegistry(OFFICIAL_DOMAIN_REGISTRY);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("catalog active generation", () => {
  it("resolves product catalog through the pointer on every operation", async () => {
    const { coordinator } = await runtime();
    await initializeRuntimeCatalog({ coordinator, generationAware: true });
    await withCatalogWrite({ coordinator, generationAware: true }, async (paths: { runtimeCatalogPath: string }) => {
      const current = JSON.parse(await readFile(paths.runtimeCatalogPath, "utf8"));
      const fixture = { ...current.skus[0], id: "gpu.generation-one", name: "Generation One Fixture" };
      await atomicWriteJson(paths.runtimeCatalogPath, {
        ...current,
        skus: [...current.skus, fixture],
        runtimeCatalog: { ...current.runtimeCatalog, acceptedSkuIds: [fixture.id] },
      });
    });
    expect((await loadMergedCatalog({ coordinator, generationAware: true })).skus.some((sku: { id: string }) => sku.id === "gpu.generation-one")).toBe(true);

    const before = await coordinator.readState();
    const lease = await coordinator.acquireMaintenanceLease("catalog-pointer-test");
    const staging = await coordinator.createStagingGeneration(lease.token);
    await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);
    expect((await loadMergedCatalog({ coordinator, generationAware: true })).skus.some((sku: { id: string }) => sku.id === "gpu.generation-one")).toBe(false);
  });

  it("refreshes the process registry after restore and serializes concurrent proposals", async () => {
    const { coordinator } = await runtime();
    await activateOfficialRegistryRepository({ coordinator, generationAware: true });
    const suffix = Date.now();
    const domains = [`parallel-${suffix}.fixture.example.org`, `parallel-${suffix}.fixture.example.net`];
    const [first, second] = await Promise.all(domains.map((domain, index) => createDomainProposal({
      brand: `Parallel Fixture ${index}`,
      url: `https://${domain}/item`,
      provider: "fixture",
    }, { coordinator, generationAware: true })));
    expect((await listDomainProposals({ coordinator, generationAware: true })).proposals).toHaveLength(2);
    await decideDomainProposal(first.proposalId, "approved", first.inputHash, { coordinator, generationAware: true });
    expect(registryForUrl(new URL(`https://${domains[0]}/item`))?.brand).toBe("Parallel Fixture 0");

    const before = await coordinator.readState();
    const lease = await coordinator.acquireMaintenanceLease("domain-pointer-test");
    const staging = await coordinator.createStagingGeneration(lease.token);
    await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);
    expect(registryForUrl(new URL(`https://${domains[0]}/item`))).toBeNull();
    expect(activeOfficialRegistry().brands.length).toBeGreaterThan(0);

    const afterRestore = await createDomainProposal({ brand: "After Restore", url: `https://after-${suffix}.fixture.example.org/item`, provider: "fixture" }, { coordinator, generationAware: true });
    expect(afterRestore.trustStatus).toBe("proposed");
    expect((await listDomainProposals({ coordinator, generationAware: true })).proposals.map((value: { proposalId: string }) => value.proposalId)).not.toContain(second.proposalId);
  });

  it("uses a newly approved domain immediately in URL security and discovery", async () => {
    const { coordinator } = await runtime();
    await activateOfficialRegistryRepository({ coordinator, generationAware: true });
    const domain = `immediate-${Date.now()}.fixture.example.org`;
    const proposal = await createDomainProposal({
      brand: "Immediate Fixture", url: `https://${domain}/products/item`, provider: "fixture",
    }, { coordinator, generationAware: true });
    await decideDomainProposal(proposal.proposalId, "approved", proposal.inputHash, { coordinator, generationAware: true });

    expect(validateOfficialUrl(`https://${domain}/products/item`).hostname).toBe(domain);
    let observedDomains: string[] = [];
    const discovery = await discoverOfficialUrls({
      query: { raw: "Immediate Fixture Item", brand: "Immediate Fixture", model: "Item", category: "case", tokens: ["immediate", "fixture", "item"] },
      providers: [{
        id: "approved-domain-fixture",
        discover: async ({ allowedDomains }: { allowedDomains: string[] }) => {
          observedDomains = allowedDomains;
          return [{ url: `https://${domain}/products/item`, title: "Fixture Item", retrievedAt: "2026-08-27T00:00:00.000Z", rank: 0 }];
        },
      }],
    });
    expect(observedDomains).toEqual([domain]);
    expect(discovery.registryVersion).toBe(activeOfficialRegistry().version);
    expect(discovery.candidates).toEqual([expect.objectContaining({ url: `https://${domain}/products/item` })]);
  });

  it("fails closed on corrupt and partially materialized domain overlays", async () => {
    const { coordinator } = await runtime();
    await coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await atomicWriteJson(confined(activeRoot, "domain-overlays", "official-domains.overlay.json"), { schemaVersion: "broken" });
    });
    await expect(activateOfficialRegistryRepository({ coordinator, generationAware: true })).rejects.toThrow(/overlay/);
  });

  it("stores portable rollback paths, rejects incomplete commits, and rolls back after restore", async () => {
    const { coordinator } = await runtime();
    const domain = `portable-${Date.now()}.fixture.example.org`;
    const proposal = await createDomainProposal({ brand: "Portable Fixture", url: `https://${domain}/item`, provider: "fixture" }, { coordinator });
    await decideDomainProposal(proposal.proposalId, "approved", proposal.inputHash, { coordinator });
    const before = await coordinator.readState();
    const oldRoot = coordinator.activeRoot(before);
    const manifest = JSON.parse(await readFile(path.join(oldRoot, "audit/rollback/domain/official-registry-manifest.json"), "utf8"));
    expect(manifest.transactions[0].files.every((file: { target: string; backup: string }) => !path.isAbsolute(file.target) && !path.isAbsolute(file.backup))).toBe(true);

    const lease = await coordinator.acquireMaintenanceLease("portable-domain-restore");
    const staging = await coordinator.createStagingGeneration(lease.token);
    await cp(path.join(oldRoot, "domain-overlays"), path.join(staging, "domain-overlays"), { recursive: true, force: true });
    await cp(path.join(oldRoot, "audit"), path.join(staging, "audit"), { recursive: true, force: true });
    await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);
    await activateOfficialRegistryRepository({ coordinator, generationAware: true });
    expect(registryForUrl(new URL(`https://${domain}/item`))?.brand).toBe("Portable Fixture");
    await rollbackDomainApproval({ coordinator, generationAware: true });
    expect(registryForUrl(new URL(`https://${domain}/item`))).toBeNull();

    await coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      await atomicWriteJson(path.join(activeRoot, "audit/rollback/domain/official-registry-manifest.json"), {
        schemaVersion: "1.0.0", transactions: [{ transactionId: "incomplete", status: "applying", files: [] }],
      });
    });
    await expect(activateOfficialRegistryRepository({ coordinator, generationAware: true })).rejects.toThrow(/incomplete approval/);
  });

  it("dry-runs and applies legacy import once without later resurrection", async () => {
    const { root, coordinator } = await runtime();
    const bundled = JSON.parse(await readFile(new URL("../data/skus/catalog.json", import.meta.url), "utf8"));
    await atomicWriteJson(path.join(root, "data/skus/catalog.json"), bundled);
    const dryRun = await migrateLegacyCatalogRepository({ coordinator, generationAware: true });
    expect(dryRun).toMatchObject({ status: "dry_run" });
    expect(await migrateLegacyCatalogRepository({ coordinator, generationAware: true, dryRun: false, expectedSourceHash: dryRun.sourceHash })).toMatchObject({ status: "applied" });
    expect(await migrateLegacyCatalogRepository({ coordinator, generationAware: true, dryRun: false })).toMatchObject({ status: "already_migrated" });

    const before = await coordinator.readState();
    const lease = await coordinator.acquireMaintenanceLease("legacy-pointer-test");
    const staging = await coordinator.createStagingGeneration(lease.token);
    await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);
    await initializeRuntimeCatalog({ coordinator, generationAware: true });
    const state = await coordinator.readState();
    expect(await readFile(path.join(coordinator.activeRoot(state), "catalog-overlays/product-catalog.json"), "utf8")).not.toContain("catalog-legacy-migration-v1");
  });

  it("never imports user transaction notes into the product overlay", async () => {
    const { root, coordinator } = await runtime();
    const bundled = JSON.parse(await readFile(new URL("../data/skus/catalog.json", import.meta.url), "utf8"));
    bundled.skus[0].price.note = "用户成交 123 元，订单截图";
    await atomicWriteJson(path.join(root, "data/skus/catalog.json"), bundled);
    const dryRun = await migrateLegacyCatalogRepository({ coordinator });
    expect(dryRun).toMatchObject({ status: "dry_run", removedFieldCount: 1, requiresExplicitApply: true });
    const applied = await migrateLegacyCatalogRepository({ coordinator, dryRun: false, expectedSourceHash: dryRun.sourceHash });
    expect(applied).toMatchObject({ status: "applied", removedFieldCount: 1 });
    const catalog = await loadMergedCatalog({ coordinator, generationAware: true });
    expect(catalog.skus[0].price.note).not.toContain("用户成交");
    const state = await coordinator.readState();
    expect(await readFile(path.join(coordinator.activeRoot(state), "migrations/catalog-user-data-v1/quarantine.json"), "utf8")).toContain("用户成交 123 元");
  });

  it("migrates legacy domain proposals and records source hashes", async () => {
    const { root, coordinator } = await runtime();
    const brand = "Legacy Domain Fixture";
    const domain = "legacy-domain.fixture.example.org";
    const proposalId = `domain-proposal-${sha256Bytes(Buffer.from(`${brand.toLocaleLowerCase()}|${domain}`, "utf8")).slice(0, 20)}`;
    const discoveredUrl = `https://${domain}/item`;
    const discoveryProvider = "legacy-fixture";
    const inputHash = sha256Bytes(Buffer.from(JSON.stringify({ brand, domain, url: discoveredUrl, provider: discoveryProvider }), "utf8"));
    await atomicWriteJson(path.join(root, "data/catalog-domain-proposals/proposals.json"), {
      schemaVersion: "1.0.0",
      proposals: [{
        schemaVersion: "1.0.0", proposalId, inputHash, brand, domain, trustStatus: "proposed",
        discoveryProvider, discoveredUrl, redirects: [], reason: "legacy migration fixture",
        createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
      }],
      events: [{
        eventId: `proposal-event-${sha256Bytes(Buffer.from(`create|${proposalId}`, "utf8")).slice(0, 20)}`,
        operation: "create", proposalId, inputHash, createdAt: "2026-08-27T00:00:00.000Z",
      }],
    });
    await atomicWriteJson(path.join(root, "data/catalog/official-domains.json"), JSON.parse(await readFile(new URL("../data/catalog/official-domains.json", import.meta.url), "utf8")));
    const dryRun = await migrateLegacyDomainRepository({ coordinator });
    expect(dryRun).toMatchObject({ status: "dry_run", proposalCount: 1, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(migrateLegacyDomainRepository({ coordinator, dryRun: false })).rejects.toThrow(/exact dry-run source hash/);
    expect(await migrateLegacyDomainRepository({ coordinator, dryRun: false, expectedSourceHash: dryRun.sourceHash })).toMatchObject({ status: "applied", sourceHash: dryRun.sourceHash });
    expect(await migrateLegacyDomainRepository({ coordinator, dryRun: false, expectedSourceHash: dryRun.sourceHash })).toMatchObject({ status: "already_migrated", sourceHash: dryRun.sourceHash });
    const state = await coordinator.readState();
    expect(JSON.parse(await readFile(path.join(coordinator.activeRoot(state), "domain-overlays/proposals.json"), "utf8")).events).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(root, "control/domain-legacy-migration.json"), "utf8")).sources).toHaveLength(2);
  });
});
