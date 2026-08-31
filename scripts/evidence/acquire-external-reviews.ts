#!/usr/bin/env -S vite-node

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createExternalReviewValidationDataset,
  validateExternalReviewValidationDataset,
  type ExternalReviewObservation,
  type ExternalReviewValidationMaterial,
} from "../../src/release/external-review-validation";

const USER_AGENT = "BuildSimEvidenceBot/1.0 (+https://build-sim.66-245-218-148.sslip.io)";
const MAX_BYTES = 8 * 1024 * 1024;
const RETRIEVED_AT = new Date().toISOString();

type SourceSpec = Omit<ExternalReviewValidationMaterial, "schemaVersion" | "tuningStatus" | "source" | "conclusion"> & {
  source: Omit<ExternalReviewValidationMaterial["source"], "retrievedAt" | "archiveFile" | "archiveSha256">;
};

const unknown = (domain: ExternalReviewObservation["domain"], notes: string): ExternalReviewObservation => ({
  domain, status: "not_reported", value: null, unit: null, locatorText: "not reported", notes,
});
const reported = (domain: ExternalReviewObservation["domain"], locatorText: string, notes: string): ExternalReviewObservation => ({
  domain, status: "reported_without_numeric_value", value: null, unit: null, locatorText, notes,
});
const measured = (
  domain: ExternalReviewObservation["domain"], value: number, unit: NonNullable<ExternalReviewObservation["unit"]>,
  locatorText: string, notes: string,
): ExternalReviewObservation => ({ domain, status: "measured", value, unit, locatorText, notes });

