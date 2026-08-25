import type { BuildEvaluation } from "../core/evaluate";
import type { KeyValueStorage } from "./migration";
import type { BuildTask } from "./contracts";
import { deriveBuildTasks, reconcileBuildTasks, summarizeBuildTasks, type BuildPurchaseFact, type BuildTaskSummary } from "./build-tasks";
import { validateBuildTask } from "./validation";

export const BUILD_TASK_STORAGE_PREFIX = "build-sim.tasks.v1:";

export interface BuildTaskStoreState { planId: string | null; sourceVersionId: string | null; tasks: BuildTask[]; }

function load(storage: KeyValueStorage, planId: string): BuildTask[] {
  try {
    const raw = storage.getItem(`${BUILD_TASK_STORAGE_PREFIX}${planId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { schemaVersion?: number; tasks?: BuildTask[] };
    return parsed.schemaVersion === 1 && Array.isArray(parsed.tasks) ? parsed.tasks.filter((item) => item?.planId === planId && validateBuildTask(item).length === 0) : [];
  } catch { return []; }
}

export class BuildTaskStore {
  private state: BuildTaskStoreState = { planId: null, sourceVersionId: null, tasks: [] };
  private listeners = new Set<(state: BuildTaskStoreState) => void>();
  constructor(private readonly storage: KeyValueStorage) {}

  getState(): BuildTaskStoreState { return structuredClone(this.state); }
  subscribe(listener: (state: BuildTaskStoreState) => void): () => void { this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener); }
  private emit(): void { const snapshot = this.getState(); for (const listener of this.listeners) listener(snapshot); }
  private persist(): void {
    if (!this.state.planId) return;
    try { this.storage.setItem(`${BUILD_TASK_STORAGE_PREFIX}${this.state.planId}`, JSON.stringify({ schemaVersion: 1, sourceVersionId: this.state.sourceVersionId, tasks: this.state.tasks })); } catch { /* offline/private storage keeps the in-memory task state usable */ }
  }

  reconcile(input: { planId: string; sourceVersionId: string; evaluation: BuildEvaluation; purchaseFacts?: BuildPurchaseFact[]; at?: string }): void {
    const previous = input.planId === this.state.planId ? this.state.tasks : load(this.storage, input.planId);
    const derived = deriveBuildTasks(input);
    this.state = { planId: input.planId, sourceVersionId: input.sourceVersionId, tasks: reconcileBuildTasks(previous, derived, input.at) };
    this.persist(); this.emit();
  }

  setStatus(taskId: string, status: Exclude<BuildTask["status"], "obsolete">, at = new Date().toISOString()): void {
    const item = this.state.tasks.find((candidate) => candidate.id === taskId && candidate.status !== "obsolete");
    if (!item) return;
    item.status = status; item.statusSource = "manual"; item.updatedAt = at;
    if (status === "done") item.completedAt = at; else delete item.completedAt;
    this.persist(); this.emit();
  }

  setNote(taskId: string, note: string, at = new Date().toISOString()): void {
    const item = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!item) return;
    const trimmed = note.trim(); if (trimmed) item.note = trimmed; else delete item.note;
    item.updatedAt = at; this.persist(); this.emit();
  }

  summary(): BuildTaskSummary { return summarizeBuildTasks(this.state.tasks); }
}
