import type { BuildConfig, BuildLineItem } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type { EngineFinding } from "../core/engine";
import type { N6Routing } from "../adapters/jonsbo-n6/routing";
import type { ThermalResult } from "../core/thermal";
import type { WiringPlan } from "../wiring/types";
import type { FieldProvenance } from "../catalog-search/types";

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
}
