// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCatalogToolResult, initAgentPanel } from "../src/lab/agent-panel";
import type { PlanAgentContext, PlanChangeProposal } from "../src/plans/contracts";
import { makePlan } from "./helpers/workspace-ui";

class FakeEventSource {
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;
  addEventListener(type: string, listener: (event: Event) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close(): void { this.closed = true; }
}

function fixtureHtml(): void {
  document.body.innerHTML = `
    <p id="agent-status" data-level="warn"></p>
    <select id="agent-model"></select><select id="agent-skill"></select>
    <button id="agent-new-session"></button>
    <div id="agent-transcript"></div><ul id="agent-events"></ul><p id="agent-usage"></p>
    <form id="agent-form"><textarea id="agent-input"></textarea><button id="agent-cancel" type="button" disabled></button><button id="agent-send" type="submit"></button></form>`;
}

function payload(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const model = { provider: "deepseek", id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } };
const skill = { manifest: { id: "build-diagnosis", name: "装机诊断", description: "fixture", version: "1.0.0", allowedTools: ["get_build_evaluation", "get_sku_facts"], readOnly: true }, definitionHash: "a".repeat(64) };
const initializerSkill = { manifest: { id: "plan-initializer", name: "方案初始化", description: "fixture", version: "1.0.0", allowedTools: ["search_catalog_skus", "propose_plan_initialization"], readOnly: true }, definitionHash: "b".repeat(64) };
const session = { contractVersion: "1.0.0", id: "session-fixture", provider: "deepseek", model: model.id, buildConfig: null, messages: [], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" };

describe("A5 Agent panel", () => {
  it("labels catalog candidate, proposal, official inspection and write states distinctly", () => {
    expect(formatCatalogToolResult("search_official_catalog", { status: "partial", candidates: [{}, {}], domainProposals: [{}], discovery: { providerIds: ["searxng"] } })).toContain("搜索候选 2");
    expect(formatCatalogToolResult("inspect_catalog_candidate", { extraction: { status: "ok", fieldsFound: 5 }, source: { domain: "asus.com" }, expectedHash: "a".repeat(64) })).toContain("expected hash 已生成");
    expect(formatCatalogToolResult("list_official_domain_proposals", { proposals: [{ trustStatus: "proposed" }, { trustStatus: "rejected" }] })).toContain("proposed 1");
    expect(formatCatalogToolResult("enrich_official_catalog", { status: "draft", changedFields: [], rollbackManifest: "manifest.json" })).toContain("目录补齐 · draft");
  });
  beforeEach(fixtureHtml);

  it("shows provider-neutral model and metadata-only Skill catalogs", async () => {
    const pro = { ...model, id: "deepseek-v4-pro", label: "DeepSeek V4 Pro · 深度推理" };
    const vision = { ...model, id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp · 视觉" };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/models") ? payload({ models: [model, pro, vision] }) : payload({ skills: [skill] }));
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    expect((document.querySelector("#agent-model") as HTMLSelectElement).value).toBe(model.id);
    expect((document.querySelector("#agent-skill") as HTMLSelectElement).value).toBe("build-diagnosis");
    expect((document.querySelector("#agent-model") as HTMLSelectElement).options).toHaveLength(3);
    expect(document.querySelector("#agent-status")?.textContent).toContain("3 个模型 · 1 项能力");
    expect(document.body.textContent).not.toContain("装机诊断工作流");
  });

  it("automatically selects the initializer Skill for a pending blank plan", async () => {
    const active = makePlan("plan-agent-init-12345678", "待 Agent 初始化方案");
    active.metadata.initialization = { status: "pending", source: "agent" };
    const context = {
      schemaVersion: "1.0.0", planId: active.id, planVersionId: null, draftRevision: 0,
      configHash: "1".repeat(64), evaluationHash: "2".repeat(64), buildConfig: active.draft.config,
      evaluation: { config: active.draft.config }, purchaseSummary: {}, buildTaskSummary: {},
      initialization: active.metadata.initialization,
    } as unknown as PlanAgentContext;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/models") ? payload({ models: [model] }) : payload({ skills: [skill, initializerSkill] }));
    await initAgentPanel({ getBuildConfig: () => active.draft.config, getPlanContext: () => context, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    expect((document.querySelector("#agent-skill") as HTMLSelectElement).value).toBe("plan-initializer");
    expect(document.querySelector("[data-agent-plan-context]")?.textContent).toContain("空白方案待初始化");
    expect((document.querySelector("#agent-input") as HTMLTextAreaElement).placeholder).toContain("预算 8000 元");
  });

  it("refreshes a stale model catalog and retries session creation once", async () => {
    const current = { ...model, id: "deepseek-v4-pro", label: "DeepSeek V4 Pro · 深度推理" };
    let modelReads = 0;
    let sessionCreates = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return payload({ models: modelReads++ === 0 ? [model] : [current] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") {
        sessionCreates += 1;
        if (sessionCreates === 1) return payload({ error: "model_not_found", message: `Unknown Agent model: ${model.id}` }, 404);
        return payload({ ...session, model: current.id }, 201);
      }
      if (url.endsWith("/messages")) return payload({ runId: "run-refreshed", status: "queued" }, 202);
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    expect(document.querySelector("#agent-status")?.textContent).toContain("1 个模型");
    expect((document.querySelector("#agent-model") as HTMLSelectElement).value).toBe(model.id);
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "刷新模型";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sessionCreates).toBe(2));
    expect((document.querySelector("#agent-model") as HTMLSelectElement).value).toBe(current.id);
    expect(document.querySelector("#agent-events")?.textContent).toContain("模型目录已自动刷新");
  });

  it("streams text, Tool audit events, usage, and the persisted final assistant message", async () => {
    const stream = new FakeEventSource();
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && method === "POST") return payload(session, 201);
      if (url.endsWith("/sessions/session-fixture/messages")) return payload({ runId: "run-fixture", status: "queued" }, 202);
      if (url.endsWith("/sessions/session-fixture")) return payload({ ...session, messages: [{ id: "a1", role: "assistant", content: "最终持久化回答", createdAt: "2026-08-24T00:00:01.000Z" }] });
      if (url.endsWith("/runs/run-fixture/audit")) return payload({ status: "completed", recordHash: "c".repeat(64) });
      throw new Error(`unexpected ${method} ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => ({ schemaVersion: "2.0.0", id: "live" }), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "诊断当前配置";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/messages"))).toBe(true));
    expect(requests.find((entry) => entry.url.endsWith("/messages"))?.body).toMatchObject({ content: "诊断当前配置", skillId: "build-diagnosis", buildConfig: { schemaVersion: "2.0.0", id: "live" } });

    stream.emit("skill_activated", { type: "skill_activated", runId: "run-fixture", skillId: "build-diagnosis", definitionHash: "a".repeat(64), at: "now" });
    stream.emit("tool_call", { type: "tool_call", runId: "run-fixture", call: { id: "c1", name: "get_build_evaluation", input: {} }, toolDefinitionHash: "b".repeat(64), at: "now" });
    stream.emit("tool_result", { type: "tool_result", runId: "run-fixture", callId: "c1", toolName: "get_build_evaluation", result: { ok: true, content: {}, provenance: ["BuildEvaluation"] }, at: "now" });
    stream.emit("text_delta", { type: "text_delta", runId: "run-fixture", text: "流式回答", at: "now" });
    stream.emit("usage", { type: "usage", runId: "run-fixture", provider: "deepseek", model: model.id, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, billing: { status: "priced", pricing: { billedModel: model.id, pricingVersion: "fixture", sourceUrl: "https://api-docs.deepseek.com", pricingBand: { id: "off-peak", label: "空闲时段" }, rates: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 } }, cost: { cacheHitCny: 0, cacheMissCny: 0.000015, outputCny: 0.0000135, totalCny: 0.0000285, currency: "CNY", estimated: true } }, at: "now" });
    stream.emit("run_status", { type: "run_status", runId: "run-fixture", status: "completed", at: "now" });

    await vi.waitFor(() => expect(document.querySelector("#agent-transcript")?.textContent).toContain("最终持久化回答"));
    expect(document.querySelector("#agent-events")?.textContent).toContain("Skill · build-diagnosis");
    expect(document.querySelector("#agent-events")?.textContent).toContain("Tool 结果 · get_build_evaluation · ok");
    expect(document.querySelector("#agent-events")?.textContent).toContain("审计记录 · completed · cccccccccccc");
    expect(document.querySelector("#agent-usage")?.textContent).toContain("total 13");
    expect(document.querySelector("#agent-usage")?.textContent).toContain("估算费用");
    expect(document.querySelector("#agent-usage")?.textContent).toContain("非余额账单");
    expect(stream.closed).toBe(true);
  });

  it("sends cancellation for the active run", async () => {
    const stream = new FakeEventSource();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [skill] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-cancel", status: "queued" }, 202);
      if (url.endsWith("/runs/run-cancel/cancel")) return payload({ runId: "run-cancel", status: "running" }, 202);
      return payload({ ...session, messages: [] });
    });
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "取消测试";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect((document.querySelector("#agent-cancel") as HTMLButtonElement).disabled).toBe(false));
    (document.querySelector("#agent-cancel") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledWith("/api/agent/runs/run-cancel/cancel", expect.objectContaining({ method: "POST" })));
  });

  it("binds run context and applies a structured proposal only after explicit human approval", async () => {
    const stream = new FakeEventSource();
    const active = makePlan("plan-agent-12345678", "Agent plan");
    const configHash = "1".repeat(64);
    const evaluationHash = "2".repeat(64);
    const context = {
      schemaVersion: "1.0.0",
      planId: active.id,
      planVersionId: active.activeVersionId,
      draftRevision: active.draftRevision,
      configHash,
      evaluationHash,
      buildConfig: active.draft.config,
      evaluation: { config: active.draft.config, findings: [], price: { knownCny: 0 } },
      spatialSelection: { partId: "psu.primary", view: "spatial", findingId: "physical.psu-clearance" },
      spatialViewContext: { cameraMode: "perspective" },
      purchaseSummary: { linked: 0 },
      buildTaskSummary: { todo: 1 },
    } as unknown as PlanAgentContext;
    const proposal: PlanChangeProposal = {
      schemaVersion: "1.0.0", id: "proposal-panel", planId: active.id, expectedDraftRevision: active.draftRevision, expectedConfigHash: configHash,
      createdAt: "2026-08-25T00:00:00.000Z", summary: "改为两块硬盘", rationale: ["用户要求"],
      operations: [{ op: "replace", path: "/selection/diskCount", value: 2 }],
      predictedImpact: { resolvedFindingIds: ["storage.fixture"], introducedFindingIds: [], budgetDeltaCny: 100 }, status: "proposed",
    };
    const appliedPlan = structuredClone(active);
    appliedPlan.draftRevision += 1;
    appliedPlan.draft.config.selection.diskCount = 2;
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const acceptServerPlan = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      requests.push({ url, body });
      if (url.endsWith("/models")) return payload({ models: [model] });
      if (url.endsWith("/skills")) return payload({ skills: [{ ...skill, manifest: { ...skill.manifest, allowedTools: [...skill.manifest.allowedTools, "propose_plan_change"] } }] });
      if (url.endsWith("/sessions") && init?.method === "POST") return payload(session, 201);
      if (url.endsWith("/messages")) return payload({ runId: "run-plan", status: "queued" }, 202);
      if (url.endsWith("/agent-context")) return payload({ runId: "run-plan", contextHash: "3".repeat(64) }, 201);
      if (url.endsWith("/proposals/validate")) return payload({ proposal });
      if (url.endsWith("/proposals/apply")) return payload({ proposal: { ...proposal, status: "applied" }, plan: appliedPlan, audit: { approvalId: "approval-panel" } });
      throw new Error(`unexpected ${url}`);
    });
    await initAgentPanel({ getBuildConfig: () => active.draft.config, getPlanContext: () => context, acceptServerPlan, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => stream });
    expect(document.querySelector("[data-agent-plan-context]")?.textContent).toContain(evaluationHash.slice(0, 12));
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "根据当前 PSU 提出修复";
    document.querySelector("#agent-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(requests.some((entry) => entry.url.endsWith("/agent-context"))).toBe(true));
    const messageBody = requests.find((entry) => entry.url.endsWith("/messages"))?.body;
    expect(messageBody?.content).toContain("<plan_agent_context");
    expect(messageBody?.content).toContain(evaluationHash);
    expect(messageBody?.content).toContain("psu.primary");
    expect(messageBody?.content).not.toContain("approvalToken");
    expect(requests.find((entry) => entry.url.endsWith("/agent-context"))?.body).toMatchObject({ sessionId: session.id, runId: "run-plan", context: { planId: active.id, evaluationHash } });

    stream.emit("text_delta", { type: "text_delta", runId: "run-plan", text: "我已经修复。", at: "now" });
    expect(acceptServerPlan).not.toHaveBeenCalled();
    stream.emit("tool_result", { type: "tool_result", runId: "run-plan", callId: "proposal", toolName: "propose_plan_change", result: { ok: true, content: { proposal }, provenance: [] }, at: "now" });
    await vi.waitFor(() => expect(document.querySelector("[data-plan-proposal='proposal-panel']")).not.toBeNull());
    const apply = document.querySelector<HTMLButtonElement>("[data-apply-proposal]")!;
    expect(apply.disabled).toBe(true);
    expect(acceptServerPlan).not.toHaveBeenCalled();
    const approval = document.querySelector<HTMLInputElement>("[data-proposal-approval]")!;
    approval.checked = true;
    approval.dispatchEvent(new Event("change"));
    apply.click();
    await vi.waitFor(() => expect(acceptServerPlan).toHaveBeenCalledWith(expect.objectContaining({ draftRevision: active.draftRevision + 1 })));
    expect(requests.find((entry) => entry.url.endsWith("/proposals/apply"))?.body).toMatchObject({ operationIndexes: [0], approvalConfirmed: true, approvedBy: "local-human" });
  });
});
