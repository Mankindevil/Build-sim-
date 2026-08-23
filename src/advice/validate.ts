import type { BuildConfig } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import type { FieldProvenance } from "../catalog-search/types";
import {
  ADVICE_SCHEMA_VERSION,
  type AdviceAction,
  type AdviceAlternative,
  type AdviceClaim,
  type AdviceRisk,
  type AdviceValidation,
  type BuildAdviceInput,
  type BuildAdviceResult,
} from "./types";

const MAX_TEXT = 2_000;
const MAX_ARRAY = 64;

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function buildAdviceInput(args: {
  requestId: string;
  locale?: BuildAdviceInput["locale"];
  userGoal?: string;
  buildConfig: BuildConfig;
  evaluation: BuildEvaluation;
  selectedSkuFacts: BuildAdviceInput["selectedSkuFacts"];
}): BuildAdviceInput {
  const unknown = [
    ...args.evaluation.power.unknown,
    ...args.evaluation.findings.filter((f) => f.evidence === "unknown").map((f) => f.id),
    ...(args.evaluation.thermal?.evidence === "unknown" ? ["thermal.evidence"] : []),
  ];
  return {
    requestId: args.requestId,
    locale: args.locale ?? "zh-CN",
    ...(args.userGoal ? { userGoal: args.userGoal.slice(0, MAX_TEXT) } : {}),
    buildConfig: args.buildConfig,
    evaluation: {
      findings: args.evaluation.findings,
      occupancy: args.evaluation.occupancy,
      wiring: args.evaluation.wiring,
      routing: args.evaluation.routing,
      ...(args.evaluation.thermal ? { thermal: args.evaluation.thermal } : {}),
      bom: args.evaluation.bom,
      unknown: [...new Set(unknown)],
    },
    selectedSkuFacts: args.selectedSkuFacts.map((fact) => ({
      skuId: fact.skuId,
      name: fact.name.slice(0, 200),
      fields: fact.fields,
      provenance: fact.provenance,
    })),
    constraints: {
      cannotDowngradeBad: true,
      unknownMustStayUnknown: true,
      citeSourceFields: true,
    },
  };
}

export function validateAdviceInput(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["input must be an object"];
  const input = value as Partial<BuildAdviceInput>;
  if (!input.requestId || typeof input.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,120}$/.test(input.requestId)) errors.push("requestId invalid");
  if (!input.locale || !["zh-CN", "en-US", "ja-JP"].includes(input.locale)) errors.push("locale invalid");
  if (input.userGoal !== undefined && (typeof input.userGoal !== "string" || input.userGoal.length > MAX_TEXT)) errors.push("userGoal invalid");
  if (!input.buildConfig || typeof input.buildConfig !== "object") errors.push("buildConfig missing");
  const evaluation = input.evaluation;
  if (!evaluation || typeof evaluation !== "object") errors.push("evaluation missing");
  else {
    if (!Array.isArray(evaluation.findings) || evaluation.findings.length > MAX_ARRAY) errors.push("evaluation.findings invalid");
    if (!Array.isArray(evaluation.bom) || evaluation.bom.length > MAX_ARRAY) errors.push("evaluation.bom invalid");
    if (!Array.isArray(evaluation.unknown) || evaluation.unknown.length > MAX_ARRAY) errors.push("evaluation.unknown invalid");
    for (const finding of evaluation.findings ?? []) {
      if (!finding || typeof finding !== "object" || typeof finding.id !== "string" || !["ok", "warn", "bad"].includes(finding.verdict)) errors.push("finding invalid");
      if (typeof finding?.message === "string" && finding.message.length > MAX_TEXT) errors.push("finding message too long");
    }
  }
  if (!Array.isArray(input.selectedSkuFacts) || input.selectedSkuFacts.length > MAX_ARRAY) errors.push("selectedSkuFacts invalid");
  for (const fact of input.selectedSkuFacts ?? []) {
    if (!fact || typeof fact !== "object" || typeof fact.skuId !== "string" || typeof fact.name !== "string" || !fact.fields || !Array.isArray(fact.provenance)) errors.push("selected SKU fact invalid");
    for (const provenance of fact?.provenance ?? []) {
      if (!provenance || typeof provenance !== "object" || typeof provenance.provenanceId !== "string") errors.push("SKU provenance invalid");
    }
  }
  if (input.constraints?.cannotDowngradeBad !== true || input.constraints?.unknownMustStayUnknown !== true || input.constraints?.citeSourceFields !== true) errors.push("safety constraints missing");
  return [...new Set(errors)];
}

