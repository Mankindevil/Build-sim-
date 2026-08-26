export interface FindingTarget {
  section: "platform" | "power" | "storage" | "expansion";
  field: string;
  spatialPartId: string | null;
  taskRef: string | null;
}

export function targetForFinding(findingId: string): FindingTarget {
  const id = findingId.toLowerCase();
  if (id.includes("psu") || id.includes("power") || id.includes("harness")) return { section: "power", field: "selection.psuId", spatialPartId: "psu-primary", taskRef: `verification:${findingId}` };
  if (id.includes("cool") || id.includes("thermal") || id.includes("air")) return { section: "power", field: "selection.coolerId", spatialPartId: "cpu-cooler", taskRef: `verification:${findingId}` };
  if (id.includes("disk") || id.includes("tray") || id.includes("sata") || id.includes("bay") || id.includes("boot")) return { section: "storage", field: "selection.diskCount", spatialPartId: "drive-array", taskRef: `wiring:${findingId}` };
  if (id.includes("hba") || id.includes("pcie")) return { section: "expansion", field: "selection.hbaMode", spatialPartId: "hba", taskRef: `assembly:${findingId}` };
  if (id.includes("gpu")) return { section: "expansion", field: "selection.gpuId", spatialPartId: "gpu", taskRef: `assembly:${findingId}` };
  if (id.includes("memory") || id.includes("mem.") || id.includes("xmp") || id.includes("ram") || id.includes("dimm")) return { section: "expansion", field: "selection.memoryId", spatialPartId: "memory", taskRef: `assembly:${findingId}` };
  // Keep a stable section/field for audit metadata, but do not pretend the
  // whole chassis is a spatial target. The UI only offers edit actions for
  // explicitly editable fields, so this read-only fallback never becomes a
  // dead “go modify” button.
  return { section: "platform", field: "caseId", spatialPartId: null, taskRef: `verification:${findingId}` };
}
