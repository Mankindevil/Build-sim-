// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { governedPriceViewMarkup } from "../src/lab/governed-price-panel";
import type { PlanCurrentPriceView } from "../src/price/production";

describe("U11 current and historical price UI", () => {
  it("separates current purchase links from immutable history and shows confidence, conditions, freshness, and buy/wait uncertainty", () => {
    const currentUrl = "https://item.jd.com/current-exact.html";
    const historicalUrl = "https://item.jd.com/old-archive.html";
    const view = {
      schemaVersion: "plan-current-price-view-v1", planId: "plan-price-ui", draftRevision: 4,
      configHash: "a".repeat(64), evaluationLockHash: "b".repeat(64), priceSnapshotHash: "c".repeat(64),
      priceSnapshotId: "price-snapshot-ui", asOf: "2026-08-30",
      unresolvedInstanceIds: [],
      components: [{
        instanceId: "gpu-main", skuId: "gpu-exact", variantIdentityFactIds: ["fact-gpu-variant"],
        current: {
          status: "range", confidence: "medium", minCny: 3999, maxCny: 4299, sellerCount: 2, sampleCount: 3,
          validUntil: "2026-09-02T00:00:00.000Z", riskTags: ["coupon_required"],
        },
        currentObservations: [{
          observationId: "price-observation-ui", platform: "jd", sellerName: "自营店", sellerTier: "S1", stockStatus: "in_stock",
          comparableTotalCny: 3999, invoiceStatus: "mainland_invoice", warrantyStatus: "mainland_warranty", canonicalUrl: currentUrl,
          capturedAt: "2026-08-30T00:00:00.000Z", requiredDiscountConditions: ["会员券", "限时满减"],
        }],
        history: [{
          historyPointId: "history-ui", skuId: "gpu-exact", variantIdentityFactIds: ["fact-gpu-variant"],
          bucketStart: "2026-08-01T00:00:00.000Z", bucketEnd: "2026-08-29T00:00:00.000Z", canonicalUrl: historicalUrl,
        }],
        buyWait: {
          recommendation: "wait", historicalPosition: 0.86, historyWindow: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-29T00:00:00.000Z", coverageDays: 28, sampleCount: 8 },
          uncertainty: "历史位置不是价格预测", triggerConditions: ["精确规格进入历史区间低位再复核"], counterEvidence: ["当前报价需要会员券"],
        },
        targets: [],
      }],
    } as unknown as PlanCurrentPriceView;

    const host = document.createElement("section"); host.innerHTML = governedPriceViewMarkup(view, true);

    expect(host.textContent).toContain("¥3,999–¥4,299");
    expect(host.textContent).toContain("中等置信");
    expect(host.textContent).toContain("S1 · 发票 mainland_invoice · 保修 mainland_warranty · 条件 会员券、限时满减");
    expect(host.textContent).toContain("建议在 2026-09-02T00:00:00.000Z 前重新确认");
    expect(host.textContent).toContain("建议等待");
    expect(host.textContent).toContain("历史位置不是价格预测");
    expect(host.querySelector<HTMLAnchorElement>(`a[href='${currentUrl}']`)).not.toBeNull();
    expect(host.innerHTML).not.toContain(historicalUrl);
  });
});
