import { createHash } from "node:crypto";
import { hashContent, isSha256Hex } from "../../hash";
import type { EvidenceClaimInput } from "../claims";
import {
  EVIDENCE_SEARCH_REASONS,
  type EvidenceSearchReason,
} from "../search-outcome.mjs";

export const EVIDENCE_PIPELINE_SCHEMA_VERSION = "evidence-pipeline-v1" as const;
export const EVIDENCE_PIPELINE_HANDLER_VERSION = "1" as const;

export const EVIDENCE_PIPELINE_STAGES = Object.freeze([
  "official_discovery",
  "official_acquisition",
  "archive",
  "parse_ocr",
  "excerpt",
  "claim_extraction",
  "third_party_fallback",
  "fact_impact",
  "adapter_generation",
  "binding_proposal",
] as const);

export type EvidencePipelineStage = (typeof EVIDENCE_PIPELINE_STAGES)[number];

export const EVIDENCE_PIPELINE_JOB_TYPES: Readonly<Record<EvidencePipelineStage, string>> = Object.freeze({
  official_discovery: "evidence.official.discovery",
  official_acquisition: "evidence.official.acquire",
  archive: "evidence.archive",
  parse_ocr: "evidence.parse-ocr",
  excerpt: "evidence.excerpt",
  claim_extraction: "evidence.claim.extract",
  third_party_fallback: "evidence.third-party.fallback",
  fact_impact: "evidence.fact-impact",
  adapter_generation: "evidence.adapter.generate",
  binding_proposal: "evidence.binding.propose",
});

export const EVIDENCE_NETWORK_STAGES = Object.freeze([
  "official_discovery",
  "official_acquisition",
  "third_party_fallback",
] as const satisfies readonly EvidencePipelineStage[]);

/** Backward-compatible job name backed by the single U4 search-outcome registry. */
export const EVIDENCE_OFFICIAL_SEARCH_REASONS = EVIDENCE_SEARCH_REASONS;

export type EvidenceOfficialSearchReason = EvidenceSearchReason;

export interface EvidencePipelineSubject {
  readonly brand: string;
  readonly category: string;
  readonly skuId: string;
  readonly familyId: string;
  readonly modelId?: string;
  readonly variantId?: string;
  readonly revision?: string;
  readonly region?: string;
}

export interface EvidencePipelineRequestInput {
  readonly planId?: string;
  readonly subject: EvidencePipelineSubject;
  readonly requestedFieldIds: readonly string[];
  readonly entry:
    | { readonly kind: "official_url"; readonly url: string }
    | { readonly kind: "search_query"; readonly query: string };
  readonly allowThirdPartyFallback: boolean;
  readonly requestedAt: string;
}

export interface EvidencePipelineRequest extends EvidencePipelineRequestInput {
  readonly schemaVersion: typeof EVIDENCE_PIPELINE_SCHEMA_VERSION;
  readonly pipelineId: `evidence-pipeline-sha256-${string}`;
  readonly requestHash: string;
}

export type EvidenceStageStatus = "completed" | "skipped" | "needs_review" | "blocked";

export interface EvidenceStageEffectResult {
  readonly status: EvidenceStageStatus;
  /** Bounded finite JSON. Untrusted document/OCR text remains an artifact reference. */
  readonly output: Readonly<Record<string, unknown>>;
  readonly resultRefs?: readonly string[];
  readonly officialSearchReason?: EvidenceOfficialSearchReason;
}

export interface EvidenceStageAttemptCheckpoint {
  readonly schemaVersion: "evidence-stage-attempt-v1";
  readonly pipelineId: EvidencePipelineRequest["pipelineId"];
  readonly stage: EvidencePipelineStage;
  readonly jobId: string;
  readonly attemptStartedAt: string;
  readonly inputRefs: readonly string[];
}

