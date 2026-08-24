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
}

export interface CandidateExtraction {
  status: "not-run" | "ok" | "partial" | "failed";
  fieldsFound: number;
  fieldsMissing: number;
  adapter?: string;
  error?: string;
  contentHash?: string;
}

export interface ModelCandidate {
  candidateId: string;
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
    etag?: string;
    lastModified?: string;
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
  baseSkuId?: string;
  candidateId: string;
  /** Immutable candidate snapshot used to revalidate a confirmation after a job reload. */
  candidateSnapshot?: ModelCandidate;
  proposed: Record<string, unknown>;
  fields: FieldProvenance[];
  conflicts: { field: string; existing?: unknown; proposed?: unknown; reason: string }[];
  status: "draft" | "confirmed" | "rejected";
  createdAt: string;
  updatedAt: string;
}
