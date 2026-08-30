#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileEvidenceRepository } from "../../src/evidence/repository.mjs";

const IMPORTED_AT = "2026-08-20T00:00:00.000Z";

export const BUNDLED_MANUALS = Object.freeze([
  Object.freeze({
    file: "data/cases/jonsbo-n6/jonsbo-n6-manual.pdf",
    sha256: "15f026946a18b5e4fc0ebf585f8b60ed8e3044f41efe699326adfa0ee3d480cd",
    title: "JONSBO N6 User Guide",
    url: "https://www.jonsbo.com/Upfiles/down/N6%20Installation%20Manual.pdf",
    officialBrand: "JONSBO",
    identity: Object.freeze({
      brand: "JONSBO", basis: "official-document-explicit", model: "N6", category: "case", skuId: "case.jonsbo-n6",
      familyId: "case.jonsbo", modelId: "JONSBO N6", variantId: "case.jonsbo-n6",
    }),
  }),
  Object.freeze({
    file: "data/boards/asus-w680m-ace-se/asus-w680m-manual.pdf",
    sha256: "dbb482ef25ababeae9d4d1063e176a78c0544f18dacffd16dc830a1a2f203d2e",
    title: "ASUS Pro WS W680M-ACE SE User's Manual E22371",
    url: "https://dlcdnets.asus.com/pub/ASUS/mb/LGA1700/PRO_WS_W680M-ACE_SE/E22371_Pro_WS_W680M-ACE_SE_UM_V2_WEB.pdf?model=Pro+WS+W680M-ACE+SE",
    officialBrand: "ASUS",
    identity: Object.freeze({
      brand: "ASUS", basis: "official-document-explicit", model: "Pro WS W680M-ACE SE", category: "motherboard", skuId: "board.asus-w680m-ace-se",
      familyId: "board.asus-w680m", modelId: "ASUS Pro WS W680M-ACE SE", variantId: "board.asus-w680m-ace-se",
    }),
  }),
]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Import checked-in snapshots into the shared CAS without duplicating bytes. */
export async function importBundledManuals(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const repository = options.repository ?? new FileEvidenceRepository({ root: options.root });
  const entries = options.entries ?? BUNDLED_MANUALS;
  const results = [];
  for (const entry of entries) {
    const file = path.resolve(cwd, entry.file);
    const bytes = await readFile(file);
    const actualHash = sha256(bytes);
    if (actualHash !== entry.sha256) throw new Error(`Bundled evidence checksum mismatch: ${entry.file}`);
    if (options.dryRun) {
      results.push({ file: entry.file, sha256: actualHash, status: "verified" });
      continue;
    }
    const verifiedIdentity = {
      brand: entry.identity.brand,
      basis: "official-document-explicit",
      ...(entry.identity.model ? { model: entry.identity.model } : {}),
      ...(entry.identity.mpn ? { mpn: entry.identity.mpn } : {}),
      ...(entry.identity.category ? { category: entry.identity.category } : {}),
      ...(entry.identity.skuId ? { skuId: entry.identity.skuId } : {}),
      ...(entry.identity.familyId ? { familyId: entry.identity.familyId } : {}),
      ...(entry.identity.modelId ? { modelId: entry.identity.modelId } : {}),
      ...(entry.identity.variantId ? { variantId: entry.identity.variantId } : {}),
      ...(entry.identity.revision ? { revision: entry.identity.revision } : {}),
      ...(entry.identity.region ? { region: entry.identity.region } : {}),
    };
    const stored = await repository.importFile(file, {
      mediaType: "application/pdf",
      kind: "manufacturer-manual",
      title: entry.title,
      productIdentities: [verifiedIdentity],
      createdAt: IMPORTED_AT,
      capture: {
        requestedUrl: entry.url,
        finalUrl: entry.url,
        canonicalUrl: entry.url,
        retrievedAt: IMPORTED_AT,
        status: 200,
        redirects: [],
        officialBrand: entry.officialBrand,
        acquisitionMethod: "bundled-import",
        kindBasis: "content-verified",
      },
    });
    const expectedIdentity = JSON.stringify([verifiedIdentity]);
    if (stored.document.sha256 !== entry.sha256
      || stored.capture.kind !== "manufacturer-manual"
      || stored.capture.kindBasis !== "content-verified"
      || stored.capture.title !== entry.title
      || JSON.stringify(stored.capture.productIdentities) !== expectedIdentity) {
      throw new Error(`Bundled evidence metadata conflict: ${entry.file}`);
    }
    results.push({ file: entry.file, document: stored.document, capture: stored.capture, reusedDocument: stored.reusedDocument, reusedCapture: stored.reusedCapture });
  }
  return results;
}

function cliOptions(argv) {
  const rootArg = argv.find((value) => value.startsWith("--root="));
  return {
    root: rootArg ? path.resolve(rootArg.slice("--root=".length)) : path.resolve(process.env.EVIDENCE_REPOSITORY_ROOT ?? "runtime/evidence"),
    dryRun: argv.includes("--dry-run"),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  importBundledManuals(cliOptions(process.argv.slice(2)))
    .then((results) => console.log(JSON.stringify({ imported: results.length, results }, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Bundled evidence import failed");
      process.exitCode = 1;
    });
}
