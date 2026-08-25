import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSession } from "../agent/contracts";
import type { AgentSessionStore } from "../agent/session-store";

const SESSION_ID = /^[A-Za-z0-9._:-]{8,120}$/;

export class FileAgentSessionStore implements AgentSessionStore {
  constructor(private readonly root = path.resolve("data/agent/sessions")) {}

  private file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("invalid Agent session id");
    return path.join(this.root, `${sessionId}.json`);
  }

  async get(sessionId: string): Promise<AgentSession | null> {
    try {
      return JSON.parse(await readFile(this.file(sessionId), "utf8")) as AgentSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(session: AgentSession): Promise<void> {
    const file = this.file(session.id);
    await mkdir(this.root, { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }
}
