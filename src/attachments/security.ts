import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const ATTACHMENT_INSPECTION_SCHEMA_VERSION = "attachment-inspection-v1" as const;

export interface AttachmentInspectionLimits {
  maxBytes: number;
  maxWidthPixels: number;
  maxHeightPixels: number;
  maxPixels: number;
  maxPages: number;
  maxDecodedBytes: number;
  maxDecompressionRatio: number;
  maxExtractedTextBytes: number;
  processingTimeoutMs: number;
}

export const DEFAULT_ATTACHMENT_INSPECTION_LIMITS: Readonly<AttachmentInspectionLimits> = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxWidthPixels: 16_384,
  maxHeightPixels: 16_384,
  maxPixels: 40_000_000,
  maxPages: 64,
  maxDecodedBytes: 160 * 1024 * 1024,
  maxDecompressionRatio: 200,
  maxExtractedTextBytes: 64 * 1024,
  processingTimeoutMs: 12_000,
});

export type InspectedAttachmentMediaType = "image/png" | "image/jpeg" | "application/pdf";

export class AttachmentSecurityError extends Error {
  constructor(
    readonly code:
      | "attachment_empty"
      | "attachment_too_large"
      | "mime_not_allowed"
      | "mime_magic_mismatch"
      | "malformed_attachment"
      | "pixel_limit_exceeded"
      | "page_limit_exceeded"
      | "decompression_limit_exceeded"
      | "processing_timeout"
      | "decoder_required"
      | "decoder_mismatch"
      | "extracted_text_too_large",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentSecurityError";
  }
}

export interface BoundedImageDecoder {
  decode(input: {
    bytes: Buffer;
    mediaType: "image/jpeg";
    signal: AbortSignal;
    limits: Readonly<AttachmentInspectionLimits>;
  }): Promise<{ width: number; height: number; decodedBytes: number }>;
}

export interface BoundedPdfInspector {
  inspect(input: {
    bytes: Buffer;
    mediaType: "application/pdf";
    /** Avoids extracting potentially large text when the caller only archives. */
    extractText?: boolean;
    signal: AbortSignal;
    limits: Readonly<AttachmentInspectionLimits>;
  }): Promise<{ pageCount: number; decodedBytes: number; text?: string }>;
}

export interface BoundedOcrInspector {
  extract(input: {
    bytes: Buffer;
    mediaType: InspectedAttachmentMediaType;
    signal: AbortSignal;
    limits: Readonly<AttachmentInspectionLimits>;
  }): Promise<{ text: string; confidence?: number }>;
}

export interface AttachmentInspectionAdapters {
  imageDecoder?: BoundedImageDecoder;
  pdfInspector?: BoundedPdfInspector;
  ocrInspector?: BoundedOcrInspector;
}

export interface UntrustedAttachmentExtraction {
  text: string;
  confidence: number | null;
  contentTrust: "untrusted_user_attachment";
  promptInjectionSignals: string[];
  mayCreate: "plan_scoped_user_observation_proposal_only";
  mayPromoteOfficialFact: false;
}

export interface AttachmentInspectionResult {
  schemaVersion: typeof ATTACHMENT_INSPECTION_SCHEMA_VERSION;
  accepted: true;
  mediaType: InspectedAttachmentMediaType;
  originalContentHash: string;
  originalByteLength: number;
  sanitizedContentHash: string;
  sanitizedByteLength: number;
  strippedMetadata: string[];
  widthPixels: number | null;
  heightPixels: number | null;
  pageCount: number;
  decodedBytes: number;
  decompressionRatio: number;
  actualDecodeValidated: boolean;
  processingMs: number;
  contentTrust: "untrusted_user_attachment";
  scope: "plan_only";
  mayCreate: "plan_scoped_user_observation_proposal_only";
  mayPromoteOfficialFact: false;
  extraction?: UntrustedAttachmentExtraction;
  /** Internal processing derivative. Never use this hash/body as the raw-byte authority. */
  sanitizedBytes: Buffer;
}

export type PublicAttachmentInspection = Omit<AttachmentInspectionResult, "sanitizedBytes">;

