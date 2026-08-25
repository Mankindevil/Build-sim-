import type { BuildConfig, BuildLineItem } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type { EngineFinding } from "../core/engine";
import type { N6Routing } from "../adapters/jonsbo-n6/routing";
import type { ThermalResult } from "../core/thermal";
import type { WiringPlan } from "../wiring/types";
import type { FieldProvenance } from "../catalog-search/types";
import type { PhysicalEvaluation } from "../core/physical";
import type { CalibrationEvaluation } from "../core/calibration";

export const ADVICE_SCHEMA_VERSION = "1.0.0" as const;
export const ADVICE_PROMPT_VERSION = "build-advice-1.0.0" as const;

export interface BuildAdviceInput {
  requestId: string;
  locale: "zh-CN" | "en-US" | "ja-JP";
  userGoal?: string;
  buildConfig: BuildConfig;
  evaluation: {
    findings: EngineFinding[];
    occupancy: BuildEvaluation["occupancy"];
    wiring: WiringPlan;
    routing: N6Routing;
    thermal?: ThermalResult;
    bom: BuildLineItem[];
    unknown: string[];
    physical: PhysicalEvaluation;
    calibration: CalibrationEvaluation;
    engineHash?: string;
  };
  selectedSkuFacts: {
    skuId: string;
    name: string;
    fields: Record<string, unknown>;
    provenance: FieldProvenance[];
  }[];
  constraints: {
    cannotDowngradeBad: true;
    unknownMustStayUnknown: true;
    citeSourceFields: true;
  };
}

export interface AdviceClaim {
  text: string;
  kind: "engine-finding" | "official-field" | "user-goal" | "model-inference";
  refs: string[];
}

export interface AdviceRisk {
  level: "high" | "medium" | "low" | "unknown";
  category: "mechanical" | "electrical" | "thermal" | "maintenance" | "price" | "data";
  text: string;
  refs: string[];
  mitigation?: string;
}

export interface AdviceAction {
  priority: number;
  action: string;
  blocking: boolean;
  refs: string[];
}

export interface AdviceAlternative {
  title: string;
  changes: string[];
  benefits: string[];
  tradeoffs: string[];
  refs: string[];
}

export interface BuildAdviceResult {
  schemaVersion: typeof ADVICE_SCHEMA_VERSION;
  model: string;
  generatedAt: string;
  summary: string;
  recommendation: {
    verdict: "recommended" | "conditional" | "not-recommended" | "insufficient-data";
    reasons: AdviceClaim[];
  };
  risks: AdviceRisk[];
  actions: AdviceAction[];
  alternatives: AdviceAlternative[];
  unknowns: string[];
  sourceRefs: string[];
}

export interface DeterministicAdviceFacts {
  findings: EngineFinding[];
  bom: BuildLineItem[];
  unknown: string[];
  verdict: "ok" | "warn" | "bad";
}

export interface AdviceValidation {
  ok: boolean;
  errors: string[];
  result?: BuildAdviceResult;
}

export interface AdviceJobResponse {
  requestId: string;
  status: "queued" | "running" | "completed" | "disabled" | "advice-unavailable";
  provider: "deepseek";
  model: string | null;
  promptVersion: typeof ADVICE_PROMPT_VERSION;
  inputHash: string;
  engineHash: string;
  deterministic: DeterministicAdviceFacts;
  advice?: BuildAdviceResult;
  failureStage?: string;
  validationErrors?: string[];
  generatedAt?: string;
  cacheHit?: boolean;
  calls?: AdviceBillingCall[];
  billing?: AdviceBillingTotals;
}

export interface DeepSeekUsage {
  promptTokens: number | null;
  promptCacheHitTokens: number | null;
  promptCacheMissTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  warnings: string[];
}

export interface AdviceBillingCost {
  cacheHitCny: number;
  cacheMissCny: number;
  outputCny: number;
  totalCny: number;
  currency: "CNY";
  estimated: true;
}

export interface AdviceBillingCall {
  callId: string;
  requestId: string;
  attempt: number;
  status: "completed" | "validation-failed" | "failed";
  provider: "deepseek";
  requestedModel: string | null;
  providerModel: string | null;
  providerRequestId: string | null;
  latencyMs: number | null;
  httpStatus: number | null;
  failureStage: string | null;
  startedAt: string;
  generatedAt: string;
  billing: {
    usage: DeepSeekUsage | null;
    pricing: {
      requestedModel: string | null;
      billedModel: string | null;
      aliasApplied: boolean;
      pricingBand: {
        id: "peak" | "off-peak";
        label: string;
        timeZone: "Asia/Shanghai";
        occurredAt: string;
        localDate: string;
        localTime: string;
        weekday: string;
      } | null;
      rates: { cacheHit: number; cacheMiss: number; output: number } | null;
      pricingVersion: string;
      pricingHash: string;
      sourceUrl: string;
      capturedAt: string;
      currency: "CNY";
      unitTokens: number;
      timeZone: "Asia/Shanghai";
    };
    status: "priced" | "priced-with-warning" | "usage-unavailable" | "unknown-model" | "usage-incomplete";
    cost: AdviceBillingCost | null;
  };
}

export interface AdviceBillingTotals {
  schemaVersion: "1.1.0";
  pricingVersion: string;
  pricingHash: string;
  pricingSourceUrl: string;
  pricingTimeZone: "Asia/Shanghai";
  currency: "CNY";
  estimated: true;
  cacheServed: boolean;
  providerCalls: number;
  pricedCalls: number;
  unknownCostCalls: number;
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
}

export interface AdviceBillingSummary {
  schemaVersion: "1.0.0";
  generatedAt: string;
  pricing: {
    pricingVersion: string;
    pricingHash: string;
    capturedAt: string;
    sourceUrl: string;
    currency: "CNY";
    unitTokens: number;
    timeZone: "Asia/Shanghai";
    bandRule: {
      weekdays: readonly string[];
      peakWindows: ReadonlyArray<{ start: string; end: string }>;
      weekend: "off-peak";
    };
  };
  jobs: number;
  cacheServedJobs: number;
  totals: AdviceBillingTotals;
  byModel: Array<AdviceBillingTotals & { model: string }>;
  byPricingBand: Array<AdviceBillingTotals & { pricingBand: string; label: string }>;
  calls: AdviceBillingCall[];
  returnedCalls: number;
  totalCalls: number;
}
