import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveTransaction, listTransactionArchives, updateTransactionArchive } from "../scripts/price-server/transactions/archive.mjs";

const roots: string[] = [];
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "build-sim-r8-link-")); roots.push(value); return value;
}

function body(planId = "plan-r8-12345678") {
  const contentHash = createHash("sha256").update(image).digest("hex");
  const receiptId = `receipt-${contentHash.slice(0, 20)}`;
  return {
    receiptId,
    screenshotDataUrl: `data:image/png;base64,${image.toString("base64")}`,
    link: { schemaVersion: "1.0.0", planId, planVersionIdAtCapture: "version-r8-12345678", planItemId: "psu.primary", linkStatus: "linked" },
    item: { id: `transaction-${receiptId}`, skuId: "psu.seasonic-focus-gx-850-v5", name: "FOCUS GX-850", category: "psu", qty: 1, unitPriceCny: 899, stage: "purchased", source: "transaction", transaction: { receiptId, fileName: "order.png", contentHash, capturedAt: "2026-08-25T00:00:00.000Z", ocrEngine: "fixture", ocrConfidence: 91, excerpt: "evidence", verification: "matched-catalog" } },
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("R8 transaction to plan links", () => {
  it("archives a version-at-capture and concrete plan item, then supports audited relinking", async () => {
    const dir = await root();
    const archived = await archiveTransaction(body(), { root: dir });
    expect(archived).toMatchObject({ schemaVersion: 2, link: { planId: "plan-r8-12345678", planVersionIdAtCapture: "version-r8-12345678", planItemId: "psu.primary", linkStatus: "linked" } });
    const updated = await updateTransactionArchive(archived.receiptId, { item: { name: "FOCUS GX-850 · 已核对" }, link: { schemaVersion: "1.0.0", planId: "plan-r8-87654321", planVersionIdAtCapture: null, planItemId: "psu.secondary", linkStatus: "linked" } }, { root: dir });
    expect(updated).toMatchObject({ item: { name: "FOCUS GX-850 · 已核对" }, link: { planId: "plan-r8-87654321", planItemId: "psu.secondary", linkStatus: "linked" }, image: { contentHash: archived.image.contentHash } });
  });

  it("reads legacy schema v1 records into the unlinked inbox without inventing a plan", async () => {
    const dir = await root();
    const legacy = body();
    await writeFile(path.join(dir, `${legacy.receiptId}.json`), JSON.stringify({ schemaVersion: 1, receiptId: legacy.receiptId, storedAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", item: legacy.item, image: null }));
    const records = await listTransactionArchives({ root: dir });
    expect(records).toEqual([expect.objectContaining({ schemaVersion: 2, link: { schemaVersion: "1.0.0", planId: null, planVersionIdAtCapture: null, planItemId: null, linkStatus: "unlinked" } })]);
    const stored = JSON.parse(await readFile(path.join(dir, `${legacy.receiptId}.json`), "utf8"));
    expect(stored).not.toHaveProperty("link");
  });
});
