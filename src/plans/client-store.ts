import type { BuildConfig } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import { sha256Hex } from "./canonical";
import type { BuildPlan, BuildPlanSummary, PlanSaveStatus, PlanVersion, PlanVersionReason } from "./contracts";
import type { WorkspacePlanApi } from "./client";
import { WorkspaceApiError } from "./client";
import { migrateLegacyProgress, type KeyValueStorage } from "./migration";

export const ACTIVE_PLAN_KEY = "build-sim.workspace.active-plan.v1";
const CACHE_PREFIX = "build-sim.workspace.plan-cache.v1:";
type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface PlanSelection {
  partId: string;
  view: string;
  findingId?: string;
}

export interface PlanStoreState {
  initialized: boolean;
  plans: BuildPlanSummary[];
  activePlan: BuildPlan | null;
  evaluation: BuildEvaluation | null;
  saveStatus: PlanSaveStatus;
  selection: PlanSelection | null;
  offline: boolean;
  localRevision: number;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface PlanStoreOptions {
  api: WorkspacePlanApi;
  storage: KeyValueStorage;
  debounceMs?: number;
  setTimer?: (handler: () => void, timeout: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

interface History {
  undo: BuildConfig[];
  redo: BuildConfig[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function summary(plan: BuildPlan): BuildPlanSummary {
  return {
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    name: plan.name,
    status: plan.status,
    updatedAt: plan.updatedAt,
    activeVersionId: plan.activeVersionId,
    draftRevision: plan.draftRevision,
    dirty: plan.draft.dirty,
  };
}

export class PlanStore {
  private state: PlanStoreState = {
    initialized: false,
    plans: [],
    activePlan: null,
    evaluation: null,
    saveStatus: "clean",
    selection: null,
    offline: false,
    localRevision: 0,
    error: null,
    canUndo: false,
    canRedo: false,
  };
  private readonly listeners = new Set<(state: PlanStoreState) => void>();
  private readonly histories = new Map<string, History>();
  private timer: TimerHandle | null = null;
  private saveInFlight: Promise<BuildPlan | null> | null = null;
  private changeToken = 0;

  constructor(private readonly options: PlanStoreOptions) {}

  getState(): PlanStoreState {
    return clone(this.state);
  }

  getActiveConfig(): BuildConfig | null {
    return this.state.activePlan ? clone(this.state.activePlan.draft.config) : null;
  }

  subscribe(listener: (state: PlanStoreState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const history = this.state.activePlan ? this.histories.get(this.state.activePlan.id) : undefined;
    this.state.canUndo = Boolean(history?.undo.length);
    this.state.canRedo = Boolean(history?.redo.length);
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private cache(plan: BuildPlan): void {
    try {
      this.options.storage.setItem(`${CACHE_PREFIX}${plan.id}`, JSON.stringify(plan));
      this.options.storage.setItem(ACTIVE_PLAN_KEY, plan.id);
    } catch {
      // Cache is best effort and never changes the authoritative save status.
    }
  }

  private cached(planId: string): BuildPlan | null {
    try {
      const raw = this.options.storage.getItem(`${CACHE_PREFIX}${planId}`);
      return raw ? JSON.parse(raw) as BuildPlan : null;
    } catch {
      return null;
    }
  }

  private replaceSummary(plan: BuildPlan): void {
    const next = this.state.plans.filter((item) => item.id !== plan.id);
    next.push(summary(plan));
    this.state.plans = next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async initialize(): Promise<void> {
    migrateLegacyProgress(this.options.storage);
    const preferredId = this.options.storage.getItem(ACTIVE_PLAN_KEY);
    try {
      this.state.plans = await this.options.api.list();
      const selected = (preferredId && this.state.plans.some((plan) => plan.id === preferredId) ? preferredId : this.state.plans.find((plan) => plan.status === "active")?.id) ?? this.state.plans[0]?.id;
      this.state.activePlan = selected ? await this.options.api.get(selected) : null;
      if (this.state.activePlan) this.cache(this.state.activePlan);
      this.state.saveStatus = this.state.activePlan?.draft.dirty ? "saved" : "clean";
      this.state.offline = false;
      this.state.error = null;
    } catch (error) {
      const cached = preferredId ? this.cached(preferredId) : null;
      this.state.activePlan = cached;
      this.state.plans = cached ? [summary(cached)] : [];
      this.state.saveStatus = "offline";
      this.state.offline = true;
      this.state.error = error instanceof Error ? error.message : "Workspace service unavailable";
    }
    this.state.initialized = true;
    this.emit();
  }

  async activate(planId: string, force = false): Promise<void> {
    if (this.state.activePlan?.id === planId) return;
    if (!force && this.shouldWarnBeforeUnload()) throw new Error("active_plan_has_unsaved_changes");
    this.cancelAutosave();
    try {
      const plan = await this.options.api.get(planId);
      this.state.activePlan = plan;
      this.state.saveStatus = plan.draft.dirty ? "saved" : "clean";
      this.state.offline = false;
      this.state.error = null;
      this.state.localRevision = 0;
      this.cache(plan);
      this.emit();
    } catch (error) {
      const cached = this.cached(planId);
      if (!cached) throw error;
      this.state.activePlan = cached;
      this.state.saveStatus = "offline";
      this.state.offline = true;
      this.state.error = error instanceof Error ? error.message : "Workspace service unavailable";
      this.emit();
    }
  }

  private history(planId: string): History {
    const existing = this.histories.get(planId);
    if (existing) return existing;
    const created: History = { undo: [], redo: [] };
    this.histories.set(planId, created);
    return created;
  }

  replaceDraft(config: BuildConfig, recordHistory = true): void {
    const plan = this.state.activePlan;
    if (!plan || plan.status !== "active") return;
    const history = this.history(plan.id);
    if (recordHistory) {
      history.undo.push(clone(plan.draft.config));
      if (history.undo.length > 100) history.undo.shift();
      history.redo = [];
    }
    const next = clone(config);
    next.id = plan.id;
    next.name = plan.name;
    plan.draft.config = next;
    plan.draft.dirty = true;
    plan.draft.updatedAt = new Date().toISOString();
    this.state.localRevision += 1;
    this.state.saveStatus = this.state.offline ? "offline" : "dirty";
    this.state.error = null;
    this.changeToken += 1;
    this.cache(plan);
    this.scheduleAutosave();
    this.emit();
  }

  patchDraft(mutator: (config: BuildConfig) => void): void {
    const config = this.state.activePlan ? clone(this.state.activePlan.draft.config) : null;
    if (!config) return;
    mutator(config);
    this.replaceDraft(config);
  }

  undo(): void {
    const plan = this.state.activePlan;
    if (!plan) return;
    const history = this.history(plan.id);
    const previous = history.undo.pop();
    if (!previous) return;
    history.redo.push(clone(plan.draft.config));
    this.replaceDraft(previous, false);
  }

  redo(): void {
    const plan = this.state.activePlan;
    if (!plan) return;
    const history = this.history(plan.id);
    const next = history.redo.pop();
    if (!next) return;
    history.undo.push(clone(plan.draft.config));
    this.replaceDraft(next, false);
  }

  private scheduleAutosave(): void {
    this.cancelAutosave();
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => { void this.saveDraftNow(); }, this.options.debounceMs ?? 600);
  }

  private cancelAutosave(): void {
    if (this.timer === null) return;
    if (this.options.clearTimer) this.options.clearTimer(this.timer);
    else clearTimeout(this.timer);
    this.timer = null;
  }

  async saveDraftNow(): Promise<BuildPlan | null> {
    if (this.saveInFlight) return this.saveInFlight;
    const plan = this.state.activePlan;
    if (!plan || this.state.saveStatus === "clean" || this.state.saveStatus === "saved") return plan;
    this.cancelAutosave();
    const planId = plan.id;
    const expectedRevision = plan.draftRevision;
    const config = clone(plan.draft.config);
    const token = this.changeToken;
    this.state.saveStatus = "saving";
    this.emit();
    this.saveInFlight = this.options.api.updateDraft(planId, {
      expectedRevision,
      config,
      idempotencyKey: `draft-${planId}-${expectedRevision}-${token}`,
    }).then((saved) => {
      if (this.state.activePlan?.id !== planId) return saved;
      if (this.changeToken === token) {
        this.state.activePlan = saved;
        this.state.saveStatus = "saved";
      } else {
        saved.draft.config = clone(this.state.activePlan.draft.config);
        saved.draft.dirty = true;
        this.state.activePlan = saved;
        this.state.saveStatus = "dirty";
        this.scheduleAutosave();
      }
      this.state.offline = false;
      this.state.error = null;
      this.replaceSummary(saved);
      this.cache(this.state.activePlan);
      this.emit();
      return saved;
    }).catch((error) => {
      if (this.state.activePlan?.id === planId) {
        this.state.saveStatus = error instanceof WorkspaceApiError && (error.code === "stale_revision" || error.code === "stale_config_hash") ? "conflict" : globalThis.navigator?.onLine === false ? "offline" : "failed";
        this.state.offline = this.state.saveStatus === "offline";
        this.state.error = error instanceof Error ? error.message : "Draft save failed";
        this.cache(this.state.activePlan);
        this.emit();
      }
      return null;
    }).finally(() => { this.saveInFlight = null; });
    return this.saveInFlight;
  }

  async saveVersion(reason: PlanVersionReason = "manual-save"): Promise<PlanVersion> {
    await this.saveDraftNow();
    const plan = this.state.activePlan;
    if (!plan || this.state.saveStatus === "failed" || this.state.saveStatus === "conflict" || this.state.saveStatus === "offline") throw new Error("Draft must be persisted before saving a version");
    const version = await this.options.api.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision,
      expectedConfigHash: await sha256Hex(plan.draft.config),
      reason,
      idempotencyKey: `version-${plan.id}-${plan.draftRevision}-${await sha256Hex(plan.draft.config)}`,
    });
    plan.activeVersionId = version.id;
    plan.draft.baseVersionId = version.id;
    plan.draft.dirty = false;
    this.state.saveStatus = "clean";
    this.replaceSummary(plan);
    this.cache(plan);
    this.emit();
    return version;
  }

  async create(name: string, config: BuildConfig): Promise<BuildPlan> {
    const plan = await this.options.api.create({ name, config, idempotencyKey: `create-${crypto.randomUUID()}` });
    this.state.plans.push(summary(plan));
    await this.activate(plan.id, true);
    return plan;
  }

  async duplicate(name: string): Promise<BuildPlan> {
    const source = this.state.activePlan;
    if (!source) throw new Error("No active plan");
    const copy = await this.options.api.duplicate(source.id, { name, idempotencyKey: `duplicate-${crypto.randomUUID()}` });
    this.state.plans.push(summary(copy));
    await this.activate(copy.id, true);
    return copy;
  }

  async archiveActive(): Promise<void> {
    const plan = this.state.activePlan;
    if (!plan) return;
    await this.options.api.archive(plan.id);
    plan.status = "archived";
    this.replaceSummary(plan);
    this.emit();
  }

  setEvaluation(evaluation: BuildEvaluation | null): void {
    this.state.evaluation = evaluation;
    this.emit();
  }

  setSelection(selection: PlanSelection | null): void {
    this.state.selection = selection;
    this.emit();
  }

  shouldWarnBeforeUnload(): boolean {
    return Boolean(this.state.activePlan?.draft.dirty || ["dirty", "saving", "failed", "conflict", "offline"].includes(this.state.saveStatus));
  }

  dispose(): void {
    this.cancelAutosave();
    this.listeners.clear();
  }
}
