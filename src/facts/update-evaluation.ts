import { HASH_SPEC_VERSION, isSha256Hex } from "../hash";
import type { PlanEvaluationLock } from "../plans/contracts";
import { validatePlanEvaluationLock, verifyPlanEvaluationLock } from "../plans/evaluation-lock";
import type { EvaluationDecision } from "../requirements/contracts";
import { sha256Json } from "../runtime/fs.mjs";
import type { FactFieldDiff, UpdateDecision } from "./contracts";
import { FACT_FIELD_POLICY_REGISTRY } from "./field-registry";

export const FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION = "fact-update-evaluation-diff-v1" as const;
export const FACT_UPDATE_SNAPSHOT_EVALUATION_SCHEMA_VERSION = "fact-update-snapshot-evaluation-receipt-v1" as const;

/**
 * The diff domain is intentionally frozen here instead of borrowing another
 * registered content-hash domain. `sha256Json` is the runtime's canonical,
 * NFC-normalized JSON encoding; the domain wrapper below prevents cross-type
 * collisions and is shared by create/verify and the production graph mirror.
 */
export const FACT_UPDATE_EVALUATION_DIFF_HASH_AUTHORITY = Object.freeze({
  hashSpecVersion: HASH_SPEC_VERSION,
  algorithm: "sha256",
  canonicalizationPolicyId: "canonical-json-v1",
  domain: "fact-update-evaluation-diff",
} as const);

export const FACT_UPDATE_EVALUATION_DOMAINS = Object.freeze([
  "identity", "mechanical", "electrical", "firmware", "system", "storage", "assembly",
  "commissioning", "routing", "thermal", "acoustic", "procurement",
] as const satisfies readonly EvaluationDecision["domain"][]);

export type FactUpdateEvaluationDomain = EvaluationDecision["domain"];

function domainsForGovernedField(fieldId: string): readonly FactUpdateEvaluationDomain[] {
  if (fieldId.startsWith("identity.")) return ["identity"];
  if (fieldId.startsWith("physical.") || fieldId.startsWith("case.") || fieldId.startsWith("mount.")
    || fieldId === "motherboard.form_factor" || fieldId === "gpu.length" || fieldId === "gpu.slot_width"
    || fieldId === "cooling.fan_mounts" || fieldId === "cooling.radiator_support") return ["mechanical"];
  if (fieldId.startsWith("psu.") || fieldId.startsWith("power.")
    || fieldId === "gpu.power_connectors" || fieldId === "cooling.pump_header") return ["electrical"];
  if (fieldId.startsWith("io.")) return ["electrical", "routing"];
  if (fieldId.startsWith("firmware.") || fieldId === "motherboard.bios_version"
    || fieldId === "motherboard.bios_upgrade_methods") return ["firmware"];
  if (fieldId.startsWith("storage.") || fieldId === "hba.mode") return ["storage"];
  if (fieldId.startsWith("package.")) return ["assembly"];
  if (fieldId === "cable.connector_standard") return ["assembly", "electrical", "routing"];
  if (fieldId === "resource.kind" || fieldId.startsWith("fastener.") || fieldId.startsWith("tool.")
    || fieldId.startsWith("consumable.") || fieldId.startsWith("accessory.")) return ["assembly"];
  if (fieldId.startsWith("thermal.")) return ["thermal"];
  if (fieldId.startsWith("acoustic.")) return ["acoustic"];
  if (fieldId.startsWith("pcie.")) return ["routing"];
  if (fieldId.startsWith("compatibility.") || fieldId.startsWith("system.")) return ["system"];
  if (fieldId.startsWith("cpu.") || fieldId.startsWith("motherboard.") || fieldId.startsWith("memory.")
    || fieldId.startsWith("driver.")) return ["system"];
  throw new Error(`governed fact field has no evaluation-domain authority: ${fieldId}`);
}

/**
 * Frozen field-to-evaluator routing. This is derived only from the governed
 * field registry, never from caller-supplied affectedDomains.
 */
