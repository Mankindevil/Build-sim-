import type { BuildEvaluation } from "../core/evaluate";
import type { BuildLineItem } from "../config/types";
import type { PurchaseBucket, SkuCatalog, SkuRecord } from "../sku/types";

export const BUILD_PROGRESS_STORAGE_KEY = "build-sim.progress.v1";

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
}

export interface TransactionImportRecord {
  receiptId: string;
  skuId: string | null;
  name: string;
  category: string;
  qty: number;
  unitPriceCny: number | null;
  stage?: BuildStage;
  evidence: TransactionEvidence;
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
  stageTransaction: (record: TransactionImportRecord) => void;
  importTransaction: (record: TransactionImportRecord) => void;
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

function loadState(): BuildProgressState {
  try {
    const raw = window.localStorage.getItem(BUILD_PROGRESS_STORAGE_KEY);
    return raw ? normalizeProgressState(JSON.parse(raw)) : emptyProgressState();
  } catch {
    return emptyProgressState();
  }
}

function persistState(state: BuildProgressState): void {
  state.updatedAt = now();
  try {
    window.localStorage.setItem(BUILD_PROGRESS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The UI remains usable when storage is disabled; only cross-refresh persistence is lost.
  }
}

export function initBuildProgress(args: {
  getCatalog: () => SkuCatalog;
  baseSkuIds: string[];
}): BuildProgressController {
  let state = loadState();
  let currentBom: BuildLineItem[] = [];
  const pendingTransactions = new Map<string, BuildProgressItem>();

  const dialog = $("build-base-dialog") as HTMLDialogElement | null;
  const editor = $("build-base-editor");

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
    const count = pendingTransactions.size;
    if (button) button.textContent = count ? `保存基座（${count} 项待保存）` : "保存基座";
    if (status) {
      status.textContent = count ? "识别结果已加入编辑区；确认无误后保存到当前浏览器。" : "修改只会在点击“保存基座”后生效。";
      status.dataset.level = count ? "pending" : "idle";
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
  };

  const openEditor = (): void => {
    if (!dialog || !editor) return;
    pendingTransactions.clear();
    renderEditor();
    dialog.showModal();
  };

  const closeEditor = (discardPending = true): void => {
    if (discardPending) pendingTransactions.clear();
    updateSaveState();
    dialog?.close();
  };

  $("build-base-edit")?.addEventListener("click", openEditor);
  $("build-base-close")?.addEventListener("click", () => closeEditor());
  $("build-base-cancel")?.addEventListener("click", () => closeEditor());
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeEditor();
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
  });

  $("build-base-save")?.addEventListener("click", () => {
    if (!editor) return;
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
      state.items[id] = { id, skuId: pending?.skuId ?? existing?.skuId ?? (source === "catalog" ? id : null), name, category, qty, unitPriceCny, stage, source, ...(transaction ? { transaction } : {}) };
      if (source !== "catalog") retainedExternal.add(id);
    }
    for (const item of Object.values(state.items)) {
      if (item.source !== "catalog" && !retainedExternal.has(item.id)) delete state.items[item.id];
    }
    persistState(state);
    pendingTransactions.clear();
    closeEditor(false);
    render();
  });

  $("build-lock-current")?.addEventListener("click", () => {
    for (const item of currentCatalogItems()) {
      if (item.stage === "candidate") item.stage = "locked";
    }
    persistState(state);
    render();
  });

  $("next-buy-list")?.addEventListener("change", (event) => {
    const select = (event.target as Element).closest<HTMLSelectElement>(".bom-stage-select");
    const id = select?.dataset.progressId;
    if (!select || !id || !isBuildStage(select.value) || !state.items[id]) return;
    state.items[id].stage = select.value;
    persistState(state);
    render();
  });

  return {
    stageTransaction(record) {
      const matchedCatalog = record.skuId
        ? Object.values(state.items).find((item) => item.source === "catalog" && item.skuId === record.skuId)
        : null;
      const id = matchedCatalog?.id ?? `transaction-${record.receiptId}`;
      const existing = state.items[id];
      pendingTransactions.set(id, {
        id,
        skuId: record.skuId,
        name: matchedCatalog?.name ?? record.name,
        category: matchedCatalog?.category ?? record.category,
        qty: Math.max(1, Math.round(record.qty)),
        unitPriceCny: record.unitPriceCny ?? existing?.unitPriceCny ?? null,
        stage: record.stage ?? (existing?.stage === "installed" ? "installed" : "purchased"),
        source: matchedCatalog ? "catalog" : "transaction",
        transaction: record.evidence,
      });
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
      state.items[id] = {
        id,
        skuId: record.skuId,
        name: matchedCatalog?.name ?? record.name,
        category: matchedCatalog?.category ?? record.category,
        qty: Math.max(1, Math.round(record.qty)),
        unitPriceCny: record.unitPriceCny ?? existing?.unitPriceCny ?? null,
        stage: record.stage ?? (existing?.stage === "installed" ? "installed" : "purchased"),
        source: matchedCatalog ? "catalog" : "transaction",
        transaction: record.evidence,
      };
      persistState(state);
      render();
    },
    syncEvaluation(evaluation) {
      currentBom = evaluation.bom;
      for (const line of currentBom) ensureLine(line);
      render();
    },
  };
}
