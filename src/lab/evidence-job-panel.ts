import type {
  PlanEvidenceResolutionAuthority,
  PlanEvidenceResolutionState,
  PlanEvidenceResolutionSummary,
} from "../plans/contracts";
import { PLAN_EVIDENCE_RESOLUTION_SUMMARY_SCHEMA_VERSION } from "../plans/contracts";

const PIPELINE_ID = /^evidence-pipeline-sha256-([a-f0-9]{64})$/;
const JOB_ID = /^job-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_REF = /^sha256:[a-f0-9]{64}$/;
const SEARCH_OUTCOME_ID = /^search-outcome-sha256-([a-f0-9]{64})$/;
const OFFICIAL_CONFIRMATION_ID = /^official-confirmation-sha256-([a-f0-9]{64})$/;
const THIRD_PARTY_SOURCE_ID = /^third-party-source-sha256-([a-f0-9]{64})$/;
const THIRD_PARTY_ASSESSMENT_ID = /^third-party-assessment-sha256-([a-f0-9]{64})$/;
const INFERENCE_ID = /^inference-sha256-([a-f0-9]{64})$/;
const STORAGE_KEY = "build-sim:evidence-job-tracking:v1";

export const EVIDENCE_JOB_STAGES = Object.freeze([
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

export type EvidenceJobStage = (typeof EVIDENCE_JOB_STAGES)[number];

const JOB_STATUSES = Object.freeze([
  "queued", "running", "waiting_user", "waiting_retry", "paused_offline", "paused_restore_review",
  "succeeded", "failed", "cancelled", "dead_letter",
] as const);
type EvidenceJobStatus = (typeof JOB_STATUSES)[number];

const RESULT_STATUSES = Object.freeze(["completed", "skipped", "needs_review", "blocked"] as const);
type EvidenceResultStatus = (typeof RESULT_STATUSES)[number];

export const EVIDENCE_SEARCH_REASONS = Object.freeze([
  "official_not_published",
  "official_page_found_field_missing",
  "official_identity_unresolved",
  "official_access_blocked",
  "official_parse_failed",
  "official_sources_conflict",
  "official_search_exhausted",
] as const);

export type EvidenceSearchReason = (typeof EVIDENCE_SEARCH_REASONS)[number];

export const EVIDENCE_SEARCH_REASON_COPY: Readonly<Record<EvidenceSearchReason, {
  label: string;
  explanation: string;
  action: string;
}>> = Object.freeze({
  official_not_published: {
    label: "官网尚未发布",
    explanation: "已检查的官网范围没有发布这项资料，不能把缺失理解为肯定或否定。",
    action: "确认精确型号与修订版，或等待厂商发布并再次检索。",
  },
  official_page_found_field_missing: {
    label: "找到官网页面，但缺少目标字段",
    explanation: "官网原文已找到，当前受控摘录中没有请求的字段，因此该字段仍是未知。",
    action: "补充准确页码或章节，或由人工核对已归档原文。",
  },
  official_identity_unresolved: {
    label: "官网身份未能精确对应",
    explanation: "来源可能属于厂商，但正文没有闭合到目标型号、变体、修订版或地区。",
    action: "核对机身标签、MPN、修订版和地区，再提供精确官网入口。",
  },
  official_access_blocked: {
    label: "官网访问受阻",
    explanation: "官网页面受到验证码、权限或访问限制，系统没有把无法读取的页面当作证据。",
    action: "稍后重试，或由用户归档可公开访问的官方文件。",
  },
  official_parse_failed: {
    label: "官网原文解析失败",
    explanation: "原文可能已归档，但当前解析器无法可靠读取目标内容，系统没有猜测结果。",
    action: "提供可读取的 PDF/文本版本，或使用经过批准的受限 OCR 适配器。",
  },
  official_sources_conflict: {
    label: "多个官网来源互相冲突",
    explanation: "至少两个官网证据给出不一致信息，在明确修订版和适用范围前不能选一个当确定值。",
    action: "核对各文档日期、修订版、地区和勘误，并提交人工冲突决策。",
  },
  official_search_exhausted: {
    label: "官网检索范围已用尽",
    explanation: "已完成配置的官网检索路径，但没有形成可用的精确证据。",
    action: "补充官方 URL、精确身份或新检索线索后重新运行。",
  },
});

const STAGE_COPY: Readonly<Record<EvidenceJobStage, string>> = Object.freeze({
  official_discovery: "发现官网资料",
  official_acquisition: "获取官网原文",
  archive: "归档原始字节",
  parse_ocr: "解析 / OCR",
  excerpt: "生成有界摘录",
  claim_extraction: "提取候选事实",
  third_party_fallback: "第三方补证",
  fact_impact: "分析事实影响",
  adapter_generation: "生成适配器候选",
  binding_proposal: "生成绑定提案",
});

const JOB_STATUS_COPY: Readonly<Record<EvidenceJobStatus, string>> = Object.freeze({
  queued: "已排队",
  running: "正在运行",
  waiting_user: "等待人工处理",
  waiting_retry: "等待重试",
  paused_offline: "离线暂停",
  paused_restore_review: "恢复后待复核",
  succeeded: "阶段已执行",
  failed: "执行失败",
  cancelled: "已取消",
  dead_letter: "重试耗尽",
});

const RESULT_STATUS_COPY: Readonly<Record<EvidenceResultStatus, string>> = Object.freeze({
  completed: "本阶段形成受治理输出",
  skipped: "本阶段跳过",
  needs_review: "需要人工复核，结论仍未知",
  blocked: "被阻断，不能形成确定值",
});

const LADDER_COPY = Object.freeze({
  1: "第 1 级 · 精确修订版官网文档",
  2: "第 2 级 · 精确型号官网技术资料",
  3: "第 3 级 · 已证明字段不变的官网系列资料",
  4: "第 4 级 · 单一专业第三方测量（低置信）",
  5: "第 5 级 · 两个以上真正独立且一致的第三方原始来源",
  6: "第 6 级 · 可重放 Agent 推断",
} as const);

interface ParsedEvidenceResult {
  status: EvidenceResultStatus;
  output: Record<string, unknown>;
  resultRefs: `sha256:${string}`[];
  officialSearchReason?: EvidenceSearchReason;
}

interface ParsedEvidenceStage {
  stage: EvidenceJobStage;
  jobId: string;
  status: EvidenceJobStatus;
  revision: number;
  attempt: number;
  maxAttempts: number;
  runAfter: string;
  progress?: { stage: string; completed: number; total?: number };
  lastError?: { code: string; message: string };
  result?: ParsedEvidenceResult;
}

interface LadderResolution {
  level: 1 | 2 | 3 | 4 | 5 | 6 | null;
  authority: PlanEvidenceResolutionAuthority;
  key: PlanEvidenceResolutionSummary["ladder"]["key"];
}

interface SearchOutcomeView {
  reason: EvidenceSearchReason;
  attemptRefs: `sha256:${string}`[];
  officialEvidenceRefs: `sha256:${string}`[];
  manualAction: string | null;
}

interface ThirdPartySourceView {
  sourceId: `third-party-source-sha256-${string}`;
  publisherId: string;
  sourceType: string;
  contentHash: string;
}

type ThirdPartyAssessmentBase = Omit<NonNullable<PlanEvidenceResolutionSummary["thirdParty"]>, "sources">;

interface ThirdPartyView {
  assessment?: NonNullable<PlanEvidenceResolutionSummary["thirdParty"]>;
  sources: ThirdPartySourceView[];
  artifactRefs: `sha256:${string}`[];
}

interface InferenceView extends NonNullable<PlanEvidenceResolutionSummary["inference"]> {
  assumptions: string[];
  invalidationConditions: string[];
  confidence: number;
}

type ApprovalCandidate = NonNullable<PlanEvidenceResolutionSummary["candidates"]>[number];

export interface ParsedEvidenceJobStatus {
  pipelineId: PlanEvidenceResolutionSummary["pipelineId"];
  requestHash: string;
  planId?: string;
  stages: ParsedEvidenceStage[];
  state: PlanEvidenceResolutionState;
  ladder: LadderResolution;
  searchOutcomes: SearchOutcomeView[];
  thirdParty: ThirdPartyView;
  inference?: InferenceView;
  candidates: ApprovalCandidate[];
  summary: PlanEvidenceResolutionSummary;
}

export interface EvidenceJobPanelApi {
  status(pipelineId: string): Promise<unknown>;
  cancel(pipelineId: string, stage: EvidenceJobStage, expectedRevision: number): Promise<unknown>;
  resume(pipelineId: string, stage: EvidenceJobStage, expectedRevision: number): Promise<unknown>;
}

export interface EvidenceJobPanelController {
  track(pipelineId: string): Promise<void>;
  refresh(): Promise<void>;
  resolutionSummaries(): readonly PlanEvidenceResolutionSummary[];
  dispose(): void;
}

export interface EvidenceJobPanelOptions {
  getPlanId(): string | null;
  subscribePlan?: (listener: () => void) => () => void;
  api?: EvidenceJobPanelApi;
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** Set to 0 in deterministic tests. */
  pollIntervalMs?: number;
}

export class EvidenceJobPanelApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "EvidenceJobPanelApiError";
  }
}

