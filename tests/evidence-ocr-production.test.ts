import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createProductionEvidenceJobRuntime } from "../src/evidence/jobs/production";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { ProductionEvidenceServiceError } from "../scripts/price-server/evidence/services.mjs";

const NOW = "2026-08-28T12:30:00.000Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function rasterText(text: string): Buffer {
  const canvas = createCanvas(760, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  context.font = "bold 40px sans-serif";
  context.fillText(text, 30, 120);
  return canvas.toBuffer("image/jpeg", 94);
}

function pdf(objects: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n", "binary")];
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`, "ascii"), objects[index]!, Buffer.from("\nendobj\n", "ascii"));
  }
  const xref = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, "ascii"));
  for (const offset of offsets.slice(1)) parts.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`, "ascii"));
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "ascii"));
  return Buffer.concat(parts);
}

function scannedPdf(): Buffer {
  const jpeg = rasterText("MEASURE 244 MILLIMETERS");
  const content = "q\n760 0 0 200 0 0 cm\n/Im0 Do\nQ\n";
  return pdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 760 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>", "ascii"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 760 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "ascii"),
      jpeg,
      Buffer.from("\nendstream", "ascii"),
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`, "ascii"),
  ]);
}

describe("U4 official scanned-PDF evidence OCR", () => {
  it("writes one replayable OCR artifact, excerpts it, and remains restart-idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-evidence-ocr-"));
    roots.push(root);
    let timestamp = NOW;
    const now = () => timestamp;
    const coordinator = new RuntimeCoordinator({ root, now });
    await coordinator.initialize("evidence-ocr-production-test");
    const evidenceRepository = new FileEvidenceRepository({ coordinator, runtimeRoot: root, now });
    const artifactRepository = new FileArtifactRepository({ coordinator, now });
    const documentBytes = scannedPdf();
    const documentUrl = "https://dlcdnets.asus.com/pub/ASUS/mb/manual/scanned-measure-manual.pdf";
    const fetcher = async (url: string, input: { includeBody?: boolean }) => input.includeBody === true ? {
      status: 200,
      finalUrl: documentUrl,
      redirects: [],
      rawBody: documentBytes,
      body: documentBytes.toString("latin1"),
      contentType: "application/pdf",
      contentHash: createHash("sha256").update(documentBytes).digest("hex"),
      retrievedAt: NOW,
    } : {
      status: 200,
      finalUrl: url,
      redirects: [],
      body: `<a href="${documentUrl}">scanned exact model manual</a>`,
      contentType: "text/html",
      retrievedAt: NOW,
    };
    const request = {
      planId: "plan-evidence-ocr-production",
      subject: {
        brand: "ASUS",
        category: "motherboard",
        skuId: "sku-evidence-ocr-production",
        familyId: "family-evidence-ocr-production",
        modelId: "model-evidence-ocr-production",
        variantId: "retail",
        revision: "rev-a",
        region: "US",
      },
      requestedFieldIds: ["MEASURE"],
      entry: { kind: "search_query" as const, query: "ASUS scanned exact model manual" },
      allowThirdPartyFallback: false,
      requestedAt: NOW,
    };
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      coordinator,
      evidenceRepository,
      artifactRepository,
      online: () => true,
      now,
      officialFetcher: fetcher,
      rateLimiter: Object.freeze({ acquire: async () => undefined }),
      evidenceOcrFaultInjector(input: { point: string; created: boolean }) {
        if (input.point === "after_ocr_artifact" && input.created) {
          throw new ProductionEvidenceServiceError(
            "worker_interrupted",
            "Worker stopped after the idempotent OCR artifact effect",
            { retryable: true },
          );
        }
      },
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue(request);
    await runtime.scheduler.drain(30);
    const interrupted = await runtime.status(descriptor.pipelineId);
    const waiting = interrupted.stages.find(({ stage }) => stage === "parse_ocr");
    expect(waiting).toMatchObject({ status: "waiting_retry", attempt: 1 });
    expect((await artifactRepository.list()).records.filter((record: { kind: string }) => record.kind === "evidence-ocr-text"))
      .toHaveLength(1);

    if (!waiting) throw new Error("parse/OCR retry fixture is missing");
    timestamp = waiting.runAfter;
    const restartedArtifacts = new FileArtifactRepository({ coordinator, now });
    const restarted = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      coordinator,
      evidenceRepository: new FileEvidenceRepository({ coordinator, runtimeRoot: root, now }),
      artifactRepository: restartedArtifacts,
      online: () => true,
      now,
      officialFetcher: fetcher,
      rateLimiter: Object.freeze({ acquire: async () => undefined }),
    });
    await restarted.initialize();
    expect(await restarted.enqueue(request)).toEqual(descriptor);
    expect((await restarted.status(descriptor.pipelineId)).stages.find(({ stage }) => stage === "parse_ocr"))
      .toMatchObject({ status: "queued", attempt: 1 });
    await restarted.scheduler.drain(30);
    const status = await restarted.status(descriptor.pipelineId);
    const parse = status.stages.find(({ stage }) => stage === "parse_ocr")?.result;
    expect(parse).toMatchObject({
      status: "completed",
      output: {
        parseMode: "bounded_pdf_local_ocr",
        pageCount: 1,
        ocrArtifactRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      resultRefs: [expect.stringMatching(/^sha256:[a-f0-9]{64}$/)],
    });
    const excerpt = status.stages.find(({ stage }) => stage === "excerpt")?.result;
    expect(excerpt).toMatchObject({ status: "completed", output: { returned: 1 } });
    expect(JSON.stringify(status)).not.toContain("244 MILLIMETERS");

    const artifacts = await restartedArtifacts.list();
    const ocrArtifacts = artifacts.records.filter((record: { kind: string }) => record.kind === "evidence-ocr-text");
    expect(ocrArtifacts).toHaveLength(1);
    const ocrArtifact = await restartedArtifacts.get(String(parse?.output.ocrArtifactRef));
    expect(ocrArtifact?.record).toMatchObject({
      kind: "evidence-ocr-text",
      mediaType: "application/vnd.buildsim.evidence-ocr+json",
      privacyClass: "runtime_internal",
      references: [{ ref: expect.stringMatching(/^sha256:/), necessity: "required_for_replay" }],
    });
    expect(JSON.parse(Buffer.from(ocrArtifact!.bytes).toString("utf8"))).toMatchObject({
      schemaVersion: "evidence-ocr-text-v1",
      pages: [{ num: 1, text: expect.stringMatching(/MEASURE 244 MILLIMETERS/i) }],
      contentTrust: "untrusted-evidence-ocr",
    });

    expect((await restarted.scheduler.drain(30)).at(-1)?.worker.outcome).toBe("idle");
    expect(await restarted.status(descriptor.pipelineId)).toEqual(status);
    expect((await restartedArtifacts.list()).records.filter((record: { kind: string }) => record.kind === "evidence-ocr-text"))
      .toHaveLength(1);
  }, 30_000);
});
