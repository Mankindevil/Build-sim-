#!/usr/bin/env node

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileEvidenceRepository } from "../../src/evidence/repository.mjs";
import { evidenceIdentityMatchesClaimSubjectRuntime, validateEvidenceClaimRuntime, verifyEvidenceClaimRuntime } from "../../src/evidence/claim-runtime.mjs";
import {
  contentHashRuntime,
  factFieldPolicyRuntime,
  validateFactRecordRuntime,
  verifyFactRecordRuntime,
} from "../../src/facts/canonical-runtime.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import {
  atomicWriteJson,
  confined,
  pathExists,
  readJson,
  sha256Bytes,
  sha256Json,
} from "../../src/runtime/fs.mjs";
import { BUNDLED_MANUALS, importBundledManuals } from "../evidence/import-bundled-manuals.mjs";

export const FACTS_V1_MIGRATION_ID = "catalog-facts-v1";
export const FACTS_V1_IMPORTED_AT = "2026-08-20T00:00:00.000Z";

const FORMAL_MANUAL_FACTS = Object.freeze([
  { constraintId: "n6.case.externalEnvelope", fieldId: "physical.width", unit: "mm", select: (value) => value.widthMm },
  { constraintId: "n6.case.externalEnvelope", fieldId: "physical.depth", unit: "mm", select: (value) => value.depthMm },
  { constraintId: "n6.case.externalEnvelope", fieldId: "physical.height", unit: "mm", select: (value) => value.heightMm },
  { constraintId: "n6.case.motherboardFormFactors", fieldId: "case.motherboard_form_factors", select: (value) => value },
  { constraintId: "n6.package.genericHardware", fieldId: "package.contents", select: (value) => Object.keys(value).sort() },
  { constraintId: "w680m.board.formFactor", fieldId: "motherboard.form_factor", select: (value) => value.name },
  { constraintId: "w680m.board.formFactor", fieldId: "physical.width", unit: "mm", select: (value) => value.widthMm },
  { constraintId: "w680m.board.formFactor", fieldId: "physical.height", unit: "mm", select: (value) => value.heightMm },
  { constraintId: "w680m.memory.slotsAndCapacity", fieldId: "motherboard.memory_slot_count", unit: "count", select: (value) => value.dimmSlots },
  { constraintId: "w680m.memory.slotsAndCapacity", fieldId: "motherboard.memory_type", select: () => "DDR5" },
]);

