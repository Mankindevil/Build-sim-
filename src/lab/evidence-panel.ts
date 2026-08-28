import type { BuildConfigDocument } from "../config/types";
import type {
  EvidenceCapture,
  EvidenceDocumentId,
  EvidenceIdentityBasis,
  EvidenceKindBasis,
  EvidenceProductCategory,
  PlanEvidenceBinding,
  PlanEvidencePurpose,
} from "../evidence/contracts";
import type { PlanStore, PlanStoreState } from "../plans/client-store";
import { WorkspaceApiClient, type WorkspaceEvidenceApi } from "../plans/client";
import {
  EvidenceApiClient,
  EvidenceApiError,
  type EvidenceAcquisitionResult,
  type EvidenceDiscoveryCandidate,
  type EvidenceDocumentResult,
  type EvidenceServiceApi,
} from "../plans/evidence-client";
import type { BindPlanEvidenceInput } from "../plans/contracts";
import type { SkuCatalog } from "../sku/types";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";

export interface EvidencePanelServices {
  evidence: EvidenceServiceApi;
  workspace: WorkspaceEvidenceApi;
}

export interface EvidencePanelController {
  refreshCatalog(): void;
  dispose(): void;
}

interface SelectedSku {
  /** V3 needs a per-instance UI key even when several instances share one SKU. */
  selectionId?: string;
  id: string;
  name: string;
  category: EvidenceProductCategory;
  componentInstanceId?: string;
}

