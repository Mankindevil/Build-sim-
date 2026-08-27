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
    expect(updated).toMatchObject({ item: { name: "FOCUS GX-850 · 已核对" }, link: { planId: "plan-r8-87654321", planItemId: "psu.secondary", linkStatus: "linked" }, image: null, imageEvidence: { contentHash: archived.imageEvidence.contentHash, persistence: "discarded_after_verification" } });
    await updateTransactionArchive(archived.receiptId, { item: { name: "FOCUS GX-850 · 同方案复核" }, link: updated.link }, { root: dir });
    const afterRestartRead = await listTransactionArchives({ root: dir });
    expect(afterRestartRead).toEqual([expect.objectContaining({ receiptId: archived.receiptId, item: expect.objectContaining({ name: "FOCUS GX-850 · 同方案复核" }) })]);
    const journal = JSON.parse(await readFile(path.join(dir, "rollback", "transactions-manifest.json"), "utf8"));
    expect(journal.entries.every((entry: Record<string, unknown>) =>
      !["source", "preparedTargets", "cleanupTargets", "previousBase64"].some((field) => field in entry))).toBe(true);
  });

  it("removes PII from every persisted transaction field and never copies old records into a reversible journal", async () => {
    const dir = await root();
    const input = body();
    input.item.name = "GPU 联系人：张三，手机：13812345678";
    input.item.transaction.fileName = "张三-北京市朝阳区订单.png";
    input.item.transaction.ocrEngine = "fixture 联系人：张三";
    input.item.transaction.excerpt = "收货人：张三，地址：北京市朝阳区测试路 88 号，电话：13812345678";
    input.item.transaction.verification = "联系邮箱 private@example.com";
    (input.item.transaction as typeof input.item.transaction & { officialUrl: string }).officialUrl = "https://vendor.example/item?receiver=张三&phone=13812345678";

    const archived = await archiveTransaction(input, { root: dir });
    expect(JSON.stringify(archived)).not.toMatch(/张三|13812345678|北京市朝阳区|private@example\.com/);
    await updateTransactionArchive(archived.receiptId, { item: { name: "Sanitized GPU" }, link: archived.link }, { root: dir });

    const persisted = await readFile(path.join(dir, `${archived.receiptId}.json`), "utf8");
    const journal = await readFile(path.join(dir, "rollback", "transactions-manifest.json"), "utf8");
    expect(`${persisted}\n${journal}`).not.toMatch(/张三|13812345678|北京市朝阳区|private@example\.com|previousBase64/);
    expect(JSON.parse(persisted).item.transaction).toMatchObject({
      fileName: "transaction-screenshot",
      officialUrl: "https://vendor.example/item",
    });
  });

  it("recovers an atomic metadata commit without storing a reversible previous payload", async () => {
    const dir = await root();
    const archived = await archiveTransaction(body(), { root: dir });
    const metadataFile = path.join(dir, `${archived.receiptId}.json`);
    const manifestFile = path.join(dir, "rollback", "transactions-manifest.json");
    const previous = JSON.parse(await readFile(metadataFile, "utf8"));
    const next = { ...previous, item: { ...previous.item, name: "Crash-completed update" }, updatedAt: "2026-08-27T00:00:00.000Z" };
    const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const prepared = {
      id: "simulated-crash-after-rename", operation: "transaction-update", target: `${archived.receiptId}.json`,
      previousHash: hash(previous), nextHash: hash(next), preparedTargets: [], cleanupTargets: [],
      state: "prepared", createdAt: "2026-08-27T00:00:00.000Z",
    };
    const entries = [...manifest.entries, prepared];
    const unsigned = { schemaVersion: "transactions-rollback-v2", entries };
    await writeFile(manifestFile, JSON.stringify({ ...unsigned, checksum: hash(unsigned) }), "utf8");
    await writeFile(metadataFile, JSON.stringify(next), "utf8");

    await updateTransactionArchive(archived.receiptId, { item: { name: "Post-recovery update" }, link: archived.link }, { root: dir });
    const recoveredManifest = JSON.parse(await readFile(manifestFile, "utf8"));
    expect(recoveredManifest.entries.find((entry: { id: string }) => entry.id === prepared.id)).toMatchObject({ state: "committed" });
    expect(JSON.stringify(recoveredManifest)).not.toContain("previousBase64");
    expect((await listTransactionArchives({ root: dir }))[0]?.item.name).toBe("Post-recovery update");
  });

  it("fails closed on a legacy reversible journal payload without decoding or restoring it", async () => {
    const dir = await root();
    const archived = await archiveTransaction(body(), { root: dir });
    const metadataFile = path.join(dir, `${archived.receiptId}.json`);
    const manifestFile = path.join(dir, "rollback", "transactions-manifest.json");
    const before = await readFile(metadataFile, "utf8");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.entries[0].previousBase64 = Buffer.from(JSON.stringify({ customerName: "张三", phone: "13812345678" })).toString("base64");
    const unsigned = { schemaVersion: manifest.schemaVersion, entries: manifest.entries };
    manifest.checksum = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    await writeFile(manifestFile, JSON.stringify(manifest), "utf8");

    await expect(updateTransactionArchive(archived.receiptId, { item: { name: "must-not-write" } }, { root: dir })).rejects.toThrow(/explicit runtime migration quarantine/);
    expect(await readFile(metadataFile, "utf8")).toBe(before);
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
