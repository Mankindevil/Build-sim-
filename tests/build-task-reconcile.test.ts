import { describe, expect, it } from "vitest";
import { evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { deriveBuildTasks, reconcileBuildTasks } from "../src/plans/build-tasks";

const catalog = loadBundledCatalog();

describe("build task reconcile", () => {
  it("obsoletes the completed old PSU purchase without transferring completion to a replacement SKU", () => {
    const config = createDefaultN6Config("plan-task", "2026-08-25T00:00:00.000Z");
    const before = deriveBuildTasks({ planId: "plan-task", sourceVersionId: "version-1", evaluation: evaluateBuild(config, catalog) });
    const oldRef = `purchase:sku:${config.selection.psuId}`;
    const old = before.find((item) => item.sourceRef === oldRef)!;
    old.status = "done";
    old.statusSource = "manual";
    old.title = "完成购买一颗相似名称的电源";

    const replacement = structuredClone(config);
    replacement.selection.psuId = "psu.corsair-sf750-atx31";
    replacement.selection.psuTopology = "bottom";
    const derived = deriveBuildTasks({ planId: "plan-task", sourceVersionId: "version-2", evaluation: evaluateBuild(replacement, catalog) });
    const reconciled = reconcileBuildTasks(before, derived, "2026-08-25T01:00:00.000Z");

    expect(reconciled.find((item) => item.sourceRef === oldRef)).toMatchObject({ status: "obsolete", staleReason: "该来源已从当前方案版本移除" });
    expect(reconciled.find((item) => item.sourceRef === "purchase:sku:psu.corsair-sf750-atx31")).toMatchObject({ status: "todo", statusSource: "derived" });
    expect(reconcileBuildTasks(reconciled, derived).find((item) => item.sourceRef === oldRef)?.status).toBe("obsolete");
  });

  it("completes only the exact plan-linked purchase task and preserves a manual correction", () => {
    const evaluation = evaluateBuild(createDefaultN6Config("plan-task", "2026-08-25T00:00:00.000Z"), catalog);
    const skuId = evaluation.config.selection.psuId;
    const complete = deriveBuildTasks({
      planId: "plan-task", sourceVersionId: "version-1", evaluation,
      purchaseFacts: [{ skuId, stage: "purchased", receiptId: "receipt-1", planId: "plan-task", planItemId: skuId }],
    });
    expect(complete.find((item) => item.sourceRef === `purchase:sku:${skuId}`)).toMatchObject({ status: "done", evidenceRefs: ["transaction:receipt-1"] });

    const corrected = complete.map((item) => item.sourceRef === `purchase:sku:${skuId}` ? { ...item, status: "todo" as const, statusSource: "manual" as const } : item);
    expect(reconcileBuildTasks(corrected, complete).find((item) => item.sourceRef === `purchase:sku:${skuId}`)).toMatchObject({ status: "todo", statusSource: "manual" });

    const wrongPlan = deriveBuildTasks({ planId: "plan-task", sourceVersionId: "version-1", evaluation, purchaseFacts: [{ skuId, stage: "purchased", planId: "another-plan", planItemId: skuId }] });
    expect(wrongPlan.find((item) => item.sourceRef === `purchase:sku:${skuId}`)?.status).toBe("todo");
    const staleLink = deriveBuildTasks({ planId: "plan-task", sourceVersionId: "version-1", evaluation, purchaseFacts: [{ skuId, stage: "purchased", planId: "plan-task", planItemId: skuId, linkStatus: "stale" }] });
    expect(staleLink.find((item) => item.sourceRef === `purchase:sku:${skuId}`)?.status).toBe("todo");
  });
});
