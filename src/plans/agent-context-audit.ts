import fs from "node:fs/promises";
import path from "node:path";
import type { PlanAgentContext, PlanRepository } from "./contracts";
import { assertValidPlanAgentContext } from "./validation";
import { assertExpectedConfigHash, assertExpectedRevision } from "./conflict";
import { hashPlanConfig, sha256Hex } from "./canonical";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, ensurePrivateDirectory, withDirectoryLock } from "../runtime/fs.mjs";
import {
  authoritativeEvaluationHashFromLockHash,
  isTopologyEvaluationV3,
  matchesBuildConfigV3Evaluation,
} from "./evaluation";
import type { BuildConfigDocument } from "../config/types";
import {
  validatePlanAgentRunContextAuditEnvelopeRuntime,
  validatePlanAgentRunContextAuditRuntime,
} from "./agent-context-audit-runtime.mjs";

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

const ISSUED_AUDIT_RECORDS = new WeakSet<object>();
const ROOT_BOUND_AUDIT_WRITE = Symbol("root-bound-plan-agent-context-audit-write");

function issueAuditRecord(record: PlanAgentRunContextAudit): PlanAgentRunContextAudit {
  if (record.spatialSelection) Object.freeze(record.spatialSelection);
  const issued = Object.freeze(record);
  ISSUED_AUDIT_RECORDS.add(issued);
  return issued;
}

function assertIssuedAuditRecord(record: PlanAgentRunContextAudit): void {
  if (!ISSUED_AUDIT_RECORDS.has(record)) {
    throw new Error("Plan Agent context audit must be issued by recordPlanAgentRunContext");
  }
}

function assertValidAuditRecord(record: unknown): asserts record is PlanAgentRunContextAudit {
  const errors = validatePlanAgentRunContextAuditRuntime(record);
  if (errors.length) throw new Error(`Plan Agent context audit is invalid: ${errors.join(", ")}`);
}

export class MemoryPlanAgentContextAuditStore implements PlanAgentContextAuditStore {
  private readonly values = new Map<string, PlanAgentRunContextAudit>();
  async put(record: PlanAgentRunContextAudit): Promise<void> {
    assertIssuedAuditRecord(record);
    assertValidAuditRecord(record);
    const existing = this.values.get(record.runId);
    if (existing && await sha256Hex(existing) !== await sha256Hex(record)) throw new Error("Plan Agent context audit run id conflict");
    this.values.set(record.runId, structuredClone(record));
  }
  async get(runId: string): Promise<PlanAgentRunContextAudit | null> {
    safeId(runId);
    const record = this.values.get(runId);
    if (!record) return null;
    assertValidAuditRecord(record);
    return structuredClone(record);
  }
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(value)) throw new Error("unsafe run id");
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
      const errors = validatePlanAgentRunContextAuditEnvelopeRuntime(stored, runId);
      if (errors.length) throw new Error(`Plan Agent context audit integrity check failed: ${errors.join(", ")}`);
      return structuredClone((stored as { payload: PlanAgentRunContextAudit }).payload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async putAt(root: string, record: PlanAgentRunContextAudit): Promise<void> {
    assertValidAuditRecord(record);
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
    assertIssuedAuditRecord(record);
    safeId(record.runId);
    if (this.root) return withDirectoryLock(confined(this.root, ".locks", safeId(record.runId)), () => this.putAt(this.root!, record));
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    await coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => this.putAt(confined(activeRoot, "audit", "plan-agent-context"), record));
  }

  async [ROOT_BOUND_AUDIT_WRITE](activeRoot: string, record: PlanAgentRunContextAudit): Promise<void> {
    if (this.root || !this.coordinator) throw new Error("root-bound Plan Agent context audit writes require the shared runtime coordinator");
    assertIssuedAuditRecord(record);
    safeId(record.runId);
    await this.putAt(confined(activeRoot, "audit", "plan-agent-context"), record);
  }

  /**
   * Explicit compatibility bridge for governed migrations and recovery tools.
   * Normal request handling must use recordPlanAgentRunContext instead.
   */
  async putWithMaintenanceLease(record: PlanAgentRunContextAudit, maintenanceLeaseToken: string): Promise<void> {
    if (this.root || !this.coordinator) throw new Error("Plan Agent context audit maintenance import requires the shared runtime coordinator");
    assertValidAuditRecord(record);
    await this.coordinator.assertMaintenanceLease(maintenanceLeaseToken);
    await this.coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => this.putAt(
      confined(activeRoot, "audit", "plan-agent-context"),
      record,
    ), { maintenanceLeaseToken });
  }

  async get(runId: string): Promise<PlanAgentRunContextAudit | null> {
    safeId(runId);
    if (this.root) return this.readAt(this.root, runId);
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    return (await coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => this.readAt(confined(activeRoot, "audit", "plan-agent-context"), runId))).result;
  }
}

