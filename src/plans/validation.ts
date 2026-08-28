import { parseConfig, type BuildConfigDocument } from "../config/types";
import { validateGovernedPatchOperation } from "../contracts/registries";
import { EVIDENCE_SCHEMA_VERSION, type PlanEvidenceBinding } from "../evidence/contracts";
import { canonicalJson } from "./canonical";
import {
  PLAN_PATCH_PATHS,
  PLAN_PARTIAL_EVALUATION_V3_SCHEMA_VERSION,
  PLAN_PARTIAL_EVALUATION_V3_UNKNOWN_DOMAINS,
  PLAN_SCHEMA_VERSION,
  type BuildPlan,
  type BuildTask,
  type PlanAgentContext,
  type PlanChangeProposal,
  type PlanDraft,
  type PlanEvaluationSnapshot,
  type PlanPatchOperation,
  type PlanTransactionLink,
  type PlanVersion,
} from "./contracts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HASH = /^[a-f0-9]{64}$/;
const DOCUMENT_ID = /^doc-sha256-[a-f0-9]{64}$/;
const CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/;
const BINDING_ID = /^binding-sha256-[a-f0-9]{64}$/;
const EVIDENCE_PURPOSES = new Set(["identity", "compatibility", "geometry", "power", "wiring", "thermal", "assembly"]);
const EVIDENCE_SUBJECTS = new Set(["plan", "sku", "case-profile", "component"]);
const EVIDENCE_CATEGORIES = new Set(["case", "motherboard", "cpu", "psu", "cooler", "gpu", "memory", "storage", "hba", "fan", "accessory"]);
const MIGRATION_DIFF_OPERATIONS = new Set(["mapped", "expanded", "omitted"]);
const MIGRATION_WARNING_CODES = new Set([
  "owned_mapped_to_ordered", "legacy_purchase_bucket_mapped_to_planned", "nvme_identity_unresolved",
  "fan_identity_unresolved", "disk_identity_missing", "cooler_kind_unresolved", "legacy_hba_not_migrated",
  "legacy_bom_item_not_migrated", "legacy_topology_not_migrated",
]);
const MIGRATION_POINTER = /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/;
const patchPaths = new Set<string>(PLAN_PATCH_PATHS);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Browser-safe synchronous SHA-256 used only for validating persisted binding IDs. */
function sha256Sync(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input); bytes[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  for (let index = 0; index < 8; index += 1) bytes[paddedLength - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotate = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!; const right = words[index - 2]!;
      const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
      const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) state[index] = (state[index]! + word!) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function planEvidenceBindingIdentity(value: Pick<PlanEvidenceBinding, "planId" | "documentId" | "captureId" | "subject" | "purposes" | "locators">): unknown {
  const purposes = [...value.purposes].sort();
  const locators = value.locators
    ? [...value.locators].map((locator) => structuredClone(locator)).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
    : undefined;
  return {
    planId: value.planId,
    documentId: value.documentId,
    ...(value.captureId ? { captureId: value.captureId } : {}),
    subject: structuredClone(value.subject),
    purposes,
    ...(locators ? { locators } : {}),
  };
}

export function planEvidenceBindingId(value: Pick<PlanEvidenceBinding, "planId" | "documentId" | "captureId" | "subject" | "purposes" | "locators">): PlanEvidenceBinding["id"] {
  return `binding-sha256-${sha256Sync(canonicalJson(planEvidenceBindingIdentity(value)))}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof input[key] !== "string" || !String(input[key]).trim()) errors.push(`${key} must be a non-empty string`);
}

function isoDate(input: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof input[key] !== "string" || !ISO_DATE.test(String(input[key]))) errors.push(`${key} must be an ISO UTC date`);
}

function schema(input: Record<string, unknown>, errors: string[]): void {
  if (input.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
}

function validConfig(value: unknown): value is BuildConfigDocument {
  try {
    parseConfig(JSON.stringify(value), { topologyV3Enabled: true });
    return true;
  } catch {
    return false;
  }
}

function migrationPointer(value: unknown): boolean {
  return typeof value === "string" && value.length <= 512 && MIGRATION_POINTER.test(value);
}

function finiteJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => finiteJsonValue(item, ancestors));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value as Record<string, unknown>).every((item) => finiteJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function validateMigrationDiffItem(value: unknown, index: number): string[] {
  const item = record(value);
  const prefix = `configMigration diff.${index}`;
  if (!item) return [`${prefix} must be an object`];
  const errors: string[] = [];
  if (Object.keys(item).length !== 5 || Object.keys(item).some((key) => !["sourcePath", "targetPath", "operation", "before", "after"].includes(key))) errors.push(`${prefix} fields invalid`);
  if (!migrationPointer(item.sourcePath)) errors.push(`${prefix}.sourcePath invalid`);
  if (item.targetPath !== null && !migrationPointer(item.targetPath)) errors.push(`${prefix}.targetPath invalid`);
  if (!MIGRATION_DIFF_OPERATIONS.has(String(item.operation))) errors.push(`${prefix}.operation invalid`);
  if (!("before" in item) || !finiteJsonValue(item.before) || !("after" in item) || !finiteJsonValue(item.after)) errors.push(`${prefix} before/after must be finite JSON values`);
  return errors;
}

function validateMigrationWarningItem(value: unknown, index: number): string[] {
  const item = record(value);
  const prefix = `configMigration warnings.${index}`;
  if (!item) return [`${prefix} must be an object`];
  const errors: string[] = [];
  if (Object.keys(item).length !== 3 || Object.keys(item).some((key) => !["code", "sourcePath", "message"].includes(key))) errors.push(`${prefix} fields invalid`);
  if (!MIGRATION_WARNING_CODES.has(String(item.code))) errors.push(`${prefix}.code invalid`);
  if (!migrationPointer(item.sourcePath)) errors.push(`${prefix}.sourcePath invalid`);
  if (typeof item.message !== "string" || !item.message.trim() || item.message.length > 2_000) errors.push(`${prefix}.message invalid`);
  return errors;
}

function validateMigrationCatalogBinding(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["configMigration catalogBinding must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).length !== 5 || Object.keys(input).some((key) => !["schemaVersion", "rulesetId", "catalog", "cooler", "bindingHash"].includes(key))
    || input.schemaVersion !== "build-config-v3-migration-catalog-binding-v1"
    || input.rulesetId !== "v2-to-v3-governed-component-kind-v1") errors.push("configMigration catalogBinding shape/ruleset invalid");
  const catalog = record(input.catalog);
  if (!catalog || Object.keys(catalog).length !== 4 || Object.keys(catalog).some((key) => !["contentHash", "schemaVersion", "catalogVersion", "updatedAt"].includes(key))
    || typeof catalog.contentHash !== "string" || !HASH.test(catalog.contentHash)
    || typeof catalog.schemaVersion !== "string" || !catalog.schemaVersion || catalog.schemaVersion !== catalog.schemaVersion.normalize("NFC")
    || catalog.catalogVersion !== null && (typeof catalog.catalogVersion !== "string" || !catalog.catalogVersion || catalog.catalogVersion !== catalog.catalogVersion.normalize("NFC"))
    || typeof catalog.updatedAt !== "string" || !Number.isFinite(Date.parse(catalog.updatedAt)) || catalog.updatedAt !== catalog.updatedAt.normalize("NFC")) {
    errors.push("configMigration catalogBinding catalog authority invalid");
  }
  const cooler = record(input.cooler);
  if (!cooler || Object.keys(cooler).length !== 4 || Object.keys(cooler).some((key) => !["skuId", "catalogSkuId", "category", "type"].includes(key))
    || typeof cooler.skuId !== "string" || cooler.skuId !== cooler.skuId.normalize("NFC")
    || cooler.catalogSkuId !== null && (typeof cooler.catalogSkuId !== "string" || !cooler.catalogSkuId || cooler.catalogSkuId !== cooler.catalogSkuId.normalize("NFC"))
    || cooler.category !== null && (typeof cooler.category !== "string" || !cooler.category || cooler.category !== cooler.category.normalize("NFC"))
    || cooler.type !== null && (typeof cooler.type !== "string" || !cooler.type || cooler.type !== cooler.type.normalize("NFC"))
    || cooler.catalogSkuId !== null && cooler.catalogSkuId !== cooler.skuId
    || (cooler.catalogSkuId === null) !== (cooler.category === null)
    || cooler.catalogSkuId === null && cooler.type !== null) errors.push("configMigration catalogBinding cooler projection invalid");
  if (typeof input.bindingHash !== "string" || !HASH.test(input.bindingHash)) errors.push("configMigration catalogBinding hash invalid");
  else if (catalog && cooler) {
    try {
      const material = { schemaVersion: input.schemaVersion, rulesetId: input.rulesetId, catalog, cooler };
      if (sha256Sync(canonicalJson(material)) !== input.bindingHash) errors.push("configMigration catalogBinding content hash mismatch");
    } catch {
      errors.push("configMigration catalogBinding content is not canonical JSON");
    }
  }
  return errors;
}

function validateConfigMigration(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["configMigration must be an object"];
  const errors: string[] = [];
  const allowed = ["schemaVersion", "sourceSchemaVersion", "targetSchemaVersion", "sourceVersionId", "sourceConfigHash", "migratedAt", "catalogBinding", "diff", "warnings", "rollbackRef"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) errors.push("configMigration contains unknown fields");
  if (input.schemaVersion !== "plan-config-migration-v1" || input.sourceSchemaVersion !== "2.0.0" || input.targetSchemaVersion !== "3.0.0") errors.push("configMigration schema transition invalid");
  requiredString(input, "sourceVersionId", errors);
  if (typeof input.sourceConfigHash !== "string" || !HASH.test(input.sourceConfigHash)) errors.push("configMigration sourceConfigHash invalid");
  isoDate(input, "migratedAt", errors);
  errors.push(...validateMigrationCatalogBinding(input.catalogBinding));
  if (!Array.isArray(input.diff)) errors.push("configMigration diff invalid");
  else input.diff.forEach((item, index) => errors.push(...validateMigrationDiffItem(item, index)));
  if (!Array.isArray(input.warnings)) errors.push("configMigration warnings invalid");
  else input.warnings.forEach((item, index) => errors.push(...validateMigrationWarningItem(item, index)));
  const rollback = record(input.rollbackRef);
  if (!rollback || rollback.schemaVersion !== "build-config-v2-rollback-ref-v1" || rollback.sourceSchemaVersion !== "2.0.0"
    || typeof rollback.configId !== "string" || !rollback.configId || typeof rollback.sourceHash !== "string" || !HASH.test(rollback.sourceHash)
    || !Number.isSafeInteger(rollback.sourceByteLength) || Number(rollback.sourceByteLength) <= 0) errors.push("configMigration rollbackRef invalid");
  return errors;
}

function validateIntent(value: unknown, prefix: string): string[] {
  const input = record(value);
  if (!input) return [`${prefix} must be an object`];
  const errors: string[] = [];
  const allowed = ["useCase", "budgetCny", "region", "targetResolution", "targetFps", "games", "ownedSkuIds", "preferences"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) errors.push(`${prefix} contains unknown fields`);
  if (typeof input.useCase !== "string" || !input.useCase.trim()) errors.push(`${prefix}.useCase invalid`);
  if (input.budgetCny !== undefined && input.budgetCny !== null && (typeof input.budgetCny !== "number" || !Number.isFinite(input.budgetCny) || input.budgetCny < 0)) errors.push(`${prefix}.budgetCny invalid`);
  if (input.region !== undefined && typeof input.region !== "string") errors.push(`${prefix}.region invalid`);
  if (input.targetResolution !== undefined && !["1080p", "1440p", "4k", "other"].includes(String(input.targetResolution))) errors.push(`${prefix}.targetResolution invalid`);
  if (input.targetFps !== undefined && input.targetFps !== null && (typeof input.targetFps !== "number" || !Number.isFinite(input.targetFps) || input.targetFps < 0)) errors.push(`${prefix}.targetFps invalid`);
  for (const key of ["games", "ownedSkuIds", "preferences"]) if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].some((item) => typeof item !== "string"))) errors.push(`${prefix}.${key} invalid`);
  return errors;
}

function validateInitialization(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["initialization must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["status", "source", "intent", "proposalId", "initializedAt"].includes(key))) errors.push("initialization contains unknown fields");
  if (input.status !== "pending" && input.status !== "initialized") errors.push("initialization.status invalid");
  if (input.source !== "agent" && input.source !== "template" && input.source !== "manual") errors.push("initialization.source invalid");
  if (input.proposalId !== undefined && (typeof input.proposalId !== "string" || !input.proposalId)) errors.push("initialization.proposalId invalid");
  if (input.initializedAt !== undefined) isoDate(input, "initializedAt", errors);
  if (input.intent !== undefined) {
    errors.push(...validateIntent(input.intent, "initialization.intent"));
  }
  return errors;
}

function validateEvidenceLocator(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["locator must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["page", "printedPage", "section", "field", "locator", "snippet"].includes(key))) errors.push("locator contains unknown fields");
  const page = input.page;
  if (page !== undefined && !(
    (Number.isSafeInteger(page) && Number(page) > 0)
    || (Array.isArray(page) && page.length > 0 && page.every((item) => Number.isSafeInteger(item) && Number(item) > 0))
  )) errors.push("locator.page invalid");
  const printedPage = input.printedPage;
  if (printedPage !== undefined && !(
    (typeof printedPage === "string" && printedPage.trim())
    || (Array.isArray(printedPage) && printedPage.length > 0 && printedPage.every((item) => typeof item === "string" && item.trim()))
  )) errors.push("locator.printedPage invalid");
  for (const key of ["section", "field", "locator", "snippet"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !String(input[key]).trim())) errors.push(`locator.${key} invalid`);
  }
  if (!["page", "printedPage", "section", "field", "locator", "snippet"].some((key) => input[key] !== undefined)) errors.push("locator must identify a document location");
  return errors;
}

export function validatePlanEvidenceBinding(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["evidence binding must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["schemaVersion", "id", "planId", "planVersionId", "documentId", "contentHash", "captureId", "subject", "purposes", "locators", "boundAt", "note"].includes(key))) errors.push("evidence binding contains unknown fields");
  if (input.schemaVersion !== EVIDENCE_SCHEMA_VERSION) errors.push(`evidence binding schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  if (typeof input.id !== "string" || !BINDING_ID.test(input.id)) errors.push("evidence binding id invalid");
  requiredString(input, "planId", errors);
  if (input.planVersionId !== undefined && input.planVersionId !== null && (typeof input.planVersionId !== "string" || !input.planVersionId)) errors.push("evidence binding planVersionId invalid");
  if (typeof input.documentId !== "string" || !DOCUMENT_ID.test(input.documentId)) errors.push("evidence binding documentId invalid");
  if (typeof input.contentHash !== "string" || !HASH.test(input.contentHash)) errors.push("evidence binding contentHash invalid");
  if (typeof input.documentId === "string" && typeof input.contentHash === "string" && input.documentId !== `doc-sha256-${input.contentHash}`) errors.push("evidence binding documentId/contentHash mismatch");
  if (input.captureId !== undefined && (typeof input.captureId !== "string" || !CAPTURE_ID.test(input.captureId))) errors.push("evidence binding captureId invalid");
  const subject = record(input.subject);
  if (!subject || !EVIDENCE_SUBJECTS.has(String(subject.kind)) || typeof subject.id !== "string" || !subject.id.trim()) errors.push("evidence binding subject invalid");
  if (subject && Object.keys(subject).some((key) => !["kind", "id", "category"].includes(key))) errors.push("evidence binding subject contains unknown fields");
  if (subject?.category !== undefined && !EVIDENCE_CATEGORIES.has(String(subject.category))) errors.push("evidence binding subject category invalid");
  if (subject?.category !== undefined && subject.kind !== "sku" && subject.kind !== "component") errors.push("evidence binding subject category is not allowed for this subject kind");
  if (subject?.kind === "plan" && subject.id !== input.planId) errors.push("plan evidence subject does not match binding owner");
  if (!Array.isArray(input.purposes) || input.purposes.length === 0 || new Set(input.purposes).size !== input.purposes.length || input.purposes.some((purpose) => !EVIDENCE_PURPOSES.has(String(purpose)))) errors.push("evidence binding purposes invalid");
  if (input.locators !== undefined) {
    if (!Array.isArray(input.locators) || input.locators.length === 0) errors.push("evidence binding locators invalid");
    else input.locators.forEach((locator, index) => errors.push(...validateEvidenceLocator(locator).map((error) => `locators.${index}.${error}`)));
  }
  isoDate(input, "boundAt", errors);
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 500)) errors.push("evidence binding note invalid");
  try {
    if (input.id !== planEvidenceBindingId(input as unknown as PlanEvidenceBinding)) errors.push("evidence binding id does not match semantic identity");
  } catch {
    errors.push("evidence binding semantic identity invalid");
  }
  return errors;
}