function textWithin(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function refsOf(input: BuildAdviceInput): Set<string> {
  const refs = new Set<string>(["user-goal"]);
  for (const finding of input.evaluation.findings) refs.add(finding.id);
  for (const fact of input.selectedSkuFacts) {
    refs.add(fact.skuId);
    for (const provenance of fact.provenance) refs.add(provenance.provenanceId);
  }
  return refs;
}

function knownNumericTokens(input: BuildAdviceInput): Set<string> {
  const out = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) out.add(String(value));
    else if (typeof value === "string") {
      for (const token of value.match(/(?<![A-Za-z])[+-]?\d+(?:\.\d+)?/g) ?? []) out.add(token);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(input);
  return out;
}

function numbersOutsideInput(text: string, known: Set<string>): string[] {
  return (text.match(/(?<![A-Za-z])[+-]?\d+(?:\.\d+)?/g) ?? []).filter((token) => !known.has(token));
}

function validateRefs(refs: unknown, allowed: Set<string>, errors: string[], path: string): refs is string[] {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 12 || refs.some((ref) => typeof ref !== "string" || !allowed.has(ref))) {
    errors.push(`${path} refs invalid`);
    return false;
  }
  return true;
}

function validateClaim(value: unknown, input: BuildAdviceInput, allowed: Set<string>, known: Set<string>, errors: string[], path: string): value is AdviceClaim {
  const claim = value as Partial<AdviceClaim>;
  if (!claim || !textWithin(claim.text) || typeof claim.kind !== "string" || !["engine-finding", "official-field", "user-goal", "model-inference"].includes(claim.kind)) {
    errors.push(`${path} invalid`);
    return false;
  }
  validateRefs(claim.refs, allowed, errors, path);
  if (numbersOutsideInput(claim.text, known).length > 0) errors.push(`${path} contains unsupported number`);
  return true;
}

function validateRisk(value: unknown, allowed: Set<string>, known: Set<string>, errors: string[], path: string): value is AdviceRisk {
  const risk = value as Partial<AdviceRisk>;
  if (!risk || !textWithin(risk.text) || typeof risk.level !== "string" || !["high", "medium", "low", "unknown"].includes(risk.level) || typeof risk.category !== "string" || !["mechanical", "electrical", "thermal", "maintenance", "price", "data"].includes(risk.category)) {
    errors.push(`${path} invalid`);
    return false;
  }
  validateRefs(risk.refs, allowed, errors, path);
  if (risk.mitigation !== undefined && !textWithin(risk.mitigation)) errors.push(`${path} mitigation invalid`);
  if (numbersOutsideInput(`${risk.text} ${risk.mitigation ?? ""}`, known).length > 0) errors.push(`${path} contains unsupported number`);
  return true;
}

function validateAction(value: unknown, allowed: Set<string>, known: Set<string>, errors: string[], path: string): value is AdviceAction {
  const action = value as Partial<AdviceAction>;
  if (!action || !textWithin(action.action) || typeof action.priority !== "number" || !Number.isInteger(action.priority) || action.priority < 1 || action.priority > 99 || typeof action.blocking !== "boolean") {
    errors.push(`${path} invalid`);
    return false;
  }
  validateRefs(action.refs, allowed, errors, path);
  if (numbersOutsideInput(action.action, known).length > 0) errors.push(`${path} contains unsupported number`);
  return true;
}

