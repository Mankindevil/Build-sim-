import { randomUUID } from "node:crypto";
import type {
  AgentProviderId,
  AgentRunEvent,
  AgentRunStatus,
  AgentSession,
  ProviderAdapter,
} from "./contracts";
import { AGENT_CONTRACT_VERSION } from "./contracts";
import type { AgentSessionStore } from "./session-store";

const SYSTEM_PROMPT = `You are the Build Sim Agent. Be concise and explicit about unknowns. Deterministic BuildEvaluation and Tool results are authoritative. Never invent measurements, prices, compatibility verdicts, source references, or tool results. You may explain facts but may not downgrade bad findings or turn unknown into known.`;

export class AgentRuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

type Listener = (event: AgentRunEvent, index: number) => void;

interface RunRecord {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  events: AgentRunEvent[];
  listeners: Set<Listener>;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

export interface StartAgentRunInput {
  content: string;
  buildConfig?: AgentSession["buildConfig"];
}

export class AgentRuntime {
  private readonly providers = new Map<AgentProviderId, ProviderAdapter>();
  private readonly runs = new Map<string, RunRecord>();

  constructor(
    adapters: ProviderAdapter[],
    private readonly store: AgentSessionStore,
    private readonly options: {
      now?: () => string;
      id?: () => string;
      maxTokens?: number;
      temperature?: number;
    } = {},
  ) {
    for (const adapter of adapters) this.providers.set(adapter.id, adapter);
  }

  private now(): string { return (this.options.now ?? (() => new Date().toISOString()))(); }
  private id(prefix: string): string { return `${prefix}-${(this.options.id ?? randomUUID)()}`; }

  getModels() {
    return [...this.providers.values()].flatMap((provider) => provider.models);
  }

  async createSession(input: { provider?: AgentProviderId; model?: string } = {}): Promise<AgentSession> {
    const providerId = input.provider ?? "deepseek";
    const provider = this.providers.get(providerId);
    if (!provider) throw new AgentRuntimeError("provider_not_found", `Unknown Agent provider: ${providerId}`, 404);
    const model = input.model ?? provider.models[0]?.id;
    if (!model || !provider.models.some((entry) => entry.id === model)) throw new AgentRuntimeError("model_not_found", `Unknown Agent model: ${model ?? "missing"}`, 404);
    const now = this.now();
    const session: AgentSession = {
      contractVersion: AGENT_CONTRACT_VERSION,
      id: this.id("session"),
      provider: providerId,
      model,
      messages: [],
      buildConfig: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.put(session);
    return session;
  }

  async getSession(sessionId: string): Promise<AgentSession> {
    const session = await this.store.get(sessionId);
    if (!session) throw new AgentRuntimeError("session_not_found", "Agent session not found", 404);
    return session;
  }

  async startRun(sessionId: string, input: StartAgentRunInput): Promise<{ runId: string; status: AgentRunStatus }> {
    if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 20_000) {
      throw new AgentRuntimeError("message_invalid", "Agent message must contain 1-20000 characters");
    }
    const session = await this.getSession(sessionId);
    const provider = this.providers.get(session.provider);
    if (!provider) throw new AgentRuntimeError("provider_not_found", "Agent provider is unavailable", 503);
    const now = this.now();
    session.messages.push({ id: this.id("message"), role: "user", content: input.content.trim(), createdAt: now });
    if (input.buildConfig !== undefined) session.buildConfig = input.buildConfig;
    session.updatedAt = now;
    await this.store.put(session);

    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const run: RunRecord = {
      id: this.id("run"),
      sessionId,
      status: "queued",
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      done,
      resolveDone,
    };
    this.runs.set(run.id, run);
    this.emit(run, { type: "run_status", runId: run.id, status: "queued", at: now });
    void this.execute(run, session, provider);
    return { runId: run.id, status: run.status };
  }

  private emit(run: RunRecord, event: AgentRunEvent): void {
    const index = run.events.push(event) - 1;
    for (const listener of run.listeners) listener(event, index);
  }

  private async execute(run: RunRecord, session: AgentSession, provider: ProviderAdapter): Promise<void> {
    run.status = "running";
    this.emit(run, { type: "run_status", runId: run.id, status: run.status, at: this.now() });
    try {
      const turn = await provider.createTurn({
        model: session.model,
        system: SYSTEM_PROMPT,
        messages: structuredClone(session.messages),
        tools: [],
        maxTokens: this.options.maxTokens ?? 2_000,
        temperature: this.options.temperature ?? 0.2,
        signal: run.controller.signal,
        onTextDelta: (text) => this.emit(run, { type: "text_delta", runId: run.id, text, at: this.now() }),
      });
      if (turn.toolCalls.length) throw new AgentRuntimeError("tools_not_enabled", "Provider requested tools before the Tool runtime was enabled", 409);
      session.messages.push({ id: this.id("message"), role: "assistant", content: turn.content, createdAt: this.now() });
      session.updatedAt = this.now();
      await this.store.put(session);
      this.emit(run, { type: "usage", runId: run.id, provider: turn.provider, model: turn.model, usage: turn.usage, at: this.now() });
      run.status = "completed";
      this.emit(run, { type: "run_status", runId: run.id, status: run.status, at: this.now() });
    } catch (error) {
      const cancelled = run.controller.signal.aborted;
      run.status = cancelled ? "cancelled" : "failed";
      this.emit(run, {
        type: "error",
        runId: run.id,
        code: cancelled ? "run_cancelled" : error instanceof AgentRuntimeError ? error.code : "provider_failed",
        message: cancelled ? "Agent run cancelled" : error instanceof Error ? error.message : "Agent run failed",
        at: this.now(),
      });
      this.emit(run, { type: "run_status", runId: run.id, status: run.status, at: this.now() });
    } finally {
      run.resolveDone();
    }
  }

  getRun(runId: string): { runId: string; sessionId: string; status: AgentRunStatus; events: AgentRunEvent[] } {
    const run = this.runs.get(runId);
    if (!run) throw new AgentRuntimeError("run_not_found", "Agent run not found", 404);
    return { runId: run.id, sessionId: run.sessionId, status: run.status, events: structuredClone(run.events) };
  }

  subscribe(runId: string, listener: Listener, afterIndex = -1): () => void {
    const run = this.runs.get(runId);
    if (!run) throw new AgentRuntimeError("run_not_found", "Agent run not found", 404);
    run.events.forEach((event, index) => { if (index > afterIndex) listener(structuredClone(event), index); });
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  cancelRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new AgentRuntimeError("run_not_found", "Agent run not found", 404);
    if (run.status === "queued" || run.status === "running") run.controller.abort();
  }

  async waitForRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new AgentRuntimeError("run_not_found", "Agent run not found", 404);
    await run.done;
  }
}
