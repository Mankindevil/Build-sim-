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

export interface BuildProgressController {
  syncEvaluation: (evaluation: BuildEvaluation) => void;
  activatePlan: (context: BuildProgressPlanContext) => void;
  stageTransaction: (record: TransactionImportRecord, screenshot?: File) => void;
  importTransaction: (record: TransactionImportRecord) => void;
  summary: () => BuildProgressSummary;
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
    items[id] = {
      id,
      skuId: typeof item.skuId === "string" ? item.skuId : null,
      name: String(item.name),
      category: String(item.category ?? "其他"),
      qty: Number.isFinite(item.qty) ? Math.max(1, Math.round(Number(item.qty))) : 1,
      unitPriceCny: Number.isFinite(item.unitPriceCny) ? Math.max(0, Number(item.unitPriceCny)) : null,
      stage: item.stage,
      source: item.source === "manual" || item.source === "transaction" ? item.source : "catalog",
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
}): BuildProgressController {
  const initialPlan = args.getPlanContext?.() ?? null;
  let activePlanId = initialPlan?.planId ?? null;
  let activePlanVersionId = initialPlan?.planVersionId ?? null;
  let state = loadState(activePlanId);
  let currentBom: BuildLineItem[] = initialPlan?.evaluation.bom ?? [];
  const pendingTransactions = new Map<string, BuildProgressItem>();
  const pendingScreenshotDeletes = new Set<string>();
  const pendingArchiveDeletes = new Set<string>();
  const screenshotArchive = args.screenshotArchive ?? createTransactionScreenshotArchive();
  const screenshotObjectUrls = new Set<string>();
  const listeners = new Set<() => void>();
  let transactionRenderToken = 0;

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
  const historyStateFilter = ensureHistoryControl("transaction-history-filter", () => { const select = document.createElement("select"); select.innerHTML = '<option value="all">全部状态</option><option value="pending">staged</option><option value="archived">archived</option>'; select.setAttribute("aria-label", "交易归档状态"); return select; });
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
    state.items[line.skuId] = {
      id: line.skuId,
      skuId: line.skuId,
      name: sku.name,
      category: sku.category,
      qty: existing?.transaction ? existing.qty : line.qty,
      unitPriceCny: existing?.unitPriceCny ?? priceForSku(sku),
      stage: existing?.stage ?? stageForBucket(line.bucket),
      source: "catalog",
      ...(existing?.transaction ? { transaction: existing.transaction } : {}),
    };
  };

  const renderHero = (): void => {
    const host = $("build-base-summary");
    const progress = $("build-hero-progress");
    if (!host || !progress) return;
    const base = args.baseSkuIds.map((id) => state.items[id]).filter((item): item is BuildProgressItem => Boolean(item));
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
    if (transactionCount && transactionCount.textContent === "0 笔") transactionCount.textContent = `${transactions} 笔`;
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
    return currentBom.some((line) => line.skuId === record.link.planItemId) ? "linked" : "stale";
  };

  const transactionCard = (record: TransactionArchiveRecord): string => {
    const item = record.item;
    const evidence = item.transaction;
    const pending = Boolean(record.pendingFile);
    const deletingImage = pendingScreenshotDeletes.has(record.receiptId);
    const officialUrl = safeOfficialUrl(evidence?.officialUrl as string | null | undefined);
    const activeItems = currentBom.map((line) => state.items[line.skuId]).filter((entry): entry is BuildProgressItem => Boolean(entry));
    const linkOptions = [`<option value="">未关联采购项</option>`, ...activeItems.map((entry) => `<option value="${esc(entry.id)}"${record.link.planId === activePlanId && record.link.planItemId === entry.id ? " selected" : ""}>${esc(categoryLabel(entry.category))} · ${esc(entry.name)}</option>`)].join("");
    const planName = args.getPlans?.().find((plan) => plan.id === record.link.planId)?.name ?? record.link.planId;
    const linkStatus = effectiveLinkStatus(record);
    return `<article class="transaction-history-card${pending ? " is-pending" : ""}" data-archive-receipt="${esc(record.receiptId)}">
      <div class="transaction-history-visual">${record.image && !deletingImage ? `<img alt="${esc(item.name)} 的交易截图" data-archive-image="${esc(record.receiptId)}">` : `<span>${deletingImage ? "原图待删除" : "仅保留交易摘要"}</span>`}</div>
      <div class="transaction-history-copy"><div><small>${pending ? "staged · 待保存" : "archived · 服务器已归档"} · ${esc(formatArchiveDate(record.storedAt))}</small><input data-archive-edit-name value="${esc(item.name)}" aria-label="交易商品摘要"></div><p>${esc(categoryLabel(item.category))} · ${item.qty} 件 · ${item.unitPriceCny === null ? "价格 unknown" : formatCny(item.unitPriceCny)} · ${esc(BUILD_STAGE_LABELS[item.stage as BuildStage] ?? item.stage)}</p><p data-link-status="${linkStatus}">${linkStatus === "linked" ? `已关联 ${esc(planName ?? "方案")} / ${esc(record.link.planItemId ?? "")}` : linkStatus === "stale" ? `原关联已 stale · ${esc(planName ?? "未知方案")}` : "未关联 inbox"}</p><p>${evidence ? `${esc(evidence.fileName)} · ${esc(verificationLabel(evidence.verification as TransactionEvidence["verification"]))} · ${esc(evidence.ocrEngine)}` : "交易证据待补"}${record.image ? ` · ${formatBytes(record.image.bytes)}` : ""}${officialUrl ? ` · <a href="${esc(officialUrl)}" target="_blank" rel="noreferrer">官网来源</a>` : ""}</p></div>
      <div class="transaction-history-actions">${pending ? "" : `<label>关联当前方案部件<select data-archive-link-item>${linkOptions}</select></label><button type="button" class="case-view-btn" data-archive-update="${esc(record.receiptId)}">保存摘要与关联</button>`}${record.image && !deletingImage ? `<a class="case-view-btn" data-archive-open="${esc(record.receiptId)}" target="_blank" rel="noreferrer">查看原图</a>${pending ? "" : `<button type="button" class="case-view-btn" data-archive-delete-image="${esc(record.receiptId)}">删除原图</button>`}` : ""}${pending ? "" : `<button type="button" class="case-view-btn danger" data-archive-delete-record="${esc(record.receiptId)}">删除整笔档案</button>`}</div>
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
      const pendingIds = new Set(pendingRecords.map((record) => record.receiptId));
      const allRecords = [...pendingRecords, ...remoteRecords.filter((record) => !pendingIds.has(record.receiptId))];
      const previousPlanFilter = historyPlanFilter?.value;
      if (historyPlanFilter) {
        const plans = args.getPlans?.() ?? [];
        historyPlanFilter.innerHTML = `<option value="all">全部方案与 inbox</option><option value="unlinked">未关联 inbox</option>${plans.map((plan) => `<option value="${esc(plan.id)}">${esc(plan.name)}</option>`).join("")}`;
        historyPlanFilter.value = previousPlanFilter || activePlanId || "all";
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
      host.innerHTML = records.length ? records.map(transactionCard).join("") : `<div class="transaction-history-empty"><strong>还没有交易档案</strong><p>上传截图、核对识别结果并保存基座后，会在这里形成可复核记录。</p></div>`;
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
      if (count) count.textContent = `${records.length} 笔`;
      status.textContent = `${records.length}/${allRecords.length} 笔可见 · ${remoteRecords.length} archived${pendingRecords.length ? ` · ${pendingRecords.length} staged` : ""}${pendingScreenshotDeletes.size || pendingArchiveDeletes.size ? " · 有删除操作待保存" : ""}`;
      status.dataset.level = pendingRecords.length || pendingScreenshotDeletes.size || pendingArchiveDeletes.size ? "pending" : "ok";
    } catch (error) {
      if (token !== transactionRenderToken) return;
      host.innerHTML = "";
      status.textContent = `读取服务器档案失败：${error instanceof Error ? error.message : "服务不可用"}`;
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
    <div class="build-editor-identity"><small>${item.source === "manual" ? "用户记录" : item.transaction ? "交易截图" : "正式 SKU"}${pendingTransactions.has(item.id) ? " · 待保存" : ""}</small><input class="build-editor-name" value="${esc(item.name)}" ${item.source === "catalog" ? "readonly" : ""}>${item.transaction ? `<span class="build-transaction-proof">${esc(item.transaction.fileName)} · ${verificationLabel(item.transaction.verification)}${officialUrl ? ` · <a href="${esc(officialUrl)}" target="_blank" rel="noreferrer">查看官网来源</a>` : ""}</span>` : ""}</div>
    <label>分类<select class="build-editor-category"${item.source === "catalog" ? " disabled" : ""}>${categoryOptions(item.category)}</select></label>
    <label>数量<input class="build-editor-qty" type="number" min="1" max="99" step="1" value="${item.qty}"></label>
    <label>单价 ¥<input class="build-editor-price" type="number" min="0" step="1" value="${item.unitPriceCny ?? ""}" placeholder="待补"></label>
    <label>状态<select class="build-editor-stage">${stageOptions(item.stage)}</select></label>
    ${item.source !== "catalog" ? `<button type="button" class="build-remove-custom case-view-btn" aria-label="移除 ${esc(item.name)}">移除</button>` : ""}
  </div>`;
  };

  const updateSaveState = (): void => {
    const button = $("build-base-save") as HTMLButtonElement | null;
    const status = $("build-base-save-status");
    const count = pendingTransactions.size + pendingScreenshotDeletes.size + pendingArchiveDeletes.size;
    if (button) button.textContent = count ? `保存基座（${count} 项待保存）` : "保存基座";
    if (status) {
      status.textContent = count ? "识别结果或档案操作尚未生效；确认后统一保存到服务器与当前基座。" : "修改与新截图只会在点击“保存基座”后生效。";
      status.dataset.level = count ? "pending" : "idle";
      status.dataset.phase = count ? "staged" : "idle";
    }
  };

  const renderEditor = (): void => {
    if (!editor) return;
    const rows = currentItems();
    const ids = new Set(rows.map((item) => item.id));
    editor.innerHTML = [
      ...rows.map((item) => editorRow(pendingTransactions.get(item.id) ?? item)),
      ...[...pendingTransactions.values()].filter((item) => !ids.has(item.id)).map(editorRow),
    ].join("");
    updateSaveState();
    renderCurrentReviewSummary();
  };

  const openEditor = (): void => {
    if (!dialog || !editor) return;
    pendingTransactions.clear();
    pendingScreenshotDeletes.clear();
    pendingArchiveDeletes.clear();
    renderEditor();
    setReviewTab("current");
    dialog.showModal();
  };

  const closeEditor = (discardPending = true, protectPending = false): void => {
    const pendingCount = pendingTransactions.size + pendingScreenshotDeletes.size + pendingArchiveDeletes.size;
    if (protectPending && pendingCount && !window.confirm(`${pendingCount} 项 staged 更改尚未归档。确认放弃并关闭？`)) return;
    if (discardPending) {
      pendingTransactions.clear();
      pendingScreenshotDeletes.clear();
      pendingArchiveDeletes.clear();
      screenshotArchive.discard();
    }
    clearScreenshotObjectUrls();
    updateSaveState();
    dialog?.close();
  };

  $("build-base-edit")?.addEventListener("click", openEditor);
  $("build-base-close")?.addEventListener("click", () => closeEditor(true, true));
  $("build-base-cancel")?.addEventListener("click", () => closeEditor());
  $("build-review-current-tab")?.addEventListener("click", () => setReviewTab("current"));
  $("build-review-transactions-tab")?.addEventListener("click", () => setReviewTab("transactions"));
  $("transaction-history-refresh")?.addEventListener("click", () => void renderTransactionHistory());
  historySearch?.addEventListener("input", () => void renderTransactionHistory());
  for (const control of [historyStateFilter, historyPlanFilter, historyCategoryFilter, historySort]) control?.addEventListener("change", () => void renderTransactionHistory());
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeEditor(true, true);
  });

  $("build-add-custom")?.addEventListener("click", () => {
    if (!editor) return;
    const id = `manual-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    const item: BuildProgressItem = { id, skuId: null, name: "待补充部件", category: "其他", qty: 1, unitPriceCny: null, stage: "candidate", source: "manual" };
    editor.insertAdjacentHTML("beforeend", editorRow(item));
  });

  editor?.addEventListener("click", (event) => {
    const button = (event.target as Element).closest(".build-remove-custom");
    button?.closest("[data-progress-row]")?.remove();
    if (button) renderCurrentReviewSummary();
  });

  editor?.addEventListener("change", renderCurrentReviewSummary);

  $("transaction-history-list")?.addEventListener("click", (event) => {
    const target = event.target as Element;
    const updateButton = target.closest<HTMLElement>("[data-archive-update]");
    if (updateButton?.dataset.archiveUpdate) {
      const receiptId = updateButton.dataset.archiveUpdate;
      const card = updateButton.closest<HTMLElement>("[data-archive-receipt]");
      const planItemId = card?.querySelector<HTMLSelectElement>("[data-archive-link-item]")?.value || null;
      const name = card?.querySelector<HTMLInputElement>("[data-archive-edit-name]")?.value.trim();
      const link: PlanTransactionLink = { schemaVersion: "1.0.0", planId: activePlanId, planVersionIdAtCapture: activePlanVersionId, planItemId, linkStatus: activePlanId && planItemId ? "linked" : "unlinked" };
      updateButton.setAttribute("aria-busy", "true");
      void screenshotArchive.updateRecord(receiptId, { ...(name ? { item: { name } } : {}), link }).then(() => {
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
      nextState.items[id] = { id, skuId: pending?.skuId ?? existing?.skuId ?? (source === "catalog" ? id : null), name, category, qty, unitPriceCny, stage, source, ...(planLink ? { planLink } : {}), ...(transaction ? { transaction } : {}) };
      if (source !== "catalog") retainedExternal.add(id);
    }
    for (const item of Object.values(nextState.items)) {
      if (item.source !== "catalog" && !retainedExternal.has(item.id)) delete nextState.items[item.id];
    }
    saveButton.disabled = true;
    if (saveStatus) {
      saveStatus.textContent = "正在保存基座并归档截图到服务器…";
      saveStatus.dataset.level = "pending";
      saveStatus.dataset.phase = "archiving";
    }
    try {
      const batch = await screenshotArchive.commit(Object.values(nextState.items).filter((item) => item.transaction));
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
        try { await screenshotArchive.deleteRecord(receiptId); } catch (error) { failures.push({ receiptId, message: error instanceof Error ? error.message : "删除档案失败" }); }
      }
      const failedReceipts = new Set(failures.map((failure) => failure.receiptId));
      for (const [id, pending] of pendingTransactions) {
        if (!pending.transaction || !failedReceipts.has(pending.transaction.receiptId)) continue;
        if (state.items[id]) nextState.items[id] = state.items[id];
        else delete nextState.items[id];
      }
      state = nextState;
      persistState(state, activePlanId);
      for (const [id, pending] of pendingTransactions) if (!pending.transaction || !failedReceipts.has(pending.transaction.receiptId)) pendingTransactions.delete(id);
      for (const receiptId of [...pendingScreenshotDeletes]) if (!failedReceipts.has(receiptId)) pendingScreenshotDeletes.delete(receiptId);
      for (const receiptId of [...pendingArchiveDeletes]) if (!failedReceipts.has(receiptId)) pendingArchiveDeletes.delete(receiptId);
      if (!failures.length) {
        closeEditor(false);
        if (saveStatus) {
          saveStatus.textContent = `archived · ${batch.archived.length} 笔截图已归档，方案采购状态已更新。`;
          saveStatus.dataset.level = "ok";
          saveStatus.dataset.phase = "archived";
        }
      }
      else {
        renderEditor();
        if (saveStatus) {
          saveStatus.textContent = `部分保存：${batch.archived.length} 笔已归档，${failures.length} 笔仍为 staged，可直接重试。`;
          saveStatus.dataset.level = "bad";
          saveStatus.dataset.phase = "staged";
        }
      }
      render();
    } catch (error) {
      if (saveStatus) {
        saveStatus.textContent = `保存失败：${error instanceof Error ? error.message : "服务器档案不可用"}。基座尚未写入，请稍后重试。`;
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
      pendingTransactions.set(id, {
        id,
        skuId: record.skuId,
        name: matchedCatalog?.name ?? record.name,
        category: matchedCatalog?.category ?? record.category,
        qty: Math.max(1, Math.round(record.qty)),
        unitPriceCny: record.unitPriceCny ?? existing?.unitPriceCny ?? null,
        stage: record.stage ?? (existing?.stage === "installed" ? "installed" : "purchased"),
        source: matchedCatalog ? "catalog" : "transaction",
        ...(planLink ? { planLink } : {}),
        transaction: record.evidence,
      });
      if (screenshot) screenshotArchive.stage(record.receiptId, screenshot, record.evidence.contentHash, record.evidence.capturedAt);
      renderEditor();
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
      state.items[id] = {
        id,
        skuId: record.skuId,
        name: matchedCatalog?.name ?? record.name,
        category: matchedCatalog?.category ?? record.category,
        qty: Math.max(1, Math.round(record.qty)),
        unitPriceCny: record.unitPriceCny ?? existing?.unitPriceCny ?? null,
        stage: record.stage ?? (existing?.stage === "installed" ? "installed" : "purchased"),
        source: matchedCatalog ? "catalog" : "transaction",
        ...(planLink ? { planLink } : {}),
        transaction: record.evidence,
      };
      persistState(state, activePlanId);
      render();
    },
    syncEvaluation(evaluation) {
      currentBom = evaluation.bom;
      for (const line of currentBom) ensureLine(line);
      render();
    },
    activatePlan(context) {
      if (context.planId !== activePlanId) {
        pendingTransactions.clear();
        pendingScreenshotDeletes.clear();
        pendingArchiveDeletes.clear();
        screenshotArchive.discard();
        activePlanId = context.planId;
        state = loadState(activePlanId);
      }
      activePlanVersionId = context.planVersionId;
      currentBom = context.evaluation.bom;
      for (const line of currentBom) ensureLine(line);
      render();
    },
    summary() { return summarizeProgress(currentItems()); },
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
