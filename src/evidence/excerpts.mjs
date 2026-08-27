import { Worker } from "node:worker_threads";

const DOCUMENT_ID = /^doc-sha256-[a-f0-9]{64}$/;
const PDF_MEDIA_TYPE = "application/pdf";
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
]);

export const EVIDENCE_EXCERPT_LIMITS = Object.freeze({
  maxSourceBytes: 25_000_000,
  maxExtractedTextBytes: 4_000_000,
  maxPdfPagesWithoutSelection: 256,
  maxQueryCharacters: 160,
  maxLimit: 8,
  defaultLimit: 4,
  maxExcerptBytes: 1_200,
  maxOutputBytes: 12_000,
  pdfTimeoutMs: 15_000,
});

export class EvidenceExcerptError extends Error {
  constructor(code, message, status = 400, manualAction) {
    super(String(message).slice(0, 500));
    this.name = "EvidenceExcerptError";
    this.code = code;
    this.status = status;
    this.manualAction = manualAction;
  }
}

function requestInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceExcerptError("evidence_excerpt_invalid_request", "Excerpt request body must be an object");
  }
  const query = value.query;
  if (
    typeof query !== "string"
    || query !== query.trim()
    || query.length < 2
    || query.length > EVIDENCE_EXCERPT_LIMITS.maxQueryCharacters
    || /[\u0000-\u001f\u007f]/.test(query)
  ) {
    throw new EvidenceExcerptError(
      "evidence_excerpt_query_invalid",
      `query must be trimmed text between 2 and ${EVIDENCE_EXCERPT_LIMITS.maxQueryCharacters} characters`,
    );
  }
  const page = value.page;
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > 4_096)) {
    throw new EvidenceExcerptError("evidence_excerpt_page_invalid", "page must be an integer between 1 and 4096");
  }
  const limit = value.limit ?? EVIDENCE_EXCERPT_LIMITS.defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVIDENCE_EXCERPT_LIMITS.maxLimit) {
    throw new EvidenceExcerptError("evidence_excerpt_limit_invalid", `limit must be an integer between 1 and ${EVIDENCE_EXCERPT_LIMITS.maxLimit}`);
  }
  return { query, ...(page === undefined ? {} : { page }), limit };
}

function normalizedMediaType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLocaleLowerCase();
}

function isTextMediaType(value) {
  return value.startsWith("text/") || TEXT_MEDIA_TYPES.has(value) || value.endsWith("+json") || value.endsWith("+xml");
}

function boundedOption(value, fallback, minimum) {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(fallback, Math.max(minimum, value));
}

function decodedText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EvidenceExcerptError(
      "evidence_text_decode_failed",
      "Archived text is not valid UTF-8",
      422,
      "Re-import the source with a supported UTF-8 text media type.",
    );
  }
}

function selectedTextPages(bytes, requestedPage) {
  const all = decodedText(bytes)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\f")
    .map((text, index) => ({ num: index + 1, text }));
  if (requestedPage !== undefined && requestedPage > all.length) {
    throw new EvidenceExcerptError("evidence_excerpt_page_out_of_range", `Requested page ${requestedPage} exceeds the document's ${all.length} text page(s)`, 416);
  }
  return { total: all.length, pages: requestedPage === undefined ? all : [all[requestedPage - 1]] };
}

function pdfWorkerError(value) {
  const code = value?.code;
  if (code === "page_out_of_range") {
    return new EvidenceExcerptError("evidence_excerpt_page_out_of_range", value.message, 416);
  }
  if (code === "page_required") {
    return new EvidenceExcerptError(
      "evidence_excerpt_page_required",
      value.message,
      422,
      "Use document metadata or a known locator to request one explicit page.",
    );
  }
  if (code === "text_too_large") {
    return new EvidenceExcerptError(
      "evidence_excerpt_text_too_large",
      value.message,
      413,
      "Retry with an explicit page number.",
    );
  }
  if (code === "text_unavailable") {
    return new EvidenceExcerptError(
      "evidence_pdf_text_unavailable",
      value.message,
      422,
      "Use a reviewed OCR workflow or inspect the archived PDF visually; the Agent will not infer text from empty pages.",
    );
  }
  return new EvidenceExcerptError(
    "evidence_pdf_parse_failed",
    `Archived PDF text extraction failed: ${String(value?.message ?? "unknown parser failure").slice(0, 240)}`,
    422,
    "Verify that the archived bytes are a readable, unencrypted PDF; no network fallback was attempted.",
  );
}