export const FACT_UPDATE_FIELD_DOMAIN_REGISTRY = Object.freeze(Object.fromEntries(
  Object.keys(FACT_FIELD_POLICY_REGISTRY).sort().map((fieldId) => [fieldId, Object.freeze([...domainsForGovernedField(fieldId)].sort())]),
)) as Readonly<Record<string, readonly FactUpdateEvaluationDomain[]>>;

export function requiredEvaluationDomainsForFactField(fieldId: string): readonly FactUpdateEvaluationDomain[] {
  const domains = FACT_UPDATE_FIELD_DOMAIN_REGISTRY[fieldId];
  if (!domains) throw new TypeError(`fact field has no governed evaluation domains: ${fieldId}`);
  return domains;
}

export type FactUpdatePlanTarget =
  | { kind: "draft"; draftRevision: number }
  | { kind: "version"; versionId: string };

/**
 * Detached result of an internal snapshot evaluator. The full evaluation
 * payload remains in the evaluation receipt repository; this immutable closure
 * records exactly which plan target, lock, snapshot, and evaluation hash were
 * compared by an update transaction.
 */
export interface SnapshotEvaluationReceipt {
  schemaVersion: typeof FACT_UPDATE_SNAPSHOT_EVALUATION_SCHEMA_VERSION;
  planId: string;
  target: FactUpdatePlanTarget;
  runtimeGeneration: number;
  configHash: string;
  factSnapshotId: string;
  factSnapshotHash: string;
  evaluationHash: string;
  evaluationLock: PlanEvaluationLock;
  domainHashes: Partial<Record<FactUpdateEvaluationDomain, string>>;
}

export interface FactUpdateEvaluationDiff {
  schemaVersion: typeof FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION;
  hashSpecVersion: typeof HASH_SPEC_VERSION;
  hashAlgorithm: "sha256";
  canonicalizationPolicyId: "canonical-json-v1";
  evaluationDiffId: string;
  updateDecisionId: string;
  updateDecisionHash: string;
  planId: string;
  before: SnapshotEvaluationReceipt;
  after: SnapshotEvaluationReceipt;
  changedDomains: FactUpdateEvaluationDomain[];
  fieldDiffs: FactFieldDiff[];
  contentHash: string;
}

export type FactUpdateEvaluationDiffInput = Omit<FactUpdateEvaluationDiff,
  "schemaVersion" | "hashSpecVersion" | "hashAlgorithm" | "canonicalizationPolicyId" | "evaluationDiffId" | "contentHash"
