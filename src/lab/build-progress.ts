import type { BuildEvaluation } from "../core/evaluate";
import type { BuildLineItem } from "../config/types";
import type { PurchaseBucket, SkuCatalog, SkuRecord } from "../sku/types";
import { createTransactionScreenshotArchive, type TransactionArchiveRecord, type TransactionScreenshotArchive } from "./transaction-archive";
import type { PlanTransactionLink } from "../plans/contracts";

export const BUILD_PROGRESS_STORAGE_KEY = "build-sim.progress.v1";
export const BUILD_PROGRESS_PLAN_STORAGE_PREFIX = "build-sim.progress.v2:";

export const BUILD_STAGES = ["candidate", "locked", "purchased", "installed"] as const;
export type BuildStage = typeof BUILD_STAGES[number];

export const BUILD_STAGE_LABELS: Record<BuildStage, string> = {
  candidate: "候选",
  locked: "已锁定",
  purchased: "已购买",
  installed: "已安装",
};

export interface BuildProgressItem {
  id: string;
  skuId: string | null;
  name: string;
  category: string;
  qty: number;
  unitPriceCny: number | null;
  stage: BuildStage;
  source: "catalog" | "manual" | "transaction";
  overrides?: {
    name?: true;
    category?: true;
    qty?: true;
    unitPriceCny?: true;
  };
  planLink?: PlanTransactionLink;
  transaction?: TransactionEvidence;
}

export interface TransactionEvidence {
  receiptId: string;
  fileName: string;
  contentHash: string;
  capturedAt: string;
  ocrEngine: string;
  ocrConfidence: number | null;
  excerpt: string;
  verification: "matched-catalog" | "online-searching" | "catalog-candidate" | "catalog-draft" | "identity-review-required" | "search-no-result" | "search-failed";
  catalogJobId?: string | null;
  candidateId?: string | null;
  draftId?: string | null;
  officialUrl?: string | null;
  sourceReview?: "user-confirmed";
  screenshotArchive?: "server";
  screenshotStoredAt?: string | null;
  screenshotMimeType?: string | null;
  screenshotSize?: number | null;
}

export interface TransactionImportRecord {
  receiptId: string;
  skuId: string | null;
  name: string;
  category: string;
  qty: number;
  unitPriceCny: number | null;
  stage?: BuildStage;
  planLink?: PlanTransactionLink;
  evidence: TransactionEvidence;
}

export interface BuildProgressPlanContext {
  planId: string;
  planVersionId: string | null;
  planName: string;
  evaluation: BuildEvaluation;
}

export interface BuildProgressState {
  schemaVersion: 1;
  updatedAt: string;
  items: Record<string, BuildProgressItem>;
}

export interface BuildProgressSummary {
  total: number;
  candidate: number;
  locked: number;
  purchased: number;
  installed: number;
  knownSpentCny: number;
  unknownPurchasedPrice: number;
}

export interface PurchasePriceSummary {
  spentKnownCny: number;
  spentUnknownItems: number;
  remainingNowKnownCny: number;
  remainingNowUnknownItems: number;
  remainingFutureKnownCny: number;
  remainingFutureUnknownItems: number;
}

export interface BuildProgressController {
  syncEvaluation: (evaluation: BuildEvaluation) => void;
  activatePlan: (context: BuildProgressPlanContext) => void;
  stageTransaction: (record: TransactionImportRecord, screenshot?: File) => void;
  importTransaction: (record: TransactionImportRecord) => void;
  summary: () => BuildProgressSummary;
  items: () => BuildProgressItem[];
  pricing: () => PurchasePriceSummary;
  purchaseFacts: () => Array<{ skuId: string; stage: BuildStage; receiptId?: string; planId?: string | null; planItemId?: string | null; linkStatus?: PlanTransactionLink["linkStatus"] }>;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

const stageRank = new Map(BUILD_STAGES.map((stage, index) => [stage, index]));

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function now(): string {
  return new Date().toISOString();
}

function isBuildStage(value: unknown): value is BuildStage {
  return typeof value === "string" && BUILD_STAGES.includes(value as BuildStage);
}

export function stageForBucket(bucket: PurchaseBucket): BuildStage {
  return bucket === "owned" ? "purchased" : "candidate";
}

export function emptyProgressState(): BuildProgressState {
  return { schemaVersion: 1, updatedAt: now(), items: {} };
}

export function normalizeProgressState(input: unknown): BuildProgressState {
  if (!input || typeof input !== "object") return emptyProgressState();
  const candidate = input as Partial<BuildProgressState>;
  if (candidate.schemaVersion !== 1 || !candidate.items || typeof candidate.items !== "object") return emptyProgressState();
  const items: Record<string, BuildProgressItem> = {};
  for (const [id, raw] of Object.entries(candidate.items)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<BuildProgressItem>;
    if (!item.name || !isBuildStage(item.stage)) continue;
    const rawOverrides = item.overrides && typeof item.overrides === "object" ? item.overrides : {};
    const overrides: NonNullable<BuildProgressItem["overrides"]> = {
      ...(rawOverrides.name === true ? { name: true } : {}),
      ...(rawOverrides.category === true ? { category: true } : {}),
      ...(rawOverrides.qty === true ? { qty: true } : {}),
      ...(rawOverrides.unitPriceCny === true ? { unitPriceCny: true } : {}),
    };
    items[id] = {
      id,
      skuId: typeof item.skuId === "string" ? item.skuId : null,
      name: String(item.name),
      category: String(item.category ?? "其他"),
      qty: Number.isFinite(item.qty) ? Math.max(1, Math.round(Number(item.qty))) : 1,
      unitPriceCny: Number.isFinite(item.unitPriceCny) ? Math.max(0, Number(item.unitPriceCny)) : null,
      stage: item.stage,
      source: item.source === "manual" || item.source === "transaction" ? item.source : "catalog",
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(item.planLink && typeof item.planLink === "object" ? { planLink: item.planLink as PlanTransactionLink } : {}),
      ...(item.transaction && typeof item.transaction === "object" ? { transaction: item.transaction as TransactionEvidence } : {}),
    };
  }
  return { schemaVersion: 1, updatedAt: String(candidate.updatedAt ?? now()), items };
}

export function summarizeProgress(items: BuildProgressItem[]): BuildProgressSummary {
  const summary: BuildProgressSummary = {
    total: items.length,
    candidate: 0,
    locked: 0,
    purchased: 0,
    installed: 0,
    knownSpentCny: 0,
    unknownPurchasedPrice: 0,
  };
  for (const item of items) {
    summary[item.stage] += 1;
    const rank = stageRank.get(item.stage) ?? 0;
    if (rank >= (stageRank.get("purchased") ?? 2)) {
      if (item.unitPriceCny === null) summary.unknownPurchasedPrice += 1;
      else summary.knownSpentCny += item.unitPriceCny * item.qty;
    }
  }
  return summary;
}

export function summarizePurchasePricing(evaluation: BuildEvaluation | null, items: BuildProgressItem[]): PurchasePriceSummary {
  const progress = summarizeProgress(items);
  const result: PurchasePriceSummary = {
    spentKnownCny: progress.knownSpentCny,
    spentUnknownItems: progress.unknownPurchasedPrice,
    remainingNowKnownCny: 0,
    remainingNowUnknownItems: 0,
    remainingFutureKnownCny: 0,
    remainingFutureUnknownItems: 0,
  };
  if (!evaluation) return result;

  const progressBySku = new Map(items.filter((item) => item.skuId).map((item) => [item.skuId, item]));
  const priceBySku = new Map(evaluation.price.items.map((item) => [item.skuId, item]));
  for (const line of evaluation.bom) {
    const item = progressBySku.get(line.skuId);
    const purchased = item?.stage === "purchased" || item?.stage === "installed";
    if (purchased) continue;
    const price = priceBySku.get(line.skuId)?.priceCny ?? null;
    const future = line.bucket === "upgrade_later";
    if (price === null) {
      if (future) result.remainingFutureUnknownItems += 1;
      else result.remainingNowUnknownItems += 1;
    } else if (future) result.remainingFutureKnownCny += price * line.qty;
    else result.remainingNowKnownCny += price * line.qty;
  }
  return result;
}

function priceForSku(sku: SkuRecord): number | null {
  if (typeof sku.price.paid === "number") return sku.price.paid;
  if (typeof sku.price.current === "number") return sku.price.current;
  return null;
}

function categoryLabel(category: string): string {
  return ({
    case: "机箱", motherboard: "主板", cpu: "处理器", psu: "电源", cooler: "散热器",
    gpu: "显卡", memory: "内存", storage: "存储", hba: "HBA", fan: "风扇", accessory: "配件",
  } as Record<string, string>)[category] ?? category;
}

function formatCny(value: number): string {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function verificationLabel(value: TransactionEvidence["verification"]): string {
  return ({
    "matched-catalog": "已匹配正式 SKU",
    "online-searching": "联网补参中",
    "catalog-candidate": "已关联官网候选",
    "catalog-draft": "官方参数草稿待确认",
    "identity-review-required": "型号待确认",
    "search-no-result": "官网参数未找到",
    "search-failed": "官网搜索失败",
  } as Record<TransactionEvidence["verification"], string>)[value];
}

function safeOfficialUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : null; } catch { return null; }
}

