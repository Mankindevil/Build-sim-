import type {
  AgentMessage,
  AgentToolCall,
  ProviderAdapter,
  ProviderBillingEstimate,
  ProviderModel,
  ProviderTurnRequest,
  ProviderTurnResult,
  ProviderUsage,
} from "../contracts";
import { priceDeepSeekUsage } from "../../../scripts/deepseek/pricing.mjs";

export interface DeepSeekAgentConfig {
  enabled: boolean;
  apiKey: string;
  apiUrl: string;
  model: string;
  models?: string[];
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

const EMPTY_USAGE: ProviderUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUsage(value: unknown): ProviderUsage {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  return {
    inputTokens: finite(usage.prompt_tokens),
    outputTokens: finite(usage.completion_tokens),
    totalTokens: finite(usage.total_tokens),
    cacheReadTokens: finite(usage.prompt_cache_hit_tokens),
    cacheWriteTokens: finite(usage.prompt_cache_miss_tokens),
    reasoningTokens: finite(details.reasoning_tokens),
  };
}

function toProviderMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })) } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

function usesV4Thinking(model: string): boolean {
  return /^deepseek-v4(?:-|$)/.test(model);
}

function stopReason(value: unknown): ProviderTurnResult["stopReason"] {
  if (value === "tool_calls") return "tool_use";
  if (value === "length") return "max_tokens";
  if (value === "content_filter") return "content_filter";
  return "end_turn";
}

type ToolAccumulator = { id: string; name: string; arguments: string };

function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return raw;
  }
}

export class DeepSeekProviderAdapter implements ProviderAdapter {
  readonly id = "deepseek" as const;
  readonly models: ProviderModel[];

  constructor(
    private readonly config: DeepSeekAgentConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const ids = [...new Set((config.models?.length ? config.models : [config.model]).map((model) => model.trim()).filter(Boolean))];
    this.models = ids.map((id) => ({
      provider: "deepseek",
      id,
      label: id === "deepseek-v4-flash"
        ? "DeepSeek V4 Flash · 快速"
        : id === "deepseek-v4-pro"
          ? "DeepSeek V4 Pro · 深度推理"
          : id === "deepseek-v4-flash-vision-exp"
            ? "DeepSeek V4 Flash Vision Exp · 视觉"
            : id,
      capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true },
    }));
  }

  async createTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    if (!this.config.enabled) throw new Error("DeepSeek Agent provider is disabled");
    if (!this.config.apiKey) throw new Error("DeepSeek Agent API key is missing");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.min(this.config.timeoutMs, 120_000));
    const started = Date.now();
    const thinking = usesV4Thinking(request.model);
    try {
      const response = await this.fetchImpl(`${this.config.apiUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: request.model,
          ...(thinking ? { thinking: { type: "enabled" }, reasoning_effort: "high" } : { temperature: request.temperature }),
          max_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "system", content: request.system }, ...request.messages.map(toProviderMessage)],
          ...(request.tools.length ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                strict: tool.strict,
              },
            })),
            // DeepSeek V4 thinking mode rejects tool_choice and chooses tools automatically.
            ...(!thinking ? { tool_choice: "auto" } : {}),
          } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`DeepSeek Agent HTTP ${response.status}`);
      if (!response.body) throw new Error("DeepSeek Agent stream is missing");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoningContent = "";
      let providerRequestId: string | null = null;
      let providerModel = request.model;
      let finish: unknown = null;
      let usage = EMPTY_USAGE;
      let rawUsage: unknown = null;
      const toolParts = new Map<number, ToolAccumulator>();

      const consume = (raw: string): void => {
        const line = raw.trim();
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        const chunk = JSON.parse(data) as Record<string, unknown>;
        if (typeof chunk.id === "string") providerRequestId = chunk.id;
        if (typeof chunk.model === "string") providerModel = chunk.model;
        if (chunk.usage) {
          rawUsage = chunk.usage;
          usage = normalizeUsage(chunk.usage);
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
        for (const choice of choices) {
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason;
          const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            request.onTextDelta?.(delta.content);
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoningContent += delta.reasoning_content;
          }
          const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
          for (const call of calls) {
            const index = typeof call.index === "number" ? call.index : 0;
            const current = toolParts.get(index) ?? { id: "", name: "", arguments: "" };
            if (typeof call.id === "string") current.id += call.id;
            const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
            if (typeof fn.name === "string") current.name += fn.name;
            if (typeof fn.arguments === "string") current.arguments += fn.arguments;
            toolParts.set(index, current);
          }
        }
      };

      while (true) {
        const read = await reader.read();
        buffer += decoder.decode(read.value, { stream: !read.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        lines.forEach(consume);
        if (read.done) break;
      }
      if (buffer.trim()) consume(buffer);

      const toolCalls: AgentToolCall[] = [...toolParts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call], index) => ({
          id: call.id || `deepseek-tool-${index}`,
          name: call.name,
          input: parseToolInput(call.arguments),
        }));
      return {
        provider: "deepseek",
        providerRequestId,
        model: providerModel,
        content,
        ...(reasoningContent ? { reasoningContent } : {}),
        toolCalls,
        stopReason: toolCalls.length ? "tool_use" : stopReason(finish),
        usage,
        billing: priceDeepSeekUsage(providerModel, rawUsage, { occurredAt: new Date(started).toISOString() }) as ProviderBillingEstimate,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(request.signal.aborted ? "Agent run cancelled" : "DeepSeek Agent request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }
  }
}

export const __testing = { normalizeUsage, toProviderMessage, stopReason, usesV4Thinking };