>;

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SNAPSHOT_ID = /^fact-snapshot-sha256-[a-f0-9]{64}$/;
const DECISION_ID = /^update-decision-sha256-[a-f0-9]{64}$/;
const DIFF_ID = /^fact-update-evaluation-diff-sha256-[a-f0-9]{64}$/;
const DOMAIN_SET = new Set<string>(FACT_UPDATE_EVALUATION_DOMAINS);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function uniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function same(left: unknown, right: unknown): boolean {
  return sha256Json(left) === sha256Json(right);
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function validateTarget(value: unknown): string[] {
  if (!record(value)) return ["snapshot evaluation plan target invalid"];
  if (value.kind === "draft") {
    return exactKeys(value, ["kind", "draftRevision"])
      && Number.isInteger(value.draftRevision) && (value.draftRevision as number) >= 0
      ? [] : ["snapshot evaluation draft target invalid"];
  }
  if (value.kind === "version") {
    return exactKeys(value, ["kind", "versionId"])
      && typeof value.versionId === "string" && PLAN_ID.test(value.versionId)
      ? [] : ["snapshot evaluation version target invalid"];
  }
  return ["snapshot evaluation plan target kind invalid"];
}

export function validateSnapshotEvaluationReceipt(value: unknown): string[] {
  if (!record(value)) return ["snapshot evaluation receipt must be an object"];
  const errors: string[] = [];
  const keys = [
    "schemaVersion", "planId", "target", "runtimeGeneration", "configHash", "factSnapshotId", "factSnapshotHash",
    "evaluationHash", "evaluationLock", "domainHashes",
  ];
  if (!exactKeys(value, keys)) errors.push("snapshot evaluation receipt fields invalid");
  if (value.schemaVersion !== FACT_UPDATE_SNAPSHOT_EVALUATION_SCHEMA_VERSION) errors.push("snapshot evaluation receipt schema invalid");
  if (typeof value.planId !== "string" || !PLAN_ID.test(value.planId)) errors.push("snapshot evaluation receipt planId invalid");
  errors.push(...validateTarget(value.target));
  if (!Number.isInteger(value.runtimeGeneration) || (value.runtimeGeneration as number) < 1) {
    errors.push("snapshot evaluation receipt runtimeGeneration invalid");
  }
  for (const field of ["configHash", "factSnapshotHash", "evaluationHash"] as const) {
    if (!isSha256Hex(value[field])) errors.push(`snapshot evaluation receipt ${field} invalid`);
  }
  if (typeof value.factSnapshotId !== "string" || !SNAPSHOT_ID.test(value.factSnapshotId)
    || value.factSnapshotId !== `fact-snapshot-sha256-${String(value.factSnapshotHash)}`) {
    errors.push("snapshot evaluation receipt fact snapshot identity invalid");
  }
  errors.push(...validatePlanEvaluationLock(value.evaluationLock).map((error) => `snapshot evaluation receipt ${error}`));
  if (record(value.evaluationLock)) {
    const lock = value.evaluationLock as unknown as PlanEvaluationLock;
    if (lock.planId !== value.planId || lock.factSnapshotId !== value.factSnapshotId
      || lock.snapshotHashes?.factSnapshotHash !== value.factSnapshotHash
      || lock.snapshotHashes?.configHash !== value.configHash) {
      errors.push("snapshot evaluation receipt plan/snapshot lock closure invalid");
    }
  }
  if (!record(value.domainHashes)) {
    errors.push("snapshot evaluation receipt domainHashes invalid");
  } else {
    for (const [domain, hash] of Object.entries(value.domainHashes)) {
      if (!DOMAIN_SET.has(domain) || !isSha256Hex(hash)) errors.push("snapshot evaluation receipt domain hash invalid");
    }
  }
  return errors;
}

export async function verifySnapshotEvaluationReceipt(value: unknown): Promise<boolean> {
  if (validateSnapshotEvaluationReceipt(value).length) return false;
  return verifyPlanEvaluationLock((value as SnapshotEvaluationReceipt).evaluationLock);
}

function validateFieldDiffs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["evaluation diff fieldDiffs invalid"];
  const errors: string[] = [];
  const fields = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!record(item) || !exactKeys(item, ["field", "beforeFactIds", "afterFactIds"])
      || typeof item.field !== "string" || item.field.length === 0
      || !uniqueStrings(item.beforeFactIds) || !uniqueStrings(item.afterFactIds)) {
      errors.push(`evaluation diff fieldDiffs.${index} invalid`);
      continue;
    }
    if (fields.has(item.field)) errors.push("evaluation diff contains duplicate field authority");
    fields.add(item.field);
  }
  return errors;
}

function diffHashMaterial(value: FactUpdateEvaluationDiffInput | FactUpdateEvaluationDiff): unknown {
  const material = structuredClone(value) as Partial<FactUpdateEvaluationDiff>;
  delete material.schemaVersion;
  delete material.hashSpecVersion;
  delete material.hashAlgorithm;
  delete material.canonicalizationPolicyId;
  delete material.evaluationDiffId;
  delete material.contentHash;
  return {
    ...FACT_UPDATE_EVALUATION_DIFF_HASH_AUTHORITY,
    schemaVersion: FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION,
    payload: material,
  };
}

