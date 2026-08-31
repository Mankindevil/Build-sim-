#!/usr/bin/env node

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { acquireOfficialEvidence } from "../../src/evidence/acquire.mjs";
import { discoverOfficialDocumentLinks } from "../../src/evidence/discovery.mjs";
import { createEvidenceReacquisitionComparison } from "../../src/evidence/reacquisition-comparison.mjs";
import { FileEvidenceRepository } from "../../src/evidence/repository.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, isInside, pathExists } from "../../src/runtime/fs.mjs";

export const JONSBO_N6_OFFICIAL_PRODUCT_URL = "https://www.jonsbo.com/en/products/N6Black.html";
export const JONSBO_N6_OFFICIAL_MANUAL_SHA256 = "15f026946a18b5e4fc0ebf585f8b60ed8e3044f41efe699326adfa0ee3d480cd";
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parse(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--runtime-root", "--report-output", "--product-url"].includes(key)) throw new TypeError(`unknown N6 reacquisition argument: ${key}`);
    if (values.has(key)) throw new TypeError(`${key} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${key} requires a value`);
    values.set(key, value);
    index += 1;
  }
  if (!values.get("--runtime-root") || !values.get("--report-output")) throw new TypeError("--runtime-root and --report-output are required");
  return {
    runtimeRoot: path.resolve(values.get("--runtime-root")),
    reportOutput: path.resolve(values.get("--report-output")),
    productUrl: values.get("--product-url") ?? JONSBO_N6_OFFICIAL_PRODUCT_URL,
  };
}

async function legacyN6Fields(adapterFile = path.join(MODULE_ROOT, "data/cases/jonsbo-n6/adapter.json")) {
  const adapter = JSON.parse(await readFile(adapterFile, "utf8"));
  if (!Array.isArray(adapter.factInputs)) throw new Error("legacy N6 adapter fact inventory is invalid");
  return adapter.factInputs.map((fact) => ({
    fieldId: fact.field,
    value: fact.value,
    sourceFactId: fact.factId,
    // The old seed may say `authority: official`, but this comparison does
    // not inherit that assertion. Only the new reviewed promotion path may
    // grant official fact authority.
    classification: "legacy_unverified",
  }));
}

export async function reacquireN6OfficialEvidence(options) {
  const {
    coordinator,
    reportOutput,
    productUrl = JONSBO_N6_OFFICIAL_PRODUCT_URL,
    now = () => new Date().toISOString(),
    discoveryFetcher,
    acquisitionFetcher,
    requireFreshGeneration = true,
    adapterFile,
  } = options ?? {};
  if (!coordinator || typeof reportOutput !== "string") throw new TypeError("N6 official reacquisition requires coordinator and report output");
  const state = await coordinator.readState();
  const activeRoot = coordinator.activeRoot(state);
  if (requireFreshGeneration && !await pathExists(confined(activeRoot, "migrations", "fresh-governed-rebuild-v1", "manifest.json"))) {
    throw new Error("N6 official reacquisition requires an activated fresh governed runtime generation");
  }
  const resolvedReport = path.resolve(reportOutput);
  if (isInside(coordinator.root, resolvedReport)) throw new Error("N6 reacquisition comparison report must be stored outside the runtime root");

  const discovery = await discoverOfficialDocumentLinks(productUrl, {
    queryTokens: ["N6", "installation", "manual"],
    limit: 8,
    followPageLimit: 1,
    ...(discoveryFetcher ? { fetcher: discoveryFetcher } : {}),
  });
  const manual = discovery.candidates.find((candidate) => /N6(?:%20|\s).*Installation(?:%20|\s).*Manual\.pdf/i.test(candidate.url))
    ?? discovery.candidates.find((candidate) => /\.pdf(?:$|[?#])/i.test(candidate.url));
  if (!manual) throw new Error("JONSBO official discovery did not return an N6 manual candidate");
  const evidence = new FileEvidenceRepository({ coordinator, now });
  const acquired = await acquireOfficialEvidence(manual.url, {
    repository: evidence,
    clock: () => new Date(now()),
    cacheTtlMs: 0,
    kind: "manufacturer-manual",
    title: "JONSBO N6 Installation Manual",
    officialBrand: "JONSBO",
    productIdentities: [{
      brand: "JONSBO",
      basis: "governed-sku-user-asserted",
      model: "N6",
      category: "case",
      skuId: "case.jonsbo-n6",
      familyId: "case.jonsbo-n-series",
      modelId: "N6",
    }],
    ...(acquisitionFetcher ? { fetcher: acquisitionFetcher } : {}),
  });
  const comparison = createEvidenceReacquisitionComparison({
    subject: { skuId: "case.jonsbo-n6", brand: "JONSBO", category: "case", modelId: "N6" },
    document: acquired.document,
    capture: acquired.capture,
    legacyFields: await legacyN6Fields(adapterFile),
    reacquiredFields: [],
    createdAt: now(),
  });
  await atomicWriteJson(resolvedReport, comparison, { mode: 0o600 });
  return Object.freeze({
    schemaVersion: "n6-official-reacquisition-result-v1",
    runtimeGeneration: state.runtimeGeneration,
    productUrl: discovery.finalUrl,
    officialBrand: discovery.officialBrand,
    discoveredManualUrl: manual.url,
    documentId: acquired.document.id,
    documentSha256: acquired.document.sha256,
    captureId: acquired.capture.id,
    kindBasis: acquired.capture.kindBasis,
    sourceAssessment: comparison.sourceAssessment,
    legacyFieldCount: comparison.legacyFields.length,
    reacquiredFieldCount: comparison.reacquiredFields.length,
    activeFactsCreated: comparison.summary.activeFactsCreated,
    reportHash: comparison.contentHash,
    reportOutput: resolvedReport,
  });
}

export async function runN6OfficialReacquisitionCli(argv = process.argv.slice(2), options = {}) {
  const input = parse(argv);
  const coordinator = new RuntimeCoordinator({ root: input.runtimeRoot, ...(options.now ? { now: options.now } : {}) });
  await coordinator.initialize();
  return reacquireN6OfficialEvidence({
    coordinator,
    reportOutput: input.reportOutput,
    productUrl: input.productUrl,
    ...(options.now ? { now: options.now } : {}),
  });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runN6OfficialReacquisitionCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "N6 official reacquisition failed"}\n`);
    process.exitCode = 1;
  });
}
