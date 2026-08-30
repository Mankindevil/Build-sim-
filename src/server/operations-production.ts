import { randomUUID } from "node:crypto";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  createBackup,
  persistBackupVerification,
  validatePersistedBackupVerificationRecord,
  verifyBackup,
} from "../backup/runtime.mjs";
import type { DoctorReport } from "../doctor/contracts";
import { validateRepairPlan, type RepairPlan } from "../doctor/contracts";
import { createRedactedDiagnosticBundle, verifyRedactedDiagnosticBundle } from "../doctor/diagnostic-bundle.mjs";
import { executeApprovedRepair } from "../doctor/repair.mjs";
import { runDoctor } from "../doctor/runner.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import {
  atomicWriteJson,
  confined,
  ensurePrivateDirectory,
  listRegularFiles,
  pathExists,
  readJson,
  sha256Json,
} from "../runtime/fs.mjs";
import { persistProductionReferenceGraph } from "../runtime/production-reference-graph.mjs";

export interface WorkspaceBackupSummary {
  readonly schemaVersion: "workspace-backup-summary-v1";
  readonly backupId: string;
  readonly manifestHash: string;
  readonly createdAt: string;
  readonly verifiedAt: string;
  readonly runtimeGeneration: number;
  readonly entryCount: number;
  readonly result: "pass";
}

export interface WorkspaceDiagnosticSummary {
  readonly schemaVersion: "workspace-diagnostic-summary-v1";
  readonly diagnosticId: string;
  readonly bundleHash: string;
  readonly createdAt: string;
  readonly runtimeGeneration: number;
  readonly downloadUrl: string;
}

export interface WorkspaceRepairPreview {
  readonly schemaVersion: "workspace-repair-preview-v1";
  readonly repairPlanId: string;
  readonly planHash: string;
  readonly reportHash: string;
  readonly actionIds: readonly ["restrict-runtime-permissions"];
  readonly impactSummary: string;
  readonly backupId: string;
  readonly requiresSecondConfirmation: true;
}

export interface WorkspaceRepairResult {
  readonly schemaVersion: "workspace-repair-result-v1";
  readonly repairPlanId: string;
  readonly applied: boolean;
  readonly idempotentReplay: boolean;
  readonly rolledBack: boolean;
  readonly afterReportHash: string;
  readonly afterOverall: DoctorReport["overall"];
}

interface StoredRepairPlan {
  readonly schemaVersion: "workspace-repair-plan-v1";
  readonly plan: RepairPlan;
  readonly preparedAt: string;
  readonly planHash: string;
}

const PERMISSION_ACTION = "restrict-runtime-permissions" as const;
const PERMISSION_IMPACT = "Restrict the local runtime tree to owner-only file and directory permissions.";

function exactCreateInput(value: unknown): { password: string; confirmation: true } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) throw new TypeError("backup request fields are invalid");
  const input = value as { password?: unknown; confirmation?: unknown };
  if (typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") < 12 || input.confirmation !== true) {
    throw new TypeError("backup password and explicit confirmation are required");
  }
  return { password: input.password, confirmation: true };
}

function exactRepairPreviewInput(value: unknown): { password: string; confirmation: true; actionIds: [typeof PERMISSION_ACTION] } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) {
    throw new TypeError("repair preview request fields are invalid");
  }
  const input = value as { password?: unknown; confirmation?: unknown; actionIds?: unknown };
  if (typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") < 12 || input.confirmation !== true
    || !Array.isArray(input.actionIds) || input.actionIds.length !== 1 || input.actionIds[0] !== PERMISSION_ACTION) {
    throw new TypeError("repair preview requires one supported action, backup password, and explicit confirmation");
  }
  return { password: input.password, confirmation: true, actionIds: [PERMISSION_ACTION] };
}

function exactRepairApplyInput(value: unknown): { repairPlanId: string; planHash: string; password: string; confirmation: true } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4) {
    throw new TypeError("repair apply request fields are invalid");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.repairPlanId !== "string" || !/^[a-f0-9-]{16,80}$/.test(input.repairPlanId)
    || typeof input.planHash !== "string" || !/^[a-f0-9]{64}$/.test(input.planHash)
    || typeof input.password !== "string" || Buffer.byteLength(input.password, "utf8") < 12
    || input.confirmation !== true) throw new TypeError("repair apply requires the exact plan, backup password, and second confirmation");
  return { repairPlanId: input.repairPlanId, planHash: input.planHash, password: input.password, confirmation: true };
}

