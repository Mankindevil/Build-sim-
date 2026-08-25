import type {
  AgentMessage,
  AgentToolCall,
  ProviderAdapter,
  ProviderModel,
  ProviderTurnRequest,
  ProviderTurnResult,
  ProviderUsage,
} from "../contracts";

export interface ClaudeAgentConfig {
  enabled: boolean;
  apiKey: string;
  apiUrl: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

type ClaudeMessage = { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> };

function toClaudeMessages(messages: AgentMessage[]): ClaudeMessage[] {
  const output: ClaudeMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const content: Array<Record<string, unknown>> = [];
      while (index < messages.length && messages[index]?.role === "tool") {
        const tool = messages[index]!;
        content.push({ type: "tool_result", tool_use_id: tool.toolCallId, content: tool.content, ...(tool.isError ? { is_error: true } : {}) });
        index += 1;
      }
      index -= 1;
      output.push({ role: "user", content });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      output.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })),
        ],
      });
      continue;
    }
    output.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
  }
  return output;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usage(value: Record<string, unknown>): ProviderUsage {
  const inputTokens = finite(value.input_tokens);
  const outputTokens = finite(value.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    cacheReadTokens: finite(value.cache_read_input_tokens),
    cacheWriteTokens: finite(value.cache_creation_input_tokens),
    reasoningTokens: null,
  };
}

function stopReason(value: unknown): ProviderTurnResult["stopReason"] {
  if (value === "tool_use") return "tool_use";
  if (value === "max_tokens" || value === "model_context_window_exceeded") return "max_tokens";
  if (value === "refusal") return "content_filter";
  return "end_turn";
}

type ToolPart = { id: string; name: string; input: string };

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly models: ProviderModel[];

  constructor(private readonly config: ClaudeAgentConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.models = [{
      provider: "claude",
      id: config.model,
      label: config.model,
      capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: false },
    }];
  }

  async createTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    if (!this.config.enabled) throw new Error("Claude Agent provider is disabled");
    if (!this.config.apiKey) throw new Error("Claude Agent API key is missing");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.min(this.config.timeoutMs, 120_000));
    const started = Date.now();
    try {
      const response = await this.fetchImpl(`${this.config.apiUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: request.model,
          system: request.system,
          messages: toClaudeMessages(request.messages),
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          stream: true,
          ...(request.tools.length ? {
            tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema, strict: tool.strict })),
            tool_choice: { type: "auto" },
          } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Claude Agent HTTP ${response.status}`);
      if (!response.body) throw new Error("Claude Agent stream is missing");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let providerRequestId: string | null = null;
      let providerModel = request.model;
      let finish: unknown = null;
      let currentUsage: Record<string, unknown> = {};
      const toolParts = new Map<number, ToolPart>();

      const consume = (raw: string): void => {
        const line = raw.trim();
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data) return;
        const event = JSON.parse(data) as Record<string, unknown>;
        if (event.type === "error") {
          const detail = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : {};
          throw new Error(`Claude Agent stream error: ${String(detail.type ?? "unknown")}`);
        }
        if (event.type === "message_start") {
          const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : {};
          if (typeof message.id === "string") providerRequestId = message.id;
          if (typeof message.model === "string") providerModel = message.model;
          if (message.usage && typeof message.usage === "object") currentUsage = { ...currentUsage, ...message.usage as Record<string, unknown> };
        }
        if (event.type === "content_block_start") {
          const index = typeof event.index === "number" ? event.index : 0;
          const block = event.content_block && typeof event.content_block === "object" ? event.content_block as Record<string, unknown> : {};
          if (block.type === "tool_use") toolParts.set(index, { id: String(block.id ?? ""), name: String(block.name ?? ""), input: "" });
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            content += block.text;
            request.onTextDelta?.(block.text);
          }
        }
        if (event.type === "content_block_delta") {
          const index = typeof event.index === "number" ? event.index : 0;
          const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            content += delta.text;
            request.onTextDelta?.(delta.text);
          }
          if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const tool = toolParts.get(index);
            if (tool) tool.input += delta.partial_json;
          }
        }
        if (event.type === "message_delta") {
          const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : {};
          if (delta.stop_reason !== undefined) finish = delta.stop_reason;
          if (event.usage && typeof event.usage === "object") currentUsage = { ...currentUsage, ...event.usage as Record<string, unknown> };
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
      const toolCalls: AgentToolCall[] = [...toolParts.entries()].sort(([a], [b]) => a - b).map(([, tool], index) => {
        let input: unknown = {};
        try { input = JSON.parse(tool.input || "{}"); } catch { input = tool.input; }
        return { id: tool.id || `claude-tool-${index}`, name: tool.name, input };
      });
      return {
        provider: "claude",
        providerRequestId,
        model: providerModel,
        content,
        toolCalls,
        stopReason: toolCalls.length ? "tool_use" : stopReason(finish),
        usage: usage(currentUsage),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(request.signal.aborted ? "Agent run cancelled" : "Claude Agent request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }
  }
}

export const __testing = { toClaudeMessages, usage, stopReason };