export const EXTERNAL_REVIEW_SOURCES: readonly SourceSpec[] = Object.freeze([
  {
    sourceId: "gamersnexus-meshify3-2025", layout: "atx",
    publisher: { publisherId: "gamersnexus", independenceGroupId: "gamersnexus", name: "GamersNexus", editorialControl: "independent" },
    caseIdentity: { skuId: "fractal-meshify-3", modelId: "Meshify-3", revision: "reviewed-2025", region: "global" },
    source: { url: "https://gamersnexus.net/cases/new-best-fractal-meshify-3-case-review-thermal-benchmarks-noise", title: "A New Best: Fractal Meshify 3 Case Review, Thermal Benchmarks, & Noise", publishedAt: "2025-05-15T00:00:00.000Z", mediaType: "text/html" },
    method: { summary: "Independent case review with dimensional inspection, controlled thermal workloads, and noise-normalized acoustic testing.", instrument: null, calibrationRef: null, referenceDistanceM: 1, ambientC: null },
    observations: [
      measured("clearance", 30, "mm", "uniform depth at just over 3cm", "Reviewer-measured rear cable-management depth; not a universal internal-clearance pass."),
      unknown("cable_length", "No bounded cable-length measurement was published."),
      measured("temperature", 40, "c", "40 degrees Celsius over ambient", "CPU temperature delta in the cited workload; configuration-specific."),
      measured("acoustic", 37.5, "dba", "37.5 dBA", "Noise-normalized review condition; configuration-specific."),
    ],
  },
  {
    sourceId: "tomshardware-antec-p70-2015", layout: "atx",
    publisher: { publisherId: "tomshardware", independenceGroupId: "future-plc-tomshardware", name: "Tom's Hardware", editorialControl: "independent" },
    caseIdentity: { skuId: "antec-p70", modelId: "P70", revision: "reviewed-2015", region: "global" },
    source: { url: "https://www.tomshardware.com/reviews/antec-p70-atx-mid-tower-case%2C4122-4.html", title: "Antec P70 ATX Mid-Tower Case Review — How We Test Cases", publishedAt: "2015-05-15T07:00:00.000Z", mediaType: "text/html" },
    method: { summary: "Independent ATX case test protocol documents half-metre acquisition corrected to the one-metre convention.", instrument: "Galaxy CM-140 SPL meter", calibrationRef: null, referenceDistanceM: 1, ambientC: null },
    observations: [
      unknown("clearance", "This page did not publish a bounded clearance result used by this validation set."),
      unknown("cable_length", "No bounded cable-length measurement was published."),
      unknown("temperature", "Thermal result was not extracted as a product-level measurement in this validation set."),
      reported("acoustic", "Noise is measured .5m from the case", "Method is independently documented, but no numeric value is promoted by this dataset."),
    ],
  },
  {
    sourceId: "gamersnexus-a4h2o-2023", layout: "mini_itx",
    publisher: { publisherId: "gamersnexus", independenceGroupId: "gamersnexus", name: "GamersNexus", editorialControl: "independent" },
    caseIdentity: { skuId: "dan-a4-h2o", modelId: "A4-H2O", revision: "reviewed-2023", region: "global" },
    source: { url: "https://gamersnexus.net/cases/water-cooled-mini-itx-review-dan-case-a4-h2o-thermals-noise-cable-management", title: "Water Cooled Mini-ITX Review: Dan Case A4-H2O Thermals, Noise, & Cable Management", publishedAt: "2023-10-10T00:00:00.000Z", mediaType: "text/html" },
    method: { summary: "Independent Mini-ITX build review with explicit cooler clearance, controlled thermal delta, and acoustic measurement.", instrument: null, calibrationRef: null, referenceDistanceM: 1, ambientC: null },
    observations: [
      measured("clearance", 55, "mm", "CPU cooler clearance is only 55mm", "Published case clearance; exact component fit remains configuration-specific."),
      reported("cable_length", "A lack of cable management features makes tidy builds more difficult", "Cable-management difficulty was reported without a bounded required length."),
      measured("temperature", 57, "c", "57C delta T over ambient", "CPU temperature delta in the cited workload; configuration-specific."),
      measured("acoustic", 36.5, "dba", "36.5dbA", "Measured review configuration; not a product-wide acoustic pass."),
    ],
  },
  {
    sourceId: "tomshardware-pcq34-2016", layout: "mini_itx",
    publisher: { publisherId: "tomshardware", independenceGroupId: "future-plc-tomshardware", name: "Tom's Hardware", editorialControl: "independent" },
    caseIdentity: { skuId: "lianli-pc-q34", modelId: "PC-Q34", revision: "reviewed-2016", region: "global" },
    source: { url: "https://www.tomshardware.com/reviews/lian-li-case-pc-q34-mini-itx-review%2C4760-2.html", title: "Lian Li PC-Q34 Mini ITX Case Review — Benchmarks & Conclusion", publishedAt: "2016-10-05T13:00:00.000Z", mediaType: "text/html" },
    method: { summary: "Independent two-hour full-load Mini-ITX protocol with controlled ambient and one-metre-corrected acoustics.", instrument: "Galaxy CM-140 SPL meter", calibrationRef: null, referenceDistanceM: 1, ambientC: 26 },
    observations: [
      unknown("clearance", "No bounded clearance observation was extracted."),
      unknown("cable_length", "No bounded cable-length measurement was published."),
      reported("temperature", "ambient air temperature for the test was maintained at approximately 26", "Controlled ambient is documented; no product-level thermal value is promoted here."),
      reported("acoustic", "corrected to 1 m (-6 dB), dBA weighting", "The independent acoustic method is documented; no numeric product value is promoted here."),
    ],
  },
  {
    sourceId: "servethehome-thecus-n7710g-2014", layout: "nas",
    publisher: { publisherId: "servethehome", independenceGroupId: "servethehome", name: "ServeTheHome", editorialControl: "independent" },
    caseIdentity: { skuId: "thecus-n7710-g", modelId: "N7710-G", revision: "reviewed-2014", region: "global" },
    source: { url: "https://www.servethehome.com/thecus-n7710-g-review-7-bay-nas-10gb-ethernet/", title: "Thecus N7710-G Review — 7 bay NAS with 10Gb Ethernet", publishedAt: "2014-08-12T05:26:30.000Z", mediaType: "text/html" },
    method: { summary: "Independent NAS review documents enclosure dimensions and an acoustic setup using a NIST-calibrated meter.", instrument: "NIST calibrated Extech sound meter", calibrationRef: "publisher-declared NIST calibration", referenceDistanceM: 0.4572, ambientC: null },
    observations: [
      measured("clearance", 320, "mm", "320 x 210 x 270 (mm) chassis came", "Reviewer-described chassis depth; not an internal component-clearance pass."),
      unknown("cable_length", "No bounded cable-length measurement was published."),
      unknown("temperature", "No numeric measured thermal observation was extracted."),
      reported("acoustic", "34dba ambient environment at 18 inches", "Acoustic method is in text; the numeric device result is image-only and therefore remains unknown."),
    ],
  },
  {
    sourceId: "storagereview-synology-ds216plus-2016", layout: "nas",
    publisher: { publisherId: "storagereview", independenceGroupId: "storagereview", name: "StorageReview", editorialControl: "independent" },
    caseIdentity: { skuId: "synology-ds216plus", modelId: "DS216-plus", revision: "reviewed-2016", region: "global" },
    source: { url: "https://www.storagereview.com/review/synology-diskstation-ds216-review", title: "Synology DiskStation DS216+ Review", publishedAt: "2016-06-15T17:25:19.000Z", mediaType: "text/html" },
    method: { summary: "Independent NAS review archived as a second publisher; listed vendor dimensions/noise are not promoted as reviewer measurements.", instrument: null, calibrationRef: null, referenceDistanceM: null, ambientC: null },
    observations: [
      reported("clearance", "Dimensions: 165mm x 108mm x 233.2mm", "Listed product dimensions are retained as context, not treated as independent measurement."),
      unknown("cable_length", "No bounded cable-length measurement was published."),
      unknown("temperature", "No numeric reviewer-measured thermal observation was extracted."),
      reported("acoustic", "Noise Level: 18.2dB", "Listed noise specification is retained as context, not treated as reviewer measurement."),
    ],
  },
]);

