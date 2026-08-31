import type { EvidenceLevel } from "../core/evidence";
import type { SkuCategory } from "../sku/types";
import type { PriceQuote } from "../price/types";

export interface NormalizedModelQuery {
  raw: string;
  brand?: string;
  model?: string;
  mpn?: string;
  category?: SkuCategory;
  capacity?: string;
  interface?: string;
  tokens: string[];
  locale: string;
}

export type NormalizedModelQueryOverrides = Partial<Pick<NormalizedModelQuery, "brand" | "model" | "mpn" | "category" | "locale">>;

export type CandidateSourceKind = "official" | "marketplace" | "search";

export interface FieldProvenance {
  provenanceId: string;
  field: string;
  value: unknown;
  evidence: EvidenceLevel;
  sourceUrl: string;
  sourceKind: "official-page" | "official-pdf" | "official-ocr-pdf" | "official-rendered-page" | "marketplace" | "manual";
  retrievedAt: string;
  extractor: string;
  locator?: string;
  snippet?: string;
  confidence?: number;
  note?: string;
  /** Provenance edge for a conservative derived field such as GPU slots from official thickness. */
  derivedFromProvenanceId?: string;
}

export interface CandidateExtraction {
  status: "not-run" | "ok" | "partial" | "failed";
  fieldsFound: number;
  fieldsMissing: number;
  adapter?: string;
  error?: string;
  contentHash?: string;
  supportingDocuments?: Array<{ requestedUrl: string; finalUrl: string; httpStatus: number; retrievedAt: string; contentHash: string; redirects: string[]; exactVariant: boolean }>;
}

export interface ModelCandidate {
  candidateId: string;
  skuId?: string;
  query: NormalizedModelQuery;
  brand?: string;
  model?: string;
  mpn?: string;
  category?: SkuCategory;
  title: string;
  url: string;
  canonicalUrl?: string;
  source: {
    kind: CandidateSourceKind;
    domain: string;
    platform?: string;
    retrievedAt: string;
    httpStatus?: number;
    finalUrl?: string;
    fetchMode?: "playwright" | "cloakbrowser";
    initialFetch?: { requestedUrl: string; finalUrl: string; httpStatus: number; retrievedAt: string; contentHash: string; redirects: string[] };
    supportingDocuments?: Array<{ requestedUrl: string; finalUrl: string; httpStatus: number; retrievedAt: string; contentHash: string; redirects: string[]; exactVariant: boolean }>;
    etag?: string;
    lastModified?: string;
  };
  official?: {
    trustStatus: "trusted" | "proposed" | "untrusted";
    brand?: string;
    pageKind: "product" | "spec" | "datasheet" | "support" | "series" | "search" | "forum" | "article" | "blocked" | "unknown";
    reasons: string[];
  };
  identity?: {
    verdict: "exact" | "same-family" | "conflict" | "insufficient-evidence";
    score: number;
    criticalMatches: Array<{ field: string; input: unknown; candidate: unknown; evidenceId?: string }>;
    criticalConflicts: Array<{ field: string; input: unknown; candidate: unknown; evidenceId?: string }>;
    unknowns: string[];
    reasons: string[];
    agentReviewRequired: boolean;
  };
  match: {
    score: number;
    kind: "exact-mpn" | "brand-model" | "spec-match" | "weak";
    reasons: string[];
  };
  extraction: CandidateExtraction;
  accessBarrier?: {
    kind: "captcha" | "login-wall" | "paywall" | "rate-limit" | "access-denied";
    status: number;
    signals: string[];
    manualAction: string;
  };
  fields?: FieldProvenance[];
  conflicts?: { field: string; values: unknown[]; reason: string }[];
  priceCandidates?: PriceQuote[];
  /** Hash of the immutable inspection payload used when requesting enrichment. */
  expectedHash?: string;
}

export interface OfficialFetchResult {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl?: string;
  status: number;
  contentType: string;
  retrievedAt: string;
  body: string;
  contentHash: string;
  etag?: string;
  lastModified?: string;
  redirects: string[];
  pdfExtraction?: {
    mode: "text" | "ocr";
    ocrAttempted: boolean;
    pagesProcessed?: number;
    engine?: string;
    confidence?: number | null;
    ocrError?: string;
  };
}

export interface ExtractedOfficialData {
  title?: string;
  fields: FieldProvenance[];
  conflicts: { field: string; values: unknown[]; reason: string }[];
  warnings: string[];
  adapter: string;
  accessBarrier?: ModelCandidate["accessBarrier"];
}

export interface SkuDraft {
  schemaVersion: "1.0.0";
  draftId: string;
  operation: "create" | "update";
  baseSkuId?: string;
  baseSkuHash?: string;
  baseCatalogVersion?: string;
  candidateId: string;
  /** Immutable candidate snapshot used to revalidate a confirmation after a job reload. */
  candidateSnapshot: ModelCandidate;
  candidateInputHash: string;
  proposed: Record<string, unknown>;
  fields: FieldProvenance[];
  conflicts: { field: string; existing?: unknown; proposed?: unknown; reason: string }[];
  missing: string[];
  changedFields: string[];
  /** Immutable review input hash required by confirm/reject. */
  inputHash: string;
  expectedHash: string;
  registryVersion?: string;
  extractorVersion?: string;
  contentHash?: string;
  status: "preview" | "draft" | "confirming" | "confirmed" | "rejected";
  createdAt: string;
  updatedAt: string;
  confirmation?: {
    status: "confirmed";
    draftId: string;
    skuId: string;
    sku: Record<string, unknown>;
    catalogChanged: boolean;
    created: boolean;
    inputHash: string;
    expectedHash: string;
  };
  /** Durable two-phase confirmation journal; present only while recovery is pending. */
  confirmationIntent?: Record<string, unknown>;
}

export interface GovernedDraftResult extends SkuDraft {
  writeEnabled: boolean;
  changedFields: string[];
  reasons: string[];
}