const PURPOSES: Array<{ id: PlanEvidencePurpose; label: string }> = [
  { id: "identity", label: "型号身份" },
  { id: "compatibility", label: "兼容性" },
  { id: "geometry", label: "尺寸与位置" },
  { id: "power", label: "功率" },
  { id: "wiring", label: "接线" },
  { id: "thermal", label: "散热" },
  { id: "assembly", label: "安装步骤" },
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function safeHref(value: string, allowRelative = false): string {
  if (allowRelative && value.startsWith("/")) return escapeHtml(value);
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isBuildConfigV3(config: unknown): config is BuildConfigV3 {
  return Boolean(config && typeof config === "object" && (config as { schemaVersion?: unknown }).schemaVersion === "3.0.0");
}

function categoryForComponent(kind: ComponentInstance["kind"]): EvidenceProductCategory {
  return ({
    case: "case", motherboard: "motherboard", cpu: "cpu", psu: "psu", cpu_cooler: "cooler", aio: "cooler",
    radiator: "cooler", pump: "cooler", case_fan: "fan", gpu: "gpu", memory_module: "memory", storage_drive: "storage",
    hba: "hba", raid_controller: "hba", storage_expander: "hba", backplane: "accessory",
  } as Partial<Record<ComponentInstance["kind"], EvidenceProductCategory>>)[kind] ?? "accessory";
}

function selectedSkus(config: BuildConfigDocument, catalog: SkuCatalog): SelectedSku[] {
  if (isBuildConfigV3(config)) {
    const catalogById = new Map(catalog.skus.map((sku) => [sku.id, sku]));
    return config.components.flatMap((component): SelectedSku[] => {
      if (component.identity.status !== "resolved") return [];
      const sku = catalogById.get(component.identity.skuId);
      return [{
        selectionId: component.instanceId,
        componentInstanceId: component.instanceId,
        id: component.identity.skuId,
        name: sku?.name ?? `${component.kind} · ${component.role}`,
        category: categoryForComponent(component.kind),
      }];
    });
  }
  const values: Array<[string | null | undefined, EvidenceProductCategory]> = [
    [config.caseId, "case"],
    [config.boardId, "motherboard"],
    [config.cpuId, "cpu"],
    [config.selection.psuId, "psu"],
    [config.selection.secondaryPsuId, "psu"],
    [config.selection.coolerId, "cooler"],
    [config.selection.gpuId, "gpu"],
    [config.selection.memoryId, "memory"],
    [config.selection.diskSkuId, "storage"],
    [config.selection.hbaSkuId, "hba"],
  ];
  const catalogById = new Map(catalog.skus.map((sku) => [sku.id, sku]));
  const byId = new Map<string, SelectedSku>();
  for (const [id, category] of values) {
    if (!id || id === "gpu.none" || byId.has(id)) continue;
    const sku = catalogById.get(id);
    byId.set(id, { id, name: sku?.name ?? id, category });
  }
  return [...byId.values()];
}

function defaultPurposes(category: EvidenceProductCategory): Set<PlanEvidencePurpose> {
  if (category === "case") return new Set(["compatibility", "geometry", "assembly"]);
  if (category === "psu") return new Set(["compatibility", "power", "wiring"]);
  if (category === "gpu") return new Set(["compatibility", "geometry", "power"]);
  if (category === "cooler" || category === "fan") return new Set(["compatibility", "geometry", "thermal"]);
  if (category === "motherboard" || category === "hba") return new Set(["compatibility", "wiring", "assembly"]);
  return new Set(["identity", "compatibility"]);
}

function idempotencyKey(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function errorCopy(error: unknown): string {
  if (error instanceof EvidenceApiError && error.manualAction) return `${error.message}；${error.manualAction}`;
  return error instanceof Error ? error.message : "证据操作失败";
}

function locatorCopy(binding: PlanEvidenceBinding): string {
  return (binding.locators ?? []).map((locator) => [
    locator.page ? `PDF 第 ${Array.isArray(locator.page) ? locator.page.join("、") : locator.page} 页` : "",
    locator.printedPage ? `印刷页 ${Array.isArray(locator.printedPage) ? locator.printedPage.join("、") : locator.printedPage}` : "",
    locator.section ?? "",
    locator.field ?? "",
  ].filter(Boolean).join(" · ")).filter(Boolean).join("；");
}

function captureFor(binding: PlanEvidenceBinding, detail: EvidenceDocumentResult | undefined): EvidenceCapture | undefined {
  return detail?.captures.find((capture) => capture.id === binding.captureId) ?? detail?.captures[0];
}

function kindBasisCopy(basis: EvidenceKindBasis): { label: string; level: "verified" | "asserted" | "unknown" } {
  if (basis === "content-verified") return { label: "文档类型：内容已核验", level: "verified" };
  if (basis === "user-asserted") return { label: "文档类型：用户选择，内容未核验", level: "asserted" };
  return { label: "文档类型：历史记录，未核验", level: "unknown" };
}

function identityBasisCopy(basis: EvidenceIdentityBasis): { label: string; level: "verified" | "asserted" | "unknown" } {
  if (basis === "official-document-explicit") return { label: "型号身份：文档明确写出", level: "verified" };
  if (basis === "governed-sku-user-asserted") return { label: "型号身份：来自审核目录关联，文档未证明精确型号", level: "asserted" };
  if (basis === "official-domain-only") return { label: "型号身份：仅确认官网域名，未证明精确型号", level: "asserted" };
  return { label: "型号身份：历史关联，未核验", level: "unknown" };
}

function evidenceBasisMarkup(capture: EvidenceCapture | undefined): string {
  if (!capture) return `<div class="workspace-evidence-basis"><span data-strength-level="unknown">证据强度：刷新后查看</span></div>`;
  const kind = kindBasisCopy(capture.kindBasis);
  const identities = capture.productIdentities.length
    ? capture.productIdentities.map((identity) => identityBasisCopy(identity.basis))
    : [{ label: "型号身份：文档未声明", level: "unknown" as const }];
  const uniqueIdentities = identities.filter((identity, index) => identities.findIndex((candidate) => candidate.label === identity.label) === index);
  return `<div class="workspace-evidence-basis"><span data-strength-level="${kind.level}">${kind.label}</span>${uniqueIdentities.map((identity) => `<span data-strength-level="${identity.level}">${identity.label}</span>`).join("")}</div>`;
}

export function mountEvidencePanel(
  host: HTMLElement,
  store: PlanStore,
  getCatalog: () => SkuCatalog,
  services: EvidencePanelServices = { evidence: new EvidenceApiClient(), workspace: new WorkspaceApiClient() },
): EvidencePanelController {
  let state = store.getState();
  let planId: string | null = null;
  let observedPlanRevision = "";
  let selectedSkuId = "";
  let officialUrl = "";
  let query = "";
  let locatorPage = "";
  let locatorSection = "";
  let purposes = new Set<PlanEvidencePurpose>();
  let candidates: EvidenceDiscoveryCandidate[] = [];
  let staged: EvidenceAcquisitionResult | null = null;
  let stagedBindKey = "";
  let bindings: PlanEvidenceBinding[] = [];
  const documentDetails = new Map<EvidenceDocumentId, EvidenceDocumentResult>();
  let busy: "discover" | "archive" | "bind" | "unbind" | "refresh" | null = null;
  let message = "";
  let error = "";

  const currentSkus = () => state.activePlan ? selectedSkus(state.activePlan.draft.config as BuildConfigDocument, getCatalog()) : [];
  const selectionKey = (sku: SelectedSku) => sku.selectionId ?? sku.id;
  const bindingMatches = (binding: PlanEvidenceBinding, sku: SelectedSku | undefined) => Boolean(sku && (
    sku.componentInstanceId
      ? binding.subject.kind === "component" && binding.subject.id === sku.componentInstanceId
      : binding.subject.kind === "sku" && binding.subject.id === sku.id
  ));

  const resetForPlan = (nextPlanId: string | null) => {
    planId = nextPlanId;
    observedPlanRevision = "";
    selectedSkuId = "";
    officialUrl = "";
    query = "";
    locatorPage = "";
    locatorSection = "";
    candidates = [];
    staged = null;
    stagedBindKey = "";
    bindings = [];
    documentDetails.clear();
    message = "";
    error = "";
  };

  const chooseDefaultSku = () => {
    const skus = currentSkus();
    if (!skus.some((sku) => selectionKey(sku) === selectedSkuId)) {
      selectedSkuId = skus[0] ? selectionKey(skus[0]) : "";
      purposes = defaultPurposes(skus[0]?.category ?? "accessory");
    }
    return skus;
  };

  const renderCandidates = () => {
    if (!candidates.length) return `<div class="workspace-evidence-empty"><p>还没有候选。点击“发现官网文档”只会读取官网，不会保存文件。</p></div>`;
    return `<div class="workspace-evidence-candidates">${candidates.map((candidate, index) => `<article data-evidence-candidate="${index}">
      <div><small>${escapeHtml(candidate.kindHint)} · 匹配分 ${candidate.score}</small><strong>${escapeHtml(candidate.title)}</strong><a href="${safeHref(candidate.url)}" target="_blank" rel="noreferrer">先在官网核对 ↗</a></div>
      <button type="button" data-evidence-action="archive" data-candidate-index="${index}"${busy ? " disabled" : ""}>归档这份文档</button>
    </article>`).join("")}</div>`;
  };

  const renderStaged = (selected: SelectedSku | undefined) => {
    if (!staged) return "";
    const alreadyBound = bindings.some((binding) => binding.documentId === staged?.document.id
      && binding.captureId === staged?.capture.id
      && bindingMatches(binding, selected));
    return `<article class="workspace-evidence-staged" data-evidence-staged>
      <header><div><small>${staged.reusedDocument ? "已复用共享文件" : "已保存到共享证据库"}</small><strong>${escapeHtml(staged.capture.title)}</strong><span>SHA-256 ${escapeHtml(staged.document.sha256.slice(0, 16))}… · ${Math.ceil(staged.document.byteLength / 1024).toLocaleString("zh-CN")} KiB</span></div><a href="${safeHref(services.evidence.contentUrl(staged.document.id), true)}" target="_blank" rel="noreferrer">打开归档原文 ↗</a></header>
      ${evidenceBasisMarkup(staged.capture)}
      <div class="workspace-evidence-claim-fields"><label>PDF 页码（可选）<input type="number" min="1" data-evidence-locator-page value="${escapeHtml(locatorPage)}" placeholder="例如 8"></label><label>章节或图名（可选）<input data-evidence-locator-section value="${escapeHtml(locatorSection)}" maxlength="240" placeholder="例如 Power supply installation"></label></div>
      <fieldset><legend>这份文档支持哪些判断</legend><div>${PURPOSES.map((purpose) => `<label><input type="checkbox" data-evidence-purpose="${purpose.id}"${purposes.has(purpose.id) ? " checked" : ""}>${purpose.label}</label>`).join("")}</div></fieldset>
      <footer><p>${alreadyBound ? "这次归档已经绑定到当前部件，无需重复添加。" : "绑定只会把文档 ID、内容哈希与定位信息写进当前方案；共享原文不会复制。"}</p><button type="button" data-evidence-action="bind"${busy || alreadyBound || !selected || state.activePlan?.status !== "active" ? " disabled" : ""}>绑定到当前方案</button></footer>
    </article>`;
  };

  const renderBindings = () => {
    if (!bindings.length) return `<div class="workspace-evidence-empty"><strong>当前方案还没有绑定官方文档</strong><p>先在左侧发现并归档，再明确绑定到一个部件。</p></div>`;
    return `<div class="workspace-evidence-bindings">${bindings.map((binding) => {
      const detail = documentDetails.get(binding.documentId);
      const capture = captureFor(binding, detail);
      const locator = locatorCopy(binding);
      return `<article data-evidence-binding="${escapeHtml(binding.id)}"><header><div><small>${escapeHtml(binding.subject.kind)} · ${escapeHtml(binding.subject.id)}</small><strong>${escapeHtml(capture?.title ?? `证据 ${binding.documentId.slice(-12)}`)}</strong></div><span>${binding.purposes.map((purpose) => escapeHtml(PURPOSES.find((item) => item.id === purpose)?.label ?? purpose)).join(" · ")}</span></header>
        ${evidenceBasisMarkup(capture)}
        ${locator ? `<p>${escapeHtml(locator)}</p>` : `<p>尚未填写页码或章节；Agent 会把它列为定位缺口。</p>`}
        <details><summary>来源与哈希</summary><dl><div><dt>SHA-256</dt><dd>${escapeHtml(binding.contentHash)}</dd></div>${capture ? `<div><dt>官方来源</dt><dd><a href="${safeHref(capture.canonicalUrl)}" target="_blank" rel="noreferrer">${escapeHtml(capture.officialBrand)} · ${formatDate(capture.retrievedAt)} ↗</a></dd></div>` : ""}</dl></details>
        <footer><a href="${safeHref(services.evidence.contentUrl(binding.documentId), true)}" target="_blank" rel="noreferrer">打开归档原文</a><button type="button" data-evidence-action="unbind" data-binding-id="${escapeHtml(binding.id)}"${busy || state.activePlan?.status !== "active" ? " disabled" : ""}>解除绑定</button></footer>
      </article>`;
    }).join("")}</div>`;
  };

  const render = () => {
    const active = state.activePlan;
    if (active?.id !== planId) resetForPlan(active?.id ?? null);
    const revision = active ? `${active.id}:${active.draftRevision}` : "";
    if (revision !== observedPlanRevision) {
      observedPlanRevision = revision;
      bindings = structuredClone(active?.draft.evidenceBindings ?? []);
    }
    const skus = chooseDefaultSku();
    const selected = skus.find((sku) => selectionKey(sku) === selectedSkuId);
    const v3Partial = isBuildConfigV3(active?.draft.config);
    const v3Notice = v3Partial ? `<p data-v3-evidence-partial>仅列出 V3 中已解析身份的组件实例；未解析实例没有可绑定的 SKU，不能据此推断兼容性或价格。</p>` : "";
    host.innerHTML = active ? `<header class="workspace-evidence-head"><div><p>配置依据 · 官方证据</p><h2>把手册保存一次，绑定到需要的方案</h2><span>发现是只读；只有点击“归档”和“绑定”才会写入。解除绑定或删除方案都不会删除共享原文。</span>${v3Notice}</div><button type="button" data-evidence-action="refresh"${busy ? " disabled" : ""}>刷新已有证据</button></header>
      <div class="workspace-evidence-layout"><section class="workspace-evidence-discovery"><h3>1. 发现并归档</h3><label>当前方案部件<select data-evidence-sku${skus.length ? "" : " disabled"}>${skus.map((sku) => `<option value="${escapeHtml(selectionKey(sku))}"${selectionKey(sku) === selectedSkuId ? " selected" : ""}>${escapeHtml(sku.name)}</option>`).join("") || `<option value="">${v3Partial ? "还没有已解析的组件实例" : "请先选择硬件"}</option>`}</select></label><label>官网产品页 / 手册 URL（可选）<input type="url" data-evidence-url value="${escapeHtml(officialUrl)}" placeholder="不填时使用目录中的官网产品页"></label><label>补充关键词（可选）<input data-evidence-query value="${escapeHtml(query)}" maxlength="240" placeholder="例如 user manual 或型号"></label><button type="button" data-evidence-action="discover"${busy || !selected ? " disabled" : ""}>${busy === "discover" ? "正在发现…" : "发现官网文档"}</button>${renderCandidates()}${renderStaged(selected)}</section>
      <section class="workspace-evidence-current"><div><h3>2. 当前方案已绑定</h3><span>${bindings.length} 条引用 · 保存版本时会固定内容哈希</span></div>${renderBindings()}</section></div>
      <p class="workspace-evidence-status" data-evidence-status data-level="${error ? "bad" : message ? "ok" : "idle"}" ${error ? "role=alert" : "aria-live=polite"}>${escapeHtml(error || message || "官网候选不等于已归档证据；请先核对标题和 URL。")}</p>` : `<div class="workspace-evidence-empty"><p>请选择或创建方案后再管理官方证据。</p></div>`;
  };

  const persistDraftBeforeEvidenceWrite = async () => {
    await store.saveDraftNow();
    const next = store.getState();
    if (!next.activePlan || ["dirty", "saving", "failed", "conflict", "offline"].includes(next.saveStatus)) {
      throw new Error("请先保存当前配置并解决同步冲突，再修改证据绑定");
    }
    return next.activePlan;
  };

  const refreshBindings = async () => {
    const active = state.activePlan;
    if (!active) return;
    busy = "refresh";
    error = "";
    render();
    try {
      bindings = await services.workspace.listEvidenceBindings(active.id);
      const ids = [...new Set(bindings.map((binding) => binding.documentId))];
      const details = await Promise.all(ids.map(async (id) => [id, await services.evidence.getDocument(id)] as const));
      details.forEach(([id, detail]) => documentDetails.set(id, detail));
      message = `已刷新 ${bindings.length} 条方案证据`;
    } catch (cause) {
      error = errorCopy(cause);
    } finally {
      busy = null;
      render();
    }
  };

  const discover = async () => {
    const selected = currentSkus().find((sku) => selectionKey(sku) === selectedSkuId);
    if (!selected) return;
    busy = "discover";
    error = "";
    message = "";
    candidates = [];
    staged = null;
    render();
    try {
      const result = await services.evidence.discover({
        skuId: selected.id,
        ...(officialUrl.trim() ? { url: officialUrl.trim() } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
      });
      candidates = result.candidates;
      message = candidates.length ? `检查了 ${result.pagesInspected} 个官网页面，找到 ${candidates.length} 个候选` : "官网页面已检查，但没有发现可归档文档；可粘贴明确的官方 PDF URL 后重试";
    } catch (cause) {
      error = errorCopy(cause);
    } finally {
      busy = null;
      render();
    }
  };

  const archive = async (index: number) => {
    const candidate = candidates[index];
    const selected = currentSkus().find((sku) => selectionKey(sku) === selectedSkuId);
    if (!candidate || !selected) return;
    busy = "archive";
    error = "";
    staged = null;
    stagedBindKey = "";
    locatorPage = "";
    locatorSection = "";
    render();
    try {
      staged = await services.evidence.acquire({ url: candidate.url, skuId: selected.id, kind: candidate.kindHint, title: candidate.title });
      stagedBindKey = idempotencyKey("evidence-bind-ui");
      documentDetails.set(staged.document.id, { document: staged.document, captures: [staged.capture] });
      message = staged.reusedDocument ? "已命中共享证据库，没有重复保存原文" : "官方原文已归档；请填写定位信息后再绑定方案";
    } catch (cause) {
      error = errorCopy(cause);
    } finally {
      busy = null;
      render();
    }
  };

  const bind = async () => {
    const selected = currentSkus().find((sku) => selectionKey(sku) === selectedSkuId);
    if (!staged || !selected) return;
    if (!purposes.size) {
      error = "请至少选择一种证据用途";
      render();
      return;
    }
    busy = "bind";
    error = "";
    render();
    try {
      const active = await persistDraftBeforeEvidenceWrite();
      const page = locatorPage ? Number(locatorPage) : null;
      if (page !== null && (!Number.isSafeInteger(page) || page < 1)) throw new Error("PDF 页码必须是大于 0 的整数");
      const locators = page !== null || locatorSection.trim()
        ? [{ ...(page !== null ? { page } : {}), ...(locatorSection.trim() ? { section: locatorSection.trim() } : {}) }]
        : undefined;
      const input: BindPlanEvidenceInput = {
        expectedRevision: active.draftRevision,
        documentId: staged.document.id,
        contentHash: staged.document.sha256,
        captureId: staged.capture.id,
        subject: selected.componentInstanceId
          ? { kind: "component", id: selected.componentInstanceId, category: selected.category }
          : { kind: "sku", id: selected.id, category: selected.category },
        purposes: [...purposes],
        ...(locators ? { locators } : {}),
        note: "用户通过方案证据面板核对并绑定",
        idempotencyKey: stagedBindKey || idempotencyKey("evidence-bind-ui"),
      };
      await services.workspace.bindEvidence(active.id, input);
      store.acceptServerPlan(await services.workspace.get(active.id));
      message = "已绑定到当前方案；下次保存版本时会固定这份内容哈希";
    } catch (cause) {
      error = errorCopy(cause);
    } finally {
      busy = null;
      render();
    }
  };

  const unbind = async (bindingId: string) => {
    const binding = bindings.find((item) => item.id === bindingId);
    if (!binding || !window.confirm("只解除当前方案引用，共享原文仍会保留。确认继续？")) return;
    busy = "unbind";
    error = "";
    render();
    try {
      const active = await persistDraftBeforeEvidenceWrite();
      await services.workspace.unbindEvidence(active.id, {
        expectedRevision: active.draftRevision,
        bindingId: binding.id,
        idempotencyKey: idempotencyKey("evidence-unbind-ui"),
      });
      store.acceptServerPlan(await services.workspace.get(active.id));
      message = "已解除当前方案绑定；共享原文没有删除";
    } catch (cause) {
      error = errorCopy(cause);
    } finally {
      busy = null;
      render();
    }
  };

  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-evidence-action]");
    const action = button?.dataset.evidenceAction;
    if (!action || busy) return;
    if (action === "refresh") void refreshBindings();
    else if (action === "discover") void discover();
    else if (action === "archive") void archive(Number(button.dataset.candidateIndex));
    else if (action === "bind") void bind();
    else if (action === "unbind" && button.dataset.bindingId) void unbind(button.dataset.bindingId);
  };

  const onInput = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-evidence-url]")) officialUrl = target.value;
    else if (target.matches("[data-evidence-query]")) query = target.value;
    else if (target.matches("[data-evidence-locator-page]")) locatorPage = target.value;
    else if (target.matches("[data-evidence-locator-section]")) locatorSection = target.value;
  };

  const onChange = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.matches("[data-evidence-sku]")) {
      selectedSkuId = target.value;
      const selected = currentSkus().find((sku) => selectionKey(sku) === selectedSkuId);
      purposes = defaultPurposes(selected?.category ?? "accessory");
      candidates = [];
      staged = null;
      officialUrl = "";
      query = "";
      message = "";
      error = "";
      render();
      return;
    }
    const purpose = (target as HTMLInputElement).dataset.evidencePurpose as PlanEvidencePurpose | undefined;
    if (purpose) {
      if ((target as HTMLInputElement).checked) purposes.add(purpose);
      else purposes.delete(purpose);
    }
  };

  host.addEventListener("click", onClick);
  host.addEventListener("input", onInput);
  host.addEventListener("change", onChange);
  const unsubscribe = store.subscribe((next: PlanStoreState) => {
    state = next;
    render();
  });

  return {
    refreshCatalog() { render(); },
    dispose() {
      unsubscribe();
      host.removeEventListener("click", onClick);
      host.removeEventListener("input", onInput);
      host.removeEventListener("change", onChange);
    },
  };
}
