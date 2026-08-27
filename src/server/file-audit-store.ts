import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentRunAuditRecord } from "../agent/contracts";
import { agentAuditHash, type AgentRunAuditStore } from "../agent/audit";
import type { AgentRuntimeWriteFence } from "../agent/session-store";
import { atomicWriteJson, ensurePrivateDirectory, readJson, sha256Json } from "../runtime/fs.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { validateRuntimeJobSideEffectFence } from "../jobs/runtime-validation.mjs";

const RUN_ID = /^[A-Za-z0-9._:-]{8,120}$/;

export interface FileAgentRunAuditStoreOptions {
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  now?: () => string;
}

export class FileAgentRunAuditStore implements AgentRunAuditStore {
  private readonly root: string | undefined;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly now: () => string;

  constructor(rootOrOptions: string | FileAgentRunAuditStoreOptions = {}) {
    this.now = typeof rootOrOptions === "string" ? () => new Date().toISOString() : rootOrOptions.now ?? (() => new Date().toISOString());
    if (typeof rootOrOptions === "string") this.root = path.resolve(rootOrOptions);
    else {
      this.root = rootOrOptions.root ? path.resolve(rootOrOptions.root) : undefined;
      this.coordinator = rootOrOptions.coordinator ?? (!this.root ? new RuntimeCoordinator({ root: rootOrOptions.runtimeRoot }) : undefined);
    }
  }

  private file(root: string, runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error("invalid Agent run id");
    return path.join(root, `${runId}.json`);
  }

  private async read(root: string, runId: string): Promise<AgentRunAuditRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.file(root, runId), "utf8")) as AgentRunAuditRecord;
      const { recordHash, ...unsigned } = record;
      if (recordHash !== agentAuditHash(unsigned)) throw new Error("Agent audit integrity check failed");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async appendRollback(root: string, runId: string, previous: string | null, next: AgentRunAuditRecord, state: "prepared" | "committed", id?: string): Promise<string> {
    const file = path.join(root, "rollback", "audit-manifest.json");
    let manifest: { schemaVersion: string; entries: Array<Record<string, unknown>>; checksum?: string } = { schemaVersion: "agent-rollback-v1", entries: [] };
    try { manifest = JSON.parse(await readFile(file, "utf8")) as typeof manifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const unsigned = { schemaVersion: manifest.schemaVersion, entries: manifest.entries };
    if (manifest.schemaVersion !== "agent-rollback-v1" || (manifest.checksum && manifest.checksum !== createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"))) throw new Error("Agent audit rollback manifest is corrupt");
    const entryId = id ?? `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
    const entry = { id: entryId, operation: "audit-put", runId, target: `${path.basename(root) === "agent" ? "audit/" : ""}${runId}.json`, state, previousBase64: previous ? Buffer.from(previous).toString("base64") : null, previousHash: previous ? hash(previous) : null, nextHash: hash(next), createdAt: new Date().toISOString() };
    const entries = state === "committed" ? manifest.entries.map((item) => item.id === id ? { ...item, state: "committed", committedAt: new Date().toISOString() } : item) : [...manifest.entries, entry];
    const nextUnsigned = { schemaVersion: "agent-rollback-v1", entries };
    await atomicWriteJson(file, { ...nextUnsigned, checksum: createHash("sha256").update(JSON.stringify(nextUnsigned)).digest("hex") });
    return entryId;
  }

  private async validateJournal(root: string): Promise<void> {
    try {
      const file = path.join(root, "rollback", "audit-manifest.json");
      const manifest = JSON.parse(await readFile(file, "utf8")) as { schemaVersion?: string; entries?: Array<{ state?: string }>; checksum?: string };
      const unsigned = { schemaVersion: manifest.schemaVersion, entries: manifest.entries };
      const incomplete = await Promise.all((manifest.entries ?? []).filter((entry) => entry.state !== "committed").map(async (entry) => {
        if (entry.state !== "prepared" || typeof (entry as { target?: unknown }).target !== "string") return true;
        try { const value = JSON.parse(await readFile(path.join(root, (entry as { target: string }).target), "utf8")); return createHash("sha256").update(JSON.stringify(value)).digest("hex") !== (entry as { nextHash?: string }).nextHash; } catch { return true; }
      }));
      if (manifest.schemaVersion !== "agent-rollback-v1" || !Array.isArray(manifest.entries) || manifest.checksum !== createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") || incomplete.some(Boolean)) throw new Error("Agent audit rollback manifest is corrupt or incomplete");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async assertJobFence(activeRoot: string, fence: AgentRuntimeWriteFence): Promise<void> {
    const leaseFields = [fence.jobId, fence.expectedRevision, fence.leaseToken].filter((value) => value !== undefined).length;
    if (leaseFields === 0) return;
    if (leaseFields !== 3 || !/^job-[a-f0-9]{64}$/.test(fence.jobId ?? "")) throw new Error("Agent audit write fence is incomplete");
    const envelope = await readJson(path.join(activeRoot, "jobs", "records", `${fence.jobId}.json`));
    if (envelope?.schemaVersion !== "job-store-envelope-v1" || envelope.kind !== "background-job"
      || envelope.checksum !== sha256Json(envelope.payload)) throw new Error("Agent audit write fenced by corrupt job lease");
    if (validateRuntimeJobSideEffectFence(envelope.payload, fence, this.now()).length > 0) {
      throw new Error("Agent audit write fenced by stale job lease");
    }
  }

  async get(runId: string): Promise<AgentRunAuditRecord | null> {
    if (!RUN_ID.test(runId)) throw new Error("invalid Agent run id");
    if (this.root) { await this.validateJournal(this.root); return this.read(this.root, runId); }
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    return (await coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => { await this.validateJournal(path.join(activeRoot, "agent")); return this.read(path.join(activeRoot, "agent", "audit"), runId); })).result;
  }

  async put(record: AgentRunAuditRecord, fence?: AgentRuntimeWriteFence): Promise<void> {
    if (!RUN_ID.test(record.runId)) throw new Error("invalid Agent run id");
    const { recordHash, ...unsigned } = record;
    if (recordHash !== agentAuditHash(unsigned)) throw new Error("Agent audit record is not sealed");
    if (this.root) {
      if (fence) throw new Error("Agent audit write fence requires the shared runtime coordinator");
      await ensurePrivateDirectory(this.root);
      const file = this.file(this.root, record.runId);
      const previous = await readFile(file, "utf8").catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      const id = await this.appendRollback(this.root, record.runId, previous, record, "prepared");
      await atomicWriteJson(file, record);
      await this.appendRollback(this.root, record.runId, previous, record, "committed", id);
      return;
    }
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    await coordinator.withWrite(async ({ activeRoot, state }: { activeRoot: string; state: { runtimeGeneration: number } }) => {
      if (fence && state.runtimeGeneration !== fence.runtimeGeneration) throw new Error("Agent audit write fenced by runtime generation");
      if (fence) await this.assertJobFence(activeRoot, fence);
      const root = path.join(activeRoot, "agent", "audit");
      const file = this.file(root, record.runId);
      const previous = await readFile(file, "utf8").catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      const journalRoot = path.join(activeRoot, "agent");
      const id = await this.appendRollback(journalRoot, record.runId, previous, record, "prepared");
      await atomicWriteJson(file, record);
      await this.appendRollback(journalRoot, record.runId, previous, record, "committed", id);
    });
  }
}