const MANUAL_IDENTITY = Object.freeze({
  "references/jonsbo-n6-manual.pdf": Object.freeze({
    entryFile: "data/cases/jonsbo-n6/jonsbo-n6-manual.pdf",
    skuId: "case.jonsbo-n6",
    familyId: "case.jonsbo",
    modelId: "JONSBO N6",
    variantId: "case.jonsbo-n6",
  }),
  "references/asus-w680m-manual.pdf": Object.freeze({
    entryFile: "data/boards/asus-w680m-ace-se/asus-w680m-manual.pdf",
    skuId: "board.asus-w680m-ace-se",
    familyId: "board.asus-w680m",
    modelId: "ASUS Pro WS W680M-ACE SE",
    variantId: "board.asus-w680m-ace-se",
  }),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourcePage(source) {
  const pdf = source?.page?.pdf;
  if (Number.isSafeInteger(pdf) && pdf > 0) return pdf;
  if (Array.isArray(pdf) && Number.isSafeInteger(pdf[0]) && pdf[0] > 0) return pdf[0];
  throw new Error("formal manual fact lacks a bounded PDF page locator");
}

function sourcePrintedPage(source) {
  const printed = source?.page?.printed;
  if (typeof printed === "string" && printed.length > 0) return printed;
  if (Array.isArray(printed) && typeof printed[0] === "string" && printed[0].length > 0) return printed[0];
  return undefined;
}

function classificationForAttribute(skuId, attrName, value, attributes) {
  const evidence = attributes[`${attrName}Evidence`];
  const sourceUrl = attributes[`${attrName}SourceUrl`] ?? attributes.specSourceUrl ?? attributes.qvlUrl;
  const sourceFile = attributes[`${attrName}SourceFile`];
  const planning = attrName.startsWith("planning") || evidence === "inferred" || evidence === "unknown";
  return Object.freeze({
    skuId,
    attrName,
    valueHash: sha256Json(value),
    classification: planning ? "planning_or_inferred" : "legacy_unverified",
    reason: planning
      ? "legacy planning/inferred value has no replayable governed rule artifact"
      : sourceFile || sourceUrl || evidence === "official"
        ? "legacy label or URL is not a bounded claim locator"
        : "legacy attribute has no governed claim provenance",
  });
}

function createClaimMaterial(mapping, constraint, identity, document, capture) {
  if (!isRecord(constraint.value) && !Array.isArray(constraint.value) && typeof constraint.value !== "number") {
    throw new Error(`formal constraint value is invalid: ${mapping.constraintId}`);
  }
  const selected = mapping.select(constraint.value);
  const locator = {
    page: sourcePage(constraint.source),
    ...(sourcePrintedPage(constraint.source) ? { printedPage: sourcePrintedPage(constraint.source) } : {}),
    field: mapping.constraintId,
    snippet: constraint.rule,
  };
  return {
    schemaVersion: "evidence-claim-v1",
    subject: {
      skuId: identity.skuId,
      familyId: identity.familyId,
      modelId: identity.modelId,
      variantId: identity.variantId,
    },
    scope: "variant",
    fieldId: mapping.fieldId,
    value: selected,
    ...(mapping.unit ? { unit: mapping.unit } : {}),
    authority: "official",
    source: {
      documentId: document.id,
      documentSha256: document.sha256,
      captureId: capture.id,
      locator,
    },
    retrievedAt: FACTS_V1_IMPORTED_AT,
    status: "active",
  };
}

function completeClaim(material) {
  const contentHash = contentHashRuntime(material, "evidence-claim", "evidence-claim-v1", "evidenceClaim");
  if (!contentHash) throw new Error("evidence claim canonical hash failed");
  const claim = { ...material, claimId: `claim-sha256-${contentHash}`, contentHash };
  const errors = validateEvidenceClaimRuntime(claim);
  if (errors.length || !verifyEvidenceClaimRuntime(claim)) throw new Error(`generated evidence claim is invalid: ${errors.join("; ")}`);
  return claim;
}

function completeFact(claim) {
  const policy = factFieldPolicyRuntime(claim.fieldId);
  if (!policy) throw new Error(`generated fact field is not governed: ${claim.fieldId}`);
  const material = {
    schemaVersion: "fact-record-v1",
    factId: `fact-${claim.contentHash}`,
    subject: { kind: "product", ...claim.subject },
    field: claim.fieldId,
    value: claim.value,
    ...(claim.unit ? { unit: claim.unit } : {}),
    scope: claim.scope,
    authority: claim.authority,
    safetyClass: policy.safetyClass,
    status: "active",
    evidenceRefs: [claim.claimId],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: FACTS_V1_IMPORTED_AT,
  };
  const contentHash = contentHashRuntime(material, "fact-record", "fact-record-v1", "factRecord");
  if (!contentHash) throw new Error("fact canonical hash failed");
  const fact = { ...material, contentHash };
  const errors = validateFactRecordRuntime(fact);
  if (errors.length || !verifyFactRecordRuntime(fact)) throw new Error(`generated fact is invalid: ${errors.join("; ")}`);
  return fact;
}

async function readSources(cwd, options = {}) {
  const catalogFile = path.resolve(cwd, options.catalogFile ?? "data/skus/catalog.json");
  const constraintsFile = path.resolve(cwd, options.constraintsFile ?? "data/constraints/constraint-registry.json");
  const [catalogBytes, constraintsBytes] = await Promise.all([readFile(catalogFile), readFile(constraintsFile)]);
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const registry = JSON.parse(constraintsBytes.toString("utf8"));
  if (catalog?.schemaVersion !== "2.0.0" || !Array.isArray(catalog.skus)) throw new Error("catalog facts migration requires ProductCatalogSeed v2");
  if (!Array.isArray(registry?.constraints)) throw new Error("constraint registry is invalid");
  const manuals = [];
  for (const entry of BUNDLED_MANUALS) {
    const bytes = await readFile(path.resolve(cwd, entry.file));
    const hash = sha256Bytes(bytes);
    if (hash !== entry.sha256) throw new Error(`Bundled evidence checksum mismatch: ${entry.file}`);
    manuals.push({ file: entry.file, sha256: hash });
  }
  return {
    catalog,
    registry,
    catalogHash: sha256Bytes(catalogBytes),
    constraintsHash: sha256Bytes(constraintsBytes),
    manuals,
  };
}

export async function planFactsV1Migration(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sources = await readSources(cwd, options);
  const constraints = new Map(sources.registry.constraints.map((entry) => [entry.id, entry]));
  const formal = FORMAL_MANUAL_FACTS.map((mapping) => {
    const constraint = constraints.get(mapping.constraintId);
    const identity = MANUAL_IDENTITY[constraint?.source?.file];
    if (!constraint || constraint.evidenceLevel !== "official" || !identity) throw new Error(`formal manual constraint is unavailable: ${mapping.constraintId}`);
    const value = mapping.select(constraint.value);
    return {
      constraintId: mapping.constraintId,
      fieldId: mapping.fieldId,
      ...(mapping.unit ? { unit: mapping.unit } : {}),
      valueHash: sha256Json(value),
      sourceFile: constraint.source.file,
      page: sourcePage(constraint.source),
      skuId: identity.skuId,
    };
  });
  const legacyUnverified = sources.catalog.skus.flatMap((sku) => Object.entries(sku.attrs ?? {})
    .filter(([name]) => !name.endsWith("Evidence") && !name.endsWith("SourceUrl") && !name.endsWith("SourceFile") && !name.endsWith("Note") && !name.endsWith("Image"))
    .map(([name, value]) => classificationForAttribute(sku.id, name, value, sku.attrs ?? {})))
    .sort((left, right) => `${left.skuId}\0${left.attrName}`.localeCompare(`${right.skuId}\0${right.attrName}`));
  const sourceHash = sha256Json({ catalogHash: sources.catalogHash, constraintsHash: sources.constraintsHash, manuals: sources.manuals });
  const plan = {
    schemaVersion: "catalog-facts-v1-plan",
    migrationId: FACTS_V1_MIGRATION_ID,
    sourceHash,
    catalogHash: sources.catalogHash,
    constraintsHash: sources.constraintsHash,
    manuals: sources.manuals,
    formal,
    legacyUnverified,
  };
  return Object.freeze({ ...plan, planHash: sha256Json(plan) });
}

async function writeImmutableJson(file, value, label) {
  if (await pathExists(file)) {
    const existing = await readJson(file);
    if (sha256Json(existing) !== sha256Json(value)) throw new Error(`${label} immutable authority conflict`);
    return false;
  }
  await atomicWriteJson(file, value);
  return true;
}

async function verifyImportedEvidence(evidence, imported, identity) {
  const document = await evidence.getDocument(imported.document.id);
  const capture = await evidence.getCapture(imported.capture.id);
  if (!document || !capture || document.sha256 !== imported.document.sha256 || capture.documentId !== document.id
    || !capture.productIdentities.some((item) => item.basis === "official-document-explicit"
      && evidenceIdentityMatchesClaimSubjectRuntime(item, identity, "variant"))) {
    throw new Error("bundled manual evidence closure is invalid");
  }
}

export async function migrateFactsV1(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const plan = await planFactsV1Migration({ ...options, cwd });
  if (options.dryRun !== false) return { status: "planned", plan };
  if (options.expectedSourceHash !== plan.sourceHash) throw new Error("facts migration apply requires the exact dry-run source hash");
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.env.RUNTIME_ROOT ?? path.join(cwd, "runtime"));
  const coordinator = options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
  await coordinator.initialize();
  const evidence = options.evidenceRepository ?? new FileEvidenceRepository({ coordinator, now: options.now });
  const imported = await importBundledManuals({ cwd, repository: evidence });
  const importedByFile = new Map(imported.map((entry) => [entry.file, entry]));
  for (const identity of Object.values(MANUAL_IDENTITY)) {
    const source = importedByFile.get(identity.entryFile);
    if (!source) throw new Error(`bundled evidence result is missing: ${identity.entryFile}`);
    await verifyImportedEvidence(evidence, source, identity);
  }

  const result = await coordinator.withWrite(async ({ activeRoot }) => {
    const constraints = JSON.parse(await readFile(path.resolve(cwd, options.constraintsFile ?? "data/constraints/constraint-registry.json"), "utf8"));
    const byId = new Map(constraints.constraints.map((entry) => [entry.id, entry]));
    const claims = [];
    const facts = [];
    for (const mapping of FORMAL_MANUAL_FACTS) {
      const constraint = byId.get(mapping.constraintId);
      const identity = MANUAL_IDENTITY[constraint.source.file];
      const source = importedByFile.get(identity.entryFile);
      if (!source) throw new Error(`bundled evidence result is missing: ${identity.entryFile}`);
      const claim = completeClaim(createClaimMaterial(mapping, constraint, identity, source.document, source.capture));
      const fact = completeFact(claim);
      const claimEnvelope = { schemaVersion: "evidence-claim-envelope-v1", kind: "evidence-claim", checksum: sha256Json(claim), payload: claim };
      const factPayload = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(fact), fact };
      const factEnvelope = { schemaVersion: "fact-repository-envelope-v1", kind: "fact", checksum: sha256Json(factPayload), payload: factPayload };
      await writeImmutableJson(confined(activeRoot, "evidence", "claims", claim.contentHash.slice(0, 2), `${claim.claimId}.json`), claimEnvelope, "evidence claim");
      await writeImmutableJson(confined(activeRoot, "facts", "records", `${fact.factId}.json`), factEnvelope, "fact");
      claims.push({ claimId: claim.claimId, contentHash: claim.contentHash, documentId: claim.source.documentId, captureId: claim.source.captureId });
      facts.push({ factId: fact.factId, contentHash: fact.contentHash, claimId: claim.claimId });
    }
    const material = {
      schemaVersion: "catalog-facts-v1-manifest",
      migrationId: FACTS_V1_MIGRATION_ID,
      status: "applied",
      sourceHash: plan.sourceHash,
      planHash: plan.planHash,
      catalogHash: plan.catalogHash,
      constraintsHash: plan.constraintsHash,
      manuals: plan.manuals,
      formal: plan.formal,
      legacyUnverified: plan.legacyUnverified,
      claims: claims.sort((left, right) => left.claimId.localeCompare(right.claimId)),
      facts: facts.sort((left, right) => left.factId.localeCompare(right.factId)),
      appliedAt: options.now?.() ?? new Date().toISOString(),
    };
    const manifest = { ...material, manifestHash: sha256Json(material) };
    const manifestFile = confined(activeRoot, "migrations", FACTS_V1_MIGRATION_ID, "manifest.json");
    if (await pathExists(manifestFile)) {
      const previous = await readJson(manifestFile);
      if (previous.status === "applied" && previous.sourceHash === manifest.sourceHash && previous.planHash === manifest.planHash) return previous;
      if (previous.status !== "rolled_back") throw new Error("facts migration manifest conflicts with this source");
    }
    await atomicWriteJson(manifestFile, manifest);
    return manifest;
  });
  return { status: "applied", plan, manifest: result.result };
}

