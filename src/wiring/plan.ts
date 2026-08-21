import type { BuildConfig } from "../config/types";
import type { SkuCatalog } from "../sku/types";
import type { WiringPlan, BayDataPath, BackplanePowerFeed, WiringChecklistItem } from "./types";

/**
 * Baseline N6 wiring planner.
 * Exact SlimSAS breakout / HBA lane mapping stays `inferred` or `unknown`
 * until a concrete cable SKU and port photo are locked.
 */
export function planN6Wiring(config: BuildConfig, _catalog: SkuCatalog): WiringPlan {
  const diskCount = config.selection.diskCount;
  const boot = config.selection.boot;
  const useHba =
    config.selection.hbaMode === "always" ||
    diskCount >= 9 ||
    (diskCount >= 8 && boot === "bay");

  const bayPaths: BayDataPath[] = [];
  for (let i = 1; i <= 9; i++) {
    const isBootBay = boot === "bay" && i === 9;
    const isDataBay = i <= diskCount && !(isBootBay && diskCount === 9 && i === 9);

    if (isBootBay) {
      bayPaths.push({
        bayId: `bay-${i}`,
        bayIndex: i,
        target: "sata",
        portLabel: "MB SATA_boot",
        evidence: "inferred",
        note: "2.5″ SATA boot occupies tray 9 — cannot also count 9 data HDDs",
      });
      continue;
    }

    if (!isDataBay) {
      bayPaths.push({
        bayId: `bay-${i}`,
        bayIndex: i,
        target: "sata",
        portLabel: "—",
        evidence: "official",
        note: "Empty tray",
      });
      continue;
    }

    if (useHba) {
      bayPaths.push({
        bayId: `bay-${i}`,
        bayIndex: i,
        target: "hba",
        portLabel: `HBA P${i - 1} (plan)`,
        evidence: "inferred",
        note: "Exact Mini-SAS breakout orientation not verified against a locked cable SKU",
      });
      continue;
    }

    const viaSlim = i > 4;
    bayPaths.push({
      bayId: `bay-${i}`,
      bayIndex: i,
      target: viaSlim ? "slimsas" : "sata",
      portLabel: viaSlim ? `SlimSAS lane plan #${i - 4}` : `MB SATA_${i}`,
      evidence: viaSlim ? "inferred" : "official",
      note: viaSlim
        ? "W680M SlimSAS can expose extra SATA; confirm breakout cable MPN before buy"
        : "Native board SATA",
    });
  }

  const psuId = config.selection.secondaryPsuId ?? config.selection.psuId;
  const backplanePower: BackplanePowerFeed[] = ([1, 2, 3, 4] as const).map((n) => ({
    inletIndex: n,
    psuId,
    leadLabel: `PSU modular lead #${n} (plan)`,
    evidence: "inferred" as const,
    note: "N6 manual: 4 backplane power inputs; which lead is unknown until PSU harness SKU is locked",
  }));

  const checklist: WiringChecklistItem[] = [
    {
      id: "sata-data",
      kind: "data",
      requiredQty: useHba ? 0 : Math.min(diskCount, 4),
      label: "SATA data cables (board native)",
      evidence: "official",
    },
    {
      id: "slimsas-breakout",
      kind: "data",
      requiredQty: useHba ? 0 : diskCount > 4 ? 1 : 0,
      label: "SlimSAS → SATA breakout (MPN TBD)",
      evidence: "unknown",
      purchaseHint: "Lock ASUS-compatible breakout before purchase",
    },
    {
      id: "hba-minisas",
      kind: "data",
      requiredQty: useHba ? 2 : 0,
      label: "Mini-SAS HD to SATA / backplane set for HBA",
      evidence: "unknown",
    },
    {
      id: "bp-power",
      kind: "power",
      requiredQty: 4,
      label: "Backplane power leads (4 inlets)",
      evidence: "official",
    },
  ];

  const warnings: string[] = [];
  if (boot === "bay" && diskCount === 9) {
    warnings.push(
      "SATA boot on tray 9 conflicts with 9 data HDDs — clamp data disks to 8 or move boot to M.2/USB.",
    );
  }
  if (config.selection.psuTopology === "dual" && config.selection.dualStart !== "sync") {
    warnings.push("Dual PSU without sync module is not purchase-ready.");
  }

  return {
    caseId: config.caseId,
    bayPaths,
    backplanePower,
    checklist,
    warnings,
  };
}
