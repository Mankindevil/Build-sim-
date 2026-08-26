import { BUILD_STAGE_LABELS, BUILD_STAGES, type BuildStage, type TransactionEvidence, type TransactionImportRecord } from "./build-progress";
import type { PlanTransactionLink } from "../plans/contracts";
import type { SkuRecord } from "../sku/types";

const MAX_FILE_BYTES = 5_000_000;
const TERMINAL_JOB_STATUS = new Set(["completed", "partial", "failed"]);
const TRANSACTION_CATEGORIES = ["case", "motherboard", "cpu", "psu", "cooler", "gpu", "memory", "storage", "hba", "fan", "accessory", "其他"];
const CATEGORY_LABELS: Record<string, string> = {
  case: "机箱", motherboard: "主板", cpu: "处理器", psu: "电源", cooler: "散热器",
  gpu: "显卡", memory: "内存", storage: "存储", hba: "HBA", fan: "风扇", accessory: "配件", 其他: "其他",
};

interface TransactionAnalysis {
  receiptId: string;
  status: "matched-catalog" | "catalog-search-required" | "identity-review-required";
  detected: { name: string; brand: string | null; model: string | null; category: string; qty: number; unitPriceCny: number | null };
  catalogMatch: { skuId: string; kind: string; score: number } | null;
  searchQuery?: string | null;
  ocrText?: string;
  evidence: Omit<TransactionEvidence, "verification" | "catalogJobId" | "candidateId" | "draftId" | "officialUrl">;
  catalogSearch: { jobId: string; status: string; stage: string } | null;
  billing?: {
    status: string;
    cost: { totalCny: number } | null;
    pricing: { pricingBand: { label: string } | null };
  } | null;
}

interface CatalogCandidate {
  skuId?: string;
  candidateId?: string;
  expectedHash?: string;
  title?: string;
  brand?: string;
  model?: string;
  mpn?: string;
  canonicalUrl?: string;
  url?: string;
  match?: { score?: number; kind?: string };
  extraction?: { status?: string; fieldsFound?: number; error?: string };
  official?: { trustStatus?: string; pageKind?: string; reasons?: string[] };
  identity?: {
    verdict?: "exact" | "same-family" | "conflict" | "insufficient-evidence";
    score?: number;
    reasons?: string[];
    unknowns?: string[];
    criticalConflicts?: Array<{ field?: string; input?: unknown; candidate?: unknown }>;
  };
  fields?: Array<{ field?: string; value?: unknown; evidence?: string }>;
}

interface CatalogJob {
  jobId: string;
  status: string;
  stage?: string;
  candidates?: CatalogCandidate[];
  warnings?: string[];
  errors?: string[];
  summary?: { discovered?: number; inspected?: number; fetchSucceeded?: number; productPages?: number; exact?: number; sameFamily?: number; conflicts?: number; insufficientEvidence?: number; blocked?: number; searchLinks?: number };
}

interface CatalogLookupResult {
  record: TransactionImportRecord;
  candidate: CatalogCandidate | null;
}

function catalogCandidateFromSku(sku: SkuRecord): CatalogCandidate {
  const sourceUrl = sku.appearance?.page ?? sku.harness?.sourceUrl ?? sku.price.listingUrl;
  const fields: NonNullable<CatalogCandidate["fields"]> = [];
  const add = (field: string, value: unknown, evidence: string) => {
    if (value !== undefined && value !== null && value !== "") fields.push({ field, value, evidence });
  };
  add("brand", sku.brand, "catalog");
  add("model", sku.model, "catalog");
  add("mpn", sku.mpn, "catalog");
  for (const [field, value] of Object.entries(sku.dims)) if (field !== "evidence" && field !== "note") add(`dims.${field}`, value, sku.dims.evidence);
  for (const [field, value] of Object.entries(sku.power)) if (field !== "evidence" && field !== "note") add(`power.${field}`, value, sku.power.evidence);
  if (sku.harness) {
    for (const [field, value] of Object.entries(sku.harness)) {
      if (["evidence", "leadEvidence", "sourceUrl", "crossCheck", "note"].includes(field)) continue;
      add(`harness.${field}`, value, field.includes("Leads") ? sku.harness.leadEvidence ?? sku.harness.evidence : sku.harness.evidence);
    }
  }
  for (const [field, value] of Object.entries(sku.attrs ?? {})) {
    if (/Evidence$|Note$|SourceUrl$/.test(field)) continue;
    add(`attrs.${field}`, value, String(sku.attrs?.[`${field}Evidence`] ?? "catalog"));
  }
  return {
    skuId: sku.id,
    title: sku.name,
    brand: sku.brand,
    model: sku.model,
    ...(sku.mpn ? { mpn: sku.mpn } : {}),
    ...(sourceUrl ? { canonicalUrl: sourceUrl } : {}),
    match: { kind: "exact-mpn", score: 1 },
    extraction: { status: "ok", fieldsFound: fields.length },
    fields,
  };
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({ error: "invalid_json", message: "本地服务返回了无效数据" }));
  if (!response.ok) throw new Error(String((payload as { message?: string; error?: string }).message ?? (payload as { error?: string }).error ?? `HTTP ${response.status}`));
  return payload as T;
}