function validateEvidenceBindings(value: unknown, ownerPlanId?: unknown, versionId?: unknown): string[] {
  if (!Array.isArray(value)) return ["evidenceBindings must be an array"];
  const errors: string[] = [];
  const ids = new Set<string>();
  const semanticIdentities = new Set<string>();
  value.forEach((binding, index) => {
    errors.push(...validatePlanEvidenceBinding(binding).map((error) => `evidenceBindings.${index}.${error}`));
    const item = record(binding);
    if (!item) return;
    if (ownerPlanId !== undefined && item.planId !== ownerPlanId) errors.push(`evidenceBindings.${index}.planId does not match owner`);
    if (versionId === null) {
      if (item.planVersionId !== null && item.planVersionId !== undefined) errors.push(`evidenceBindings.${index}.planVersionId does not match draft`);
    } else if (versionId !== undefined && item.planVersionId !== versionId) errors.push(`evidenceBindings.${index}.planVersionId does not match version`);
    if (typeof item.id === "string") {
      if (ids.has(item.id)) errors.push(`evidenceBindings.${index}.id duplicated`);
      ids.add(item.id);
    }
    try {
      const identity = canonicalJson(planEvidenceBindingIdentity(item as unknown as PlanEvidenceBinding));
      if (semanticIdentities.has(identity)) errors.push(`evidenceBindings.${index}.semantic identity duplicated`);
      semanticIdentities.add(identity);
    } catch {
      // The item-level validator reports invalid semantic identity details.
    }
  });
  return errors;
}