export class WorkspaceEvidenceJobClient implements EvidenceJobPanelApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly base = "/api/workspace/evidence-jobs") {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl.call(globalThis, `${this.base}${path}`, {
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      ...init,
    });
    const body = await response.json().catch(() => ({ error: "invalid_response", message: "证据任务服务返回了无效 JSON" }));
    if (!response.ok) {
      const error = record(body);
      throw new EvidenceJobPanelApiError(response.status, boundedText(error?.error, 160) ?? "request_failed", boundedText(error?.message, 500) ?? `HTTP ${response.status}`);
    }
    return body;
  }

  status(pipelineId: string): Promise<unknown> {
    return this.request(`/${encodeURIComponent(assertPipelineId(pipelineId))}`);
  }

  cancel(pipelineId: string, stage: EvidenceJobStage, expectedRevision: number): Promise<unknown> {
    return this.request(`/${encodeURIComponent(assertPipelineId(pipelineId))}/cancel`, {
      method: "POST",
      body: JSON.stringify({ stage: assertStage(stage), expectedRevision: assertRevision(expectedRevision) }),
    });
  }

  resume(pipelineId: string, stage: EvidenceJobStage, expectedRevision: number): Promise<unknown> {
    return this.request(`/${encodeURIComponent(assertPipelineId(pipelineId))}/resume`, {
      method: "POST",
      body: JSON.stringify({ stage: assertStage(stage), expectedRevision: assertRevision(expectedRevision) }),
    });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, maximum = 1_000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function contentRefs(value: unknown, maximum = 128): `sha256:${string}`[] {
  if (!Array.isArray(value) || value.length > maximum) return [];
  return [...new Set(value.filter((ref): ref is `sha256:${string}` => typeof ref === "string" && CONTENT_REF.test(ref)))];
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const parsed: string[] = [];
  for (const item of value) {
    const text = boundedText(item, maximumLength);
    if (text === null) return null;
    parsed.push(text);
  }
  return [...new Set(parsed)];
}

function isSearchReason(value: unknown): value is EvidenceSearchReason {
  return typeof value === "string" && (EVIDENCE_SEARCH_REASONS as readonly string[]).includes(value);
}

function isJobStatus(value: unknown): value is EvidenceJobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

function isResultStatus(value: unknown): value is EvidenceResultStatus {
  return typeof value === "string" && (RESULT_STATUSES as readonly string[]).includes(value);
}

function assertPipelineId(value: string): string {
  if (!PIPELINE_ID.test(value)) throw new TypeError("证据任务 ID 无效");
  return value;
}

function assertStage(value: string): EvidenceJobStage {
  if (!(EVIDENCE_JOB_STAGES as readonly string[]).includes(value)) throw new TypeError("证据任务阶段无效");
  return value as EvidenceJobStage;
}

function assertRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("证据任务 revision 无效");
  return value;
}

function parseResult(value: unknown, pipelineId: string, stage: EvidenceJobStage): ParsedEvidenceResult {
  const result = record(value);
  if (!result) throw new TypeError(`证据阶段 ${stage} 的结果契约无效`);
  if (result.schemaVersion !== "evidence-stage-result-v1" || result.pipelineId !== pipelineId || result.stage !== stage
    || !isResultStatus(result.status) || !record(result.output)) throw new TypeError(`证据阶段 ${stage} 的结果契约无效`);
  const resultRefs = contentRefs(result.resultRefs, 128);
  if (!Array.isArray(result.resultRefs) || resultRefs.length !== result.resultRefs.length) throw new TypeError(`证据阶段 ${stage} 的结果引用无效`);
  if (result.officialSearchReason !== undefined && !isSearchReason(result.officialSearchReason)) throw new TypeError(`证据阶段 ${stage} 的官网原因无效`);
  return {
    status: result.status,
    output: result.output as Record<string, unknown>,
    resultRefs,
    ...(isSearchReason(result.officialSearchReason) ? { officialSearchReason: result.officialSearchReason } : {}),
  };
}

