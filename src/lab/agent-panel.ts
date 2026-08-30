import type { AgentMessage, AgentPendingWriteApproval, AgentRunAuditRecord, AgentRunEvent, AgentSession, ProviderModel } from "../agent/contracts";
import type { FieldProvenance } from "../catalog-search/types";
import type { BuildConfigDocument } from "../config/types";
import type { TopologyV3PatchOperation } from "../contracts/registries";
import type { BuildPlan, PlanAgentContext, PlanChangeProposal, PlanPatchOperation } from "../plans/contracts";
import type { SkuRecord } from "../sku/types";
import { isPlanAgentContextStale, planAgentContextEnvelope } from "../agent/plan-context";
import { hashPlanConfig } from "../plans/canonical";

const API = "/api/agent";

interface SkillEntry {
  manifest: { id: string; name: string; description: string; version: string; allowedTools: string[]; readOnly: boolean };
  definitionHash: string;
}

interface CatalogReviewField extends Partial<FieldProvenance> {
  field?: string;
  value?: unknown;
  before?: unknown;
  after?: unknown;
  existing?: unknown;
  proposed?: unknown;
}

interface CatalogReviewConflict {
  field?: string;
  existing?: unknown;
  proposed?: unknown;
  reason?: string;
}

interface CatalogReviewPreview {
  status?: string;
  schemaVersion?: string;
  draftId: string;
  operation?: "create" | "update" | string;
  baseSkuId?: string;
  baseSkuHash?: string;
  baseCatalogVersion?: string;
  candidateId: string;
  candidateInputHash: string;
  proposed: Partial<SkuRecord>;
  fields?: CatalogReviewField[];
  changes?: CatalogReviewField[];
  conflicts?: CatalogReviewConflict[];
  missing?: string[];
  changedFields?: string[];
  inputHash: string;
  expectedHash?: string;
  writeEnabled?: boolean;
  candidateSnapshot?: {
    canonicalUrl?: string;
    url?: string;
    official?: { trustStatus?: string; pageKind?: string };
  };
}

interface CatalogReviewEnvelope {
  preview?: CatalogReviewPreview;
  draft?: CatalogReviewPreview;
  review?: CatalogReviewPreview;
  writeEnabled?: boolean;
}

interface CatalogAcceptanceResult {
  status?: string;
  skuId?: string;
  sku?: SkuRecord;
  catalogChanged?: boolean;
  created?: boolean;
  changedFields?: string[];
  reason?: string;
  reasons?: string[];
}

interface EventStream {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface AgentPanelOptions {
  getBuildConfig: () => unknown;
  getPlanContext?: () => PlanAgentContext | null | Promise<PlanAgentContext | null>;
  requirePlanContext?: () => boolean;
  subscribePlanContext?: (listener: () => void) => () => void;
  acceptServerPlan?: (plan: BuildPlan<BuildConfigDocument>) => void | Promise<void>;
  /** Installs an explicitly reviewed, server-confirmed SKU into the runtime catalog. */
  onCatalogSkuAccepted?: (sku: SkuRecord) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string) => EventStream;
}

