import {
  decodeJpegProduction,
  extractOcrProduction,
  inspectPdfProduction,
} from "./production-inspection-runtime.mjs";
import {
  AttachmentSecurityError,
  type AttachmentInspectionAdapters,
  type AttachmentInspectionLimits,
  type BoundedImageDecoder,
  type BoundedOcrInspector,
  type BoundedPdfInspector,
  type InspectedAttachmentMediaType,
} from "./security";

type SecurityCode = ConstructorParameters<typeof AttachmentSecurityError>[0];
const SECURITY_CODES = new Set<SecurityCode>([
  "attachment_empty", "attachment_too_large", "mime_not_allowed", "mime_magic_mismatch", "malformed_attachment",
  "pixel_limit_exceeded", "page_limit_exceeded", "decompression_limit_exceeded", "processing_timeout",
  "decoder_required", "decoder_mismatch", "extracted_text_too_large",
]);

function asSecurityError(error: unknown): never {
  if (error instanceof AttachmentSecurityError) throw error;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  const mapped = typeof code === "string" && SECURITY_CODES.has(code as SecurityCode) ? code as SecurityCode : "malformed_attachment";
  throw new AttachmentSecurityError(mapped, error instanceof Error ? error.message : "production attachment adapter failed");
}

export class ProductionJpegDecoder implements BoundedImageDecoder {
  async decode(input: {
    bytes: Buffer;
    mediaType: "image/jpeg";
    signal: AbortSignal;
    limits: Readonly<AttachmentInspectionLimits>;
  }): Promise<{ width: number; height: number; decodedBytes: number }> {
    return decodeJpegProduction(input).catch(asSecurityError);
  }
}

export class ProductionPdfInspector implements BoundedPdfInspector {
  async inspect(input: {
    bytes: Buffer;
    mediaType: "application/pdf";
    extractText?: boolean;
    signal: AbortSignal;
    limits: Readonly<AttachmentInspectionLimits>;
  }): Promise<{ pageCount: number; decodedBytes: number; text?: string }> {
    return inspectPdfProduction(input).catch(asSecurityError);
  }
}

export class ProductionOcrInspector implements BoundedOcrInspector {
  async extract(input: {
    bytes: Buffer;
    mediaType: InspectedAttachmentMediaType;
    signal: AbortSignal;
    limits: Readonly<AttachmentInspectionLimits>;
  }): Promise<{ text: string; confidence?: number }> {
    return extractOcrProduction(input).catch(asSecurityError);
  }
}

export function createProductionAttachmentInspectionAdapters(): AttachmentInspectionAdapters {
  return Object.freeze({
    imageDecoder: new ProductionJpegDecoder(),
    pdfInspector: new ProductionPdfInspector(),
    ocrInspector: new ProductionOcrInspector(),
  });
}
