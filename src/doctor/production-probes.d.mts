export interface ProductionDoctorProbeResult {
  serviceVersionsVerified: boolean;
  browserWebglAvailable: boolean;
  pdfParserAvailable: boolean;
  searxngAvailable?: boolean;
  referenceClockMs?: number;
}

export function probeBrowserWebgl(): Promise<boolean>;
export function probePdfParser(): Promise<boolean>;
export function probeProductionDoctorCapabilities(options?: {
  coordinator?: { readState(): Promise<{ appVersion: string }> };
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  browserWebglProbe?: () => Promise<boolean>;
  pdfParserProbe?: () => Promise<boolean>;
  offline?: boolean;
}): Promise<ProductionDoctorProbeResult>;