interface ParsedImage {
  width: number;
  height: number;
  decodedBytes: number;
  compressedBytes: number;
  sanitizedBytes: Buffer;
  strippedMetadata: string[];
  actualDecodeValidated: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const PNG_METADATA = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const PROMPT_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ["instruction_override", /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)/iu],
  ["system_prompt_impersonation", /(?:system|developer|assistant)\s*(?:message|prompt|instruction)\s*:/iu],
  ["tool_or_secret_request", /(?:call|invoke|run)\s+(?:the\s+)?(?:tool|function)|(?:reveal|print|exfiltrate)\s+(?:the\s+)?(?:secret|token|password|prompt)/iu],
  ["active_payload", /<\s*(?:script|iframe|object)|javascript\s*:|on(?:load|error|click)\s*=/iu],
];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function limitsWith(overrides: Partial<AttachmentInspectionLimits> | undefined): Readonly<AttachmentInspectionLimits> {
  const limits = { ...DEFAULT_ATTACHMENT_INSPECTION_LIMITS, ...(overrides ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new TypeError(`attachment inspection limit ${name} must be a positive integer`);
    }
  }
  return Object.freeze(limits);
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new AttachmentSecurityError("processing_timeout", "attachment inspection exceeded its processing deadline");
}

function assertDimensions(width: number, height: number, limits: Readonly<AttachmentInspectionLimits>): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new AttachmentSecurityError("malformed_attachment", "attachment dimensions are invalid");
  }
  if (width > limits.maxWidthPixels || height > limits.maxHeightPixels || width * height > limits.maxPixels) {
    throw new AttachmentSecurityError("pixel_limit_exceeded", "attachment exceeds the bounded pixel dimensions");
  }
}

function assertDecoded(decodedBytes: number, compressedBytes: number, limits: Readonly<AttachmentInspectionLimits>): number {
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0 || decodedBytes > limits.maxDecodedBytes) {
    throw new AttachmentSecurityError("decompression_limit_exceeded", "attachment decoded size exceeds the bounded output limit");
  }
  const ratio = decodedBytes / Math.max(1, compressedBytes);
  if (!Number.isFinite(ratio) || ratio > limits.maxDecompressionRatio) {
    throw new AttachmentSecurityError("decompression_limit_exceeded", "attachment decompression ratio exceeds the bounded limit");
  }
  return ratio;
}

let crcTable: Uint32Array | undefined;
function pngCrc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngExpectedRows(width: number, height: number, bitsPerPixel: number, interlace: number): Array<{ rowBytes: number; rows: number }> {
  if (interlace === 0) return [{ rowBytes: Math.ceil(width * bitsPerPixel / 8), rows: height }];
  const passes = [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ] as const;
  return passes.flatMap(([startX, startY, stepX, stepY]) => {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    return passWidth === 0 || passHeight === 0 ? [] : [{ rowBytes: Math.ceil(passWidth * bitsPerPixel / 8), rows: passHeight }];
  });
}

