import type { PlanSaveStatus } from "./contracts";

export type PlanLifecycleState = "missing" | "active-clean" | "active-dirty" | "archived" | "deleted";
export type PlanLifecycleEvent = "create" | "import" | "duplicate" | "edit" | "autosave" | "save-version" | "archive" | "restore" | "delete";
export type ProposalStatus = "proposed" | "applied" | "rejected" | "stale";
export type TransactionImportStatus = "selected" | "reading" | "recognizing" | "enriching" | "reviewing" | "staged" | "archiving" | "archived" | "failed";

const lifecycle: Record<PlanLifecycleState, Partial<Record<PlanLifecycleEvent, PlanLifecycleState>>> = {
  missing: { create: "active-dirty", import: "active-dirty", duplicate: "active-dirty" },
  "active-clean": { edit: "active-dirty", archive: "archived", delete: "deleted" },
  "active-dirty": { edit: "active-dirty", autosave: "active-dirty", "save-version": "active-clean", archive: "archived" },
  archived: { restore: "active-clean", duplicate: "active-dirty", delete: "deleted" },
  deleted: {},
};

const saveStatuses: Record<PlanSaveStatus, readonly PlanSaveStatus[]> = {
  clean: ["dirty", "saving", "offline"],
  dirty: ["saving", "clean", "offline"],
  saving: ["saved", "conflict", "failed", "offline", "dirty"],
  saved: ["clean", "dirty", "saving", "offline"],
  conflict: ["dirty", "saving", "clean", "offline"],
  failed: ["dirty", "saving", "offline", "clean"],
  offline: ["dirty", "saving", "clean", "failed"],
};

const proposalStatuses: Record<ProposalStatus, readonly ProposalStatus[]> = {
  proposed: ["applied", "rejected", "stale"],
  applied: [],
  rejected: [],
  stale: [],
};

const transactionStatuses: Record<TransactionImportStatus, readonly TransactionImportStatus[]> = {
  selected: ["reading", "failed"],
  reading: ["recognizing", "failed"],
  recognizing: ["enriching", "reviewing", "failed"],
  enriching: ["reviewing", "failed"],
  reviewing: ["staged", "failed"],
  staged: ["archiving", "reviewing", "failed"],
  archiving: ["archived", "staged", "failed"],
  archived: [],
  failed: ["selected", "reading", "recognizing", "enriching", "reviewing", "archiving"],
};

export function transitionPlan(state: PlanLifecycleState, event: PlanLifecycleEvent): PlanLifecycleState {
  const next = lifecycle[state][event];
  if (!next) throw new Error(`Invalid plan lifecycle transition: ${state} -> ${event}`);
  return next;
}

export function transitionSaveStatus(state: PlanSaveStatus, next: PlanSaveStatus): PlanSaveStatus {
  if (state === next) return state;
  if (!saveStatuses[state].includes(next)) throw new Error(`Invalid save status transition: ${state} -> ${next}`);
  return next;
}

export function transitionProposal(state: ProposalStatus, next: ProposalStatus): ProposalStatus {
  if (!proposalStatuses[state].includes(next)) throw new Error(`Invalid proposal transition: ${state} -> ${next}`);
  return next;
}

export function transitionTransaction(state: TransactionImportStatus, next: TransactionImportStatus): TransactionImportStatus {
  if (!transactionStatuses[state].includes(next)) throw new Error(`Invalid transaction transition: ${state} -> ${next}`);
  return next;
}
