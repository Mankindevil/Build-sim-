// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentPanel } from "../src/lab/agent-panel";

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
const session = { contractVersion: "1.0.0", id: "session-fixture", provider: "deepseek", model: model.id, buildConfig: null, messages: [], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" };

describe("A5 Agent panel", () => {
  beforeEach(fixtureHtml);

  it("shows provider-neutral model and metadata-only Skill catalogs", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/models") ? payload({ models: [model] }) : payload({ skills: [skill] }));
    await initAgentPanel({ getBuildConfig: () => ({}), fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => new FakeEventSource() });
    expect((document.querySelector("#agent-model") as HTMLSelectElement).value).toBe(model.id);
    expect((document.querySelector("#agent-skill") as HTMLSelectElement).value).toBe("build-diagnosis");
    expect(document.querySelector("#agent-status")?.textContent).toContain("1 模型 · 1 Skills");
    expect(document.body.textContent).not.toContain("装机诊断工作流");
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
    stream.emit("usage", { type: "usage", runId: "run-fixture", provider: "deepseek", model: model.id, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, at: "now" });
    stream.emit("run_status", { type: "run_status", runId: "run-fixture", status: "completed", at: "now" });

    await vi.waitFor(() => expect(document.querySelector("#agent-transcript")?.textContent).toContain("最终持久化回答"));
    expect(document.querySelector("#agent-events")?.textContent).toContain("Skill · build-diagnosis");
    expect(document.querySelector("#agent-events")?.textContent).toContain("Tool 结果 · get_build_evaluation · ok");
    expect(document.querySelector("#agent-usage")?.textContent).toContain("total 13");
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
});