export function validatePlanDraft(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["draft must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["schemaVersion", "baseVersionId", "config", "configMigration", "configAccess", "evidenceBindings", "dirty", "updatedAt"].includes(key))) errors.push("draft contains unknown fields");
  schema(input, errors);
  if (input.baseVersionId !== null && (typeof input.baseVersionId !== "string" || !input.baseVersionId)) errors.push("baseVersionId invalid");
  if (!validConfig(input.config)) errors.push("config must be a valid BuildConfig");
  if (input.configMigration !== undefined) errors.push(...validateConfigMigration(input.configMigration));
  if (input.configAccess !== undefined) {
    const access = record(input.configAccess);
    if (!access || Object.keys(access).some((key) => !["mode", "sourceVersionId"].includes(key)) || access.mode !== "v2_fallback" || typeof access.sourceVersionId !== "string" || !access.sourceVersionId) errors.push("configAccess invalid");
  }
  if (input.evidenceBindings !== undefined) errors.push(...validateEvidenceBindings(input.evidenceBindings));
  if (typeof input.dirty !== "boolean") errors.push("dirty must be boolean");
  isoDate(input, "updatedAt", errors);
  return errors;
}

export function validateBuildPlan(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["plan must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["schemaVersion", "id", "name", "description", "status", "createdAt", "updatedAt", "activeVersionId", "draftRevision", "draft", "metadata"].includes(key))) errors.push("plan contains unknown fields");
  schema(input, errors);
  requiredString(input, "id", errors);
  requiredString(input, "name", errors);
  if (input.description !== undefined && typeof input.description !== "string") errors.push("description invalid");
  if (input.status !== "active" && input.status !== "archived") errors.push("status invalid");
  isoDate(input, "createdAt", errors);
  isoDate(input, "updatedAt", errors);
  if (input.activeVersionId !== null && (typeof input.activeVersionId !== "string" || !input.activeVersionId)) errors.push("activeVersionId invalid");
  if (!Number.isSafeInteger(input.draftRevision) || Number(input.draftRevision) < 0) errors.push("draftRevision invalid");
  errors.push(...validatePlanDraft(input.draft).map((error) => `draft.${error}`));
  const draft = record(input.draft);
  if (draft?.evidenceBindings !== undefined) errors.push(...validateEvidenceBindings(draft.evidenceBindings, input.id, null).map((error) => `draft.${error}`));
  const metadata = record(input.metadata);
  if (!metadata) errors.push("metadata must be an object");
  else {
    if (Object.keys(metadata).some((key) => !["useCase", "budgetCny", "tags", "initialization"].includes(key))) errors.push("metadata contains unknown fields");
    if (metadata.useCase !== undefined && typeof metadata.useCase !== "string") errors.push("metadata.useCase invalid");
    if (metadata.budgetCny !== undefined && metadata.budgetCny !== null && (typeof metadata.budgetCny !== "number" || !Number.isFinite(metadata.budgetCny) || metadata.budgetCny < 0)) errors.push("metadata.budgetCny invalid");
    if (metadata.tags !== undefined && (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== "string"))) errors.push("metadata.tags invalid");
    if (metadata.initialization !== undefined) errors.push(...validateInitialization(metadata.initialization));
  }
  return errors;
}

export function validatePlanVersion(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["version must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["schemaVersion", "id", "planId", "versionNumber", "createdAt", "reason", "summary", "config", "configHash", "evidenceBindings", "evidenceHash", "evaluationHash", "evaluatedAt", "parentVersionId"].includes(key))) errors.push("version contains unknown fields");
  schema(input, errors);
  for (const key of ["id", "planId"]) requiredString(input, key, errors);
  if (!Number.isSafeInteger(input.versionNumber) || Number(input.versionNumber) < 1) errors.push("versionNumber invalid");
  isoDate(input, "createdAt", errors);
  if (!["initial", "manual-save", "agent-proposal", "import", "restore", "migration-source"].includes(String(input.reason))) errors.push("reason invalid");
  if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 500)) errors.push("summary invalid");
  if (!validConfig(input.config)) errors.push("config must be a valid BuildConfig");
  if (typeof input.configHash !== "string" || !HASH.test(input.configHash)) errors.push("configHash must be a sha256 hex digest");
  if (input.evidenceBindings !== undefined) errors.push(...validateEvidenceBindings(input.evidenceBindings, input.planId, input.id));
  if (input.evidenceHash !== undefined && (typeof input.evidenceHash !== "string" || !HASH.test(input.evidenceHash))) errors.push("evidenceHash invalid");
  if ((input.evidenceBindings === undefined) !== (input.evidenceHash === undefined)) errors.push("evidenceBindings and evidenceHash must be present together");
  if (input.evaluationHash !== undefined && (typeof input.evaluationHash !== "string" || !HASH.test(input.evaluationHash))) errors.push("evaluationHash invalid");
  if (input.evaluatedAt !== undefined) isoDate(input, "evaluatedAt", errors);
  if (input.parentVersionId !== null && (typeof input.parentVersionId !== "string" || !input.parentVersionId)) errors.push("parentVersionId invalid");
  return errors;
}

