import fs from "node:fs/promises";
import path from "node:path";
import type { PlanAgentContext, PlanRepository } from "./contracts";
import { assertValidPlanAgentContext } from "./validation";
import { assertExpectedConfigHash, assertExpectedRevision } from "./conflict";
import { sha256Hex } from "./canonical";

export interface PlanAgentRunContextAudit {
  schemaVersion: "1.0.0";
  sessionId: string;
  runId: string;
  planId: string;
  planVersionId: string | null;
  draftRevision: number;
  configHash: string;
  evaluationHash: string;
  spatialSelection: PlanAgentContext["spatialSelection"];
  contextHash: string;
  recordedAt: string;
}

export interface PlanAgentContextAuditStore {
  put(record: PlanAgentRunContextAudit): Promise<void>;
  get(runId: string): Promise<PlanAgentRunContextAudit | null>;
}

export class MemoryPlanAgentContextAuditStore implements PlanAgentContextAuditStore {
  private readonly values = new Map<string, PlanAgentRunContextAudit>();
  async put(record: PlanAgentRunContextAudit): Promise<void> { this.values.set(record.runId, structuredClone(record)); }
  async get(runId: string): Promise<PlanAgentRunContextAudit | null> { return this.values.has(runId) ? structuredClone(this.values.get(runId)!) : null; }
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,180}$/.test(value)) throw new Error("unsafe run id");
  return value;
}

export class FilePlanAgentContextAuditStore implements PlanAgentContextAuditStore {
  constructor(private readonly root: string) {}
  async put(record: PlanAgentRunContextAudit): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, `${safeId(record.runId)}.json`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  async get(runId: string): Promise<PlanAgentRunContextAudit | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.root, `${safeId(runId)}.json`), "utf8")) as PlanAgentRunContextAudit; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
}

export async function recordPlanAgentRunContext(repository: PlanRepository, store: PlanAgentContextAuditStore, input: { sessionId: string; runId: string; context: PlanAgentContext }, now = () => new Date().toISOString()): Promise<PlanAgentRunContextAudit> {
  if (!input.sessionId || !input.runId) throw new Error("sessionId and runId are required");
  assertValidPlanAgentContext(input.context);
  const plan = await repository.get(input.context.planId);
  assertExpectedRevision(input.context.draftRevision, plan.draftRevision);
  assertExpectedConfigHash(input.context.configHash, await sha256Hex(plan.draft.config));
  const record: PlanAgentRunContextAudit = {
    schemaVersion: "1.0.0",
    sessionId: input.sessionId,
    runId: input.runId,
    planId: input.context.planId,
    planVersionId: input.context.planVersionId,
    draftRevision: input.context.draftRevision,
    configHash: input.context.configHash,
    evaluationHash: input.context.evaluationHash,
    spatialSelection: structuredClone(input.context.spatialSelection),
    contextHash: await sha256Hex(input.context),
    recordedAt: now(),
  };
  await store.put(record);
  return record;
}
