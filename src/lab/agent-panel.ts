import type { AgentMessage, AgentRunAuditRecord, AgentRunEvent, AgentSession, ProviderModel } from "../agent/contracts";
import type { BuildPlan, PlanAgentContext, PlanChangeProposal } from "../plans/contracts";
import { isPlanAgentContextStale, planAgentContextEnvelope } from "../agent/plan-context";

const API = "/api/agent";

interface SkillEntry {
  manifest: { id: string; name: string; description: string; version: string; allowedTools: string[]; readOnly: boolean };
  definitionHash: string;
}

interface EventStream {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface AgentPanelOptions {
  getBuildConfig: () => unknown;
  getPlanContext?: () => PlanAgentContext | null;
  subscribePlanContext?: (listener: () => void) => () => void;
  acceptServerPlan?: (plan: BuildPlan) => void;
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string) => EventStream;
}

export interface AgentPanelController { dispose(): void; }

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
  if (toolName === "search_official_catalog") {
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const proposals = Array.isArray(value.domainProposals) ? value.domainProposals : [];
    const discovery = value.discovery && typeof value.discovery === "object" ? value.discovery as { providerIds?: string[] } : {};
    return `搜索候选 ${candidates.length} · provider ${(discovery.providerIds ?? []).join(",") || "unknown"} · 待治理域名 ${proposals.length} · job ${text(value.status ?? "unknown")}`;
  }
  if (toolName === "inspect_catalog_candidate") {
    const extraction = value.extraction && typeof value.extraction === "object" ? value.extraction as { status?: string; fieldsFound?: number } : {};
    const source = value.source && typeof value.source === "object" ? value.source as { domain?: string } : {};
    return `官方检查 ${text(extraction.status ?? "unknown")} · ${text(source.domain ?? "unknown domain")} · 字段 ${extraction.fieldsFound ?? 0} · ${value.expectedHash ? "expected hash 已生成" : "无可写 hash"}`;
  }
  if (toolName === "list_official_domain_proposals") {
    const proposals = Array.isArray(value.proposals) ? value.proposals as Array<{ trustStatus?: string }> : [];
    return `域名治理 · proposed ${proposals.filter((entry) => entry.trustStatus === "proposed").length} · rejected ${proposals.filter((entry) => entry.trustStatus === "rejected").length} · trusted ${proposals.filter((entry) => entry.trustStatus === "trusted").length}`;
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

function proposalNode(
  proposal: PlanChangeProposal,
  onApply: (indexes: number[], card: HTMLElement) => Promise<void>,
  onReject: (card: HTMLElement) => void,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "agent-plan-proposal";
  card.dataset.planProposal = proposal.id;
  const heading = document.createElement("h4"); heading.textContent = proposal.summary;
  const meta = document.createElement("p"); meta.textContent = `方案 ${proposal.planId} · revision ${proposal.expectedDraftRevision} · config ${proposal.expectedConfigHash.slice(0, 12)}`;
  const list = document.createElement("ol");
  proposal.operations.forEach((operation, index) => {
    const item = document.createElement("li");
    const label = document.createElement("label"); const checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.checked = true; checkbox.dataset.proposalOperation = String(index);
    const value = operation.op === "remove" ? "移除" : JSON.stringify(operation.value);
    label.append(checkbox, ` ${operation.op} ${operation.path} → ${value.length > 120 ? `${value.slice(0, 120)}…` : value}`); item.append(label); list.append(item);
  });
  const impact = document.createElement("p");
  impact.className = "agent-proposal-impact";
  impact.textContent = `确定性预览：解决 ${proposal.predictedImpact.resolvedFindingIds.length} · 新增 ${proposal.predictedImpact.introducedFindingIds.length} · 预算 ${proposal.predictedImpact.budgetDeltaCny === null ? "unknown" : `${proposal.predictedImpact.budgetDeltaCny >= 0 ? "+" : ""}${proposal.predictedImpact.budgetDeltaCny} CNY`}`;
  const approvalLabel = document.createElement("label"); const approval = document.createElement("input");
  approval.type = "checkbox"; approval.dataset.proposalApproval = ""; approvalLabel.append(approval, " 我已审阅所选字段并批准写入当前草稿");
  const actions = document.createElement("div"); const apply = document.createElement("button"); const reject = document.createElement("button");
  apply.type = "button"; apply.textContent = "应用所选项"; apply.disabled = true; apply.dataset.applyProposal = "";
  reject.type = "button"; reject.textContent = "拒绝"; reject.dataset.rejectProposal = "";
  const state = document.createElement("p"); state.dataset.proposalState = ""; state.textContent = "proposed · 未修改方案";
  approval.addEventListener("change", () => { apply.disabled = !approval.checked; });
  apply.addEventListener("click", async () => {
    const indexes = [...card.querySelectorAll<HTMLInputElement>("[data-proposal-operation]:checked")].map((entry) => Number(entry.dataset.proposalOperation));
    if (!indexes.length) { state.textContent = "至少选择一项修改。"; return; }
    apply.disabled = true; reject.disabled = true; state.textContent = "正在重新验证 revision/hash/SKU 并运行确定性评估…";
    try { await onApply(indexes, card); } catch (error) { state.textContent = `stale/rejected · ${text((error as Error).message)}`; reject.disabled = false; }
  });
  reject.addEventListener("click", () => onReject(card));
  actions.append(apply, reject); card.append(heading, meta, list, impact, approvalLabel, actions, state);
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

  const contextBadge = document.createElement("p");
  contextBadge.className = "agent-plan-context";
  contextBadge.dataset.agentPlanContext = "";
  contextBadge.setAttribute("aria-live", "polite");
  status.insertAdjacentElement("afterend", contextBadge);
  const proposalHost = document.createElement("section");
  proposalHost.className = "agent-plan-proposals";
  proposalHost.dataset.agentPlanProposals = "";
  proposalHost.setAttribute("aria-label", "Agent 方案修改提案");
  form.parentElement?.insertBefore(proposalHost, form);

  const fetchImpl = options.fetchImpl ?? fetch;
  const eventSourceFactory = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  let session: AgentSession | null = null;
  let activeRunId: string | null = null;
  let stream: EventStream | null = null;
  let assistantBody: HTMLElement | null = null;
  let catalogReady = false;
  let boundContext: PlanAgentContext | null = null;

  const currentContext = () => options.getPlanContext?.() ?? null;
  const refreshContextBadge = () => {
    const current = currentContext();
    if (!current) {
      contextBadge.textContent = "未绑定方案 evaluation；普通对话仍可用，不能生成可应用提案。";
      contextBadge.dataset.stale = "true";
      return;
    }
    const stale = isPlanAgentContextStale(boundContext, current);
    contextBadge.dataset.stale = String(stale);
    contextBadge.textContent = `绑定方案 ${current.planId} · revision ${current.draftRevision} · evaluation ${current.evaluationHash.slice(0, 12)}${boundContext ? stale ? " · context stale，发送时刷新" : " · context current" : " · 尚未发送"}`;
  };
  refreshContextBadge();
  const unsubscribePlanContext = options.subscribePlanContext?.(refreshContextBadge) ?? (() => undefined);

  const setStatus = (content: string, level: "ok" | "warn" | "bad" = "warn") => {
    status.textContent = content;
    status.dataset.level = level;
  };

  const receiveProposal = async (content: unknown) => {
    const proposal = content && typeof content === "object" ? (content as { proposal?: PlanChangeProposal }).proposal : undefined;
    if (!proposal) return;
    try {
      const validated = await workspaceJson<{ proposal: PlanChangeProposal }>(fetchImpl, `/plans/${encodeURIComponent(proposal.planId)}/proposals/validate`, { method: "POST", body: JSON.stringify({ proposal }) });
      const card = proposalNode(validated.proposal, async (indexes, target) => {
        const result = await workspaceJson<{ proposal: PlanChangeProposal; plan: BuildPlan; audit: { approvalId: string } }>(fetchImpl, `/plans/${encodeURIComponent(validated.proposal.planId)}/proposals/apply`, {
          method: "POST",
          body: JSON.stringify({ proposal: validated.proposal, operationIndexes: indexes, approvalConfirmed: true, approvedBy: "local-human" }),
        });
        options.acceptServerPlan?.(result.plan);
        target.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((control) => { control.disabled = true; });
        target.querySelector<HTMLElement>("[data-proposal-state]")!.textContent = `applied · ${result.audit.approvalId} · 已进入 active draft，未自动保存版本`;
      }, (target) => {
        target.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((control) => { control.disabled = true; });
        target.querySelector<HTMLElement>("[data-proposal-state]")!.textContent = "rejected · 方案未改变";
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
    transcript.replaceChildren(messageNode("notice", "新会话会绑定当前模型；每条消息都会附带当前 BuildConfig 快照。"));
    events.replaceChildren();
    usage.textContent = "尚无 token usage";
    assistantBody = null;
    boundContext = null;
    refreshContextBadge();
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
    source.addEventListener("tool_result", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "tool_result" }>>(event);
      if (data) {
        const summary = formatCatalogToolResult(data.toolName, data.result.content);
        addEvent(`Tool 结果 · ${data.toolName} · ${data.result.ok ? "ok" : data.result.errorCode ?? "error"}${summary ? ` · ${summary}` : ""}`, data.result.ok ? "ok" : "warn");
        if (data.result.ok && data.toolName === "propose_plan_change") void receiveProposal(data.result.content);
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
    general.textContent = "通用对话 · 全部只读 Tools";
    const skillOptions = skillPayload.skills.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.manifest.id;
      option.textContent = `${entry.manifest.name} · ${entry.manifest.allowedTools.length} Tools`;
      option.title = entry.manifest.description;
      return option;
    });
    skill.replaceChildren(general, ...skillOptions);
    skill.value = skillPayload.skills.some((entry) => entry.manifest.id === "build-diagnosis") ? "build-diagnosis" : "";
    if (!modelPayload.models.length) throw new Error("服务端没有可用模型");
    catalogReady = true;
    setBusy(false);
    setStatus(`Agent 服务可用 · ${modelPayload.models.length} 模型 · ${skillPayload.skills.length} Skills`, "ok");
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
      const planContext = currentContext();
      if (session && boundContext && planContext && boundContext.planId !== planContext.planId) clearConversation();
      const current = await createSession();
      const agentContent = planContext ? planAgentContextEnvelope(content, planContext) : content;
      const run = await json<{ runId: string }>(fetchImpl, `/sessions/${encodeURIComponent(current.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: agentContent, buildConfig: planContext?.buildConfig ?? options.getBuildConfig(), ...(skill.value ? { skillId: skill.value } : {}) }),
      });
      if (planContext) {
        boundContext = structuredClone(planContext);
        refreshContextBadge();
        try {
          await workspaceJson(fetchImpl, "/agent-context", { method: "POST", body: JSON.stringify({ sessionId: current.id, runId: run.runId, context: planContext }) });
          addEvent(`方案上下文审计 · ${planContext.planId} r${planContext.draftRevision} · ${planContext.evaluationHash.slice(0, 12)}`);
        } catch (error) {
          addEvent(`方案上下文审计失败：${text((error as Error).message)}`, "bad");
        }
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
