import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAuditHash } from "../src/agent/audit";
import {
  type AgentToolContext,
} from "../src/agent/contracts";
import type { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import { AgentWriteApprovalAuthority } from "../src/agent/write-approval-authority";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import {
  createProductionAttachmentInspectionAdapters,
  ProductionOcrInspector,
  ProductionPdfInspector,
} from "../src/attachments/production-inspection-adapters";
import { createProductionGovernedAgentActions } from "../src/attachments/production-actions";
import { inspectAttachmentBytes } from "../src/attachments/security";
import { StagedAttachmentUploadRepository } from "../src/attachments/staged-upload-repository";
import { runDoctor } from "../src/doctor/runner.mjs";
import { FilePlanAgentContextAuditStore } from "../src/plans/agent-context-audit";
import { hashPlanConfig } from "../src/plans/canonical";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanRepository } from "../src/plans/file-repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { confined } from "../src/runtime/fs.mjs";
import { stageAgentAttachmentUpload } from "../src/server/agent-server";
import { createBuildSimTools } from "../src/server/domain-tools";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function rasterFixture(mediaType: "image/png" | "image/jpeg", text = "BUILD SIM 42"): Buffer {
  const canvas = createCanvas(640, 180);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  context.font = "bold 58px sans-serif";
  context.fillText(text, 24, 112);
  return mediaType === "image/png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", 92);
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

function textPdfFixture(text = "BUILD SIM PDF 42"): Buffer {
  const content = `BT /F1 36 Tf 40 100 Td (${text}) Tj ET\n`;
  return pdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "ascii"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>", "ascii"),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`, "ascii"),
  ]);
}

