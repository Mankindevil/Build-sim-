/** Evidence labels — never upgrade without a stronger source. */
export type EvidenceLevel = "official" | "standard" | "inferred" | "unknown";

export type ConflictVerdict = "ok" | "warn" | "bad";

export interface EvidenceRef {
  level: EvidenceLevel;
  /** Short human note; may cite manual page or SKU datasheet. */
  note: string;
  sourceId?: string;
}

export const EVIDENCE_LABELS: Record<EvidenceLevel, string> = {
  official: "官方确认",
  standard: "标准规格",
  inferred: "结构推算",
  unknown: "尚未验证",
};
