import { createHash } from "node:crypto";
import { stableDefinition, validateToolSpec } from "./contract-validation";
import type { AgentToolContext, AgentToolResult, AgentToolSpec, ProviderToolDefinition } from "./contracts";
import { validateJsonSchema } from "./tool-schema";

export interface DispatchedToolResult {
  result: AgentToolResult;
  definitionHash: string;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolSpec>();
  private readonly hashes = new Map<string, string>();

  constructor(specs: AgentToolSpec[]) {
    for (const spec of specs) {
      const errors = validateToolSpec(spec);
      if (errors.length) throw new Error(`Invalid Agent Tool ${spec.name}: ${errors.join("; ")}`);
      if (this.tools.has(spec.name)) throw new Error(`Duplicate Agent Tool: ${spec.name}`);
      this.tools.set(spec.name, spec);
      this.hashes.set(spec.name, createHash("sha256").update(stableDefinition(spec)).digest("hex"));
    }
  }

  names(): string[] { return [...this.tools.keys()].sort(); }

  catalog() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      effect: tool.effect,
      approval: tool.approval,
      definitionHash: this.definitionHash(tool.name),
    }));
  }

  definitions(allowedTools?: Set<string>): ProviderToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => !allowedTools || allowedTools.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, strict: true }));
  }

  definitionHash(name: string): string {
    const hash = this.hashes.get(name);
    if (!hash) throw new Error(`Unknown Agent Tool: ${name}`);
    return hash;
  }

  definitionHashOrUnregistered(name: string): string {
    return this.hashes.get(name) ?? "unregistered";
  }

  async dispatch(name: string, input: unknown, context: AgentToolContext, allowedTools?: Set<string>): Promise<DispatchedToolResult> {
    const tool = this.tools.get(name);
    if (!tool || (allowedTools && !allowedTools.has(name))) {
      return { definitionHash: "unregistered", result: { ok: false, content: null, errorCode: "tool_not_allowed", message: `Tool is not registered or allowed: ${name}`, provenance: [] } };
    }
    if (tool.effect === "write" || tool.approval !== "never") {
      return { definitionHash: this.definitionHash(name), result: { ok: false, content: null, errorCode: "write_tools_disabled", message: "Write Tools remain disabled; an approval envelope alone cannot enable execution", provenance: [] } };
    }
    const validationErrors = validateJsonSchema(input, tool.inputSchema as Record<string, unknown>);
    if (validationErrors.length) {
      return { definitionHash: this.definitionHash(name), result: { ok: false, content: null, errorCode: "tool_input_invalid", message: validationErrors.join("; "), provenance: [] } };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, tool.timeoutMs);
    try {
      const result = await Promise.race([
        tool.execute(input, { ...context, signal: controller.signal }),
        new Promise<AgentToolResult>((resolve) => controller.signal.addEventListener("abort", () => resolve({ ok: false, content: null, errorCode: context.signal.aborted ? "tool_cancelled" : "tool_timeout", message: context.signal.aborted ? "Tool call cancelled" : "Tool call timed out", provenance: [] }), { once: true })),
      ]);
      const bytes = Buffer.byteLength(JSON.stringify(result.content ?? null));
      if (bytes > Math.min(tool.maxResultBytes, 1_000_000)) {
        return { definitionHash: this.definitionHash(name), result: { ok: false, content: { originalBytes: bytes }, errorCode: "tool_result_too_large", message: "Tool result exceeded its context budget", provenance: result.provenance, truncated: true } };
      }
      return { definitionHash: this.definitionHash(name), result };
    } catch (error) {
      return { definitionHash: this.definitionHash(name), result: { ok: false, content: null, errorCode: "tool_execution_failed", message: error instanceof Error ? error.message : "Tool execution failed", provenance: [] } };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    }
  }
}
