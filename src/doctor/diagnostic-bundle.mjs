import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, canonicalJson, sha256Bytes } from "../runtime/fs.mjs";
import { isDoctorRunResult } from "./runner.mjs";

const SCHEMA_VERSION = "buildsim-redacted-diagnostic-bundle-v1";
const HASH_PREFIX = "buildsim\0hash-spec-v1\0diagnostic-bundle\0diagnostic-bundle-v1\0";

function sensitive(value) {
  return /(?:https?:\/\/|file:\/\/|\/(?:home|root|etc|var|tmp|srv|opt)\/|[A-Za-z]:\\|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:token|secret|bearer|api[-_]?key|password|cookie)[-:=_A-Za-z0-9]{8,})/i.test(value);
}

function bundleHash(value) {
  return sha256Bytes(Buffer.from(`${HASH_PREFIX}${canonicalJson(value).normalize("NFC")}`, "utf8"));
}

function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((key) => fields.includes(key));
}

export async function createRedactedDiagnosticBundle({ doctorRun, outputFile, now = () => new Date().toISOString() }) {
  if (!isDoctorRunResult(doctorRun) || typeof outputFile !== "string") throw new TypeError("diagnostic bundle requires runner-issued Doctor state and an output file");
  const createdAt = now();
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError("diagnostic bundle timestamp is invalid");
  const report = structuredClone(doctorRun.report);
  const evidence = [...doctorRun.evidenceArtifacts.entries()].map(([ref, artifact]) => ({
    ref,
    checkId: artifact.checkId,
    measurementHash: artifact.measurementHash,
    status: artifact.status,
    severity: artifact.severity,
  })).sort((left, right) => left.ref.localeCompare(right.ref));
  const base = {
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    runtimeGeneration: report.runtimeGeneration,
    appVersion: report.appVersion,
    report,
    evidence,
    privacy: {
      redacted: true,
      omitted: ["raw_paths", "web_bodies", "user_fields", "secrets", "cookies", "private_attachment_bytes"],
    },
  };
  const serializedBase = canonicalJson(base).normalize("NFC");
  if (sensitive(serializedBase)) throw new Error("diagnostic bundle redaction policy rejected sensitive detail");
  const bundle = { ...base, bundleHash: bundleHash(base) };
  await atomicWriteFile(path.resolve(outputFile), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return bundle;
}

export async function verifyRedactedDiagnosticBundle(inputFile) {
  let value;
  try { value = JSON.parse(await readFile(path.resolve(inputFile), "utf8")); }
  catch { return { valid: false, errors: ["diagnostic bundle is unreadable"] }; }
  const fields = ["schemaVersion", "createdAt", "runtimeGeneration", "appVersion", "report", "evidence", "privacy", "bundleHash"];
  const errors = [];
  if (!exact(value, fields) || value.schemaVersion !== SCHEMA_VERSION || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isInteger(value.runtimeGeneration) || value.runtimeGeneration < 1 || typeof value.appVersion !== "string"
    || !Array.isArray(value.evidence) || value.privacy?.redacted !== true || typeof value.bundleHash !== "string") {
    errors.push("diagnostic bundle structure is invalid");
  }
  if (exact(value, fields)) {
    const { bundleHash: claimed, ...base } = value;
    if (claimed !== bundleHash(base)) errors.push("diagnostic bundle hash is invalid");
  }
  if (sensitive(canonicalJson(value))) errors.push("diagnostic bundle contains sensitive detail");
  return { valid: errors.length === 0, errors };
}
