import { canonicalize, sha256Hex } from "../hash";
import { PHYSICAL_HOLDOUT_LAYOUTS, type PhysicalHoldoutLayout } from "./physical-holdout";

export const EXTERNAL_REVIEW_VALIDATION_SCHEMA_VERSION = "external-review-validation-v1" as const;
export const EXTERNAL_REVIEW_OBSERVATION_DOMAINS = Object.freeze([
  "clearance",
  "cable_length",
  "temperature",
  "acoustic",
] as const);

export type ExternalReviewObservationDomain = (typeof EXTERNAL_REVIEW_OBSERVATION_DOMAINS)[number];
export type ExternalReviewObservationStatus = "measured" | "reported_without_numeric_value" | "not_reported";

export interface ExternalReviewObservation {
  domain: ExternalReviewObservationDomain;
  status: ExternalReviewObservationStatus;
  value: number | null;
  unit: "mm" | "c" | "dba" | null;
  locatorText: string;
  notes: string;
}

export interface ExternalReviewValidationMaterial {
  schemaVersion: typeof EXTERNAL_REVIEW_VALIDATION_SCHEMA_VERSION;
  sourceId: string;
  layout: PhysicalHoldoutLayout;
  tuningStatus: "not_used_for_tuning";
  publisher: {
    publisherId: string;
    independenceGroupId: string;
    name: string;
    editorialControl: "independent";
  };
  caseIdentity: {
    skuId: string;
    modelId: string;
    revision: string;
    region: string;
  };
  source: {
    url: string;
    title: string;
    publishedAt: string;
    retrievedAt: string;
    mediaType: "text/html";
    archiveFile: string;
    archiveSha256: string;
  };
  method: {
    summary: string;
    instrument: string | null;
    calibrationRef: string | null;
    referenceDistanceM: number | null;
    ambientC: number | null;
  };
  observations: ExternalReviewObservation[];
  conclusion: {
    productReadiness: "unknown";
    eligibleForProductPass: false;
    missingDomains: ExternalReviewObservationDomain[];
  };
}

export interface ExternalReviewValidationDataset extends ExternalReviewValidationMaterial {
  contentHash: string;
}

export interface ExternalReviewValidationReport {
  schemaVersion: "external-review-validation-report-v1";
  status: "pass" | "blocked";
  layouts: PhysicalHoldoutLayout[];
  datasetHashes: string[];
  sourceIds: string[];
  unknownDomainsByLayout: Record<PhysicalHoldoutLayout, ExternalReviewObservationDomain[]>;
  errors: string[];
}

const HASH = /^[a-f0-9]{64}$/u;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,199}$/u;
const ARCHIVE = /^archives\/sha256-[a-f0-9]{64}\.html$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function token(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function finiteOrNull(value: unknown, minimum = Number.NEGATIVE_INFINITY): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= minimum);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum;
}

function validateObservation(value: unknown): string[] {
  if (!record(value) || !exact(value, ["domain", "status", "value", "unit", "locatorText", "notes"])) {
    return ["external review observation fields are invalid"];
  }
  const errors: string[] = [];
  if (!EXTERNAL_REVIEW_OBSERVATION_DOMAINS.includes(value.domain as ExternalReviewObservationDomain)) {
    errors.push("external review observation domain is invalid");
  }
  if (!["measured", "reported_without_numeric_value", "not_reported"].includes(String(value.status))) {
    errors.push("external review observation status is invalid");
  }
  if (!finiteOrNull(value.value, 0) || !["mm", "c", "dba", null].includes(value.unit as never)) {
    errors.push("external review observation value is invalid");
  }
  const expectedUnit = value.domain === "clearance" || value.domain === "cable_length"
    ? "mm" : value.domain === "temperature" ? "c" : value.domain === "acoustic" ? "dba" : null;
  if (value.status === "measured") {
    if (typeof value.value !== "number" || value.unit !== expectedUnit || !boundedText(value.locatorText, 240)) {
      errors.push("measured external review observation lacks a bounded numeric locator");
    }
  } else if (value.value !== null || value.unit !== null) {
    errors.push("non-numeric external review observation must remain unknown");
  }
  if (value.status === "not_reported" && value.locatorText !== "not reported") {
    errors.push("missing external review observation must use the explicit locator");
  }
  if (!boundedText(value.notes, 500)) errors.push("external review observation notes are invalid");
  return errors;
}

