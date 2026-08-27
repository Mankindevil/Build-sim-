import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { loadBundledPriceSnapshot } from "../src/sku/catalog";
import { configureAuthoritativeCatalogRepository, evaluateBuildAuthoritatively } from "../src/server/evaluation-service";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureAuthoritativeCatalogRepository({ allowSeedPriceFallback: true });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent authoritative runtime price snapshot", () => {
  it("reads the active runtime snapshot rather than the image seed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-agent-price-"));
    roots.push(root);
    const material = { ...loadBundledPriceSnapshot(), asOf: "2026-08-27", snapshotId: "price-snapshot-runtime-fixture" };
    const snapshot = { ...material, contentHash: createHash("sha256").update(JSON.stringify(material)).digest("hex") };
    const coordinator = new RuntimeCoordinator({ root });
    const state = await coordinator.initialize();
    const activeRoot = coordinator.activeRoot(state);
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices/latest.json"), `${JSON.stringify(snapshot)}\n`, "utf8");
    configureAuthoritativeCatalogRepository({ priceRuntimeRoot: root });
    const result = evaluateBuildAuthoritatively(baseline);
    expect(result.priceSnapshotVersion).toBe("1.0.0:2026-08-27");
  });
});