type AgentContextRecordInput = { sessionId: string; runId: string; context: PlanAgentContext };

export interface RootBoundPlanAgentContextRepository extends PlanRepository {
  getAtRoot(activeRoot: string, planId: string): ReturnType<PlanRepository["get"]>;
}

async function issuePlanAgentRunContextAudit(
  plan: Awaited<ReturnType<PlanRepository["get"]>>,
  input: AgentContextRecordInput,
  now: () => string,
): Promise<PlanAgentRunContextAudit> {
  safeId(input.sessionId);
  safeId(input.runId);
  assertValidPlanAgentContext(input.context);
  const planConfig = plan.draft.config as BuildConfigDocument;
  assertExpectedRevision(input.context.draftRevision, plan.draftRevision);
  const authoritativeConfigHash = await hashPlanConfig(planConfig);
  assertExpectedConfigHash(input.context.configHash, authoritativeConfigHash);
  assertExpectedConfigHash(await hashPlanConfig(input.context.buildConfig), authoritativeConfigHash);
  if (input.context.planVersionId !== plan.activeVersionId) throw new Error("stale_plan_version");
  assertExpectedConfigHash(
    input.context.evaluationHash,
    input.context.evaluationLockHash
      ? await authoritativeEvaluationHashFromLockHash(input.context.evaluation, input.context.evaluationLockHash)
      : await sha256Hex(input.context.evaluation),
  );
  if (planConfig.schemaVersion === "3.0.0") {
    if (!await matchesBuildConfigV3Evaluation(planConfig, input.context.evaluation)) throw new Error("stale_v3_evaluation");
  } else {
    if (isTopologyEvaluationV3(input.context.evaluation)
      || await hashPlanConfig(input.context.evaluation.config) !== authoritativeConfigHash) throw new Error("stale_v2_evaluation");
  }
  const record = issueAuditRecord({
    schemaVersion: "1.0.0",
    sessionId: input.sessionId,
    runId: input.runId,
    planId: input.context.planId,
    planVersionId: input.context.planVersionId,
    draftRevision: input.context.draftRevision,
    configHash: input.context.configHash,
    evaluationHash: input.context.evaluationHash,
    spatialSelection: input.context.spatialSelection ? structuredClone(input.context.spatialSelection) : null,
    contextHash: await sha256Hex(input.context),
    recordedAt: now(),
  } satisfies PlanAgentRunContextAudit);
  assertValidAuditRecord(record);
  return record;
}

export async function recordPlanAgentRunContext(repository: PlanRepository, store: PlanAgentContextAuditStore, input: AgentContextRecordInput, now = () => new Date().toISOString()): Promise<PlanAgentRunContextAudit> {
  const plan = await repository.get(input.context.planId);
  const record = await issuePlanAgentRunContextAudit(plan, input, now);
  await store.put(record);
  return record;
}

/**
 * Root-pinned variant for a caller already inside one RuntimeCoordinator
 * writer. Summary derivation, plan validation and audit persistence therefore
 * observe one generation and cannot straddle restore/activation.
 */
export async function recordPlanAgentRunContextAtRoot(
  repository: RootBoundPlanAgentContextRepository,
  store: FilePlanAgentContextAuditStore,
  activeRoot: string,
  input: AgentContextRecordInput,
  now = () => new Date().toISOString(),
): Promise<PlanAgentRunContextAudit> {
  const plan = await repository.getAtRoot(activeRoot, input.context.planId);
  const record = await issuePlanAgentRunContextAudit(plan, input, now);
  await store[ROOT_BOUND_AUDIT_WRITE](activeRoot, record);
  return record;
}