function parsePng(bytes: Buffer, limits: Readonly<AttachmentInspectionLimits>, deadline: number): ParsedImage {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AttachmentSecurityError("mime_magic_mismatch", "declared PNG does not have PNG magic bytes");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let interlace = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  const idat: Buffer[] = [];
  const retained: Buffer[] = [PNG_SIGNATURE];
  const stripped = new Set<string>();
  while (offset < bytes.length) {
    checkDeadline(deadline);
    if (offset + 12 > bytes.length) throw new AttachmentSecurityError("malformed_attachment", "PNG chunk header is truncated");
    const start = offset;
    const length = bytes.readUInt32BE(offset);
    if (length > limits.maxBytes || offset + 12 + length > bytes.length) throw new AttachmentSecurityError("malformed_attachment", "PNG chunk length is invalid");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new AttachmentSecurityError("malformed_attachment", "PNG chunk type is invalid");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (pngCrc32(Buffer.concat([typeBytes, data])) !== storedCrc) throw new AttachmentSecurityError("malformed_attachment", `PNG ${type} chunk checksum is invalid`);
    offset += 12 + length;

    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) throw new AttachmentSecurityError("malformed_attachment", "PNG IHDR must be the first chunk");
      sawIhdr = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8]!;
      const colorType = data[9]!;
      const samples = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
      const validDepths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!samples || !validDepths[colorType]?.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) {
        throw new AttachmentSecurityError("malformed_attachment", "PNG IHDR encoding is unsupported or invalid");
      }
      bitsPerPixel = samples * bitDepth;
      interlace = data[12]!;
      assertDimensions(width, height, limits);
    } else if (type === "IHDR") {
      throw new AttachmentSecurityError("malformed_attachment", "PNG contains multiple IHDR chunks");
    }

    if (type === "IDAT") {
      if (endedIdat) throw new AttachmentSecurityError("malformed_attachment", "PNG IDAT chunks are not contiguous");
      sawIdat = true;
      idat.push(Buffer.from(data));
    } else if (sawIdat && type !== "IEND") {
      endedIdat = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawIdat || offset !== bytes.length) throw new AttachmentSecurityError("malformed_attachment", "PNG IEND or trailing data is invalid");
      sawIend = true;
    }
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) {
      throw new AttachmentSecurityError("malformed_attachment", `PNG contains unsupported critical chunk ${type}`);
    }
    if (PNG_METADATA.has(type)) stripped.add(type);
    else retained.push(Buffer.from(bytes.subarray(start, offset)));
    if (sawIend) break;
  }
  if (!sawIhdr || !sawIdat || !sawIend) throw new AttachmentSecurityError("malformed_attachment", "PNG required chunks are incomplete");
  const rows = pngExpectedRows(width, height, bitsPerPixel, interlace);
  const expectedInflated = rows.reduce((sum, row) => sum + (row.rowBytes + 1) * row.rows, 0);
  assertDecoded(expectedInflated, idat.reduce((sum, chunk) => sum + chunk.length, 0), limits);
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: Math.min(limits.maxDecodedBytes, expectedInflated + 1) });
  } catch {
    throw new AttachmentSecurityError("malformed_attachment", "PNG pixel stream cannot be decoded within the bounded output limit");
  }
  if (inflated.length !== expectedInflated) throw new AttachmentSecurityError("malformed_attachment", "PNG decoded scanline size does not match IHDR");
  let cursor = 0;
  for (const row of rows) {
    for (let line = 0; line < row.rows; line += 1) {
      if (inflated[cursor]! > 4) throw new AttachmentSecurityError("malformed_attachment", "PNG scanline filter is invalid");
      cursor += row.rowBytes + 1;
    }
  }
  checkDeadline(deadline);
  return {
    width,
    height,
    decodedBytes: inflated.length,
    compressedBytes: idat.reduce((sum, chunk) => sum + chunk.length, 0),
    sanitizedBytes: Buffer.concat(retained),
    strippedMetadata: [...stripped].sort(),
    actualDecodeValidated: true,
  };
}

function parseJpegStructure(bytes: Buffer, limits: Readonly<AttachmentInspectionLimits>, deadline: number): Omit<ParsedImage, "decodedBytes" | "actualDecodeValidated"> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new AttachmentSecurityError("mime_magic_mismatch", "declared JPEG does not have JPEG magic bytes");
  }
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new AttachmentSecurityError("malformed_attachment", "JPEG end marker is missing or trailing bytes are present");
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let scanOffset = -1;
  const retained: Buffer[] = [bytes.subarray(0, 2)];
  const stripped = new Set<string>();
  while (offset < bytes.length - 2) {
    checkDeadline(deadline);
    if (bytes[offset] !== 0xff) throw new AttachmentSecurityError("malformed_attachment", "JPEG marker prefix is invalid");
    const start = offset;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) throw new AttachmentSecurityError("malformed_attachment", "JPEG marker ordering is invalid");
    if (marker >= 0xd0 && marker <= 0xd7) {
      retained.push(bytes.subarray(start, offset));
      continue;
    }
    if (offset + 2 > bytes.length) throw new AttachmentSecurityError("malformed_attachment", "JPEG segment length is truncated");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new AttachmentSecurityError("malformed_attachment", "JPEG segment length is invalid");
    const end = offset + segmentLength;
    if (JPEG_SOF.has(marker)) {
      if (segmentLength < 8) throw new AttachmentSecurityError("malformed_attachment", "JPEG frame header is truncated");
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      assertDimensions(width, height, limits);
    }
    if (marker === 0xda) {
      if (!width || !height) throw new AttachmentSecurityError("malformed_attachment", "JPEG scan precedes a supported frame header");
      scanOffset = start;
      break;
    }
    const isPrivateMetadata = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (isPrivateMetadata) stripped.add(marker === 0xe1 ? "APP1/EXIF" : marker === 0xed ? "APP13" : "COM");
    else retained.push(bytes.subarray(start, end));
    offset = end;
  }
  if (scanOffset < 0 || !width || !height) throw new AttachmentSecurityError("malformed_attachment", "JPEG frame or scan is incomplete");
  retained.push(bytes.subarray(scanOffset));
  return {
    width,
    height,
    compressedBytes: bytes.length,
    sanitizedBytes: Buffer.concat(retained),
    strippedMetadata: [...stripped].sort(),
  };
}

