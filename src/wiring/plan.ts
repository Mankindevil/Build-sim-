import type { BuildConfig } from "../config/types";
import type { SkuCatalog } from "../sku/types";
import type {
  WiringPlan,
  BayDataPath,
  BackplaneConnector,
  BackplaneHarnessCheck,
  BackplanePowerFeed,
  BackplaneSpinUpLoad,
  WiringChecklistItem,
} from "./types";
import {
  boardStorage,
  buildSataPorts,
  nativeSataCeiling,
  needsHba,
  slimsasMode,
} from "../core/policy";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";

const BP = n6Profile.backplanePower;

/** Inlets 1–2 take SATA power, 3–4 take Molex (manual p.14 figure). */
function inletConnector(inletIndex: number): BackplaneConnector {
  return inletIndex <= BP.connectors.sataPower ? "sata" : "molex";
}

const CONNECTOR_ZH: Record<BackplaneConnector, string> = {
  sata: "SATA 供电线",
  molex: "Molex(PATA) 线",
};

/** Worst case for a NAS: every drive spins up on the same power-on. */
function spinUpLoad(
  config: BuildConfig,
  catalog: SkuCatalog,
  psuAttrs: Record<string, unknown>,
): BackplaneSpinUpLoad {
  const diskCount = config.selection.diskCount;
  const disk = config.selection.diskSkuId
    ? catalog.skus.find((s) => s.id === config.selection.diskSkuId)
    : undefined;
  const perDiskA = Number(disk?.attrs?.["startup12vPeakA"]);
  const leadLimitW = Number(psuAttrs["peripheralLeadWLimit"]);
  const limit = Number.isFinite(leadLimitW) && leadLimitW > 0 ? leadLimitW : null;

  if (!Number.isFinite(perDiskA) || perDiskA <= 0) {
    return {
      diskCount,
      perDiskA: null,
      totalA: null,
      perInletA: null,
      perSharedLeadA: null,
      leadLimitW: limit,
      evidence: "unknown",
      notes: ["所选硬盘没有 12V 启动峰值电流数据，无法估算同时启转的冲击。"],
    };
  }

  const round = (a: number): number => Math.round(a * 10) / 10;
  const totalA = round(perDiskA * diskCount);
  const perInletA = round(totalA / BP.inlets);
  const perSharedLeadA = round((totalA / BP.inlets) * 2);
  const notes = [
    `${diskCount} 盘同时启转按单盘 12V 峰值 ${perDiskA}A 估算共 ${totalA}A（≈${Math.round(totalA * 12)}W）；四口均摊每口约 ${perInletA}A。`,
  ];
  const railA = Number(psuAttrs["rail12vA"]);
  if (Number.isFinite(railA) && railA > 0) {
    notes.push(
      `电源 +12V 额定 ${railA}A，整机层面余量充足（${Math.round((totalA / railA) * 100)}%）——瓶颈在单根线，不在总功率。`,
    );
  }
  if (limit !== null) {
    notes.push(
      `若一根外围线串两个背板口，这根线要过约 ${perSharedLeadA}A（≈${Math.round(perSharedLeadA * 12)}W），已超过厂商标注的单接头 ${limit}W 上限。`,
    );
  }
  notes.push(
    "交错启转（HBA staggered spin-up 或 Exos 的 SCT 降峰配置）可以压低这个瞬时值，但不改变手册的一口一线要求。",
  );
  return {
    diskCount,
    perDiskA,
    totalA,
    perInletA,
    perSharedLeadA,
    leadLimitW: limit,
    evidence: (disk?.attrs?.["startupEvidence"] as BackplaneSpinUpLoad["evidence"]) ?? "inferred",
    notes,
  };
}

/**
 * Audits the backplane harness on its own. In dual-PSU mode only the dedicated
 * backplane PSU counts — the manual's one-lead-per-inlet rule means main and
 * secondary lead counts must never be added together.
 */