function parseStage(value: unknown, pipelineId: string, expectedStage: EvidenceJobStage): ParsedEvidenceStage {
  const stage = record(value);
  if (!stage || stage.stage !== expectedStage || typeof stage.jobId !== "string" || !JOB_ID.test(stage.jobId)
    || !isJobStatus(stage.status) || !Number.isSafeInteger(stage.revision) || Number(stage.revision) < 0
    || !Number.isSafeInteger(stage.attempt) || Number(stage.attempt) < 0
    || !Number.isSafeInteger(stage.maxAttempts) || Number(stage.maxAttempts) < 1 || Number(stage.attempt) > Number(stage.maxAttempts)
    || typeof stage.runAfter !== "string" || !Number.isFinite(Date.parse(stage.runAfter))) {
    throw new TypeError(`证据阶段 ${expectedStage} 的状态契约无效`);
  }
  const progress = record(stage.progress);
  const parsedProgress = progress && boundedText(progress.stage, 160) !== null
    && typeof progress.completed === "number" && Number.isFinite(progress.completed) && progress.completed >= 0
    && (progress.total === undefined || (typeof progress.total === "number" && Number.isFinite(progress.total) && progress.total >= progress.completed))
    ? { stage: boundedText(progress.stage, 160)!, completed: progress.completed, ...(typeof progress.total === "number" ? { total: progress.total } : {}) }
    : undefined;
  const lastError = record(stage.lastError);
  const parsedError = lastError?.redacted === true && boundedText(lastError.code, 160) && boundedText(lastError.message, 500)
    ? { code: boundedText(lastError.code, 160)!, message: boundedText(lastError.message, 500)! }
    : undefined;
  return {
    stage: expectedStage,
    jobId: stage.jobId,
    status: stage.status,
    revision: stage.revision as number,
    attempt: stage.attempt as number,
    maxAttempts: stage.maxAttempts as number,
    runAfter: stage.runAfter,
    ...(parsedProgress ? { progress: parsedProgress } : {}),
    ...(parsedError ? { lastError: parsedError } : {}),
    ...(stage.result === undefined ? {} : { result: parseResult(stage.result, pipelineId, expectedStage) }),
  };
}

function unresolvedLadder(): LadderResolution {
  return { level: null, authority: null, key: "unresolved" };
}

function officialLadder(stage: ParsedEvidenceStage): LadderResolution {
  if (stage.stage !== "claim_extraction" || stage.result?.status !== "completed") return unresolvedLadder();
  const output = stage.result.output;
  const promotion = record(output.officialPromotion);
  const promotionInput = record(output.officialPromotionInput);
  const confirmation = record(promotionInput?.confirmation);
  const identity = record(promotion?.identity);
  const confirmationMatch = typeof promotion?.confirmationId === "string" ? OFFICIAL_CONFIRMATION_ID.exec(promotion.confirmationId) : null;
  if (!promotion || promotion.eligible !== true || promotion.authority !== "official" || promotion.kindBasis !== "content-verified"
    || identity?.basis !== "official-document-explicit" || promotionInput?.registryTrust !== "trusted"
    || !confirmationMatch || promotion.confirmationId !== confirmation?.confirmationId
    || confirmationMatch[1] !== confirmation?.contentHash) return unresolvedLadder();
  const scope = promotionInput.requiredScope;
  const kind = confirmation?.pageKind;
  if (scope === "revision" && ["manual", "errata", "support", "qvl", "firmware"].includes(String(kind))) {
    return { level: 1, authority: "official", key: "official_exact_revision_document" };
  }
  if (["model", "variant", "revision"].includes(String(scope)) && ["technical_specification", "product"].includes(String(kind))) {
    return { level: 2, authority: "official", key: "official_exact_model_technical" };
  }
  if (scope === "family" && promotionInput.fieldInvariant === true) {
    return { level: 3, authority: "official", key: "official_family_invariant" };
  }
  return unresolvedLadder();
}

function parseSearchOutcome(output: Record<string, unknown>, fallback?: EvidenceSearchReason): SearchOutcomeView | null {
  const outcome = record(output.searchOutcome);
  if (!outcome) return fallback ? { reason: fallback, attemptRefs: [], officialEvidenceRefs: [], manualAction: boundedText(output.manualAction) } : null;
  const idMatch = typeof outcome.searchOutcomeId === "string" ? SEARCH_OUTCOME_ID.exec(outcome.searchOutcomeId) : null;
  if (outcome.schemaVersion !== "evidence-search-outcome-v1" || !idMatch || !SHA256.test(String(outcome.contentHash))
    || idMatch[1] !== outcome.contentHash || !isSearchReason(outcome.reason)) return null;
  const attemptRefs = contentRefs(outcome.searchAttemptRefs);
  const officialEvidenceRefs = contentRefs(outcome.officialEvidenceRefs);
  if (!Array.isArray(outcome.searchAttemptRefs) || attemptRefs.length !== outcome.searchAttemptRefs.length
    || !Array.isArray(outcome.officialEvidenceRefs) || officialEvidenceRefs.length !== outcome.officialEvidenceRefs.length) return null;
  return {
    reason: outcome.reason,
    attemptRefs,
    officialEvidenceRefs,
    manualAction: boundedText(outcome.manualAction) ?? boundedText(output.manualAction),
  };
}

function parseThirdPartySource(value: unknown): ThirdPartySourceView | null {
  const source = record(value);
  const idMatch = typeof source?.sourceId === "string" ? THIRD_PARTY_SOURCE_ID.exec(source.sourceId) : null;
  if (!source || source.schemaVersion !== "third-party-evidence-source-v1" || source.authority !== "third_party"
    || !idMatch || typeof source.contentHash !== "string" || !SHA256.test(source.contentHash) || idMatch[1] !== source.contentHash
    || !boundedText(source.publisherId, 256) || !boundedText(source.sourceType, 160)) return null;
  return {
    sourceId: source.sourceId as `third-party-source-sha256-${string}`,
    publisherId: boundedText(source.publisherId, 256)!,
    sourceType: boundedText(source.sourceType, 160)!,
    contentHash: source.contentHash,
  };
}

function parseThirdPartyAssessment(value: unknown): ThirdPartyAssessmentBase | undefined {
  const assessment = record(value);
  const idMatch = typeof assessment?.assessmentId === "string" ? THIRD_PARTY_ASSESSMENT_ID.exec(assessment.assessmentId) : null;
  if (!assessment || assessment.schemaVersion !== "third-party-independence-assessment-v1" || assessment.authority !== "third_party"
    || !idMatch || !SHA256.test(String(assessment.contentHash)) || idMatch[1] !== assessment.contentHash
    || !Array.isArray(assessment.sourceIds) || assessment.sourceIds.length > 128
    || assessment.sourceIds.some((id) => typeof id !== "string" || !THIRD_PARTY_SOURCE_ID.test(id))
    || new Set(assessment.sourceIds).size !== assessment.sourceIds.length
    || !Number.isSafeInteger(assessment.independentCount) || Number(assessment.independentCount) < 0
    || typeof assessment.consistent !== "boolean" || typeof assessment.conflicted !== "boolean"
    || ![null, 4, 5].includes(assessment.ladderLevel as null | number)) return undefined;
  const sourceIds = assessment.sourceIds as `third-party-source-sha256-${string}`[];
  const independentCount = assessment.independentCount as number;
  const ladderLevel = assessment.ladderLevel as 4 | 5 | null;
  if (assessment.conflicted !== (independentCount >= 2 && !assessment.consistent)
    || (ladderLevel === 4 && (independentCount !== 1 || assessment.consistent !== true || assessment.conflicted === true))
    || (ladderLevel === 5 && (independentCount < 2 || assessment.consistent !== true || assessment.conflicted === true))) return undefined;
  return {
    assessmentId: assessment.assessmentId as `third-party-assessment-sha256-${string}`,
    contentHash: assessment.contentHash as string,
    sourceIds: [...sourceIds],
    independentCount,
    consistent: assessment.consistent,
    conflicted: assessment.conflicted,
    ladderLevel,
  };
}

