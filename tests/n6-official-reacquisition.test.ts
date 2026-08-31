import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvidenceReacquisitionComparison,
  validateEvidenceReacquisitionComparison,
} from "../src/evidence/reacquisition-comparison.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { readJson, sha256Json } from "../src/runtime/fs.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import {
  JONSBO_N6_OFFICIAL_MANUAL_SHA256,
  JONSBO_N6_OFFICIAL_PRODUCT_URL,
  reacquireN6OfficialEvidence,
} from "../scripts/evidence/reacquire-n6-official.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const NOW = "2026-08-31T10:00:00.000Z";
const now = () => NOW;
const manualUrl = "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-n6-reacquire-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
  await coordinator.initialize("n6-reacquire-test");
  return { root, runtimeRoot, coordinator, report: path.join(root, "n6-comparison.json") };
}

describe("N6 official reacquisition", () => {
  it("uses governed official discovery and acquisition, preserves old values only as comparison, and creates no active facts", async () => {
    const test = await fixture();
    const manualBytes = await readFile(path.resolve("data/cases/jonsbo-n6/jonsbo-n6-manual.pdf"));
    expect(createHash("sha256").update(manualBytes).digest("hex")).toBe(JONSBO_N6_OFFICIAL_MANUAL_SHA256);
    const discoveryFetcher = vi.fn(async (url: string) => ({
      status: 200,
      finalUrl: url,
      redirects: [],
      body: `<html><a href="${manualUrl}">N6 Installation Manual</a></html>`,
      contentType: "text/html",
      retrievedAt: NOW,
    }));
    const acquisitionFetcher = vi.fn(async () => ({
      status: 200,
      finalUrl: manualUrl,
      redirects: [],
      rawBody: manualBytes,
      body: "",
      contentType: "application/pdf",
      contentHash: JONSBO_N6_OFFICIAL_MANUAL_SHA256,
      retrievedAt: NOW,
    }));
    const result = await reacquireN6OfficialEvidence({
      coordinator: test.coordinator,
      reportOutput: test.report,
      now,
      discoveryFetcher,
      acquisitionFetcher,
      requireFreshGeneration: false,
    });
    expect(discoveryFetcher).toHaveBeenCalledWith(JONSBO_N6_OFFICIAL_PRODUCT_URL, expect.objectContaining({ expectedBrand: "JONSBO" }));
    expect(result).toMatchObject({
      officialBrand: "JONSBO",
      documentSha256: JONSBO_N6_OFFICIAL_MANUAL_SHA256,
      kindBasis: "user-asserted",
      sourceAssessment: "official_archive_identity_unverified",
      reacquiredFieldCount: 0,
      activeFactsCreated: 0,
    });
    expect(result.legacyFieldCount).toBeGreaterThan(10);
    expect((await lstat(test.report)).mode & 0o777).toBe(0o600);
    const report = await readJson(test.report);
    expect(validateEvidenceReacquisitionComparison(report)).toEqual([]);
    expect(report.legacyFields.every(({ classification }: { classification: string }) => classification === "legacy_unverified")).toBe(true);
    expect(report.comparisons.every(({ status }: { status: string }) => status === "legacy_only")).toBe(true);
    expect(report.summary.activeFactsCreated).toBe(0);
    const graph = await createProductionReferenceGraph({ coordinator: test.coordinator, now });
    expect(graph.nodes).toContain(`evidence-document:${result.documentId}`);
    expect(graph.nodes.some((node: string) => node.startsWith("fact:"))).toBe(false);
  });

  it("compares independently reacquired candidates by value hash without granting old authority", () => {
    const documentSha256 = "a".repeat(64);
    const report = createEvidenceReacquisitionComparison({
      subject: { skuId: "case.jonsbo-n6", brand: "JONSBO", category: "case", modelId: "N6" },
      document: { id: `doc-sha256-${documentSha256}`, sha256: documentSha256 },
      capture: {
        id: `capture-sha256-${"b".repeat(64)}`,
        requestedUrl: manualUrl,
        finalUrl: manualUrl,
        officialBrand: "JONSBO",
        acquisitionMethod: "official-fetch",
        kindBasis: "content-verified",
        productIdentities: [{ basis: "official-document-explicit" }],
        retrievedAt: NOW,
      },
      legacyFields: [
        { fieldId: "physical.width", value: 305, classification: "legacy_unverified", sourceFactId: "fact.old.width" },
        { fieldId: "physical.height", value: 318, classification: "legacy_unverified", sourceFactId: "fact.old.height" },
      ],
      reacquiredFields: [
        { fieldId: "physical.width", value: 305, candidateId: `claim-candidate-sha256-${"c".repeat(64)}` },
        { fieldId: "physical.height", value: 320, candidateId: `claim-candidate-sha256-${"d".repeat(64)}` },
        { fieldId: "physical.depth", value: 353, candidateId: `claim-candidate-sha256-${"e".repeat(64)}` },
      ],
      createdAt: NOW,
    });
    expect(validateEvidenceReacquisitionComparison(report)).toEqual([]);
    expect(report.comparisons).toEqual([
      expect.objectContaining({ fieldId: "physical.depth", status: "reacquired_only" }),
      expect.objectContaining({ fieldId: "physical.height", status: "changed" }),
      expect.objectContaining({ fieldId: "physical.width", status: "matched" }),
    ]);
    expect(report.summary).toEqual({ matched: 1, changed: 1, legacyOnly: 0, reacquiredOnly: 1, activeFactsCreated: 0 });
    const forged = structuredClone(report) as unknown as Record<string, unknown>;
    (forged.comparisons as Array<Record<string, unknown>>)[0]!.status = "matched";
    const { contentHash: _ignored, ...material } = forged;
    forged.contentHash = sha256Json({ domain: "evidence-reacquisition-comparison", material });
    expect(validateEvidenceReacquisitionComparison(forged)).toContain("evidence reacquisition comparison coverage is invalid");
  });

  it("refuses to write N6 evidence into an old active generation before the fresh cutover", async () => {
    const test = await fixture();
    const discoveryFetcher = vi.fn();
    await expect(reacquireN6OfficialEvidence({
      coordinator: test.coordinator,
      reportOutput: test.report,
      now,
      discoveryFetcher,
    })).rejects.toThrow(/requires an activated fresh governed runtime generation/);
    expect(discoveryFetcher).not.toHaveBeenCalled();
    expect((await test.coordinator.readState()).revision).toBe(0);
  });
});
