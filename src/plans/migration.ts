import { PLAN_SCHEMA_VERSION, type PlanTransactionLink } from "./contracts";

export const LEGACY_PROGRESS_KEY = "build-sim.progress.v1";
export const LEGACY_PROGRESS_BACKUP_KEY = "build-sim.progress.v1.backup";
export const LEGACY_PROGRESS_MIGRATION_KEY = "build-sim.progress.v1.migrated";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LegacyProgressMigrationItem {
  legacyItemId: string;
  snapshot: Record<string, unknown>;
  transactionLink: PlanTransactionLink | null;
}

export interface LegacyProgressMigrationResult {
  migrated: boolean;
  items: LegacyProgressMigrationItem[];
  error?: "invalid_json" | "invalid_shape";
}

export function migrateLegacyProgress(storage: KeyValueStorage): LegacyProgressMigrationResult {
  const existing = storage.getItem(LEGACY_PROGRESS_MIGRATION_KEY);
  if (existing) {
    try { return JSON.parse(existing) as LegacyProgressMigrationResult; } catch { /* re-run from backup */ }
  }
  const raw = storage.getItem(LEGACY_PROGRESS_KEY) ?? storage.getItem(LEGACY_PROGRESS_BACKUP_KEY);
  if (!raw) {
    const result: LegacyProgressMigrationResult = { migrated: false, items: [] };
    storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
    return result;
  }
  storage.setItem(LEGACY_PROGRESS_BACKUP_KEY, raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const result: LegacyProgressMigrationResult = { migrated: false, items: [], error: "invalid_json" };
    storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
    return result;
  }
  const candidate = parsed as { schemaVersion?: unknown; items?: unknown };
  if (candidate.schemaVersion !== 1 || !candidate.items || typeof candidate.items !== "object" || Array.isArray(candidate.items)) {
    const result: LegacyProgressMigrationResult = { migrated: false, items: [], error: "invalid_shape" };
    storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
    return result;
  }
  const items = Object.entries(candidate.items as Record<string, unknown>)
    .filter(([, item]) => item !== null && typeof item === "object" && !Array.isArray(item))
    .map(([legacyItemId, item]) => {
      const snapshot = structuredClone(item as Record<string, unknown>);
      const hasTransaction = snapshot.transaction !== null && typeof snapshot.transaction === "object";
      return {
        legacyItemId,
        snapshot,
        transactionLink: hasTransaction ? {
          schemaVersion: PLAN_SCHEMA_VERSION,
          planId: null,
          planVersionIdAtCapture: null,
          planItemId: null,
          linkStatus: "unlinked" as const,
        } : null,
      };
    });
  const result: LegacyProgressMigrationResult = { migrated: true, items };
  storage.setItem(LEGACY_PROGRESS_MIGRATION_KEY, JSON.stringify(result));
  return result;
}

