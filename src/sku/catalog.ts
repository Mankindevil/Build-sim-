import type { SkuCatalog, SkuRecord } from "./types";
import catalogJson from "../../data/skus/catalog.json";
import latestPrices from "../../data/prices/latest.json";
import { applyPriceSnapshot, snapshotSummary } from "../price/merge";
import type { PriceSnapshotFile } from "../price/types";

export function indexSkus(catalog: SkuCatalog): Map<string, SkuRecord> {
  return new Map(catalog.skus.map((s) => [s.id, s]));
}

export function requireSku(catalog: SkuCatalog, id: string): SkuRecord {
  const sku = indexSkus(catalog).get(id);
  if (!sku) throw new Error(`Unknown SKU id: ${id}`);
  return sku;
}

export function unknownPrice(): {
  historicalLowEvidence: "unknown";
  currentEvidence: "unknown";
} {
  return { historicalLowEvidence: "unknown", currentEvidence: "unknown" };
}

export function loadBundledPriceSnapshot(): PriceSnapshotFile {
  return latestPrices as PriceSnapshotFile;
}

/** Catalog with audited price snapshots merged in (never fabricates missing quotes). */
export function loadBundledCatalog(): SkuCatalog {
  return applyPriceSnapshot(catalogJson as SkuCatalog, loadBundledPriceSnapshot());
}

/** Raw catalog JSON without price overlay (tests / refresh tooling). */
export function loadRawCatalog(): SkuCatalog {
  return catalogJson as SkuCatalog;
}

export function bundledPriceSummary(): { asOf: string | null; auditedCount: number } {
  return snapshotSummary(loadBundledPriceSnapshot());
}

export function skusByCategory(catalog: SkuCatalog, category: SkuRecord["category"]): SkuRecord[] {
  return catalog.skus.filter((s) => s.category === category);
}

/** Cross-field invariants that JSON schema alone cannot express. */
export function catalogConsistencyIssues(catalog: SkuCatalog): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const sku of catalog.skus) {
    if (seen.has(sku.id)) issues.push(`${sku.id}: duplicate SKU id`);
    seen.add(sku.id);

    if (sku.category !== "psu") continue;
    const panelPeripheral = sku.modularPanel?.groups.find((group) => group.id === "peripheral")?.sockets;
    const attrPeripheral = sku.attrs?.peripheralSockets;
    if (
      typeof panelPeripheral === "number" &&
      typeof attrPeripheral === "number" &&
      panelPeripheral !== attrPeripheral
    ) {
      issues.push(
        `${sku.id}: attrs.peripheralSockets=${attrPeripheral} but modularPanel peripheral=${panelPeripheral}`,
      );
    }

    if (typeof sku.modularPanel?.total === "number") {
      const groupTotal = sku.modularPanel.groups.reduce((sum, group) => sum + group.sockets, 0);
      if (groupTotal !== sku.modularPanel.total) {
        issues.push(`${sku.id}: modularPanel.total=${sku.modularPanel.total} but groups sum to ${groupTotal}`);
      }
    }

    const harness = sku.harness;
    if (!harness) continue;
    const mixed = harness.mixedPeripheralLeads ?? 0;
    if (typeof harness.sataLeads === "number" && mixed > harness.sataLeads) {
      issues.push(`${sku.id}: mixedPeripheralLeads exceeds sataLeads`);
    }
    if (typeof harness.molexLeads === "number" && mixed > harness.molexLeads) {
      issues.push(`${sku.id}: mixedPeripheralLeads exceeds molexLeads`);
    }
    if (
      typeof harness.peripheralLeads === "number" &&
      typeof harness.sataLeads === "number" &&
      typeof harness.molexLeads === "number"
    ) {
      const uniqueTypedLeads = harness.sataLeads + harness.molexLeads - mixed;
      if (harness.peripheralLeads !== uniqueTypedLeads) {
        issues.push(
          `${sku.id}: peripheralLeads=${harness.peripheralLeads} but typed unique leads=${uniqueTypedLeads}`,
        );
      }
    }
    if (
      typeof harness.peripheralLeads === "number" &&
      typeof attrPeripheral === "number" &&
      harness.peripheralLeads > attrPeripheral
    ) {
      issues.push(
        `${sku.id}: ${harness.peripheralLeads} bundled peripheral leads exceed ${attrPeripheral} panel sockets`,
      );
    }
  }

  return issues;
}

export function resolveSelectionIds(config: {
  caseId: string;
  boardId: string;
  cpuId: string;
  selection: {
    psuId: string;
    secondaryPsuId?: string | null;
    coolerId: string;
    gpuId: string;
    memoryId: string;
    diskSkuId?: string;
    hbaSkuId?: string | null;
  };
}): string[] {
  const ids = [
    config.caseId,
    config.boardId,
    config.cpuId,
    config.selection.psuId,
    config.selection.coolerId,
    config.selection.gpuId,
    config.selection.memoryId,
  ];
  if (config.selection.secondaryPsuId) ids.push(config.selection.secondaryPsuId);
  if (config.selection.diskSkuId) ids.push(config.selection.diskSkuId);
  if (config.selection.hbaSkuId) ids.push(config.selection.hbaSkuId);
  return ids;
}