export async function rollbackFactsV1(options = {}) {
  if (["1", "true", "yes", "on"].includes(String(options.factGraphEnabled ?? process.env.BUILD_SIM_FACT_GRAPH_ENABLED ?? "").toLowerCase())) {
    throw new Error("disable the fact graph before rolling back its migration marker");
  }
  const runtimeRoot = path.resolve(options.runtimeRoot ?? process.env.RUNTIME_ROOT ?? path.join(process.cwd(), "runtime"));
  const coordinator = options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
  const result = await coordinator.withWrite(async ({ activeRoot }) => {
    const file = confined(activeRoot, "migrations", FACTS_V1_MIGRATION_ID, "manifest.json");
    const current = await readJson(file);
    if (current?.schemaVersion !== "catalog-facts-v1-manifest" || current.status !== "applied" || current.manifestHash !== sha256Json(Object.fromEntries(Object.entries(current).filter(([key]) => key !== "manifestHash")))) {
      throw new Error("facts migration manifest is not rollback-ready");
    }
    const material = { ...current, status: "rolled_back", rolledBackAt: options.now?.() ?? new Date().toISOString(), previousManifestHash: current.manifestHash };
    delete material.manifestHash;
    const rolledBack = { ...material, manifestHash: sha256Json(material) };
    await atomicWriteJson(file, rolledBack);
    return rolledBack;
  });
  return result.result;
}

function cliOptions(argv) {
  const value = (name) => argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
  return {
    runtimeRoot: value("--runtime-root"),
    expectedSourceHash: value("--expected-source-hash"),
    dryRun: !argv.includes("--apply"),
    rollback: argv.includes("--rollback"),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = cliOptions(process.argv.slice(2));
  const operation = options.rollback ? rollbackFactsV1(options) : migrateFactsV1(options);
  operation.then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : "Facts migration failed");
    process.exitCode = 1;
  });
}