function thirdPartyFor(stage: ParsedEvidenceStage): ThirdPartyView {
  if (stage.stage !== "third_party_fallback" || !stage.result) return { sources: [], artifactRefs: [] };
  const output = stage.result.output;
  const sourceValues = Array.isArray(output.thirdPartySources) && output.thirdPartySources.length <= 128 ? output.thirdPartySources : [];
  const sources = sourceValues.map(parseThirdPartySource).filter((source): source is ThirdPartySourceView => source !== null);
  const artifactRefs = contentRefs(output.thirdPartyArtifactRefs);
  const assessmentBase = parseThirdPartyAssessment(output.independenceAssessment);
  const assessment = assessmentBase && sources.length === assessmentBase.sourceIds.length
    && sources.every((source) => assessmentBase.sourceIds.includes(source.sourceId))
    && (assessmentBase.ladderLevel === null || sources.some((source) => source.sourceType === "professional_measurement"))
    ? { ...assessmentBase, sources: structuredClone(sources) }
    : undefined;
  return { ...(assessment ? { assessment } : {}), sources, artifactRefs };
}

function thirdPartyLadder(stage: ParsedEvidenceStage, view: ThirdPartyView): LadderResolution {
  if (stage.stage !== "third_party_fallback" || stage.result?.status !== "completed" || !view.assessment) return unresolvedLadder();
  if (view.assessment.ladderLevel === 4) return { level: 4, authority: "third_party", key: "third_party_professional_measurement" };
  if (view.assessment.ladderLevel === 5) return { level: 5, authority: "third_party", key: "third_party_independent_corroboration" };
  return unresolvedLadder();
}

function parseInference(value: unknown, formulaValue?: unknown): InferenceView | undefined {
  const trace = record(value);
  const idMatch = typeof trace?.inferenceTraceId === "string" ? INFERENCE_ID.exec(trace.inferenceTraceId) : null;
  if (!trace || trace.schemaVersion !== "fact-inference-v1" || !idMatch || !SHA256.test(String(trace.contentHash)) || idMatch[1] !== trace.contentHash
    || !boundedText(trace.ruleOrModelId, 256) || !boundedText(trace.ruleOrModelVersion, 256) || !SHA256.test(String(trace.ruleOrModelArtifactHash))
    || !Array.isArray(trace.inputFactRefs) || trace.inputFactRefs.length === 0 || trace.inputFactRefs.length > 128
    || typeof trace.confidence !== "number" || !Number.isFinite(trace.confidence) || trace.confidence < 0 || trace.confidence > 1) return undefined;
  const inputFactRefs: { factId: string; contentHash: string }[] = [];
  for (const candidate of trace.inputFactRefs) {
    const ref = record(candidate);
    const factId = boundedText(ref?.factId, 256);
    if (!ref || !factId || !SHA256.test(String(ref.contentHash))) return undefined;
    inputFactRefs.push({ factId, contentHash: ref.contentHash as string });
  }
  const assumptions = stringArray(trace.assumptions, 128, 1_024);
  const invalidationConditions = stringArray(trace.invalidationConditions, 128, 1_024);
  if (!assumptions || !invalidationConditions || invalidationConditions.length === 0) return undefined;
  const range = record(trace.outputRange);
  const outputRange = range && typeof range.min === "number" && Number.isFinite(range.min)
    && typeof range.max === "number" && Number.isFinite(range.max) && range.min <= range.max
    && (range.unit === undefined || boundedText(range.unit, 64))
    ? { min: range.min, max: range.max, ...(range.unit === undefined ? {} : { unit: boundedText(range.unit, 64)! }) }
    : undefined;
  if (trace.outputRange !== undefined && !outputRange) return undefined;
  return {
    inferenceTraceId: trace.inferenceTraceId as `inference-sha256-${string}`,
    contentHash: trace.contentHash as string,
    ruleOrModelId: boundedText(trace.ruleOrModelId, 256)!,
    ruleOrModelVersion: boundedText(trace.ruleOrModelVersion, 256)!,
    ruleOrModelArtifactHash: trace.ruleOrModelArtifactHash as string,
    formula: boundedText(formulaValue ?? trace.formula, 1_024),
    inputFactRefs,
    assumptionCount: assumptions.length,
    assumptions,
    ...(outputRange ? { outputRange } : {}),
    invalidationConditionCount: invalidationConditions.length,
    invalidationConditions,
    confidence: trace.confidence,
  };
}

function inferenceFor(stage: ParsedEvidenceStage): InferenceView | undefined {
  if (stage.result?.status !== "completed") return undefined;
  const output = stage.result.output;
  const formula = output.inferenceFormula ?? output.formula ?? record(output.inferenceExplanation)?.formula;
  return parseInference(output.inferenceTrace, formula) ?? parseInference(output.inference, formula)
    ?? (output.schemaVersion === "fact-inference-v1" ? parseInference(output, formula) : undefined);
}

function inferenceLadder(inference: InferenceView | undefined): LadderResolution {
  return inference ? { level: 6, authority: "agent_inference", key: "agent_replayable_inference" } : unresolvedLadder();
}

function approvalCandidate(kind: ApprovalCandidate["kind"], id: unknown, contentHash: unknown): ApprovalCandidate | null {
  const match = typeof id === "string" ? /^[a-z][a-z0-9-]*-sha256-([a-f0-9]{64})$/.exec(id) : null;
  if (!match || typeof contentHash !== "string" || !SHA256.test(contentHash) || match[1] !== contentHash) return null;
  return { kind, id: id as string, contentHash };
}

