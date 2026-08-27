import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveTransaction, deleteTransactionArchive, deleteTransactionImage, listTransactionArchives, readTransactionImage } from "../scripts/price-server/transactions/archive.mjs";

const roots: string[] = [];

function png(width = 1200, height = 800): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt8(0x89, 0);
  buffer.write("PNG", 1, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-transaction-archive-"));
  roots.push(root);
  return root;
}

function archiveBody(image: Buffer) {
  const contentHash = createHash("sha256").update(image).digest("hex");
  return {
    receiptId: `receipt-${contentHash.slice(0, 20)}`,
    screenshotDataUrl: `data:image/png;base64,${image.toString("base64")}`,
    item: {
      id: `transaction-receipt-${contentHash.slice(0, 20)}`,
      skuId: null,
      name: "Seasonic VERTEX GX-1000",
      category: "psu",
      qty: 1,
      unitPriceCny: 1250,
      stage: "purchased",
      source: "transaction",
      transaction: {
        receiptId: `receipt-${contentHash.slice(0, 20)}`,
        fileName: "order.png",
        contentHash,
        capturedAt: "2026-08-25T00:00:00.000Z",
        ocrEngine: "deepseek-vision:fixture",
        ocrConfidence: null,
        excerpt: "识别结果",
        verification: "identity-review-required",
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server transaction screenshot archive", () => {
  it("atomically stores sanitized verification metadata and discards the original image", async () => {
    const root = await fixtureRoot();
    const image = png();
    const body = archiveBody(image);
    const record = await archiveTransaction(body, { root });

    expect(record).toMatchObject({ receiptId: body.receiptId, item: { name: "Seasonic VERTEX GX-1000" }, image: null, imageEvidence: { mimeType: "image/png", bytes: image.length, contentHash: body.item.transaction.contentHash, persistence: "discarded_after_verification" } });
    const metadata = JSON.parse(await readFile(path.join(root, `${body.receiptId}.json`), "utf8"));
    expect(JSON.stringify(metadata)).not.toContain("base64");
    expect(await readTransactionImage(body.receiptId, { root })).toBeNull();
    expect(await listTransactionArchives({ root })).toHaveLength(1);
  });

  it("rejects mismatched screenshot evidence", async () => {
    const root = await fixtureRoot();
    const body = archiveBody(png());
    body.item.transaction.contentHash = "0".repeat(64);
    await expect(archiveTransaction(body, { root })).rejects.toThrow(/哈希/);
    expect(await listTransactionArchives({ root })).toEqual([]);
  });

  it("rejects phone numbers synthesized into every governed transaction identifier", async () => {
    const root = await fixtureRoot();
    const phone = "13812345678";
    const cases: Array<[string, (input: any) => void]> = [
      ["planId", (input) => { input.link = { planId: `plan-${phone}`, planVersionIdAtCapture: null, planItemId: "psu.primary", linkStatus: "linked" }; }],
      ["planVersionIdAtCapture", (input) => { input.link = { planId: "plan-private-check", planVersionIdAtCapture: `version-${phone}`, planItemId: "psu.primary", linkStatus: "linked" }; }],
      ["planItemId", (input) => { input.link = { planId: "plan-private-check", planVersionIdAtCapture: null, planItemId: `item-${phone}`, linkStatus: "linked" }; }],
      ["item.id", (input) => { input.item.id = `transaction-${phone}`; }],
      ["item.skuId", (input) => { input.item.skuId = `sku-${phone}`; }],
      ["catalogJobId", (input) => { input.item.transaction.catalogJobId = `catalog-search-${phone}${"0".repeat(9)}`; }],
      ["candidateId", (input) => { input.item.transaction.candidateId = `catalog-candidate-${phone}${"0".repeat(5)}`; }],
      ["draftId", (input) => { input.item.transaction.draftId = `sku-draft-${phone}${"0".repeat(9)}`; }],
    ];
    for (const [label, mutate] of cases) {
      const input: any = archiveBody(png());
      mutate(input);
      await expect(archiveTransaction(input, { root }), label).rejects.toThrow(/private data|phone number/);
    }
    expect(await listTransactionArchives({ root })).toEqual([]);
  });

  it("rejects non-ISO capturedAt values instead of persisting fixture sentinels", async () => {
    const root = await fixtureRoot();
    const input = archiveBody(png());
    input.item.transaction.capturedAt = "now";
    await expect(archiveTransaction(input, { root })).rejects.toThrow(/capturedAt is invalid/);
  });

  it("serializes concurrent archive writers without losing journal entries", async () => {
    const root = await fixtureRoot();
    const first = archiveBody(png(1200, 800));
    const second = archiveBody(png(1201, 800));
    await Promise.all([archiveTransaction(first, { root }), archiveTransaction(second, { root })]);
    expect(await listTransactionArchives({ root })).toHaveLength(2);
    const journal = JSON.parse(await readFile(path.join(root, "rollback", "transactions-manifest.json"), "utf8"));
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries.every((entry: Record<string, unknown>) => entry.state === "committed"
      && !["source", "preparedTargets", "cleanupTargets", "previousBase64"].some((field) => field in entry))).toBe(true);
  });

  it("makes a repeated receipt archive idempotent instead of overwriting its first record", async () => {
    const root = await fixtureRoot();
    const input = archiveBody(png(1202, 800));
    const [first, second] = await Promise.all([
      archiveTransaction(input, { root }),
      archiveTransaction({ ...structuredClone(input), item: { ...structuredClone(input.item), name: "conflicting replay" } }, { root }),
    ]);
    expect(second).toEqual(first);
    expect((await listTransactionArchives({ root }))[0]?.item.name).toBe(input.item.name);
    const journal = JSON.parse(await readFile(path.join(root, "rollback", "transactions-manifest.json"), "utf8"));
    expect(journal.entries).toHaveLength(1);
  });

  it("can delete only the image or the complete server record", async () => {
    const root = await fixtureRoot();
    const body = archiveBody(png());
    await archiveTransaction(body, { root });
    const withoutImage = await deleteTransactionImage(body.receiptId, { root });
    expect(withoutImage.image).toBeNull();
    expect(await readTransactionImage(body.receiptId, { root })).toBeNull();
    expect(await deleteTransactionArchive(body.receiptId, { root })).toEqual({ receiptId: body.receiptId, deleted: true });
    expect(await listTransactionArchives({ root })).toEqual([]);
  });
});
