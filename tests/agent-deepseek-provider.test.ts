import { describe, expect, it } from "vitest";
import { DeepSeekProviderAdapter, type DeepSeekAgentConfig } from "../src/agent/providers/deepseek";

const config: DeepSeekAgentConfig = {
  enabled: true,
  apiKey: "fixture-secret",
  apiUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  timeoutMs: 1_000,
  maxTokens: 200,
  temperature: 0.2,
};

function sse(lines: unknown[]): Response {
  return new Response(`${lines.map((line) => line === "[DONE]" ? "data: [DONE]" : `data: ${JSON.stringify(line)}`).join("\n\n")}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function request(onTextDelta?: (text: string) => void) {
  return {
    model: config.model,
    system: "fixture system",
    messages: [{ id: "m1", role: "user" as const, content: "你好", createdAt: "2026-08-24T00:00:00.000Z" }],
    tools: [],
    maxTokens: 200,
    temperature: 0.2,
    signal: new AbortController().signal,
    ...(onTextDelta ? { onTextDelta } : {}),
  };
}

describe("A2 DeepSeek provider adapter", () => {
  it("publishes every configured DeepSeek model with distinct labels", () => {
    const adapter = new DeepSeekProviderAdapter({ ...config, models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp", "private-model"] });
    expect(adapter.models.map((entry) => [entry.id, entry.label])).toEqual([
      ["deepseek-v4-flash", "DeepSeek V4 Flash · 快速"],
      ["deepseek-v4-pro", "DeepSeek V4 Pro · 深度推理"],
      ["deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision Exp · 视觉"],
      ["private-model", "private-model"],
    ]);
  });

  it("normalizes streamed text, stop reason, model id and usage", async () => {
    const deltas: string[] = [];
    let authorization = "";
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return sse([
        { id: "provider-1", model: "deepseek-v4-flash", choices: [{ delta: { content: "装机" }, finish_reason: null }] },
        { id: "provider-1", model: "deepseek-v4-flash", choices: [{ delta: { content: "建议" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 5 } } },
        "[DONE]",
      ]);
    };
    const adapter = new DeepSeekProviderAdapter(config, fetchImpl as typeof fetch);
    const result = await adapter.createTurn(request((text) => deltas.push(text)));
    expect(result).toMatchObject({ provider: "deepseek", providerRequestId: "provider-1", model: "deepseek-v4-flash", content: "装机建议", stopReason: "end_turn" });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 60, cacheWriteTokens: 40, reasoningTokens: 5 });
    expect(result.billing).toMatchObject({ status: "priced", pricing: { billedModel: "deepseek-v4-flash" }, cost: { estimated: true } });
    expect(deltas).toEqual(["装机", "建议"]);
    expect(authorization).toBe("Bearer fixture-secret");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("assembles incremental tool calls without coupling them to the runtime", async () => {
    const fetchImpl = async () => sse([
      { id: "provider-tools", model: config.model, choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "get_build_", arguments: "{\"sections\":" } }] }, finish_reason: null }] },
      { id: "provider-tools", model: config.model, choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "evaluation", arguments: "[\"findings\"]}" } }] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]);
    const adapter = new DeepSeekProviderAdapter(config, fetchImpl as typeof fetch);
    const result = await adapter.createTurn({ ...request(), tools: [{ name: "get_build_evaluation", description: "Read the authoritative server evaluation for the active build configuration.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, strict: true }] });
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "get_build_evaluation", input: { sections: ["findings"] } }]);
  });

  it("preserves private reasoning across tool-call turns without streaming it as answer text", async () => {
    const deltas: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([
        { id: "provider-thinking", model: config.model, choices: [{ delta: { reasoning_content: "private reasoning" }, finish_reason: null }] },
        { id: "provider-thinking", model: config.model, choices: [{ delta: { content: "checking", tool_calls: [{ index: 0, id: "call-1", function: { name: "get_build_evaluation", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
        "[DONE]",
      ]);
    };
    const adapter = new DeepSeekProviderAdapter(config, fetchImpl as typeof fetch);
    const first = await adapter.createTurn({
      ...request((text) => deltas.push(text)),
      tools: [{ name: "get_build_evaluation", description: "Read evaluation.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, strict: true }],
    });
    expect(first).toMatchObject({ content: "checking", reasoningContent: "private reasoning", stopReason: "tool_use" });
    expect(deltas).toEqual(["checking"]);
    expect(requestBodies[0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(requestBodies[0]).not.toHaveProperty("temperature");
    expect(requestBodies[0]).not.toHaveProperty("tool_choice");

    await adapter.createTurn({
      ...request(),
      messages: [{
        id: "assistant-tool",
        role: "assistant",
        content: "",
        reasoningContent: first.reasoningContent ?? "",
        toolCalls: first.toolCalls,
        createdAt: "2026-08-24T00:00:00.000Z",
      }],
    });
    expect(requestBodies[1]?.messages).toEqual([
      { role: "system", content: "fixture system" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "private reasoning",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "get_build_evaluation", arguments: "{}" } }],
      },
    ]);
  });

  it("keeps legacy OpenAI-compatible models on temperature and tool_choice", async () => {
    let body: Record<string, unknown> = {};
    const adapter = new DeepSeekProviderAdapter({ ...config, model: "private-model" }, (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
    }) as typeof fetch);
    await adapter.createTurn({
      ...request(),
      model: "private-model",
      tools: [{ name: "get_build_evaluation", description: "Read evaluation.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, strict: true }],
    });
    expect(body).toMatchObject({ temperature: 0.2, tool_choice: "auto" });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("returns bounded provider errors without response bodies or secrets", async () => {
    const adapter = new DeepSeekProviderAdapter(config, (async () => new Response("upstream secret body", { status: 429 })) as typeof fetch);
    await expect(adapter.createTurn(request())).rejects.toThrow("DeepSeek Agent HTTP 429");
  });

  it("aborts a provider request at the configured timeout", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      throw new Error("unreachable");
    };
    const adapter = new DeepSeekProviderAdapter({ ...config, timeoutMs: 5 }, fetchImpl as typeof fetch);
    await expect(adapter.createTurn(request())).rejects.toThrow("DeepSeek Agent request timed out");
  });
});