function mediaTypeFromMagic(bytes: Buffer): InspectedAttachmentMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

async function runAdapter<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (parentSignal?.aborted) throw new AttachmentSecurityError("processing_timeout", "attachment inspection was cancelled");
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AttachmentSecurityError("processing_timeout", "attachment decoder exceeded its processing deadline"));
        }, timeoutMs);
      }),
      new Promise<T>((_resolve, reject) => controller.signal.addEventListener("abort", () => {
        if (parentSignal?.aborted) reject(new AttachmentSecurityError("processing_timeout", "attachment inspection was cancelled"));
      }, { once: true })),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

function promptInjectionSignals(text: string): string[] {
  return PROMPT_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function publicExtraction(text: string, confidence: number | undefined, limits: Readonly<AttachmentInspectionLimits>): UntrustedAttachmentExtraction {
  if (Buffer.byteLength(text, "utf8") > limits.maxExtractedTextBytes) {
    throw new AttachmentSecurityError("extracted_text_too_large", "attachment extraction exceeded its bounded text output");
  }
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new AttachmentSecurityError("decoder_mismatch", "attachment extraction confidence is invalid");
  }
  return {
    text,
    confidence: confidence ?? null,
    contentTrust: "untrusted_user_attachment",
    promptInjectionSignals: promptInjectionSignals(text),
    mayCreate: "plan_scoped_user_observation_proposal_only",
    mayPromoteOfficialFact: false,
  };
}

export function toPublicAttachmentInspection(result: AttachmentInspectionResult): PublicAttachmentInspection {
  const { sanitizedBytes: _privateDerivative, ...safe } = result;
  return safe;
}