export function factUpdateEvaluationDiffContentHash(value: FactUpdateEvaluationDiffInput | FactUpdateEvaluationDiff): string {
  return sha256Json(diffHashMaterial(value));
}

export function validateFactUpdateEvaluationDiff(value: unknown): string[] {
  if (!record(value)) return ["fact update evaluation diff must be an object"];
  const errors: string[] = [];
  const keys = [
    "schemaVersion", "hashSpecVersion", "hashAlgorithm", "canonicalizationPolicyId", "evaluationDiffId",
    "updateDecisionId", "updateDecisionHash", "planId", "before", "after", "changedDomains", "fieldDiffs", "contentHash",
  ];
  if (!exactKeys(value, keys)) errors.push("fact update evaluation diff fields invalid");
  if (value.schemaVersion !== FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION) errors.push("fact update evaluation diff schema invalid");
  if (value.hashSpecVersion !== HASH_SPEC_VERSION || value.hashAlgorithm !== "sha256"
    || value.canonicalizationPolicyId !== "canonical-json-v1") errors.push("fact update evaluation diff hash authority invalid");
  if (typeof value.evaluationDiffId !== "string" || !DIFF_ID.test(value.evaluationDiffId)
    || !isSha256Hex(value.contentHash) || value.evaluationDiffId !== `fact-update-evaluation-diff-sha256-${String(value.contentHash)}`) {
    errors.push("fact update evaluation diff content identity invalid");
  }
  if (typeof value.updateDecisionId !== "string" || !DECISION_ID.test(value.updateDecisionId)
    || !isSha256Hex(value.updateDecisionHash)
    || value.updateDecisionId !== `update-decision-sha256-${String(value.updateDecisionHash)}`) {
    errors.push("fact update evaluation diff decision identity invalid");
  }
  if (typeof value.planId !== "string" || !PLAN_ID.test(value.planId)) errors.push("fact update evaluation diff planId invalid");
  errors.push(...validateSnapshotEvaluationReceipt(value.before).map((error) => `before ${error}`));
  errors.push(...validateSnapshotEvaluationReceipt(value.after).map((error) => `after ${error}`));
  if (record(value.before) && record(value.after)) {
    if (value.before.planId !== value.planId || value.after.planId !== value.planId) errors.push("fact update evaluation diff plan closure invalid");
    if (value.before.runtimeGeneration !== value.after.runtimeGeneration) {
      errors.push("fact update evaluation diff runtime generation changed between snapshots");
    }
    if (!same(value.before.target, value.after.target) || value.before.configHash !== value.after.configHash) {
      errors.push("fact update evaluation diff plan target changed between snapshots");
    }
  }
  if (!uniqueStrings(value.changedDomains) || value.changedDomains.some((domain) => !DOMAIN_SET.has(domain))) {
    errors.push("fact update evaluation diff changedDomains invalid");
  } else if (!sortedUnique(value.changedDomains)) {
    errors.push("fact update evaluation diff changedDomains must be canonical");
  }
  errors.push(...validateFieldDiffs(value.fieldDiffs));
  return errors;
}

export async function verifyFactUpdateEvaluationDiff(value: unknown): Promise<boolean> {
  if (validateFactUpdateEvaluationDiff(value).length) return false;
  const diff = value as FactUpdateEvaluationDiff;
  return diff.contentHash === factUpdateEvaluationDiffContentHash(diff)
    && await verifySnapshotEvaluationReceipt(diff.before)
    && await verifySnapshotEvaluationReceipt(diff.after);
}

