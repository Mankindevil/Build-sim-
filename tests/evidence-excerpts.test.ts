import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVIDENCE_EXCERPT_LIMITS } from "../src/evidence/excerpts.mjs";
import { handleEvidenceRoute } from "../src/evidence/http-routes.mjs";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repositoryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evidence-excerpts-"));
  roots.push(root);
  return new FileEvidenceRepository({ root, now: () => "2026-08-27T00:00:00.000Z" });
}

async function archive(repository: FileEvidenceRepository, bytes: Buffer, mediaType: string, suffix: string) {
  return repository.importBuffer(bytes, {
    mediaType,
    kind: "manufacturer-manual",
    title: `Excerpt fixture ${suffix}`,
    productIdentities: [{ brand: "Fixture", model: suffix }],
    capture: {
      requestedUrl: `https://www.asus.com/support/${suffix}`,
      finalUrl: `https://www.asus.com/support/${suffix}`,
      retrievedAt: "2026-08-27T00:00:00.000Z",
      status: 200,
      redirects: [],
      officialBrand: "ASUS",
      acquisitionMethod: "bundled-import",
    },
  });
}

function emptyPdf(pageCount: number): Buffer {
  const pageObjectStart = 3;
  const pageIds = Array.from({ length: pageCount }, (_, index) => pageObjectStart + index);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...pageIds.map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"),
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

describe("bounded archived evidence excerpts", () => {
  it("returns only bounded page-numbered text windows without network or write behavior", async () => {
    const repository = await repositoryFixture();
    const bytes = Buffer.from([
      `Introduction ${"unrelated ".repeat(180)}DO_NOT_RETURN_THE_WHOLE_FIRST_PAGE`,
      `Installation notes ${"spacing ".repeat(90)}The ATX power supply mounts in the rear upper chamber. ${"afterword ".repeat(180)}DO_NOT_RETURN_THE_WHOLE_SECOND_PAGE`,
    ].join("\f"));
    const stored = await archive(repository, bytes, "text/plain; charset=utf-8", "bounded-text.txt");
    const network = vi.fn(async () => { throw new Error("network must not be used"); });
    vi.stubGlobal("fetch", network);

    const response = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${stored.document.id}/excerpts`,
      { query: "ATX power supply", page: 2, limit: 2 },
      repository,
    );

    expect(response).toMatchObject({
      handled: true,
      status: 200,
      payload: {
        documentId: stored.document.id,
        contentHash: stored.document.sha256,
        requestedPage: 2,
        totalPages: 2,
        searchedPageCount: 1,
        extractionMode: "utf8-text",
        contentTrust: "untrusted-evidence-text",
        returned: 1,
        excerpts: [{ page: 2, matchType: "exact", text: expect.stringContaining("rear upper chamber") }],
      },
    });
    expect(JSON.stringify(response.payload)).not.toContain("DO_NOT_RETURN_THE_WHOLE_FIRST_PAGE");
    expect(JSON.stringify(response.payload)).not.toContain("DO_NOT_RETURN_THE_WHOLE_SECOND_PAGE");
    expect(Buffer.byteLength(JSON.stringify(response.payload))).toBeLessThanOrEqual(EVIDENCE_EXCERPT_LIMITS.maxOutputBytes);
    expect(network).not.toHaveBeenCalled();
  });

  it("extracts one requested PDF page through the real parser and preserves its archive hash", async () => {
    const repository = await repositoryFixture();
    const bytes = await readFile(path.resolve("data/boards/asus-w680m-ace-se/asus-w680m-manual.pdf"));
    const stored = await archive(repository, bytes, "application/pdf", "w680m-manual.pdf");

    const response = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${stored.document.id}/excerpts`,
      { query: "LGA1700 socket", page: 16, limit: 2 },
      repository,
    );

    expect(response).toMatchObject({
      status: 200,
      payload: {
        contentHash: stored.document.sha256,
        requestedPage: 16,
        totalPages: 62,
        searchedPageCount: 1,
        extractionMode: "pdf-text-layer",
        excerpts: [{ page: 16, text: expect.stringMatching(/LGA1700 socket/i) }],
      },
    });
    expect(Buffer.byteLength(JSON.stringify(response.payload))).toBeLessThanOrEqual(EVIDENCE_EXCERPT_LIMITS.maxOutputBytes);
  });

  it("returns explicit errors for malformed PDFs and rejects oversized sources before extraction", async () => {
    const repository = await repositoryFixture();
    const malformed = await archive(repository, Buffer.from("not actually a PDF"), "application/pdf", "malformed.pdf");
    const failed = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${malformed.document.id}/excerpts`,
      { query: "power supply" },
      repository,
    );
    expect(failed).toMatchObject({
      status: 422,
      payload: {
        error: "evidence_pdf_parse_failed",
        manualAction: expect.stringContaining("no network fallback"),
      },
    });

    const text = await archive(repository, Buffer.from("power supply ".repeat(20)), "text/plain", "too-large.txt");
    const oversized = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${text.document.id}/excerpts`,
      { query: "power supply" },
      repository,
      { excerptOptions: { maxSourceBytes: 32 } },
    );
    expect(oversized).toMatchObject({ status: 413, payload: { error: "evidence_excerpt_source_too_large" } });
  });

  it("requires an explicit page for oversized page sets and hard-terminates timed-out parser workers", async () => {
    const repository = await repositoryFixture();
    const manyPages = await archive(
      repository,
      emptyPdf(EVIDENCE_EXCERPT_LIMITS.maxPdfPagesWithoutSelection + 1),
      "application/pdf",
      "many-pages.pdf",
    );
    const pageRequired = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${manyPages.document.id}/excerpts`,
      { query: "power supply" },
      repository,
    );
    expect(pageRequired).toMatchObject({
      status: 422,
      payload: { error: "evidence_excerpt_page_required", manualAction: expect.stringContaining("explicit page") },
    });

    const hangingWorker = new URL("data:text/javascript,setInterval(() => {}, 1000)");
    const startedAt = Date.now();
    const timedOut = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${manyPages.document.id}/excerpts`,
      { query: "power supply", page: 1 },
      repository,
      { excerptOptions: { pdfTimeoutMs: 100, pdfWorkerUrl: hangingWorker } },
    );
    expect(timedOut).toMatchObject({
      status: 504,
      payload: { error: "evidence_pdf_parse_timeout", message: expect.stringContaining("worker was terminated") },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds query and page inputs before returning archived text", async () => {
    const repository = await repositoryFixture();
    const stored = await archive(repository, Buffer.from("ATX power supply"), "text/plain", "validation.txt");
    const read = vi.spyOn(repository, "getDocumentContent");

    const query = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${stored.document.id}/excerpts`,
      { query: "x".repeat(EVIDENCE_EXCERPT_LIMITS.maxQueryCharacters + 1) },
      repository,
    );
    expect(query).toMatchObject({ status: 400, payload: { error: "evidence_excerpt_query_invalid" } });
    expect(read).not.toHaveBeenCalled();

    const page = await handleEvidenceRoute(
      "POST",
      `/api/evidence/documents/${stored.document.id}/excerpts`,
      { query: "power supply", page: 2 },
      repository,
    );
    expect(page).toMatchObject({ status: 416, payload: { error: "evidence_excerpt_page_out_of_range" } });
  });
});