function scannedPdfFixture(text = "BUILD SIM SCAN 42"): Buffer {
  const jpeg = rasterFixture("image/jpeg", text);
  const content = "q\n640 0 0 180 0 0 cm\n/Im0 Do\nQ\n";
  return pdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 180] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>", "ascii"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 640 /Height 180 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "ascii"),
      jpeg,
      Buffer.from("\nendstream", "ascii"),
    ]),
    Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`, "ascii"),
  ]);
}

function defaultLimits() {
  return {
    maxBytes: 20 * 1024 * 1024,
    maxWidthPixels: 16_384,
    maxHeightPixels: 16_384,
    maxPixels: 40_000_000,
    maxPages: 64,
    maxDecodedBytes: 160 * 1024 * 1024,
    maxDecompressionRatio: 200,
    maxExtractedTextBytes: 64 * 1024,
    processingTimeoutMs: 12_000,
  } as const;
}

describe("U4 production attachment decoders", () => {
  it("performs a real JPEG pixel decode and bounded PDF page/text inspection", async () => {
    const adapters = createProductionAttachmentInspectionAdapters();
    const jpeg = rasterFixture("image/jpeg");
    const image = await inspectAttachmentBytes({ bytes: jpeg, declaredMediaType: "image/jpeg", adapters });
    expect(image).toMatchObject({
      accepted: true,
      mediaType: "image/jpeg",
      widthPixels: 640,
      heightPixels: 180,
      decodedBytes: 640 * 180 * 4,
      actualDecodeValidated: true,
    });

    const document = await inspectAttachmentBytes({
      bytes: textPdfFixture(),
      declaredMediaType: "application/pdf",
      extractText: true,
      adapters,
    });
    expect(document).toMatchObject({
      accepted: true,
      mediaType: "application/pdf",
      pageCount: 1,
      actualDecodeValidated: true,
      extraction: { text: expect.stringContaining("BUILD SIM PDF 42"), contentTrust: "untrusted_user_attachment" },
    });
  });

  it.each([
    ["PNG", "image/png", () => rasterFixture("image/png", "PNG SAMPLE"), /PNG SAMPLE/i],
    ["JPEG", "image/jpeg", () => rasterFixture("image/jpeg", "JPEG SAMPLE"), /JPEG SAMPLE/i],
    ["PDF", "application/pdf", () => scannedPdfFixture("PDF SAMPLE"), /PDF SAMPLE/i],
  ] as const)("recognizes actual %s pixels with local OCR data", async (_label, mediaType, fixture, expected) => {
    const inspected = await inspectAttachmentBytes({
      bytes: fixture(),
      declaredMediaType: mediaType,
      extractText: true,
      adapters: createProductionAttachmentInspectionAdapters(),
      limits: { processingTimeoutMs: 20_000 },
    });
    expect(inspected.extraction?.text).toMatch(expected);
    expect(inspected.extraction?.confidence).toBeGreaterThan(0.5);
  });

  it("honors cancellation and every adapter-side output cap fail-closed", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(new ProductionOcrInspector().extract({
      bytes: rasterFixture("image/png"),
      mediaType: "image/png",
      signal: aborted.signal,
      limits: defaultLimits(),
    })).rejects.toMatchObject({ code: "processing_timeout" });

    await expect(new ProductionPdfInspector().inspect({
      bytes: textPdfFixture("A".repeat(2_000)),
      mediaType: "application/pdf",
      extractText: true,
      signal: new AbortController().signal,
      limits: { ...defaultLimits(), maxExtractedTextBytes: 8 },
    })).rejects.toMatchObject({ code: "extracted_text_too_large" });
  });
});

describe("U4 production Agent attachment composition", () => {
  it("stages, archives and OCR-inspects a real JPEG through the production Tool registry defaults", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-production-attachment-"));
    roots.push(root);
    const now = () => new Date().toISOString();
    const coordinator = new RuntimeCoordinator({ root, now });
    await coordinator.initialize("attachment-production-adapters-test");
    const plans = new FilePlanRepository({ coordinator, now, id: () => "plan-production-attachment" });
    const plan = await plans.create({ name: "Production attachment", config: createDefaultN6Config("draft-production-attachment", now()) });
    const sessionId = "session-production-attachment";
    const runId = "run-production-attachment";
    const contextAuditStore = new FilePlanAgentContextAuditStore({ coordinator });
    const contextAuditLease = await coordinator.acquireMaintenanceLease("attachment-production-context-fixture");
    await contextAuditStore.putWithMaintenanceLease({
      schemaVersion: "1.0.0",
      sessionId,
      runId,
      planId: plan.id,
      planVersionId: plan.activeVersionId,
      draftRevision: plan.draftRevision,
      configHash: await hashPlanConfig(plan.draft.config),
      evaluationHash: "d".repeat(64),
      spatialSelection: null,
      contextHash: "c".repeat(64),
      recordedAt: now(),
    }, contextAuditLease.token);
    await coordinator.releaseMaintenanceLease(contextAuditLease.token);
    const governed = createProductionGovernedAgentActions({ coordinator, runtimeRoot: root, now });
    const jpeg = rasterFixture("image/jpeg", "BUILD SIM AGENT 42");
    const getSession = vi.fn(async () => ({ id: sessionId }));
    const staged = await stageAgentAttachmentUpload(
      { sessionId, mediaType: "image/jpeg; charset=binary", bytes: jpeg },
      { getSession } as unknown as AgentRuntime,
      governed.stagedUploads,
    );
    expect(staged).toMatchObject({ status: 201, payload: { uploadId: expect.any(String), mediaType: "image/jpeg" } });
    expect(getSession).toHaveBeenCalledWith(sessionId);
    const uploadId = String((staged.payload as { uploadId: string }).uploadId);

    const registry = new AgentToolRegistry(createBuildSimTools({ attachmentActions: governed.attachmentActions }));
    const archiveInput = { uploadId, deletionPolicy: "retain_until_user_deletes" as const };
    const authority = new AgentWriteApprovalAuthority(governed.artifacts, { now });
    const requested = await authority.request({
      runId,
      sessionId,
      call: { id: "call-production-attachment", name: "archive_user_attachment", input: archiveInput },
      toolTitle: "归档用户附件",
      toolDefinitionHash: registry.definitionHash("archive_user_attachment"),
    });
    const confirmed = await authority.confirm({
      authorityRef: requested.authorityRef,
      runId,
      approvalId: requested.pending.approvalId,
      nonce: requested.pending.nonce,
      approvedBy: "reviewer-production-attachment",
    });
    const authorization = await authority.authorize(confirmed.authorityRef, {
      toolName: "archive_user_attachment",
      toolDefinitionHash: registry.definitionHash("archive_user_attachment"),
      sessionId,
      runId,
      inputHash: agentAuditHash(archiveInput),
      callId: "call-production-attachment",
    });
    if (!authorization) throw new Error("fixture approval was not authorized");
    const baseContext: AgentToolContext = {
      sessionId,
      runId,
      buildConfig: plan.draft.config,
      signal: new AbortController().signal,
      approval: authorization.envelope,
      writeApprovalProof: authorization.proof,
    };
    const archived = await registry.dispatch("archive_user_attachment", archiveInput, baseContext);
    expect(archived.result).toMatchObject({
      ok: true,
      content: {
        status: "archived_private_plan_attachment",
        inspection: { mediaType: "image/jpeg", actualDecodeValidated: true, widthPixels: 640, heightPixels: 180 },
      },
    });
    const attachmentId = String((archived.result.content as { attachmentId: string }).attachmentId);

    const { approval: _writeApproval, ...readContext } = baseContext;
    const inspected = await registry.dispatch("inspect_attachment", { attachmentId, extractText: true }, readContext);
    expect(inspected.result).toMatchObject({
      ok: true,
      content: {
        attachmentId,
        planId: plan.id,
        extraction: { text: expect.stringMatching(/BUILD SIM AGENT/i), contentTrust: "untrusted_user_attachment" },
      },
    });
  }, 30_000);

  it("keeps an after-blob upload crash as an unclaimable GC leaf across Doctor and backup/restore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-staged-blob-crash-"));
    roots.push(root);
    const now = () => "2026-08-28T08:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now });
    await coordinator.initialize("staged-blob-crash-test");
    await new FileArtifactRepository({ coordinator, now }).initialize();
    const bytes = rasterFixture("image/png", "PRIVATE CRASH LEAF");
    const crashing = new StagedAttachmentUploadRepository({
      coordinator,
      now,
      id: () => "upload-after-blob-crash",
      faultInjector(point) { if (point === "after_blob_write") throw new Error("injected after_blob_write crash"); },
    });
    await expect(crashing.put({ sessionId: "session-after-blob-crash", bytes, mediaType: "image/png" }))
      .rejects.toThrow("injected after_blob_write crash");

    const hash = createHash("sha256").update(bytes).digest("hex");
    const state = await coordinator.readState();
    const orphan = confined(coordinator.activeRoot(state), "attachments", "staged", "blobs", "sha256", hash.slice(0, 2), hash);
    await expect(readFile(orphan)).resolves.toEqual(bytes);
    const restarted = new StagedAttachmentUploadRepository({ coordinator, now });
    await expect(restarted.resolve("upload-after-blob-crash", "session-after-blob-crash")).resolves.toBeNull();
    await expect(restarted.claim("upload-after-blob-crash", "session-after-blob-crash", "approved-consumer"))
      .resolves.toBeNull();

    const doctor = await runDoctor({ coordinator, now });
    expect(doctor.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "pass" });
    expect(doctor.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure"))
      .toMatchObject({ status: "pass" });

    const backup = path.join(root, "staged-orphan.backup");
    await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password", now });
    const verified = await verifyBackup({ inputFile: backup, password: "a sufficiently long password", now });
    expect(verified).toMatchObject({ valid: true });
    expect(verified.manifest.entries).toContainEqual(expect.objectContaining({
      logicalPath: `attachments/staged/blobs/sha256/${hash.slice(0, 2)}/${hash}`,
    }));
    await restoreBackup({ coordinator, inputFile: backup, password: "a sufficiently long password", now });
    const restored = new StagedAttachmentUploadRepository({ coordinator, now });
    await expect(restored.resolve("upload-after-blob-crash", "session-after-blob-crash")).resolves.toBeNull();
    expect((await runDoctor({ coordinator, now })).report.checks.find(
      (check: { checkId: string }) => check.checkId === "integrity.reference_closure",
    )).toMatchObject({ status: "pass" });
  }, 30_000);
});
