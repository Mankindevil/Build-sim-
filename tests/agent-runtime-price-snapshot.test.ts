import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { loadBundledPriceSnapshot } from "../src/sku/catalog";
import { configureAuthoritativeCatalogRepository, evaluateBuildAuthoritatively, evaluateBuildDocumentAuthoritatively } from "../src/server/evaluation-service";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];

afterEach(async () => {
  configureAuthoritativeCatalogRepository({ allowSeedPriceFallback: true });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent authoritative runtime price snapshot", () => {
  it("reads the active runtime snapshot rather than the image seed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-agent-price-"));
    roots.push(root);
    const bundled = loadBundledPriceSnapshot();
    const material = {
      schemaVersion: bundled.schemaVersion,
      asOf: "2026-08-27",
      ...(bundled.note === undefined ? {} : { note: bundled.note }),
      snapshotId: "price-snapshot-runtime-fixture",
      ...(bundled.generatedAt === undefined ? {} : { generatedAt: bundled.generatedAt }),
      ...(bundled.catalogVersion === undefined ? {} : { catalogVersion: bundled.catalogVersion }),
      ...(bundled.inputHash === undefined ? {} : { inputHash: bundled.inputHash }),
      ...(bundled.priceVersion === undefined ? {} : { priceVersion: bundled.priceVersion }),
      quotes: bundled.quotes,
    };
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

  it("does not require a price snapshot for a V3 partial evaluation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-agent-v3-no-price-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    await coordinator.initialize();
    configureAuthoritativeCatalogRepository({ runtimeRoot: root });

    const result = evaluateBuildDocumentAuthoritatively(
      createEmptyBuildConfigV3("plan-v3-no-price", "V3 no price", "2026-08-27T00:00:00.000Z"),
      undefined,
      { topologyV3Enabled: true },
    );

    expect(result.priceSnapshotVersion).toBeNull();
    expect(result.evaluation).toMatchObject({ kind: "topology-v3-partial", unknownDomains: expect.arrayContaining(["price"]) });
  });
});
