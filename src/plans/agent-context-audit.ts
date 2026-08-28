import fs from "node:fs/promises";
import path from "node:path";
import type { PlanAgentContext, PlanRepository } from "./contracts";
import { assertValidPlanAgentContext } from "./validation";
import { assertExpectedConfigHash, assertExpectedRevision } from "./conflict";
import { hashPlanConfig, sha256Hex } from "./canonical";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, ensurePrivateDirectory, withDirectoryLock } from "../runtime/fs.mjs";
import { createPlanPartialEvaluationV3, isPlanPartialEvaluationV3 } from "./evaluation";
import type { BuildConfigDocument } from "../config/types";

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
  private readonly root: string | undefined;
  private readonly coordinator: RuntimeCoordinator | undefined;

  constructor(rootOrOptions: string | { root?: string; runtimeRoot?: string; coordinator?: RuntimeCoordinator }) {
    if (typeof rootOrOptions === "string") this.root = path.resolve(rootOrOptions);
    else {
      this.root = rootOrOptions.root ? path.resolve(rootOrOptions.root) : undefined;
      this.coordinator = rootOrOptions.coordinator ?? (!this.root ? new RuntimeCoordinator({ root: rootOrOptions.runtimeRoot }) : undefined);
    }
  }

  private file(root: string, runId: string): string {
    return confined(root, `${safeId(runId)}.json`);
  }

  private async readAt(root: string, runId: string): Promise<PlanAgentRunContextAudit | null> {
    try {
      const stored = JSON.parse(await fs.readFile(this.file(root, runId), "utf8")) as unknown;
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("Plan Agent context audit envelope is corrupt");
      const envelope = stored as { schemaVersion?: unknown; kind?: unknown; checksum?: unknown; payload?: unknown };
      if (envelope.schemaVersion !== "plan-agent-context-audit-envelope-v1" || envelope.kind !== "plan-agent-context-audit" || !envelope.payload
        || envelope.checksum !== await sha256Hex(envelope.payload)) throw new Error("Plan Agent context audit integrity check failed");
      return structuredClone(envelope.payload) as PlanAgentRunContextAudit;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async putAt(root: string, record: PlanAgentRunContextAudit): Promise<void> {
    await ensurePrivateDirectory(root);
    const file = this.file(root, record.runId);
    const existing = await this.readAt(root, record.runId);
    if (existing) {
      if (await sha256Hex(existing) !== await sha256Hex(record)) throw new Error("Plan Agent context audit run id conflict");
      return;
    }
    await atomicWriteJson(file, {
      schemaVersion: "plan-agent-context-audit-envelope-v1",
      kind: "plan-agent-context-audit",
      checksum: await sha256Hex(record),
      payload: record,
    });
  }

  async put(record: PlanAgentRunContextAudit): Promise<void> {
    safeId(record.runId);
    if (this.root) return withDirectoryLock(confined(this.root, ".locks", safeId(record.runId)), () => this.putAt(this.root!, record));
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    await coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => this.putAt(confined(activeRoot, "audit", "plan-agent-context"), record));
  }

  async get(runId: string): Promise<PlanAgentRunContextAudit | null> {
    safeId(runId);
    if (this.root) return this.readAt(this.root, runId);
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    return (await coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => this.readAt(confined(activeRoot, "audit", "plan-agent-context"), runId))).result;
  }
}

export async function recordPlanAgentRunContext(repository: PlanRepository, store: PlanAgentContextAuditStore, input: { sessionId: string; runId: string; context: PlanAgentContext }, now = () => new Date().toISOString()): Promise<PlanAgentRunContextAudit> {
  if (!input.sessionId || !input.runId) throw new Error("sessionId and runId are required");
  assertValidPlanAgentContext(input.context);
  const plan = await repository.get(input.context.planId);
  const planConfig = plan.draft.config as BuildConfigDocument;
  assertExpectedRevision(input.context.draftRevision, plan.draftRevision);
  const authoritativeConfigHash = await hashPlanConfig(planConfig);
  assertExpectedConfigHash(input.context.configHash, authoritativeConfigHash);
  assertExpectedConfigHash(await hashPlanConfig(input.context.buildConfig), authoritativeConfigHash);
  if (input.context.planVersionId !== plan.activeVersionId) throw new Error("stale_plan_version");
  assertExpectedConfigHash(input.context.evaluationHash, await sha256Hex(input.context.evaluation));
  if (planConfig.schemaVersion === "3.0.0") {
    if (!isPlanPartialEvaluationV3(input.context.evaluation)
      || await sha256Hex(input.context.evaluation) !== await sha256Hex(createPlanPartialEvaluationV3(planConfig))) {
      throw new Error("stale_v3_partial_evaluation");
    }
  } else {
    if (isPlanPartialEvaluationV3(input.context.evaluation)
      || await hashPlanConfig(input.context.evaluation.config) !== authoritativeConfigHash) throw new Error("stale_v2_evaluation");
  }
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