function validateAlternative(value: unknown, allowed: Set<string>, known: Set<string>, errors: string[], path: string): value is AdviceAlternative {
  const alternative = value as Partial<AdviceAlternative>;
  if (!alternative || !textWithin(alternative.title) || !Array.isArray(alternative.changes) || !Array.isArray(alternative.benefits) || !Array.isArray(alternative.tradeoffs)) {
    errors.push(`${path} invalid`);
    return false;
  }
  validateRefs(alternative.refs, allowed, errors, path);
  for (const [key, values] of [["changes", alternative.changes], ["benefits", alternative.benefits], ["tradeoffs", alternative.tradeoffs]] as const) {
    if (values.length > 12 || values.some((item) => !textWithin(item))) errors.push(`${path}.${key} invalid`);
    if (values.some((item) => numbersOutsideInput(item, known).length > 0)) errors.push(`${path}.${key} contains unsupported number`);
  }
  return true;
}

export function validateAdviceResult(value: unknown, input: BuildAdviceInput): AdviceValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["result must be an object"] };
  const result = value as Partial<BuildAdviceResult>;
  const allowed = refsOf(input);
  const known = knownNumericTokens(input);
  if (result.schemaVersion !== ADVICE_SCHEMA_VERSION) errors.push("schemaVersion invalid");
  if (!textWithin(result.model) || !textWithin(result.generatedAt) || !textWithin(result.summary)) errors.push("result header invalid");
  const recommendation = result.recommendation;
  if (!recommendation || typeof recommendation !== "object" || !["recommended", "conditional", "not-recommended", "insufficient-data"].includes(recommendation.verdict) || !Array.isArray(recommendation.reasons) || recommendation.reasons.length > MAX_ARRAY) errors.push("recommendation invalid");
  else recommendation.reasons.forEach((claim, i) => validateClaim(claim, input, allowed, known, errors, `recommendation.reasons[${i}]`));
  if (recommendation?.verdict === "recommended" && input.evaluation.findings.some((finding) => finding.verdict === "bad")) errors.push("recommended cannot override bad finding");
  if (!Array.isArray(result.risks) || result.risks.length > MAX_ARRAY) errors.push("risks invalid");
  else result.risks.forEach((risk, i) => validateRisk(risk, allowed, known, errors, `risks[${i}]`));
  if (!Array.isArray(result.actions) || result.actions.length > MAX_ARRAY) errors.push("actions invalid");
  else result.actions.forEach((action, i) => validateAction(action, allowed, known, errors, `actions[${i}]`));
  if (!Array.isArray(result.alternatives) || result.alternatives.length > MAX_ARRAY) errors.push("alternatives invalid");
  else result.alternatives.forEach((alternative, i) => validateAlternative(alternative, allowed, known, errors, `alternatives[${i}]`));
  if (!Array.isArray(result.unknowns) || result.unknowns.length > MAX_ARRAY || result.unknowns.some((item) => !textWithin(item))) errors.push("unknowns invalid");
  if (Array.isArray(result.sourceRefs) && result.sourceRefs.some((ref) => !allowed.has(ref))) errors.push("sourceRefs invalid");
  if (numbersOutsideInput(result.summary ?? "", known).length > 0) errors.push("summary contains unsupported number");
  return errors.length > 0 ? { ok: false, errors: [...new Set(errors)] } : { ok: true, errors: [], result: result as BuildAdviceResult };
}

export function deterministicFacts(input: BuildAdviceInput): { findings: BuildAdviceInput["evaluation"]["findings"]; bom: BuildAdviceInput["evaluation"]["bom"]; unknown: string[]; verdict: "ok" | "warn" | "bad" } {
  const verdict = input.evaluation.findings.some((f) => f.verdict === "bad") ? "bad" : input.evaluation.findings.some((f) => f.verdict === "warn") ? "warn" : "ok";
  return { findings: input.evaluation.findings, bom: input.evaluation.bom, unknown: input.evaluation.unknown, verdict };
}