function candidatesFor(stage: ParsedEvidenceStage): ApprovalCandidate[] {
  if (!stage.result) return [];
  const output = stage.result.output;
  const values: ApprovalCandidate[] = [];
  const append = (candidate: ApprovalCandidate | null) => { if (candidate && !values.some((row) => row.kind === candidate.kind && row.id === candidate.id)) values.push(candidate); };
  const governedRefs = Array.isArray(output.candidateRefs) && output.candidateRefs.length <= 128 ? output.candidateRefs : [];
  for (const value of governedRefs) {
    const row = record(value);
    const kind = row?.kind;
    if (row && (kind === "claim_candidate" || kind === "adapter_candidate" || kind === "binding_proposal")) append(approvalCandidate(kind, row.id, row.contentHash));
  }
  if (stage.stage === "claim_extraction") {
    append(approvalCandidate("claim_candidate", output.claimCandidateId, output.claimCandidateHash ?? output.contentHash));
    const candidates = Array.isArray(output.claimCandidates) && output.claimCandidates.length <= 128 ? output.claimCandidates : [];
    for (const value of candidates) {
      const row = record(value);
      append(approvalCandidate("claim_candidate", row?.claimCandidateId ?? row?.claimId, row?.claimCandidateHash ?? row?.contentHash));
    }
  }
  if (stage.stage === "adapter_generation") {
    append(approvalCandidate("adapter_candidate", output.adapterCandidateId ?? output.candidateId, output.adapterCandidateHash ?? output.contentHash));
    const candidate = record(output.adapterCandidate ?? output.candidate);
    append(approvalCandidate("adapter_candidate", candidate?.adapterCandidateId ?? candidate?.candidateId, candidate?.adapterCandidateHash ?? candidate?.contentHash));
  }
  if (stage.stage === "binding_proposal") {
    append(approvalCandidate("binding_proposal", output.bindingProposalId ?? output.proposalId, output.bindingProposalHash ?? output.contentHash));
    const candidate = record(output.bindingProposal ?? output.proposal);
    append(approvalCandidate("binding_proposal", candidate?.bindingProposalId ?? candidate?.proposalId, candidate?.bindingProposalHash ?? candidate?.contentHash));
  }
  return values;
}

function strongestLadder(ladders: readonly LadderResolution[]): LadderResolution {
  return ladders.filter((candidate) => candidate.level !== null).sort((left, right) => Number(left.level) - Number(right.level))[0] ?? unresolvedLadder();
}

function resolutionState(stages: readonly ParsedEvidenceStage[], ladder: LadderResolution): PlanEvidenceResolutionState {
  if (stages.some((stage) => stage.status === "dead_letter" || stage.status === "failed")) return "failed";
  if (stages.some((stage) => stage.result?.status === "blocked")) return "blocked";
  if (stages.some((stage) => stage.result?.status === "needs_review" || stage.status === "waiting_user")) return "needs_review";
  if (stages.some((stage) => stage.status === "cancelled")) return "cancelled";
  if (stages.some((stage) => ["queued", "running", "waiting_retry", "paused_offline", "paused_restore_review"].includes(stage.status))) return "in_progress";
  if (stages.every((stage) => stage.status === "succeeded") && ladder.level !== null) return "resolved";
  return "unknown";
}

