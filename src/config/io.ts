import type { BuildConfig, BuildLineItem, BuildSelection } from "./types";
import { parseConfig, serializeConfig } from "./types";
import type { BuildEvaluation } from "../core/evaluate";
import type { BuildTask } from "../plans/contracts";

export { parseConfig, serializeConfig };

export function createConfig(partial: {
  id: string;
  name: string;
  selection: BuildSelection;
  bom?: BuildLineItem[];
  notes?: string[];
}): BuildConfig {
  const config: BuildConfig = {
    schemaVersion: "2.0.0",
    id: partial.id,
    name: partial.name,
    updatedAt: new Date().toISOString().slice(0, 10),
    caseId: "case.jonsbo-n6",
    boardId: "board.asus-w680m-ace-se",
    cpuId: "cpu.i5-14500",
    selection: partial.selection,
    bom: partial.bom ?? [],
  };
  if (partial.notes) config.notes = partial.notes;
  return config;
}

export interface ChecklistExportContext {
  planId: string;
  planVersionId: string;
  planVersionNumber?: number;
  generatedAt: string;
  configHash: string;
  evaluationHash: string;
  tasks: BuildTask[];
}

export function exportChecklist(config: BuildConfig, bom: BuildLineItem[], evaluation?: BuildEvaluation, context?: ChecklistExportContext): string {
  const lines = [
    `# Install checklist — ${config.name}`,
    "",
    `Updated: ${config.updatedAt}`,
    `Case: ${config.caseId}`,
    `Board: ${config.boardId}`,
    `CPU: ${config.cpuId}`,
    "",
    "## Selection",
    `- PSU: ${config.selection.psuId} (${config.selection.psuTopology})`,
    `- Cooler: ${config.selection.coolerId}`,
    `- GPU: ${config.selection.gpuId}`,
    `- Memory: ${config.selection.memoryId}`,
    `- Disks: ${config.selection.diskCount} × ${config.selection.diskSkuId ?? "(default HDD SKU)"}`,
    `- Boot: ${config.selection.boot}`,
    `- HBA: ${config.selection.hbaMode}`,
    "",
    "## BOM",
  ];
  for (const line of bom) {
    lines.push(`- [${line.bucket}] ${line.qty}× ${line.skuId}`);
  }
  if (evaluation) {
    lines.push(
      "",
      "## Deterministic evidence",
      `- BuildEvaluation physical ruleset: ${evaluation.physical.rulesetVersion}`,
      `- BuildEvaluation physical hash: ${evaluation.physical.hash}`,
      `- Physical provenance: ${evaluation.physical.provenance.join(", ")}`,
      `- Calibration snapshot: ${evaluation.calibration.snapshot.calibrationVersion}`,
      `- Calibration hash: ${evaluation.calibration.hash}`,
      `- Calibration unknown: ${evaluation.calibration.unknown.join(", ") || "none"}`,
      `- Physical findings: ${evaluation.physical.findings.map((finding) => `${finding.verdict}:${finding.id}`).join(", ") || "none"}`,
    );
  }
  if (context) {
    lines.push(
      "",
      "## Saved plan trace",
      `- Plan: ${context.planId}`,
      `- Saved version: ${context.planVersionId}${context.planVersionNumber ? ` (v${context.planVersionNumber})` : ""}`,
      `- Generated at: ${context.generatedAt}`,
      `- Config hash: ${context.configHash}`,
      `- Evaluation hash: ${context.evaluationHash}`,
      "",
      "## Reconciled tasks",
    );
    for (const item of context.tasks) {
      lines.push(`- [${item.status === "done" ? "x" : " "}] [${item.status}] ${item.title} <!-- ${item.sourceRef} -->${item.note ? ` — ${item.note}` : ""}`);
    }
  }
  lines.push("", "## Notes");
  for (const n of config.notes ?? []) lines.push(`- ${n}`);
  lines.push("");
  return lines.join("\n");
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