function selectedPdfPages(bytes, requestedPage, options) {
  return new Promise((resolve, reject) => {
    const transferable = Uint8Array.from(bytes);
    const worker = new Worker(options.pdfWorkerUrl ?? new URL("./pdf-text-worker.mjs", import.meta.url), {
      type: "module",
      workerData: {
        bytes: transferable,
        ...(requestedPage === undefined ? {} : { requestedPage }),
        maxPdfPagesWithoutSelection: options.maxPdfPagesWithoutSelection,
        maxExtractedTextBytes: options.maxExtractedTextBytes,
      },
      transferList: [transferable.buffer],
    });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeAllListeners();
    };
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const timer = setTimeout(() => finish(() => {
      // PDFParse does not expose its loading task, so process isolation is the
      // cancellation boundary: terminating this worker stops parser CPU/I/O.
      void worker.terminate();
      reject(new EvidenceExcerptError(
        "evidence_pdf_parse_timeout",
        "Archived PDF text extraction timed out and its parser worker was terminated",
        504,
        "Retry with an explicit page number, or inspect the archived document outside the Agent context.",
      ));
    }), options.pdfTimeoutMs);
    worker.once("message", (message) => finish(() => {
      void worker.terminate();
      if (!message?.ok) reject(pdfWorkerError(message?.error));
      else resolve({ total: message.total, pages: message.pages });
    }));
    worker.once("error", (error) => finish(() => {
      void worker.terminate();
      reject(pdfWorkerError({ message: error.message }));
    }));
    worker.once("exit", (code) => {
      if (!settled) finish(() => reject(pdfWorkerError({ message: `PDF parser worker exited before returning data (code ${code})` })));
    });
  });
}

function compactText(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function queryTerms(query) {
  return [...new Set(query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}._+-]+/u)
    .filter((term) => /[\p{L}\p{N}]/u.test(term)))];
}

function positions(text, needle, maximum) {
  const found = [];
  let offset = 0;
  while (found.length < maximum) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return { found, overflow: false };
    found.push(index);
    offset = index + Math.max(1, needle.length);
  }
  return { found, overflow: text.indexOf(needle, offset) >= 0 };
}

function candidate(page, anchor, matchType, terms) {
  const radius = 320;
  const start = Math.max(0, anchor - radius);
  const end = Math.min(page.text.length, anchor + radius);
  const lowered = page.lowered.slice(start, end);
  return {
    page: page.num,
    source: page.text,
    start,
    end,
    matchType,
    matchedTerms: terms.filter((term) => lowered.includes(term)),
  };
}

function collectCandidates(pages, query) {
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
  const terms = queryTerms(query);
  if (!terms.length) throw new EvidenceExcerptError("evidence_excerpt_query_invalid", "query must contain searchable letters or numbers");
  const searchable = pages.map((page) => {
    const text = compactText(page.text);
    return { num: page.num, text, lowered: text.toLocaleLowerCase() };
  });
  const exact = [];
  let overflow = false;
  for (const page of searchable) {
    const matches = positions(page.lowered, normalizedQuery, 64);
    overflow ||= matches.overflow;
    for (const anchor of matches.found) exact.push(candidate(page, anchor, "exact", terms));
  }
  const gathered = exact.length ? exact : [];
  if (!exact.length) {
    for (const page of searchable) {
      for (const term of terms) {
        const matches = positions(page.lowered, term, 32);
        overflow ||= matches.overflow;
        for (const anchor of matches.found) gathered.push(candidate(page, anchor, "terms", terms));
      }
    }
  }
  gathered.sort((left, right) => (
    right.matchedTerms.length - left.matchedTerms.length
    || left.page - right.page
    || left.start - right.start
  ));
  const deduplicated = [];
  for (const item of gathered) {
    if (deduplicated.some((prior) => prior.page === item.page && prior.start <= item.end && item.start <= prior.end)) continue;
    deduplicated.push(item);
  }
  return { candidates: deduplicated, overflow };
}

function truncateUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value) <= maximumBytes) return { text: value, truncated: false };
  let text = "";
  for (const character of value) {
    if (Buffer.byteLength(`${text}${character}…`) > maximumBytes) break;
    text += character;
  }
  return { text: `${text.trimEnd()}…`, truncated: true };
}

function excerptFromCandidate(value, maximumBytes) {
  const prefix = value.start > 0 ? "…" : "";
  const suffix = value.end < value.source.length ? "…" : "";
  const bounded = truncateUtf8(`${prefix}${value.source.slice(value.start, value.end).trim()}${suffix}`, maximumBytes);
  return {
    page: value.page,
    matchType: value.matchType,
    matchedTerms: value.matchedTerms,
    text: bounded.text,
    truncated: bounded.truncated || Boolean(prefix) || Boolean(suffix),
  };
}