function stageOptions(selected: BuildStage): string {
  return BUILD_STAGES.map((stage) => `<option value="${stage}"${stage === selected ? " selected" : ""}>${BUILD_STAGE_LABELS[stage]}</option>`).join("");
}

const EDITABLE_CATEGORIES = ["case", "motherboard", "cpu", "psu", "cooler", "gpu", "memory", "storage", "hba", "fan", "accessory", "其他"];

function categoryOptions(selected: string, disabled = false): string {
  const values = EDITABLE_CATEGORIES.includes(selected) ? EDITABLE_CATEGORIES : [selected, ...EDITABLE_CATEGORIES];
  return values.map((category) => `<option value="${esc(category)}"${category === selected ? " selected" : ""}${disabled ? " disabled" : ""}>${esc(categoryLabel(category))}</option>`).join("");
}

function storageKey(planId: string | null): string {
  return planId ? `${BUILD_PROGRESS_PLAN_STORAGE_PREFIX}${planId}` : BUILD_PROGRESS_STORAGE_KEY;
}

function loadState(planId: string | null): BuildProgressState {
  try {
    const raw = window.localStorage.getItem(storageKey(planId));
    return raw ? normalizeProgressState(JSON.parse(raw)) : emptyProgressState();
  } catch {
    return emptyProgressState();
  }
}

function persistState(state: BuildProgressState, planId: string | null): void {
  state.updatedAt = now();
  try {
    window.localStorage.setItem(storageKey(planId), JSON.stringify(state));
  } catch {
    // The UI remains usable when storage is disabled; only cross-refresh persistence is lost.
  }
}