export interface AgentPanelController {
  getSessionId(): string | null;
  ensureSessionId(): Promise<string>;
  dispose(): void;
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function cny(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(value);
}

export function formatCatalogToolResult(toolName: string, content: unknown): string {
  const value = content && typeof content === "object" ? content as Record<string, unknown> : {};
  if (toolName === "search_official_catalog" || toolName === "get_catalog_search_job") {
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const proposals = Array.isArray(value.domainProposals) ? value.domainProposals : [];
    const discovery = value.discovery && typeof value.discovery === "object" ? value.discovery as { providerIds?: string[] } : {};
    const summary = value.summary && typeof value.summary === "object" ? value.summary as { exact?: number; sameFamily?: number; conflicts?: number; blocked?: number } : {};
    return `搜索候选 ${candidates.length} · 精确 ${summary.exact ?? 0} · 同系列 ${summary.sameFamily ?? 0} · 冲突 ${summary.conflicts ?? 0} · 读取受阻 ${summary.blocked ?? 0} · provider ${(discovery.providerIds ?? []).join(",") || "unknown"} · 待治理域名 ${proposals.length} · job ${text(value.status ?? "unknown")}`;
  }
  if (toolName === "inspect_catalog_candidate") {
    const extraction = value.extraction && typeof value.extraction === "object" ? value.extraction as { status?: string; fieldsFound?: number } : {};
    const source = value.source && typeof value.source === "object" ? value.source as { domain?: string } : {};
    const official = value.official && typeof value.official === "object" ? value.official as { pageKind?: string } : {};
    const identity = value.identity && typeof value.identity === "object" ? value.identity as { verdict?: string; unknowns?: string[] } : {};
    return `官方检查 ${text(extraction.status ?? "unknown")} · ${text(source.domain ?? "unknown domain")} · 页面 ${text(official.pageKind ?? "unknown")} · 身份 ${text(identity.verdict ?? "unknown")} · 未知项 ${(identity.unknowns ?? []).join(",") || "无"} · 字段 ${extraction.fieldsFound ?? 0} · ${value.expectedHash ? "expected hash 已生成" : "无可写 hash"}`;
  }
  if (toolName === "list_official_domain_proposals") {
    const proposals = Array.isArray(value.proposals) ? value.proposals as Array<{ trustStatus?: string }> : [];
    return `域名治理 · proposed ${proposals.filter((entry) => entry.trustStatus === "proposed").length} · rejected ${proposals.filter((entry) => entry.trustStatus === "rejected").length} · trusted ${proposals.filter((entry) => entry.trustStatus === "trusted").length}`;
  }
  if (toolName === "propose_catalog_review") {
    const normalized = normalizedCatalogReview(content);
    if (!normalized) return "目录审核提案无效";
    const { preview, writeEnabled } = normalized;
    return `${preview.operation === "update" || preview.baseSkuId ? "补充现有 SKU" : "新增 SKU"} · 字段 ${(preview.fields ?? []).length} · 变化 ${(preview.changedFields ?? []).length} · 冲突 ${(preview.conflicts ?? []).length} · 缺失 ${(preview.missing ?? []).length} · ${writeEnabled ? "等待人工审核" : "目录写入已关闭"}`;
  }
  if (toolName === "enrich_official_catalog") return `目录补齐 · ${text(value.status ?? "blocked")} · ${Array.isArray(value.changedFields) ? value.changedFields.length : 0} 个字段差异 · ${text(value.rollbackManifest ?? "无回滚引用")}`;
  return "";
}

async function json<T>(fetchImpl: typeof fetch, path: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json().catch(() => ({ error: "invalid_json", message: `HTTP ${response.status}` })) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function workspaceJson<T>(fetchImpl: typeof fetch, path: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(`/api/workspace${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json().catch(() => ({ error: "invalid_json", message: `HTTP ${response.status}` })) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function priceJson<T>(fetchImpl: typeof fetch, path: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(`/api/price${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  const payload = await response.json().catch(() => ({ error: "invalid_json", message: `HTTP ${response.status}` })) as T & { error?: string; message?: string; reason?: string; reasons?: string[] };
  if (!response.ok) throw new Error(payload.message ?? payload.reason ?? payload.reasons?.join("；") ?? payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function messageNode(role: "user" | "assistant" | "notice", content: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = `agent-message agent-message-${role}`;
  row.dataset.role = role;
  const label = document.createElement("span");
  label.className = "agent-message-role";
  label.textContent = role === "user" ? "你" : role === "assistant" ? "Agent" : "运行事件";
  const body = document.createElement("div");
  body.className = "agent-message-body";
  body.textContent = content;
  row.append(label, body);
  return row;
}

function writeApprovalNode(
  pending: AgentPendingWriteApproval,
  onConfirm: (target: HTMLElement, state: HTMLElement) => Promise<void>,
  onReject: (target: HTMLElement, state: HTMLElement) => Promise<void>,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "agent-write-approval";
  card.dataset.agentWriteApproval = pending.approvalId;
  card.dataset.state = "pending";
  const heading = document.createElement("h4");
  heading.textContent = `待批准写入 · ${pending.toolTitle}`;
  const warning = document.createElement("p");
  warning.textContent = "尚未执行任何写入。批准只适用于下面这一次、这组完全相同的输入。";
  const bindings = document.createElement("dl");
  for (const [label, value] of [
    ["Tool", pending.call.name],
    ["Run", pending.runId],
    ["Session", pending.sessionId],
    ["Input hash", pending.inputHash],
    ["Definition", pending.toolDefinitionHash],
    ["到期", pending.expiresAt],
    ["备份", pending.backup.target],
    ["回滚", pending.rollback.strategy],
  ] as Array<[string, string]>) {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = value;
    bindings.append(term, detail);
  }
  const exact = document.createElement("details");
  const exactSummary = document.createElement("summary"); exactSummary.textContent = "查看 exact Tool 输入";
  const exactInput = document.createElement("pre"); exactInput.textContent = JSON.stringify(pending.call.input, null, 2);
  exact.append(exactSummary, exactInput);
  const approval = document.createElement("input");
  approval.type = "checkbox";
  approval.dataset.agentWriteApprovalCheck = "";
  const approvalLabel = document.createElement("label");
  approvalLabel.append(approval, document.createTextNode("我已核对 Tool、输入和执行范围，并批准这一次写入"));
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.dataset.confirmAgentWrite = "";
  confirm.textContent = "批准并继续同一运行";
  confirm.disabled = true;
  const reject = document.createElement("button");
  reject.type = "button";
  reject.dataset.rejectAgentWrite = "";
  reject.textContent = "拒绝并取消运行";
  const state = document.createElement("p");
  state.dataset.agentWriteApprovalState = "";
  state.textContent = "等待人工审批 · 零写入";
  approval.addEventListener("change", () => { confirm.disabled = !approval.checked; });
  confirm.addEventListener("click", async () => {
    approval.disabled = true; confirm.disabled = true; reject.disabled = true;
    state.textContent = "正在由服务端签发执行绑定批准并恢复同一运行…";
    try {
      await onConfirm(card, state);
      card.dataset.state = "confirmed";
      state.textContent = "已批准；同一 run 正在以原始 Tool 输入可靠重试。";
    } catch (error) {
      approval.disabled = false;
      approval.checked = false;
      reject.disabled = false;
      state.textContent = `批准失败：${text((error as Error).message)}。没有执行写入，可重新核对。`;
    }
  });
  reject.addEventListener("click", async () => {
    approval.disabled = true; confirm.disabled = true; reject.disabled = true;
    state.textContent = "正在拒绝该写入并终结运行…";
    try {
      await onReject(card, state);
      card.dataset.state = "rejected";
      state.textContent = "已拒绝；运行已取消，未执行写入。";
    } catch (error) {
      approval.disabled = false; reject.disabled = false;
      confirm.disabled = !approval.checked;
      state.textContent = `拒绝失败：${text((error as Error).message)}。写入仍未执行。`;
    }
  });
  card.append(heading, warning, bindings, exact, approvalLabel, confirm, reject, state);
  return card;
}

function welcomeNode(): HTMLElement {
  const card = document.createElement("section");
  card.className = "agent-welcome";
  card.setAttribute("aria-label", "装机助手使用说明");
  card.innerHTML = `
    <p>第一次装机也没关系</p>
    <h4>直接说目标，我来把术语翻译成下一步</h4>
    <ul>
      <li><strong>先了解你：</strong>用途、预算、摆放位置，以及对噪音和耗电的在意程度。</li>
      <li><strong>再解释取舍：</strong>哪些能买、哪些会冲突、为什么要改，以及大概多花多少钱。</li>
      <li><strong>最后由你确认：</strong>助手只提出修改建议，不会静默改配置或替你下单。</li>
    </ul>`;
  return card;
}

const CATALOG_FIELD_LABELS: Record<string, string> = {
  brand: "品牌",
  model: "型号",
  mpn: "制造商料号（可选）",
  "dims.lengthMm": "长度",
  "dims.widthMm": "宽度",
  "dims.heightMm": "高度",
  "dims.thicknessMm": "厚度",
  "dims.slots": "占用槽位",
  "power.tgpW": "显卡功耗 TGP",
  "power.tdpW": "热设计功耗",
  "power.ratedW": "额定功率",
  "attrs.capacity": "容量 / 显存",
  "attrs.interface": "接口",
  "attrs.noiseDba": "噪音",
  "attrs.maxOperatingTempC": "最高工作温度",
  "attrs.recommendedPsuW": "建议电源功率",
  "harness.pciePower": "显卡供电接口",
};

function catalogFieldLabel(field: string | undefined): string {
  return field ? CATALOG_FIELD_LABELS[field] ?? field : "字段";
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

function catalogValue(field: string | undefined, value: unknown): string {
  if (value === undefined || value === null || value === "") return "未知";
  const suffix = field?.startsWith("dims.") && field !== "dims.slots" ? " mm"
    : field?.startsWith("power.") || field === "attrs.recommendedPsuW" ? " W"
      : field === "attrs.noiseDba" ? " dBA"
        : field === "attrs.maxOperatingTempC" ? " °C"
          : "";
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return `${rendered}${suffix}`;
}

function evidenceLabel(field: CatalogReviewField): string {
  if (field.sourceKind === "manual") return "人工覆核 · 证据待补";
  if (field.evidence === "inferred") return "规则推导 · 待你确认";
  if (field.evidence === "official") return "官网证据";
  return "证据未知";
}

function trustedHttpsUrl(value: unknown): string | null {
  try {
    const parsed = new URL(String(value ?? ""));
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch { return null; }
}

function normalizedCatalogReview(content: unknown): { preview: CatalogReviewPreview; writeEnabled: boolean } | null {
  if (!content || typeof content !== "object") return null;
  const envelope = content as CatalogReviewEnvelope & Partial<CatalogReviewPreview>;
  const preview = envelope.preview ?? envelope.draft ?? envelope.review ?? envelope as CatalogReviewPreview;
  if (!preview || typeof preview !== "object") return null;
  if (typeof preview.candidateId !== "string" || !preview.candidateId) return null;
  if (typeof preview.candidateInputHash !== "string" || !/^[a-f0-9]{64}$/i.test(preview.candidateInputHash)) return null;
  if (typeof preview.inputHash !== "string" || !/^[a-f0-9]{64}$/i.test(preview.inputHash)) return null;
  if (typeof preview.draftId !== "string" || !preview.draftId) return null;
  if (!preview.proposed || typeof preview.proposed !== "object") return null;
  return { preview, writeEnabled: envelope.writeEnabled ?? preview.writeEnabled ?? false };
}

function planningValue(preview: CatalogReviewPreview, field: string): unknown {
  const fromField = [...(preview.fields ?? []), ...(preview.changes ?? [])].find((entry) => entry.field === field);
  return fromField?.after ?? fromField?.proposed ?? fromField?.value ?? pathValue(preview.proposed, field);
}

function planningSummaryNode(preview: CatalogReviewPreview): HTMLElement {
  const list = document.createElement("ul");
  list.className = "agent-catalog-planning-summary";
  const dimensions = ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "dims.thicknessMm", "dims.slots"]
    .flatMap((field) => {
      const value = planningValue(preview, field);
      return value === undefined ? [] : [`${catalogFieldLabel(field)} ${catalogValue(field, value)}${field === "dims.slots" ? " 槽" : ""}`];
    });
  const tgp = planningValue(preview, "power.tgpW");
  const tdp = planningValue(preview, "power.tdpW");
  const rated = planningValue(preview, "power.ratedW");
  const noise = planningValue(preview, "attrs.noiseDba");
  const temperature = planningValue(preview, "attrs.maxOperatingTempC");
  const heat = tgp !== undefined
    ? `以 ${catalogValue("power.tgpW", tgp)} TGP 作为负载 / 热包络评估输入，不冒充实测温度`
    : preview.proposed.category === "cpu" && tdp !== undefined
      ? `以 ${catalogValue("power.tdpW", tdp)} TDP 作为设计参考；实际功耗仍由方案功耗限制决定`
      : rated !== undefined
        ? `${catalogValue("power.ratedW", rated)} 是额定输出容量，不等于发热；缺少效率 / 损耗证据时热信息保持 unknown`
        : tdp !== undefined
          ? `${catalogValue("power.tdpW", tdp)} 是标称设计能力，不直接当作整机发热`
          : "官网功耗未知，热评估保持 unknown";
  const rows: Array<[string, string]> = [
    ["大小", dimensions.join(" · ") || "官网没有提供可核验尺寸，保持未知"],
    ["发热", heat],
    ["噪音", noise === undefined ? "官网未公布可靠声学值，保持 unknown" : `${catalogValue("attrs.noiseDba", noise)}；不能直接当作整机噪音`],
    ["温度", temperature === undefined ? "官网未公布可靠温度上限，保持 unknown" : `${catalogValue("attrs.maxOperatingTempC", temperature)}；这是工作上限，不是实测温度`],
  ];
  for (const [label, value] of rows) {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    heading.textContent = `${label}：`;
    item.append(heading, document.createTextNode(value));
    list.append(item);
  }
  return list;
}

function proposalFieldLabel(operation: PlanPatchOperation | TopologyV3PatchOperation): string {
  if ("selector" in operation) {
    const { collection, field, id, parentId } = operation.selector;
    const configFields: Record<string, string> = {
      name: "方案名称", intent: "装机意图", requirementSpec: "需求档案",
      requirementBudget: "预算", requirementHorizonYears: "使用周期", system: "系统", notes: "备注",
    };
    if (collection === "config") return configFields[field ?? ""] ?? "方案设置";
    const collections: Record<string, string> = {
      components: "部件", roleDecisions: "角色决定", placements: "安装位", connections: "连接",
      logicalLayouts: "逻辑存储布局", vdevs: "vdev", firmwareTargets: "固件目标",
      workloads: "工作负载", metrics: "需求指标", constraints: "约束",
    };
    const target = id ?? parentId;
    return `${collections[collection] ?? "拓扑设置"}${target ? ` · ${target}` : ""}${field ? ` · ${field}` : ""}`;
  }
  return ({
    "/name": "方案名称", "/caseId": "机箱", "/boardId": "主板", "/cpuId": "处理器",
    "/selection/psuId": "电源", "/selection/psuTopology": "电源安装方式",
    "/selection/secondaryPsuId": "第二颗电源", "/selection/dualStart": "双电源启动方式",
    "/selection/coolerId": "CPU 散热器", "/selection/diskCount": "硬盘数量",
    "/selection/boot": "启动盘", "/selection/nvmeCount": "NVMe 数量",
    "/selection/hbaMode": "硬盘扩展卡", "/selection/gpuId": "显卡", "/selection/memoryId": "内存",
  } as Record<string, string>)[operation.path] ?? "方案设置";
}

function proposalRequirementConfirmationId(kind: "budget" | "horizonYears" | "workload" | "metric" | "constraint", id?: string, parentId?: string): string {
  if (kind === "budget" || kind === "horizonYears") return `requirement:${kind}`;
  if (kind === "metric") return `requirement:metric:${JSON.stringify([parentId?.normalize("NFC"), id?.normalize("NFC")])}`;
  return `requirement:${kind}:${JSON.stringify(id?.normalize("NFC"))}`;
}

function agentRequirementProposal(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).source === "agent_proposed"
    && (value as Record<string, unknown>).confirmedByUser === false;
}

function operationRequirementConfirmationIds(operation: PlanPatchOperation | TopologyV3PatchOperation): string[] {
  if (!("selector" in operation)) return [];
  const ids: string[] = [];
  if (operation.op === "add" && operation.selector.collection === "workloads") {
    if (agentRequirementProposal(operation.value)) ids.push(proposalRequirementConfirmationId("workload", operation.selector.id));
    const workload = operation.value as Record<string, unknown>;
    if (Array.isArray(workload.metrics)) for (const metric of workload.metrics) {
      if (agentRequirementProposal(metric) && typeof metric.metricId === "string") ids.push(proposalRequirementConfirmationId("metric", metric.metricId, operation.selector.id));
    }
  } else if (operation.op === "add" && operation.selector.collection === "metrics" && agentRequirementProposal(operation.value)) {
    ids.push(proposalRequirementConfirmationId("metric", operation.selector.id, operation.selector.parentId));
  } else if (operation.op === "add" && operation.selector.collection === "constraints" && agentRequirementProposal(operation.value)) {
    ids.push(proposalRequirementConfirmationId("constraint", operation.selector.id));
  } else if (operation.op === "replace" && operation.selector.collection === "config") {
    if (operation.selector.field === "requirementBudget" && agentRequirementProposal(operation.value)) ids.push(proposalRequirementConfirmationId("budget"));
    else if (operation.selector.field === "requirementHorizonYears" && agentRequirementProposal(operation.value)) ids.push(proposalRequirementConfirmationId("horizonYears"));
    else if (operation.selector.field === "requirementSpec" && operation.value && typeof operation.value === "object" && !Array.isArray(operation.value)) {
      const spec = operation.value as Record<string, unknown>;
      if (agentRequirementProposal(spec.budget)) ids.push(proposalRequirementConfirmationId("budget"));
      if (agentRequirementProposal(spec.horizonYears)) ids.push(proposalRequirementConfirmationId("horizonYears"));
      if (Array.isArray(spec.workloads)) for (const workload of spec.workloads) {
        if (!workload || typeof workload !== "object" || Array.isArray(workload)) continue;
        const row = workload as Record<string, unknown>;
        if (agentRequirementProposal(row) && typeof row.workloadId === "string") ids.push(proposalRequirementConfirmationId("workload", row.workloadId));
        if (typeof row.workloadId === "string" && Array.isArray(row.metrics)) for (const metric of row.metrics) {
          if (agentRequirementProposal(metric) && typeof metric.metricId === "string") ids.push(proposalRequirementConfirmationId("metric", metric.metricId, row.workloadId));
        }
      }
      if (Array.isArray(spec.constraints)) for (const constraint of spec.constraints) {
        if (agentRequirementProposal(constraint) && typeof constraint.constraintId === "string") ids.push(proposalRequirementConfirmationId("constraint", constraint.constraintId));
      }
    }
  }
  return ids;
}

function proposalNode(
  proposal: PlanChangeProposal<BuildConfigDocument>,
  onApply: (indexes: number[], confirmedRequirementFieldIds: string[], card: HTMLElement) => Promise<void>,
  onReject: (card: HTMLElement) => void,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "agent-plan-proposal";
  card.dataset.planProposal = proposal.id;
  const heading = document.createElement("h4"); heading.textContent = proposal.summary;
  const technical = document.createElement("details"); technical.className = "agent-proposal-technical";
  const technicalSummary = document.createElement("summary"); technicalSummary.textContent = "查看技术校验信息";
  const meta = document.createElement("p"); meta.textContent = `方案修改 · 方案 ${proposal.planId} · revision ${proposal.expectedDraftRevision} · config ${proposal.expectedConfigHash.slice(0, 12)}`;
  technical.append(technicalSummary, meta);
  const list = document.createElement("ol");
  const operationCheckboxes: HTMLInputElement[] = [];
  proposal.operations.forEach((operation, index) => {
    const item = document.createElement("li");
    const label = document.createElement("label"); const checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.checked = true; checkbox.dataset.proposalOperation = String(index);
    operationCheckboxes.push(checkbox);
    const value = operation.op === "remove" ? "不再使用" : JSON.stringify(operation.value);
    label.append(checkbox, ` ${proposalFieldLabel(operation)}：${value.length > 80 ? `${value.slice(0, 80)}…` : value}`); item.append(label); list.append(item);
  });
  const confirmationHost = document.createElement("fieldset");
  confirmationHost.dataset.proposalRequirementConfirmations = "";
  const confirmationLegend = document.createElement("legend");
  confirmationLegend.textContent = "可选：确认 Agent 建议的需求字段进入求解";
  confirmationHost.append(confirmationLegend);
  const authorizedConfirmationIds = new Set(proposal.confirmableRequirementFieldIds ?? []);
  const confirmationOwners = new Map<string, Set<number>>();
  proposal.operations.forEach((operation, index) => {
    for (const id of operationRequirementConfirmationIds(operation)) {
      if (!authorizedConfirmationIds.has(id)) continue;
      const owners = confirmationOwners.get(id) ?? new Set<number>();
      owners.add(index); confirmationOwners.set(id, owners);
    }
  });
  const confirmationCheckboxes: HTMLInputElement[] = [];
  for (const id of [...authorizedConfirmationIds].sort()) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = false;
    checkbox.dataset.proposalRequirementConfirmation = id;
    const owners = confirmationOwners.get(id) ?? new Set(proposal.operations.map((_, index) => index));
    checkbox.dataset.proposalConfirmationOperationIndexes = JSON.stringify([...owners]);
    label.append(checkbox, ` 确认此需求字段：${id}`);
    confirmationHost.append(label);
    confirmationCheckboxes.push(checkbox);
  }
  const syncConfirmations = () => {
    let visible = 0;
    for (const checkbox of confirmationCheckboxes) {
      const owners = JSON.parse(checkbox.dataset.proposalConfirmationOperationIndexes ?? "[]") as number[];
      const enabled = owners.some((index) => operationCheckboxes[index]?.checked);
      checkbox.disabled = !enabled;
      checkbox.parentElement!.hidden = !enabled;
      if (!enabled) checkbox.checked = false;
      if (enabled) visible += 1;
    }
    confirmationHost.hidden = visible === 0;
  };
  operationCheckboxes.forEach((checkbox) => checkbox.addEventListener("change", syncConfirmations));
  syncConfirmations();
  const impact = document.createElement("p");
  impact.className = "agent-proposal-impact";
  impact.textContent = `预计解决 ${proposal.predictedImpact.resolvedFindingIds.length} 个问题 · 可能新增 ${proposal.predictedImpact.introducedFindingIds.length} 个提醒 · ${proposal.predictedImpact.budgetDeltaCny === null ? "价格影响仍需确认" : `预算变化 ${proposal.predictedImpact.budgetDeltaCny >= 0 ? "+" : ""}${proposal.predictedImpact.budgetDeltaCny} 元`}`;
  const approvalLabel = document.createElement("label"); const approval = document.createElement("input");
  approval.type = "checkbox"; approval.dataset.proposalApproval = ""; approvalLabel.append(approval, " 我已审阅所选字段并批准写入当前草稿");
  const actions = document.createElement("div"); const apply = document.createElement("button"); const reject = document.createElement("button");
  apply.type = "button"; apply.textContent = "应用所选项"; apply.disabled = true; apply.dataset.applyProposal = "";
  reject.type = "button"; reject.textContent = "拒绝"; reject.dataset.rejectProposal = "";
  const state = document.createElement("p"); state.dataset.proposalState = ""; state.textContent = "等待你确认 · 方案尚未改变";
  approval.addEventListener("change", () => { apply.disabled = !approval.checked; });
  apply.addEventListener("click", async () => {
    const indexes = [...card.querySelectorAll<HTMLInputElement>("[data-proposal-operation]:checked")].map((entry) => Number(entry.dataset.proposalOperation));
    if (!indexes.length) { state.textContent = "至少选择一项修改。"; return; }
    const confirmedRequirementFieldIds = [...card.querySelectorAll<HTMLInputElement>("[data-proposal-requirement-confirmation]:checked:not(:disabled)")]
      .map((entry) => entry.dataset.proposalRequirementConfirmation!);
    apply.disabled = true; reject.disabled = true; state.textContent = "正在重新检查型号、兼容性和预算影响…";
    try { await onApply(indexes, confirmedRequirementFieldIds, card); } catch (error) { state.textContent = `无法应用：${text((error as Error).message)}`; reject.disabled = false; }
  });
  reject.addEventListener("click", () => onReject(card));
  actions.append(apply, reject); card.append(heading, list, confirmationHost, impact, approvalLabel, actions, state, technical);
  return card;
}

function catalogReviewNode(
  preview: CatalogReviewPreview,
  writeEnabled: boolean,
  onConfirm: (card: HTMLElement, state: HTMLElement) => Promise<void>,
  onReject: (card: HTMLElement) => void,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "agent-catalog-review";
  card.dataset.catalogReview = preview.draftId;
  card.dataset.candidateId = preview.candidateId;

  const header = document.createElement("header");
  const headingWrap = document.createElement("div");
  const eyebrow = document.createElement("small");
  const updating = preview.operation === "update" || Boolean(preview.baseSkuId);
  eyebrow.textContent = updating ? "补充现有配置选项" : "新增配置选项";
  const heading = document.createElement("h4");
  heading.textContent = preview.proposed.name ?? ([preview.proposed.brand, preview.proposed.model].filter(Boolean).join(" ") || "Agent SKU 审核提案");
  headingWrap.append(eyebrow, heading);
  const badge = document.createElement("span");
  badge.textContent = updating ? `更新 ${preview.baseSkuId ?? "现有 SKU"}` : "新建 SKU";
  header.append(headingWrap, badge);

  const identity = document.createElement("dl");
  identity.className = "agent-catalog-identity";
  for (const [label, value] of [
    ["品牌", preview.proposed.brand ?? "未知"],
    ["型号", preview.proposed.model ?? "未知"],
    ["制造商料号（可选）", preview.proposed.mpn ?? "官网未提供；精确品牌与型号仍可进入审核"],
  ] as Array<[string, unknown]>) {
    const term = document.createElement("dt"); term.textContent = label;
    const description = document.createElement("dd"); description.textContent = String(value);
    identity.append(term, description);
  }

  const sourceUrl = preview.candidateSnapshot?.official?.trustStatus === "trusted"
    ? trustedHttpsUrl(preview.candidateSnapshot.canonicalUrl ?? preview.candidateSnapshot.url)
    : null;
  if (sourceUrl) {
    const source = document.createElement("a");
    source.href = sourceUrl; source.target = "_blank"; source.rel = "noreferrer";
    source.textContent = "打开已核验官网页面";
    card.append(header, identity, source);
  } else {
    card.append(header, identity);
  }

  const changed = new Set(preview.changedFields ?? []);
  const fields = preview.changes?.length ? preview.changes : preview.fields ?? [];
  const fieldList = document.createElement("dl");
  fieldList.className = "agent-catalog-fields";
  for (const field of fields) {
    const fieldName = field.field;
    if (!fieldName) continue;
    const after = field.after ?? field.proposed ?? field.value ?? pathValue(preview.proposed, fieldName);
    const hasExplicitBefore = Object.hasOwn(field, "before") || Object.hasOwn(field, "existing");
    const before = field.before ?? field.existing;
    const term = document.createElement("dt");
    term.textContent = catalogFieldLabel(fieldName);
    const description = document.createElement("dd");
    const value = document.createElement("span");
    value.textContent = updating && (hasExplicitBefore || changed.has(fieldName))
      ? `${catalogValue(fieldName, before)} → ${catalogValue(fieldName, after)}`
      : catalogValue(fieldName, after);
    const provenance = document.createElement("small");
    const metadata = [evidenceLabel(field), field.sourceKind, field.extractor, field.retrievedAt].filter(Boolean).join(" · ");
    provenance.textContent = metadata || "字段来源待确认";
    const fieldSource = trustedHttpsUrl(field.sourceUrl);
    if (fieldSource && field.sourceKind?.startsWith("official")) {
      const link = document.createElement("a");
      link.href = fieldSource; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "查看来源";
      provenance.append(" · ", link);
    }
    description.append(value, provenance);
    fieldList.append(term, description);
  }
  if (!fieldList.childElementCount) {
    const empty = document.createElement("p");
    empty.textContent = "提案没有可核验字段，不能据此补充配置选项。";
    fieldList.append(empty);
  }
  card.append(fieldList, planningSummaryNode(preview));

  const conflicts = preview.conflicts ?? [];
  const missing = preview.missing ?? [];
  if (conflicts.length) {
    const block = document.createElement("section");
    block.className = "agent-catalog-review-problems";
    const title = document.createElement("strong"); title.textContent = `存在 ${conflicts.length} 项冲突，不能接纳`;
    const list = document.createElement("ul");
    for (const conflict of conflicts) {
      const item = document.createElement("li");
      item.textContent = `${catalogFieldLabel(conflict.field)}：${catalogValue(conflict.field, conflict.existing)} → ${catalogValue(conflict.field, conflict.proposed)}${conflict.reason ? ` · ${conflict.reason}` : ""}`;
      list.append(item);
    }
    block.append(title, list); card.append(block);
  }
  if (missing.length) {
    const block = document.createElement("p");
    block.className = "agent-catalog-review-missing";
    block.textContent = `仍缺少接纳所需的官网事实：${missing.map(catalogFieldLabel).join("、")}。未知值不会由 Agent 编造。`;
    card.append(block);
  }

  const approvalLabel = document.createElement("label");
  const approval = document.createElement("input");
  approval.type = "checkbox"; approval.dataset.catalogApproval = "";
  approvalLabel.append(approval, document.createTextNode(" 我已核对品牌、型号、版本与官网来源，同意写入正式目录"));
  const actions = document.createElement("div");
  const accept = document.createElement("button");
  accept.type = "button"; accept.dataset.acceptCatalogReview = ""; accept.textContent = "接纳并加入配置选项"; accept.disabled = true;
  const reject = document.createElement("button");
  reject.type = "button"; reject.dataset.rejectCatalogReview = ""; reject.textContent = "拒绝";
  const state = document.createElement("p");
  state.dataset.catalogReviewState = "";
  const blocked = !writeEnabled || conflicts.length > 0 || missing.length > 0 || !fieldList.querySelector("dt");
  state.textContent = !writeEnabled
    ? "Agent 已生成审核提案，但当前服务器关闭了正式目录写入。"
    : conflicts.length ? "请让 Agent 查找没有冲突的官方页面。"
      : missing.length ? "信息仍不完整；可以继续让 Agent 搜索，当前提案不会写入。"
        : "等待你审核 · 当前目录和方案都没有改变";
  approval.addEventListener("change", () => { accept.disabled = blocked || !approval.checked; });
  accept.addEventListener("click", async () => {
    accept.disabled = true; reject.disabled = true; approval.disabled = true;
    state.textContent = "正在固化审核快照并重新校验…";
    try { await onConfirm(card, state); }
    catch (error) {
      state.textContent = `接纳失败：${text((error as Error).message)}。提案仍保留，可重试。`;
      reject.disabled = false; approval.disabled = false; accept.disabled = blocked || !approval.checked;
    }
  });
  reject.addEventListener("click", () => onReject(card));
  actions.append(accept, reject);
  const technical = document.createElement("details");
  const technicalSummary = document.createElement("summary"); technicalSummary.textContent = "查看不可变校验信息";
  const technicalBody = document.createElement("small");
  technicalBody.textContent = `candidate ${preview.candidateId} · candidate hash ${preview.candidateInputHash.slice(0, 12)} · preview hash ${preview.inputHash.slice(0, 12)}${preview.baseSkuHash ? ` · base ${preview.baseSkuHash.slice(0, 12)}` : ""}${preview.baseCatalogVersion ? ` · catalog ${preview.baseCatalogVersion}` : ""}`;
  technical.append(technicalSummary, technicalBody);
  card.append(approvalLabel, actions, state, technical);
  return card;
}

export async function initAgentPanel(options: AgentPanelOptions): Promise<AgentPanelController | null> {
  const model = byId<HTMLSelectElement>("agent-model");
  const skill = byId<HTMLSelectElement>("agent-skill");
  const status = byId<HTMLElement>("agent-status");
  const transcript = byId<HTMLElement>("agent-transcript");
  const events = byId<HTMLElement>("agent-events");
  const form = byId<HTMLFormElement>("agent-form");
  const input = byId<HTMLTextAreaElement>("agent-input");
  const send = byId<HTMLButtonElement>("agent-send");
  const cancel = byId<HTMLButtonElement>("agent-cancel");
  const reset = byId<HTMLButtonElement>("agent-new-session");
  const usage = byId<HTMLElement>("agent-usage");
  if (!model || !skill || !status || !transcript || !events || !form || !input || !send || !cancel || !reset || !usage) return null;

  const contextBadge = document.createElement("details");
  contextBadge.className = "agent-plan-context";
  contextBadge.dataset.agentPlanContext = "";
  contextBadge.setAttribute("aria-live", "polite");
  status.insertAdjacentElement("afterend", contextBadge);
  const proposalHost = document.createElement("section");
  proposalHost.className = "agent-plan-proposals";
  proposalHost.dataset.agentPlanProposals = "";
  proposalHost.setAttribute("aria-label", "Agent 待审核提案");
  form.parentElement?.insertBefore(proposalHost, form);

  const fetchImpl = options.fetchImpl ?? fetch;
  const eventSourceFactory = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  let session: AgentSession | null = null;
  let activeRunId: string | null = null;
  let stream: EventStream | null = null;
  let assistantBody: HTMLElement | null = null;
  let catalogReady = false;
  let boundContext: PlanAgentContext | null = null;
  const catalogReviewKeys = new Set<string>();
  const writeApprovalKeys = new Set<string>();

  const currentContext = async () => await (options.getPlanContext?.() ?? null);
  const setContextCopy = (summaryText: string, detailText: string) => {
    const summary = document.createElement("summary");
    const detail = document.createElement("small");
    summary.textContent = summaryText;
    detail.textContent = detailText;
    contextBadge.replaceChildren(summary, detail);
  };
  let contextRefreshGeneration = 0;
  const refreshContextBadge = async () => {
    const generation = ++contextRefreshGeneration;
    let current: PlanAgentContext | null;
    try { current = await currentContext(); }
    catch { current = null; }
    if (generation !== contextRefreshGeneration) return;
    if (!current) {
      setContextCopy("尚未同步装机方案", "普通问答仍可使用；同步方案后才能给出可直接确认的配置建议。");
      contextBadge.dataset.stale = "true";
      return;
    }
    const stale = isPlanAgentContextStale(boundContext, current);
    contextBadge.dataset.stale = String(stale);
    const friendly = boundContext && stale ? "方案刚有变化 · 下次发送时会自动同步" : "已同步当前装机方案";
    const technicalState = boundContext ? stale ? "context stale，发送时刷新" : "context current" : "尚未发送";
    setContextCopy(friendly, `方案 ${current.planId} · revision ${current.draftRevision} · evaluation ${current.evaluationHash.slice(0, 12)} · ${technicalState}`);
    input.placeholder = "例如：预算 8000 元，先记录 2K 游戏需求；其余信息请逐项问我";
  };
  void refreshContextBadge();
  const unsubscribePlanContext = options.subscribePlanContext?.(() => { void refreshContextBadge(); }) ?? (() => undefined);

  const setStatus = (content: string, level: "ok" | "warn" | "bad" = "warn") => {
    status.textContent = content;
    status.dataset.level = level;
  };

  const receiveProposal = async (content: unknown) => {
    const proposal = content && typeof content === "object" ? (content as { proposal?: PlanChangeProposal }).proposal : undefined;
    if (!proposal) return;
    try {
      const validated = await workspaceJson<{ proposal: PlanChangeProposal }>(fetchImpl, `/plans/${encodeURIComponent(proposal.planId)}/proposals/validate`, { method: "POST", body: JSON.stringify({ proposal }) });
      const card = proposalNode(validated.proposal, async (indexes, confirmedRequirementFieldIds, target) => {
        const current = await currentContext();
        if (!current) throw new Error("当前方案尚未完成同步，请等待评估完成后重新生成提案。");
        if (current.planId !== validated.proposal.planId) throw new Error("当前方案已经切换；这张提案卡不会修改原方案，请重新生成建议。");
        if (current.draftRevision !== validated.proposal.expectedDraftRevision || current.configHash !== validated.proposal.expectedConfigHash) {
          throw new Error("当前草稿已发生变化；这张提案卡已过期，请基于最新方案重新生成建议。");
        }
        const result = await workspaceJson<{ proposal: PlanChangeProposal; plan: BuildPlan<BuildConfigDocument>; audit: { approvalId: string } }>(fetchImpl, `/plans/${encodeURIComponent(validated.proposal.planId)}/proposals/apply`, {
          method: "POST",
          body: JSON.stringify({
            proposal: validated.proposal,
            operationIndexes: indexes,
            approvalConfirmed: true,
            approvedBy: "local-human",
            confirmedRequirementFieldIds,
          }),
        });
        boundContext = null;
        void refreshContextBadge();
        if (!options.acceptServerPlan) throw new Error("方案已写入，但浏览器无法安装服务端草稿；上下文保持停用。");
        await options.acceptServerPlan(result.plan);
        const refreshedConfigHash = await hashPlanConfig(result.plan.draft.config);
        let refreshed: PlanAgentContext | null = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          refreshed = await currentContext();
          if (refreshed && refreshed.planId !== result.plan.id) break;
          if (refreshed && refreshed.draftRevision === result.plan.draftRevision
            && refreshed.configHash === refreshedConfigHash
            && refreshed.buildConfig.schemaVersion === result.plan.draft.config.schemaVersion) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!refreshed) throw new Error("方案已写入，但最新评估上下文尚未就绪；请刷新评估后继续。");
        if (refreshed.planId !== result.plan.id) throw new Error("方案已写入，但当前活动方案已经切换；请在新方案中继续。");
        if (refreshed.draftRevision !== result.plan.draftRevision) throw new Error("方案已写入，但评估仍对应旧草稿修订；请等待重新检查完成。");
        if (refreshed.configHash !== refreshedConfigHash) throw new Error("方案已写入，但评估配置与最新草稿不一致；请等待重新检查完成。");
        if (refreshed.buildConfig.schemaVersion !== result.plan.draft.config.schemaVersion) throw new Error("方案已写入，但评估配置版本尚未同步；请刷新后继续。");
        target.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((control) => { control.disabled = true; });
        target.querySelector<HTMLElement>("[data-proposal-state]")!.textContent = "修改已应用 · 已进入当前方案，尚未保存为检查点";
      }, (target) => {
        target.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((control) => { control.disabled = true; });
        target.querySelector<HTMLElement>("[data-proposal-state]")!.textContent = "已放弃这条建议 · 方案没有改变";
      });
      proposalHost.prepend(card);
    } catch (error) {
      const notice = messageNode("notice", `提案验证失败：${text((error as Error).message)}`);
      proposalHost.prepend(notice);
    }
  };
  const onProposal = (event: Event) => {
    void receiveProposal((event as CustomEvent<unknown>).detail);
  };
  proposalHost.addEventListener("build-sim:agent-plan-proposal", onProposal);
  const receiveCatalogReview = (content: unknown) => {
    const normalized = normalizedCatalogReview(content);
    if (!normalized) {
      proposalHost.prepend(messageNode("notice", "目录审核提案格式无效；没有执行任何写入。"));
      return;
    }
    const { preview, writeEnabled } = normalized;
    const key = `${preview.candidateId}:${preview.inputHash}`;
    if (catalogReviewKeys.has(key)) return;
    catalogReviewKeys.add(key);
    const card = catalogReviewNode(preview, writeEnabled, async (target, stateNode) => {
      const persistedEnvelope = await priceJson<CatalogReviewPreview | { draft?: CatalogReviewPreview }>(fetchImpl, `/catalog/candidates/${encodeURIComponent(preview.candidateId)}/draft`, {
        method: "POST",
        body: JSON.stringify({ expectedHash: preview.candidateInputHash, expectedDraftHash: preview.inputHash, selections: {} }),
      });
      const persisted = "draft" in persistedEnvelope && persistedEnvelope.draft ? persistedEnvelope.draft : persistedEnvelope as CatalogReviewPreview;
      if (persisted.status !== "draft") throw new Error(`持久化草稿状态异常：${text(persisted.status ?? "unknown")}`);
      if (persisted.candidateId !== preview.candidateId || persisted.draftId !== preview.draftId) throw new Error("持久化草稿与已审核候选不一致");
      if (persisted.inputHash !== preview.inputHash) throw new Error("持久化草稿与审核预览的不可变哈希不一致");
      stateNode.textContent = "审核快照一致，正在写入正式目录…";
      const confirmationEnvelope = await priceJson<CatalogAcceptanceResult | { result?: CatalogAcceptanceResult }>(fetchImpl, `/catalog-drafts/${encodeURIComponent(persisted.draftId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ approved: true, expectedHash: persisted.inputHash }),
      });
      const confirmation = "result" in confirmationEnvelope && confirmationEnvelope.result ? confirmationEnvelope.result : confirmationEnvelope as CatalogAcceptanceResult;
      if (!confirmation.sku || !["confirmed", "accepted"].includes(confirmation.status ?? "")) {
        throw new Error(confirmation.reasons?.join("；") ?? confirmation.reason ?? "服务没有返回已确认的 SKU");
      }
      target.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((control) => { control.disabled = true; });
      target.dataset.state = "confirmed";
      stateNode.textContent = `${confirmation.sku.name} 已写入正式目录，正在同步本页配置选项…`;
      try {
        await options.onCatalogSkuAccepted?.(confirmation.sku);
        stateNode.textContent = `${confirmation.sku.name} 已加入正式目录和配置选项；当前方案没有自动改变。`;
      } catch {
        // Server confirmation is the irreversible boundary. A browser refresh
        // failure must never make a committed draft look retryable/rejectable.
        stateNode.textContent = `${confirmation.sku.name} 已写入正式目录；本页同步失败，请刷新页面。当前方案没有自动改变。`;
      }
    }, (target) => {
      target.remove();
    });
    proposalHost.prepend(card);
  };
  const setBusy = (busy: boolean) => {
    send.disabled = busy || !catalogReady;
    cancel.disabled = !busy || !activeRunId;
    model.disabled = busy || !catalogReady;
    skill.disabled = busy || !catalogReady;
    reset.disabled = busy || !catalogReady;
    input.setAttribute("aria-busy", String(busy));
  };
  const populateModels = (models: ProviderModel[], preferred = model.value): void => {
    model.replaceChildren(...models.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.dataset.provider = entry.provider;
      option.textContent = `${entry.label} · ${entry.provider}`;
      option.title = [entry.capabilities.tools ? "Tools" : null, entry.capabilities.thinking ? "推理" : null, entry.capabilities.structuredOutput ? "结构化输出" : null].filter(Boolean).join(" · ");
      return option;
    }));
    model.value = preferred && models.some((entry) => entry.id === preferred) ? preferred : models[0]?.id ?? "";
  };
  const addEvent = (content: string, level: "ok" | "warn" | "bad" = "ok") => {
    const item = document.createElement("li");
    item.textContent = content;
    item.dataset.level = level;
    events.append(item);
  };
  const clearConversation = () => {
    session = null;
    activeRunId = null;
    stream?.close();
    stream = null;
    transcript.replaceChildren(welcomeNode());
    events.replaceChildren();
    proposalHost.replaceChildren();
    catalogReviewKeys.clear();
    writeApprovalKeys.clear();
    usage.textContent = "尚无用量记录";
    assistantBody = null;
    boundContext = null;
    void refreshContextBadge();
  };

  const createSession = async (): Promise<AgentSession> => {
    if (session) return session;
    const establish = async (): Promise<AgentSession> => {
      const selected = model.selectedOptions[0];
      if (!selected?.value) throw new Error("没有可用的 Agent 模型");
      return json<AgentSession>(fetchImpl, "/sessions", {
        method: "POST",
        body: JSON.stringify({ provider: selected.dataset.provider, model: selected.value }),
      });
    };
    try {
      session = await establish();
    } catch (error) {
      if (!/Unknown Agent model/.test((error as Error).message)) throw error;
      const refreshed = await json<{ models: ProviderModel[] }>(fetchImpl, "/models");
      if (!refreshed.models.length) throw error;
      populateModels(refreshed.models);
      addEvent("Agent 服务已重启，模型目录已自动刷新；本次请求使用当前可用模型。", "warn");
      session = await establish();
    }
    setStatus(`会话已建立 · ${session.model}`, "ok");
    return session;
  };

  const syncAssistant = async (sessionId: string): Promise<void> => {
    const saved = await json<AgentSession>(fetchImpl, `/sessions/${encodeURIComponent(sessionId)}`);
    session = saved;
    const latest = [...saved.messages].reverse().find((entry: AgentMessage) => entry.role === "assistant");
    if (!latest) return;
    if (!assistantBody) {
      const row = messageNode("assistant", latest.content);
      transcript.append(row);
      assistantBody = row.querySelector<HTMLElement>(".agent-message-body");
    } else {
      assistantBody.textContent = latest.content;
    }
  };

  const watchRun = (runId: string, sessionId: string) => {
    let finished = false;
    const totals = { calls: 0, input: 0, output: 0, tokens: 0, cost: 0, unknownCost: 0 };
    const source = eventSourceFactory(`${API}/runs/${encodeURIComponent(runId)}/events`);
    stream = source;
    const finish = async (state: string) => {
      if (finished) return;
      finished = true;
      source.close();
      stream = null;
      activeRunId = null;
      try { await syncAssistant(sessionId); } catch (error) { addEvent(`会话同步失败：${text((error as Error).message)}`, "warn"); }
      try {
        const audit = await json<AgentRunAuditRecord>(fetchImpl, `/runs/${encodeURIComponent(runId)}/audit`);
        addEvent(`审计记录 · ${audit.status} · ${audit.recordHash.slice(0, 12)}`, audit.status === "completed" ? "ok" : "warn");
      } catch (error) {
        addEvent(`审计读取失败：${text((error as Error).message)}`, "warn");
      }
      setBusy(false);
      if (state === "completed") setStatus("回答完成 · 确定性事实仍以 BuildEvaluation 为准", "ok");
      else if (state === "cancelled") setStatus("本次运行已取消", "warn");
      else setStatus(`本次运行结束：${state}`, "bad");
    };
    const parse = <T extends AgentRunEvent>(event: Event): T | null => {
      const data = (event as MessageEvent<string>).data;
      if (!data) return null;
      try { return JSON.parse(data) as T; } catch { return null; }
    };
    source.addEventListener("skill_activated", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "skill_activated" }>>(event);
      if (data) addEvent(`Skill · ${data.skillId} · ${data.definitionHash.slice(0, 12)}`);
    });
    source.addEventListener("text_delta", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "text_delta" }>>(event);
      if (!data) return;
      if (!assistantBody) {
        const row = messageNode("assistant", "");
        transcript.append(row);
        assistantBody = row.querySelector<HTMLElement>(".agent-message-body");
      }
      if (assistantBody) assistantBody.textContent += data.text;
      transcript.scrollTop = transcript.scrollHeight;
    });
    source.addEventListener("tool_call", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "tool_call" }>>(event);
      if (data) addEvent(`调用 Tool · ${data.call.name} · ${data.toolDefinitionHash.slice(0, 12)}`);
    });
    source.addEventListener("approval_required", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "approval_required" }>>(event);
      if (!data || writeApprovalKeys.has(data.pending.approvalId)) return;
      writeApprovalKeys.add(data.pending.approvalId);
      const card = writeApprovalNode(
        data.pending,
        async () => {
          await json(fetchImpl, `/runs/${encodeURIComponent(data.runId)}/approvals/${encodeURIComponent(data.pending.approvalId)}/confirm`, {
            method: "POST",
            body: JSON.stringify({ nonce: data.pending.nonce, approvedBy: "local-human" }),
          });
          setStatus("写入已批准，正在继续同一 Agent 运行…", "ok");
        },
        async () => {
          await json(fetchImpl, `/runs/${encodeURIComponent(data.runId)}/approvals/${encodeURIComponent(data.pending.approvalId)}/reject`, {
            method: "POST",
            body: JSON.stringify({ nonce: data.pending.nonce }),
          });
          setStatus("已拒绝写入并取消本次运行", "warn");
        },
      );
      proposalHost.prepend(card);
      setStatus(`等待你审核写入 · ${data.pending.toolTitle}`, "warn");
    });
    source.addEventListener("tool_result", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "tool_result" }>>(event);
      if (data) {
        const summary = formatCatalogToolResult(data.toolName, data.result.content);
        addEvent(`Tool 结果 · ${data.toolName} · ${data.result.ok ? "ok" : data.result.errorCode ?? "error"}${summary ? ` · ${summary}` : ""}`, data.result.ok ? "ok" : "warn");
        if (data.result.ok && data.toolName === "propose_plan_change") void receiveProposal(data.result.content);
        if (data.result.ok && data.toolName === "propose_catalog_review") receiveCatalogReview(data.result.content);
      }
    });
    source.addEventListener("usage", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "usage" }>>(event);
      if (!data) return;
      totals.calls += 1;
      totals.input += data.usage.inputTokens ?? 0;
      totals.output += data.usage.outputTokens ?? 0;
      totals.tokens += data.usage.totalTokens ?? 0;
      if (data.billing?.cost) totals.cost += data.billing.cost.totalCny;
      else totals.unknownCost += 1;
      const band = data.billing?.pricing.pricingBand?.label;
      const cost = data.billing?.cost ? ` · 估算费用 ${cny(totals.cost)}${band ? `（${band}）` : ""}` : ` · 费用 ${data.billing?.status ?? "unknown"}`;
      usage.textContent = `${data.provider} / ${data.model} · ${totals.calls} 次调用 · input ${totals.input} · output ${totals.output} · total ${totals.tokens}${cost}${totals.unknownCost ? ` · ${totals.unknownCost} 次未估价` : ""} · 非余额账单`;
    });
    source.addEventListener("error", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "error" }>>(event);
      if (data) addEvent(`${data.code} · ${data.message}`, "bad");
      else if (!finished) setStatus("事件流连接中断，正在核对运行状态…", "warn");
    });
    source.addEventListener("run_status", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "run_status" }>>(event);
      if (!data) return;
      if (["completed", "failed", "cancelled", "limit_exceeded"].includes(data.status)) void finish(data.status);
      else if (data.status === "waiting_approval") setStatus("Agent 等待人工写入审批 · 尚未执行写入", "warn");
      else setStatus(`Agent 运行中 · ${data.status}`, "ok");
    });
  };

  try {
    const [modelPayload, skillPayload] = await Promise.all([
      json<{ models: ProviderModel[] }>(fetchImpl, "/models"),
      json<{ skills: SkillEntry[] }>(fetchImpl, "/skills"),
    ]);
    populateModels(modelPayload.models);
    const general = document.createElement("option");
    general.value = "";
    general.textContent = "通用对话 · 安全读取与审核提案";
    const skillOptions = skillPayload.skills.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.manifest.id;
      option.textContent = `${entry.manifest.name} · ${entry.manifest.allowedTools.length} Tools`;
      option.title = entry.manifest.description;
      return option;
    });
    skill.replaceChildren(general, ...skillOptions);
    skill.value = "";
    if (!modelPayload.models.length) throw new Error("服务端没有可用模型");
    catalogReady = true;
    setBusy(false);
    setStatus(`装机助手已就绪 · ${modelPayload.models.length} 个模型 · ${skillPayload.skills.length} 项能力`, "ok");
  } catch (error) {
    setStatus(`Agent 服务不可用：${text((error as Error).message)}`, "warn");
    send.disabled = true;
  }

  const onModelChange = () => {
    clearConversation();
    setStatus("模型已切换；下一条消息将创建新会话", "warn");
  };
  const onReset = () => {
    clearConversation();
    setBusy(false);
    setStatus("已清空本地会话；下一条消息将创建新会话", "warn");
  };
  const onCancel = async () => {
    if (!activeRunId) return;
    cancel.disabled = true;
    try { await json(fetchImpl, `/runs/${encodeURIComponent(activeRunId)}/cancel`, { method: "POST", body: "{}" }); }
    catch (error) { setStatus(`取消失败：${text((error as Error).message)}`, "bad"); }
  };
  const onInputKeydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
  };
  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || activeRunId) return;
    setBusy(true);
    assistantBody = null;
    events.replaceChildren();
    usage.textContent = "等待 provider usage…";
    transcript.append(messageNode("user", content));
    input.value = "";
    try {
      const planContext = await currentContext();
      if (!planContext && options.requirePlanContext?.()) throw new Error("当前方案评估上下文尚未就绪；没有启动 Agent run。");
      if (session && boundContext && planContext && boundContext.planId !== planContext.planId) clearConversation();
      const current = await createSession();
      const idempotencyKey = planContext ? `context-${crypto.randomUUID()}` : undefined;
      const contextAudit = planContext ? await workspaceJson<{ runId: string; context: PlanAgentContext }>(fetchImpl, "/agent-context", {
        method: "POST",
        body: JSON.stringify({ sessionId: current.id, idempotencyKey, context: planContext }),
      }) : null;
      const auditedContext = contextAudit?.context ?? null;
      if (planContext && !auditedContext) throw new Error("方案上下文审计未返回服务端派生上下文");
      const agentContent = auditedContext ? planAgentContextEnvelope(content, auditedContext) : content;
      if (auditedContext) addEvent(`方案上下文审计 · ${auditedContext.planId} r${auditedContext.draftRevision} · ${auditedContext.evaluationHash.slice(0, 12)}`);
      const run = await json<{ runId: string }>(fetchImpl, `/sessions/${encodeURIComponent(current.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: agentContent, buildConfig: auditedContext?.buildConfig ?? options.getBuildConfig(), ...(skill.value ? { skillId: skill.value } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) }),
      });
      if (contextAudit && run.runId !== contextAudit.runId) throw new Error("Agent run 与已审计方案上下文不一致");
      if (auditedContext) {
        boundContext = structuredClone(auditedContext);
        void refreshContextBadge();
      }
      activeRunId = run.runId;
      cancel.disabled = false;
      setStatus("请求已提交，等待流式响应…", "ok");
      watchRun(run.runId, current.id);
    } catch (error) {
      setBusy(false);
      setStatus(`发送失败：${text((error as Error).message)}`, "bad");
      transcript.append(messageNode("notice", `发送失败：${text((error as Error).message)}`));
    }
  };
  model.addEventListener("change", onModelChange);
  reset.addEventListener("click", onReset);
  cancel.addEventListener("click", onCancel);
  input.addEventListener("keydown", onInputKeydown);
  form.addEventListener("submit", onSubmit);
  return {
    getSessionId: () => session?.id ?? null,
    ensureSessionId: async () => (await createSession()).id,
    dispose() {
      stream?.close(); stream = null; activeRunId = null;
      unsubscribePlanContext();
      proposalHost.removeEventListener("build-sim:agent-plan-proposal", onProposal);
      model.removeEventListener("change", onModelChange);
      reset.removeEventListener("click", onReset);
      cancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onInputKeydown);
      form.removeEventListener("submit", onSubmit);
      proposalHost.remove(); contextBadge.remove();
    },
  };
}
