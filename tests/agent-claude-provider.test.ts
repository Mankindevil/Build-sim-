import { describe, expect, it } from "vitest";
import { ClaudeProviderAdapter, type ClaudeAgentConfig } from "../src/agent/providers/claude";

const config: ClaudeAgentConfig = {
  enabled: true,
  apiKey: "fixture-claude-secret",
  apiUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-20250514",
  timeoutMs: 1_000,
  maxTokens: 200,
  temperature: 0.2,
};

function sse(events: Array<{ event: string; data: unknown }>): Response {
  return new Response(`${events.map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}`).join("\n\n")}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
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

describe("A7 Claude provider adapter", () => {
  it("normalizes Messages SSE text, stop reason, ids, cache usage, and headers", async () => {
    const deltas: string[] = [];
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return sse([
        { event: "message_start", data: { type: "message_start", message: { id: "msg-fixture", model: config.model, usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 40, output_tokens: 1 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "装机" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "建议" } } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    };
    const result = await new ClaudeProviderAdapter(config, fetchImpl as typeof fetch).createTurn(request((text) => deltas.push(text)));
    expect(result).toMatchObject({ provider: "claude", providerRequestId: "msg-fixture", model: config.model, content: "装机建议", stopReason: "end_turn" });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 60, cacheWriteTokens: 40, reasoningTokens: null });
    expect(deltas).toEqual(["装机", "建议"]);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured!.headers.get("x-api-key")).toBe("fixture-claude-secret");
    expect(captured!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(captured!.body).toMatchObject({ model: config.model, system: "fixture system", stream: true, messages: [{ role: "user", content: "你好" }] });
    expect(JSON.stringify(result)).not.toContain("fixture-claude-secret");
  });

  it("assembles partial tool input and maps internal Tool messages to Claude content blocks", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return sse([
        { event: "message_start", data: { type: "message_start", message: { id: "msg-tool", model: config.model, usage: { input_tokens: 50, output_tokens: 1 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-1", name: "get_build_evaluation", input: {} } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"sections\":" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "[\"findings\"]}" } } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    };
    const adapter = new ClaudeProviderAdapter(config, fetchImpl as typeof fetch);
    const result = await adapter.createTurn({
      ...request(),
      messages: [
        { id: "u1", role: "user", content: "诊断", createdAt: "now" },
        { id: "a1", role: "assistant", content: "", createdAt: "now", toolCalls: [{ id: "old-call", name: "get_sku_facts", input: { skuIds: ["case.jonsbo-n6"] } }] },
        { id: "t1", role: "tool", content: "{\"ok\":true}", createdAt: "now", toolCallId: "old-call", toolName: "get_sku_facts" },
      ],
      tools: [{ name: "get_build_evaluation", description: "Read the authoritative server evaluation for the active build configuration.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, strict: true }],
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "toolu-1", name: "get_build_evaluation", input: { sections: ["findings"] } }]);
    expect(body).toMatchObject({
      tools: [{ name: "get_build_evaluation", input_schema: { type: "object" }, strict: true }],
      messages: [
        { role: "user", content: "诊断" },
        { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "get_sku_facts" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "{\"ok\":true}" }] },
      ],
    });
  });

  it("bounds HTTP and in-stream errors without response bodies or secrets", async () => {
    const http = new ClaudeProviderAdapter(config, (async () => new Response("secret upstream body", { status: 429 })) as typeof fetch);
    await expect(http.createTurn(request())).rejects.toThrow("Claude Agent HTTP 429");
    const streamed = new ClaudeProviderAdapter(config, (async () => sse([{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "secret body" } } }])) as typeof fetch);
    await expect(streamed.createTurn(request())).rejects.toThrow("Claude Agent stream error: overloaded_error");
  });

  it("aborts a provider request at the configured timeout", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      throw new Error("unreachable");
    };
    const adapter = new ClaudeProviderAdapter({ ...config, timeoutMs: 5 }, fetchImpl as typeof fetch);
    await expect(adapter.createTurn(request())).rejects.toThrow("Claude Agent request timed out");
  });
});
