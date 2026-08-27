import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AgentSession } from "../agent/contracts";
import type { AgentSessionStore } from "../agent/session-store";
import type { AgentRuntimeWriteFence } from "../agent/session-store";
import { atomicWriteJson, ensurePrivateDirectory, readJson, sha256Json } from "../runtime/fs.mjs";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { validateRuntimeJobSideEffectFence } from "../jobs/runtime-validation.mjs";

const SESSION_ID = /^[A-Za-z0-9._:-]{8,120}$/;

function validSession(value: unknown, sessionId: string): value is AgentSession {
  const session = value as AgentSession | null;
  return Boolean(session && typeof session === "object" && session.id === sessionId && session.contractVersion === "1.0.0"
    && (session.provider === "deepseek" || session.provider === "claude") && typeof session.model === "string"
    && Array.isArray(session.messages) && (session.buildConfig === null || typeof session.buildConfig === "object")
    && typeof session.createdAt === "string" && typeof session.updatedAt === "string");
}

export interface FileAgentSessionStoreOptions {
  /** Explicit roots remain supported for fixtures and isolated deployments. */
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  now?: () => string;
}

export class FileAgentSessionStore implements AgentSessionStore {
  private readonly root: string | undefined;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly now: () => string;

  constructor(rootOrOptions: string | FileAgentSessionStoreOptions = {}) {
    this.now = typeof rootOrOptions === "string" ? () => new Date().toISOString() : rootOrOptions.now ?? (() => new Date().toISOString());
    if (typeof rootOrOptions === "string") this.root = path.resolve(rootOrOptions);
    else {
      this.root = rootOrOptions.root ? path.resolve(rootOrOptions.root) : undefined;
      this.coordinator = rootOrOptions.coordinator ?? (!this.root ? new RuntimeCoordinator({ root: rootOrOptions.runtimeRoot }) : undefined);
    }
  }

  private file(root: string, sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error("invalid Agent session id");
    return path.join(root, `${sessionId}.json`);
  }

