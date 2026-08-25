import { createDefaultN6Config } from "../../src/plans/default-plan";
import { evaluateBuild } from "../../src/core/evaluate";
import { loadBundledCatalog } from "../../src/sku/catalog";

export function buildN6Evaluation() {
  const catalog = loadBundledCatalog();
  const config = createDefaultN6Config("plan-spatial", "2026-08-25T00:00:00.000Z");
  return { catalog, evaluation: evaluateBuild(config, catalog) };
}