function boundedResult(base, candidates, limit, overflow, maxExcerptBytes, maxOutputBytes) {
  const selected = candidates.slice(0, limit).map((value) => excerptFromCandidate(value, maxExcerptBytes));
  let result = {
    ...base,
    returned: selected.length,
    excerpts: selected,
    truncated: overflow || candidates.length > selected.length || selected.some((entry) => entry.truncated),
  };
  while (result.excerpts.length && Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes) {
    result = { ...result, returned: result.excerpts.length - 1, excerpts: result.excerpts.slice(0, -1), truncated: true };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxOutputBytes) {
    throw new EvidenceExcerptError("evidence_excerpt_output_too_large", "Excerpt metadata exceeded its fixed output budget", 500);
  }
  return result;
}

/**
 * Read and search only immutable, already-archived bytes. This function has no
 * network or write capability and never returns a complete source document.
 */
export async function extractEvidenceExcerpts(repository, documentId, value, options = {}) {
  if (!DOCUMENT_ID.test(String(documentId ?? ""))) {
    throw new EvidenceExcerptError("evidence_excerpt_document_id_invalid", "Evidence document id is invalid");
  }
  if (!repository || typeof repository.getDocumentContent !== "function") {
    throw new EvidenceExcerptError("evidence_excerpt_repository_invalid", "Evidence repository cannot provide immutable document bytes", 500);
  }
  const input = requestInput(value);
  const limits = {
    maxSourceBytes: boundedOption(options.maxSourceBytes, EVIDENCE_EXCERPT_LIMITS.maxSourceBytes, 1),
    maxExtractedTextBytes: boundedOption(options.maxExtractedTextBytes, EVIDENCE_EXCERPT_LIMITS.maxExtractedTextBytes, 1),
    maxPdfPagesWithoutSelection: boundedOption(options.maxPdfPagesWithoutSelection, EVIDENCE_EXCERPT_LIMITS.maxPdfPagesWithoutSelection, 1),
    maxExcerptBytes: boundedOption(options.maxExcerptBytes, EVIDENCE_EXCERPT_LIMITS.maxExcerptBytes, 128),
    maxOutputBytes: boundedOption(options.maxOutputBytes, EVIDENCE_EXCERPT_LIMITS.maxOutputBytes, 1_024),
    pdfTimeoutMs: boundedOption(options.pdfTimeoutMs, EVIDENCE_EXCERPT_LIMITS.pdfTimeoutMs, 100),
    ...(options.pdfWorkerUrl ? { pdfWorkerUrl: options.pdfWorkerUrl } : {}),
  };
  const archived = await repository.getDocumentContent(documentId);
  if (!archived) throw new EvidenceExcerptError("not_found", "Evidence document was not found", 404);
  const { document, bytes } = archived;
  if (document.id !== documentId || document.id !== `doc-sha256-${document.sha256}`) {
    throw new EvidenceExcerptError("integrity_error", "Archived evidence document identity is inconsistent", 500);
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new EvidenceExcerptError("integrity_error", "Archived evidence content is unavailable", 500);
  }
  if (document.byteLength !== bytes.byteLength) {
    throw new EvidenceExcerptError("integrity_error", "Archived evidence byte length is inconsistent", 500);
  }
  if (bytes.byteLength > limits.maxSourceBytes) {
    throw new EvidenceExcerptError(
      "evidence_excerpt_source_too_large",
      `Archived evidence exceeds the ${limits.maxSourceBytes}-byte extraction limit`,
      413,
      "Inspect the immutable source outside Agent context or archive a smaller reviewed source.",
    );
  }
  const mediaType = normalizedMediaType(document.mediaType);
  let selected;
  let extractionMode;
  if (mediaType === PDF_MEDIA_TYPE) {
    selected = await selectedPdfPages(bytes, input.page, limits);
    extractionMode = "pdf-text-layer";
  } else if (isTextMediaType(mediaType)) {
    selected = selectedTextPages(bytes, input.page);
    extractionMode = "utf8-text";
  } else {
    throw new EvidenceExcerptError(
      "evidence_excerpt_media_type_unsupported",
      `Evidence media type ${mediaType || "unknown"} does not support text excerpts`,
      415,
    );
  }
  const extractedBytes = selected.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0);
  if (extractedBytes > limits.maxExtractedTextBytes) {
    throw new EvidenceExcerptError(
      "evidence_excerpt_text_too_large",
      `Extracted text exceeds the ${limits.maxExtractedTextBytes}-byte processing limit`,
      413,
      "Retry with an explicit page number.",
    );
  }
  const matches = collectCandidates(selected.pages, input.query);
  return boundedResult({
    schemaVersion: "1.0.0",
    documentId: document.id,
    contentHash: document.sha256,
    mediaType,
    sourceByteLength: document.byteLength,
    query: input.query,
    ...(input.page === undefined ? {} : { requestedPage: input.page }),
    totalPages: selected.total,
    searchedPageCount: selected.pages.length,
    extractionMode,
    contentTrust: "untrusted-evidence-text",
  }, matches.candidates, input.limit, matches.overflow, limits.maxExcerptBytes, limits.maxOutputBytes);
}
