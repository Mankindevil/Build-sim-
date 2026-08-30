#!/usr/bin/env node

import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FileEvidenceRepository } from "../../src/evidence/repository.mjs";
import { evidenceIdentityMatchesClaimSubjectRuntime, validateEvidenceClaimLocatorRuntime, verifyEvidenceClaimRuntime } from "../../src/evidence/claim-runtime.mjs";
import { validateFactRecordRuntime, verifyFactRecordRuntime } from "../../src/facts/canonical-runtime.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { confined, readJson, sha256Json } from "../../src/runtime/fs.mjs";

async function jsonFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json"))) {
    throw new Error("official fact authority contains an unknown path");
  }
  return entries.map((entry) => entry.name).sort();
}

async function readClaim(activeRoot, claimId) {
  const match = /^claim-sha256-([a-f0-9]{64})$/.exec(claimId);
  if (!match) return null;
  const envelope = await readJson(confined(activeRoot, "evidence", "claims", match[1].slice(0, 2), `${claimId}.json`));
  if (envelope?.schemaVersion !== "evidence-claim-envelope-v1" || envelope.kind !== "evidence-claim"
    || envelope.checksum !== sha256Json(envelope.payload) || !verifyEvidenceClaimRuntime(envelope.payload)) return null;
  return envelope.payload;
}

export async function scanOfficialFactsAtRoot(activeRoot) {
  const errors = [];
  const evidence = new FileEvidenceRepository({ root: confined(activeRoot, "evidence") });
  for (const file of await jsonFiles(confined(activeRoot, "facts", "records"))) {
    let envelope;
    try { envelope = await readJson(confined(activeRoot, "facts", "records", file)); }
    catch (error) { errors.push({ file, code: "unreadable_fact", message: String(error?.message ?? error) }); continue; }
    const stored = envelope?.payload;
    const fact = stored?.fact;
    if (envelope?.schemaVersion !== "fact-repository-envelope-v1" || envelope.kind !== "fact" || envelope.checksum !== sha256Json(stored)
      || stored?.schemaVersion !== "fact-repository-v1" || stored.revision !== 0 || stored.recordHash !== sha256Json(fact)
      || !verifyFactRecordRuntime(fact)) {
      errors.push({ file, code: "invalid_fact", message: "fact authority integrity invalid" });
      continue;
    }
    if (fact.authority !== "official" || fact.status !== "active") continue;
    if (validateFactRecordRuntime(fact).length || !fact.evidenceRefs.length) {
      errors.push({ file, code: "official_fact_missing_evidence", factId: fact.factId });
      continue;
    }
    for (const claimId of fact.evidenceRefs) {
      let claim;
      try { claim = await readClaim(activeRoot, claimId); }
      catch { claim = null; }
      if (!claim || claim.authority !== "official" || claim.status !== "active" || claim.fieldId !== fact.field
        || validateEvidenceClaimLocatorRuntime(claim.source?.locator).length) {
        errors.push({ file, code: "official_claim_or_locator_invalid", factId: fact.factId, claimId });
        continue;
      }
      const [document, capture] = await Promise.all([evidence.getDocument(claim.source.documentId), evidence.getCapture(claim.source.captureId)]);
      if (!document || !capture || document.sha256 !== claim.source.documentSha256 || capture.documentId !== document.id
        || !capture.productIdentities.some((identity) => identity.basis === "official-document-explicit"
          && evidenceIdentityMatchesClaimSubjectRuntime(identity, claim.subject, claim.scope))) {
        errors.push({ file, code: "official_evidence_closure_invalid", factId: fact.factId, claimId });
      }
    }
  }
  return { schemaVersion: "official-fact-scan-v1", status: errors.length ? "fail" : "pass", errors };
}

export async function scanOfficialFacts(options = {}) {
  const coordinator = options.coordinator ?? new RuntimeCoordinator({ root: path.resolve(options.runtimeRoot ?? process.env.RUNTIME_ROOT ?? "runtime") });
  return (await coordinator.withReadOnlySnapshot(({ activeRoot }) => scanOfficialFactsAtRoot(activeRoot))).result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) scanOfficialFacts().then((result) => {
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") process.exitCode = 1;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : "Official fact scan failed");
  process.exitCode = 2;
});
