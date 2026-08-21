import type { BuildConfig, BuildLineItem, BuildSelection } from "./types";
import { parseConfig, serializeConfig } from "./types";

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

export function exportChecklist(config: BuildConfig, bom: BuildLineItem[]): string {
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
