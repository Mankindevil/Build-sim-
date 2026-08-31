import path from "node:path";
import { readFile } from "node:fs/promises";
import { createBackup, persistBackupVerification, verifyBackup } from "../backup/runtime.mjs";
import {
  atomicWriteFile,
  atomicWriteJson,
  confined,
  isInside,
  pathExists,
  readJson,
  sha256Json,
} from "./fs.mjs";
import {
  createProductionReferenceGraph,
  createProductionReferenceGraphAtSnapshot,
  validateProductionRuntimeRoot,
} from "./production-reference-graph.mjs";

export const FRESH_GOVERNED_REBUILD_PLAN_SCHEMA_VERSION = "fresh-governed-rebuild-v1-plan";
export const FRESH_GOVERNED_REBUILD_MANIFEST_SCHEMA_VERSION = "fresh-governed-rebuild-v1-manifest";
export const FRESH_GOVERNED_REBUILD_MIGRATION_ID = "fresh-governed-rebuild-v1";
export const FRESH_GOVERNED_REBUILD_CONFIRMATION = "BACKUP_AND_ACTIVATE_FRESH_GOVERNED_RUNTIME";

const REACQUIRE_KINDS = Object.freeze([
  "official_evidence",
  "third_party_evidence",
  "prices",
  "plans",
  "observations",
]);
const PRESERVED_AUTHORITY_KINDS = Object.freeze(["backup_verification"]);
const SHA256 = /^[a-f0-9]{64}$/u;

