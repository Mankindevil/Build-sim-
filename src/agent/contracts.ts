import type { BuildConfig } from "../config/types";

export const AGENT_CONTRACT_VERSION = "1.0.0" as const;

export type AgentProviderId = "deepseek" | "claude";
export type AgentRole = "system" | "user" | "assistant" | "tool";
export type ToolEffect = "read" | "external-read" | "write";
export type ToolApproval = "never" | "required";

export type JsonSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  strict: boolean;
}

export interface ProviderTurnRequest {
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: ProviderToolDefinition[];
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
  onTextDelta?: (text: string) => void;
}

export interface ProviderTurnResult {
  provider: AgentProviderId;
  providerRequestId: string | null;
  model: string;
  content: string;
  toolCalls: AgentToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "content_filter" | "cancelled" | "error";
  usage: ProviderUsage;
  latencyMs: number;
}

export interface ProviderModel {
  provider: AgentProviderId;
  id: string;
  label: string;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    parallelTools: boolean;
    structuredOutput: boolean;
    thinking: boolean;
  };
}

export interface ProviderAdapter {
  readonly id: AgentProviderId;
  readonly models: ProviderModel[];
  createTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult>;
}

export interface AgentToolContext {
  sessionId: string;
  runId: string;
  buildConfig: BuildConfig | null;
  signal: AbortSignal;
}

export interface AgentToolResult {
  ok: boolean;
  content: unknown;
  errorCode?: string;
  message?: string;
  provenance: string[];
  truncated?: boolean;
}

export interface AgentToolSpec {
  contractVersion: typeof AGENT_CONTRACT_VERSION;
  name: string;
  title: string;
  description: string;
  effect: ToolEffect;
  approval: ToolApproval;
  timeoutMs: number;
  maxResultBytes: number;
  inputSchema: JsonSchema;
  execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult>;
}

export interface AgentSkillManifest {
  contractVersion: typeof AGENT_CONTRACT_VERSION;
  id: string;
  name: string;
  version: string;
  description: string;
  allowedTools: string[];
  readOnly: boolean;
  contextBudget: number;
  triggers: string[];
}

export interface LoadedAgentSkill {
  manifest: AgentSkillManifest;
  instructions: string;
  definitionHash: string;
}

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "limit_exceeded";

export type AgentRunEvent =
  | { type: "run_status"; runId: string; status: AgentRunStatus; at: string }
  | { type: "skill_activated"; runId: string; skillId: string; definitionHash: string; at: string }
  | { type: "text_delta"; runId: string; text: string; at: string }
  | { type: "tool_call"; runId: string; call: AgentToolCall; toolDefinitionHash: string; at: string }
  | { type: "tool_result"; runId: string; callId: string; toolName: string; result: AgentToolResult; at: string }
  | { type: "usage"; runId: string; provider: AgentProviderId; model: string; usage: ProviderUsage; at: string }
  | { type: "error"; runId: string; code: string; message: string; at: string };

export interface AgentSession {
  contractVersion: typeof AGENT_CONTRACT_VERSION;
  id: string;
  provider: AgentProviderId;
  model: string;
  messages: AgentMessage[];
  buildConfig: BuildConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunLimits {
  maxModelTurns: number;
  maxToolCalls: number;
  maxRepeatedToolCalls: number;
  maxToolResultBytes: number;
}

