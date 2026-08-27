import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-evidence-"));
  roots.push(root);
  return root;
}

function metadata(url: string, overrides: Record<string, unknown> = {}) {
  return {
    mediaType: "application/pdf",
    kind: "manufacturer-manual",
    title: "Example Hardware Manual",
    productIdentities: [{ brand: "Example", model: "Board X1", category: "motherboard", skuId: "board.example-x1" }],
    capture: {
      acquisitionMethod: "official-fetch",
      requestedUrl: url,
      finalUrl: `${url}/download`,
      canonicalUrl: `${url}/manual.pdf`,
      retrievedAt: "2026-08-27T00:00:00.000Z",
      status: 200,
      redirects: [`${url}/download`],
      etag: '"manual-v1"',
      lastModified: "Wed, 26 Aug 2026 12:00:00 GMT",
      officialBrand: "Example",
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content-addressed evidence repository", () => {
  it("persists one immutable blob and restores document, capture, content and URL aliases after restart", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("%PDF-1.7\nexample official manual\n%%EOF\n");
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const repository = new FileEvidenceRepository({ root });

    const imported = await repository.importBuffer(bytes, metadata("https://support.example.com/board-x1"));

    expect(imported).toMatchObject({
      reusedDocument: false,
      reusedCapture: false,
      document: {
        id: `doc-sha256-${hash}`,
        sha256: hash,
        byteLength: bytes.byteLength,
        mediaType: "application/pdf",
      },
      capture: { acquisitionMethod: "official-fetch", kind: "manufacturer-manual", officialBrand: "Example" },
    });
    expect(Object.isFrozen(imported.document)).toBe(true);

    const blob = path.join(root, "blobs", "sha256", hash.slice(0, 2), hash);
    const documentFile = path.join(root, "documents", hash.slice(0, 2), `${imported.document.id}.json`);
    const captureHash = imported.capture.id.slice("capture-sha256-".length);
    const captureFile = path.join(root, "captures", captureHash.slice(0, 2), `${imported.capture.id}.json`);
    expect((await stat(blob)).mode & 0o777).toBe(0o600);
    expect((await stat(documentFile)).mode & 0o777).toBe(0o600);
    expect((await stat(captureFile)).mode & 0o777).toBe(0o600);

    const restarted = new FileEvidenceRepository({ root });
    await expect(restarted.getDocument(imported.document.id)).resolves.toEqual(imported.document);
    await expect(restarted.getCapture(imported.capture.id)).resolves.toEqual(imported.capture);
    await expect(restarted.readContent(imported.document.id)).resolves.toEqual(bytes);
    for (const alias of [imported.capture.requestedUrl, imported.capture.finalUrl, imported.capture.canonicalUrl]) {
      await expect(restarted.getLatestCaptureForUrl(alias)).resolves.toEqual(imported.capture);
      await expect(restarted.getLatestDocumentForUrl(alias)).resolves.toEqual(imported.document);
    }
  });

  it("converges concurrent imports of identical bytes while retaining separate source captures", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("shared-manual-revision-one");
    const repository = new FileEvidenceRepository({ root });
    const concurrentInstance = new FileEvidenceRepository({ root });
    const firstMetadata = metadata("https://docs.example.com/x1");
    const secondMetadata = metadata("https://cdn.example.com/x1", {
      capture: {
        ...(metadata("https://cdn.example.com/x1").capture as Record<string, unknown>),
        retrievedAt: "2026-08-27T00:05:00.000Z",
      },
    });

    const [first, second] = await Promise.all([
      repository.importBuffer(bytes, firstMetadata),
      concurrentInstance.importBuffer(bytes, secondMetadata),
    ]);

    expect(first.document.id).toBe(second.document.id);
    expect(second.document).toEqual(first.document);
    expect(first.capture.id).not.toBe(second.capture.id);
    expect(await repository.listCaptures(first.document.id)).toHaveLength(2);
    const hash = first.document.sha256;
    expect(await readdir(path.join(root, "blobs", "sha256", hash.slice(0, 2)))).toEqual([hash]);
    await expect(repository.getLatestCaptureForUrl(second.capture.requestedUrl)).resolves.toEqual(second.capture);

    const exactReplay = await repository.importBuffer(bytes, firstMetadata);
    expect(exactReplay).toMatchObject({ reusedDocument: true, reusedCapture: true });
    expect(exactReplay.capture.id).toBe(first.capture.id);
    expect(await repository.listCaptures(first.document.id)).toHaveLength(2);
  });

  it("keeps the newest capture in every requested/final/canonical URL index and accepts a 304 reuse capture", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("conditional-download-content");
    const repository = new FileEvidenceRepository({ root });
    const source = "https://support.example.com/conditional";
    const initial = await repository.importBuffer(bytes, metadata(source));
    const laterMetadata = metadata(source, {
      capture: {
        ...(metadata(source).capture as Record<string, unknown>),
        acquisitionMethod: "official-fetch",
        retrievedAt: "2026-08-28T00:00:00.000Z",
        status: 304,
      },
    });
    const revalidated = await repository.importBuffer(bytes, laterMetadata);

    expect(revalidated).toMatchObject({ reusedDocument: true, reusedCapture: false, capture: { status: 304 } });
    expect(revalidated.document.id).toBe(initial.document.id);
    for (const alias of [initial.capture.requestedUrl, initial.capture.finalUrl, initial.capture.canonicalUrl]) {
      await expect(repository.getLatestCaptureForUrl(alias)).resolves.toEqual(revalidated.capture);
    }
  });

  it("imports a bundled file without mislabelling it as a network fetch", async () => {
    const root = await temporaryRoot();
    const sourceFile = path.join(root, "seed-manual.pdf");
    await writeFile(sourceFile, "%PDF-1.7\nbundled seed\n", { mode: 0o600 });
    const repository = new FileEvidenceRepository({ root: path.join(root, "repository") });
    const input = metadata("https://vendor.example.com/seed");
    delete (input.capture as { acquisitionMethod?: string }).acquisitionMethod;

    const imported = await repository.importFile(sourceFile, input);

    expect(imported.capture.acquisitionMethod).toBe("bundled-import");
    await expect(repository.readContent(imported.document.id)).resolves.toEqual(await readFile(sourceFile));
  });

  it("isolates incompatible descriptive metadata to captures instead of poisoning the global content hash", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("one content hash with governed metadata");
    const first = new FileEvidenceRepository({ root });
    const restarted = new FileEvidenceRepository({ root });
    const original = await first.importBuffer(bytes, metadata("https://support.example.com/original"));
    const other = await restarted.importBuffer(bytes, metadata("https://support.example.com/spoofed", {
      title: "Wrong Model Manual",
      productIdentities: [{ brand: "Example", model: "Wrong Model", category: "motherboard" }],
    }));
    expect(other.document).toEqual(original.document);
    expect(other.capture).toMatchObject({
      title: "Wrong Model Manual",
      kindBasis: "legacy-unverified",
      productIdentities: [{ model: "Wrong Model", basis: "legacy-unverified" }],
    });
    const captures = await first.listCaptures(`doc-sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`);
    expect(captures).toHaveLength(2);
    expect(captures.map((capture: { title: string }) => capture.title)).toEqual(expect.arrayContaining(["Example Hardware Manual", "Wrong Model Manual"]));
  });

  it("returns verified metadata and a defensive byte copy in one content read", async () => {
    const root = await temporaryRoot();
    const repository = new FileEvidenceRepository({ root });
    const bytes = Buffer.from("single-pass-content");
    const imported = await repository.importBuffer(bytes, metadata("https://support.example.com/single-pass"));

    const first = await repository.getDocumentContent(imported.document.id);
    expect(first?.document).toEqual(imported.document);
    expect(first?.bytes).toEqual(bytes);
    first?.bytes.fill(0);
    await expect(repository.readContent(imported.document.id)).resolves.toEqual(bytes);
  });

  it("fails closed for traversal-shaped ids and blob or metadata tampering", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("tamper-sensitive-content");
    const repository = new FileEvidenceRepository({ root });
    const imported = await repository.importBuffer(bytes, metadata("https://support.example.com/tamper"));

    await expect(repository.getDocument("../../etc/passwd")).rejects.toMatchObject({ code: "invalid_id" });
    await expect(repository.getCapture("capture-sha256-../../escape")).rejects.toMatchObject({ code: "invalid_id" });
    await expect(repository.getLatestCaptureForUrl("file:///etc/passwd")).rejects.toMatchObject({ code: "invalid_input" });

    const blob = path.join(root, "blobs", "sha256", imported.document.sha256.slice(0, 2), imported.document.sha256);
    await writeFile(blob, Buffer.alloc(bytes.byteLength, 0x78));
    await expect(repository.readContent(imported.document.id)).rejects.toMatchObject({ code: "integrity_error" });
    await expect(repository.getDocument(imported.document.id)).rejects.toMatchObject({ code: "integrity_error" });

    await writeFile(blob, bytes);
    const documentFile = path.join(root, "documents", imported.document.sha256.slice(0, 2), `${imported.document.id}.json`);
    const envelope = JSON.parse(await readFile(documentFile, "utf8"));
    envelope.payload.title = "tampered title";
    await writeFile(documentFile, JSON.stringify(envelope));
    await expect(repository.getDocument(imported.document.id)).rejects.toMatchObject({ code: "corrupt_data" });
  });
});
