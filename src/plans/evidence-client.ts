import type {
  EvidenceCapture,
  EvidenceDocument,
  EvidenceDocumentKind,
  EvidenceDocumentId,
} from "../evidence/contracts";

export interface EvidenceDiscoveryCandidate {
  url: string;
  title: string;
  mediaTypeHint: string;
  kindHint: EvidenceDocumentKind;
  score: number;
  discoveredFrom: string;
}

export interface EvidenceDiscoveryResult {
  startUrl: string;
  finalUrl: string;
  officialBrand: string | null;
  candidates: EvidenceDiscoveryCandidate[];
  pagesInspected: number;
  warnings: string[];
}

export interface DiscoverEvidenceInput {
  skuId: string;
  url?: string;
  query?: string;
  limit?: number;
  followPageLimit?: number;
}

export interface AcquireEvidenceInput {
  url: string;
  skuId: string;
  kind: EvidenceDocumentKind;
  title: string;
}

export interface EvidenceAcquisitionResult {
  document: EvidenceDocument;
  capture: EvidenceCapture;
  reusedDocument: boolean;
  reusedCapture: boolean;
  cacheStatus: "fresh" | "revalidated" | "updated" | "miss";
  notModified?: boolean;
}

export interface EvidenceDocumentResult {
  document: EvidenceDocument;
  captures: EvidenceCapture[];
}

export interface EvidenceServiceApi {
  discover(input: DiscoverEvidenceInput): Promise<EvidenceDiscoveryResult>;
  acquire(input: AcquireEvidenceInput): Promise<EvidenceAcquisitionResult>;
  getDocument(documentId: EvidenceDocumentId): Promise<EvidenceDocumentResult>;
  contentUrl(documentId: EvidenceDocumentId): string;
}

export class EvidenceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly manualAction?: string,
  ) {
    super(message);
    this.name = "EvidenceApiError";
  }
}

async function payload<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({ error: "invalid_response", message: "Evidence service returned invalid JSON" }));
  if (!response.ok) {
    const error = body as { error?: string; message?: string; manualAction?: string };
    throw new EvidenceApiError(
      response.status,
      error.error ?? "request_failed",
      error.message ?? `HTTP ${response.status}`,
      error.manualAction,
    );
  }
  return body as T;
}

export class EvidenceApiClient implements EvidenceServiceApi {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "/api/evidence",
  ) {}

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl.call(globalThis, `${this.base}${path}`, {
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      ...init,
    });
  }

  async discover(input: DiscoverEvidenceInput): Promise<EvidenceDiscoveryResult> {
    return payload(await this.request("/discover", { method: "POST", body: JSON.stringify(input) }));
  }

  async acquire(input: AcquireEvidenceInput): Promise<EvidenceAcquisitionResult> {
    return payload(await this.request("/acquisitions", { method: "POST", body: JSON.stringify(input) }));
  }

  async getDocument(documentId: EvidenceDocumentId): Promise<EvidenceDocumentResult> {
    return payload(await this.request(`/documents/${encodeURIComponent(documentId)}`));
  }

  contentUrl(documentId: EvidenceDocumentId): string {
    return `${this.base}/documents/${encodeURIComponent(documentId)}/content`;
  }
}
