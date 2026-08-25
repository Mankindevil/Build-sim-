import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  it("atomically stores metadata and the original image outside the source tree", async () => {
    const root = await fixtureRoot();
    const image = png();
    const body = archiveBody(image);
    const record = await archiveTransaction(body, { root });

    expect(record).toMatchObject({ receiptId: body.receiptId, item: { name: "Seasonic VERTEX GX-1000" }, image: { mimeType: "image/png", bytes: image.length } });
    expect(record.image.imageUrl).toContain(`/transactions/archive/${body.receiptId}/image`);
    const metadata = JSON.parse(await readFile(path.join(root, `${body.receiptId}.json`), "utf8"));
    expect(JSON.stringify(metadata)).not.toContain("base64");
    expect((await stat(path.join(root, `${body.receiptId}.png`))).mode & 0o777).toBe(0o600);
    expect(await readTransactionImage(body.receiptId, { root })).toMatchObject({ mimeType: "image/png", fileName: "order.png" });
    expect(await listTransactionArchives({ root })).toHaveLength(1);
  });

  it("rejects mismatched screenshot evidence", async () => {
    const root = await fixtureRoot();
    const body = archiveBody(png());
    body.item.transaction.contentHash = "0".repeat(64);
    await expect(archiveTransaction(body, { root })).rejects.toThrow(/哈希/);
    expect(await listTransactionArchives({ root })).toEqual([]);
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
