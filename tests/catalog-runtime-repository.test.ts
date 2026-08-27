import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import type { AgentToolContext } from "../src/agent/contracts";
import { loadRawCatalog } from "../src/sku/catalog";
import { createBuildSimTools } from "../src/server/domain-tools";
import { evaluateBuildAuthoritatively } from "../src/server/evaluation-service";
import {
  initializeRuntimeCatalog,
  loadMergedCatalog,
  loadMergedCatalogSync,
  markRuntimeCatalogSkuAccepted,
  resolveCatalogRepositoryPaths,
  resultRequiresRuntimeCatalogRetention,
  sanitizeMergedCatalog,
} from "../scripts/price-server/catalog/repository.mjs";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-catalog-runtime-"));
  roots.push(root);
  return root;
}

function sku(id: string, model: string) {
  return {
    id,
    category: "gpu",
    brand: "Fixture",
    model,
    name: `Fixture ${model}`,
    dims: { lengthMm: 200, slots: 2, evidence: "official" },
    power: { tgpW: 150, evidence: "official" },
    price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime catalog repository", () => {
  it("falls back to base, then preserves accepted rows while taking base release updates", async () => {
    const root = await tempRoot();
    const baseCatalogPath = path.join(root, "release/catalog.json");
    const persistRoot = path.join(root, "persist");
    const options = { baseCatalogPath, persistRoot };
    await writeJson(baseCatalogPath, { schemaVersion: "2.0.0", catalogVersion: "2.0.0", updatedAt: "2026-08-25", skus: [sku("gpu.base", "Base v1")] });

    const fallback = await loadMergedCatalog(options);
    expect(fallback.skus.map((entry: { id: string }) => entry.id)).toEqual(["gpu.base"]);
    expect(sanitizeMergedCatalog(fallback)).not.toHaveProperty("runtimeCatalog");

    const initialized = await initializeRuntimeCatalog(options);
    const paths = resolveCatalogRepositoryPaths(options);
    await writeJson(paths.runtimeCatalogPath, {
      ...initialized,
      catalogVersion: "2.0.1",
      updatedAt: "2026-08-26",
      skus: [...initialized.skus, sku("gpu.accepted", "Accepted")],
    });
    await markRuntimeCatalogSkuAccepted("gpu.accepted", options);

    await writeJson(baseCatalogPath, { schemaVersion: "2.0.0", catalogVersion: "2.1.0", updatedAt: "2026-08-27", skus: [sku("gpu.base", "Base v2"), sku("gpu.release-new", "Release new")] });
    const afterRelease = await initializeRuntimeCatalog(options);
    expect(afterRelease.catalogVersion).toBe("2.1.0");
    expect(afterRelease.skus.map((entry: { id: string }) => entry.id)).toEqual(["gpu.base", "gpu.release-new", "gpu.accepted"]);
    expect(afterRelease.skus.find((entry: { id: string }) => entry.id === "gpu.base")?.model).toBe("Base v2");
    expect(loadMergedCatalogSync(options)).toEqual(afterRelease);

    const persisted = JSON.parse(await readFile(paths.runtimeCatalogPath, "utf8"));
    expect(persisted.runtimeCatalog).toMatchObject({ acceptedSkuIds: ["gpu.accepted"], baseCatalogVersion: "2.1.0", baseUpdatedAt: "2026-08-27" });
  });

  it("fails closed for corrupt runtime data and rejects paths outside the persistence root", async () => {
    const root = await tempRoot();
    const baseCatalogPath = path.join(root, "base.json");
    const persistRoot = path.join(root, "persist");
    await writeJson(baseCatalogPath, { schemaVersion: "2.0.0", updatedAt: "2026-08-25", skus: [] });
    const paths = resolveCatalogRepositoryPaths({ baseCatalogPath, persistRoot });
    await mkdir(path.dirname(paths.runtimeCatalogPath), { recursive: true });
    await writeFile(paths.runtimeCatalogPath, "{not-json", "utf8");
    await expect(loadMergedCatalog({ baseCatalogPath, persistRoot })).rejects.toThrow(/invalid JSON/);
    expect(() => resolveCatalogRepositoryPaths({ baseCatalogPath, persistRoot, runtimeCatalogPath: path.join(root, "outside.json") })).toThrow(/within CATALOG_PERSIST_ROOT/);
  });

  it("retains real catalog writes but not a confirmation that only reuses a base SKU", () => {
    expect(resultRequiresRuntimeCatalogRetention({ status: "accepted", skuId: "gpu.updated" })).toBe(true);
    expect(resultRequiresRuntimeCatalogRetention({ status: "confirmed", skuId: "gpu.created", catalogChanged: true })).toBe(true);
    expect(resultRequiresRuntimeCatalogRetention({ status: "confirmed", skuId: "gpu.base", catalogChanged: false, changedFields: ["new SKU"] })).toBe(false);
    expect(resultRequiresRuntimeCatalogRetention({ status: "confirmed", skuId: "gpu.base", changedFields: [] })).toBe(false);
  });
});

describe("Agent runtime catalog consumers", () => {
  it("evaluates, searches, reads facts, and compares with an accepted runtime-only SKU", async () => {
    const persistRoot = await tempRoot();
    const catalog = structuredClone(loadRawCatalog());
    const template = catalog.skus.find((entry) => entry.id === "gpu.rtx-a2000-12gb");
    if (!template) throw new Error("GPU fixture missing");
    const runtimeGpu = { ...structuredClone(template), id: "gpu.runtime-review", model: "Runtime Review", name: "Fixture Runtime Review" };
    await writeJson(path.join(persistRoot, "data/skus/catalog.json"), {
      ...catalog,
      catalogVersion: "2.0.1",
      updatedAt: "2026-08-26",
      skus: [...catalog.skus, runtimeGpu],
      runtimeCatalog: { schemaVersion: "1.0.0", acceptedSkuIds: [runtimeGpu.id], baseCatalogVersion: catalog.catalogVersion ?? catalog.schemaVersion, baseUpdatedAt: catalog.updatedAt },
    });
    vi.stubEnv("CATALOG_PERSIST_ROOT", persistRoot);

    const configuration = { ...structuredClone(baseline), selection: { ...structuredClone(baseline.selection), gpuId: runtimeGpu.id } };
    expect(evaluateBuildAuthoritatively(configuration).evaluation.config.selection.gpuId).toBe(runtimeGpu.id);

    const registry = new AgentToolRegistry(createBuildSimTools());
    const context: AgentToolContext = { sessionId: "runtime-catalog", runId: "runtime-catalog", buildConfig: baseline as never, signal: new AbortController().signal };
    const searched = await registry.dispatch("search_catalog_skus", { category: "gpu", query: "Runtime Review" }, context);
    expect(searched.result.content).toMatchObject({ count: 1, records: [{ id: runtimeGpu.id }] });
    const facts = await registry.dispatch("get_sku_facts", { skuIds: [runtimeGpu.id], fields: ["identity"] }, context);
    expect(facts.result.content).toMatchObject({ records: [{ skuId: runtimeGpu.id, status: "found" }] });
    const compared = await registry.dispatch("compare_builds", { selectionPatch: { gpuId: runtimeGpu.id } }, context);
    expect(compared.result).toMatchObject({ ok: true, content: { selectionPatch: { gpuId: runtimeGpu.id } } });
  });
});
