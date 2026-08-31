import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireExternalReviews, EXTERNAL_REVIEW_SOURCES } from "../scripts/evidence/acquire-external-reviews";
import { validateExternalReviewDirectory } from "../scripts/release/external-reviews";

function fixtureFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  const spec = EXTERNAL_REVIEW_SOURCES.find((entry) => entry.source.url === url);
  if (!spec) return Promise.resolve(new Response("missing", { status: 404 }));
  const body = `<!doctype html><title>${spec.sourceId}</title>${spec.observations.map(({ locatorText }) => locatorText).join("\n")}`;
  return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/html" } }))
    .then((response) => Object.defineProperty(response, "url", { value: url }));
}

describe("external professional review validation gate", () => {
  it("passes independent ATX, Mini-ITX, and NAS sources while preserving missing product measurements as unknown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-external-reviews-"));
    await acquireExternalReviews(root, fixtureFetch as typeof fetch, "2026-08-31T00:00:00.000Z");
    const report = await validateExternalReviewDirectory(root);
    expect(report.status).toBe("pass");
    expect(report.layouts).toEqual(["atx", "mini_itx", "nas"]);
    expect(report.datasetHashes).toHaveLength(6);
    expect(report.unknownDomainsByLayout.atx).toContain("cable_length");
    expect(report.unknownDomainsByLayout.nas).toEqual(expect.arrayContaining(["cable_length", "temperature", "acoustic"]));
  });

  it("rejects a duplicate publisher group and a checksum-correct attempt to claim product readiness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-external-reviews-forge-"));
    await acquireExternalReviews(root, fixtureFetch as typeof fetch, "2026-08-31T00:00:00.000Z");
    const files = EXTERNAL_REVIEW_SOURCES.map(({ sourceId }) => path.join(root, `${sourceId}.json`));
    const first = JSON.parse(await readFile(files[0]!, "utf8")) as Record<string, any>;
    const second = JSON.parse(await readFile(files[1]!, "utf8")) as Record<string, any>;
    second.publisher.independenceGroupId = first.publisher.independenceGroupId;
    second.conclusion.productReadiness = "pass";
    await writeFile(files[1]!, `${JSON.stringify(second)}\n`);
    const report = await validateExternalReviewDirectory(root);
    expect(report.status).toBe("blocked");
    expect(report.errors.join("\n")).toMatch(/contentHash mismatch|product-level unknown/);
  });

  it("rejects missing archive locators and archive tampering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-external-reviews-tamper-"));
    await mkdir(root, { recursive: true });
    await acquireExternalReviews(root, fixtureFetch as typeof fetch, "2026-08-31T00:00:00.000Z");
    const dataset = JSON.parse(await readFile(path.join(root, `${EXTERNAL_REVIEW_SOURCES[0]!.sourceId}.json`), "utf8")) as any;
    await writeFile(path.join(root, dataset.source.archiveFile), "tampered");
    const report = await validateExternalReviewDirectory(root);
    expect(report.status).toBe("blocked");
    expect(report.errors).toContain("external review archive hash mismatch");
  });
});
