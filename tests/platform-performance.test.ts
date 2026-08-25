import { describe, expect, it } from "vitest";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { deriveBuildTasks, reconcileBuildTasks } from "../src/plans/build-tasks";
import type { BuildTask } from "../src/plans/contracts";

describe("R10 bounded local performance", () => {
  it("re-evaluates fifty representative plans within the local regression budget", () => {
    const catalog = loadBundledCatalog();
    const config = createDefaultN6Config("plan-perf", "2026-08-25T00:00:00.000Z");
    const started = performance.now();
    for (let index = 0; index < 50; index += 1) {
      config.selection.diskCount = index % 10;
      evaluateBuild(config, catalog);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("reconciles a 5,000-row historical task list without fuzzy matching or quadratic blow-up", () => {
    const evaluation = evaluateBuild(createDefaultN6Config("plan-perf", "2026-08-25T00:00:00.000Z"), loadBundledCatalog());
    const derived = deriveBuildTasks({ planId: "plan-perf", sourceVersionId: "version-current", evaluation });
    const historical: BuildTask[] = Array.from({ length: 5_000 }, (_, index) => ({ schemaVersion: "1.0.0", id: `old-${index}`, planId: "plan-perf", sourceVersionId: "version-old", kind: "purchase", sourceRef: `purchase:sku:retired-${index}`, title: `Retired ${index}`, status: "obsolete", statusSource: "derived" }));
    const started = performance.now();
    const reconciled = reconcileBuildTasks(historical, derived);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(reconciled).toHaveLength(historical.length + derived.length);
  });
});
