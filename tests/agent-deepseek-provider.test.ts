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
