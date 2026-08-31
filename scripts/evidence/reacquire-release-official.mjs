#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOfficialEvidence } from "../../src/evidence/acquire.mjs";
import { FileEvidenceRepository } from "../../src/evidence/repository.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { atomicWriteJson, isInside, sha256Json } from "../../src/runtime/fs.mjs";
import {
  JONSBO_N6_OFFICIAL_PRODUCT_URL,
  reacquireN6OfficialEvidence,
} from "./reacquire-n6-official.mjs";

export const RELEASE_OFFICIAL_REACQUISITION_SCHEMA_VERSION = "release-official-reacquisition-v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const DOCUMENT_ID = /^doc-sha256-[a-f0-9]{64}$/u;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/u;

export const RELEASE_OFFICIAL_SOURCES = Object.freeze([
  Object.freeze({
    skuId: "board.asus-w680m-ace-se", brand: "ASUS", category: "motherboard",
    familyId: "board.asus-w680m", modelId: "Pro WS W680M-ACE SE", variantId: "Pro WS W680M-ACE SE",
    sourceKind: "manufacturer-manual", title: "ASUS Pro WS W680M-ACE SE User Manual E22371",
    url: "https://dlcdnets.asus.com/pub/ASUS/mb/LGA1700/PRO_WS_W680M-ACE_SE/E22371_Pro_WS_W680M-ACE_SE_UM_V2_WEB.pdf?model=Pro+WS+W680M-ACE+SE",
  }),
  Object.freeze({
    skuId: "cpu.i5-14500", brand: "Intel", category: "cpu",
    familyId: "cpu.intel-core-i5-14th-gen", modelId: "Core i5-14500", variantId: "ark-sku-236784",
    sourceKind: "datasheet", title: "Intel Core Desktop Processors 14th Gen Quick Reference Guide Phase 2",
    // Intel ARK is the canonical human-readable record, but rejects the
    // bounded production fetcher with HTTP 403. This official Intel-hosted PDF
    // is the reproducibly fetchable archival source for the same SKU family.
    url: "https://cdrdv2-public.intel.com/787258/Intel%20Core%20Desktop%20Processors%2014th%20gen%20Quick%20Reference%20Guide%20Phase%202.pdf",
  }),
  Object.freeze({
    skuId: "storage.samsung-980-pro", brand: "Samsung", category: "storage",
    familyId: "storage.samsung-980-pro", modelId: "980 PRO", variantId: "capacity-unresolved",
    sourceKind: "datasheet", title: "Samsung NVMe SSD 980 PRO Data Sheet Revision 2.1",
    url: "https://download.semiconductor.samsung.com/resources/data-sheet/Samsung-NVMe-SSD-980-PRO-Data-Sheet_Rev.2.1_230509_10129505074622.pdf",
  }),
  Object.freeze({
    skuId: "psu.seasonic-focus-plus-gold-850-fx", brand: "Seasonic", category: "psu",
    familyId: "psu.seasonic-focus-plus-gold", modelId: "FOCUS PLUS Gold 850", variantId: "SSR-850FX",
    sourceKind: "official-product-page-snapshot", title: "Seasonic FOCUS PLUS Gold 850 Product and Cable Specification",
    url: "https://seasonic.com/product/focus-plus-gold/",
  }),
]);

