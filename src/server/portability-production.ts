import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createPortablePlanPackage, planPortableImport, type PortableConflictStrategy } from "../portability/runtime";
import type { PortableExportSummary, PortableImportPreview, PortableImportResult } from "../portability/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteFile, confined, ensurePrivateDirectory, sha256Bytes } from "../runtime/fs.mjs";
import type { ProductionWorkspaceOperations } from "./operations-production";

const ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const TOKEN = /^[a-f0-9-]{16,80}$/;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === fields.length && Object.keys(value).every((key) => fields.includes(key));
}
function password(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 12) throw new TypeError("package password must contain at least 12 UTF-8 bytes");
  return value;
}
function strategy(value: unknown): PortableConflictStrategy {
  if (!['reject', 'copy_as_new_plan', 'replace_after_backup'].includes(String(value))) throw new TypeError("portable conflict strategy is invalid");
  return value as PortableConflictStrategy;
}

export class ProductionWorkspacePortability {
  private readonly exportRoot: string;
  private readonly uploadRoot: string;
  private readonly now: () => string;

  constructor(private readonly options: {
    coordinator: RuntimeCoordinator;
    runtimeRoot: string;
    operations: Pick<ProductionWorkspaceOperations, "createFullBackup">;
    now?: () => string;
  }) {
    const root = path.resolve(options.runtimeRoot);
    this.exportRoot = confined(root, "exports", "portable-plans");
    this.uploadRoot = confined(root, "exports", "portable-imports");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async createExport(value: unknown): Promise<PortableExportSummary> {
    const fields = ["planId", "portableProfile", "redacted", "password", "confirmation"] as const;
    if (!exact(value, fields) || typeof value.planId !== "string" || !ID.test(value.planId)
      || !['slim', 'complete'].includes(String(value.portableProfile)) || typeof value.redacted !== "boolean"
      || value.confirmation !== true) throw new TypeError("portable export request fields are invalid");
    const secret = password(value.password); const exportId = randomUUID();
    await ensurePrivateDirectory(this.exportRoot);
    const outputFile = confined(this.exportRoot, `${exportId}.buildsim`);
    const created = await createPortablePlanPackage({
      coordinator: this.options.coordinator,
      outputFile,
      password: secret,
      planId: value.planId,
      portableProfile: value.portableProfile as "slim" | "complete",
      redacted: value.redacted,
      now: this.now,
    });
    return {
      schemaVersion: "portable-export-summary-v1",
      exportId,
      planId: value.planId,
      manifestHash: created.manifest.manifestHash,
      portableProfile: created.manifest.portableProfile,
      resultMode: created.exactReplayReady ? "exact_replay" : "reevaluate_with_current_runtime",
      redacted: value.redacted,
      entryCount: created.manifest.entries.length,
      createdAt: created.manifest.createdAt,
      downloadUrl: `/api/workspace/portability/exports/${encodeURIComponent(exportId)}/download`,
    };
  }

  async download(exportId: string): Promise<{ bytes: Buffer; fileName: string }> {
    if (!TOKEN.test(exportId)) throw new TypeError("portable export ID is invalid");
    return { bytes: await readFile(confined(this.exportRoot, `${exportId}.buildsim`)), fileName: `${exportId}.buildsim` };
  }

  async stageImport(bytes: Buffer, input: { password: string; strategy: PortableConflictStrategy; newPlanId?: string }): Promise<PortableImportPreview> {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES) throw new TypeError("portable upload size is invalid");
    const secret = password(input.password); const chosen = strategy(input.strategy);
    if (input.newPlanId !== undefined && !ID.test(input.newPlanId)) throw new TypeError("portable remap plan ID is invalid");
    await ensurePrivateDirectory(this.uploadRoot);
    const uploadId = sha256Bytes(Buffer.concat([bytes, Buffer.from(randomUUID(), "utf8")])).slice(0, 40);
    const inputFile = confined(this.uploadRoot, `${uploadId}.buildsim`);
    await atomicWriteFile(inputFile, bytes, { mode: 0o600 });
    try {
      const inspected = await planPortableImport({
        coordinator: this.options.coordinator,
        inputFile,
        password: secret,
        mode: "dry_run",
        strategy: chosen,
        ...(input.newPlanId ? { newPlanId: input.newPlanId } : {}),
        ...(chosen === "replace_after_backup" ? { rollbackRef: "backup:pending-before-apply" } : {}),
        now: this.now,
      });
      return {
        schemaVersion: "portable-import-preview-v1",
        uploadId,
        sourcePlanId: inspected.sourcePlanId,
        sourcePlanName: inspected.sourcePlanName,
        sourcePlanHash: inspected.sourcePlanHash,
        manifestHash: inspected.plan.manifestHash,
        portableProfile: inspected.plan.portableProfile,
        exactReplayReady: inspected.plan.resultMode === "exact_replay",
        importPlan: inspected.plan,
      };
    } catch (error) {
      // Keep authenticated uploads only when a valid dry-run can refer to them.
      await rm(inputFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async applyImport(value: unknown): Promise<PortableImportResult> {
    const allowed = ["uploadId", "password", "expectedManifestHash", "strategy", "newPlanId", "confirmation", "backupPassword"] as const;
    if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key as typeof allowed[number]))
      || typeof value.uploadId !== "string" || !TOKEN.test(value.uploadId)
      || typeof value.expectedManifestHash !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedManifestHash)
      || value.confirmation !== true) throw new TypeError("portable apply request fields are invalid");
    const secret = password(value.password); const chosen = strategy(value.strategy);
    const newPlanId = value.newPlanId === undefined ? undefined : String(value.newPlanId);
    if (newPlanId !== undefined && !ID.test(newPlanId)) throw new TypeError("portable remap plan ID is invalid");
    let rollbackRef: string | undefined;
    if (chosen === "replace_after_backup") {
      const backup = await this.options.operations.createFullBackup({ password: password(value.backupPassword), confirmation: true });
      rollbackRef = `backup:${backup.manifestHash}`;
    }
    const applied = await planPortableImport({
      coordinator: this.options.coordinator,
      inputFile: confined(this.uploadRoot, `${value.uploadId}.buildsim`),
      password: secret,
      mode: "apply",
      strategy: chosen,
      ...(newPlanId ? { newPlanId } : {}),
      ...(rollbackRef ? { rollbackRef } : {}),
      expectedManifestHash: value.expectedManifestHash,
      now: this.now,
    });
    if (!applied.state && applied.plan.action !== "no_op_same_hash") throw new Error("portable import did not commit a runtime generation");
    return {
      schemaVersion: "portable-import-result-v1",
      action: applied.plan.action,
      sourcePlanId: applied.sourcePlanId,
      importedPlanId: applied.importedPlanId,
      manifestHash: applied.plan.manifestHash,
      resultMode: applied.plan.resultMode,
      runtimeGeneration: applied.state?.runtimeGeneration ?? (await this.options.coordinator.readState()).runtimeGeneration,
      ...(rollbackRef ? { rollbackRef } : {}),
    };
  }
}