export function validatePlanEvaluationSnapshot(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["evaluation snapshot must be an object"];
  const errors: string[] = [];
  if (Object.keys(input).some((key) => !["schemaVersion", "planId", "planVersionId", "draftRevision", "configHash", "evaluationHash", "evaluatedAt", "evaluation"].includes(key))) errors.push("evaluation snapshot contains unknown fields");
  schema(input, errors);
  requiredString(input, "planId", errors);
  if (input.planVersionId !== null && (typeof input.planVersionId !== "string" || !input.planVersionId)) errors.push("planVersionId invalid");
  if (!Number.isSafeInteger(input.draftRevision) || Number(input.draftRevision) < 0) errors.push("draftRevision invalid");
  for (const key of ["configHash", "evaluationHash"]) {
    if (typeof input[key] !== "string" || !HASH.test(input[key])) errors.push(`${key} invalid`);
  }
  isoDate(input, "evaluatedAt", errors);
  errors.push(...validatePlanEvaluationPayload(input.evaluation));
  return errors;
}

function validateTopologyBomLine(value: unknown, index: number): string[] {
  const line = record(value);
  const prefix = `evaluation.topologyBom.${index}`;
  if (!line) return [`${prefix} invalid`];
  const common = ["instanceId", "kind", "role", "state", "quantity", "identityStatus"];
  const identity = line.identityStatus === "resolved" ? ["skuId", "identityClaimIds"] : ["userText", "candidateIds"];
  const errors: string[] = [];
  if (Object.keys(line).some((key) => ![...common, ...identity].includes(key))) errors.push(`${prefix} contains unknown fields`);
  for (const key of ["instanceId", "kind", "role", "state"]) if (typeof line[key] !== "string" || !String(line[key]).trim()) errors.push(`${prefix}.${key} invalid`);
  if (line.quantity !== 1) errors.push(`${prefix}.quantity invalid`);
  if (line.identityStatus === "resolved") {
    if (typeof line.skuId !== "string" || !line.skuId.trim() || !Array.isArray(line.identityClaimIds) || line.identityClaimIds.some((id) => typeof id !== "string" || !id)) errors.push(`${prefix}.resolved identity invalid`);
  } else if (line.identityStatus === "unresolved") {
    if (typeof line.userText !== "string" || !line.userText.trim() || (line.candidateIds !== undefined && (!Array.isArray(line.candidateIds) || line.candidateIds.some((id) => typeof id !== "string" || !id)))) errors.push(`${prefix}.unresolved identity invalid`);
  } else errors.push(`${prefix}.identityStatus invalid`);
  return errors;
}