export async function createExternalReviewValidationDataset(
  material: ExternalReviewValidationMaterial,
): Promise<ExternalReviewValidationDataset> {
  const contentHash = await sha256Hex(
    `buildsim\0${EXTERNAL_REVIEW_VALIDATION_SCHEMA_VERSION}\0${canonicalize(material)}`,
  );
  return { ...structuredClone(material), contentHash };
}

export async function validateExternalReviewValidationDataset(value: unknown): Promise<string[]> {
  if (!record(value) || !exact(value, [
    "schemaVersion", "sourceId", "layout", "tuningStatus", "publisher", "caseIdentity", "source",
    "method", "observations", "conclusion", "contentHash",
  ])) return ["external review validation dataset fields are invalid"];
  const errors: string[] = [];
  if (value.schemaVersion !== EXTERNAL_REVIEW_VALIDATION_SCHEMA_VERSION) errors.push("external review schemaVersion is invalid");
  if (!token(value.sourceId)) errors.push("external review source ID is invalid");
  if (!PHYSICAL_HOLDOUT_LAYOUTS.includes(value.layout as PhysicalHoldoutLayout)) errors.push("external review layout is invalid");
  if (value.tuningStatus !== "not_used_for_tuning") errors.push("external review was used for tuning");
  if (!record(value.publisher) || !exact(value.publisher, ["publisherId", "independenceGroupId", "name", "editorialControl"])
    || !token(value.publisher.publisherId) || !token(value.publisher.independenceGroupId)
    || !boundedText(value.publisher.name, 120) || value.publisher.editorialControl !== "independent") {
    errors.push("external review publisher authority is invalid");
  }
  if (!record(value.caseIdentity) || !exact(value.caseIdentity, ["skuId", "modelId", "revision", "region"])
    || [value.caseIdentity.skuId, value.caseIdentity.modelId, value.caseIdentity.revision, value.caseIdentity.region]
      .some((entry) => !token(entry))) errors.push("external review case identity is invalid");
  if (!record(value.source) || !exact(value.source, [
    "url", "title", "publishedAt", "retrievedAt", "mediaType", "archiveFile", "archiveSha256",
  ])) errors.push("external review source fields are invalid");
  else {
    try {
      const url = new URL(String(value.source.url));
      if (url.protocol !== "https:" || url.username || url.password || url.port) errors.push("external review source URL is invalid");
    } catch { errors.push("external review source URL is invalid"); }
    if (!boundedText(value.source.title, 240) || !iso(value.source.publishedAt) || !iso(value.source.retrievedAt)
      || value.source.mediaType !== "text/html" || !ARCHIVE.test(String(value.source.archiveFile))
      || !HASH.test(String(value.source.archiveSha256))
      || value.source.archiveFile !== `archives/sha256-${value.source.archiveSha256}.html`) {
      errors.push("external review source archive authority is invalid");
    }
  }
  if (!record(value.method) || !exact(value.method, ["summary", "instrument", "calibrationRef", "referenceDistanceM", "ambientC"])
    || !boundedText(value.method.summary, 600)
    || !(value.method.instrument === null || boundedText(value.method.instrument, 160))
    || !(value.method.calibrationRef === null || boundedText(value.method.calibrationRef, 240))
    || !finiteOrNull(value.method.referenceDistanceM, 0) || !finiteOrNull(value.method.ambientC)) {
    errors.push("external review method is invalid");
  }
  if (!Array.isArray(value.observations) || value.observations.length !== EXTERNAL_REVIEW_OBSERVATION_DOMAINS.length) {
    errors.push("external review must state every observation domain");
  } else {
    errors.push(...value.observations.flatMap(validateObservation));
    const domains = value.observations.map((entry) => record(entry) ? entry.domain : null);
    if ([...new Set(domains)].sort().join("\0") !== [...EXTERNAL_REVIEW_OBSERVATION_DOMAINS].sort().join("\0")) {
      errors.push("external review observation domains are incomplete or duplicated");
    }
  }
  if (!record(value.conclusion) || !exact(value.conclusion, ["productReadiness", "eligibleForProductPass", "missingDomains"])
    || value.conclusion.productReadiness !== "unknown" || value.conclusion.eligibleForProductPass !== false
    || !Array.isArray(value.conclusion.missingDomains)
    || value.conclusion.missingDomains.some((domain) => !EXTERNAL_REVIEW_OBSERVATION_DOMAINS.includes(domain as ExternalReviewObservationDomain))) {
    errors.push("external review conclusion must remain product-level unknown");
  } else if (Array.isArray(value.observations)) {
    const expectedMissing = value.observations
      .filter((entry) => record(entry) && entry.status !== "measured")
      .map((entry) => entry.domain).sort();
    if (canonicalize(expectedMissing) !== canonicalize([...value.conclusion.missingDomains].sort())) {
      errors.push("external review missing-domain projection is invalid");
    }
  }
  if (!HASH.test(String(value.contentHash))) errors.push("external review contentHash is invalid");
  else {
    const { contentHash: _contentHash, ...material } = value;
    const expected = await createExternalReviewValidationDataset(material as unknown as ExternalReviewValidationMaterial);
    if (expected.contentHash !== value.contentHash) errors.push("external review contentHash mismatch");
  }
  return [...new Set(errors)].sort();
}

