import { BUILD_STAGE_LABELS, BUILD_STAGES, type BuildStage, type TransactionEvidence, type TransactionImportRecord } from "./build-progress";

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
  evidence: Omit<TransactionEvidence, "verification" | "catalogJobId" | "candidateId" | "draftId" | "officialUrl">;
  catalogSearch: { jobId: string; status: string; stage: string } | null;
  billing?: {
    status: string;
    cost: { totalCny: number } | null;
    pricing: { pricingBand: { label: string } | null };
  } | null;
}

interface CatalogCandidate {
  candidateId?: string;
  expectedHash?: string;
  canonicalUrl?: string;
  url?: string;
  match?: { score?: number; kind?: string };
  extraction?: { status?: string; fieldsFound?: number };
}

interface CatalogJob {
  jobId: string;
  status: string;
  stage?: string;
  candidates?: CatalogCandidate[];
  warnings?: string[];
  errors?: string[];
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({ error: "invalid_json", message: "本地服务返回了无效数据" }));
  if (!response.ok) throw new Error(String((payload as { message?: string; error?: string }).message ?? (payload as { error?: string }).error ?? `HTTP ${response.status}`));
  return payload as T;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取截图"));
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

export function selectBestCatalogCandidate(candidates: CatalogCandidate[] = []): CatalogCandidate | null {
  return [...candidates].sort((a, b) => {
    const rank = (candidate: CatalogCandidate): number => {
      const exact = candidate.match?.kind === "exact-mpn" ? 100 : candidate.match?.kind === "brand-model" ? 60 : 0;
      const extracted = candidate.extraction?.status === "ok" ? 30 : candidate.extraction?.status === "partial" ? 10 : 0;
      return exact + extracted + Number(candidate.match?.score ?? 0) * 10 + Number(candidate.extraction?.fieldsFound ?? 0);
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

export function initTransactionImport(options: { onImport: (record: TransactionImportRecord, screenshot: File) => void }): void {
  const input = $("transaction-screenshot-input") as HTMLInputElement | null;
  const drop = $("transaction-screenshot-drop");
  const preview = $("transaction-screenshot-preview") as HTMLImageElement | null;
  const status = $("transaction-screenshot-status");
  const result = $("transaction-screenshot-result");
  if (!input || !drop || !preview || !status || !result) return;

  let previewUrl: string | null = null;
  const setStatus = (copy: string, level: "idle" | "busy" | "ok" | "warn" | "bad" = "idle"): void => {
    status.textContent = copy;
    status.dataset.level = level;
  };
  const showReview = (record: TransactionImportRecord, screenshot: File, copy: string): void => {
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
    name.readOnly = Boolean(record.skuId);
    const category = document.createElement("select");
    category.className = "transaction-review-category";
    category.disabled = Boolean(record.skuId);
    const categories = TRANSACTION_CATEGORIES.includes(record.category) ? TRANSACTION_CATEGORIES : [record.category, ...TRANSACTION_CATEGORIES];
    for (const value of categories) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = CATEGORY_LABELS[value] ?? value;
      option.selected = value === record.category;
      category.append(option);
    }
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
    fields.append(makeLabel(record.skuId ? "部件名称（正式 SKU）" : "部件名称", name), makeLabel("分类", category), makeLabel("数量", qty), makeLabel("成交单价 ¥", price), makeLabel("当前状态", stage));

    const actions = document.createElement("div");
    actions.className = "transaction-review-actions";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "case-view-btn";
    discard.textContent = "放弃本次识别";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "加入下方基座";
    discard.addEventListener("click", () => {
      result.hidden = true;
      result.replaceChildren();
      setStatus("本次识别结果已放弃，未写入基座。", "idle");
    });
    confirm.addEventListener("click", () => {
      const rawPrice = price.value.trim();
      const selectedStage = BUILD_STAGES.includes(stage.value as BuildStage) ? stage.value as BuildStage : "purchased";
      options.onImport({
        ...record,
        name: name.value.trim() || record.name,
        category: category.value || record.category,
        qty: Math.max(1, Math.round(Number(qty.value) || 1)),
        unitPriceCny: rawPrice === "" ? null : Math.max(0, Number(rawPrice) || 0),
        stage: selectedStage,
      }, screenshot);
      result.hidden = true;
      result.replaceChildren();
      setStatus("已加入下方编辑区，仍可继续修改；点击右下角“保存基座”后才会正式保存。", "ok");
    });
    actions.append(discard, confirm);
    result.append(heading, fields, actions);
  };

  const updateFromCatalogJob = async (analysis: TransactionAnalysis): Promise<TransactionImportRecord> => {
    const jobId = analysis.catalogSearch?.jobId;
    if (!jobId) return recordFromAnalysis(analysis, "search-failed");
    let job: CatalogJob | null = null;
    for (let index = 0; index < 45; index += 1) {
      await sleep(index === 0 ? 250 : 750);
      job = await jsonResponse<CatalogJob>(await fetch(`/api/catalog/search/${encodeURIComponent(jobId)}`, { headers: { Accept: "application/json" } }));
      if (TERMINAL_JOB_STATUS.has(job.status)) break;
      setStatus(`正在联网补充官方参数 · ${job.stage ?? job.status}`, "busy");
    }
    if (!job || !TERMINAL_JOB_STATUS.has(job.status)) {
      const timedOut = recordFromAnalysis(analysis, "search-failed");
      setStatus("官网参数搜索超时；请先检查识别结果，参数稍后可继续补齐。", "warn");
      return timedOut;
    }
    const candidate = selectBestCatalogCandidate(job.candidates);
    if (!candidate || Number(candidate.extraction?.fieldsFound ?? 0) < 1) {
      const noResult = recordFromAnalysis(analysis, job.status === "failed" ? "search-failed" : "search-no-result");
      setStatus("没有找到可核验的官方候选；请检查识别结果，参数将保持 unknown。", "warn");
      return noResult;
    }
    let verification: TransactionEvidence["verification"] = "catalog-candidate";
    let draftId: string | null = null;
    if (candidate.candidateId && candidate.expectedHash) {
      try {
        const enrichment = await jsonResponse<{ status?: string; draftId?: string }>(await fetch(`/api/catalog/candidates/${encodeURIComponent(candidate.candidateId)}/enrich`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedHash: candidate.expectedHash }),
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
    return enriched;
  };

  const processFile = async (file: File): Promise<void> => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setStatus("请选择 PNG、JPEG 或 WebP 图片。", "bad"); return; }
    if (file.size > MAX_FILE_BYTES) { setStatus("截图不能超过 5MB。", "bad"); return; }
    input.disabled = true;
    drop.dataset.busy = "true";
    setStatus("正在识别商品型号、数量与成交价…", "busy");
    result.hidden = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.hidden = false;
    try {
      const analysis = await jsonResponse<TransactionAnalysis>(await fetch("/api/price/transactions/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, capturedAt: new Date(file.lastModified || Date.now()).toISOString(), imageDataUrl: await readAsDataUrl(file) }),
      }));
      const verification: TransactionEvidence["verification"] = analysis.status === "matched-catalog" ? "matched-catalog" : analysis.status === "catalog-search-required" ? "online-searching" : "identity-review-required";
      let record = recordFromAnalysis(analysis, verification);
      const costCopy = billingCopy(analysis);
      let resultCopy = `OCR 识别完成${costCopy} · 尚未写入基座`;
      if (analysis.status === "matched-catalog") {
        setStatus("已匹配正式 SKU；请核对数量、成交价和状态。", "ok");
        resultCopy = `正式 SKU · ${(analysis.catalogMatch?.score ?? 0) * 100}% 匹配${costCopy} · 尚未保存`;
      } else if (analysis.status === "catalog-search-required" && analysis.catalogSearch) {
        setStatus("正在联网补充官网参数；完成后可检查并修改识别结果…", "busy");
        record = await updateFromCatalogJob(analysis);
        resultCopy = record.evidence.verification === "catalog-draft" ? `已生成官方参数草稿${costCopy} · 尚未保存` : record.evidence.verification === "catalog-candidate" ? `已关联官网候选${costCopy} · 尚未保存` : `官网参数待补${costCopy} · 尚未保存`;
      } else {
        setStatus("截图中没有足够明确的型号；请手动修正后再加入基座。", "warn");
        resultCopy = `待确认型号 · 参数保持 unknown${costCopy} · 尚未保存`;
      }
      showReview(record, file, resultCopy);
    } catch (error) {
      setStatus(`识别失败：${error instanceof Error ? error.message : "本地服务不可用"}`, "bad");
    } finally {
      input.disabled = false;
      delete drop.dataset.busy;
      input.value = "";
    }
  };

  input.addEventListener("change", () => { const file = input.files?.[0]; if (file) void processFile(file); });
  for (const eventName of ["dragenter", "dragover"]) drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.dataset.drag = "true"; });
  for (const eventName of ["dragleave", "drop"]) drop.addEventListener(eventName, (event) => { event.preventDefault(); delete drop.dataset.drag; });
  drop.addEventListener("drop", (event) => { const file = event.dataTransfer?.files?.[0]; if (file) void processFile(file); });
}