export function validatePlanEvaluationPayload(value: unknown): string[] {
  const evaluation = record(value);
  if (!evaluation) return ["evaluation must be an object"];
  if (evaluation.kind !== "topology-v3-partial") {
    const config = record(evaluation.config);
    return config?.schemaVersion === "2.0.0" && validConfig(config) ? [] : ["V2 evaluation config invalid"];
  }
  const errors: string[] = [];
  const allowed = ["schemaVersion", "kind", "configSchemaVersion", "topologyBom", "unknownDomains"];
  if (Object.keys(evaluation).some((key) => !allowed.includes(key))) errors.push("V3 partial evaluation contains unknown fields");
  if (evaluation.schemaVersion !== PLAN_PARTIAL_EVALUATION_V3_SCHEMA_VERSION || evaluation.configSchemaVersion !== "3.0.0") errors.push("V3 partial evaluation schema invalid");
  if (!Array.isArray(evaluation.topologyBom)) errors.push("V3 partial evaluation topologyBom invalid");
  else {
    evaluation.topologyBom.forEach((line, index) => errors.push(...validateTopologyBomLine(line, index)));
    const ids = evaluation.topologyBom.map((line) => record(line)?.instanceId).filter((id): id is string => typeof id === "string");
    if (new Set(ids.map((id) => id.normalize("NFC"))).size !== ids.length) errors.push("V3 partial evaluation topologyBom instanceId duplicated");
  }
  if (!Array.isArray(evaluation.unknownDomains)
    || evaluation.unknownDomains.length !== PLAN_PARTIAL_EVALUATION_V3_UNKNOWN_DOMAINS.length
    || evaluation.unknownDomains.some((domain, index) => domain !== PLAN_PARTIAL_EVALUATION_V3_UNKNOWN_DOMAINS[index])) {
    errors.push("V3 partial evaluation unknownDomains incomplete");
  }
  return errors;
}