function exact(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function material(value) {
  const { contentHash: _ignored, ...rest } = value;
  return rest;
}

export function validateReleaseOfficialReacquisition(value) {
  const fields = ["schemaVersion", "runtimeGeneration", "createdAt", "entries", "n6ComparisonHash", "activeFactsCreated", "contentHash"];
  if (!exact(value, fields)) return ["release official reacquisition fields are invalid"];
  const errors = [];
  if (value.schemaVersion !== RELEASE_OFFICIAL_REACQUISITION_SCHEMA_VERSION
    || !Number.isInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
    || new Date(value.createdAt).toISOString() !== value.createdAt
    || !SHA256.test(String(value.n6ComparisonHash)) || value.activeFactsCreated !== 0) {
    errors.push("release official reacquisition identity is invalid");
  }
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const entryFields = ["skuId", "brand", "category", "sourceKind", "requestedUrl", "finalUrl", "documentId", "documentSha256", "captureId", "kindBasis", "identityStatus"];
  if (!Array.isArray(value.entries) || entries.length !== 5 || entries.some((entry) => !exact(entry, entryFields)
    || !DOCUMENT_ID.test(String(entry.documentId)) || !CAPTURE_ID.test(String(entry.captureId))
    || !SHA256.test(String(entry.documentSha256)) || entry.documentId !== `doc-sha256-${entry.documentSha256}`
    || ![entry.requestedUrl, entry.finalUrl].every((url) => { try { return new URL(url).protocol === "https:"; } catch { return false; } })
    || !["user-asserted", "content-verified"].includes(entry.kindBasis)
    || entry.identityStatus !== (entry.kindBasis === "content-verified" ? "official_exact_identity_verified" : "official_archive_identity_unverified"))) {
    errors.push("release official reacquisition entries are invalid");
  }
  const expectedSkuIds = ["case.jonsbo-n6", ...RELEASE_OFFICIAL_SOURCES.map(({ skuId }) => skuId)].sort();
  if (JSON.stringify(entries.map(({ skuId }) => skuId)) !== JSON.stringify(expectedSkuIds)) {
    errors.push("release official reacquisition SKU coverage is invalid");
  }
  if (!SHA256.test(String(value.contentHash))
    || value.contentHash !== sha256Json({ domain: "release-official-reacquisition", material: material(value) })) {
    errors.push("release official reacquisition content hash is invalid");
  }
  return errors;
}

function entry(source, acquired) {
  return {
    skuId: source.skuId,
    brand: source.brand,
    category: source.category,
    sourceKind: source.sourceKind,
    requestedUrl: acquired.capture.requestedUrl,
    finalUrl: acquired.capture.finalUrl,
    documentId: acquired.document.id,
    documentSha256: acquired.document.sha256,
    captureId: acquired.capture.id,
    kindBasis: acquired.capture.kindBasis,
    identityStatus: acquired.capture.kindBasis === "content-verified"
      ? "official_exact_identity_verified" : "official_archive_identity_unverified",
  };
}

export async function reacquireReleaseOfficialEvidence(options) {
  const {
    coordinator, reportOutput, now = () => new Date().toISOString(),
    discoveryFetcher, acquisitionFetcher, requireFreshGeneration = true,
  } = options ?? {};
  if (!coordinator || typeof reportOutput !== "string") throw new TypeError("release official reacquisition requires coordinator and report output");
  const output = path.resolve(reportOutput);
  if (isInside(coordinator.root, output)) throw new Error("release official reacquisition report must be outside the runtime root");
  const n6Report = path.join(path.dirname(output), "n6-official-comparison.json");
  let n6;
  try {
    n6 = await reacquireN6OfficialEvidence({
      coordinator, reportOutput: n6Report, now, discoveryFetcher, acquisitionFetcher,
      cacheTtlMs: 24 * 60 * 60 * 1_000,
      requireFreshGeneration,
    });
  } catch (error) {
    throw new Error(`official reacquisition failed for case.jonsbo-n6: ${error instanceof Error ? error.message : "acquisition failed"}`, { cause: error });
  }
  const repository = new FileEvidenceRepository({ coordinator, now });
  const acquiredEntries = [{
    skuId: "case.jonsbo-n6", brand: "JONSBO", category: "case", sourceKind: "manufacturer-manual",
    requestedUrl: n6.discoveredManualUrl, finalUrl: n6.discoveredManualUrl,
    documentId: n6.documentId, documentSha256: n6.documentSha256, captureId: n6.captureId,
    kindBasis: n6.kindBasis, identityStatus: n6.sourceAssessment,
  }];
  for (const source of RELEASE_OFFICIAL_SOURCES) {
    let acquired;
    try {
      acquired = await acquireOfficialEvidence(source.url, {
        repository,
        clock: () => new Date(now()),
        cacheTtlMs: 0,
        kind: source.sourceKind,
        title: source.title,
        officialBrand: source.brand,
        productIdentities: [{
          brand: source.brand,
          basis: "governed-sku-user-asserted",
          model: source.modelId,
          category: source.category,
          skuId: source.skuId,
          familyId: source.familyId,
          modelId: source.modelId,
          variantId: source.variantId,
        }],
        ...(acquisitionFetcher ? { fetcher: acquisitionFetcher } : {}),
      });
    } catch (error) {
      throw new Error(`official reacquisition failed for ${source.skuId}: ${error instanceof Error ? error.message : "acquisition failed"}`, { cause: error });
    }
    acquiredEntries.push(entry(source, acquired));
  }
  const state = await coordinator.readState();
  const indexMaterial = {
    schemaVersion: RELEASE_OFFICIAL_REACQUISITION_SCHEMA_VERSION,
    runtimeGeneration: state.runtimeGeneration,
    createdAt: now(),
    entries: acquiredEntries.sort((left, right) => left.skuId.localeCompare(right.skuId)),
    n6ComparisonHash: n6.reportHash,
    activeFactsCreated: 0,
  };
  const result = { ...indexMaterial, contentHash: sha256Json({ domain: "release-official-reacquisition", material: indexMaterial }) };
  const errors = validateReleaseOfficialReacquisition(result);
  if (errors.length) throw new TypeError(errors.join("; "));
  await atomicWriteJson(output, result, { mode: 0o600 });
  return Object.freeze(result);
}

function parse(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--runtime-root", "--report-output"].includes(key) || values.has(key)) throw new TypeError(`invalid release official reacquisition argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${key} requires a value`);
    values.set(key, value);
    index += 1;
  }
  if (!values.get("--runtime-root") || !values.get("--report-output")) throw new TypeError("--runtime-root and --report-output are required");
  return { runtimeRoot: path.resolve(values.get("--runtime-root")), reportOutput: path.resolve(values.get("--report-output")) };
}

export async function runReleaseOfficialReacquisitionCli(argv = process.argv.slice(2)) {
  const input = parse(argv);
  const coordinator = new RuntimeCoordinator({ root: input.runtimeRoot });
  await coordinator.initialize();
  return reacquireReleaseOfficialEvidence({ coordinator, reportOutput: input.reportOutput });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runReleaseOfficialReacquisitionCli().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "release official reacquisition failed"}\n`);
  process.exitCode = 1;
});