export function initBuildProgress(args: {
  getCatalog: () => SkuCatalog;
  baseSkuIds: string[];
  getPlanContext?: () => BuildProgressPlanContext | null;
  getPlans?: () => Array<{ id: string; name: string }>;
  screenshotArchive?: TransactionScreenshotArchive;
  onTransactionsArchived?: (items: BuildProgressItem[]) => string[] | void;
}): BuildProgressController {
  const initialPlan = args.getPlanContext?.() ?? null;
  let activePlanId = initialPlan?.planId ?? null;
  let activePlanVersionId = initialPlan?.planVersionId ?? null;
  let state = loadState(activePlanId);
  let currentBom: BuildLineItem[] = initialPlan?.evaluation.bom ?? [];
  let currentEvaluation: BuildEvaluation | null = initialPlan?.evaluation ?? null;
  const pendingTransactions = new Map<string, BuildProgressItem>();
  const pendingScreenshotDeletes = new Set<string>();
  const pendingArchiveDeletes = new Set<string>();
  const screenshotArchive = args.screenshotArchive ?? createTransactionScreenshotArchive();
  const screenshotObjectUrls = new Set<string>();
  const listeners = new Set<() => void>();
  let transactionRenderToken = 0;
  let editorDirty = false;
  let deferredPlanContext: BuildProgressPlanContext | null = null;

  const dialog = $("build-base-dialog") as HTMLDialogElement | null;
  const editor = $("build-base-editor");
  const currentPanel = $("build-review-current-panel");
  const transactionsPanel = $("build-review-transactions-panel");
  const historyStatus = $("transaction-history-status");
  let historyToolbar = document.querySelector<HTMLElement>(".transaction-history-toolbar");
  if (!historyToolbar && historyStatus) {
    historyToolbar = document.createElement("div"); historyToolbar.className = "transaction-history-toolbar"; historyStatus.parentElement?.insertBefore(historyToolbar, historyStatus);
  }
  const ensureHistoryControl = <T extends HTMLInputElement | HTMLSelectElement>(id: string, create: () => T): T | null => {
    const existing = document.getElementById(id) as T | null;
    if (existing) return existing;
    const control = create(); control.id = id; historyToolbar?.append(control); return control;
  };
  const historySearch = ensureHistoryControl("transaction-history-search", () => { const input = document.createElement("input"); input.type = "search"; input.placeholder = "搜索商品、分类、文件名或方案"; input.setAttribute("aria-label", "搜索交易"); return input; });
  const historyStateFilter = ensureHistoryControl("transaction-history-filter", () => { const select = document.createElement("select"); select.innerHTML = '<option value="all">全部状态</option><option value="pending">待保存</option><option value="archived">已归档</option>'; select.setAttribute("aria-label", "交易归档状态"); return select; });
  const historyPlanFilter = ensureHistoryControl("transaction-history-plan-filter", () => { const select = document.createElement("select"); select.setAttribute("aria-label", "交易方案筛选"); return select; });
  const historyCategoryFilter = ensureHistoryControl("transaction-history-category-filter", () => { const select = document.createElement("select"); select.innerHTML = '<option value="all">全部分类</option>'; select.setAttribute("aria-label", "交易分类筛选"); return select; });
  const historySort = ensureHistoryControl("transaction-history-sort", () => { const select = document.createElement("select"); select.innerHTML = '<option value="updated-desc">最近更新</option><option value="price-desc">金额从高到低</option><option value="name-asc">商品名称</option>'; select.setAttribute("aria-label", "交易排序"); return select; });

  const currentCatalogItems = (): BuildProgressItem[] => currentBom
    .map((line) => state.items[line.skuId])
    .filter((item): item is BuildProgressItem => Boolean(item));

  const currentItems = (): BuildProgressItem[] => [
    ...currentCatalogItems(),
    ...Object.values(state.items).filter((item) => item.source !== "catalog"),
  ];

  const ensureLine = (line: BuildLineItem): void => {
    const sku = args.getCatalog().skus.find((entry) => entry.id === line.skuId);
    if (!sku) return;
    const existing = state.items[line.skuId];
    const overrides = existing?.overrides;
    const keepRecordedValue = Boolean(existing?.transaction);
    state.items[line.skuId] = {
      id: line.skuId,
      skuId: line.skuId,
      name: overrides?.name ? existing?.name ?? sku.name : sku.name,
      category: overrides?.category ? existing?.category ?? sku.category : sku.category,
      qty: overrides?.qty || keepRecordedValue ? existing?.qty ?? line.qty : line.qty,
      unitPriceCny: overrides?.unitPriceCny || keepRecordedValue ? existing?.unitPriceCny ?? null : existing?.unitPriceCny ?? priceForSku(sku),
      stage: existing?.stage ?? stageForBucket(line.bucket),
      source: "catalog",
      ...(overrides && Object.keys(overrides).length ? { overrides } : {}),
      ...(existing?.planLink ? { planLink: existing.planLink } : {}),
      ...(existing?.transaction ? { transaction: existing.transaction } : {}),
    };
  };

  const applyPlanContext = (context: BuildProgressPlanContext): void => {
    activePlanId = context.planId;
    activePlanVersionId = context.planVersionId;
    state = loadState(activePlanId);
    currentEvaluation = context.evaluation;
    currentBom = context.evaluation.bom;
    for (const line of currentBom) ensureLine(line);
  };

  const renderHero = (): void => {
    const host = $("build-base-summary");
    const progress = $("build-hero-progress");
    if (!host || !progress) return;
    const base = currentItems();
    const summary = summarizeProgress(currentItems());
    host.innerHTML = base.map((item) => `<div class="build-base-row"><span><small>${esc(categoryLabel(item.category))}</small>${esc(item.name)}</span><b>${item.unitPriceCny === null ? "价格待补" : formatCny(item.unitPriceCny)}</b><em data-stage="${item.stage}">${BUILD_STAGE_LABELS[item.stage]}</em></div>`).join("");
    const purchased = summary.purchased + summary.installed;
    progress.innerHTML = `<div class="build-progress-copy"><span><b>${purchased}</b> / ${summary.total} 已购买</span><span><b>${summary.installed}</b> / ${summary.total} 已安装</span></div><div class="build-progress-track"><i style="width:${summary.total ? Math.round(summary.installed / summary.total * 100) : 0}%"></i></div><strong><small>已记录投入</small>${formatCny(summary.knownSpentCny)}${summary.unknownPurchasedPrice ? ` <span>+ ${summary.unknownPurchasedPrice} 项价格待补</span>` : ""}</strong>`;
  };

  const renderProgressSummary = (): void => {
    const host = $("build-progress-summary");
    if (!host) return;
    const summary = summarizeProgress(currentItems());
    const purchased = summary.purchased + summary.installed;
    host.innerHTML = `<div><span>候选 <b>${summary.candidate}</b></span><span>锁定 <b>${summary.locked}</b></span><span>已购买 <b>${purchased}</b></span><span>已安装 <b>${summary.installed}</b></span></div><p>先锁定方案，再逐项记录成交价和安装状态。进度保存在当前浏览器。</p>`;
  };

  const renderBom = (): void => {
    const host = $("next-buy-list");
    if (!host) return;
    const rows = currentItems();
    host.innerHTML = rows.map((item) => `<li data-stage="${item.stage}" data-source="${item.source}"><span class="bom-qty">${item.qty}×</span><span class="bom-name">${esc(item.name)}${item.source === "manual" ? " <small>用户记录</small>" : item.transaction ? ` <small data-verification="${item.transaction.verification}">交易截图 · ${verificationLabel(item.transaction.verification)}</small>` : ""}</span><span class="bom-price">${item.unitPriceCny === null ? "价格待补" : formatCny(item.unitPriceCny)}</span><select class="bom-stage-select" data-progress-id="${esc(item.id)}" aria-label="${esc(item.name)}状态">${stageOptions(item.stage)}</select></li>`).join("");
  };

  const render = (): void => {
    renderHero();
    renderProgressSummary();
    renderBom();
    if (dialog?.dataset.routeSurface === "true") {
      if (editorDirty) {
        updateSaveState();
        renderCurrentReviewSummary();
      } else renderEditor();
    }
    for (const listener of listeners) listener();
  };

  const effectiveItems = (): BuildProgressItem[] => {
    const byId = new Map(currentItems().map((item) => [item.id, item]));
    for (const item of pendingTransactions.values()) byId.set(item.id, item);
    return [...byId.values()];
  };

  const renderCurrentReviewSummary = (): void => {
    const host = $("build-review-current-summary");
    const items = effectiveItems();
    const summary = summarizeProgress(items);
    const transactions = items.filter((item) => item.transaction).length;
    if (host) host.innerHTML = `<article><small>配置部件</small><strong>${summary.total}</strong><span>${summary.candidate} 候选 · ${summary.locked} 锁定</span></article><article><small>采购进度</small><strong>${summary.purchased + summary.installed}</strong><span>${summary.installed} 项已安装</span></article><article><small>已记录投入</small><strong>${formatCny(summary.knownSpentCny)}</strong><span>${summary.unknownPurchasedPrice ? `${summary.unknownPurchasedPrice} 项价格待补` : "成交价已补齐"}</span></article><article><small>交易凭证</small><strong>${transactions}</strong><span>${pendingTransactions.size ? `${pendingTransactions.size} 项待保存` : "暂无待保存识别"}</span></article>`;
    const currentCount = $("build-review-current-count");
    const transactionCount = $("build-review-transaction-count");
    if (currentCount) currentCount.textContent = `${summary.total} 项`;
    if (transactionCount) transactionCount.textContent = `${transactions} 笔`;
  };

  const clearScreenshotObjectUrls = (): void => {
    for (const url of screenshotObjectUrls) URL.revokeObjectURL(url);
    screenshotObjectUrls.clear();
  };

  const formatArchiveDate = (value: string): string => {
    if (!value) return "待保存";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };

  const formatBytes = (value: number): string => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1_000))} KB`;

  const effectiveLinkStatus = (record: TransactionArchiveRecord): PlanTransactionLink["linkStatus"] => {
    if (record.link.linkStatus !== "linked" || record.link.planId !== activePlanId) return record.link.linkStatus;
    if (record.link.planItemId === "gpu.primary" && record.item.category === "gpu") return "linked";
    return currentBom.some((line) => line.skuId === record.link.planItemId) ? "linked" : "stale";
  };

  const transactionCard = (record: TransactionArchiveRecord): string => {
    const item = record.item;
    const evidence = item.transaction;
    const pending = Boolean(record.pendingFile);
    const deletingImage = pendingScreenshotDeletes.has(record.receiptId);
    const officialUrl = safeOfficialUrl(evidence?.officialUrl as string | null | undefined);
    const activeItems: Array<Pick<BuildProgressItem, "id" | "category" | "name">> = currentBom.map((line) => state.items[line.skuId]).filter((entry): entry is BuildProgressItem => Boolean(entry));
    if (!activeItems.some((entry) => entry.category === "gpu")) activeItems.push({ id: "gpu.primary", category: "gpu", name: "显卡未配置（可关联购买记录）" });
    const linkOptions = [`<option value="">未关联采购项</option>`, ...activeItems.map((entry) => `<option value="${esc(entry.id)}"${record.link.planId === activePlanId && record.link.planItemId === entry.id ? " selected" : ""}>${esc(categoryLabel(entry.category))} · ${esc(entry.name)}</option>`)].join("");
    const planName = args.getPlans?.().find((plan) => plan.id === record.link.planId)?.name ?? record.link.planId;
    const linkStatus = effectiveLinkStatus(record);
    const titleControl = record.localOnly ? `<strong>${esc(item.name)}</strong>` : `<input data-archive-edit-name value="${esc(item.name)}" aria-label="交易商品摘要">`;
    const localAction = item.source === "catalog" ? "解除本机凭证引用" : "清除本机采购记录";
    const pendingActions = record.image && !deletingImage ? `<a class="case-view-btn" data-archive-open="${esc(record.receiptId)}" target="_blank" rel="noreferrer">查看待保存原图</a>` : "";
    const remoteActions = `<label>关联当前方案部件<select data-archive-link-item>${linkOptions}</select></label><button type="button" class="case-view-btn" data-archive-update="${esc(record.receiptId)}">保存摘要与关联</button>${record.image && !deletingImage ? `<a class="case-view-btn" data-archive-open="${esc(record.receiptId)}" target="_blank" rel="noreferrer">查看原图</a><button type="button" class="case-view-btn" data-archive-delete-image="${esc(record.receiptId)}">删除原图</button>` : ""}<button type="button" class="case-view-btn danger" data-archive-delete-record="${esc(record.receiptId)}">删除整笔档案</button>`;
    return `<article class="transaction-history-card${pending ? " is-pending" : ""}" data-archive-receipt="${esc(record.receiptId)}"${record.localOnly ? " data-local-only=\"true\"" : ""}>
      <div class="transaction-history-visual">${record.image && !deletingImage ? `<img alt="${esc(item.name)} 的交易截图" data-archive-image="${esc(record.receiptId)}">` : `<span>${deletingImage ? "原图待删除" : "仅保留交易摘要"}</span>`}</div>
      <div class="transaction-history-copy"><div><small>${pending ? "待保存" : record.localOnly ? "仅本机采购状态 · 没有可操作的服务器档案" : "服务器已归档"} · ${esc(formatArchiveDate(record.storedAt))}</small>${titleControl}</div><p>${esc(categoryLabel(item.category))} · ${item.qty} 件 · ${item.unitPriceCny === null ? "价格待确认" : formatCny(item.unitPriceCny)} · ${esc(BUILD_STAGE_LABELS[item.stage as BuildStage] ?? item.stage)}</p><p data-link-status="${linkStatus}">${linkStatus === "linked" ? `已关联 ${esc(planName ?? "方案")} / ${esc(record.link.planItemId ?? "")}` : linkStatus === "stale" ? `原方案关联已失效 · ${esc(planName ?? "未知方案")}` : "暂未关联方案"}</p><p>${evidence ? `${esc(evidence.fileName)} · ${esc(verificationLabel(evidence.verification as TransactionEvidence["verification"]))} · ${esc(evidence.ocrEngine)}` : "交易证据待补"}${record.image ? ` · ${formatBytes(record.image.bytes)}` : ""}${officialUrl ? ` · <a href="${esc(officialUrl)}" target="_blank" rel="noreferrer">官网来源</a>` : ""}</p>${record.localOnly ? "<p>这条记录只存在于当前浏览器；服务器关联、原图和删除操作不可用。</p>" : ""}</div>
      <div class="transaction-history-actions">${pending ? pendingActions : record.localOnly ? `<button type="button" class="case-view-btn danger" data-local-clear-transaction="${esc(record.receiptId)}">${localAction}</button>` : remoteActions}</div>
    </article>`;
  };

  const renderTransactionHistory = async (): Promise<void> => {
    const host = $("transaction-history-list");
    const status = $("transaction-history-status");
    if (!host || !status) return;
    const token = ++transactionRenderToken;
    clearScreenshotObjectUrls();
    status.textContent = "正在读取服务器档案…";
    status.dataset.level = "busy";
    try {
      const remoteRecords = (await screenshotArchive.list()).filter((record) => !pendingArchiveDeletes.has(record.receiptId));
      const pendingRecords = [...pendingTransactions.values()]
        .filter((item) => item.transaction)
        .map((item) => screenshotArchive.pendingRecord(item.transaction!.receiptId, item))
        .filter((record): record is TransactionArchiveRecord => Boolean(record));
      if (token !== transactionRenderToken) return;
      const projectedRecords: TransactionArchiveRecord[] = effectiveItems().filter((item) => item.transaction).map((item) => ({
        schemaVersion: 2,
        receiptId: item.transaction!.receiptId,
        storedAt: item.transaction!.screenshotStoredAt ?? item.transaction!.capturedAt,
        updatedAt: item.transaction!.screenshotStoredAt ?? item.transaction!.capturedAt,
        item,
        link: item.planLink ?? { schemaVersion: "1.0.0", planId: activePlanId, planVersionIdAtCapture: activePlanVersionId, planItemId: item.id, linkStatus: activePlanId ? "linked" : "unlinked" },
        image: null,
        localOnly: true,
      }));
      const knownIds = new Set([...pendingRecords, ...remoteRecords].map((record) => record.receiptId));
      const allRecords = [...pendingRecords, ...remoteRecords.filter((record) => !pendingRecords.some((pending) => pending.receiptId === record.receiptId)), ...projectedRecords.filter((record) => !knownIds.has(record.receiptId))];
      const previousPlanFilter = historyPlanFilter?.value;
      if (historyPlanFilter) {
        const plans = args.getPlans?.() ?? [];
        historyPlanFilter.innerHTML = `<option value="all">全部方案与待整理记录</option><option value="unlinked">尚未关联方案</option>${plans.map((plan) => `<option value="${esc(plan.id)}">${esc(plan.name)}</option>`).join("")}`;
        historyPlanFilter.value = previousPlanFilter && [...historyPlanFilter.options].some((option) => option.value === previousPlanFilter) ? previousPlanFilter : "all";
      }
      const previousCategory = historyCategoryFilter?.value;
      if (historyCategoryFilter) {
        const categories = [...new Set(allRecords.map((record) => record.item.category))].sort();
        historyCategoryFilter.innerHTML = `<option value="all">全部分类</option>${categories.map((category) => `<option value="${esc(category)}">${esc(categoryLabel(category))}</option>`).join("")}`;
        historyCategoryFilter.value = previousCategory && categories.includes(previousCategory) ? previousCategory : "all";
      }
      const query = historySearch?.value.trim().toLocaleLowerCase() ?? "";
      const planFilter = historyPlanFilter?.value || "all";
      const stateFilter = historyStateFilter?.value || "all";
      const categoryFilter = historyCategoryFilter?.value || "all";
      const records = allRecords.filter((record) => {
        const pending = Boolean(record.pendingFile);
        const searchable = `${record.item.name} ${record.item.category} ${record.item.transaction?.fileName ?? ""} ${record.link.planId ?? ""}`.toLocaleLowerCase();
        return (!query || searchable.includes(query))
          && (planFilter === "all" || planFilter === "unlinked" ? planFilter === "all" || effectiveLinkStatus(record) !== "linked" : record.link.planId === planFilter)
          && (stateFilter === "all" || stateFilter === (pending ? "pending" : "archived"))
          && (categoryFilter === "all" || record.item.category === categoryFilter);
      }).sort((left, right) => historySort?.value === "price-desc" ? ((right.item.unitPriceCny ?? -1) * right.item.qty) - ((left.item.unitPriceCny ?? -1) * left.item.qty) : historySort?.value === "name-asc" ? left.item.name.localeCompare(right.item.name, "zh-CN") : right.updatedAt.localeCompare(left.updatedAt));
      host.innerHTML = records.length ? records.map(transactionCard).join("") : allRecords.length ? `<div class="transaction-history-empty"><strong>当前筛选隐藏了全部 ${allRecords.length} 笔记录</strong><p>清除搜索或把方案、分类和状态改为“全部”，即可重新显示。</p><button type="button" class="case-view-btn" data-archive-clear-filters>清除筛选</button></div>` : `<div class="transaction-history-empty"><strong>还没有交易记录</strong><p>上传订单截图、核对识别结果并保存后，会在这里形成可复核记录。</p></div>`;
      for (const record of records) {
        const image = host.querySelector<HTMLImageElement>(`[data-archive-image="${CSS.escape(record.receiptId)}"]`);
        const open = host.querySelector<HTMLAnchorElement>(`[data-archive-open="${CSS.escape(record.receiptId)}"]`);
        if (!record.image) continue;
        const imageUrl = record.pendingFile ? URL.createObjectURL(record.pendingFile) : record.image.imageUrl;
        if (record.pendingFile) screenshotObjectUrls.add(imageUrl);
        if (image) image.src = imageUrl;
        if (open) open.href = imageUrl;
      }
      const count = $("build-review-transaction-count");
      if (count) count.textContent = `${allRecords.length} 笔`;
      status.textContent = `${allRecords.length} 笔记录 · 当前显示 ${records.length} 笔${pendingRecords.length ? ` · ${pendingRecords.length} 笔待保存` : ""}${projectedRecords.some((record) => record.localOnly && !knownIds.has(record.receiptId)) ? " · 含仅保存在本机的采购状态" : ""}${pendingScreenshotDeletes.size || pendingArchiveDeletes.size ? " · 有删除操作待保存" : ""}`;
      status.dataset.level = pendingRecords.length || pendingScreenshotDeletes.size || pendingArchiveDeletes.size ? "pending" : "ok";
    } catch (error) {
      if (token !== transactionRenderToken) return;
      const local = effectiveItems().filter((item) => item.transaction);
      const localRecords = local.map((item): TransactionArchiveRecord => {
        const staged = pendingTransactions.has(item.id) ? screenshotArchive.pendingRecord(item.transaction!.receiptId, item) : null;
        return staged ?? { schemaVersion: 2, receiptId: item.transaction!.receiptId, storedAt: item.transaction!.screenshotStoredAt ?? item.transaction!.capturedAt, updatedAt: item.transaction!.capturedAt, item, link: item.planLink ?? { schemaVersion: "1.0.0", planId: activePlanId, planVersionIdAtCapture: activePlanVersionId, planItemId: item.id, linkStatus: activePlanId ? "linked" : "unlinked" }, image: null, localOnly: true };
      });
      host.innerHTML = localRecords.length ? localRecords.map(transactionCard).join("") : "";
      for (const record of localRecords) {
        if (!record.pendingFile || !record.image) continue;
        const imageUrl = URL.createObjectURL(record.pendingFile);
        screenshotObjectUrls.add(imageUrl);
        const image = host.querySelector<HTMLImageElement>(`[data-archive-image="${CSS.escape(record.receiptId)}"]`);
        const open = host.querySelector<HTMLAnchorElement>(`[data-archive-open="${CSS.escape(record.receiptId)}"]`);
        if (image) image.src = imageUrl;
        if (open) open.href = imageUrl;
      }
      status.textContent = `服务器档案暂时不可用${local.length ? `；仍显示 ${local.length} 笔本地摘要` : ""}：${error instanceof Error ? error.message : "服务不可用"}`;
      status.dataset.level = "bad";
    }
  };

  const setReviewTab = (tab: "current" | "transactions"): void => {
    const currentTab = $("build-review-current-tab");
    const transactionsTab = $("build-review-transactions-tab");
    if (currentPanel) currentPanel.hidden = tab !== "current";
    if (transactionsPanel) transactionsPanel.hidden = tab !== "transactions";
    currentTab?.setAttribute("aria-selected", String(tab === "current"));
    transactionsTab?.setAttribute("aria-selected", String(tab === "transactions"));
    if (tab === "transactions") void renderTransactionHistory();
  };

  const editorRow = (item: BuildProgressItem): string => {
    const officialUrl = safeOfficialUrl(item.transaction?.officialUrl);
    return `<div class="build-editor-row${pendingTransactions.has(item.id) ? " is-pending" : ""}" data-progress-row data-progress-id="${esc(item.id)}" data-source="${item.source}">
    <div class="build-editor-identity"><small>${item.source === "manual" ? "用户记录" : item.transaction ? "交易截图" : "正式 SKU · 显示信息可编辑"}${pendingTransactions.has(item.id) ? " · 待保存" : ""}</small><input class="build-editor-name" value="${esc(item.name)}">${item.transaction ? `<span class="build-transaction-proof">${esc(item.transaction.fileName)} · ${verificationLabel(item.transaction.verification)}${officialUrl ? ` · <a href="${esc(officialUrl)}" target="_blank" rel="noreferrer">查看官网来源</a>` : ""}</span>` : ""}</div>
    <label>分类<select class="build-editor-category">${categoryOptions(item.category)}</select></label>
    <label>数量<input class="build-editor-qty" type="number" min="1" max="99" step="1" value="${item.qty}"></label>
    <label>单价 ¥<input class="build-editor-price" type="number" min="0" step="1" value="${item.unitPriceCny ?? ""}" placeholder="待补"></label>
    <label>状态<select class="build-editor-stage">${stageOptions(item.stage)}</select></label>
    ${item.source !== "catalog" ? `<button type="button" class="build-remove-custom case-view-btn" aria-label="移除 ${esc(item.name)}">移除</button>` : ""}
  </div>`;
  };

  const pendingOperationCount = (): number => pendingTransactions.size + pendingScreenshotDeletes.size + pendingArchiveDeletes.size;

  const unsavedChangeCount = (): number => pendingOperationCount() + (editorDirty ? 1 : 0);

  const updateSaveState = (): void => {
    const button = $("build-base-save") as HTMLButtonElement | null;
    const status = $("build-base-save-status");
    const count = unsavedChangeCount();
    if (button) button.textContent = count ? `保存采购记录（${count} 项待保存）` : "保存采购记录";
    if (status) {
      status.textContent = count
        ? `${editorDirty ? "表单有未保存修改" : ""}${editorDirty && pendingOperationCount() ? "；" : ""}${pendingOperationCount() ? "识别结果或档案操作尚未生效" : ""}。请点击“保存采购记录”，或取消时明确确认放弃。`
        : "你在这里的修改会在点击“保存采购记录”后生效。";
      status.dataset.level = count ? "pending" : "idle";
      status.dataset.phase = count ? "staged" : "idle";
      status.dataset.dirty = String(Boolean(count));
    }
  };

  const renderEditor = (): void => {
    if (!editor) return;
    const rows = currentItems();
    const ids = new Set(rows.map((item) => item.id));
    const renderedItems = [
      ...rows.map((item) => pendingTransactions.get(item.id) ?? item),
      ...[...pendingTransactions.values()].filter((item) => !ids.has(item.id)),
    ];
    editor.innerHTML = renderedItems.map(editorRow).join("");
    for (const item of renderedItems) {
      const row = [...editor.querySelectorAll<HTMLElement>("[data-progress-row]")].find((candidate) => candidate.dataset.progressId === item.id);
      const category = row?.querySelector<HTMLSelectElement>(".build-editor-category");
      const stage = row?.querySelector<HTMLSelectElement>(".build-editor-stage");
      if (category) category.value = item.category;
      if (stage) stage.value = item.stage;
    }
    updateSaveState();
    renderCurrentReviewSummary();
  };

  const openEditor = (): void => {
    if (!dialog || !editor) return;
    if (!editorDirty) renderEditor();
    else updateSaveState();
    setReviewTab("current");
    if (!dialog.open) {
      if (dialog.dataset.routeSurface === "true") dialog.setAttribute("open", "");
      else dialog.showModal();
    }
  };

  const closeEditor = (discardPending = true, protectPending = false): void => {
    const pendingCount = unsavedChangeCount();
    if (protectPending && pendingCount && !window.confirm(`${pendingCount} 项采购更改尚未保存。确认放弃这些更改？`)) {
      updateSaveState();
      return;
    }
    if (discardPending) {
      pendingTransactions.clear();
      pendingScreenshotDeletes.clear();
      pendingArchiveDeletes.clear();
      screenshotArchive.discard();
      editorDirty = false;
      if (deferredPlanContext) {
        const nextContext = deferredPlanContext;
        deferredPlanContext = null;
        applyPlanContext(nextContext);
      }
    }
    clearScreenshotObjectUrls();
    updateSaveState();
    if (dialog?.dataset.routeSurface === "true") {
      dialog.setAttribute("open", "");
      renderEditor();
      setReviewTab("current");
    } else dialog?.close();
  };

  $("build-base-edit")?.addEventListener("click", openEditor);
  $("build-base-close")?.addEventListener("click", () => closeEditor(true, true));
  $("build-base-cancel")?.addEventListener("click", () => closeEditor(true, true));
  $("build-review-current-tab")?.addEventListener("click", () => setReviewTab("current"));
  $("build-review-transactions-tab")?.addEventListener("click", () => setReviewTab("transactions"));
  $("transaction-history-refresh")?.addEventListener("click", () => void renderTransactionHistory());
  historySearch?.addEventListener("input", () => void renderTransactionHistory());
  for (const control of [historyStateFilter, historyPlanFilter, historyCategoryFilter, historySort]) control?.addEventListener("change", () => void renderTransactionHistory());
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeEditor(true, true);
  });
  dialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEditor(true, true);
  });

  $("build-add-custom")?.addEventListener("click", () => {
    if (!editor) return;
    const id = `manual-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    const item: BuildProgressItem = { id, skuId: null, name: "待补充部件", category: "其他", qty: 1, unitPriceCny: null, stage: "candidate", source: "manual" };
    editor.insertAdjacentHTML("beforeend", editorRow(item));
    editorDirty = true;
    updateSaveState();
  });

  editor?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest(".build-remove-custom");
    const row = button?.closest<HTMLElement>("[data-progress-row]");
    const pending = row?.dataset.progressId ? pendingTransactions.get(row.dataset.progressId) : null;
    if (pending?.transaction && row?.dataset.progressId) {
      pendingTransactions.delete(row.dataset.progressId);
      screenshotArchive.discard([pending.transaction.receiptId]);
    }
    row?.remove();
    if (button) {
      editorDirty = true;
      updateSaveState();
      renderCurrentReviewSummary();
    }
  });

  const markEditorDirty = (): void => {
    editorDirty = true;
    updateSaveState();
    renderCurrentReviewSummary();
  };
  editor?.addEventListener("input", markEditorDirty);
  editor?.addEventListener("change", markEditorDirty);

  $("transaction-history-list")?.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest("[data-archive-clear-filters]")) {
      if (historySearch) historySearch.value = "";
      if (historyStateFilter) historyStateFilter.value = "all";
      if (historyPlanFilter) historyPlanFilter.value = "all";
      if (historyCategoryFilter) historyCategoryFilter.value = "all";
      void renderTransactionHistory();
      return;
    }
    const localClearButton = target.closest<HTMLElement>("[data-local-clear-transaction]");
    if (localClearButton?.dataset.localClearTransaction) {
      const receiptId = localClearButton.dataset.localClearTransaction;
      const localEntry = Object.entries(state.items).find(([, item]) => item.transaction?.receiptId === receiptId);
      const pendingEntry = [...pendingTransactions.entries()].find(([, item]) => item.transaction?.receiptId === receiptId);
      const targetEntry = localEntry ?? pendingEntry;
      if (!targetEntry) return;
      const [id, item] = targetEntry;
      const actionCopy = item.source === "catalog" ? "解除这条本机凭证引用" : "清除这条仅保存在本机的采购记录";
      if (!window.confirm(`${actionCopy}？这不会调用服务器，也不会删除服务器档案。`)) return;
      if (pendingEntry) {
        pendingTransactions.delete(id);
        screenshotArchive.discard([receiptId]);
        [...(editor?.querySelectorAll<HTMLElement>("[data-progress-row]") ?? [])].find((row) => row.dataset.progressId === id)?.remove();
      } else if (item.source === "catalog") {
        delete item.transaction;
        delete item.planLink;
      } else delete state.items[id];
      if (localEntry) persistState(state, activePlanId);
      if (historyStatus) {
        historyStatus.textContent = item.source === "catalog" ? "已解除本机凭证引用；服务器档案未改动。" : "已清除本机采购记录；服务器档案未改动。";
        historyStatus.dataset.level = "ok";
      }
      render();
      void renderTransactionHistory();
      return;
    }
    const updateButton = target.closest<HTMLElement>("[data-archive-update]");
    if (updateButton?.dataset.archiveUpdate) {
      const receiptId = updateButton.dataset.archiveUpdate;
      const card = updateButton.closest<HTMLElement>("[data-archive-receipt]");
      const planItemId = card?.querySelector<HTMLSelectElement>("[data-archive-link-item]")?.value || null;
      const name = card?.querySelector<HTMLInputElement>("[data-archive-edit-name]")?.value.trim();
      const link: PlanTransactionLink = { schemaVersion: "1.0.0", planId: activePlanId, planVersionIdAtCapture: activePlanVersionId, planItemId, linkStatus: activePlanId && planItemId ? "linked" : "unlinked" };
      updateButton.setAttribute("aria-busy", "true");
      void screenshotArchive.updateRecord(receiptId, { ...(name ? { item: { name } } : {}), link }).then(() => {
        const projected = Object.values(state.items).find((item) => item.transaction?.receiptId === receiptId);
        if (projected) {
          projected.planLink = link;
          if (name) projected.name = name;
          persistState(state, activePlanId);
        }
        if (historyStatus) { historyStatus.textContent = "交易摘要与方案关联已更新。"; historyStatus.dataset.level = "ok"; }
        return renderTransactionHistory();
      }).catch((error) => {
        if (historyStatus) { historyStatus.textContent = `更新失败：${error instanceof Error ? error.message : "服务不可用"}`; historyStatus.dataset.level = "bad"; }
      }).finally(() => updateButton.removeAttribute("aria-busy"));
      return;
    }
    const imageButton = target.closest<HTMLElement>("[data-archive-delete-image]");
    const recordButton = target.closest<HTMLElement>("[data-archive-delete-record]");
    const receiptId = imageButton?.dataset.archiveDeleteImage ?? recordButton?.dataset.archiveDeleteRecord;
    if (!receiptId) return;
    if (imageButton) {
      if (!window.confirm("只删除服务器上的原始截图？交易摘要会继续保留。")) return;
      pendingScreenshotDeletes.add(receiptId);
    } else {
      if (!window.confirm("删除整笔服务器交易档案？原始截图和交易摘要都会删除，且无法从服务器恢复。")) return;
      pendingArchiveDeletes.add(receiptId);
      pendingScreenshotDeletes.delete(receiptId);
    }
    updateSaveState();
    void renderTransactionHistory();
  });

  $("build-base-save")?.addEventListener("click", async () => {
    const saveButton = $("build-base-save") as HTMLButtonElement | null;
    const saveStatus = $("build-base-save-status");
    if (!editor || !saveButton) return;
    const nextState: BuildProgressState = { ...state, items: { ...state.items } };
    const retainedExternal = new Set<string>();
    for (const row of editor.querySelectorAll<HTMLElement>("[data-progress-row]")) {
      const id = row.dataset.progressId;
      if (!id) continue;
      const source = row.dataset.source === "manual" ? "manual" : row.dataset.source === "transaction" ? "transaction" : "catalog";
      const existing = state.items[id];
      const name = (row.querySelector(".build-editor-name") as HTMLInputElement | null)?.value.trim() || existing?.name || "未命名部件";
      const qty = Math.max(1, Math.round(Number((row.querySelector(".build-editor-qty") as HTMLInputElement | null)?.value) || 1));
      const category = (row.querySelector(".build-editor-category") as HTMLSelectElement | null)?.value || existing?.category || "其他";
      const rawPrice = (row.querySelector(".build-editor-price") as HTMLInputElement | null)?.value.trim() ?? "";
      const unitPriceCny = rawPrice === "" ? null : Math.max(0, Number(rawPrice) || 0);
      const rawStage = (row.querySelector(".build-editor-stage") as HTMLSelectElement | null)?.value;
      const stage = isBuildStage(rawStage) ? rawStage : existing?.stage ?? "candidate";
      const pending = pendingTransactions.get(id);
      const transaction = pending?.transaction ?? existing?.transaction;
      const planLink = pending?.planLink ?? existing?.planLink;
      const skuId = pending?.skuId ?? existing?.skuId ?? (source === "catalog" ? id : null);
      const sku = source === "catalog" && skuId ? args.getCatalog().skus.find((entry) => entry.id === skuId) : null;
      const line = source === "catalog" && skuId ? currentBom.find((entry) => entry.skuId === skuId) : null;
      const overrides: NonNullable<BuildProgressItem["overrides"]> = source === "catalog" ? {
        ...(sku && name !== sku.name ? { name: true } : {}),
        ...(sku && category !== sku.category ? { category: true } : {}),
        ...(line && qty !== line.qty ? { qty: true } : {}),
        ...(sku && unitPriceCny !== priceForSku(sku) ? { unitPriceCny: true } : {}),
      } : {};
      nextState.items[id] = { id, skuId, name, category, qty, unitPriceCny, stage, source, ...(Object.keys(overrides).length ? { overrides } : {}), ...(planLink ? { planLink } : {}), ...(transaction ? { transaction } : {}) };
      if (pending) pendingTransactions.set(id, structuredClone(nextState.items[id]));
      if (source !== "catalog") retainedExternal.add(id);
    }
    for (const item of Object.values(nextState.items)) {
      if (item.source !== "catalog" && !retainedExternal.has(item.id)) delete nextState.items[item.id];
    }
    saveButton.disabled = true;
    if (saveStatus) {
      saveStatus.textContent = "正在保存采购状态，并把你确认过的凭证归档到服务器…";
      saveStatus.dataset.level = "pending";
      saveStatus.dataset.phase = "archiving";
    }
    try {
      const stagedItems = [...pendingTransactions.keys()]
        .map((id) => nextState.items[id])
        .filter((item): item is BuildProgressItem => Boolean(item?.transaction));
      const batch = await screenshotArchive.commit(stagedItems);
      for (const record of batch.archived) {
        const item = Object.values(nextState.items).find((candidate) => candidate.transaction?.receiptId === record.receiptId);
        if (!item?.transaction) continue;
        item.transaction.screenshotArchive = "server";
        item.transaction.screenshotStoredAt = record.storedAt;
        item.transaction.screenshotMimeType = record.image?.mimeType ?? null;
        item.transaction.screenshotSize = record.image?.bytes ?? null;
      }
      const failures = [...batch.failures];
      for (const receiptId of pendingScreenshotDeletes) {
        try { await screenshotArchive.deleteScreenshot(receiptId); } catch (error) { failures.push({ receiptId, message: error instanceof Error ? error.message : "删除原图失败" }); }
      }
      for (const receiptId of pendingArchiveDeletes) {
        try {
          await screenshotArchive.deleteRecord(receiptId);
          for (const [id, item] of Object.entries(nextState.items)) {
            if (item.transaction?.receiptId !== receiptId) continue;
            if (item.source === "catalog") { delete item.transaction; delete item.planLink; }
            else delete nextState.items[id];
          }
        } catch (error) { failures.push({ receiptId, message: error instanceof Error ? error.message : "删除档案失败" }); }
      }
      const failedReceipts = new Set(failures.map((failure) => failure.receiptId));
      for (const [id, pending] of pendingTransactions) {
        if (!pending.transaction || !failedReceipts.has(pending.transaction.receiptId)) continue;
        if (state.items[id]) nextState.items[id] = state.items[id];
        else delete nextState.items[id];
      }
      state = nextState;
      persistState(state, activePlanId);
      editorDirty = false;
      const archivedReceiptIds = new Set(batch.archived.map((record) => record.receiptId));
      const archivedItems = Object.values(state.items).filter((item) => item.transaction && archivedReceiptIds.has(item.transaction.receiptId));
      const defaultedParts = archivedItems.length ? args.onTransactionsArchived?.(archivedItems.map((item) => structuredClone(item))) ?? [] : [];
      for (const [id, pending] of pendingTransactions) if (!pending.transaction || !failedReceipts.has(pending.transaction.receiptId)) pendingTransactions.delete(id);
      for (const receiptId of [...pendingScreenshotDeletes]) if (!failedReceipts.has(receiptId)) pendingScreenshotDeletes.delete(receiptId);
      for (const receiptId of [...pendingArchiveDeletes]) if (!failedReceipts.has(receiptId)) pendingArchiveDeletes.delete(receiptId);
      if (!failures.length) {
        if (deferredPlanContext) {
          const nextContext = deferredPlanContext;
          deferredPlanContext = null;
          applyPlanContext(nextContext);
        }
        closeEditor(false);
      }
      else renderEditor();
      render();
      // Render refreshes counts and rows, so publish the outcome afterwards;
      // otherwise the generic idle/pending copy immediately erases feedback.
      if (saveStatus) {
        if (!failures.length) {
          saveStatus.textContent = `${batch.archived.length} 笔凭证已归档，采购状态已保存${defaultedParts.length ? `；已将 ${defaultedParts.join("、")} 设为方案默认部件` : ""}。`;
          saveStatus.dataset.level = "ok";
          saveStatus.dataset.phase = "archived";
          saveStatus.dataset.dirty = "false";
        } else {
          saveStatus.textContent = `部分保存：${batch.archived.length} 笔已归档，${failures.length} 笔仍在待保存区。${failures.map((failure) => `${failure.receiptId}：${failure.message}`).join("；")}`;
          saveStatus.dataset.level = "bad";
          saveStatus.dataset.phase = "staged";
          saveStatus.dataset.dirty = "true";
        }
      }
    } catch (error) {
      if (saveStatus) {
        saveStatus.textContent = `保存失败：${error instanceof Error ? error.message : "服务器档案不可用"}。采购记录尚未写入，请稍后重试。`;
        saveStatus.dataset.level = "bad";
      }
    } finally {
      saveButton.disabled = false;
    }
  });

  $("build-lock-current")?.addEventListener("click", () => {
    for (const item of currentCatalogItems()) {
      if (item.stage === "candidate") item.stage = "locked";
    }
    persistState(state, activePlanId);
    render();
  });

  $("next-buy-list")?.addEventListener("change", (event) => {
    const select = (event.target as Element).closest<HTMLSelectElement>(".bom-stage-select");
    const id = select?.dataset.progressId;
    if (!select || !id || !isBuildStage(select.value) || !state.items[id]) return;
    state.items[id].stage = select.value;
    persistState(state, activePlanId);
    render();
  });

  return {
    stageTransaction(record, screenshot) {
      const matchedCatalog = record.skuId
        ? Object.values(state.items).find((item) => item.source === "catalog" && item.skuId === record.skuId)
        : null;
      const id = matchedCatalog?.id ?? `transaction-${record.receiptId}`;
      const existing = state.items[id];
      const planLink = record.planLink ?? (activePlanId ? { schemaVersion: "1.0.0", planId: activePlanId, planVersionIdAtCapture: activePlanVersionId, planItemId: matchedCatalog?.id ?? null, linkStatus: matchedCatalog ? "linked" : "unlinked" } satisfies PlanTransactionLink : undefined);
      const qty = Math.max(1, Math.round(record.qty));
      const unitPriceCny = record.unitPriceCny ?? existing?.unitPriceCny ?? null;
      const sku = matchedCatalog && record.skuId ? args.getCatalog().skus.find((entry) => entry.id === record.skuId) : null;
      const line = matchedCatalog && record.skuId ? currentBom.find((entry) => entry.skuId === record.skuId) : null;
      const overrides: NonNullable<BuildProgressItem["overrides"]> = matchedCatalog ? {
        ...(sku && record.name !== sku.name ? { name: true } : {}),
        ...(sku && record.category !== sku.category ? { category: true } : {}),
        ...(line && qty !== line.qty ? { qty: true } : {}),
        ...(sku && unitPriceCny !== priceForSku(sku) ? { unitPriceCny: true } : {}),
      } : {};
      pendingTransactions.set(id, {
        id,
        skuId: record.skuId,
        name: record.name,
        category: record.category,
        qty,
        unitPriceCny,
        stage: record.stage ?? (existing?.stage === "installed" ? "installed" : "purchased"),
        source: matchedCatalog ? "catalog" : "transaction",
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(planLink ? { planLink } : {}),
        transaction: record.evidence,
      });
      if (screenshot) screenshotArchive.stage(record.receiptId, screenshot, record.evidence.contentHash, record.evidence.capturedAt);
      if (editorDirty && editor) {
        const existingRow = [...editor.querySelectorAll<HTMLElement>("[data-progress-row]")].find((row) => row.dataset.progressId === id);
        if (existingRow) existingRow.classList.add("is-pending");
        else {
          const pending = pendingTransactions.get(id);
          if (pending) editor.insertAdjacentHTML("beforeend", editorRow(pending));
        }
        updateSaveState();
        renderCurrentReviewSummary();
      } else renderEditor();
      const pendingRow = [...(editor?.querySelectorAll<HTMLElement>("[data-progress-row]") ?? [])].find((row) => row.dataset.progressId === id);
      pendingRow?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    },
    importTransaction(record) {
      const matchedCatalog = record.skuId
        ? Object.values(state.items).find((item) => item.source === "catalog" && item.skuId === record.skuId)
        : null;
      const id = matchedCatalog?.id ?? `transaction-${record.receiptId}`;
      const existing = state.items[id];
      const planLink = record.planLink ?? (activePlanId ? { schemaVersion: "1.0.0", planId: activePlanId, planVersionIdAtCapture: activePlanVersionId, planItemId: matchedCatalog?.id ?? null, linkStatus: matchedCatalog ? "linked" : "unlinked" } satisfies PlanTransactionLink : undefined);
      const qty = Math.max(1, Math.round(record.qty));
      const unitPriceCny = record.unitPriceCny ?? existing?.unitPriceCny ?? null;
      const sku = matchedCatalog && record.skuId ? args.getCatalog().skus.find((entry) => entry.id === record.skuId) : null;
      const line = matchedCatalog && record.skuId ? currentBom.find((entry) => entry.skuId === record.skuId) : null;
      const overrides: NonNullable<BuildProgressItem["overrides"]> = matchedCatalog ? {
        ...(sku && record.name !== sku.name ? { name: true } : {}),
        ...(sku && record.category !== sku.category ? { category: true } : {}),
        ...(line && qty !== line.qty ? { qty: true } : {}),
        ...(sku && unitPriceCny !== priceForSku(sku) ? { unitPriceCny: true } : {}),
      } : {};
      state.items[id] = {
        id,
        skuId: record.skuId,
        name: record.name,
        category: record.category,
        qty,
        unitPriceCny,
        stage: record.stage ?? (existing?.stage === "installed" ? "installed" : "purchased"),
        source: matchedCatalog ? "catalog" : "transaction",
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(planLink ? { planLink } : {}),
        transaction: record.evidence,
      };
      persistState(state, activePlanId);
      render();
    },
    syncEvaluation(evaluation) {
      currentEvaluation = evaluation;
      currentBom = evaluation.bom;
      for (const line of currentBom) ensureLine(line);
      render();
    },
    activatePlan(context) {
      if (context.planId !== activePlanId) {
        const pendingCount = unsavedChangeCount();
        if (pendingCount && !window.confirm(`当前采购页有 ${pendingCount} 项更改尚未保存。切换方案会放弃这些更改，是否继续？`)) {
          deferredPlanContext = context;
          const saveStatus = $("build-base-save-status");
          if (saveStatus) {
            saveStatus.textContent = "已保留当前采购更改。请先点击“保存采购记录”或明确取消，再切换方案。";
            saveStatus.dataset.level = "pending";
            saveStatus.dataset.dirty = "true";
          }
          return;
        }
        deferredPlanContext = null;
        pendingTransactions.clear();
        pendingScreenshotDeletes.clear();
        pendingArchiveDeletes.clear();
        screenshotArchive.discard();
        editorDirty = false;
        applyPlanContext(context);
      } else {
        deferredPlanContext = null;
        activePlanVersionId = context.planVersionId;
        currentEvaluation = context.evaluation;
        currentBom = context.evaluation.bom;
        for (const line of currentBom) ensureLine(line);
      }
      render();
    },
    summary() { return summarizeProgress(currentItems()); },
    items() { return currentItems().map((item) => structuredClone(item)); },
    pricing() { return summarizePurchasePricing(currentEvaluation, currentItems()); },
    purchaseFacts() {
      return currentCatalogItems().filter((item): item is BuildProgressItem & { skuId: string } => Boolean(item.skuId)).map((item) => ({
        skuId: item.skuId,
        stage: item.stage,
        ...(item.transaction?.receiptId ? { receiptId: item.transaction.receiptId } : {}),
        ...(item.planLink ? { planId: item.planLink.planId, planItemId: item.planLink.planItemId, linkStatus: item.planLink.linkStatus } : {}),
      }));
    },
    subscribe(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); },
    dispose() {
      clearScreenshotObjectUrls();
      pendingTransactions.clear(); pendingScreenshotDeletes.clear(); pendingArchiveDeletes.clear(); listeners.clear();
      screenshotArchive.discard();
      if (dialog?.open) dialog.close();
    },
  };
}
