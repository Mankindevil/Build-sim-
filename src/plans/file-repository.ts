import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, deepReadonly, sha256Hex } from "./canonical";
import { assertExpectedConfigHash, assertExpectedRevision, PlanConflictError } from "./conflict";
import {
  PLAN_SCHEMA_VERSION,
  type BuildPlan,
  type BuildPlanSummary,
  type CreatePlanInput,
  type DuplicatePlanInput,
  type PlanRepository,
  type PlanVersion,
  type SaveVersionInput,
  type UpdateDraftInput,
  type UpdatePlanInfoInput,
} from "./contracts";
import { PlanRepositoryError } from "./errors";
import { assertValidBuildPlan, assertValidPlanVersion } from "./validation";
import { createImmutablePlanVersion } from "./version";

const STORED_SCHEMA_VERSION = "1.0.0" as const;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;

interface StoredEnvelope<T> {
  schemaVersion: typeof STORED_SCHEMA_VERSION;
  kind: "plan" | "version" | "idempotency";
  checksum: string;
  payload: T;
}

interface IdempotencyRecord {
  operation: string;
  requestHash: string;
  result: { planId?: string; versionId?: string; value?: unknown };
}

export interface FilePlanRepositoryOptions {
  root?: string;
  now?: () => string;
  id?: (prefix: "plan" | "version") => string;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FilePlanRepository implements PlanRepository {
  private readonly root: string;
  private readonly now: () => string;
  private readonly id: (prefix: "plan" | "version") => string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: FilePlanRepositoryOptions = {}) {
    this.root = path.resolve(options.root ?? "runtime/plans");
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  private assertId(id: string): void {
    if (!SAFE_ID.test(id)) throw new PlanRepositoryError("invalid_id", "Invalid plan storage id", 400);
  }

  private planDirectory(planId: string): string {
    this.assertId(planId);
    return path.join(this.root, planId);
  }

  private planFile(planId: string): string {
    return path.join(this.planDirectory(planId), "plan.json");
  }

  private versionFile(planId: string, versionId: string): string {
    this.assertId(versionId);
    return path.join(this.planDirectory(planId), "versions", `${versionId}.json`);
  }

  private idempotencyFile(scope: string, key: string): string {
    const digest = createHash("sha256").update(`${scope}\0${key}`).digest("hex");
    return path.join(this.root, ".idempotency", `${digest}.json`);
  }

  private async atomicWrite<T>(file: string, kind: StoredEnvelope<T>["kind"], payload: T): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const envelope: StoredEnvelope<T> = { schemaVersion: STORED_SCHEMA_VERSION, kind, checksum: checksum(payload), payload };
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  }

