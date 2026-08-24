import type { AgentMessage, AgentRunAuditRecord, AgentRunEvent, AgentSession, ProviderModel } from "../agent/contracts";

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
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string) => EventStream;
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function json<T>(fetchImpl: typeof fetch, path: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
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

export async function initAgentPanel(options: AgentPanelOptions): Promise<void> {
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
  if (!model || !skill || !status || !transcript || !events || !form || !input || !send || !cancel || !reset || !usage) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  const eventSourceFactory = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  let session: AgentSession | null = null;
  let activeRunId: string | null = null;
  let stream: EventStream | null = null;
  let assistantBody: HTMLElement | null = null;
  let catalogReady = false;

  const setStatus = (content: string, level: "ok" | "warn" | "bad" = "warn") => {
    status.textContent = content;
    status.dataset.level = level;
  };
  const setBusy = (busy: boolean) => {
    send.disabled = busy || !catalogReady;
    cancel.disabled = !busy || !activeRunId;
    model.disabled = busy || !catalogReady;
    skill.disabled = busy || !catalogReady;
    reset.disabled = busy || !catalogReady;
    input.setAttribute("aria-busy", String(busy));
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
  };

  const createSession = async (): Promise<AgentSession> => {
    if (session) return session;
    const selected = model.selectedOptions[0];
    if (!selected?.value) throw new Error("没有可用的 Agent 模型");
    session = await json<AgentSession>(fetchImpl, "/sessions", {
      method: "POST",
      body: JSON.stringify({ provider: selected.dataset.provider, model: selected.value }),
    });
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
      if (data) addEvent(`Tool 结果 · ${data.toolName} · ${data.result.ok ? "ok" : data.result.errorCode ?? "error"}`, data.result.ok ? "ok" : "warn");
    });
    source.addEventListener("usage", (event) => {
      const data = parse<Extract<AgentRunEvent, { type: "usage" }>>(event);
      if (!data) return;
      usage.textContent = `${data.provider} / ${data.model} · input ${data.usage.inputTokens ?? "unknown"} · output ${data.usage.outputTokens ?? "unknown"} · total ${data.usage.totalTokens ?? "unknown"}`;
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
    model.replaceChildren(...modelPayload.models.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.dataset.provider = entry.provider;
      option.textContent = `${entry.label} · ${entry.provider}`;
      return option;
    }));
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

  model.addEventListener("change", () => {
    clearConversation();
    setStatus("模型已切换；下一条消息将创建新会话", "warn");
  });
  reset.addEventListener("click", () => {
    clearConversation();
    setBusy(false);
    setStatus("已清空本地会话；下一条消息将创建新会话", "warn");
  });
  cancel.addEventListener("click", async () => {
    if (!activeRunId) return;
    cancel.disabled = true;
    try { await json(fetchImpl, `/runs/${encodeURIComponent(activeRunId)}/cancel`, { method: "POST", body: "{}" }); }
    catch (error) { setStatus(`取消失败：${text((error as Error).message)}`, "bad"); }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || activeRunId) return;
    setBusy(true);
    assistantBody = null;
    transcript.append(messageNode("user", content));
    input.value = "";
    try {
      const current = await createSession();
      const run = await json<{ runId: string }>(fetchImpl, `/sessions/${encodeURIComponent(current.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, buildConfig: options.getBuildConfig(), ...(skill.value ? { skillId: skill.value } : {}) }),
      });
      activeRunId = run.runId;
      cancel.disabled = false;
      events.replaceChildren();
      setStatus("请求已提交，等待流式响应…", "ok");
      watchRun(run.runId, current.id);
    } catch (error) {
      setBusy(false);
      setStatus(`发送失败：${text((error as Error).message)}`, "bad");
      transcript.append(messageNode("notice", `发送失败：${text((error as Error).message)}`));
    }
  });
}
