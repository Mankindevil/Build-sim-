import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { importBundledManuals } from "../scripts/evidence/import-bundled-manuals.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("bundled evidence migration", () => {
  it("verifies the snapshot hash and reuses one content-addressed blob on repeat", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "bundled-evidence-source-"));
    const root = await mkdtemp(path.join(tmpdir(), "bundled-evidence-store-"));
    roots.push(cwd, root);
    const bytes = Buffer.from("fixture bundled manual");
    const file = "manual.pdf";
    await writeFile(path.join(cwd, file), bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const entries = [{ file, sha256, title: "Fixture Manual", url: "https://www.jonsbo.com/manual.pdf", officialBrand: "JONSBO", identity: { brand: "JONSBO", model: "Fixture", category: "case" } }];
    const repository = new FileEvidenceRepository({ root });
    const first = await importBundledManuals({ cwd, repository, entries });
    const second = await importBundledManuals({ cwd, repository, entries });
    expect(first[0]).toMatchObject({ reusedDocument: false, reusedCapture: false, capture: { acquisitionMethod: "bundled-import" } });
    expect(second[0]).toMatchObject({ reusedDocument: true, reusedCapture: true });
    const blob = path.join(root, "blobs", "sha256", sha256.slice(0, 2), sha256);
    expect(await readFile(blob)).toEqual(bytes);
  });

  it("refuses a changed checked-in file before persisting it", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "bundled-evidence-bad-"));
    const root = await mkdtemp(path.join(tmpdir(), "bundled-evidence-empty-"));
    roots.push(cwd, root);
    await writeFile(path.join(cwd, "manual.pdf"), "changed");
    await expect(importBundledManuals({ cwd, root, entries: [{ file: "manual.pdf", sha256: "0".repeat(64) }] })).rejects.toThrow(/checksum mismatch/);
  });

  it("adds the governed bundled identity as a separate capture when the same bytes had other metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "bundled-evidence-poison-source-"));
    const root = await mkdtemp(path.join(tmpdir(), "bundled-evidence-poison-store-"));
    roots.push(cwd, root);
    const bytes = Buffer.from("same bytes, incompatible metadata");
    await writeFile(path.join(cwd, "manual.pdf"), bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const repository = new FileEvidenceRepository({ root });
    await repository.importBuffer(bytes, {
      mediaType: "application/pdf", kind: "manufacturer-manual", title: "Wrong Model Manual",
      productIdentities: [{ brand: "JONSBO", model: "Wrong Model" }],
      capture: { requestedUrl: "https://www.jonsbo.com/wrong.pdf", finalUrl: "https://www.jonsbo.com/wrong.pdf", retrievedAt: "2026-08-19T00:00:00.000Z", status: 200, redirects: [], officialBrand: "JONSBO", acquisitionMethod: "official-fetch" },
    });
    const entries = [{ file: "manual.pdf", sha256, title: "N6 Manual", url: "https://www.jonsbo.com/n6.pdf", officialBrand: "JONSBO", identity: { brand: "JONSBO", model: "N6", category: "case" } }];
    const imported = await importBundledManuals({ cwd, repository, entries });
    expect(imported[0]).toMatchObject({ reusedDocument: true, capture: { title: "N6 Manual", productIdentities: [{ model: "N6" }] } });
    expect(await repository.listCaptures(imported[0]!.document.id)).toHaveLength(2);
  });
});