function exactObject(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function iso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function planMaterial(value) {
  const { contentHash: _ignored, ...material } = value;
  return material;
}

export function validateFreshGovernedRebuildPlan(value) {
  const fields = [
    "schemaVersion", "migrationId", "policy", "sourceRuntimeGeneration", "sourceRuntimeRevision",
    "sourceActiveRoot", "sourcePointerHash", "sourceReferenceGraphHash", "legacyDisposition",
    "preservedAuthorityKinds", "reacquireKinds", "createdAt", "contentHash",
  ];
  const errors = [];
  if (!exactObject(value, fields)) return ["fresh governed rebuild plan fields are invalid"];
  if (value.schemaVersion !== FRESH_GOVERNED_REBUILD_PLAN_SCHEMA_VERSION
    || value.migrationId !== FRESH_GOVERNED_REBUILD_MIGRATION_ID
    || value.policy !== "backup_then_fresh_authority"
    || value.legacyDisposition !== "backup_only_no_legacy_import") errors.push("fresh governed rebuild plan policy is invalid");
  if (!Number.isInteger(value.sourceRuntimeGeneration) || value.sourceRuntimeGeneration < 1
    || !Number.isInteger(value.sourceRuntimeRevision) || value.sourceRuntimeRevision < 0
    || value.sourceActiveRoot !== `generations/${value.sourceRuntimeGeneration}`) errors.push("fresh governed rebuild source state is invalid");
  if (!SHA256.test(String(value.sourcePointerHash)) || !SHA256.test(String(value.sourceReferenceGraphHash))) errors.push("fresh governed rebuild source hashes are invalid");
  if (JSON.stringify(value.preservedAuthorityKinds) !== JSON.stringify(PRESERVED_AUTHORITY_KINDS)
    || JSON.stringify(value.reacquireKinds) !== JSON.stringify(REACQUIRE_KINDS)) errors.push("fresh governed rebuild authority policy is invalid");
  if (!iso(value.createdAt)) errors.push("fresh governed rebuild plan time is invalid");
  if (!SHA256.test(String(value.contentHash))
    || value.contentHash !== sha256Json({ domain: "fresh-governed-rebuild-plan", material: planMaterial(value) })) {
    errors.push("fresh governed rebuild plan hash is invalid");
  }
  return errors;
}

export async function createFreshGovernedRebuildPlan({ coordinator, now = () => new Date().toISOString() }) {
  if (!coordinator) throw new TypeError("fresh governed rebuild plan requires a coordinator");
  const createdAt = now();
  const captured = await coordinator.withConsistentSnapshot(async ({ state, activeRoot }) => ({
    state,
    graph: await createProductionReferenceGraphAtSnapshot({ state, activeRoot, now: () => createdAt }),
  }));
  const { state, graph } = captured.result;
  const material = {
    schemaVersion: FRESH_GOVERNED_REBUILD_PLAN_SCHEMA_VERSION,
    migrationId: FRESH_GOVERNED_REBUILD_MIGRATION_ID,
    policy: "backup_then_fresh_authority",
    sourceRuntimeGeneration: state.runtimeGeneration,
    sourceRuntimeRevision: state.revision,
    sourceActiveRoot: state.activeRoot,
    sourcePointerHash: sha256Json(state),
    sourceReferenceGraphHash: graph.graphHash,
    legacyDisposition: "backup_only_no_legacy_import",
    preservedAuthorityKinds: [...PRESERVED_AUTHORITY_KINDS],
    reacquireKinds: [...REACQUIRE_KINDS],
    createdAt,
  };
  return Object.freeze({ ...material, contentHash: sha256Json({ domain: "fresh-governed-rebuild-plan", material }) });
}

export async function writeFreshGovernedRebuildPlan(outputFile, plan, runtimeRoot) {
  const errors = validateFreshGovernedRebuildPlan(plan);
  if (errors.length) throw new TypeError(errors.join("; "));
  const output = path.resolve(outputFile);
  if (isInside(path.resolve(runtimeRoot), output)) throw new Error("fresh governed rebuild plan must be written outside the runtime root");
  await atomicWriteJson(output, plan, { mode: 0o600 });
  return output;
}

export async function readFreshGovernedRebuildPlan(inputFile) {
  const value = await readJson(path.resolve(inputFile));
  const errors = validateFreshGovernedRebuildPlan(value);
  if (errors.length) throw new TypeError(errors.join("; "));
  return Object.freeze(value);
}

function freshManifest({ plan, verification, verificationRef, targetRuntimeGeneration, activatedAt }) {
  const material = {
    schemaVersion: FRESH_GOVERNED_REBUILD_MANIFEST_SCHEMA_VERSION,
    migrationId: FRESH_GOVERNED_REBUILD_MIGRATION_ID,
    status: "activated",
    policy: plan.policy,
    sourceRuntimeGeneration: plan.sourceRuntimeGeneration,
    sourceRuntimeRevision: plan.sourceRuntimeRevision,
    targetRuntimeGeneration,
    sourcePointerHash: plan.sourcePointerHash,
    sourceReferenceGraphHash: plan.sourceReferenceGraphHash,
    planHash: plan.contentHash,
    backupId: verification.manifest.backupId,
    backupManifestHash: verification.manifest.manifestHash,
    backupVerificationRef: verificationRef,
    legacyDisposition: plan.legacyDisposition,
    preservedAuthorityKinds: [...plan.preservedAuthorityKinds],
    reacquireKinds: [...plan.reacquireKinds],
    activatedAt,
  };
  return { ...material, manifestHash: sha256Json(material) };
}

export async function applyFreshGovernedRebuildPlan(options) {
  const {
    coordinator, plan, expectedPlanHash, backupOutput, password, confirmation,
    now = () => new Date().toISOString(), beforePointerSwitch,
  } = options ?? {};
  if (!coordinator || typeof backupOutput !== "string") throw new TypeError("fresh governed rebuild apply requires coordinator and backup output");
  const errors = validateFreshGovernedRebuildPlan(plan);
  if (errors.length) throw new TypeError(errors.join("; "));
  if (expectedPlanHash !== plan.contentHash) throw new Error("fresh governed rebuild expected plan hash mismatch");
  if (confirmation !== FRESH_GOVERNED_REBUILD_CONFIRMATION) throw new Error("fresh governed rebuild confirmation is invalid");
  const resolvedBackup = path.resolve(backupOutput);
  if (isInside(coordinator.root, resolvedBackup)) throw new Error("fresh governed rebuild backup must be stored outside the runtime root");
  if (await pathExists(resolvedBackup)) throw new Error("fresh governed rebuild refuses to overwrite an existing backup");

  const sourceState = await coordinator.readState();
  // graphHash includes its deterministic creation timestamp. Rebuild the
  // reviewed source graph at the plan's timestamp so elapsed wall time alone
  // cannot invalidate an otherwise unchanged plan.
  const sourceGraph = await createProductionReferenceGraph({ coordinator, now: () => plan.createdAt });
  if (sourceState.runtimeGeneration !== plan.sourceRuntimeGeneration || sourceState.revision !== plan.sourceRuntimeRevision
    || sourceState.activeRoot !== plan.sourceActiveRoot || sha256Json(sourceState) !== plan.sourcePointerHash
    || sourceGraph.graphHash !== plan.sourceReferenceGraphHash) throw new Error("fresh governed rebuild source authority changed after review");

  const backup = await createBackup({ coordinator, outputFile: resolvedBackup, password, mode: "full_local_backup", now });
  const verification = await verifyBackup({ inputFile: resolvedBackup, password, now });
  const persisted = await persistBackupVerification({
    coordinator,
    verification,
    expectedRuntimeRevision: plan.sourceRuntimeRevision,
  });

  const lease = await coordinator.acquireMaintenanceLease("fresh-governed-rebuild", { ttlMs: 300_000 });
  let staging;
  try {
    const before = await coordinator.readState();
    if (before.runtimeGeneration !== plan.sourceRuntimeGeneration || before.revision !== plan.sourceRuntimeRevision + 1) {
      throw new Error("fresh governed rebuild runtime changed after backup verification");
    }
    const targetRuntimeGeneration = before.runtimeGeneration + 1;
    staging = await coordinator.createStagingGeneration(lease.token);
    const sourceVerification = confined(coordinator.activeRoot(before), ...persisted.result.fileRef.split("/"));
    const targetVerification = confined(staging, ...persisted.result.fileRef.split("/"));
    await atomicWriteFile(targetVerification, await readFile(sourceVerification), { mode: 0o600 });
    const activatedAt = now();
    const manifest = freshManifest({
      plan,
      verification,
      verificationRef: persisted.result.fileRef,
      targetRuntimeGeneration,
      activatedAt,
    });
    await atomicWriteJson(confined(staging, "migrations", FRESH_GOVERNED_REBUILD_MIGRATION_ID, "manifest.json"), manifest);
    if (typeof beforePointerSwitch === "function") await beforePointerSwitch({ staging, before, manifest, backup, verification });
    await validateProductionRuntimeRoot({
      state: { ...before, runtimeGeneration: targetRuntimeGeneration, revision: before.revision + 1, activeRoot: `generations/${targetRuntimeGeneration}` },
      activeRoot: staging,
      now: () => activatedAt,
    });
    const state = await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token, { minimumGeneration: targetRuntimeGeneration });
    staging = undefined;
    return Object.freeze({
      schemaVersion: "fresh-governed-rebuild-v1-result",
      planHash: plan.contentHash,
      backupId: backup.manifest.backupId,
      backupManifestHash: backup.manifest.manifestHash,
      backupOutput: resolvedBackup,
      backupVerificationRef: persisted.result.fileRef,
      manifestHash: manifest.manifestHash,
      runtimeGeneration: state.runtimeGeneration,
      runtimeRevision: state.revision,
      legacyImported: false,
    });
  } catch (error) {
    if (staging) await coordinator.discardStagingGeneration(staging).catch(() => undefined);
    throw error;
  } finally {
    await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined);
  }
}
