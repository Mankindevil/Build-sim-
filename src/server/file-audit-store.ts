import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunAuditRecord } from "../agent/contracts";
import { agentAuditHash, type AgentRunAuditStore } from "../agent/audit";

const RUN_ID = /^[A-Za-z0-9._:-]{8,120}$/;

export class FileAgentRunAuditStore implements AgentRunAuditStore {
  constructor(private readonly root = path.resolve("data/agent/audit")) {}

  private file(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error("invalid Agent run id");
    return path.join(this.root, `${runId}.json`);
  }

  async get(runId: string): Promise<AgentRunAuditRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.file(runId), "utf8")) as AgentRunAuditRecord;
      const { recordHash, ...unsigned } = record;
      if (recordHash !== agentAuditHash(unsigned)) throw new Error("Agent audit integrity check failed");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(record: AgentRunAuditRecord): Promise<void> {
    const { recordHash, ...unsigned } = record;
    if (recordHash !== agentAuditHash(unsigned)) throw new Error("Agent audit record is not sealed");
    const file = this.file(record.runId);
    await mkdir(this.root, { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }
}