export function validatePlanAgentContext(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["agent context must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  requiredString(input, "planId", errors);
  if (input.planVersionId !== null && (typeof input.planVersionId !== "string" || !input.planVersionId)) errors.push("planVersionId invalid");
  if (!Number.isSafeInteger(input.draftRevision) || Number(input.draftRevision) < 0) errors.push("draftRevision invalid");
  for (const key of ["configHash", "evaluationHash"]) {
    if (typeof input[key] !== "string" || !HASH.test(input[key])) errors.push(`${key} invalid`);
  }
  if (!validConfig(input.buildConfig)) errors.push("buildConfig must be a valid BuildConfig");
  errors.push(...validatePlanEvaluationPayload(input.evaluation));
  const config = record(input.buildConfig);
  const evaluation = record(input.evaluation);
  if (config?.schemaVersion === "3.0.0" && evaluation?.kind !== "topology-v3-partial") errors.push("BuildConfig V3 requires a V3 partial evaluation");
  if (config?.schemaVersion === "2.0.0" && evaluation?.kind === "topology-v3-partial") errors.push("BuildConfig V2 cannot use a V3 partial evaluation");
  const selection = input.spatialSelection;
  if (selection !== undefined && selection !== null) {
    const spatial = record(selection);
    if (!spatial || typeof spatial.partId !== "string" || !spatial.partId || typeof spatial.view !== "string" || !spatial.view) errors.push("spatialSelection invalid");
  }
  if ("spatialViewContext" in input && input.spatialViewContext !== null && !record(input.spatialViewContext)) errors.push("spatialViewContext invalid");
  if (!("purchaseSummary" in input)) errors.push("purchaseSummary missing");
  if (!("buildTaskSummary" in input)) errors.push("buildTaskSummary missing");
  if (input.evidenceSummary !== undefined) {
    const summary = record(input.evidenceSummary);
    if (!summary || !Number.isSafeInteger(summary.count) || Number(summary.count) < 0 || !Array.isArray(summary.bindings) || summary.bindings.length > 40 || Number(summary.count) < summary.bindings.length) errors.push("evidenceSummary invalid");
    else summary.bindings.forEach((binding, index) => {
      const row = record(binding);
      if (!row || typeof row.documentId !== "string" || !DOCUMENT_ID.test(row.documentId)) errors.push(`evidenceSummary.bindings.${index} invalid`);
      if (row?.captureId !== undefined && (typeof row.captureId !== "string" || !CAPTURE_ID.test(row.captureId))) errors.push(`evidenceSummary.bindings.${index}.captureId invalid`);
      if (!record(row?.subject) || !Array.isArray(row?.purposes)) errors.push(`evidenceSummary.bindings.${index}.claims invalid`);
      if (row?.locators !== undefined && !Array.isArray(row.locators)) errors.push(`evidenceSummary.bindings.${index}.locators invalid`);
    });
  }
  if (input.initialization !== undefined) errors.push(...validateInitialization(input.initialization));
  return errors;
}

export function validatePlanPatchOperation(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["operation must be an object"];
  const errors: string[] = [];
  const allowedKeys = input.op === "remove" ? ["op", "path"] : ["op", "path", "value"];
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) errors.push("operation contains unknown fields");
  if (input.op !== "add" && input.op !== "replace" && input.op !== "remove") errors.push("operation op invalid");
  if (typeof input.path !== "string" || !patchPaths.has(input.path)) errors.push("operation path is not allowlisted");
  if ((input.op === "add" || input.op === "replace") && !("value" in input)) errors.push("operation value missing");
  if (input.op === "remove" && "value" in input) errors.push("remove operation cannot contain value");
  return errors;
}

