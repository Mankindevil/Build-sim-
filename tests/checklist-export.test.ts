import { describe, expect, it } from "vitest";
import { exportChecklist } from "../src/config/io";
import { evaluateBuild } from "../src/core/evaluate";
import { deriveBuildTasks } from "../src/plans/build-tasks";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { loadBundledCatalog } from "../src/sku/catalog";

describe("saved-version checklist export", () => {
  it("records saved version, generation time, hashes and exact task source refs", () => {
    const config = createDefaultN6Config("plan-export", "2026-08-25T00:00:00.000Z");
    const evaluation = evaluateBuild(config, loadBundledCatalog());
    const tasks = deriveBuildTasks({ planId: "plan-export", sourceVersionId: "version-export-7", evaluation });
    tasks[0]!.status = "done";
    const text = exportChecklist(config, evaluation.bom, evaluation, {
      planId: "plan-export", planVersionId: "version-export-7", planVersionNumber: 7,
      generatedAt: "2026-08-25T02:03:04.000Z", configHash: "a".repeat(64), evaluationHash: "b".repeat(64), tasks,
    });
    expect(text).toContain("Saved version: version-export-7 (v7)");
    expect(text).toContain("Generated at: 2026-08-25T02:03:04.000Z");
    expect(text).toContain(`Config hash: ${"a".repeat(64)}`);
    expect(text).toContain(`Evaluation hash: ${"b".repeat(64)}`);
    expect(text).toContain(`<!-- ${tasks[0]!.sourceRef} -->`);
    expect(text).toContain("- [x] [done]");
  });
});
