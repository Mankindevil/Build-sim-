import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { readJson } from "../src/runtime/fs.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import {
  RELEASE_OFFICIAL_SOURCES,
  reacquireReleaseOfficialEvidence,
  validateReleaseOfficialReacquisition,
} from "../scripts/evidence/reacquire-release-official.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const NOW = "2026-08-31T11:00:00.000Z";
const manualUrl = "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf";

describe("release official evidence reacquisition", () => {
  it("archives all five official sources in a fresh-schema repository without promoting unreviewed facts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-release-official-"));
    roots.push(root);
    const runtimeRoot = path.join(root, "runtime");
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => NOW });
    await coordinator.initialize("release-official-reacquisition-test");
    const reportOutput = path.join(root, "official-reacquisition.json");
    const discoveryFetcher = vi.fn(async (url: string) => ({
      status: 200,
      finalUrl: url,
      redirects: [],
      body: `<a href="${manualUrl}">N6 Installation Manual</a>`,
      contentType: "text/html",
      retrievedAt: NOW,
    }));
    const acquisitionFetcher = vi.fn(async (url: string) => {
      const rawBody = Buffer.from(`official fixture bytes for ${url}`, "utf8");
      return {
        status: 200,
        finalUrl: url,
        redirects: [],
        rawBody,
        body: "",
        contentType: url.includes(".pdf") ? "application/pdf" : "text/html",
        contentHash: createHash("sha256").update(rawBody).digest("hex"),
        retrievedAt: NOW,
      };
    });

    const result = await reacquireReleaseOfficialEvidence({
      coordinator,
      reportOutput,
      now: () => NOW,
      discoveryFetcher,
      acquisitionFetcher,
      requireFreshGeneration: false,
    });
    expect(validateReleaseOfficialReacquisition(result)).toEqual([]);
    expect(result.entries.map(({ skuId }) => skuId)).toEqual([
      "board.asus-w680m-ace-se",
      "case.jonsbo-n6",
      "cpu.i5-14500",
      "psu.seasonic-focus-plus-gold-850-fx",
      "storage.samsung-980-pro",
    ]);
    expect(result.entries.every(({ identityStatus }) => identityStatus === "official_archive_identity_unverified")).toBe(true);
    expect(result.activeFactsCreated).toBe(0);
    expect(acquisitionFetcher).toHaveBeenCalledTimes(RELEASE_OFFICIAL_SOURCES.length + 1);
    expect((await lstat(reportOutput)).mode & 0o777).toBe(0o600);
    expect(validateReleaseOfficialReacquisition(await readJson(reportOutput))).toEqual([]);
    const graph = await createProductionReferenceGraph({ coordinator, now: () => NOW });
    expect(graph.nodes.filter((node: string) => node.startsWith("evidence-document:"))).toHaveLength(5);
    expect(graph.nodes.some((node: string) => node.startsWith("fact:"))).toBe(false);
  });
});