export async function inspectAttachmentBytes(input: {
  bytes: Buffer | Uint8Array | ArrayBuffer;
  declaredMediaType: string;
  extractText?: boolean;
  signal?: AbortSignal;
  limits?: Partial<AttachmentInspectionLimits>;
  adapters?: AttachmentInspectionAdapters;
}): Promise<AttachmentInspectionResult> {
  const started = Date.now();
  const limits = limitsWith(input.limits);
  const bytes = Buffer.isBuffer(input.bytes)
    ? Buffer.from(input.bytes)
    : input.bytes instanceof ArrayBuffer
      ? Buffer.from(input.bytes)
      : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  if (bytes.length === 0) throw new AttachmentSecurityError("attachment_empty", "attachment body is empty");
  if (bytes.length > limits.maxBytes) throw new AttachmentSecurityError("attachment_too_large", "attachment body exceeds the bounded byte limit");
  if (!["image/png", "image/jpeg", "application/pdf"].includes(input.declaredMediaType)) {
    throw new AttachmentSecurityError("mime_not_allowed", "attachment MIME type is not allowlisted");
  }
  const detected = mediaTypeFromMagic(bytes);
  if (!detected || detected !== input.declaredMediaType) {
    throw new AttachmentSecurityError("mime_magic_mismatch", "declared attachment MIME does not match its magic bytes");
  }
  const deadline = started + limits.processingTimeoutMs;
  let parsed: ParsedImage;
  let pageCount = 1;
  let pdfText: string | undefined;
  if (detected === "image/png") {
    parsed = parsePng(bytes, limits, deadline);
  } else if (detected === "image/jpeg") {
    const structure = parseJpegStructure(bytes, limits, deadline);
    const decoder = input.adapters?.imageDecoder;
    if (!decoder) throw new AttachmentSecurityError("decoder_required", "JPEG archival requires a bounded real image decoder");
    const decoded = await runAdapter(
      (signal) => decoder.decode({ bytes: Buffer.from(bytes), mediaType: detected, signal, limits }),
      input.signal,
      Math.max(1, deadline - Date.now()),
    );
    if (decoded.width !== structure.width || decoded.height !== structure.height) {
      throw new AttachmentSecurityError("decoder_mismatch", "JPEG decoder dimensions do not match the frame header");
    }
    assertDimensions(decoded.width, decoded.height, limits);
    assertDecoded(decoded.decodedBytes, structure.compressedBytes, limits);
    parsed = { ...structure, decodedBytes: decoded.decodedBytes, actualDecodeValidated: true };
  } else {
    const pdfInspector = input.adapters?.pdfInspector;
    if (!pdfInspector) throw new AttachmentSecurityError("decoder_required", "PDF archival requires a bounded real PDF inspector");
    const inspected = await runAdapter(
      (signal) => pdfInspector.inspect({
        bytes: Buffer.from(bytes),
        mediaType: detected,
        extractText: input.extractText === true,
        signal,
        limits,
      }),
      input.signal,
      Math.max(1, deadline - Date.now()),
    );
    if (!Number.isInteger(inspected.pageCount) || inspected.pageCount <= 0 || inspected.pageCount > limits.maxPages) {
      throw new AttachmentSecurityError("page_limit_exceeded", "PDF page count exceeds the bounded limit");
    }
    assertDecoded(inspected.decodedBytes, bytes.length, limits);
    pageCount = inspected.pageCount;
    pdfText = inspected.text;
    parsed = {
      width: 0,
      height: 0,
      decodedBytes: inspected.decodedBytes,
      compressedBytes: bytes.length,
      sanitizedBytes: Buffer.from(bytes),
      strippedMetadata: [],
      actualDecodeValidated: true,
    };
  }
  checkDeadline(deadline);
  const ratio = assertDecoded(parsed.decodedBytes, parsed.compressedBytes, limits);
  let extraction: UntrustedAttachmentExtraction | undefined;
  if (input.extractText) {
    if (pdfText !== undefined) extraction = publicExtraction(pdfText, undefined, limits);
    else {
      const ocr = input.adapters?.ocrInspector;
      if (!ocr) throw new AttachmentSecurityError("decoder_required", "image text extraction requires a bounded OCR inspector");
      const extracted = await runAdapter(
        (signal) => ocr.extract({ bytes: Buffer.from(parsed.sanitizedBytes), mediaType: detected, signal, limits }),
        input.signal,
        Math.max(1, deadline - Date.now()),
      );
      extraction = publicExtraction(extracted.text, extracted.confidence, limits);
    }
  }
  checkDeadline(deadline);
  return {
    schemaVersion: ATTACHMENT_INSPECTION_SCHEMA_VERSION,
    accepted: true,
    mediaType: detected,
    originalContentHash: sha256(bytes),
    originalByteLength: bytes.length,
    sanitizedContentHash: sha256(parsed.sanitizedBytes),
    sanitizedByteLength: parsed.sanitizedBytes.length,
    strippedMetadata: parsed.strippedMetadata,
    widthPixels: detected === "application/pdf" ? null : parsed.width,
    heightPixels: detected === "application/pdf" ? null : parsed.height,
    pageCount,
    decodedBytes: parsed.decodedBytes,
    decompressionRatio: ratio,
    actualDecodeValidated: parsed.actualDecodeValidated,
    processingMs: Date.now() - started,
    contentTrust: "untrusted_user_attachment",
    scope: "plan_only",
    mayCreate: "plan_scoped_user_observation_proposal_only",
    mayPromoteOfficialFact: false,
    ...(extraction ? { extraction } : {}),
    sanitizedBytes: Buffer.from(parsed.sanitizedBytes),
  };
}