function hasUserAuthorityAssertion(value: unknown): "authority" | "confirmation" | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = hasUserAuthorityAssertion(item);
      if (result) return result;
    }
    return null;
  }
  const input = record(value);
  if (!input) return null;
  if (input.confirmedByUser === true || input.lockedByUser === true) return "confirmation";
  if (input.source === "user" || (typeof input.confirmedAt === "string" && input.confirmedAt)) return "authority";
  for (const child of Object.values(input)) {
    const result = hasUserAuthorityAssertion(child);
    if (result) return result;
  }
  return null;
}

function hasTrustedProvenanceAssertion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTrustedProvenanceAssertion);
  const input = record(value);
  if (!input) return false;
  return ["migration", "defaulted", "system_requirement"].includes(String(input.source))
    || Object.values(input).some(hasTrustedProvenanceAssertion);
}

function validateAgentRequirementProvenance(value: unknown): string[] {
  if (value === null) return [];
  const spec = record(value);
  if (!spec) return ["Agent requirementSpec proposal invalid"];
  const fields: unknown[] = [spec.budget, spec.horizonYears];
  if (Array.isArray(spec.workloads)) for (const workload of spec.workloads) {
    fields.push(workload);
    const row = record(workload);
    if (Array.isArray(row?.metrics)) fields.push(...row.metrics);
  }
  if (Array.isArray(spec.constraints)) fields.push(...spec.constraints);
  return fields.filter((field) => field !== undefined).some((field) => {
    const row = record(field);
    return !row || !["answered", "deferred", "not_applicable"].includes(String(row.state)) || row.source !== "agent_proposed" || row.confirmedByUser !== false;
  }) ? ["Agent requirement proposal must use source=agent_proposed and confirmedByUser=false"] : [];
}

function validateAgentRequirementEntity(value: unknown, kind: "workload" | "metric" | "constraint"): string[] {
  const entity = record(value);
  if (!entity || !["answered", "deferred", "not_applicable"].includes(String(entity.state))
    || entity.source !== "agent_proposed" || entity.confirmedByUser !== false) {
    return [`Agent ${kind} proposal must use an explicit state, source=agent_proposed, and confirmedByUser=false`];
  }
  if (kind === "workload" && Array.isArray(entity.metrics) && entity.metrics.some((metric) => validateAgentRequirementEntity(metric, "metric").length)) {
    return ["Agent workload metrics must use an explicit state, source=agent_proposed, and confirmedByUser=false"];
  }
  return [];
}

export function validatePlanV3ProposalOperation(value: unknown): string[] {
  const input = record(value);
  const selector = record(input?.selector);
  const assertion = hasUserAuthorityAssertion(input?.value);
  if (assertion === "confirmation") return ["Agent proposal cannot assert user confirmation"];
  if (assertion === "authority") return ["Agent proposal cannot assert user authority"];
  if (hasTrustedProvenanceAssertion(input?.value)) return ["Agent proposal cannot assert trusted migration, defaulted, or system provenance"];
  if (input?.op === "add" && selector?.collection === "roleDecisions") {
    const decision = record(input.value);
    if (!decision) return ["role decision proposal value invalid"];
    if (Object.keys(decision).some((key) => !["roleDecisionId", "role", "decision"].includes(key))) return ["role decision proposal cannot assert user authority"];
    if (decision.roleDecisionId !== selector.id || typeof decision.role !== "string" || !decision.role.trim() || decision.decision !== "not_needed") return ["role decision proposal invalid"];
    return [];
  }
  if (input?.op === "add" && selector?.collection === "components" && record(input.value)?.source !== "agent") {
    return ["Agent component proposal must use source=agent"];
  }
  if (input?.op === "add" && ["workloads", "metrics", "constraints"].includes(String(selector?.collection))) {
    const errors = validateAgentRequirementEntity(input.value, String(selector?.collection).replace(/s$/, "") as "workload" | "metric" | "constraint");
    if (errors.length) return errors;
  }
  if (input?.op === "replace" && selector?.collection === "config" && selector.field === "requirementSpec") {
    const errors = validateAgentRequirementProvenance(input.value);
    if (errors.length) return errors;
  }
  if (input?.op === "replace" && selector?.collection === "config" && ["requirementBudget", "requirementHorizonYears"].includes(String(selector.field))) {
    const field = record(input.value);
    if (!field || field.source !== "agent_proposed" || field.confirmedByUser !== false) {
      return ["Agent requirement field proposal must use source=agent_proposed and confirmedByUser=false"];
    }
  }
  return validateGovernedPatchOperation("plan-v3", value, { actor: "agent" });
}

