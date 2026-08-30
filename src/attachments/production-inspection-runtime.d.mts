import type {
  AttachmentInspectionLimits,
  InspectedAttachmentMediaType,
} from "./security";

export declare class ProductionAttachmentAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export declare function decodeJpegProduction(input: {
  bytes: Buffer;
  mediaType: "image/jpeg";
  signal: AbortSignal;
  limits: Readonly<AttachmentInspectionLimits>;
}): Promise<{ width: number; height: number; decodedBytes: number }>;

export declare function inspectPdfProduction(input: {
  bytes: Buffer;
  mediaType: "application/pdf";
  extractText?: boolean;
  signal: AbortSignal;
  limits: Readonly<AttachmentInspectionLimits>;
}): Promise<{ pageCount: number; decodedBytes: number; text?: string }>;

export declare function extractOcrProduction(input: {
  bytes: Buffer;
  mediaType: InspectedAttachmentMediaType;
  signal: AbortSignal;
  limits: Readonly<AttachmentInspectionLimits>;
}): Promise<{
  text: string;
  confidence?: number;
  pages?: Array<{ num: number; text: string; confidence: number }>;
}>;
