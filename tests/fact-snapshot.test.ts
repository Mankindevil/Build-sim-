import { describe, expect, it } from "vitest";
import { verifyFactSnapshotRuntime } from "../src/facts/canonical-runtime.mjs";
import { createFactSnapshot, verifyFactSnapshot } from "../src/facts/snapshots";

const digest = (letter: string): string => letter.repeat(64);

describe("U3 content-addressed fact snapshots", () => {
  it("is order-independent across Node/TypeScript and the production JavaScript validator", async () => {
    const input = {
      schemaVersion: "fact-snapshot-v2" as const,
      factRefs: [
        { factId: "fact-b", contentHash: digest("b") },
        { factId: "fact-a", contentHash: digest("a") },
      ],
      conflictRefs: [
        { conflictSetId: "conflict-b", contentHash: digest("d") },
        { conflictSetId: "conflict-a", contentHash: digest("c") },
      ],
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const first = await createFactSnapshot(input);
    const reordered = await createFactSnapshot({
      ...input,
      factRefs: [...input.factRefs].reverse(),
      conflictRefs: [...input.conflictRefs].reverse(),
    });
    expect(reordered).toEqual(first);
    expect(first.snapshotId).toBe(`fact-snapshot-sha256-${first.contentHash}`);
    await expect(verifyFactSnapshot(first)).resolves.toBe(true);
    expect(verifyFactSnapshotRuntime(first)).toBe(true);
  });

  it("changes identity for one fact mutation and rejects checksum-correct-looking forged closure", async () => {
    const first = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: [{ factId: "fact-a", contentHash: digest("a") }],
      conflictRefs: [],
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    const changed = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: [{ factId: "fact-a", contentHash: digest("b") }],
      conflictRefs: [],
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect(changed.contentHash).not.toBe(first.contentHash);
    const forged = structuredClone(first);
    forged.factRefs[0]!.contentHash = digest("f");
    await expect(verifyFactSnapshot(forged)).resolves.toBe(false);
    expect(verifyFactSnapshotRuntime(forged)).toBe(false);
  });
});