function readAsDataUrl(file: File, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取截图"));
    reader.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded, event.total); };
    signal?.addEventListener("abort", () => { reader.abort(); reject(new DOMException("已取消", "AbortError")); }, { once: true });
    reader.readAsDataURL(file);
  });
}

function billingCopy(analysis: TransactionAnalysis): string {
  if (!analysis.billing) return "";
  if (!analysis.billing.cost) return ` · OCR 费用 ${analysis.billing.status}`;
  const amount = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(analysis.billing.cost.totalCny);
  const band = analysis.billing.pricing.pricingBand?.label;
  return ` · OCR 估算 ${amount}${band ? `（${band}）` : ""}`;
}

function comparableIdentity(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

const OFFICIAL_QUERY_NOISE = new Set([
  "graphics", "card", "geforce", "overclocked", "dual-fan", "dual", "fan", "gddr6", "gddr6x",
  "pcie", "pci", "express", "edition", "gaming", "video", "显卡", "商品", "型号",
]);

export function compactOfficialQuery(name: string, brand: string | null | undefined, category: string): string {
  const normalized = name.normalize("NFKC").replace(/[™®]/g, " ").replace(/\boverclocked\b/gi, "OC").replace(/[^A-Za-z0-9.+-]+/g, " ").trim();
  if (category !== "gpu") return normalized.slice(0, 120);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const useful = tokens.filter((token) => !OFFICIAL_QUERY_NOISE.has(token.toLocaleLowerCase()) && !/^\d+\.\d+$/.test(token));
  const brandToken = brand?.trim();
  const selected = [...new Set([...(brandToken ? [brandToken] : []), ...useful])].slice(0, 8);
  return (selected.join(" ") || normalized).slice(0, 120);
}

export function selectBestCatalogCandidate(candidates: CatalogCandidate[] = [], expected?: { name?: string; brand?: string | null; model?: string | null }): CatalogCandidate | null {
  const expectedKeys = [...new Set([expected?.model, expected?.name]
    .map(comparableIdentity)
    .filter((value) => value.length >= 4 && /[a-z]/.test(value) && /\d/.test(value)))];
  const expectedBrand = comparableIdentity(expected?.brand);
  const identityText = (candidate: CatalogCandidate): string => comparableIdentity([
    candidate.title, candidate.brand, candidate.model, candidate.mpn, candidate.canonicalUrl, candidate.url,
  ].filter(Boolean).join(" "));
  const isStrongMatch = (candidate: CatalogCandidate): boolean => candidate.identity?.verdict === "exact"
    || (!candidate.identity && ["exact-mpn", "brand-model"].includes(candidate.match?.kind ?? "") && Number(candidate.match?.score ?? 0) >= 0.7);
  const eligible = candidates.filter((candidate) => {
    if (candidate.identity && candidate.identity.verdict !== "exact") return false;
    if (candidate.identity && !["product", "spec", "datasheet", "support"].includes(candidate.official?.pageKind ?? "unknown")) return false;
    if (["search", "forum", "article", "blocked"].includes(candidate.official?.pageKind ?? "")) return false;
    return true;
  });
  const relevant = expectedKeys.length === 0 ? eligible : eligible.filter((candidate) => {
    if (isStrongMatch(candidate)) return true;
    const haystack = identityText(candidate);
    const modelMatches = expectedKeys.some((key) => haystack.includes(key));
    const brandMatches = !expectedBrand || haystack.includes(expectedBrand);
    return modelMatches && brandMatches;
  });
  return relevant.sort((a, b) => {
    const rank = (candidate: CatalogCandidate): number => {
      const exact = candidate.match?.kind === "exact-mpn" ? 100 : candidate.match?.kind === "brand-model" ? 60 : 0;
      const identityVerdict = candidate.identity?.verdict === "exact" ? 300 : 0;
      const extracted = candidate.extraction?.status === "ok" ? 30 : candidate.extraction?.status === "partial" ? 10 : 0;
      const haystack = identityText(candidate);
      const identityTextMatch = expectedKeys.some((key) => haystack.includes(key)) ? 200 : 0;
      const brand = expectedBrand && haystack.includes(expectedBrand) ? 40 : 0;
      return identityVerdict + identityTextMatch + brand + exact + extracted + Number(candidate.match?.score ?? 0) * 10 + Number(candidate.extraction?.fieldsFound ?? 0);
    };
    return rank(b) - rank(a);
  })[0] ?? null;
}

function recordFromAnalysis(analysis: TransactionAnalysis, verification: TransactionEvidence["verification"]): TransactionImportRecord {
  return {
    receiptId: analysis.receiptId,
    skuId: analysis.catalogMatch?.skuId ?? null,
    name: analysis.detected.name,
    category: analysis.detected.category,
    qty: analysis.detected.qty,
    unitPriceCny: analysis.detected.unitPriceCny,
    stage: "purchased",
    evidence: {
      ...analysis.evidence,
      verification,
      catalogJobId: analysis.catalogSearch?.jobId ?? null,
    },
  };
}

export interface TransactionImportPlanContext {
  planId: string;
  planVersionId: string | null;
  planName: string;
  items: Array<{ id: string; skuId: string; name: string; category: string }>;
}

export interface TransactionImportController { dispose(): void; }

export function initTransactionImport(options: { onImport: (record: TransactionImportRecord, screenshot: File) => void; getPlanContext?: () => TransactionImportPlanContext | null; getCatalogSku?: (skuId: string) => SkuRecord | null }): TransactionImportController | null {
  const input = $("transaction-screenshot-input") as HTMLInputElement | null;
  const drop = $("transaction-screenshot-drop");
  const preview = $("transaction-screenshot-preview") as HTMLImageElement | null;
  const status = $("transaction-screenshot-status");
  const result = $("transaction-screenshot-result");
  if (!input || !drop || !preview || !status || !result) return null;
  let createdFlow = false;
  if (!$("transaction-flow")) {
    const flow = document.createElement("ol");
    flow.id = "transaction-flow"; flow.className = "transaction-flow"; flow.setAttribute("aria-label", "交易导入进度");
    flow.innerHTML = '<li data-step="upload" data-state="current"><span>选择截图</span></li><li data-step="recognize" data-state="idle"><span>识别交易</span></li><li data-step="enrich" data-state="idle"><span>核验型号</span></li><li data-step="review" data-state="idle"><span>确认入档</span></li>';
    drop.parentElement?.insertBefore(flow, drop);
    createdFlow = true;
  }

  let previewUrl: string | null = null;
  let activeRequest: AbortController | null = null;
  let lastFile: File | null = null;
  let currentPhase = "";
  let phaseStartedAt = 0;
  let phaseTimer: number | null = null;
  const setStatus = (copy: string, level: "idle" | "busy" | "ok" | "warn" | "bad" = "idle"): void => {
    status.textContent = copy;
    status.dataset.level = level;
  };
  const setPhase = (phase: "selected" | "reading" | "recognizing" | "enriching" | "reviewing" | "staged" | "cancelled" | "failed", copy: string, level: "idle" | "busy" | "ok" | "warn" | "bad" = "idle"): void => {
    if (currentPhase !== phase) { currentPhase = phase; phaseStartedAt = performance.now(); }
    const renderCopy = () => setStatus(`${copy}${level === "busy" && (phase === "recognizing" || phase === "enriching") ? ` · elapsed ${Math.max(0, Math.floor((performance.now() - phaseStartedAt) / 1000))}s` : ""}`, level);
    renderCopy();
    if (phaseTimer !== null) { window.clearInterval(phaseTimer); phaseTimer = null; }
    if (level === "busy" && (phase === "recognizing" || phase === "enriching")) phaseTimer = window.setInterval(renderCopy, 1000);
    status.dataset.phase = phase;
    const order = ["selected", "recognizing", "enriching", "reviewing"];
    const effective = phase === "reading" ? "selected" : phase === "staged" ? "reviewing" : phase;
    const currentIndex = order.indexOf(effective);
    for (const step of document.querySelectorAll<HTMLElement>("#transaction-flow [data-step]")) {
      const mapped = step.dataset.step === "upload" ? "selected" : step.dataset.step === "recognize" ? "recognizing" : step.dataset.step === "enrich" ? "enriching" : "reviewing";
      const index = order.indexOf(mapped);
      step.dataset.state = phase === "failed" || phase === "cancelled" ? index === Math.max(0, currentIndex) ? phase : index < currentIndex ? "done" : "idle" : index < currentIndex ? "done" : index === currentIndex ? phase === "staged" ? "done" : "current" : "idle";
    }
  };
  const retry = ($("transaction-retry") as HTMLButtonElement | null) ?? document.createElement("button");
  if (!retry.id) { retry.id = "transaction-retry"; retry.type = "button"; retry.className = "case-view-btn"; retry.textContent = "重试"; status.insertAdjacentElement("afterend", retry); }
  retry.hidden = true;
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "case-view-btn"; cancel.textContent = "取消当前处理"; cancel.hidden = true; cancel.dataset.transactionCancel = ""; retry.insertAdjacentElement("afterend", cancel);
  const readProgress = document.createElement("progress"); readProgress.max = 100; readProgress.hidden = true; readProgress.setAttribute("aria-label", "读取截图进度"); cancel.insertAdjacentElement("afterend", readProgress);
  const showReview = (record: TransactionImportRecord, screenshot: File, copy: string, reviewOptions: { enrichmentAnalysis?: TransactionAnalysis; ocrText?: string; catalogCandidate?: CatalogCandidate; searchLogs?: string[] } = {}): void => {
    const { enrichmentAnalysis, ocrText, catalogCandidate, searchLogs = [] } = reviewOptions;
    result.hidden = false;
    result.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "transaction-review-head";
    const strong = document.createElement("strong");
    strong.textContent = "检查识别结果";
    const small = document.createElement("small");
    small.textContent = copy;
    heading.append(strong, small);

    const fields = document.createElement("div");
    fields.className = "transaction-review-fields";
    const makeLabel = (copyText: string, control: HTMLElement): HTMLLabelElement => {
      const label = document.createElement("label");
      label.append(document.createTextNode(copyText), control);
      return label;
    };
    const name = document.createElement("input");
    name.className = "transaction-review-name";
    name.value = record.name;
    const category = document.createElement("select");
    category.className = "transaction-review-category";
    const categories = TRANSACTION_CATEGORIES.includes(record.category) ? TRANSACTION_CATEGORIES : [record.category, ...TRANSACTION_CATEGORIES];
    for (const value of categories) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = CATEGORY_LABELS[value] ?? value;
      option.selected = value === record.category;
      category.append(option);
    }
    category.value = record.category;
    const qty = document.createElement("input");
    qty.className = "transaction-review-qty";
    qty.type = "number";
    qty.min = "1";
    qty.max = "99";
    qty.step = "1";
    qty.value = String(record.qty);
    const price = document.createElement("input");
    price.className = "transaction-review-price";
    price.type = "number";
    price.min = "0";
    price.step = "1";
    price.placeholder = "待补";
    price.value = record.unitPriceCny === null ? "" : String(record.unitPriceCny);
    const stage = document.createElement("select");
    stage.className = "transaction-review-stage";
    for (const value of BUILD_STAGES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = BUILD_STAGE_LABELS[value];
      option.selected = value === (record.stage ?? "purchased");
      stage.append(option);
    }
    stage.value = record.stage ?? "purchased";
    const planContext = options.getPlanContext?.() ?? null;
    const link = document.createElement("select");
    link.className = "transaction-review-link";
    const linkHint = document.createElement("small");
    linkHint.className = "transaction-review-link-hint";
    linkHint.id = `transaction-link-hint-${record.receiptId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    link.setAttribute("aria-describedby", linkHint.id);
    const unlinked = document.createElement("option");
    unlinked.value = "";
    unlinked.textContent = planContext ? "不对应方案（作为额外采购）" : "暂存为未关联采购";
    link.append(unlinked);
    const appendPlanItems = (labelText: string, items: TransactionImportPlanContext["items"]): void => {
      if (items.length === 0) return;
      const group = document.createElement("optgroup");
      group.label = labelText;
      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = `${CATEGORY_LABELS[item.category] ?? item.category} · ${item.name}`;
        option.selected = record.planLink?.planItemId === item.id || item.skuId === record.skuId;
        group.append(option);
      }
      link.append(group);
    };
    const sameCategoryItems = (planContext?.items ?? []).filter((item) => item.category === record.category);
    const otherItems = (planContext?.items ?? []).filter((item) => item.category !== record.category);
    appendPlanItems("同类方案位置", sameCategoryItems);
    appendPlanItems("其他方案位置", otherItems);
    const updateLinkHint = (): void => {
      const selectedItem = planContext?.items.find((item) => item.id === link.value);
      if (!planContext) {
        linkHint.textContent = "当前没有活动方案，这笔交易会先进入未关联采购。";
      } else if (!selectedItem) {
        linkHint.textContent = "额外购买或暂不确定用途时选这里，之后仍可重新对应方案位置。";
      } else if (selectedItem.skuId === record.skuId) {
        linkHint.textContent = "已按相同型号自动对应；这里只记录交易用途，不会改动识别结果。";
      } else {
        linkHint.textContent = "买了不同型号时，选择它实际用于的方案位置；购买型号仍以左侧识别结果为准。";
      }
    };
    link.addEventListener("change", updateLinkHint);
    updateLinkHint();
    const linkLabel = makeLabel("对应方案位置（可选）", link);
    linkLabel.append(linkHint);
    fields.append(makeLabel(record.skuId ? "部件名称（已匹配正式 SKU，可编辑显示信息）" : "部件名称", name), makeLabel("分类", category), makeLabel("数量", qty), makeLabel("成交单价 ¥", price), makeLabel("当前状态", stage), linkLabel);
    const evidence = document.createElement("p");
    evidence.className = "transaction-review-evidence";
    evidence.textContent = `证据：${record.evidence.fileName} · OCR ${record.evidence.ocrEngine} · 置信度 ${record.evidence.ocrConfidence === null ? "unknown" : `${record.evidence.ocrConfidence}%`} · ${record.evidence.excerpt || "无可展示摘录"}`;
    const ocrDetails = document.createElement("details");
    ocrDetails.className = "transaction-review-ocr";
    const ocrSummary = document.createElement("summary");
    ocrSummary.textContent = "查看完整 OCR 原文（可选择复制）";
    const ocrCopy = document.createElement("textarea");
    ocrCopy.readOnly = true;
    ocrCopy.spellcheck = false;
    ocrCopy.rows = 8;
    ocrCopy.setAttribute("aria-label", "完整 OCR 原文");
    ocrCopy.value = ocrText?.trim() || "本次服务未返回 OCR 原文。";
    const ocrPrivacy = document.createElement("small");
    ocrPrivacy.textContent = "OCR 原文仅用于本次校对，不会随交易档案保存。";
    ocrDetails.append(ocrSummary, ocrCopy, ocrPrivacy);

    let completedSearchLog: HTMLDetailsElement | null = null;
    if (searchLogs.length) {
      completedSearchLog = document.createElement("details") as HTMLDetailsElement;
      completedSearchLog.className = "transaction-search-log";
      completedSearchLog.open = true;
      const logSummary = document.createElement("summary");
      logSummary.textContent = `官网查询日志 · ${searchLogs.length} 条`;
      const logList = document.createElement("ol");
      for (const message of searchLogs) { const row = document.createElement("li"); row.textContent = message; logList.append(row); }
      completedSearchLog.append(logSummary, logList);
    }

    let candidateApproval: HTMLInputElement | null = null;
    let candidateReview: HTMLElement | null = null;
    if (catalogCandidate && record.evidence.officialUrl) {
      candidateReview = document.createElement("section");
      candidateReview.className = "transaction-candidate-review";
      const candidateTitle = document.createElement("strong");
      candidateTitle.textContent = "校验官网候选";
      const candidateMeta = document.createElement("p");
      candidateMeta.textContent = `${catalogCandidate.title ?? "未命名候选"} · 页面 ${catalogCandidate.official?.pageKind ?? "unknown"} · 身份 ${catalogCandidate.identity?.verdict ?? catalogCandidate.match?.kind ?? "unknown"} · 匹配 ${Math.round(Number(catalogCandidate.identity?.score ?? catalogCandidate.match?.score ?? 0) * 100)}% · 参数 ${catalogCandidate.extraction?.status ?? "unknown"}`;
      const candidateWarning = document.createElement("p");
      candidateWarning.className = "transaction-candidate-warning";
      const identityNotes = [
        ...(catalogCandidate.identity?.criticalConflicts ?? []).map((entry) => `${entry.field}: ${String(entry.input)} ≠ ${String(entry.candidate)}`),
        ...((catalogCandidate.identity?.unknowns ?? []).length ? [`待确认：${catalogCandidate.identity?.unknowns?.join("、")}`] : []),
      ];
      candidateWarning.textContent = identityNotes.length
        ? identityNotes.join("；")
        : catalogCandidate.extraction?.error ? `仍缺参数：${catalogCandidate.extraction.error}` : "已展示当前来源明确提供的参数；未列出的字段保持 unknown。";
      const candidateLink = document.createElement("a");
      candidateLink.href = record.evidence.officialUrl;
      candidateLink.target = "_blank";
      candidateLink.rel = "noreferrer";
      candidateLink.textContent = "打开候选官网页面";
      const fieldsList = document.createElement("dl");
      fieldsList.className = "transaction-candidate-fields";
      for (const field of catalogCandidate.fields ?? []) {
        const term = document.createElement("dt");
        term.textContent = field.field ?? "字段";
        const value = document.createElement("dd");
        const renderedValue = typeof field.value === "string" ? field.value : JSON.stringify(field.value);
        value.textContent = `${renderedValue}${field.evidence ? ` · 证据 ${field.evidence}` : ""}`;
        fieldsList.append(term, value);
      }
      if (!fieldsList.childElementCount) {
        const empty = document.createElement("p");
        empty.textContent = "页面未抽取出可展示参数，请重点人工核对标题、品牌、型号和版本。";
        fieldsList.append(empty);
      }
      const approvalLabel = document.createElement("label");
      candidateApproval = document.createElement("input");
      candidateApproval.type = "checkbox";
      candidateApproval.className = "transaction-candidate-approval";
      approvalLabel.append(candidateApproval, document.createTextNode("我已核对：页面的品牌、型号和版本与实物一致"));
      const removeSource = document.createElement("button");
      removeSource.type = "button";
      removeSource.className = "case-view-btn";
      removeSource.textContent = "移除错误来源";
      removeSource.addEventListener("click", () => {
        const cleaned: TransactionImportRecord = {
          ...record,
          evidence: { ...record.evidence, verification: "search-no-result", candidateId: null, draftId: null, officialUrl: null },
        };
        showReview(cleaned, screenshot, "候选来源已移除 · 可修改信息后直接入档", { ...(ocrText ? { ocrText } : {}) });
      });
      candidateReview.append(candidateTitle, candidateMeta, candidateWarning, candidateLink, fieldsList, approvalLabel, removeSource);
    } else if (searchLogs.length) {
      candidateReview = document.createElement("section");
      candidateReview.className = "transaction-candidate-review";
      candidateReview.dataset.state = "empty";
      const candidateTitle = document.createElement("strong");
      candidateTitle.textContent = "官网参数校验结果 · 0 个可用候选";
      const empty = document.createElement("p");
      empty.textContent = "没有找到能同时证明品牌、型号并提供参数的官网页面。本次不会附加来源或猜测尺寸、功耗等参数。";
      candidateReview.append(candidateTitle, empty);
    }

    const actions = document.createElement("div");
    actions.className = "transaction-review-actions";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "case-view-btn";
    discard.textContent = "放弃本次识别";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "加入下方基座";
    confirm.disabled = Boolean(candidateApproval);
    confirm.hidden = Boolean(enrichmentAnalysis);
    candidateApproval?.addEventListener("change", () => { confirm.disabled = !candidateApproval?.checked; });
    const reviewedRecord = (): TransactionImportRecord => {
      const rawPrice = price.value.trim();
      const selectedStage = BUILD_STAGES.includes(stage.value as BuildStage) ? stage.value as BuildStage : "purchased";
      const selectedItem = planContext?.items.find((item) => item.id === link.value);
      const planLink: PlanTransactionLink = {
        schemaVersion: "1.0.0",
        planId: planContext?.planId ?? null,
        planVersionIdAtCapture: planContext?.planVersionId ?? null,
        planItemId: selectedItem?.id ?? null,
        linkStatus: planContext && selectedItem ? "linked" : "unlinked",
      };
      return {
        ...record,
        skuId: candidateApproval?.checked && catalogCandidate?.skuId ? catalogCandidate.skuId : record.skuId,
        name: name.value.trim() || record.name,
        category: category.value || record.category,
        qty: Math.max(1, Math.round(Number(qty.value) || 1)),
        unitPriceCny: rawPrice === "" ? null : Math.max(0, Number(rawPrice) || 0),
        stage: selectedStage,
        planLink,
        evidence: candidateApproval?.checked ? { ...record.evidence, sourceReview: "user-confirmed" } : record.evidence,
      };
    };
    discard.addEventListener("click", () => {
      result.hidden = true;
      result.replaceChildren();
      setPhase("selected", "本次识别结果已放弃，未写入方案或档案。可重新选择截图。", "idle");
    });
    confirm.addEventListener("click", () => {
      options.onImport(reviewedRecord(), screenshot);
      result.hidden = true;
      result.replaceChildren();
      setPhase("staged", "staged · 已加入编辑区但尚未归档；点击“保存基座/保存更改”后才会成为 archived。", "ok");
    });
    actions.append(discard);
    if (enrichmentAnalysis) {
      const enrich = document.createElement("button");
      enrich.type = "button";
      enrich.className = "case-view-btn transaction-review-enrich";
      enrich.textContent = "确认信息并查询官网";
      enrich.addEventListener("click", async () => {
        const reviewed = reviewedRecord();
        const officialQuery = compactOfficialQuery(reviewed.name, enrichmentAnalysis.detected.brand, reviewed.category);
        const progressMessages: string[] = [];
        const searchLog = document.createElement("section");
        searchLog.className = "transaction-search-log";
        const logTitle = document.createElement("strong");
        logTitle.textContent = "官网查询日志";
        const logList = document.createElement("ol");
        searchLog.append(logTitle, logList);
        actions.insertAdjacentElement("beforebegin", searchLog);
        const appendLog = (message: string): void => {
          const stamped = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} · ${message}`;
          progressMessages.push(stamped);
          const row = document.createElement("li");
          row.textContent = stamped;
          logList.append(row);
        };
        appendLog(`用户已确认输入 · ${reviewed.name} · ${CATEGORY_LABELS[reviewed.category] ?? reviewed.category}`);
        appendLog(`官网查询词 · ${officialQuery}`);
        const searchController = new AbortController();
        activeRequest?.abort();
        activeRequest = searchController;
        enrich.disabled = true;
        confirm.disabled = true;
        cancel.hidden = false;
        setPhase("enriching", "正在按你确认的名称与分类查询官网参数", "busy");
        try {
          const search = await jsonResponse<CatalogJob>(await fetch("/api/price/transactions/catalog-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: officialQuery,
              ...(enrichmentAnalysis.detected.brand && reviewed.name.toLocaleLowerCase().includes(enrichmentAnalysis.detected.brand.toLocaleLowerCase()) ? { brand: enrichmentAnalysis.detected.brand } : {}),
              category: reviewed.category,
            }),
            signal: searchController.signal,
          }));
          appendLog(`请求已提交 · ${search.jobId}`);
          const correctedAnalysis: TransactionAnalysis = {
            ...enrichmentAnalysis,
            detected: {
              ...enrichmentAnalysis.detected,
              name: reviewed.name,
              category: reviewed.category,
              qty: reviewed.qty,
              unitPriceCny: reviewed.unitPriceCny,
            },
            searchQuery: reviewed.name,
            catalogSearch: { jobId: search.jobId, status: search.status, stage: search.stage ?? search.status },
          };
          const lookup = await updateFromCatalogJob(correctedAnalysis, searchController.signal, appendLog);
          const merged: TransactionImportRecord = { ...lookup.record, ...reviewed, evidence: lookup.record.evidence };
          setPhase("reviewing", "官网查询完成；请再次核对来源与参数后确认入档。", lookup.record.evidence.officialUrl ? "ok" : "warn");
          const retainedOcrText = enrichmentAnalysis.ocrText ?? ocrText;
          showReview(merged, screenshot, lookup.record.evidence.officialUrl ? "已找到同型号候选 · 需要你确认后才能入档" : "未找到同型号官网来源 · 仍可按人工记录入档", {
            ...(retainedOcrText ? { ocrText: retainedOcrText } : {}),
            ...(lookup.candidate ? { catalogCandidate: lookup.candidate } : {}),
            searchLogs: progressMessages,
          });
        } catch (error) {
          if (searchController.signal.aborted) {
            setPhase("reviewing", "官网查询已取消；已保留你修正的识别结果。", "warn");
          } else {
            setPhase("reviewing", `官网查询失败：${error instanceof Error ? error.message : "服务不可用"}；可修改后重试或直接入档。`, "warn");
          }
          enrich.disabled = false;
          confirm.hidden = false;
          confirm.disabled = false;
        } finally {
          cancel.hidden = true;
          if (activeRequest === searchController) activeRequest = null;
        }
      });
      actions.append(enrich);
    }
    actions.append(confirm);
    result.append(heading, fields, evidence, ocrDetails, ...(completedSearchLog ? [completedSearchLog] : []), ...(candidateReview ? [candidateReview] : []), actions);
  };

  const updateFromCatalogJob = async (analysis: TransactionAnalysis, signal: AbortSignal, onProgress?: (message: string) => void): Promise<CatalogLookupResult> => {
    const jobId = analysis.catalogSearch?.jobId;
    if (!jobId) return { record: recordFromAnalysis(analysis, "search-failed"), candidate: null };
    onProgress?.(`搜索任务已创建 · ${jobId}`);
    let job: CatalogJob | null = null;
    let lastProgress = "";
    for (let index = 0; index < 45; index += 1) {
      await sleep(index === 0 ? 250 : 750);
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      job = await jsonResponse<CatalogJob>(await fetch(`/api/catalog/search/${encodeURIComponent(jobId)}`, { headers: { Accept: "application/json" }, signal }));
      const progress = `${job.stage ?? "unknown"} · ${job.status}`;
      if (progress !== lastProgress) { onProgress?.(`服务阶段 · ${progress}`); lastProgress = progress; }
      if (TERMINAL_JOB_STATUS.has(job.status)) break;
      setPhase("enriching", `正在联网补充官方参数 · ${job.stage ?? job.status} · 阶段耗时由服务决定，不伪造百分比`, "busy");
    }
    if (!job || !TERMINAL_JOB_STATUS.has(job.status)) {
      const timedOut = recordFromAnalysis(analysis, "search-failed");
      setStatus("官网参数搜索超时；请先检查识别结果，参数稍后可继续补齐。", "warn");
      onProgress?.("搜索超时 · 未附加来源");
      return { record: timedOut, candidate: null };
    }
    onProgress?.(`候选发现完成 · ${job.candidates?.length ?? 0} 个页面`);
    if (job.summary) {
      onProgress?.(`候选漏斗 · 发现 ${job.summary.discovered ?? 0} · 成功读取 ${job.summary.fetchSucceeded ?? 0} · 产品/规格页 ${job.summary.productPages ?? 0} · 精确型号 ${job.summary.exact ?? 0} · 同系列 ${job.summary.sameFamily ?? 0} · 冲突 ${job.summary.conflicts ?? 0}`);
    }
    for (const warning of job.warnings ?? []) onProgress?.(`服务警告 · ${warning}`);
    for (const error of job.errors ?? []) onProgress?.(`服务错误 · ${error}`);
    const candidate = selectBestCatalogCandidate(job.candidates, analysis.detected);
    if (!candidate || Number(candidate.extraction?.fieldsFound ?? 0) < 1) {
      const noResult = recordFromAnalysis(analysis, job.status === "failed" ? "search-failed" : "search-no-result");
      setStatus("没有找到品牌与型号一致的官网候选；不会附加无关来源。", "warn");
      onProgress?.("身份校验未通过 · 所有无关或无参数候选已拒绝");
      const explained = (job.candidates ?? []).find((entry) => entry.identity?.reasons?.length || entry.extraction?.error);
      if (explained?.identity?.reasons?.length) onProgress?.(`首个未通过原因 · ${explained.identity.reasons.join("；")}`);
      else if (explained?.extraction?.error) onProgress?.(`首个读取失败 · ${explained.extraction.error}`);
      return { record: noResult, candidate: null };
    }
    onProgress?.(`候选入选 · ${candidate.title ?? candidate.canonicalUrl ?? candidate.url ?? "未命名页面"}`);
    let verification: TransactionEvidence["verification"] = "catalog-candidate";
    let draftId: string | null = null;
    if (candidate.candidateId && candidate.expectedHash) {
      try {
        const enrichment = await jsonResponse<{ status?: string; draftId?: string }>(await fetch(`/api/catalog/candidates/${encodeURIComponent(candidate.candidateId)}/enrich`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedHash: candidate.expectedHash }),
          signal,
        }));
        if (enrichment.status === "draft") {
          verification = "catalog-draft";
          draftId = enrichment.draftId ?? null;
        }
      } catch {
        // A governed catalog write or draft gate may be disabled. The inspected
        // official candidate still remains attached as reviewable provenance.
      }
    }
    const enriched = recordFromAnalysis(analysis, verification);
    enriched.evidence.candidateId = candidate.candidateId ?? null;
    enriched.evidence.draftId = draftId;
    enriched.evidence.officialUrl = candidate.canonicalUrl ?? candidate.url ?? null;
    setStatus(verification === "catalog-draft" ? "官方参数草稿已生成；请检查交易字段后加入基座。" : "已关联可核验的官网参数候选；请检查后加入基座。", "ok");
    onProgress?.(`参数抽取 · ${candidate.extraction?.status ?? "unknown"} · ${candidate.extraction?.fieldsFound ?? 0} 个字段`);
    return { record: enriched, candidate };
  };

  const processFile = async (file: File): Promise<void> => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setStatus("请选择 PNG、JPEG 或 WebP 图片。", "bad"); return; }
    if (file.size > MAX_FILE_BYTES) { setStatus("截图不能超过 5MB。", "bad"); return; }
    lastFile = file;
    activeRequest?.abort();
    const controller = new AbortController();
    activeRequest = controller;
    input.disabled = true;
    drop.dataset.busy = "true";
    retry.hidden = true; cancel.hidden = false;
    setPhase("selected", `selected · ${file.name} · ${(file.size / 1000).toFixed(1)} KB`, "busy");
    result.hidden = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.hidden = false;
    let timedOut = false;
    const timeoutId = window.setTimeout(() => { timedOut = true; controller.abort(); }, 75_000);
    try {
      readProgress.hidden = false; readProgress.value = 0;
      setPhase("reading", "reading · 正在读取本地文件 0%", "busy");
      const imageDataUrl = await readAsDataUrl(file, (loaded, total) => {
        const percent = total ? Math.round(loaded / total * 100) : 0;
        readProgress.value = percent;
        setPhase("reading", `reading · 正在读取本地文件 ${percent}%`, "busy");
      }, controller.signal);
      readProgress.hidden = true;
      setPhase("recognizing", "recognizing · OCR 正在识别商品、数量与成交价；仅显示阶段与耗时，不伪造百分比", "busy");
      const analysis = await jsonResponse<TransactionAnalysis>(await fetch("/api/price/transactions/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, capturedAt: new Date(file.lastModified || Date.now()).toISOString(), imageDataUrl }),
        signal: controller.signal,
      }));
      const verification: TransactionEvidence["verification"] = analysis.status === "matched-catalog" ? "matched-catalog" : analysis.status === "catalog-search-required" ? "online-searching" : "identity-review-required";
      let record = recordFromAnalysis(analysis, verification);
      const costCopy = billingCopy(analysis);
      let resultCopy = `OCR 识别完成${costCopy} · 尚未写入基座`;
      if (analysis.status === "matched-catalog") {
        setPhase("reviewing", "reviewing · 已匹配正式 SKU；请核对数量、成交价、证据和方案部件。", "ok");
        resultCopy = `正式 SKU · ${(analysis.catalogMatch?.score ?? 0) * 100}% 匹配${costCopy} · 尚未保存`;
      } else if (analysis.status === "catalog-search-required") {
        setPhase("reviewing", "reviewing · 请先修正名称与分类，再决定是否查询官网参数。", "warn");
        resultCopy = `OCR 初步识别${costCopy} · 尚未发起官网查询`;
        showReview(record, file, resultCopy, { enrichmentAnalysis: analysis, ...(analysis.ocrText ? { ocrText: analysis.ocrText } : {}) });
        return;
      } else {
        setPhase("reviewing", "reviewing · 型号证据不足；请手动修正，unknown 保持 unknown。", "warn");
        resultCopy = `待确认型号 · 参数保持 unknown${costCopy} · 尚未保存`;
      }
      const catalogSku = analysis.catalogMatch?.skuId ? options.getCatalogSku?.(analysis.catalogMatch.skuId) ?? null : null;
      const catalogCandidate = catalogSku ? catalogCandidateFromSku(catalogSku) : null;
      if (catalogCandidate?.canonicalUrl) record = { ...record, evidence: { ...record.evidence, officialUrl: catalogCandidate.canonicalUrl } };
      showReview(record, file, resultCopy, { ...(analysis.ocrText ? { ocrText: analysis.ocrText } : {}), ...(catalogCandidate ? { catalogCandidate } : {}) });
    } catch (error) {
      const aborted = controller.signal.aborted;
      setPhase(aborted && !timedOut ? "cancelled" : "failed", timedOut ? "识别超时；已保留截图，可直接重试或重新选择。" : aborted ? "已取消处理；截图未归档，可直接重试或重新选择。" : `识别失败：${error instanceof Error ? error.message : "本地服务不可用"}。已保留截图，可直接重试。`, aborted && !timedOut ? "warn" : "bad");
      retry.hidden = false;
    } finally {
      window.clearTimeout(timeoutId);
      readProgress.hidden = true;
      cancel.hidden = true;
      if (activeRequest === controller) activeRequest = null;
      input.disabled = false;
      delete drop.dataset.busy;
      input.value = "";
    }
  };

  const onCancel = () => activeRequest?.abort();
  const onRetry = () => { if (lastFile) void processFile(lastFile); };
  const onInput = () => { const file = input.files?.[0]; if (file) void processFile(file); };
  const onDragActive = (event: DragEvent) => { event.preventDefault(); drop.dataset.drag = "true"; };
  const onDragInactive = (event: DragEvent) => { event.preventDefault(); delete drop.dataset.drag; };
  const onDrop = (event: DragEvent) => { const file = event.dataTransfer?.files?.[0]; if (file) void processFile(file); };
  cancel.addEventListener("click", onCancel);
  retry.addEventListener("click", onRetry);
  input.addEventListener("change", onInput);
  for (const eventName of ["dragenter", "dragover"] as const) drop.addEventListener(eventName, onDragActive);
  for (const eventName of ["dragleave", "drop"] as const) drop.addEventListener(eventName, onDragInactive);
  drop.addEventListener("drop", onDrop);
  return {
    dispose() {
      activeRequest?.abort(); activeRequest = null;
      if (phaseTimer !== null) window.clearInterval(phaseTimer);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null; preview.removeAttribute("src");
      cancel.removeEventListener("click", onCancel); retry.removeEventListener("click", onRetry); input.removeEventListener("change", onInput);
      for (const eventName of ["dragenter", "dragover"] as const) drop.removeEventListener(eventName, onDragActive);
      for (const eventName of ["dragleave", "drop"] as const) drop.removeEventListener(eventName, onDragInactive);
      drop.removeEventListener("drop", onDrop);
      cancel.remove(); readProgress.remove();
      if (createdFlow) $("transaction-flow")?.remove();
    },
  };
}