export async function acquireExternalReviews(
  outputDirectory: string,
  fetcher: typeof fetch = fetch,
  retrievedAt = RETRIEVED_AT,
): Promise<{ datasetHashes: string[]; archiveHashes: string[] }> {
  const output = path.resolve(outputDirectory);
  const archives = path.join(output, "archives");
  await mkdir(archives, { recursive: true, mode: 0o700 });
  const datasetHashes: string[] = [];
  const archiveHashes: string[] = [];
  for (const spec of EXTERNAL_REVIEW_SOURCES) {
    const response = await fetcher(spec.source.url, { redirect: "follow", headers: { "user-agent": USER_AGENT, accept: "text/html" } });
    if (!response.ok) throw new Error(`external review fetch failed (${response.status}): ${spec.source.url}`);
    const final = new URL(response.url || spec.source.url);
    if (final.protocol !== "https:" || final.hostname !== new URL(spec.source.url).hostname) throw new Error(`external review redirect escaped its publisher: ${spec.source.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new Error(`external review archive size is invalid: ${spec.source.url}`);
    const body = bytes.toString("utf8");
    for (const observation of spec.observations) {
      if (observation.status !== "not_reported" && !body.includes(observation.locatorText)) {
        throw new Error(`external review locator is missing (${observation.domain}): ${spec.source.url}`);
      }
    }
    const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
    const archiveFile = `archives/sha256-${archiveSha256}.html`;
    await writeFile(path.join(output, archiveFile), bytes, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const missingDomains = spec.observations.filter(({ status }) => status !== "measured").map(({ domain }) => domain).sort();
    const dataset = await createExternalReviewValidationDataset({
      ...spec,
      schemaVersion: "external-review-validation-v1",
      tuningStatus: "not_used_for_tuning",
      source: { ...spec.source, retrievedAt, archiveFile, archiveSha256 },
      conclusion: { productReadiness: "unknown", eligibleForProductPass: false, missingDomains },
    });
    const errors = await validateExternalReviewValidationDataset(dataset);
    if (errors.length) throw new Error(`external review dataset failed validation: ${errors.join("; ")}`);
    const target = path.join(output, `${dataset.sourceId}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(dataset, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    datasetHashes.push(dataset.contentHash);
    archiveHashes.push(archiveSha256);
  }
  return { datasetHashes: datasetHashes.sort(), archiveHashes: [...new Set(archiveHashes)].sort() };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const output = process.argv[2] ?? "runtime/release-evidence/external-reviews";
  acquireExternalReviews(output).then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "external review acquisition failed"}\n`);
    process.exitCode = 1;
  });
}