export async function validateExternalReviewValidationSet(
  values: readonly unknown[],
): Promise<ExternalReviewValidationReport> {
  const errors: string[] = [];
  const valid: ExternalReviewValidationDataset[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const entryErrors = await validateExternalReviewValidationDataset(values[index]);
    if (entryErrors.length) errors.push(...entryErrors.map((error) => `dataset ${index}: ${error}`));
    else valid.push(structuredClone(values[index]) as ExternalReviewValidationDataset);
  }
  const sourceIds = valid.map(({ sourceId }) => sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) errors.push("external review source IDs must be unique");
  const datasetHashes = valid.map(({ contentHash }) => contentHash);
  if (new Set(datasetHashes).size !== datasetHashes.length) errors.push("external review dataset hashes must be unique");
  const layouts = [...new Set(valid.map(({ layout }) => layout))].sort() as PhysicalHoldoutLayout[];
  const unknownDomainsByLayout = Object.fromEntries(PHYSICAL_HOLDOUT_LAYOUTS.map((layout) => {
    const entries = valid.filter((entry) => entry.layout === layout);
    const groups = new Set(entries.map(({ publisher }) => publisher.independenceGroupId));
    if (groups.size < 2) errors.push(`external ${layout} validation requires two independent publishers`);
    if (entries.length > 0 && !entries.some(({ observations }) => observations.some(({ status }) => status === "measured"))) {
      errors.push(`external ${layout} validation has no measured observation`);
    }
    const unknown = EXTERNAL_REVIEW_OBSERVATION_DOMAINS.filter((domain) => !entries.some(({ observations }) => (
      observations.some((observation) => observation.domain === domain && observation.status === "measured")
    )));
    return [layout, unknown];
  })) as Record<PhysicalHoldoutLayout, ExternalReviewObservationDomain[]>;
  for (const layout of PHYSICAL_HOLDOUT_LAYOUTS) if (!layouts.includes(layout)) errors.push(`missing external ${layout} validation`);
  return {
    schemaVersion: "external-review-validation-report-v1",
    status: errors.length === 0 ? "pass" : "blocked",
    layouts,
    datasetHashes: datasetHashes.sort(),
    sourceIds: sourceIds.sort(),
    unknownDomainsByLayout,
    errors: [...new Set(errors)].sort(),
  };
}
