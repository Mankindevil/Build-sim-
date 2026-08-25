const OFF_PEAK = "off-peak";
const PEAK = "peak";

export const DEEPSEEK_PRICING = Object.freeze({
  schemaVersion: "1.2.0",
  pricingVersion: "deepseek-pricing-cn-tiered-2026-08-25",
  capturedAt: "2026-08-25",
  currency: "CNY",
  unitTokens: 1_000_000,
  timeZone: "Asia/Shanghai",
  sourceUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
  bandRule: Object.freeze({
    weekdays: Object.freeze(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]),
    peakWindows: Object.freeze([Object.freeze({ start: "09:00", end: "12:00" }), Object.freeze({ start: "14:00", end: "18:00" })]),
    weekend: OFF_PEAK,
  }),
  bands: Object.freeze({
    [OFF_PEAK]: Object.freeze({ id: OFF_PEAK, label: "空闲时段" }),
    [PEAK]: Object.freeze({ id: PEAK, label: "高峰时段" }),
  }),
  models: Object.freeze({
    "deepseek-v4-flash": Object.freeze({
      [OFF_PEAK]: Object.freeze({ cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }),
      [PEAK]: Object.freeze({ cacheHit: 0.10, cacheMiss: 3, output: 9 }),
    }),
    "deepseek-v4-pro": Object.freeze({
      [OFF_PEAK]: Object.freeze({ cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }),
      [PEAK]: Object.freeze({ cacheHit: 0.30, cacheMiss: 9, output: 27 }),
    }),
    "deepseek-v4-flash-vision-exp": Object.freeze({
      [OFF_PEAK]: Object.freeze({ cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }),
      [PEAK]: Object.freeze({ cacheHit: 0.10, cacheMiss: 3, output: 9 }),
    }),
  }),
  aliases: Object.freeze({}),
});

export const DEEPSEEK_PRICING_HASH = createHash("sha256").update(JSON.stringify(DEEPSEEK_PRICING)).digest("hex");