  private async readEnvelope<T>(file: string, kind: StoredEnvelope<T>["kind"]): Promise<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PlanRepositoryError("not_found", "Plan data was not found", 404);
      throw new PlanRepositoryError("corrupt_data", `Cannot read plan data: ${error instanceof Error ? error.message : "unknown error"}`, 500);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PlanRepositoryError("corrupt_data", "Plan data envelope is invalid", 500);
    const envelope = parsed as Partial<StoredEnvelope<T>>;
    if (envelope.schemaVersion !== STORED_SCHEMA_VERSION || envelope.kind !== kind || !("payload" in envelope) || envelope.checksum !== checksum(envelope.payload)) {
      throw new PlanRepositoryError("corrupt_data", "Plan data integrity check failed", 500);
    }
    return envelope.payload as T;
  }

  private async readPlan(planId: string): Promise<BuildPlan> {
    const plan = await this.readEnvelope<BuildPlan>(this.planFile(planId), "plan");
    try {
      assertValidBuildPlan(plan);
    } catch (error) {
      throw new PlanRepositoryError("corrupt_data", error instanceof Error ? error.message : "Invalid plan data", 500);
    }
    return plan;
  }

  private async readVersion(planId: string, versionId: string): Promise<PlanVersion> {
    const version = await this.readEnvelope<PlanVersion>(this.versionFile(planId, versionId), "version");
    try {
      assertValidPlanVersion(version);
      if (version.configHash !== await sha256Hex(version.config)) throw new Error("PlanVersion config hash mismatch");
    } catch (error) {
      throw new PlanRepositoryError("corrupt_data", error instanceof Error ? error.message : "Invalid version data", 500);
    }
    return deepReadonly(version) as PlanVersion;
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }

  private async idempotent<T>(
    scope: string,
    key: string | undefined,
    request: unknown,
    readResult: (record: IdempotencyRecord) => Promise<T>,
    operation: () => Promise<{ value: T; result: IdempotencyRecord["result"] }>,
  ): Promise<T> {
    if (!key) return (await operation()).value;
    if (key.length > 200) throw new PlanRepositoryError("invalid_input", "Idempotency key is too long", 400);
    const file = this.idempotencyFile(scope, key);
    const requestHash = checksum(request);
    try {
      const stored = await this.readEnvelope<IdempotencyRecord>(file, "idempotency");
      if (stored.operation !== scope || stored.requestHash !== requestHash) throw new PlanRepositoryError("idempotency_conflict", "Idempotency key was reused for another request", 409);
      return readResult(stored);
    } catch (error) {
      if (!(error instanceof PlanRepositoryError) || error.code !== "not_found") throw error;
    }
    const completed = await operation();
    await this.atomicWrite(file, "idempotency", { operation: scope, requestHash, result: completed.result });
    return completed.value;
  }

  async list(): Promise<BuildPlanSummary[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const plans: BuildPlanSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const plan = await this.readPlan(entry.name);
      plans.push({
        schemaVersion: PLAN_SCHEMA_VERSION,
        id: plan.id,
        name: plan.name,
        status: plan.status,
        updatedAt: plan.updatedAt,
        activeVersionId: plan.activeVersionId,
        draftRevision: plan.draftRevision,
        dirty: plan.draft.dirty,
      });
    }
    return plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  async get(planId: string): Promise<BuildPlan> {
    return clone(await this.readPlan(planId));
  }

  async create(input: CreatePlanInput): Promise<BuildPlan> {
    if (!input.name.trim()) throw new PlanRepositoryError("invalid_input", "Plan name is required", 400);
    return this.serialize("create", () => this.idempotent(
      "create",
      input.idempotencyKey,
      input,
      async (record) => clone(record.result.value as BuildPlan),
      async () => {
        const planId = this.id("plan");
        this.assertId(planId);
        const timestamp = this.now();
        const config = clone(input.config);
        config.id = planId;
        config.name = input.name.trim();
        config.updatedAt = timestamp;
        const plan: BuildPlan = {
          schemaVersion: PLAN_SCHEMA_VERSION,
          id: planId,
          name: input.name.trim(),
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          activeVersionId: null,
          draftRevision: 0,
          draft: { schemaVersion: PLAN_SCHEMA_VERSION, baseVersionId: null, config, dirty: true, updatedAt: timestamp },
          metadata: clone(input.metadata ?? {}),
        };
        assertValidBuildPlan(plan);
        await this.atomicWrite(this.planFile(planId), "plan", plan);
        return { value: clone(plan), result: { planId, value: clone(plan) } };
      },
    ));
  }

  async updateDraft(planId: string, input: UpdateDraftInput): Promise<BuildPlan> {
    return this.serialize(planId, () => this.idempotent(
      `updateDraft:${planId}`,
      input.idempotencyKey,
      input,
      async (record) => clone(record.result.value as BuildPlan),
      async () => {
        const plan = await this.readPlan(planId);
        if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
        assertExpectedRevision(input.expectedRevision, plan.draftRevision);
        const timestamp = this.now();
        const config = clone(input.config);
        config.id = planId;
        config.name = plan.name;
        config.updatedAt = timestamp;
        const updated: BuildPlan = {
          ...plan,
          updatedAt: timestamp,
          draftRevision: plan.draftRevision + 1,
          draft: { ...plan.draft, config, dirty: true, updatedAt: timestamp },
        };
        assertValidBuildPlan(updated);
        await this.atomicWrite(this.planFile(planId), "plan", updated);
        return { value: clone(updated), result: { planId, value: clone(updated) } };
      },
    ));
  }

  async updateInfo(planId: string, input: UpdatePlanInfoInput): Promise<BuildPlan> {
    return this.serialize(planId, async () => {
      const plan = await this.readPlan(planId);
      if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
      assertExpectedRevision(input.expectedRevision, plan.draftRevision);
      const name = input.name.trim();
      if (!name || name.length > 120) throw new PlanRepositoryError("invalid_input", "Plan name must contain 1 to 120 characters", 400);
      const timestamp = this.now();
      const config = clone(plan.draft.config);
      config.name = name;
      config.updatedAt = timestamp;
      const updated: BuildPlan = {
        ...plan,
        name,
        ...(input.metadata ? { metadata: clone(input.metadata) } : {}),
        updatedAt: timestamp,
        draftRevision: plan.draftRevision + 1,
        draft: { ...plan.draft, config, dirty: true, updatedAt: timestamp },
      };
      if (input.description !== undefined) {
        if (input.description.trim()) updated.description = input.description.trim();
        else delete updated.description;
      }
      assertValidBuildPlan(updated);
      await this.atomicWrite(this.planFile(planId), "plan", updated);
      return clone(updated);
    });
  }

  async saveVersion(planId: string, input: SaveVersionInput): Promise<PlanVersion> {
    return this.serialize(planId, () => this.idempotent(
      `saveVersion:${planId}`,
      input.idempotencyKey,
      input,
      async (record) => deepReadonly(clone(record.result.value as PlanVersion)) as PlanVersion,
      async () => {
        const plan = await this.readPlan(planId);
        if (plan.status !== "active") throw new PlanRepositoryError("invalid_input", "Archived plans are read-only", 409);
        assertExpectedRevision(input.expectedRevision, plan.draftRevision);
        const actualHash = await sha256Hex(plan.draft.config);
        assertExpectedConfigHash(input.expectedConfigHash, actualHash);
        const versions = await this.listVersions(planId);
        const versionId = this.id("version");
        const version = await createImmutablePlanVersion({
          id: versionId,
          planId,
          versionNumber: versions.length + 1,
          createdAt: this.now(),
          reason: input.reason,
          ...(input.summary ? { summary: input.summary } : {}),
          config: plan.draft.config,
          parentVersionId: plan.activeVersionId,
        });
        await this.atomicWrite(this.versionFile(planId, versionId), "version", version);
        const updated: BuildPlan = {
          ...plan,
          activeVersionId: versionId,
          updatedAt: version.createdAt,
          draft: { ...plan.draft, baseVersionId: versionId, dirty: false, updatedAt: version.createdAt },
        };
        await this.atomicWrite(this.planFile(planId), "plan", updated);
        return { value: version, result: { planId, versionId, value: clone(version) } };
      },
    ));
  }

  async duplicate(planId: string, input: DuplicatePlanInput): Promise<BuildPlan> {
    if (!input.name.trim()) throw new PlanRepositoryError("invalid_input", "Plan name is required", 400);
    return this.serialize(`duplicate:${planId}`, () => this.idempotent(
      `duplicate:${planId}`,
      input.idempotencyKey,
      input,
      async (record) => clone(record.result.value as BuildPlan),
      async () => {
        const source = await this.readPlan(planId);
        const created = await this.create({ name: input.name, config: source.draft.config, metadata: clone(source.metadata) });
        const hash = await sha256Hex(created.draft.config);
        await this.saveVersion(created.id, { expectedRevision: created.draftRevision, expectedConfigHash: hash, reason: "initial" });
        const saved = await this.get(created.id);
        return { value: saved, result: { planId: saved.id, value: clone(saved) } };
      },
    ));
  }

  async archive(planId: string): Promise<void> {
    await this.serialize(planId, async () => {
      const plan = await this.readPlan(planId);
      if (plan.status === "archived") return;
      await this.atomicWrite(this.planFile(planId), "plan", { ...plan, status: "archived", updatedAt: this.now() });
    });
  }

  async restore(planId: string): Promise<void> {
    await this.serialize(planId, async () => {
      const plan = await this.readPlan(planId);
      if (plan.status === "active") return;
      await this.atomicWrite(this.planFile(planId), "plan", { ...plan, status: "active", updatedAt: this.now() });
    });
  }

  async delete(planId: string): Promise<void> {
    await this.serialize(planId, async () => {
      await this.readPlan(planId);
      const target = path.join(this.root, ".trash", `${planId}-${this.now().replace(/[^0-9]/g, "")}`);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(this.planDirectory(planId), target);
    });
  }

  async listVersions(planId: string): Promise<PlanVersion[]> {
    await this.readPlan(planId);
    const directory = path.join(this.planDirectory(planId), "versions");
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const versions = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => this.readVersion(planId, file.slice(0, -5))));
    return versions.sort((left, right) => left.versionNumber - right.versionNumber);
  }
}

export function repositoryErrorResponse(error: unknown): { status: number; payload: { error: string; message: string } } {
  if (error instanceof PlanConflictError) return { status: error.status, payload: { error: error.code, message: error.message } };
  if (error instanceof PlanRepositoryError) return { status: error.status, payload: { error: error.code, message: error.message } };
  return { status: 500, payload: { error: "internal_error", message: error instanceof Error ? error.message : "Workspace request failed" } };
}
