import { describe, expect, it } from "vitest";
import { DEEPSEEK_PRICING, normalizeDeepSeekUsage, priceDeepSeekUsage, resolveDeepSeekPricing, resolveDeepSeekPricingBand, summarizeBillingCalls } from "../scripts/deepseek/pricing.mjs";

const usage = {
  prompt_tokens: 3_000,
  prompt_cache_hit_tokens: 1_000,
  prompt_cache_miss_tokens: 2_000,
  completion_tokens: 500,
  total_tokens: 3_500,
  completion_tokens_details: { reasoning_tokens: 125 },
};
const MONDAY_PEAK = "2026-08-24T02:00:00.000Z"; // 10:00 Asia/Shanghai
const MONDAY_OFF_PEAK = "2026-08-24T00:59:00.000Z"; // 08:59 Asia/Shanghai
const SUNDAY_DAYTIME = "2026-08-23T02:00:00.000Z"; // 10:00 Asia/Shanghai

describe("DeepSeek token billing", () => {
  it("uses Beijing weekday peak windows with start-inclusive/end-exclusive boundaries", () => {
    expect(resolveDeepSeekPricingBand(MONDAY_OFF_PEAK)).toMatchObject({ id: "off-peak", localTime: "08:59:00", timeZone: "Asia/Shanghai" });
    expect(resolveDeepSeekPricingBand(MONDAY_PEAK)).toMatchObject({ id: "peak", localTime: "10:00:00" });
    expect(resolveDeepSeekPricingBand("2026-08-24T04:00:00.000Z")).toMatchObject({ id: "off-peak", localTime: "12:00:00" });
    expect(resolveDeepSeekPricingBand("2026-08-24T06:00:00.000Z")).toMatchObject({ id: "peak", localTime: "14:00:00" });
    expect(resolveDeepSeekPricingBand("2026-08-24T10:00:00.000Z")).toMatchObject({ id: "off-peak", localTime: "18:00:00" });
  });

  it("prices weekends as off-peak and cache hit, miss and output separately", () => {
    const billed = priceDeepSeekUsage("deepseek-v4-flash", usage, { occurredAt: SUNDAY_DAYTIME });
    expect(billed.status).toBe("priced");
    expect(billed.usage).toMatchObject({ promptTokens: 3_000, promptCacheHitTokens: 1_000, promptCacheMissTokens: 2_000, completionTokens: 500, reasoningTokens: 125 });
    expect(billed.cost).toEqual({ cacheHitCny: 0.00005, cacheMissCny: 0.003, outputCny: 0.00225, totalCny: 0.0053, currency: "CNY", estimated: true });
    expect(billed.pricing).toMatchObject({ pricingVersion: "deepseek-pricing-cn-tiered-2026-08-24", sourceUrl: DEEPSEEK_PRICING.sourceUrl, pricingBand: { id: "off-peak", weekday: "Sunday" } });
  });

  it("charges peak calls at the current official peak rates", () => {
    const billed = priceDeepSeekUsage("deepseek-v4-pro", usage, { occurredAt: MONDAY_PEAK });
    expect(billed.pricing).toMatchObject({ billedModel: "deepseek-v4-pro", rates: { cacheHit: 0.3, cacheMiss: 9, output: 27 }, pricingBand: { id: "peak" } });
    expect(billed.cost).toEqual({ cacheHitCny: 0.0003, cacheMissCny: 0.018, outputCny: 0.0135, totalCny: 0.0318, currency: "CNY", estimated: true });
  });

  it("refuses to invent prices for deprecated aliases or unknown models", () => {
    expect(resolveDeepSeekPricing("deepseek-chat", { occurredAt: MONDAY_PEAK })).toMatchObject({ billedModel: null, aliasApplied: false, rates: null });
    expect(priceDeepSeekUsage("private-model", usage, { occurredAt: MONDAY_PEAK })).toMatchObject({ status: "unknown-model", cost: null });
  });

  it("keeps inconsistent or incomplete provider usage visible", () => {
    expect(normalizeDeepSeekUsage({ ...usage, total_tokens: 4_000 })?.warnings).toContain("total token mismatch");
    expect(priceDeepSeekUsage("deepseek-v4-pro", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, { occurredAt: MONDAY_PEAK })).toMatchObject({ status: "usage-incomplete", cost: null });
    expect(priceDeepSeekUsage("deepseek-v4-pro", null, { occurredAt: MONDAY_PEAK })).toMatchObject({ status: "usage-unavailable", cost: null });
  });

  it("sums retries as separate calls and preserves their pricing bands", () => {
    const call = (id: string, occurredAt: string) => ({ callId: id, billing: priceDeepSeekUsage("deepseek-v4-flash", usage, { occurredAt }) });
    const calls = [call("a", MONDAY_OFF_PEAK), call("b", MONDAY_PEAK)];
    expect(summarizeBillingCalls(calls)).toMatchObject({ schemaVersion: "1.1.0", providerCalls: 2, pricedCalls: 2, totalTokens: 7_000, estimatedCostCny: 0.0159, pricingTimeZone: "Asia/Shanghai" });
  });
});
