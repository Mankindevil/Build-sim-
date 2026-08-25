import { describe, expect, it } from "vitest";
import {
  LEGACY_PROGRESS_BACKUP_KEY,
  LEGACY_PROGRESS_KEY,
  LEGACY_PROGRESS_MIGRATION_KEY,
  migrateLegacyProgress,
  type KeyValueStorage,
} from "../src/plans/migration";

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("R1 legacy progress migration", () => {
  it("backs up once, is idempotent, and never guesses transaction plan links", () => {
    const storage = new MemoryStorage();
    const legacy = JSON.stringify({
      schemaVersion: 1,
      items: {
        psu: { name: "PSU", stage: "purchased", transaction: { receiptId: "receipt-1" } },
        case: { name: "Case", stage: "installed" },
      },
    });
    storage.setItem(LEGACY_PROGRESS_KEY, legacy);
    const first = migrateLegacyProgress(storage);
    expect(first.migrated).toBe(true);
    expect(first.items).toHaveLength(2);
    expect(first.items.find((item) => item.legacyItemId === "psu")?.transactionLink).toMatchObject({
      planId: null,
      planVersionIdAtCapture: null,
      planItemId: null,
      linkStatus: "unlinked",
    });
    expect(storage.getItem(LEGACY_PROGRESS_BACKUP_KEY)).toBe(legacy);
    storage.setItem(LEGACY_PROGRESS_KEY, JSON.stringify({ schemaVersion: 1, items: { changed: {} } }));
    expect(migrateLegacyProgress(storage)).toEqual(first);
    expect(storage.getItem(LEGACY_PROGRESS_MIGRATION_KEY)).toBeTruthy();
  });

  it("preserves malformed source data and reports a recoverable error", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_PROGRESS_KEY, "not-json");
    expect(migrateLegacyProgress(storage)).toEqual({ migrated: false, items: [], error: "invalid_json" });
    expect(storage.getItem(LEGACY_PROGRESS_BACKUP_KEY)).toBe("not-json");
  });
});