export function checkBackplaneHarness(
  config: BuildConfig,
  catalog: SkuCatalog,
): BackplaneHarnessCheck {
  const dual = config.selection.psuTopology === "dual";
  const feedPsuId = dual
    ? (config.selection.secondaryPsuId ?? n6Profile.defaults.secondaryPsuSkuId)
    : config.selection.psuId;
  const psu = catalog.skus.find((s) => s.id === feedPsuId);
  const harness = psu?.harness;

  const required: Record<BackplaneConnector, number> = {
    sata: BP.connectors.sataPower,
    molex: BP.connectors.molex,
  };
  const confirmed: Record<BackplaneConnector, number | null> = {
    sata: harness?.sataLeads ?? null,
    molex: harness?.molexLeads ?? null,
  };
  const connectors: Record<BackplaneConnector, number | null> = {
    sata: harness?.sataConnectors ?? null,
    molex: harness?.molexConnectors ?? null,
  };
  const spinUp = spinUpLoad(config, catalog, psu?.attrs ?? {});
  const leadEvidence = harness?.leadEvidence ?? harness?.evidence ?? "unknown";
  const socketCount = Number(psu?.attrs?.["peripheralSockets"]);
  const peripheralSockets = Number.isFinite(socketCount) && socketCount > 0 ? socketCount : null;
  // Sockets, not cables, are the hard ceiling: four inlets need four cables plugged in.
  const socketLimited = peripheralSockets !== null && peripheralSockets < BP.inlets;
  const base = {
    feedPsuId,
    feedRole: (dual ? "backplane-dedicated" : "main") as BackplaneHarnessCheck["feedRole"],
    inlets: BP.inlets,
    required,
    confirmed,
    connectors,
    peripheralSockets,
    socketLimited,
    spinUp,
  };

  const notes: string[] = [
    `手册要求 ${BP.inlets} 口全插：SATA 供电 ×${required.sata} + Molex(PATA) ×${required.molex}，每口一根独立线，不得菊链串联。`,
  ];
  if (dual) {
    notes.push("双电源时四口只能由专供背板的第二颗电源提供，主电源线束不参与计数。");
  }
  // A socket ceiling settles the audit on its own: no cable purchase can add a plug point.
  if (socketLimited) {
    notes.push(
      `${psu?.name ?? feedPsuId} 的 SATA/PATA 模组插座只有 ${peripheralSockets} 个，少于背板 ${BP.inlets} 口，因此一口一根独立线在这颗电源上物理上做不到——加购线也没有插座可插。`,
    );
    notes.push(
      `只剩两种偏离：插满 4 口但其中一口与另一口共用一根线（违背"不串联"），或只插 ${peripheralSockets} 口（违背"建议插满"）。`,
    );
    const socketEvidence =
      (psu?.attrs?.["peripheralSocketsEvidence"] as BackplaneHarnessCheck["evidence"]) ?? "inferred";
    return {
      ...base,
      oneLeadPerInlet: false,
      daisyChainOnly: (connectors.molex ?? 0) >= required.molex,
      verdict: "bad",
      evidence: socketEvidence,
      notes,
    };
  }

  const missing = (Object.keys(required) as BackplaneConnector[]).filter(
    (k) => confirmed[k] === null,
  );
  if (missing.length > 0) {
    const connectorBit = missing
      .filter((k) => connectors[k] !== null)
      .map((k) => `${CONNECTOR_ZH[k]}接头 ${connectors[k]} 个`)
      .join(" / ");
    notes.push(
      `${psu?.name ?? feedPsuId} 的 ${missing.map((k) => CONNECTOR_ZH[k]).join(" / ")} 根数未公布${
        connectorBit ? `（只知道${connectorBit}，厂商没说分几根线）` : ""
      }，不能判定能否一口一线喂满四口。`,
    );
    return {
      ...base,
      oneLeadPerInlet: false,
      daisyChainOnly: false,
      verdict: "unknown",
      evidence: "unknown",
      notes,
    };
  }

  const short = (Object.keys(required) as BackplaneConnector[]).filter(
    (k) => (confirmed[k] ?? 0) < required[k],
  );
  if (short.length > 0) {
    // Enough plugs but too few cables is the common SFX case: reachable, yet the
    // manual explicitly discourages chaining two inlets off one lead.
    const daisyChainOnly = short.every((k) => (connectors[k] ?? 0) >= required[k]);
    notes.push(
      `${psu?.name ?? feedPsuId} 缺 ${short
        .map((k) => `${CONNECTOR_ZH[k]} ${required[k] - (confirmed[k] ?? 0)} 根`)
        .join(" / ")}（官方线材表已确认，不是数据缺失）。`,
    );
    if (daisyChainOnly) {
      const surge =
        spinUp.perSharedLeadA !== null
          ? `串起来的那根线在满盘同时启转时要过约 ${spinUp.perSharedLeadA}A（≈${Math.round(spinUp.perSharedLeadA * 12)}W）。`
          : "";
      notes.push(`接头总数够，但要靠同一根线串起两个背板口，正是手册不建议的接法。${surge}`);
      if (socketLimited) {
        notes.push(
          `而且加线也解决不了：该型号 SATA/PATA 模组插座只有 ${peripheralSockets} 个（少于 ${BP.inlets} 口），原盒线已占满，第 4 根线没有插座可插。要做到一口一线只能换外围插座 ≥${BP.inlets} 的电源，或用双电源让一颗专供背板（那颗同样要有 ${BP.inlets} 个外围插座）。`,
        );
      } else {
        notes.push(
          "可走的路：①加购同型号原厂 / 授权外围线（Corsair Type-5 等专有针脚不可混用他牌）；②改用外围线根数够的电源；③双电源，用一颗专供背板。",
        );
        // The buy-a-cable route only exists if a socket is really free. When the
        // socket count is a guess, say so instead of implying a purchase fixes it.
        const socketEvidence = psu?.attrs?.["peripheralSocketsEvidence"];
        if (peripheralSockets === null) {
          notes.push(
            "注意：该型号外围模组插座数未查到，走 ① 之前必须先数面板插座——插座不够时加线也插不上。",
          );
        } else if (socketEvidence !== "official") {
          notes.push(
            `注意：${peripheralSockets} 个外围插座是按原盒线材清单推算的，不是逐座点数；走 ① 之前先确认面板真有第 ${BP.inlets} 个空位。`,
          );
        }
        // Backplane inlets are physically typed, so a missing Molex lead cannot be
        // covered by the spare SATA leads.
        const missingMolex = required.molex - (confirmed.molex ?? 0);
        if (missingMolex > 0) {
          notes.push(
            `缺的是 Molex 口：背板 ${required.molex} 个 PATA 进线口只能用 Molex 端子的线，富余的 SATA 线顶不上；用 SATA→Molex 转接等于在已占用的线上再分流，启转电流反而更集中，不采纳。`,
          );
        }
      }
    } else {
      notes.push("需补该型号原厂 / 授权线，禁止混用其他品牌或代际的模组线。");
    }
    return {
      ...base,
      oneLeadPerInlet: false,
      daisyChainOnly,
      verdict: "bad",
      evidence: leadEvidence,
      notes,
    };
  }

  notes.push("线数满足四口独立供电；仍需开箱逐根核对针脚与长度。");
  return {
    ...base,
    oneLeadPerInlet: true,
    daisyChainOnly: false,
    verdict: leadEvidence === "official" ? "ok" : "warn",
    evidence: leadEvidence,
    notes,
  };
}