export function parseEvidenceJobStatus(value: unknown): ParsedEvidenceJobStatus {
  const payload = record(value);
  const pipelineId = typeof payload?.pipelineId === "string" ? payload.pipelineId : "";
  const pipelineMatch = PIPELINE_ID.exec(pipelineId);
  if (!payload || !pipelineMatch || !SHA256.test(String(payload.requestHash)) || pipelineMatch[1] !== payload.requestHash
    || !Array.isArray(payload.stages) || payload.stages.length !== EVIDENCE_JOB_STAGES.length) {
    throw new TypeError("证据任务状态契约无效");
  }
  if (payload.planId !== undefined && !boundedText(payload.planId, 256)) throw new TypeError("证据任务方案绑定无效");
  const stagePayloads = payload.stages as unknown[];
  const stages = EVIDENCE_JOB_STAGES.map((stage, index) => parseStage(stagePayloads[index], pipelineId, stage));
  const searchOutcomes = stages.map((stage) => stage.result ? parseSearchOutcome(stage.result.output, stage.result.officialSearchReason) : null)
    .filter((outcome): outcome is SearchOutcomeView => outcome !== null);
  const thirdPartyStage = stages.find((stage) => stage.stage === "third_party_fallback")!;
  const thirdParty = thirdPartyFor(thirdPartyStage);
  const inferences = stages.map(inferenceFor).filter((inference): inference is InferenceView => inference !== undefined);
  const inference = inferences[0];
  const candidates = stages.flatMap(candidatesFor);
  const manualActions = [...new Set(stages.map(manualActionFor).filter((action): action is string => action !== null))];
  const ladder = strongestLadder([
    ...stages.map(officialLadder),
    thirdPartyLadder(thirdPartyStage, thirdParty),
    ...inferences.map(inferenceLadder),
  ]);
  const state = resolutionState(stages, ladder);
  const officialSearchReason = searchOutcomes.at(-1)?.reason;
  const officialAttemptRefs = [...new Set(searchOutcomes.flatMap((outcome) => outcome.attemptRefs))];
  const summary: PlanEvidenceResolutionSummary = {
    schemaVersion: PLAN_EVIDENCE_RESOLUTION_SUMMARY_SCHEMA_VERSION,
    pipelineId: pipelineId as PlanEvidenceResolutionSummary["pipelineId"],
    requestHash: payload.requestHash as string,
    state,
    ladder: { ...ladder },
    ...(officialSearchReason ? { officialSearchReason } : {}),
    officialAttemptRefs,
    ...(thirdParty.assessment ? { thirdParty: structuredClone(thirdParty.assessment) } : {}),
    ...(inference ? {
      inference: {
        inferenceTraceId: inference.inferenceTraceId,
        contentHash: inference.contentHash,
        ruleOrModelId: inference.ruleOrModelId,
        ruleOrModelVersion: inference.ruleOrModelVersion,
        ruleOrModelArtifactHash: inference.ruleOrModelArtifactHash,
        formula: inference.formula,
        inputFactRefs: structuredClone(inference.inputFactRefs),
        assumptionCount: inference.assumptionCount,
        assumptions: structuredClone(inference.assumptions),
        ...(inference.outputRange ? { outputRange: structuredClone(inference.outputRange) } : {}),
        invalidationConditionCount: inference.invalidationConditionCount,
        invalidationConditions: structuredClone(inference.invalidationConditions),
      },
    } : {}),
    manualActions,
    ...(candidates.length ? { candidates: structuredClone(candidates) } : {}),
    stages: stages.map((stage) => ({
      stage: stage.stage,
      jobStatus: stage.status,
      ...(stage.result ? { resultStatus: stage.result.status } : {}),
      revision: stage.revision,
      attempt: stage.attempt,
      maxAttempts: stage.maxAttempts,
      resultRefs: structuredClone(stage.result?.resultRefs ?? []),
    })),
  };
  return {
    pipelineId: summary.pipelineId,
    requestHash: summary.requestHash,
    ...(typeof payload.planId === "string" ? { planId: payload.planId } : {}),
    stages,
    state,
    ladder,
    searchOutcomes,
    thirdParty,
    ...(inference ? { inference } : {}),
    candidates,
    summary,
  };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function authorityCopy(authority: PlanEvidenceResolutionAuthority): string {
  if (authority === "official") return "权威：官网原文";
  if (authority === "third_party") return "权威：第三方（永不等同官网）";
  if (authority === "agent_inference") return "权威：Agent 可重放推断";
  return "权威：未解析";
}

function ladderCopy(ladder: LadderResolution): string {
  return ladder.level === null ? "证据阶梯：尚未成立" : `证据阶梯：${LADDER_COPY[ladder.level]}`;
}

function appendRefs(host: HTMLElement, title: string, refs: readonly string[]): void {
  const section = element("div", undefined, "workspace-evidence-job-refs");
  section.append(element("strong", title));
  if (!refs.length) section.append(element("span", "无内容寻址引用"));
  else {
    const list = element("ul");
    for (const ref of refs) list.append(element("li", ref));
    section.append(list);
  }
  host.append(section);
}

function appendSearchOutcome(host: HTMLElement, outcome: SearchOutcomeView): void {
  const copy = EVIDENCE_SEARCH_REASON_COPY[outcome.reason];
  const section = element("section", undefined, "workspace-evidence-job-official");
  section.dataset.officialSearchReason = outcome.reason;
  section.append(element("h5", `官网未找到原因：${copy.label}`));
  section.append(element("code", outcome.reason));
  section.append(element("p", copy.explanation));
  appendRefs(section, "官网尝试审计", outcome.attemptRefs);
  appendRefs(section, "官网证据引用", outcome.officialEvidenceRefs);
  section.append(element("p", `建议补证：${outcome.manualAction ?? copy.action}`, "workspace-evidence-job-action-copy"));
  host.append(section);
}

function appendThirdParty(host: HTMLElement, view: ThirdPartyView): void {
  if (!view.assessment && !view.sources.length && !view.artifactRefs.length) return;
  const section = element("section", undefined, "workspace-evidence-job-third-party");
  section.dataset.evidenceAuthority = "third_party";
  section.append(element("h5", "第三方证据（不会标记为 official）"));
  if (view.assessment) {
    const level = view.assessment.ladderLevel === null ? "尚未形成阶梯等级" : LADDER_COPY[view.assessment.ladderLevel];
    section.append(element("p", `${level} · 独立来源 ${view.assessment.independentCount} 个 · ${view.assessment.consistent ? "结果一致" : "结果不一致"}${view.assessment.conflicted ? " · 存在冲突" : ""}`));
    section.append(element("code", view.assessment.assessmentId));
  } else section.append(element("p", "尚无通过独立性闭环的第三方评估，不能渲染为确定值。"));
  if (view.sources.length) {
    const list = element("ul");
    for (const source of view.sources) list.append(element("li", `${source.publisherId} · ${source.sourceType} · ${source.sourceId}`));
    section.append(list);
  }
  appendRefs(section, "第三方归档引用", view.artifactRefs);
  host.append(section);
}

function appendInference(host: HTMLElement, inference: InferenceView): void {
  const section = element("section", undefined, "workspace-evidence-job-inference");
  section.dataset.evidenceAuthority = "agent_inference";
  section.append(element("h5", "可重放推断详情"));
  section.append(element("p", `规则 / 模型：${inference.ruleOrModelId}@${inference.ruleOrModelVersion} · 置信度 ${Math.round(inference.confidence * 100)}%`));
  section.append(element("p", `公式 / 推导：${inference.formula ?? "未声明；不得自行补造公式"}`));
  section.append(element("code", `规则工件 SHA-256 ${inference.ruleOrModelArtifactHash}`));
  const inputs = element("ul");
  for (const input of inference.inputFactRefs) inputs.append(element("li", `${input.factId} · SHA-256 ${input.contentHash}`));
  section.append(element("strong", "输入事实与哈希"), inputs);
  const assumptions = element("ul");
  if (!inference.assumptions.length) assumptions.append(element("li", "无额外假设"));
  else for (const assumption of inference.assumptions) assumptions.append(element("li", assumption));
  section.append(element("strong", "假设"), assumptions);
  if (inference.outputRange) section.append(element("p", `输出区间：${inference.outputRange.min} – ${inference.outputRange.max}${inference.outputRange.unit ? ` ${inference.outputRange.unit}` : ""}`));
  else section.append(element("p", "输出区间：未声明；不得显示为无误差的精确值。"));
  const invalidation = element("ul");
  for (const condition of inference.invalidationConditions) invalidation.append(element("li", condition));
  section.append(element("strong", "失效条件"), invalidation);
  host.append(section);
}

function appendCandidates(host: HTMLElement, candidates: readonly ApprovalCandidate[]): void {
  if (!candidates.length) return;
  const labels: Readonly<Record<ApprovalCandidate["kind"], string>> = {
    claim_candidate: "事实候选",
    adapter_candidate: "适配器候选",
    binding_proposal: "绑定提案",
  };
  const section = element("section", undefined, "workspace-evidence-job-candidates");
  section.append(element("h5", "待审批的服务端候选（尚未写入 active 事实）"));
  const list = element("ul");
  for (const candidate of candidates) list.append(element("li", `${labels[candidate.kind]}：${candidate.id} · SHA-256 ${candidate.contentHash}`));
  section.append(list);
  section.append(element("p", "下一步：先审批并归档精确官网候选，再使用服务端 claimCandidateId 提出事实更新；适配器与绑定提案也必须单独审批。"));
  host.append(section);
}

function manualActionFor(stage: ParsedEvidenceStage): string | null {
  const output = stage.result?.output;
  if (!output) return null;
  return boundedText(output.manualAction) ?? boundedText(record(output.searchOutcome)?.manualAction);
}

function stageLadder(stage: ParsedEvidenceStage): LadderResolution {
  const thirdParty = thirdPartyFor(stage);
  return strongestLadder([officialLadder(stage), thirdPartyLadder(stage, thirdParty), inferenceLadder(inferenceFor(stage))]);
}

function canCancel(status: EvidenceJobStatus): boolean {
  return ["queued", "running", "waiting_user", "waiting_retry", "paused_offline", "paused_restore_review"].includes(status);
}

function canResume(status: EvidenceJobStatus): boolean {
  return ["waiting_user", "waiting_retry", "paused_offline", "paused_restore_review"].includes(status);
}

function pipelineStateCopy(state: PlanEvidenceResolutionState): string {
  return ({
    in_progress: "任务进行中，尚无最终事实",
    resolved: "已有受治理证据阶梯；仍需按提案流程应用",
    needs_review: "需要人工复核，未知项不会变成确定值",
    blocked: "流水线被阻断，不能形成确定值",
    failed: "任务失败或重试耗尽",
    cancelled: "任务已取消",
    unknown: "任务已执行，但没有形成受治理证据阶梯",
  } as const)[state];
}

function readTracking(storage: EvidenceJobPanelOptions["storage"], planId: string): string[] {
  if (!storage) return [];
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    const root = record(value);
    const ids = root?.[planId];
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter((id): id is string => typeof id === "string" && PIPELINE_ID.test(id)))].slice(0, 20);
  } catch { return []; }
}

function writeTracking(storage: EvidenceJobPanelOptions["storage"], planId: string, ids: readonly string[]): void {
  if (!storage) return;
  try {
    const current = record(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}")) ?? {};
    const bounded = Object.fromEntries(Object.entries(current).filter(([key, value]) => boundedText(key, 256) && Array.isArray(value)).slice(0, 49));
    bounded[planId] = [...ids].slice(0, 20);
    storage.setItem(STORAGE_KEY, JSON.stringify(bounded));
  } catch { /* Storage failure cannot change the durable server job. */ }
}