const BEIJING_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: DEEPSEEK_PRICING.timeZone,
  weekday: "long",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function token(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function money(value) {
  return Math.round(value * 1e12) / 1e12;
}

function timeParts(occurredAt) {
  const instant = occurredAt instanceof Date ? occurredAt : new Date(occurredAt ?? Date.now());
  if (Number.isNaN(instant.getTime())) return null;
  const parts = Object.fromEntries(BEIJING_PARTS.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    instant: instant.toISOString(),
    weekday: parts.weekday,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function resolveDeepSeekPricingBand(occurredAt) {
  const parts = timeParts(occurredAt);
  if (!parts) return null;
  const weekday = DEEPSEEK_PRICING.bandRule.weekdays.includes(parts.weekday);
  const peak = weekday && ((parts.minuteOfDay >= 9 * 60 && parts.minuteOfDay < 12 * 60) || (parts.minuteOfDay >= 14 * 60 && parts.minuteOfDay < 18 * 60));
  const band = DEEPSEEK_PRICING.bands[peak ? PEAK : OFF_PEAK];
  return {
    ...band,
    timeZone: DEEPSEEK_PRICING.timeZone,
    occurredAt: parts.instant,
    localDate: parts.localDate,
    localTime: parts.localTime,
    weekday: parts.weekday,
  };
}

export function resolveDeepSeekPricing(model, { occurredAt } = {}) {
  const requestedModel = typeof model === "string" && model ? model : null;
  const billedModel = DEEPSEEK_PRICING.aliases[requestedModel] ?? requestedModel;
  const modelRates = billedModel ? DEEPSEEK_PRICING.models[billedModel] : null;
  const pricingBand = resolveDeepSeekPricingBand(occurredAt);
  const rates = modelRates && pricingBand ? modelRates[pricingBand.id] : null;
  return {
    requestedModel,
    billedModel: rates ? billedModel : null,
    aliasApplied: Boolean(rates && requestedModel !== billedModel),
    pricingBand,
    rates: rates ?? null,
    pricingVersion: DEEPSEEK_PRICING.pricingVersion,
    pricingHash: DEEPSEEK_PRICING_HASH,
    sourceUrl: DEEPSEEK_PRICING.sourceUrl,
    capturedAt: DEEPSEEK_PRICING.capturedAt,
    currency: DEEPSEEK_PRICING.currency,
    unitTokens: DEEPSEEK_PRICING.unitTokens,
    timeZone: DEEPSEEK_PRICING.timeZone,
  };
}

export function normalizeDeepSeekUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const promptTokens = token(raw.prompt_tokens);
  const cacheHitTokens = token(raw.prompt_cache_hit_tokens);
  const cacheMissTokens = token(raw.prompt_cache_miss_tokens);
  const completionTokens = token(raw.completion_tokens);
  const totalTokens = token(raw.total_tokens);
  const reasoningTokens = token(raw.completion_tokens_details?.reasoning_tokens);
  const warnings = [];
  if (promptTokens === null) warnings.push("prompt_tokens missing");
  if (cacheHitTokens === null) warnings.push("prompt_cache_hit_tokens missing");
  if (cacheMissTokens === null) warnings.push("prompt_cache_miss_tokens missing");
  if (completionTokens === null) warnings.push("completion_tokens missing");
  if (totalTokens === null) warnings.push("total_tokens missing");
  if (promptTokens !== null && cacheHitTokens !== null && cacheMissTokens !== null && promptTokens !== cacheHitTokens + cacheMissTokens) warnings.push("prompt token split mismatch");
  if (totalTokens !== null && promptTokens !== null && completionTokens !== null && totalTokens !== promptTokens + completionTokens) warnings.push("total token mismatch");
  return {
    promptTokens,
    promptCacheHitTokens: cacheHitTokens,
    promptCacheMissTokens: cacheMissTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
    warnings,
  };
}

export function priceDeepSeekUsage(model, rawUsage, { occurredAt } = {}) {
  const usage = normalizeDeepSeekUsage(rawUsage);
  const pricing = resolveDeepSeekPricing(model, { occurredAt });
  const completeUsage = usage && usage.promptCacheHitTokens !== null && usage.promptCacheMissTokens !== null && usage.completionTokens !== null;
  if (!completeUsage || !pricing.rates) {
    return {
      usage,
      pricing: { ...pricing, rates: pricing.rates },
      status: !usage ? "usage-unavailable" : !pricing.rates ? "unknown-model" : "usage-incomplete",
      cost: null,
    };
  }
  const cacheHitCny = money((usage.promptCacheHitTokens * pricing.rates.cacheHit) / pricing.unitTokens);
  const cacheMissCny = money((usage.promptCacheMissTokens * pricing.rates.cacheMiss) / pricing.unitTokens);
  const outputCny = money((usage.completionTokens * pricing.rates.output) / pricing.unitTokens);
  return {
    usage,
    pricing: { ...pricing, rates: pricing.rates },
    status: usage.warnings.length ? "priced-with-warning" : "priced",
    cost: {
      cacheHitCny,
      cacheMissCny,
      outputCny,
      totalCny: money(cacheHitCny + cacheMissCny + outputCny),
      currency: pricing.currency,
      estimated: true,
    },
  };
}

export function summarizeBillingCalls(calls = [], { cacheServed = false } = {}) {
  const totals = {
    providerCalls: calls.length,
    pricedCalls: 0,
    unknownCostCalls: 0,
    promptTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostCny: 0,
  };
  for (const call of calls) {
    const usage = call.billing?.usage;
    if (usage) {
      totals.promptTokens += usage.promptTokens ?? 0;
      totals.promptCacheHitTokens += usage.promptCacheHitTokens ?? 0;
      totals.promptCacheMissTokens += usage.promptCacheMissTokens ?? 0;
      totals.completionTokens += usage.completionTokens ?? 0;
      totals.reasoningTokens += usage.reasoningTokens ?? 0;
      totals.totalTokens += usage.totalTokens ?? 0;
    }
    if (call.billing?.cost) {
      totals.pricedCalls += 1;
      totals.estimatedCostCny = money(totals.estimatedCostCny + call.billing.cost.totalCny);
    } else {
      totals.unknownCostCalls += 1;
    }
  }
  return {
    schemaVersion: "1.1.0",
    pricingVersion: DEEPSEEK_PRICING.pricingVersion,
    pricingHash: DEEPSEEK_PRICING_HASH,
    pricingSourceUrl: DEEPSEEK_PRICING.sourceUrl,
    pricingTimeZone: DEEPSEEK_PRICING.timeZone,
    currency: DEEPSEEK_PRICING.currency,
    estimated: true,
    cacheServed,
    ...totals,
  };
}
import { createHash } from "node:crypto";