/**
 * Baseline N6 wiring planner.
 * Exact SlimSAS breakout / HBA lane mapping stays `inferred` or `unknown`
 * until a concrete cable SKU and port photo are locked.
 */
export function planN6Wiring(config: BuildConfig, catalog: SkuCatalog): WiringPlan {
  const diskCount = config.selection.diskCount;
  const boot = config.selection.boot;
  const board = boardStorage(catalog, config.boardId);
  const nvmeCount = config.selection.nvmeCount ?? 0;
  const slimsasNvme = slimsasMode(board, nvmeCount) === "nvme";
  const boardPorts = buildSataPorts(catalog, config);
  const boardCeiling = nativeSataCeiling(boardPorts);
  const useHba = needsHba(config.selection, boardPorts);

  // The card's own port count is the ceiling. A 9300-8i has eight, so a ninth drive
  // has to fall back to the board — the planner must never invent an HBA port.
  const hbaSku = useHba
    ? catalog.skus.find(
        (s) => s.id === (config.selection.hbaSkuId ?? n6Profile.hba.defaultSkuId),
      )
    : undefined;
  const hbaPorts = Number(hbaSku?.attrs?.["ports"]);
  const hbaPortCount = Number.isFinite(hbaPorts) && hbaPorts > 0 ? hbaPorts : 0;
  const perConnector = Number(hbaSku?.attrs?.["portsPerConnector"]);
  const fanout = Number.isFinite(perConnector) && perConnector > 0 ? perConnector : 4;
  let hbaUsed = 0;
  let boardUsed = 0;

  /** Next free board port, or `null` once the board's own ports are gone. */
  const takeBoardSlot = (): { slot: number; viaSlim: boolean } | null => {
    if (boardUsed >= boardCeiling) return null;
    const slot = boardUsed++;
    return { slot, viaSlim: slot >= boardPorts.nativeSata };
  };

  /** A bay no controller can reach. Recorded as a shortfall so it cannot pass silently. */
  const unreachable: BayDataPath[] = [];
  const noPort = (bayIndex: number, device: string): BayDataPath => {
    const path: BayDataPath = {
      bayId: `bay-${bayIndex}`,
      bayIndex,
      target: "none",
      assignment: { controller: "none", connector: "none", portIndex: null },
      portLabel: "无可用端口",
      evidence: "inferred",
      note:
        boardCeiling === 0
          ? `主板 SKU 未记录 SATA 端口数，${device}无处可接`
          : `HBA 与主板端口均已用尽，${device}无处可接`,
    };
    unreachable.push(path);
    return path;
  };

  const bayPaths: BayDataPath[] = [];
  for (let i = 1; i <= n6Profile.trayCount; i++) {
    const isBootBay = boot === "bay" && i === n6Profile.trayCount;
    const isDataBay = i <= diskCount && !(isBootBay && diskCount === n6Profile.trayCount && i === n6Profile.trayCount);

    if (isBootBay) {
      // The boot SSD consumes a board port like any other device, so it has to go
      // through the same allocator — otherwise its cable never reaches the checklist.
      const slot = takeBoardSlot();
      if (!slot) {
        bayPaths.push(noPort(i, "启动盘"));
        continue;
      }
      bayPaths.push({
        bayId: `bay-${i}`,
        bayIndex: i,
        target: slot.viaSlim ? "slimsas" : "sata",
        assignment: { controller: "board", connector: slot.viaSlim ? "slimsas" : "sata", portIndex: slot.slot + 1 },
        portLabel: slot.viaSlim
          ? `SlimSAS lane plan #${slot.slot - boardPorts.nativeSata + 1}（启动盘）`
          : `MB SATA_${slot.slot + 1}（启动盘）`,
        evidence: "inferred",
        note: `2.5″ SATA boot occupies tray 9 — cannot also count 9 data HDDs${slot.viaSlim ? "；且它是第 " + (slot.slot + 1) + " 个 SATA 设备，已超出 " + boardPorts.nativeSata + " 路原生口，要占 SlimSAS 扩展" : ""}`,
      });
      continue;
    }

    if (!isDataBay) {
      bayPaths.push({
        bayId: `bay-${i}`,
        bayIndex: i,
        target: "sata",
        assignment: { controller: "none", connector: "none", portIndex: null },
        portLabel: "—",
        evidence: "official",
        note: "Empty tray",
      });
      continue;
    }

    if (useHba && hbaUsed < hbaPortCount) {
      const port = hbaUsed++;
      bayPaths.push({
        bayId: `bay-${i}`,
        bayIndex: i,
        target: "hba",
        assignment: { controller: "hba", connector: "sff-8643", portIndex: port + 1 },
        portLabel: `HBA C${Math.floor(port / fanout) + 1}·P${(port % fanout) + 1} (plan)`,
        evidence: "inferred",
        note: "Exact Mini-SAS breakout orientation not verified against a locked cable SKU",
      });
      continue;
    }

    // Board fallback, used both without an HBA and for drives past its last port.
    const overflow = useHba;
    const slot = takeBoardSlot();
    if (!slot) {
      bayPaths.push(noPort(i, `第 ${i} 盘`));
      continue;
    }
    bayPaths.push({
      bayId: `bay-${i}`,
      bayIndex: i,
      target: slot.viaSlim ? "slimsas" : "sata",
      assignment: { controller: "board", connector: slot.viaSlim ? "slimsas" : "sata", portIndex: slot.slot + 1 },
      portLabel: slot.viaSlim
        ? `SlimSAS lane plan #${slot.slot - boardPorts.nativeSata + 1}`
        : `MB SATA_${slot.slot + 1}`,
      evidence: slot.viaSlim ? "inferred" : "official",
      note: overflow
        ? `超出 ${hbaSku?.name ?? "HBA"} 的 ${hbaPortCount} 个口，第 ${i} 盘回落到主板${slot.viaSlim ? " SlimSAS 扩展" : "原生 SATA"}`
        : slot.viaSlim
          ? "Board SlimSAS can expose extra SATA; confirm breakout cable MPN before buy"
          : "Native board SATA",
    });
  }
  const hbaBreakouts = hbaPortCount > 0 ? Math.ceil(hbaUsed / fanout) : 0;
  const boardNativeUsed = Math.min(boardUsed, boardPorts.nativeSata);
  const boardSlimUsed = Math.max(0, boardUsed - boardPorts.nativeSata);

  const backplaneHarness = checkBackplaneHarness(config, catalog);
  const backplanePower: BackplanePowerFeed[] = ([1, 2, 3, 4] as const).map((n) => {
    const connector = inletConnector(n);
    return {
      inletIndex: n,
      connector,
      psuId: backplaneHarness.feedPsuId,
      leadLabel: `${connector === "sata" ? "SATA power" : "Molex"} lead → inlet ${n}`,
      evidence: backplaneHarness.evidence,
      note:
        backplaneHarness.verdict === "unknown"
          ? "Connector type is official; which PSU lead serves it is unknown until the harness is confirmed"
          : "One dedicated lead per inlet — never daisy-chain",
    };
  });

  const checklist: WiringChecklistItem[] = [
    {
      id: "sata-data",
      kind: "data",
      requiredQty: boardNativeUsed,
      label: "SATA data cables (board native)",
      evidence: "official",
    },
    {
      id: "slimsas-breakout",
      kind: "data",
      requiredQty: boardSlimUsed > 0 ? 1 : 0,
      label: "SlimSAS → SATA breakout (MPN TBD)",
      evidence: "unknown",
      purchaseHint: "Lock ASUS-compatible breakout before purchase",
    },
    {
      id: "slimsas-nvme-adapter",
      kind: "data",
      requiredQty: slimsasNvme ? 1 : 0,
      label: "SlimSAS(SFF-8654) → NVMe 转接",
      evidence: "unknown",
      ...(slimsasNvme
        ? { purchaseHint: "目录里没有锁定的 MPN；转接件针脚定义必须与主板 SlimSAS 一致" }
        : {}),
    },
    {
      id: "extra-nvme",
      kind: "other",
      requiredQty: Math.max(0, nvmeCount - n6Profile.defaults.ownedNvmeQty),
      label: `额外 NVMe（超出自有 ${n6Profile.defaults.ownedNvmeQty} 块，型号未锁定）`,
      evidence: "unknown",
    },
    {
      id: "hba-minisas",
      kind: "data",
      requiredQty: hbaBreakouts,
      label: `Mini-SAS HD (SFF-8643) → 4×SATA 分线${hbaBreakouts > 0 ? `，接 ${hbaUsed} 盘` : ""}`,
      evidence: "unknown",
      ...(hbaBreakouts > 0
        ? { purchaseHint: "HBA 用 SFF-8643，与主板 SlimSAS(SFF-8654) 线不可互换" }
        : {}),
    },
    {
      id: "bp-power-sata",
      kind: "power",
      requiredQty: backplaneHarness.required.sata,
      ...(backplaneHarness.confirmed.sata !== null
        ? { haveQty: backplaneHarness.confirmed.sata }
        : {}),
      label: "背板 SATA 供电线（独立，不菊链）",
      evidence: "official",
      ...(backplaneHarness.confirmed.sata === null
        ? { purchaseHint: "先确认所选电源的 SATA 供电线根数" }
        : {}),
    },
    {
      id: "bp-power-molex",
      kind: "power",
      requiredQty: backplaneHarness.required.molex,
      ...(backplaneHarness.confirmed.molex !== null
        ? { haveQty: backplaneHarness.confirmed.molex }
        : {}),
      label: "背板 Molex(PATA) 供电线（独立，不菊链）",
      evidence: "official",
      ...(backplaneHarness.confirmed.molex === null
        ? { purchaseHint: "SFX 电源常只带 1 根 Molex 或仅转接头，务必确认" }
        : backplaneHarness.confirmed.molex < backplaneHarness.required.molex
          ? {
              purchaseHint: `原盒只有 ${backplaneHarness.confirmed.molex} 根，需加购同型号原厂 / 授权外围线`,
            }
          : {}),
    },
  ];

  const warnings: string[] = [];
  if (slimsasNvme) {
    warnings.push(
      `第 ${nvmeCount} 块 NVMe 占用 SlimSAS（板上只有 ${board.m2Slots} 个 M.2 槽），该口不能同时供 SATA：主板 SATA 天花板从 ${board.nativeSata + board.slimsasSata} 降到 ${board.nativeSata}，HBA 触发点相应提前。这块盘挂在 SlimSAS 上的物理位置尚未建模。`,
    );
  }
  if (boardCeiling === 0) {
    warnings.push(
      `主板 ${config.boardId} 的 SKU 没有记录 SATA 端口数（nativeSataPorts / slimsasSataPorts），规划器不会替它假设端口：先补齐这两项，否则数据链路和 HBA 触发都不可信。`,
    );
  }
  if (useHba && hbaPortCount === 0) {
    warnings.push(
      `${hbaSku?.name ?? config.selection.hbaSkuId ?? "所选 HBA"} 的 SKU 缺少可用的 ports 字段，规划器只能把全部盘位压回主板端口。`,
    );
  }
  if (unreachable.length > 0) {
    const supply = useHba
      ? `HBA ${hbaUsed}/${hbaPortCount} 口 + 主板 ${boardUsed}/${boardCeiling} 口`
      : `主板 ${boardUsed}/${boardCeiling} 口`;
    warnings.push(
      `${unreachable.length} 个盘位没有数据端口可接（${supply} 已用尽）：减少盘数，或换端口更多的 HBA。`,
    );
  }
  if (useHba && hbaPortCount > 0 && hbaUsed >= hbaPortCount && boardUsed > 0) {
    warnings.push(
      `${hbaSku?.name ?? "HBA"} 只有 ${hbaPortCount} 个口，第 ${hbaPortCount + 1}–${hbaUsed + boardUsed} 盘回落到主板端口（原生 SATA ${boardNativeUsed} 路${boardSlimUsed > 0 ? ` + SlimSAS ${boardSlimUsed} 路` : ""}）：这不是一张卡吃下全部盘位，混用两个控制器要在系统里确认盘序与直通设置。`,
    );
  }
  if (boot === "bay" && diskCount === n6Profile.trayCount) {
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
    backplaneHarness,
    checklist,
    warnings,
  };
}