export function mountEvidenceJobPanel(host: HTMLElement, options: EvidenceJobPanelOptions): EvidenceJobPanelController {
  const api = options.api ?? new WorkspaceEvidenceJobClient();
  const storage = options.storage ?? globalThis.localStorage;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000) throw new TypeError("evidence job poll interval is invalid");
  let planId: string | null = null;
  let tracked: string[] = [];
  const statuses = new Map<string, ParsedEvidenceJobStatus>();
  const errors = new Map<string, string>();
  const pending = new Set<string>();
  let refreshBusy = false;
  let disposed = false;
  let panelError = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedulePoll = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (disposed || pollIntervalMs === 0 || ![...statuses.values()].some((status) => status.state === "in_progress")) return;
    timer = setTimeout(() => { void refreshAll(); }, pollIntervalMs);
  };

  const renderStage = (pipeline: ParsedEvidenceJobStatus, stage: ParsedEvidenceStage): HTMLElement => {
    const card = element("article", undefined, "workspace-evidence-job-stage");
    card.dataset.evidenceJobStage = stage.stage;
    card.dataset.jobStatus = stage.status;
    const header = element("header");
    const title = element("div");
    title.append(element("small", `阶段 ${EVIDENCE_JOB_STAGES.indexOf(stage.stage) + 1} / ${EVIDENCE_JOB_STAGES.length}`), element("strong", STAGE_COPY[stage.stage]));
    header.append(title, element("span", JOB_STATUS_COPY[stage.status]));
    card.append(header);
    card.append(element("p", `attempt ${stage.attempt}/${stage.maxAttempts} · revision ${stage.revision} · ${new Date(stage.runAfter).toLocaleString("zh-CN")}`));
    if (stage.progress) card.append(element("p", `进度：${stage.progress.stage} ${stage.progress.completed}${stage.progress.total === undefined ? "" : `/${stage.progress.total}`}`));
    const ladder = stageLadder(stage);
    const ladderLine = element("p", `${ladderCopy(ladder)} · ${authorityCopy(ladder.authority)}`, "workspace-evidence-job-ladder");
    ladderLine.dataset.ladderLevel = ladder.level === null ? "unresolved" : String(ladder.level);
    ladderLine.dataset.evidenceAuthority = ladder.authority ?? "unresolved";
    card.append(ladderLine);
    if (stage.result) {
      const result = element("p", RESULT_STATUS_COPY[stage.result.status]);
      result.dataset.resultStatus = stage.result.status;
      card.append(result);
      const outcome = parseSearchOutcome(stage.result.output, stage.result.officialSearchReason);
      if (outcome) appendSearchOutcome(card, outcome);
      appendThirdParty(card, thirdPartyFor(stage));
      const inference = inferenceFor(stage);
      if (inference) appendInference(card, inference);
      appendCandidates(card, candidatesFor(stage));
      const manualAction = manualActionFor(stage);
      if (manualAction && !outcome?.manualAction) card.append(element("p", `建议补证：${manualAction}`, "workspace-evidence-job-action-copy"));
      appendRefs(card, "阶段结果引用", stage.result.resultRefs);
    }
    if (stage.lastError) {
      const alert = element("p", `${stage.lastError.code}：${stage.lastError.message}`, "workspace-evidence-job-error");
      alert.setAttribute("role", "alert");
      card.append(alert);
    }
    const actions = element("footer");
    if (canCancel(stage.status)) {
      const button = element("button", "取消此阶段");
      button.type = "button";
      button.dataset.evidenceJobAction = "cancel";
      button.dataset.pipelineId = pipeline.pipelineId;
      button.dataset.stage = stage.stage;
      button.disabled = pending.has(`${pipeline.pipelineId}:${stage.stage}`);
      actions.append(button);
    }
    if (canResume(stage.status)) {
      const button = element("button", "按当前 revision 恢复");
      button.type = "button";
      button.dataset.evidenceJobAction = "resume";
      button.dataset.pipelineId = pipeline.pipelineId;
      button.dataset.stage = stage.stage;
      button.disabled = pending.has(`${pipeline.pipelineId}:${stage.stage}`);
      actions.append(button);
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  };

  const renderPipeline = (pipeline: ParsedEvidenceJobStatus): HTMLElement => {
    const article = element("article", undefined, "workspace-evidence-job-pipeline");
    article.dataset.evidencePipelineId = pipeline.pipelineId;
    article.dataset.resolutionState = pipeline.state;
    const header = element("header");
    const title = element("div");
    title.append(element("small", "持久证据流水线"), element("strong", pipeline.pipelineId));
    const remove = element("button", "不再跟踪");
    remove.type = "button";
    remove.dataset.evidenceJobAction = "untrack";
    remove.dataset.pipelineId = pipeline.pipelineId;
    header.append(title, remove);
    article.append(header);
    const state = element("p", pipelineStateCopy(pipeline.state), "workspace-evidence-job-resolution");
    state.dataset.resolutionState = pipeline.state;
    article.append(state);
    const ladder = element("p", `${ladderCopy(pipeline.ladder)} · ${authorityCopy(pipeline.ladder.authority)}`, "workspace-evidence-job-ladder");
    ladder.dataset.ladderLevel = pipeline.ladder.level === null ? "unresolved" : String(pipeline.ladder.level);
    ladder.dataset.evidenceAuthority = pipeline.ladder.authority ?? "unresolved";
    article.append(ladder);
    const officialSummary = element("section", undefined, "workspace-evidence-job-summary");
    officialSummary.append(element("h4", "官网检索审计"));
    if (!pipeline.searchOutcomes.length) officialSummary.append(element("p", "尚无官网终止原因；官网权威仍未成立。"));
    else for (const outcome of pipeline.searchOutcomes) appendSearchOutcome(officialSummary, outcome);
    article.append(officialSummary);
    appendThirdParty(article, pipeline.thirdParty);
    if (pipeline.inference) appendInference(article, pipeline.inference);
    appendCandidates(article, pipeline.candidates);
    const details = element("details");
    details.append(element("summary", "查看 10 个持久阶段"));
    const stages = element("div", undefined, "workspace-evidence-job-stages");
    for (const stage of pipeline.stages) stages.append(renderStage(pipeline, stage));
    details.append(stages);
    article.append(details);
    return article;
  };

  const render = () => {
    host.replaceChildren();
    host.classList.add("workspace-plan-evidence", "workspace-evidence-jobs");
    host.setAttribute("aria-label", "证据解析任务与证据阶梯");
    const header = element("header", undefined, "workspace-evidence-head");
    const copy = element("div");
    copy.append(element("p", "证据解析 · 持久任务"), element("h2", "看清来源强度、未知原因和下一步补证"));
    copy.append(element("span", "任务阶段执行成功不等于字段已确认；第三方永不显示为官网，未知、待复核和阻断不会变成确定值。"));
    const refresh = element("button", refreshBusy ? "正在刷新…" : "刷新任务状态");
    refresh.type = "button";
    refresh.dataset.evidenceJobAction = "refresh";
    refresh.disabled = refreshBusy || !planId || tracked.length === 0;
    header.append(copy, refresh);
    host.append(header);
    const tracker = element("div", undefined, "workspace-evidence-job-tracker");
    const label = element("label");
    label.append(element("span", "跟踪已有 pipeline ID"));
    const input = element("input") as HTMLInputElement;
    input.type = "text";
    input.placeholder = "evidence-pipeline-sha256-…";
    input.autocomplete = "off";
    input.dataset.evidencePipelineInput = "true";
    input.disabled = !planId;
    label.append(input);
    const track = element("button", "加载持久任务");
    track.type = "button";
    track.dataset.evidenceJobAction = "track";
    track.disabled = !planId;
    tracker.append(label, track);
    host.append(tracker);
    if (panelError) {
      const alert = element("p", panelError, "workspace-evidence-job-error");
      alert.setAttribute("role", "alert");
      host.append(alert);
    }
    if (!planId) {
      host.append(element("p", "请选择方案后再查看与该方案绑定的证据任务。", "workspace-evidence-status"));
      return;
    }
    if (!tracked.length) host.append(element("p", "当前方案尚未跟踪证据任务。任务创建后粘贴其 pipeline ID；页面重载会用同一 ID 重新读取持久状态。", "workspace-evidence-status"));
    for (const pipelineId of tracked) {
      const pipeline = statuses.get(pipelineId);
      if (pipeline) host.append(renderPipeline(pipeline));
      else {
        const pendingCard = element("article", undefined, "workspace-evidence-job-pipeline");
        pendingCard.dataset.evidencePipelineId = pipelineId;
        pendingCard.append(element("strong", pipelineId));
        const error = errors.get(pipelineId);
        const message = element("p", error ?? "正在读取持久任务…", error ? "workspace-evidence-job-error" : undefined);
        if (error) message.setAttribute("role", "alert");
        pendingCard.append(message);
        const remove = element("button", "不再跟踪");
        remove.type = "button";
        remove.dataset.evidenceJobAction = "untrack";
        remove.dataset.pipelineId = pipelineId;
        pendingCard.append(remove);
        host.append(pendingCard);
      }
    }
  };

  const refreshOne = async (pipelineId: string): Promise<void> => {
    try {
      const parsed = parseEvidenceJobStatus(await api.status(pipelineId));
      if (!planId || parsed.planId !== planId) throw new Error(parsed.planId ? "该任务属于另一个方案，已阻止跨方案显示" : "该任务没有绑定当前方案，已阻止显示");
      statuses.set(pipelineId, parsed);
      errors.delete(pipelineId);
    } catch (cause) {
      statuses.delete(pipelineId);
      errors.set(pipelineId, cause instanceof Error ? cause.message : "无法读取证据任务");
    }
  };

  const refreshAll = async (): Promise<void> => {
    if (disposed || refreshBusy || !planId || !tracked.length) { render(); return; }
    refreshBusy = true;
    render();
    try { await Promise.all(tracked.map(refreshOne)); }
    finally { refreshBusy = false; render(); schedulePoll(); }
  };

  const activatePlan = () => {
    const nextPlanId = options.getPlanId();
    if (nextPlanId === planId) return;
    planId = nextPlanId;
    tracked = planId ? readTracking(storage, planId) : [];
    statuses.clear();
    errors.clear();
    render();
    void refreshAll();
  };

  const trackPipeline = async (raw: string): Promise<void> => {
    if (!planId) throw new Error("请先选择方案");
    const pipelineId = assertPipelineId(raw.trim());
    if (!tracked.includes(pipelineId)) tracked = [pipelineId, ...tracked].slice(0, 20);
    panelError = "";
    writeTracking(storage, planId, tracked);
    render();
    await refreshOne(pipelineId);
    render();
    schedulePoll();
  };

  const untrack = (pipelineId: string) => {
    if (!planId) return;
    tracked = tracked.filter((id) => id !== pipelineId);
    statuses.delete(pipelineId);
    errors.delete(pipelineId);
    writeTracking(storage, planId, tracked);
    render();
    schedulePoll();
  };

  const mutateStage = async (action: "cancel" | "resume", pipelineId: string, stageName: string): Promise<void> => {
    const pipeline = statuses.get(assertPipelineId(pipelineId));
    const stage = pipeline?.stages.find((candidate) => candidate.stage === assertStage(stageName));
    if (!pipeline || !stage) return;
    const key = `${pipelineId}:${stage.stage}`;
    if (pending.has(key)) return;
    pending.add(key);
    render();
    try {
      if (action === "cancel") await api.cancel(pipelineId, stage.stage, stage.revision);
      else await api.resume(pipelineId, stage.stage, stage.revision);
      await refreshOne(pipelineId);
    } catch (cause) {
      await refreshOne(pipelineId);
      errors.set(pipelineId, cause instanceof Error ? cause.message : `无法${action === "cancel" ? "取消" : "恢复"}证据任务`);
    } finally {
      pending.delete(key);
      render();
      schedulePoll();
    }
  };

  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-evidence-job-action]");
    const action = button?.dataset.evidenceJobAction;
    if (!action) return;
    if (action === "refresh") void refreshAll();
    else if (action === "track") {
      const input = host.querySelector<HTMLInputElement>("[data-evidence-pipeline-input]");
      if (input) void trackPipeline(input.value).catch((cause) => {
        panelError = cause instanceof Error ? cause.message : "证据任务 ID 无效";
        render();
      });
    } else if (action === "untrack" && button.dataset.pipelineId) untrack(button.dataset.pipelineId);
    else if ((action === "cancel" || action === "resume") && button.dataset.pipelineId && button.dataset.stage) {
      void mutateStage(action, button.dataset.pipelineId, button.dataset.stage);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.target as HTMLElement).matches("[data-evidence-pipeline-input]")) return;
    event.preventDefault();
    void trackPipeline((event.target as HTMLInputElement).value).catch((cause) => {
      panelError = cause instanceof Error ? cause.message : "证据任务 ID 无效";
      render();
    });
  };

  const onEnqueued = (event: Event) => {
    const detail = record((event as CustomEvent).detail);
    if (detail?.planId === planId && typeof detail.pipelineId === "string") void trackPipeline(detail.pipelineId).catch(() => undefined);
  };

  host.addEventListener("click", onClick);
  host.addEventListener("keydown", onKeyDown);
  document.addEventListener("build-sim:evidence-job-enqueued", onEnqueued);
  const unsubscribe = options.subscribePlan?.(activatePlan) ?? (() => undefined);
  activatePlan();
  render();

  return {
    track: trackPipeline,
    refresh: refreshAll,
    resolutionSummaries: () => [...statuses.values()].map((status) => structuredClone(status.summary)),
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe();
      host.removeEventListener("click", onClick);
      host.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("build-sim:evidence-job-enqueued", onEnqueued);
      host.replaceChildren();
    },
  };
}
