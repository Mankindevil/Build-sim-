import type { AgentSession } from "./contracts";

export interface AgentSessionStore {
  get(sessionId: string): Promise<AgentSession | null>;
  put(session: AgentSession): Promise<void>;
}

export class MemoryAgentSessionStore implements AgentSessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  async get(sessionId: string): Promise<AgentSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async put(session: AgentSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }
}

