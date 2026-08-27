import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agent/runtime";
import { MemoryAgentSessionStore } from "../src/agent/session-store";
import type { ProviderAdapter, ProviderTurnRequest } from "../src/agent/contracts";
import { FileAgentSessionStore } from "../src/server/file-session-store";
import { parseAgentRuntimeConfig } from "../src/server/agent-env";
import { publicAgentSession } from "../src/server/agent-server";

function fakeProvider(turns: ProviderTurnRequest[]): ProviderAdapter {
  return {
    id: "deepseek",
    models: [{ provider: "deepseek", id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true } }],
    async createTurn(request) {
      turns.push(request);
      const text = `回答 ${turns.length}`;
      request.onTextDelta?.(text.slice(0, 2));
      request.onTextDelta?.(text.slice(2));
      return { provider: "deepseek", providerRequestId: `provider-${turns.length}`, model: request.model, content: text, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 10, reasoningTokens: 0 }, latencyMs: 5 };
    },
  };
}

describe("A2 Agent runtime", () => {
  it("keeps the provider disabled unless both Agent and DeepSeek flags are enabled", () => {
    expect(parseAgentRuntimeConfig({}).deepseek).toMatchObject({ enabled: false, models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"] });
    expect(parseAgentRuntimeConfig({}).deepseek.maxTokens).toBe(8_192);
    expect(parseAgentRuntimeConfig({ DEEPSEEK_ENABLED: "true", DEEPSEEK_API_KEY: "fixture" }).deepseek.enabled).toBe(false);
    expect(parseAgentRuntimeConfig({
      BUILD_SIM_AGENT_ENABLED: "true",
      DEEPSEEK_ENABLED: "true",
      DEEPSEEK_API_KEY: "fixture",
      AGENT_SERVER_PORT: "5176",
      PRICE_SERVER_PORT: "6174",
      AGENT_MAX_MODEL_TURNS: "4",
      AGENT_MAX_TOOL_CALLS: "6",
      AGENT_MAX_REPEATED_TOOL_CALLS: "1",
      AGENT_MAX_TOOL_RESULT_BYTES: "64000",
      AGENT_MAX_MESSAGE_CHARS: "9000",
      AGENT_REQUEST_BODY_MAX_BYTES: "750000",
      AGENT_SESSION_ROOT: "var/sessions",
      AGENT_AUDIT_ROOT: "var/audit",
      BUILD_SIM_SKILLS_ROOT: "var/skills",
      CATALOG_PERSIST_ROOT: "var/catalog-runtime",
    })).toMatchObject({
      enabled: true,
      port: 5176,
      priceServiceUrl: "http://127.0.0.1:6174",
      requestBodyMaxBytes: 750000,
      maxMessageChars: 9000,
      limits: { maxModelTurns: 4, maxToolCalls: 6, maxRepeatedToolCalls: 1, maxToolResultBytes: 64000 },
      sessionRoot: path.resolve("var/sessions"),
      auditRoot: path.resolve("var/audit"),
      skillsRoot: path.resolve("var/skills"),
      catalogPersistRoot: path.resolve("var/catalog-runtime"),
      deepseek: { enabled: true },
    });
    expect(() => parseAgentRuntimeConfig({ AGENT_SERVER_PORT: "70000" })).toThrow(/AGENT_SERVER_PORT/);
    expect(() => parseAgentRuntimeConfig({ PRICE_SERVER_PORT: "0" })).toThrow(/PRICE_SERVER_PORT/);
    expect(() => parseAgentRuntimeConfig({ AGENT_MAX_MODEL_TURNS: "33" })).toThrow(/AGENT_MAX_MODEL_TURNS/);
    expect(() => parseAgentRuntimeConfig({ AGENT_REQUEST_BODY_MAX_BYTES: "999999999" })).toThrow(/AGENT_REQUEST_BODY_MAX_BYTES/);
    expect(parseAgentRuntimeConfig({ DEEPSEEK_AGENT_MODELS: "deepseek-v4-pro,custom/model" }).deepseek.models).toEqual(["deepseek-v4-pro", "custom/model"]);
    expect(parseAgentRuntimeConfig({ DEEPSEEK_AGENT_MAX_TOKENS: "12000" }).deepseek.maxTokens).toBe(12_000);
    expect(() => parseAgentRuntimeConfig({ DEEPSEEK_AGENT_MAX_TOKENS: "20000" })).toThrow(/DEEPSEEK_AGENT_MAX_TOKENS/);
    expect(() => parseAgentRuntimeConfig({ DEEPSEEK_AGENT_MODELS: "bad model" })).toThrow(/DEEPSEEK_AGENT_MODELS/);
    expect(parseAgentRuntimeConfig({ BUILD_SIM_AGENT_ENABLED: "true", CLAUDE_ENABLED: "false" }).claude.enabled).toBe(false);
    expect(parseAgentRuntimeConfig({ BUILD_SIM_AGENT_ENABLED: "true", CLAUDE_ENABLED: "true", CLAUDE_API_KEY: "fixture" })).toMatchObject({ claude: { enabled: true, model: "claude-sonnet-4-20250514" } });
    expect(() => parseAgentRuntimeConfig({ CLAUDE_ENABLED: "true" })).toThrow("CLAUDE_API_KEY");
  });

  it("persists and replays provider-neutral multi-turn conversation state", async () => {
    const turns: ProviderTurnRequest[] = [];
    let sequence = 0;
    const store = new MemoryAgentSessionStore();
    const runtime = new AgentRuntime([fakeProvider(turns)], store, { id: () => String(++sequence), now: () => "2026-08-24T00:00:00.000Z" });
    const session = await runtime.createSession();
    const first = await runtime.startRun(session.id, { content: "第一问" });
    await runtime.waitForRun(first.runId);
    const second = await runtime.startRun(session.id, { content: "第二问" });
    await runtime.waitForRun(second.runId);

    const saved = await runtime.getSession(session.id);
    expect(saved.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "第一问"], ["assistant", "回答 1"], ["user", "第二问"], ["assistant", "回答 2"],
    ]);
    expect(turns[1]?.messages.map((message) => message.content)).toEqual(["第一问", "回答 1", "第二问"]);
    expect(runtime.getRun(second.runId).events.map((event) => event.type)).toEqual(["run_status", "run_status", "text_delta", "text_delta", "usage", "run_status"]);
  });

  it("fails visibly when a provider returns tokens but no final answer", async () => {
    const provider: ProviderAdapter = {
      ...fakeProvider([]),
      async createTurn() {
        return {
          provider: "deepseek",
          providerRequestId: "provider-empty",
          model: "deepseek-v4-flash",
          content: "",
          reasoningContent: "private reasoning only",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 10, reasoningTokens: 20 },
          latencyMs: 5,
        };
      },
    };
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore());
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "不要显示空回答" });
    await runtime.waitForRun(run.runId);
    expect(runtime.getRun(run.runId).status).toBe("failed");
    expect(runtime.getRun(run.runId).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", code: "provider_empty_response" }),
      expect.objectContaining({ type: "run_status", status: "failed" }),
    ]));
  });

  it("continues max-token responses and persists one complete assistant answer", async () => {
    const requests: ProviderTurnRequest[] = [];
    const provider: ProviderAdapter = {
      ...fakeProvider([]),
      async createTurn(request) {
        requests.push(request);
        if (requests.length === 1) {
          request.onTextDelta?.("第一段，尤其在这个");
          return { provider: "deepseek", providerRequestId: "provider-partial", model: request.model, content: "第一段，尤其在这个", reasoningContent: "reason-1", toolCalls: [], stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 100, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 10, reasoningTokens: 50 }, latencyMs: 5 };
        }
        request.onTextDelta?.("机箱里需要确认进风净空。完整结束。");
        return { provider: "deepseek", providerRequestId: "provider-complete", model: request.model, content: "机箱里需要确认进风净空。完整结束。", reasoningContent: "reason-2", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 10, reasoningTokens: 5 }, latencyMs: 5 };
      },
    };
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore(), { maxTokens: 8_192 });
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "请详细分析" });
    await runtime.waitForRun(run.runId);

    expect(runtime.getRun(run.runId).status).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.maxTokens).toBe(8_192);
    expect(requests[1]?.tools).toEqual([]);
    expect(requests[1]?.messages.slice(-2).map((message) => [message.role, message.content])).toEqual([
      ["assistant", "第一段，尤其在这个"],
      ["user", expect.stringContaining("Continue exactly")],
    ]);
    const saved = await runtime.getSession(session.id);
    expect(saved.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "请详细分析"],
      ["assistant", "第一段，尤其在这个机箱里需要确认进风净空。完整结束。"],
    ]);
    expect(saved.messages.at(-1)?.reasoningContent).toBe("reason-1reason-2");
  });

  it("keeps provider reasoning out of browser session payloads", () => {
    expect(publicAgentSession({
      contractVersion: "1.0.0",
      id: "session-private-reasoning",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      messages: [{ id: "message-1", role: "assistant", content: "visible answer", reasoningContent: "private reasoning", createdAt: "now" }],
      buildConfig: null,
      createdAt: "now",
      updatedAt: "now",
    }).messages[0]).toEqual({ id: "message-1", role: "assistant", content: "visible answer", createdAt: "now" });
  });

  it("selects Claude through the same session contract with provider-specific budgets", async () => {
    const requests: ProviderTurnRequest[] = [];
    const claude: ProviderAdapter = {
      id: "claude",
      models: [{ provider: "claude", id: "claude-fixture", label: "Claude fixture", capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: false } }],
      async createTurn(request) {
        requests.push(request);
        return { provider: "claude", providerRequestId: "msg-fixture", model: request.model, content: "Claude fixture response", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null }, latencyMs: 1 };
      },
    };
    const runtime = new AgentRuntime([fakeProvider([]), claude], new MemoryAgentSessionStore(), { providerSettings: { claude: { maxTokens: 333, temperature: 0.4 } } });
    const session = await runtime.createSession({ provider: "claude", model: "claude-fixture" });
    const run = await runtime.startRun(session.id, { content: "same contract" });
    await runtime.waitForRun(run.runId);
    expect(requests[0]).toMatchObject({ model: "claude-fixture", maxTokens: 333, temperature: 0.4 });
    expect((await runtime.getSession(session.id)).messages.at(-1)).toMatchObject({ role: "assistant", content: "Claude fixture response" });
  });

  it("cancels an in-flight provider call and publishes terminal events", async () => {
    const provider: ProviderAdapter = {
      ...fakeProvider([]),
      async createTurn(request) {
        await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        throw new Error("unreachable");
      },
    };
    const runtime = new AgentRuntime([provider], new MemoryAgentSessionStore());
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "取消它" });
    runtime.cancelRun(run.runId);
    await runtime.waitForRun(run.runId);
    expect(runtime.getRun(run.runId).status).toBe("cancelled");
    expect(runtime.getRun(run.runId).events.at(-1)).toMatchObject({ type: "run_status", status: "cancelled" });
  });

  it("writes recoverable session JSON atomically without provider secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-agent-session-"));
    let sequence = 0;
    const store = new FileAgentSessionStore(root);
    const runtime = new AgentRuntime([fakeProvider([])], store, { id: () => String(++sequence), now: () => "2026-08-24T00:00:00.000Z" });
    const session = await runtime.createSession();
    const run = await runtime.startRun(session.id, { content: "持久化" });
    await runtime.waitForRun(run.runId);
    const restored = await new FileAgentSessionStore(root).get(session.id);
    expect(restored?.messages.at(-1)).toMatchObject({ role: "assistant", content: "回答 1" });
    const raw = await readFile(path.join(root, `${session.id}.json`), "utf8");
    expect(raw).not.toContain("API_KEY");
  });
});