export function validatePlanChangeProposal(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["proposal must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  for (const key of ["id", "planId", "summary"]) requiredString(input, key, errors);
  if (!Number.isSafeInteger(input.expectedDraftRevision) || Number(input.expectedDraftRevision) < 0) errors.push("expectedDraftRevision invalid");
  if (typeof input.expectedConfigHash !== "string" || !HASH.test(input.expectedConfigHash)) errors.push("expectedConfigHash invalid");
  isoDate(input, "createdAt", errors);
  if (!Array.isArray(input.rationale) || input.rationale.some((item) => typeof item !== "string")) errors.push("rationale invalid");
  if (input.configSchemaVersion !== undefined && input.configSchemaVersion !== "2.0.0" && input.configSchemaVersion !== "3.0.0") errors.push("configSchemaVersion invalid");
  if (input.migrationCatalogBinding !== undefined) {
    if (input.configSchemaVersion !== "3.0.0") errors.push("migrationCatalogBinding is only valid for a V3 proposal");
    errors.push(...validateMigrationCatalogBinding(input.migrationCatalogBinding));
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) errors.push("operations must not be empty");
  else input.operations.forEach((operation, index) => errors.push(...(
    input.configSchemaVersion === "3.0.0" ? validatePlanV3ProposalOperation(operation) : validatePlanPatchOperation(operation)
  ).map((error) => `operations.${index}.${error}`)));
  if (input.confirmableRequirementFieldIds !== undefined && (!Array.isArray(input.confirmableRequirementFieldIds)
    || input.confirmableRequirementFieldIds.some((id) => typeof id !== "string" || !id)
    || new Set(input.confirmableRequirementFieldIds).size !== input.confirmableRequirementFieldIds.length)) errors.push("confirmableRequirementFieldIds invalid");
  if (!["proposed", "applied", "rejected", "stale"].includes(String(input.status))) errors.push("status invalid");
  if (input.kind !== undefined && input.kind !== "change" && input.kind !== "initialization") errors.push("kind invalid");
  if (input.kind === "initialization") {
    const intent = record(input.intent);
    if (!intent || typeof intent.useCase !== "string" || !intent.useCase.trim()) errors.push("initialization intent invalid");
  }
  return errors;
}

export function validatePlanTransactionLink(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["transaction link must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  for (const key of ["planId", "planVersionIdAtCapture", "planItemId"]) {
    if (input[key] !== null && (typeof input[key] !== "string" || !input[key])) errors.push(`${key} invalid`);
  }
  if (!["linked", "unlinked", "stale"].includes(String(input.linkStatus))) errors.push("linkStatus invalid");
  if (input.linkStatus === "linked" && (!input.planId || !input.planItemId)) errors.push("linked transaction requires planId and planItemId");
  return errors;
}

export function validateBuildTask(value: unknown): string[] {
  const input = record(value);
  if (!input) return ["task must be an object"];
  const errors: string[] = [];
  schema(input, errors);
  for (const key of ["id", "planId", "sourceVersionId", "sourceRef", "title"]) requiredString(input, key, errors);
  if (!["purchase", "assembly", "wiring", "verification"].includes(String(input.kind))) errors.push("kind invalid");
  if (!["todo", "doing", "done", "blocked", "obsolete"].includes(String(input.status))) errors.push("status invalid");
  if (input.statusSource !== undefined && input.statusSource !== "derived" && input.statusSource !== "manual") errors.push("statusSource invalid");
  if (input.order !== undefined && (!Number.isSafeInteger(input.order) || Number(input.order) < 0)) errors.push("order invalid");
  if (input.dependsOn !== undefined && (!Array.isArray(input.dependsOn) || input.dependsOn.some((item) => typeof item !== "string" || !item))) errors.push("dependsOn invalid");
  for (const key of ["relatedPartId", "cableId", "findingId", "note", "staleReason"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") errors.push(`${key} invalid`);
  }
  if (input.evidenceRefs !== undefined && (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.some((item) => typeof item !== "string" || !item))) errors.push("evidenceRefs invalid");
  for (const key of ["updatedAt", "completedAt"]) if (input[key] !== undefined) isoDate(input, key, errors);
  return errors;
}

export function assertValidBuildPlan(value: unknown): asserts value is BuildPlan {
  const errors = validateBuildPlan(value);
  if (errors.length) throw new Error(`Invalid BuildPlan: ${errors.join("; ")}`);
}

export function assertValidPlanVersion(value: unknown): asserts value is PlanVersion {
  const errors = validatePlanVersion(value);
  if (errors.length) throw new Error(`Invalid PlanVersion: ${errors.join("; ")}`);
}

export function assertValidPlanChangeProposal(value: unknown): asserts value is PlanChangeProposal {
  const errors = validatePlanChangeProposal(value);
  if (errors.length) throw new Error(`Invalid PlanChangeProposal: ${errors.join("; ")}`);
}

export function assertValidPlanEvaluationSnapshot(value: unknown): asserts value is PlanEvaluationSnapshot {
  const errors = validatePlanEvaluationSnapshot(value);
  if (errors.length) throw new Error(`Invalid PlanEvaluationSnapshot: ${errors.join("; ")}`);
}

export function assertValidPlanAgentContext(value: unknown): asserts value is PlanAgentContext {
  const errors = validatePlanAgentContext(value);
  if (errors.length) throw new Error(`Invalid PlanAgentContext: ${errors.join("; ")}`);
}

export type ValidatedPlanTypes = BuildPlan | PlanDraft | PlanVersion | PlanChangeProposal | PlanPatchOperation | PlanTransactionLink | BuildTask | PlanEvidenceBinding;
