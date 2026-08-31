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

export interface WorkspaceRepairInspection {
  readonly schemaVersion: "workspace-repair-inspection-v1";
  readonly reportHash: string;
  readonly runtimeGeneration: number;
  readonly actionIds: readonly ["restrict-runtime-permissions"];
  readonly impactSummary: string;
  readonly inspectionStatus: "ready" | "blocked_unreadable";
  readonly targetFileCount: number | null;
  readonly targetDirectoryCount: number | null;
  readonly affectedFileCount: number | null;
  readonly affectedDirectoryCount: number | null;
  readonly currentFileModes: ReadonlyArray<{ readonly mode: string; readonly count: number }>;
  readonly currentDirectoryModes: ReadonlyArray<{ readonly mode: string; readonly count: number }>;
  readonly writesPerformed: false;
  readonly requiresVerifiedBackup: true;
  readonly requiresExplicitPreparationConfirmation: true;
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

function exactRepairInspectionInput(value: unknown): { actionIds: [typeof PERMISSION_ACTION] } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) {
    throw new TypeError("repair inspection request fields are invalid");
  }
  const input = value as { actionIds?: unknown };
  if (!Array.isArray(input.actionIds) || input.actionIds.length !== 1 || input.actionIds[0] !== PERMISSION_ACTION) {
    throw new TypeError("repair inspection requires one supported action");
  }
  return { actionIds: [PERMISSION_ACTION] };
}

function summarizeModes(modes: readonly number[]): Array<{ mode: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of modes) {
    const mode = (value & 0o777).toString(8).padStart(4, "0");
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([mode, count]) => ({ mode, count }));
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
    // The production reference graph includes its creation timestamp. Freeze
    // one timestamp across graph persistence, backup creation and verification
    // so an ordinary wall-clock tick cannot make the caller graph stale.
    const createdAt = (this.options.now ?? (() => new Date().toISOString()))();
    const now = () => createdAt;
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

  /**
   * Read-only impact inspection. It deliberately creates neither a backup nor
   * a repair plan, and returns only aggregate mode counts instead of paths.
   */
  async inspectRepair(value: unknown): Promise<WorkspaceRepairInspection> {
    exactRepairInspectionInput(value);
    const doctorRun = await runDoctor({ coordinator: this.options.coordinator, offline: true, now: this.options.now });
    const permission = doctorRun.report.checks.find(({ checkId }) => checkId === "runtime.permissions");
    if (!permission || permission.status !== "fail" || permission.repairable !== true) {
      throw new Error("the requested repair is not applicable to the current Doctor report");
    }
    const base = {
      schemaVersion: "workspace-repair-inspection-v1" as const,
      reportHash: doctorRun.report.reportHash,
      runtimeGeneration: doctorRun.report.runtimeGeneration,
      actionIds: [PERMISSION_ACTION] as const,
      impactSummary: PERMISSION_IMPACT,
      writesPerformed: false as const,
      requiresVerifiedBackup: true as const,
      requiresExplicitPreparationConfirmation: true as const,
      requiresSecondConfirmation: true as const,
    };
    try {
      const snapshot = await this.options.coordinator.withReadOnlySnapshot(async ({ state, activeRoot }: {
        state: { runtimeGeneration: number };
        activeRoot: string;
      }) => {
        if (state.runtimeGeneration !== doctorRun.report.runtimeGeneration) {
          throw new Error("runtime generation changed during repair inspection");
        }
        const files = await listRegularFiles(this.options.coordinator.root);
        if (files.some(({ symlink }) => symlink)) throw new Error("runtime contains symbolic links");
        const fileTargets = [...new Set(files.map(({ absolutePath }) => absolutePath))].sort();
        const directoryTargets = [...new Set([
          this.options.coordinator.root,
          this.options.coordinator.controlRoot,
          activeRoot,
          ...fileTargets.map((file) => path.dirname(file)),
        ])].sort();
        const fileModes = await Promise.all(fileTargets.map(async (file) => (await stat(file)).mode & 0o777));
        const directoryModes = await Promise.all(directoryTargets.map(async (directory) => (await stat(directory)).mode & 0o777));
        return { fileModes, directoryModes };
      });
      return {
        ...base,
        inspectionStatus: "ready",
        targetFileCount: snapshot.result.fileModes.length,
        targetDirectoryCount: snapshot.result.directoryModes.length,
        affectedFileCount: snapshot.result.fileModes.filter((mode: number) => mode !== 0o600).length,
        affectedDirectoryCount: snapshot.result.directoryModes.filter((mode: number) => mode !== 0o700).length,
        currentFileModes: summarizeModes(snapshot.result.fileModes),
        currentDirectoryModes: summarizeModes(snapshot.result.directoryModes),
      };
    } catch {
      return {
        ...base,
        inspectionStatus: "blocked_unreadable",
        targetFileCount: null,
        targetDirectoryCount: null,
        affectedFileCount: null,
        affectedDirectoryCount: null,
        currentFileModes: [],
        currentDirectoryModes: [],
      };
    }
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