function summary(record: Record<string, unknown>): WorkspaceBackupSummary {
  const payload = record.payload as Record<string, unknown>;
  const manifest = payload.manifest as Record<string, unknown>;
  const report = payload.report as Record<string, unknown>;
  return {
    schemaVersion: "workspace-backup-summary-v1",
    backupId: String(manifest.backupId), manifestHash: String(manifest.manifestHash),
    createdAt: String(manifest.createdAt), verifiedAt: String(report.verifiedAt),
    runtimeGeneration: Number(manifest.runtimeGeneration), entryCount: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
    result: "pass",
  };
}

export class ProductionWorkspaceOperations {
  private readonly exportRoot: string;
  private readonly diagnosticRoot: string;
  private readonly repairRoot: string;
  private readonly repairIdempotencyRoot: string;
  constructor(private readonly options: { coordinator: RuntimeCoordinator; runtimeRoot: string; now?: () => string }) {
    this.exportRoot = path.join(path.resolve(options.runtimeRoot), "exports", "full-backups");
    this.diagnosticRoot = path.join(path.resolve(options.runtimeRoot), "exports", "diagnostics");
    this.repairRoot = path.join(path.resolve(options.runtimeRoot), "exports", "repair-plans");
    this.repairIdempotencyRoot = path.join(path.resolve(options.runtimeRoot), "exports", "repair-idempotency");
  }

  async doctor(): Promise<DoctorReport> {
    const result = await runDoctor({ coordinator: this.options.coordinator, offline: true, now: this.options.now });
    return result.report as unknown as DoctorReport;
  }