  async get(sessionId: string): Promise<AgentSession | null> {
    if (!SESSION_ID.test(sessionId)) throw new Error("invalid Agent session id");
    if (this.root) { await this.validateJournal(this.root); return this.read(this.root, sessionId); }
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    return (await coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => { await this.validateJournal(path.join(activeRoot, "agent")); return this.read(path.join(activeRoot, "agent", "sessions"), sessionId); })).result;
  }

  private async read(root: string, sessionId: string): Promise<AgentSession | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(root, sessionId), "utf8")) as Record<string, unknown>;
      if (raw.schemaVersion === "agent-session-v1" && raw.payload && raw.contentHash === createHash("sha256").update(JSON.stringify(raw.payload)).digest("hex") && validSession(raw.payload, sessionId)) return raw.payload;
      // Explicit fixture roots may still contain pre-envelope sessions; they
      // remain readable and are upgraded on their next write.
      if (this.root && validSession(raw, sessionId)) return raw;
      throw new Error("Agent session integrity check failed");
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  private envelope(session: AgentSession) {
    const payload = { ...session };
    return { schemaVersion: "agent-session-v1", payload, contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
  }

  private async assertJobFence(activeRoot: string, fence: AgentRuntimeWriteFence): Promise<void> {
    const leaseFields = [fence.jobId, fence.expectedRevision, fence.leaseToken].filter((value) => value !== undefined).length;
    if (leaseFields === 0) return;
    if (leaseFields !== 3 || !/^job-[a-f0-9]{64}$/.test(fence.jobId ?? "")) throw new Error("Agent session write fence is incomplete");
    const envelope = await readJson(path.join(activeRoot, "jobs", "records", `${fence.jobId}.json`));
    if (envelope?.schemaVersion !== "job-store-envelope-v1" || envelope.kind !== "background-job"
      || envelope.checksum !== sha256Json(envelope.payload)) throw new Error("Agent session write fenced by corrupt job lease");
    if (validateRuntimeJobSideEffectFence(envelope.payload, fence, this.now()).length > 0) {
      throw new Error("Agent session write fenced by stale job lease");
    }
  }

  private async journal(root: string, sessionId: string, previous: string | null, next: AgentSession, state: "prepared" | "committed", id?: string): Promise<string> {
    const file = path.join(root, "rollback", "sessions-manifest.json");
    let manifest: { schemaVersion: string; entries: Array<Record<string, unknown>>; checksum?: string } = { schemaVersion: "agent-rollback-v1", entries: [] };
    try { manifest = JSON.parse(await readFile(file, "utf8")) as typeof manifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const unsigned = { schemaVersion: manifest.schemaVersion, entries: manifest.entries };
    if (manifest.schemaVersion !== "agent-rollback-v1" || (manifest.checksum && manifest.checksum !== createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"))) throw new Error("Agent session rollback manifest is corrupt");
    const entryId = id ?? `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const entry = { id: entryId, operation: "session-put", target: `${path.basename(root) === "agent" ? "sessions/" : ""}${sessionId}.json`, state, previousBase64: previous ? Buffer.from(previous).toString("base64") : null, previousHash: previous ? createHash("sha256").update(previous).digest("hex") : null, nextHash: createHash("sha256").update(JSON.stringify(this.envelope(next))).digest("hex"), createdAt: new Date().toISOString() };
    const entries = state === "committed" ? manifest.entries.map((item) => item.id === id ? { ...item, state: "committed", committedAt: new Date().toISOString() } : item) : [...manifest.entries, entry];
    const nextUnsigned = { schemaVersion: "agent-rollback-v1", entries };
    await atomicWriteJson(file, { ...nextUnsigned, checksum: createHash("sha256").update(JSON.stringify(nextUnsigned)).digest("hex") });
    return entryId;
  }

  private async validateJournal(root: string): Promise<void> {
    try {
      const file = path.join(root, "rollback", "sessions-manifest.json");
      const manifest = JSON.parse(await readFile(file, "utf8")) as { schemaVersion?: string; entries?: Array<{ state?: string }>; checksum?: string };
      const unsigned = { schemaVersion: manifest.schemaVersion, entries: manifest.entries };
      const incomplete = await Promise.all((manifest.entries ?? []).filter((entry) => entry.state !== "committed").map(async (entry) => {
        if (entry.state !== "prepared" || typeof (entry as { target?: unknown }).target !== "string") return true;
        try { const value = JSON.parse(await readFile(path.join(root, (entry as { target: string }).target), "utf8")); return createHash("sha256").update(JSON.stringify(value)).digest("hex") !== (entry as { nextHash?: string }).nextHash; } catch { return true; }
      }));
      if (manifest.schemaVersion !== "agent-rollback-v1" || !Array.isArray(manifest.entries) || manifest.checksum !== createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") || incomplete.some(Boolean)) throw new Error("Agent session rollback manifest is corrupt or incomplete");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async put(session: AgentSession, fence?: AgentRuntimeWriteFence): Promise<void> {
    if (!SESSION_ID.test(session.id)) throw new Error("invalid Agent session id");
    if (this.root) {
      if (fence) throw new Error("Agent session write fence requires the shared runtime coordinator");
      await ensurePrivateDirectory(this.root);
      const file = this.file(this.root, session.id);
      const previous = await readFile(file, "utf8").catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      const id = await this.journal(this.root, session.id, previous, session, "prepared");
      await atomicWriteJson(file, this.envelope(session));
      await this.journal(this.root, session.id, previous, session, "committed", id);
      return;
    }
    const coordinator = this.coordinator!;
    await coordinator.initialize();
    await coordinator.withWrite(async ({ activeRoot, state }: { activeRoot: string; state: { runtimeGeneration: number } }) => {
      if (fence && state.runtimeGeneration !== fence.runtimeGeneration) throw new Error("Agent session write fenced by runtime generation");
      if (fence) await this.assertJobFence(activeRoot, fence);
      const root = path.join(activeRoot, "agent", "sessions");
      const file = this.file(root, session.id);
      const previous = await readFile(file, "utf8").catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      const journalRoot = path.join(activeRoot, "agent");
      const id = await this.journal(journalRoot, session.id, previous, session, "prepared");
      await atomicWriteJson(file, this.envelope(session));
      await this.journal(journalRoot, session.id, previous, session, "committed", id);
    });
  }
}
