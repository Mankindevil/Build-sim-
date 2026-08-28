// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { initAdvicePanel, renderBillingHtml } from "../src/lab/advice-panel";
import type { AdviceBillingSummary } from "../src/advice/types";

describe("DeepSeek billing panel", () => {
  it("keeps V3 partial plans unknown instead of invoking legacy advice input", () => {
    document.body.innerHTML = `
      <button id="advice-generate"></button>
      <div id="advice-status"></div>
      <div id="advice-deterministic"></div>
      <div id="advice-output"></div>`;
    initAdvicePanel({ getInput: () => null });
    expect(document.querySelector("#advice-deterministic")?.textContent).toContain("保持 unknown");
    expect(document.querySelector("#advice-deterministic")?.textContent).not.toContain("确定性引擎判定");
  });

  it("renders pricing band, cache split, per-call cost, reasoning tokens and provenance", () => {
    const totals = { schemaVersion: "1.1.0", pricingVersion: "deepseek-pricing-cn-tiered-2026-08-24", pricingHash: "a".repeat(64), pricingSourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", pricingTimeZone: "Asia/Shanghai", currency: "CNY", estimated: true, cacheServed: false, providerCalls: 1, pricedCalls: 1, unknownCostCalls: 0, promptTokens: 3_000, promptCacheHitTokens: 1_000, promptCacheMissTokens: 2_000, completionTokens: 500, reasoningTokens: 125, totalTokens: 3_500, estimatedCostCny: 0.0106 } as const;
    const summary = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-08-24T02:00:01.000Z",
      pricing: { pricingVersion: "deepseek-pricing-cn-tiered-2026-08-24", pricingHash: "a".repeat(64), capturedAt: "2026-08-24", sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", currency: "CNY", unitTokens: 1_000_000, timeZone: "Asia/Shanghai", bandRule: { weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], peakWindows: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }], weekend: "off-peak" } },
      jobs: 1,
      cacheServedJobs: 0,
      totals,
      byModel: [],
      byPricingBand: [{ pricingBand: "peak", label: "高峰时段", ...totals }],
      calls: [{
        callId: "advice-fixture:1", requestId: "advice-fixture", attempt: 1, status: "completed", provider: "deepseek", requestedModel: "deepseek-v4-flash", providerModel: "deepseek-v4-flash", providerRequestId: "provider-fixture", latencyMs: 321, httpStatus: null, failureStage: null, startedAt: "2026-08-24T02:00:00.000Z", generatedAt: "2026-08-24T02:00:01.000Z",
        billing: { usage: { promptTokens: 3_000, promptCacheHitTokens: 1_000, promptCacheMissTokens: 2_000, completionTokens: 500, totalTokens: 3_500, reasoningTokens: 125, warnings: [] }, pricing: { requestedModel: "deepseek-v4-flash", billedModel: "deepseek-v4-flash", aliasApplied: false, pricingBand: { id: "peak", label: "高峰时段", timeZone: "Asia/Shanghai", occurredAt: "2026-08-24T02:00:00.000Z", localDate: "2026-08-24", localTime: "10:00:00", weekday: "Monday" }, rates: { cacheHit: 0.1, cacheMiss: 3, output: 9 }, pricingVersion: "deepseek-pricing-cn-tiered-2026-08-24", pricingHash: "a".repeat(64), sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", capturedAt: "2026-08-24", currency: "CNY", unitTokens: 1_000_000, timeZone: "Asia/Shanghai" }, status: "priced", cost: { cacheHitCny: 0.0001, cacheMissCny: 0.006, outputCny: 0.0045, totalCny: 0.0106, currency: "CNY", estimated: true } },
      }],
      returnedCalls: 1,
      totalCalls: 1,
    } satisfies AdviceBillingSummary;
    const html = renderBillingHtml(summary);
    expect(html).toContain("33.3%");
    expect(html).toContain("高峰时段");
    expect(html).toContain("2026-08-24 10:00:00 北京");
    expect(html).toContain("advice-fixture:1");
    expect(html).toContain("provider provider-fixture");
    expect(html).toContain("单价 0.1/3/9 元/M");
    expect(html).toContain("推理 125");
    expect(html).toContain("¥0.0106");
    expect(html).toContain("命中 ¥0.0001 · 未中 ¥0.006 · 输出 ¥0.0045");
    expect(html).toContain("deepseek-pricing-cn-tiered-2026-08-24");
    expect(html).toContain("含周末");
  });
});