  async listBackups(): Promise<WorkspaceBackupSummary[]> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const root = confined(activeRoot, "backups", "verifications");
      let names: string[];
      try { names = await readdir(root); } catch { return []; }
      const records: WorkspaceBackupSummary[] = [];
      for (const name of names.sort()) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const record = await readJson(confined(root, name));
        if (!validatePersistedBackupVerificationRecord(record)) throw new Error("persisted backup verification is invalid");
        records.push(summary(record as Record<string, unknown>));
      }
      return records.sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt));
    })).result;
  }

  async createFullBackup(value: unknown): Promise<WorkspaceBackupSummary> {
    const input = exactCreateInput(value);
    await ensurePrivateDirectory(this.exportRoot);
    const id = `backup-${randomUUID()}`;
    const outputFile = path.join(this.exportRoot, `${id}.buildsim`);
    const now = this.options.now ?? (() => new Date().toISOString());
    const graph = await persistProductionReferenceGraph({ coordinator: this.options.coordinator, now });
    await createBackup({ coordinator: this.options.coordinator, outputFile, password: input.password, backupId: id, mode: "full_local_backup", referenceGraph: graph, now });
    const verification = await verifyBackup({ inputFile: outputFile, password: input.password, now });
    await persistBackupVerification({ coordinator: this.options.coordinator, verification });
    const recordFile = await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => (
      readFile(confined(activeRoot, "backups", "verifications", `${verification.manifest.manifestHash}.json`), "utf8")
    ));
    const record = JSON.parse(recordFile.result as string) as Record<string, unknown>;
    if (!validatePersistedBackupVerificationRecord(record)) throw new Error("new backup verification could not be reloaded");
    return summary(record);
  }

  async createDiagnostic(value: unknown): Promise<WorkspaceDiagnosticSummary> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1
      || (value as { confirmation?: unknown }).confirmation !== true) throw new TypeError("diagnostic export requires explicit confirmation");
    const diagnosticId = randomUUID();
    await ensurePrivateDirectory(this.diagnosticRoot);
    const outputFile = path.join(this.diagnosticRoot, `${diagnosticId}.json`);
    const doctorRun = await runDoctor({ coordinator: this.options.coordinator, offline: true, now: this.options.now });
    const bundle = await createRedactedDiagnosticBundle({ doctorRun, outputFile, now: this.options.now });
    const verification = await verifyRedactedDiagnosticBundle(outputFile);
    if (!verification.valid) throw new Error(`diagnostic bundle verification failed: ${verification.errors.join("; ")}`);
    return {
      schemaVersion: "workspace-diagnostic-summary-v1",
      diagnosticId,
      bundleHash: bundle.bundleHash,
      createdAt: bundle.createdAt,
      runtimeGeneration: bundle.runtimeGeneration,
      downloadUrl: `/api/workspace/diagnostics/${encodeURIComponent(diagnosticId)}/download`,
    };
  }

  async downloadDiagnostic(diagnosticId: string): Promise<{ bytes: Buffer; fileName: string }> {
    if (!/^[a-f0-9-]{16,80}$/.test(diagnosticId)) throw new TypeError("diagnostic ID is invalid");
    const file = path.join(this.diagnosticRoot, `${diagnosticId}.json`);
    const verification = await verifyRedactedDiagnosticBundle(file);
    if (!verification.valid) throw new Error(`diagnostic bundle verification failed: ${verification.errors.join("; ")}`);
    return { bytes: await readFile(file), fileName: `${diagnosticId}.buildsim-diagnostic.json` };
  }

  async prepareRepair(value: unknown): Promise<WorkspaceRepairPreview> {
    const input = exactRepairPreviewInput(value);
    const backup = await this.createFullBackup({ password: input.password, confirmation: true });
    const doctorRun = await runDoctor({ coordinator: this.options.coordinator, offline: true, now: this.options.now });
    const permission = doctorRun.report.checks.find(({ checkId }) => checkId === "runtime.permissions");
    if (!permission || permission.status !== "fail" || permission.repairable !== true) {
      throw new Error("the requested repair is not applicable to the current Doctor report");
    }
    const state = await this.options.coordinator.readState();
    await stat(this.options.coordinator.activeRoot(state));
    const repairPlanId = randomUUID();
    const plan: RepairPlan = {
      repairPlanId,
      reportHash: doctorRun.report.reportHash,
      doctorVersion: doctorRun.report.doctorVersion,
      checkRegistryVersion: doctorRun.report.checkRegistryVersion,
      runtimeGeneration: doctorRun.report.runtimeGeneration,
      actionIds: [PERMISSION_ACTION],
      impactSummary: PERMISSION_IMPACT,
      preconditionHashes: [...doctorRun.preconditionHashes],
      backupId: backup.backupId,
      idempotencyKey: `doctor-repair:${repairPlanId}:${doctorRun.report.reportHash}`,
      rollbackRefs: [`backup:${backup.backupId}`],
    };
    const validationErrors = validateRepairPlan(plan);
    if (validationErrors.length) throw new Error(`generated repair plan is invalid: ${validationErrors.join("; ")}`);
    const planHash = sha256Json(plan);
    const stored: StoredRepairPlan = {
      schemaVersion: "workspace-repair-plan-v1",
      plan,
      preparedAt: doctorRun.report.generatedAt,
      planHash,
    };
    await ensurePrivateDirectory(this.repairRoot);
    await atomicWriteJson(path.join(this.repairRoot, `${repairPlanId}.json`), {
      schemaVersion: "workspace-repair-plan-envelope-v1",
      kind: "doctor-repair-plan",
      checksum: sha256Json(stored),
      payload: stored,
    });
    return {
      schemaVersion: "workspace-repair-preview-v1",
      repairPlanId,
      planHash,
      reportHash: plan.reportHash,
      actionIds: [PERMISSION_ACTION],
      impactSummary: plan.impactSummary,
      backupId: plan.backupId,
      requiresSecondConfirmation: true,
    };
  }

  async applyRepair(value: unknown): Promise<WorkspaceRepairResult> {
    const input = exactRepairApplyInput(value);
    const record = await readJson(path.join(this.repairRoot, `${input.repairPlanId}.json`)) as {
      schemaVersion?: unknown; kind?: unknown; checksum?: unknown; payload?: unknown;
    };
    if (record.schemaVersion !== "workspace-repair-plan-envelope-v1" || record.kind !== "doctor-repair-plan"
      || typeof record.checksum !== "string" || record.checksum !== sha256Json(record.payload)) {
      throw new Error("stored repair plan envelope is invalid");
    }
    const stored = record.payload as StoredRepairPlan;
    if (stored.schemaVersion !== "workspace-repair-plan-v1" || stored.plan.repairPlanId !== input.repairPlanId
      || stored.planHash !== input.planHash || stored.planHash !== sha256Json(stored.plan)
      || !Number.isFinite(Date.parse(stored.preparedAt)) || validateRepairPlan(stored.plan).length) {
      throw new Error("stored repair plan is invalid or changed after preview");
    }
    const backupFile = path.join(this.exportRoot, `${stored.plan.backupId}.buildsim`);
    const doctorRun = await runDoctor({
      coordinator: this.options.coordinator,
      offline: true,
      // Re-evaluate current state against the preview timestamp. This keeps an
      // unchanged report byte-identical while any authority/precondition drift
      // still changes its hashes and fails closed.
      now: () => stored.preparedAt,
    });
    // Backup verification uses a temporary restore and can legitimately move
    // the host free-space measurement. Revalidate the runtime first, then
    // authenticate the already-bound backup before acquiring the repair lease.
    const verifiedBackup = await verifyBackup({ inputFile: backupFile, password: input.password, now: this.options.now });
    const beforeModes = new Map<string, number>();
    const actionRunner = async (): Promise<void> => {
      const state = await this.options.coordinator.readState();
      const activeRoot = this.options.coordinator.activeRoot(state);
      const files = await listRegularFiles(this.options.coordinator.root);
      if (files.some(({ symlink }) => symlink)) throw new Error("repair refuses a runtime containing symbolic links");
      const targets = new Set([
        this.options.coordinator.root,
        this.options.coordinator.controlRoot,
        activeRoot,
        ...files.map(({ absolutePath }) => absolutePath),
        ...files.map(({ absolutePath }) => path.dirname(absolutePath)),
      ]);
      for (const target of [...targets].sort()) {
        const info = await stat(target);
        beforeModes.set(target, info.mode & 0o777);
      }
      for (const target of [...targets].sort()) {
        const info = await stat(target);
        await chmod(target, info.isDirectory() ? 0o700 : 0o600);
      }
    };
    const rollbackRunner = async (): Promise<void> => {
      for (const [target, mode] of [...beforeModes.entries()].reverse()) await chmod(target, mode);
    };
    const result = await executeApprovedRepair({
      plan: { ...stored.plan, approvedAt: (this.options.now ?? (() => new Date().toISOString()))() },
      doctorRun,
      verifiedBackup,
      allowRepair: true,
      coordinator: this.options.coordinator,
      actionRunner,
      rollbackRunner,
      verifyRollback: async () => {
        for (const [target, mode] of beforeModes) if (((await stat(target)).mode & 0o777) !== mode) return false;
        return beforeModes.size > 0;
      },
      idempotencyStore: {
        has: async (key: string) => pathExists(path.join(this.repairIdempotencyRoot, `${sha256Json(key)}.json`)),
        mark: async (key: string) => {
          await ensurePrivateDirectory(this.repairIdempotencyRoot);
          const payload = { schemaVersion: "workspace-repair-idempotency-v1", keyHash: sha256Json(key) };
          await atomicWriteJson(path.join(this.repairIdempotencyRoot, `${payload.keyHash}.json`), {
            schemaVersion: "workspace-repair-idempotency-envelope-v1",
            kind: "doctor-repair-idempotency",
            checksum: sha256Json(payload),
            payload,
          });
        },
      },
    });
    if (result.errors.length) throw new Error(result.errors.join("; "));
    const after = await runDoctor({ coordinator: this.options.coordinator, offline: true, now: this.options.now });
    return {
      schemaVersion: "workspace-repair-result-v1",
      repairPlanId: input.repairPlanId,
      applied: result.applied === true,
      idempotentReplay: result.idempotentReplay === true,
      rolledBack: result.rolledBack === true,
      afterReportHash: after.report.reportHash,
      afterOverall: after.report.overall as DoctorReport["overall"],
    };
  }
}
