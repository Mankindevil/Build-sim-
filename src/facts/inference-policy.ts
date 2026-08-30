import { hashContent, isSha256Hex } from "../hash";
import type { FactRecord } from "./contracts";

export interface InferenceFactRef {
  factId: string;
  contentHash: string;
}

export interface ReplayableInferenceTrace {
  schemaVersion: "fact-inference-v1";
  inferenceTraceId: string;
  inputFactRefs: InferenceFactRef[];
  outputFactIds: string[];
  engine: "rule" | "model";
  ruleOrModelId: string;
  ruleOrModelVersion: string;
  ruleOrModelArtifactHash: string;
  assumptions: string[];
  confidence: number;
  outputRange?: { min: number; max: number; unit?: string };
  invalidationConditions: string[];
  createdAt: string;
  contentHash: string;
}

export type ReplayableInferenceTraceInput = Omit<ReplayableInferenceTrace, "inferenceTraceId" | "contentHash">;

const CONTRACT = Object.freeze({
  domain: "fact-inference",
  schemaVersion: "fact-inference-v1",
  canonicalizationPolicyId: "fact-inference-content-v1",
} as const);

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).every((key) => fields.includes(key)); }
function text(value: unknown, max = 512): value is string {
  if (typeof value !== "string" || !value.length || value.length > max || value !== value.normalize("NFC")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function time(value: unknown): value is string { return text(value, 64) && Number.isFinite(Date.parse(value)); }
function textSet(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every((item) => text(item, 1024)) && new Set(value).size === value.length; }

export function validateReplayableInferenceTrace(value: unknown): string[] {
  if (!record(value)) return ["inference trace must be an object"];
  const errors: string[] = [];
  const fields = ["schemaVersion", "inferenceTraceId", "inputFactRefs", "outputFactIds", "engine", "ruleOrModelId", "ruleOrModelVersion", "ruleOrModelArtifactHash", "assumptions", "confidence", "outputRange", "invalidationConditions", "createdAt", "contentHash"];
  if (!exact(value, fields)) errors.push("inference trace contains unknown fields");
  if (value.schemaVersion !== "fact-inference-v1") errors.push("inference trace schemaVersion invalid");
  if (!isSha256Hex(value.contentHash) || value.inferenceTraceId !== `inference-sha256-${String(value.contentHash)}`) errors.push("inference trace content identity invalid");
  if (!Array.isArray(value.inputFactRefs) || !value.inputFactRefs.length) errors.push("inference trace input facts invalid");
  else {
    const ids = new Set<string>();
    for (const ref of value.inputFactRefs) {
      if (!record(ref) || !exact(ref, ["factId", "contentHash"]) || !text(ref.factId, 256) || !isSha256Hex(ref.contentHash)) errors.push("inference trace input fact ref invalid");
      else if (ids.has(ref.factId)) errors.push("inference trace input facts duplicated");
      else ids.add(ref.factId);
    }
  }
  if (!textSet(value.outputFactIds)) errors.push("inference trace output fact IDs invalid");
  if (value.engine !== "rule" && value.engine !== "model") errors.push("inference trace engine invalid");
  if (!text(value.ruleOrModelId, 256) || !text(value.ruleOrModelVersion, 256) || !isSha256Hex(value.ruleOrModelArtifactHash)) errors.push("inference trace rule/model artifact invalid");
  if (!Array.isArray(value.assumptions) || value.assumptions.some((item) => !text(item, 1024)) || new Set(value.assumptions).size !== value.assumptions.length) errors.push("inference trace assumptions invalid");
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) errors.push("inference trace confidence invalid");
  if (value.outputRange !== undefined) {
    if (!record(value.outputRange) || !exact(value.outputRange, ["min", "max", "unit"])
      || typeof value.outputRange.min !== "number" || !Number.isFinite(value.outputRange.min)
      || typeof value.outputRange.max !== "number" || !Number.isFinite(value.outputRange.max) || value.outputRange.min > value.outputRange.max
      || (value.outputRange.unit !== undefined && !text(value.outputRange.unit, 64))) errors.push("inference trace output range invalid");
  }
  if (!textSet(value.invalidationConditions)) errors.push("inference trace invalidation conditions invalid");
  if (!time(value.createdAt)) errors.push("inference trace createdAt invalid");
  return errors;
}

export async function inferenceTraceContentHash(value: ReplayableInferenceTraceInput | ReplayableInferenceTrace): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createReplayableInferenceTrace(input: ReplayableInferenceTraceInput): Promise<ReplayableInferenceTrace> {
  const material = structuredClone(input);
  const contentHash = await inferenceTraceContentHash(material);
  const trace: ReplayableInferenceTrace = Object.freeze({ ...material, inferenceTraceId: `inference-sha256-${contentHash}`, contentHash });
  const errors = validateReplayableInferenceTrace(trace);
  if (errors.length) throw new TypeError(`Invalid replayable inference trace: ${errors.join("; ")}`);
  return trace;
}

export async function verifyReplayableInferenceTrace(value: unknown): Promise<boolean> {
  if (validateReplayableInferenceTrace(value).length) return false;
  const trace = value as ReplayableInferenceTrace;
  const hash = await inferenceTraceContentHash(trace);
  return trace.contentHash === hash && trace.inferenceTraceId === `inference-sha256-${hash}`;
}

export async function inferenceTraceIsCurrent(trace: ReplayableInferenceTrace, currentFacts: readonly FactRecord[], currentArtifactHash: string): Promise<boolean> {
  if (!await verifyReplayableInferenceTrace(trace) || trace.ruleOrModelArtifactHash !== currentArtifactHash) return false;
  const facts = new Map(currentFacts.filter((fact) => fact.status === "active").map((fact) => [fact.factId, fact]));
  const superseded = new Set(currentFacts.flatMap((fact) => fact.supersedesFactId ? [fact.supersedesFactId] : []));
  return trace.inputFactRefs.every((ref) => {
    const fact = facts.get(ref.factId);
    return fact?.contentHash === ref.contentHash && !superseded.has(ref.factId);
  });
}