export async function createFactUpdateEvaluationDiff(input: FactUpdateEvaluationDiffInput): Promise<FactUpdateEvaluationDiff> {
  const material = structuredClone(input);
  const contentHash = factUpdateEvaluationDiffContentHash(material);
  const diff: FactUpdateEvaluationDiff = Object.freeze({
    schemaVersion: FACT_UPDATE_EVALUATION_DIFF_SCHEMA_VERSION,
    hashSpecVersion: HASH_SPEC_VERSION,
    hashAlgorithm: "sha256",
    canonicalizationPolicyId: "canonical-json-v1",
    ...material,
    evaluationDiffId: `fact-update-evaluation-diff-sha256-${contentHash}`,
    contentHash,
  });
  const errors = validateFactUpdateEvaluationDiff(diff);
  if (errors.length || !await verifyFactUpdateEvaluationDiff(diff)) {
    throw new TypeError(`Invalid FactUpdateEvaluationDiff: ${errors.join("; ") || "content authority invalid"}`);
  }
  return diff;
}

function normalizedFieldDiffs(value: readonly FactFieldDiff[]): FactFieldDiff[] {
  return value.map((diff) => ({
    field: diff.field,
    beforeFactIds: [...diff.beforeFactIds].sort(),
    afterFactIds: [...diff.afterFactIds].sort(),
  })).sort((left, right) => left.field.localeCompare(right.field));
}

function unchangedLockClosure(receipt: SnapshotEvaluationReceipt): unknown {
  const hashes = { ...receipt.evaluationLock.snapshotHashes, factSnapshotHash: undefined };
  return {
    planId: receipt.evaluationLock.planId,
    snapshotHashes: hashes,
    userObservationSnapshotId: receipt.evaluationLock.userObservationSnapshotId,
    artifactLockfileHash: receipt.evaluationLock.artifactLockfileHash,
  };
}

/** Validates the semantic closure that is intentionally not part of a receipt's self-hash validator. */
export async function validateFactUpdateEvaluationDiffClosure(
  diff: FactUpdateEvaluationDiff,
  decision: UpdateDecision,
): Promise<string[]> {
  const errors: string[] = [];
  if (!await verifyFactUpdateEvaluationDiff(diff)) errors.push("evaluation diff content authority invalid");
  if (diff.updateDecisionId !== decision.updateDecisionId || diff.updateDecisionHash !== decision.contentHash) {
    errors.push("evaluation diff decision closure invalid");
  }
  if (!decision.planIds.includes(diff.planId)) errors.push("evaluation diff plan is outside the update decision");
  const beforeRef = decision.decision === "undo" ? decision.newSnapshotRef : decision.oldSnapshotRef;
  const afterRef = decision.decision === "undo" ? decision.oldSnapshotRef : decision.newSnapshotRef;
  if (diff.before.factSnapshotId !== beforeRef.snapshotId || diff.before.factSnapshotHash !== beforeRef.contentHash
    || diff.after.factSnapshotId !== afterRef.snapshotId || diff.after.factSnapshotHash !== afterRef.contentHash) {
    errors.push("evaluation diff snapshot direction closure invalid");
  }
  if (!same(unchangedLockClosure(diff.before), unchangedLockClosure(diff.after))) {
    errors.push("evaluation diff changed non-fact evaluation authority");
  }
  const expectedFields = normalizedFieldDiffs(decision.decision === "undo"
    ? decision.fieldDiffs.map((field) => ({ field: field.field, beforeFactIds: field.afterFactIds, afterFactIds: field.beforeFactIds }))
    : decision.fieldDiffs);
  if (!same(normalizedFieldDiffs(diff.fieldDiffs), expectedFields)) errors.push("evaluation diff field closure invalid");
  const affected = [...decision.affectedDomains].sort();
  const beforeDomains = Object.keys(diff.before.domainHashes).sort();
  const afterDomains = Object.keys(diff.after.domainHashes).sort();
  if (!same(beforeDomains, affected) || !same(afterDomains, affected)) errors.push("evaluation diff affected-domain receipt closure incomplete");
  const expectedChanged = affected.filter((domain) => diff.before.domainHashes[domain] !== diff.after.domainHashes[domain]);
  if (!same(diff.changedDomains, expectedChanged)) errors.push("evaluation diff changed-domain summary invalid");
  return errors;
}