export interface EvidenceStageResult {
  readonly schemaVersion: "evidence-stage-result-v1";
  readonly pipelineId: EvidencePipelineRequest["pipelineId"];
  readonly stage: EvidencePipelineStage;
  readonly handlerVersion: typeof EVIDENCE_PIPELINE_HANDLER_VERSION;
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly attemptStartedAt: string;
  readonly completedAt: string;
  readonly status: EvidenceStageStatus;
  readonly inputRefs: readonly string[];
  readonly output: Readonly<Record<string, unknown>>;
  readonly resultRefs: readonly string[];
  readonly officialSearchReason?: EvidenceOfficialSearchReason;
}

export interface EvidenceClaimCandidateOutput {
  readonly claimCandidates: readonly EvidenceClaimInput[];
}

export interface EvidencePipelineDescriptor {
  readonly pipelineId: EvidencePipelineRequest["pipelineId"];
  readonly requestRef: string;
  readonly requestHash: string;
  readonly jobIds: Readonly<Record<EvidencePipelineStage, string>>;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const PIPELINE_ID = /^evidence-pipeline-sha256-[a-f0-9]{64}$/;
const ARTIFACT_REF = /^sha256:[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteJson(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === undefined) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 16_384 && value === value.normalize("NFC");
  if (Array.isArray(value)) return value.length <= 2_048 && value.every((item) => finiteJson(item, depth + 1));
  if (!record(value) || Object.keys(value).length > 512) return false;
  return Object.entries(value).every(([key, child]) => key.length > 0 && key.length <= 256 && finiteJson(child, depth + 1));
}

function normalizedToken(value: string, label: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!TOKEN.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function normalizedHumanText(value: string, label: string, maximum = 512): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function normalizedSubject(value: EvidencePipelineSubject): EvidencePipelineSubject {
  if (!record(value)) throw new TypeError("evidence pipeline subject is invalid");
  const allowed = ["brand", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError("evidence pipeline subject contains unknown fields");
  return Object.freeze({
    brand: normalizedHumanText(value.brand, "subject.brand", 256),
    category: normalizedHumanText(value.category, "subject.category", 256),
    skuId: normalizedToken(value.skuId, "subject.skuId"),
    familyId: normalizedToken(value.familyId, "subject.familyId"),
    ...(value.modelId === undefined ? {} : { modelId: normalizedToken(value.modelId, "subject.modelId") }),
    ...(value.variantId === undefined ? {} : { variantId: normalizedToken(value.variantId, "subject.variantId") }),
    ...(value.revision === undefined ? {} : { revision: normalizedToken(value.revision, "subject.revision") }),
    ...(value.region === undefined ? {} : { region: normalizedToken(value.region, "subject.region") }),
  });
}

function hashArtifactMaterial(artifactId: string, payload: unknown): Promise<string> {
  return hashContent({
    schemaVersion: "artifact-payload-v1",
    artifactId,
    mediaType: "application/vnd.buildsim.evidence-job+json",
    payload,
    contentHash: "0".repeat(64),
  }, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
}

export async function createEvidencePipelineRequest(input: EvidencePipelineRequestInput): Promise<EvidencePipelineRequest> {
  if (!record(input) || Object.keys(input).some((key) => !["planId", "subject", "requestedFieldIds", "entry", "allowThirdPartyFallback", "requestedAt"].includes(key))) {
    throw new TypeError("evidence pipeline request fields are invalid");
  }
  if (!Number.isFinite(Date.parse(input.requestedAt))) throw new TypeError("evidence pipeline requestedAt is invalid");
  if (typeof input.allowThirdPartyFallback !== "boolean") throw new TypeError("allowThirdPartyFallback must be boolean");
  if (!Array.isArray(input.requestedFieldIds) || input.requestedFieldIds.length === 0) throw new TypeError("requestedFieldIds must not be empty");
  const requestedFieldIds = [...new Set(input.requestedFieldIds.map((field) => normalizedToken(field, "requested field")))].sort();
  if (requestedFieldIds.length !== input.requestedFieldIds.length) throw new TypeError("requestedFieldIds must be unique");
  if (!record(input.entry) || (input.entry.kind !== "official_url" && input.entry.kind !== "search_query")) {
    throw new TypeError("evidence pipeline entry is invalid");
  }
  let entry: EvidencePipelineRequestInput["entry"];
  if (input.entry.kind === "official_url") {
    if (Object.keys(input.entry).some((key) => !["kind", "url"].includes(key))) throw new TypeError("official URL entry contains unknown fields");
    const url = new URL(input.entry.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new TypeError("official URL entry must be public HTTPS without credentials or fragments");
    entry = Object.freeze({ kind: "official_url", url: url.toString() });
  } else {
    if (Object.keys(input.entry).some((key) => !["kind", "query"].includes(key))) throw new TypeError("search query entry contains unknown fields");
    const query = input.entry.query.normalize("NFC").trim();
    if (!query || query.length > 512) throw new TypeError("search query entry is invalid");
    entry = Object.freeze({ kind: "search_query", query });
  }
  const candidate = Object.freeze({
    schemaVersion: EVIDENCE_PIPELINE_SCHEMA_VERSION,
    ...(input.planId === undefined ? {} : { planId: normalizedToken(input.planId, "planId") }),
    subject: normalizedSubject(input.subject),
    requestedFieldIds: Object.freeze(requestedFieldIds),
    entry,
    allowThirdPartyFallback: input.allowThirdPartyFallback,
    requestedAt: new Date(input.requestedAt).toISOString(),
  });
  const requestHash = await hashArtifactMaterial("evidence-pipeline-request", candidate);
  return Object.freeze({ ...candidate, pipelineId: `evidence-pipeline-sha256-${requestHash}`, requestHash });
}

export async function verifyEvidencePipelineRequest(value: unknown): Promise<boolean> {
  if (!record(value) || value.schemaVersion !== EVIDENCE_PIPELINE_SCHEMA_VERSION || typeof value.pipelineId !== "string"
    || Object.keys(value).some((key) => ![
      "schemaVersion", "pipelineId", "requestHash", "planId", "subject", "requestedFieldIds", "entry",
      "allowThirdPartyFallback", "requestedAt",
    ].includes(key))
    || !PIPELINE_ID.test(value.pipelineId) || typeof value.requestHash !== "string" || !isSha256Hex(value.requestHash)) return false;
  try {
    const recreated = await createEvidencePipelineRequest({
      ...(value.planId === undefined ? {} : { planId: value.planId as string }),
      subject: value.subject as EvidencePipelineSubject,
      requestedFieldIds: value.requestedFieldIds as string[],
      entry: value.entry as EvidencePipelineRequestInput["entry"],
      allowThirdPartyFallback: value.allowThirdPartyFallback as boolean,
      requestedAt: value.requestedAt as string,
    });
    return recreated.requestHash === value.requestHash && recreated.pipelineId === value.pipelineId;
  } catch { return false; }
}

export function evidenceStageIdempotencyKey(pipelineId: string, stage: EvidencePipelineStage): string {
  if (!PIPELINE_ID.test(pipelineId) || !EVIDENCE_PIPELINE_STAGES.includes(stage)) throw new TypeError("evidence stage identity is invalid");
  return `${pipelineId}:${stage}:${EVIDENCE_PIPELINE_HANDLER_VERSION}`;
}

export function jobIdForEvidenceStage(pipelineId: string, stage: EvidencePipelineStage): string {
  const key = evidenceStageIdempotencyKey(pipelineId, stage);
  return `job-${createHash("sha256").update(key.normalize("NFC"), "utf8").digest("hex")}`;
}

export async function evidenceStageInputHash(
  request: EvidencePipelineRequest,
  stage: EvidencePipelineStage,
  dependencyJobIds: readonly string[],
): Promise<string> {
  return hashArtifactMaterial(`evidence-stage-input:${stage}`, {
    pipelineId: request.pipelineId,
    requestHash: request.requestHash,
    stage,
    dependencyJobIds: [...dependencyJobIds],
    handlerVersion: EVIDENCE_PIPELINE_HANDLER_VERSION,
  });
}

export async function evidenceStageCommitHash(result: EvidenceStageResult): Promise<string> {
  return hashArtifactMaterial(`evidence-stage-result:${result.stage}`, result);
}

export function validateEvidenceStageAttempt(value: unknown): value is EvidenceStageAttemptCheckpoint {
  return record(value) && Object.keys(value).every((key) => ["schemaVersion", "pipelineId", "stage", "jobId", "attemptStartedAt", "inputRefs"].includes(key))
    && value.schemaVersion === "evidence-stage-attempt-v1" && typeof value.pipelineId === "string" && PIPELINE_ID.test(value.pipelineId)
    && typeof value.stage === "string" && EVIDENCE_PIPELINE_STAGES.includes(value.stage as EvidencePipelineStage)
    && typeof value.jobId === "string" && /^job-[a-f0-9]{64}$/.test(value.jobId)
    && typeof value.attemptStartedAt === "string" && Number.isFinite(Date.parse(value.attemptStartedAt))
    && Array.isArray(value.inputRefs) && value.inputRefs.every((ref) => typeof ref === "string" && ARTIFACT_REF.test(ref))
    && new Set(value.inputRefs).size === value.inputRefs.length;
}

export function validateEvidenceStageResult(value: unknown): value is EvidenceStageResult {
  if (!record(value) || Object.keys(value).some((key) => ![
    "schemaVersion", "pipelineId", "stage", "handlerVersion", "jobId", "idempotencyKey", "attemptStartedAt",
    "completedAt", "status", "inputRefs", "output", "resultRefs", "officialSearchReason",
  ].includes(key))) return false;
  return value.schemaVersion === "evidence-stage-result-v1" && typeof value.pipelineId === "string" && PIPELINE_ID.test(value.pipelineId)
    && typeof value.stage === "string" && EVIDENCE_PIPELINE_STAGES.includes(value.stage as EvidencePipelineStage)
    && value.handlerVersion === EVIDENCE_PIPELINE_HANDLER_VERSION
    && typeof value.jobId === "string" && /^job-[a-f0-9]{64}$/.test(value.jobId)
    && typeof value.idempotencyKey === "string" && value.idempotencyKey === evidenceStageIdempotencyKey(value.pipelineId, value.stage as EvidencePipelineStage)
    && typeof value.attemptStartedAt === "string" && Number.isFinite(Date.parse(value.attemptStartedAt))
    && typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.completedAt))
    && ["completed", "skipped", "needs_review", "blocked"].includes(String(value.status))
    && Array.isArray(value.inputRefs) && value.inputRefs.every((ref) => typeof ref === "string" && ARTIFACT_REF.test(ref))
    && new Set(value.inputRefs).size === value.inputRefs.length
    && Array.isArray(value.resultRefs) && value.resultRefs.every((ref) => typeof ref === "string" && ref.length > 0)
    && new Set(value.resultRefs).size === value.resultRefs.length
    && finiteJson(value.output)
    && (value.officialSearchReason === undefined
      || EVIDENCE_OFFICIAL_SEARCH_REASONS.includes(value.officialSearchReason as EvidenceOfficialSearchReason));
}

export function assertEvidenceStageEffectResult(value: unknown): asserts value is EvidenceStageEffectResult {
  if (!record(value) || Object.keys(value).some((key) => !["status", "output", "resultRefs", "officialSearchReason"].includes(key))
    || !["completed", "skipped", "needs_review", "blocked"].includes(String(value.status))
    || !record(value.output) || !finiteJson(value.output)
    || (value.resultRefs !== undefined && (!Array.isArray(value.resultRefs)
      || value.resultRefs.some((ref) => typeof ref !== "string" || !ref) || new Set(value.resultRefs).size !== value.resultRefs.length))
    || (value.officialSearchReason !== undefined
      && !EVIDENCE_OFFICIAL_SEARCH_REASONS.includes(value.officialSearchReason as EvidenceOfficialSearchReason))) {
    throw new TypeError("evidence stage effect result is invalid");
  }
}
