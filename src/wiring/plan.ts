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

export interface CaseWiringProfile {
  trayCount: number;
  backplanePower: {
    inlets: number;
    connectors: { sataPower: number; molex: number };
    /** 1:1 physical inlet order from the locked case adapter. */
    inletOrder: BackplaneConnector[];
  };
  defaults: { secondaryPsuSkuId?: string; bootBaySkuId?: string; ownedNvmeQty: number };
  hba: { defaultSkuId?: string };
}

function assertCaseWiringProfile(profile: CaseWiringProfile): void {
  const nonNegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  if (!profile || typeof profile !== "object"
    || !Number.isSafeInteger(profile.trayCount) || profile.trayCount <= 0
    || !Number.isSafeInteger(profile.backplanePower?.inlets) || profile.backplanePower.inlets <= 0
    || !nonNegative(profile.backplanePower.connectors?.sataPower)
    || !nonNegative(profile.backplanePower.connectors?.molex)
    || profile.backplanePower.connectors.sataPower + profile.backplanePower.connectors.molex
      !== profile.backplanePower.inlets
    || !Array.isArray(profile.backplanePower.inletOrder)
    || profile.backplanePower.inletOrder.length !== profile.backplanePower.inlets
    || profile.backplanePower.inletOrder.some((connector) => connector !== "sata" && connector !== "molex")
    || profile.backplanePower.inletOrder.filter((connector) => connector === "sata").length
      !== profile.backplanePower.connectors.sataPower
    || profile.backplanePower.inletOrder.filter((connector) => connector === "molex").length
      !== profile.backplanePower.connectors.molex
    || !nonNegative(profile.defaults?.ownedNvmeQty)) {
    throw new TypeError("case wiring profile tray/backplane connector order/counts are invalid or do not close");
  }
}

/** Connector order is supplied by the selected case adapter. */
function inletConnector(inletIndex: number, profile: CaseWiringProfile): BackplaneConnector {
  return profile.backplanePower.inletOrder[inletIndex - 1]!;
}

const CONNECTOR_ZH: Record<BackplaneConnector, string> = {
  sata: "SATA 供电线",
  molex: "Molex(PATA) 线",
};

function rail12vCapacity(psuAttrs: Record<string, unknown>): { amps: number; description: string } | null {
  const railA = Number(psuAttrs["rail12vA"]);
  if (Number.isFinite(railA) && railA > 0) {
    return { amps: railA, description: `+12V 额定 ${railA}A` };
  }
  const railW = Number(psuAttrs["rail12vW"]);
  if (Number.isFinite(railW) && railW > 0) {
    const amps = railW / 12;
    return { amps, description: `+12V 额定 ${railW}W（约 ${Math.round(amps * 10) / 10}A）` };
  }
  return null;
}

/** Worst case for a NAS: every drive spins up on the same power-on. */
function spinUpLoad(
  config: BuildConfig,
  catalog: SkuCatalog,
  psuAttrs: Record<string, unknown>,
  profile: CaseWiringProfile,
): BackplaneSpinUpLoad {
  const dataDiskCount = config.selection.diskCount;
  const bootDiskCount = config.selection.boot === "bay" ? 1 : 0;
  const diskCount = dataDiskCount + bootDiskCount;
  const dataDisk = config.selection.diskSkuId
    ? catalog.skus.find((s) => s.id === config.selection.diskSkuId)
    : undefined;
  const bootDisk = bootDiskCount > 0 && profile.defaults.bootBaySkuId
    ? catalog.skus.find((s) => s.id === profile.defaults.bootBaySkuId)
    : undefined;
  const dataDiskA = Number(dataDisk?.attrs?.["startup12vPeakA"]);
  const bootDiskA = Number(bootDisk?.attrs?.["startup12vPeakA"]);
  const leadLimitW = Number(psuAttrs["peripheralLeadWLimit"]);
  const limit = Number.isFinite(leadLimitW) && leadLimitW > 0 ? leadLimitW : null;

  if (diskCount === 0) {
    return {
      diskCount: 0,
      perDiskA: null,
      totalA: 0,
      perInletA: 0,
      perSharedLeadA: 0,
      leadLimitW: limit,
      evidence: "official",
      notes: ["没有已配置的背板盘，不产生背板启转负载或预供电要求。"],
    };
  }

  const dataPeakKnown = dataDiskCount === 0 || Number.isFinite(dataDiskA) && dataDiskA > 0;
  const bootPeakKnown = bootDiskCount === 0 || Number.isFinite(bootDiskA) && bootDiskA > 0;
  if (!dataPeakKnown || !bootPeakKnown) {
    const unknownKinds = [
      ...(!dataPeakKnown ? ["数据盘"] : []),
      ...(!bootPeakKnown ? ["SATA 启动盘"] : []),
    ].join(" / ");
    return {
      diskCount,
      perDiskA: null,
      totalA: null,
      perInletA: null,
      perSharedLeadA: null,
      leadLimitW: limit,
      evidence: "unknown",
      notes: [`${unknownKinds}没有独立的 12V 启动峰值电流数据，无法估算 ${diskCount} 个背板设备同时启转的冲击。`],
    };
  }

  const round = (a: number): number => Math.round(a * 10) / 10;
  const totalA = round(
    (dataDiskCount > 0 ? dataDiskA * dataDiskCount : 0)
      + (bootDiskCount > 0 ? bootDiskA * bootDiskCount : 0),
  );
  const perDiskA = dataDiskCount === 0 ? bootDiskA
    : bootDiskCount === 0 || dataDiskA === bootDiskA ? dataDiskA : null;
  const perInletA = round(totalA / profile.backplanePower.inlets);
  const perSharedLeadA = round((totalA / profile.backplanePower.inlets) * 2);
  const peakDescription = perDiskA === null
    ? `${dataDiskCount} 个数据盘 × ${dataDiskA}A + ${bootDiskCount} 个 SATA 启动盘 × ${bootDiskA}A`
    : `${diskCount} 盘按单盘 12V 峰值 ${perDiskA}A`;
  const notes = [
    `${peakDescription} 估算同时启转共 ${totalA}A（≈${Math.round(totalA * 12)}W）；${profile.backplanePower.inlets} 口均摊每口约 ${perInletA}A。`,
  ];
  const railCapacity = rail12vCapacity(psuAttrs);
  if (railCapacity !== null) {
    const utilization = Math.round((totalA / railCapacity.amps) * 100);
    notes.push(totalA <= railCapacity.amps
      ? `电源 ${railCapacity.description}，背板启转负载占约 ${utilization}%，总 12V 余量充足；仍需单独核对每根外围线。`
      : `电源 ${railCapacity.description}，低于背板同时启转所需 ${totalA}A（约 ${utilization}% 负载），总 12V 余量不足。`);
  } else {
    notes.push("电源没有可用的 +12V 轨额定电流或功率数据，无法确认总启转容量。");
  }
  if (limit !== null) {
    const perInletW = Math.round(perInletA * 12);
    const sharedLeadW = Math.round(perSharedLeadA * 12);
    notes.push(perInletW > limit
      ? `即使一口一线，每根外围线也要过约 ${perInletA}A（≈${perInletW}W），已超过厂商标注的单线 ${limit}W 上限。`
      : `一口一线时每根外围线约 ${perInletA}A（≈${perInletW}W），未超过厂商标注的单线 ${limit}W 上限。`);
    notes.push(sharedLeadW > limit
      ? `若一根外围线串两个背板口，这根线要过约 ${perSharedLeadA}A（≈${sharedLeadW}W），已超过厂商标注的单接头 ${limit}W 上限。`
      : `若一根外围线串两个背板口，这根线要过约 ${perSharedLeadA}A（≈${sharedLeadW}W），未超过厂商标注的单接头 ${limit}W 上限；但仍违反一口一线要求。`);
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
    evidence: ([
      ...(dataDiskCount > 0 ? [dataDisk?.attrs?.["startupEvidence"]] : []),
      ...(bootDiskCount > 0 ? [bootDisk?.attrs?.["startupEvidence"]] : []),
    ].every((evidence) => evidence === "official") ? "official" : "inferred") as BackplaneSpinUpLoad["evidence"],
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
  profile: CaseWiringProfile,
): BackplaneHarnessCheck {
  assertCaseWiringProfile(profile);
  const backplane = profile.backplanePower;
  const populated = config.selection.diskCount > 0 || config.selection.boot === "bay";
  const dual = config.selection.psuTopology === "dual";
  const feedPsuId = dual
    ? (config.selection.secondaryPsuId ?? profile.defaults.secondaryPsuSkuId ?? config.selection.psuId)
    : config.selection.psuId;
  const psu = catalog.skus.find((s) => s.id === feedPsuId);
  const harness = psu?.harness;

  const required: Record<BackplaneConnector, number> = {
    sata: populated ? backplane.connectors.sataPower : 0,
    molex: populated ? backplane.connectors.molex : 0,
  };
  const confirmed: Record<BackplaneConnector, number | null> = {
    sata: harness?.sataLeads ?? null,
    molex: harness?.molexLeads ?? null,
  };
  const connectors: Record<BackplaneConnector, number | null> = {
    sata: harness?.sataConnectors ?? null,
    molex: harness?.molexConnectors ?? null,
  };
  const mixedPeripheralLeads = harness?.mixedPeripheralLeads ?? 0;
  const uniquePeripheralLeads =
    harness?.peripheralLeads !== undefined
      ? harness.peripheralLeads
      : confirmed.sata !== null && confirmed.molex !== null
        ? Math.max(0, confirmed.sata + confirmed.molex - mixedPeripheralLeads)
        : null;
  const spinUp = spinUpLoad(config, catalog, psu?.attrs ?? {}, profile);
  const railCapacity = rail12vCapacity(psu?.attrs ?? {});
  const independentLeadsConfirmed = uniquePeripheralLeads !== null
    && uniquePeripheralLeads >= backplane.inlets
    && confirmed.sata !== null && confirmed.sata >= required.sata
    && confirmed.molex !== null && confirmed.molex >= required.molex;
  const perLeadOverLimit = independentLeadsConfirmed
    && spinUp.leadLimitW !== null
    && spinUp.perInletA !== null
    && spinUp.perInletA * 12 > spinUp.leadLimitW;
  const loadVerdict: BackplaneHarnessCheck["verdict"] = spinUp.totalA === null
    ? "unknown"
    : railCapacity === null
      ? "unknown"
      : spinUp.totalA > railCapacity.amps || perLeadOverLimit ? "bad" : "ok";
  const mergeVerdict = (harnessVerdict: BackplaneHarnessCheck["verdict"]): BackplaneHarnessCheck["verdict"] => {
    if (harnessVerdict === "bad" || loadVerdict === "bad") return "bad";
    if (harnessVerdict === "unknown" || loadVerdict === "unknown") return "unknown";
    if (harnessVerdict === "warn") return "warn";
    return "ok";
  };
  const leadEvidence = harness?.leadEvidence ?? harness?.evidence ?? "unknown";
  const socketCount = Number(psu?.attrs?.["peripheralSockets"]);
  // A published zero is decisive evidence of impossibility, not missing data.
  const peripheralSockets = Number.isSafeInteger(socketCount) && socketCount >= 0 ? socketCount : null;
  // Sockets, not cables, are the hard ceiling: four inlets need four cables plugged in.
  const socketLimited = populated && peripheralSockets !== null && peripheralSockets < backplane.inlets;
  const base = {
    feedPsuId,
    feedRole: (dual ? "backplane-dedicated" : "main") as BackplaneHarnessCheck["feedRole"],
    inlets: backplane.inlets,
    required,
    confirmed,
    connectors,
    uniquePeripheralLeads,
    peripheralSockets,
    socketLimited,
    spinUp,
  };

  if (!populated) {
    return {
      ...base,
      oneLeadPerInlet: true,
      daisyChainOnly: false,
      socketLimited: false,
      verdict: "ok",
      evidence: "official",
      notes: ["背板没有已配置设备；供电线束需求为 0，未生成预供电连接。"],
    };
  }

  const notes: string[] = [
    `手册要求 ${backplane.inlets} 口全插：SATA 供电 ×${required.sata} + Molex(PATA) ×${required.molex}，每口一根独立线，不得菊链串联。`,
  ];
  if (dual) {
    notes.push(`双电源时 ${backplane.inlets} 口只能由专供背板的第二颗电源提供，主电源线束不参与计数。`);
  }
  // A socket ceiling settles the audit on its own: no cable purchase can add a plug point.
  if (socketLimited) {
    notes.push(
      `${psu?.name ?? feedPsuId} 的 SATA/PATA 模组插座只有 ${peripheralSockets} 个，少于背板 ${backplane.inlets} 口，因此一口一根独立线在这颗电源上物理上做不到——加购线也没有插座可插。`,
    );
    notes.push(
      `只剩两种偏离：插满 ${backplane.inlets} 口但其中一口与另一口共用一根线（违背"不串联"），或只插 ${peripheralSockets} 口（违背"建议插满"）。`,
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

  // A published physical lead total is decisive even when the vendor omits
  // typed SATA/Molex counts. Mixed leads explain a common source of double
  // counting, but are not required for this hard ceiling to apply.
  if (uniquePeripheralLeads !== null && uniquePeripheralLeads < backplane.inlets) {
    notes.push(mixedPeripheralLeads > 0
      ? `${psu?.name ?? feedPsuId} 原盒只有 ${uniquePeripheralLeads} 根独立外围线；其中 ${mixedPeripheralLeads} 根是 SATA+Molex 混合线，不能在两类里各算一次。`
      : `${psu?.name ?? feedPsuId} 已确认只有 ${uniquePeripheralLeads} 根独立外围线，少于背板 ${backplane.inlets} 个供电口。`);
    const connectorCapable = (connectors.sata ?? -1) >= required.sata
      && (connectors.molex ?? -1) >= required.molex;
    notes.push(connectorCapable
      ? `接头种类虽覆盖 SATA 与 Molex，但 ${backplane.inlets} 个背板口只能共用这 ${uniquePeripheralLeads} 根线，仍违反一口一线要求。`
      : `无论各型端子如何分布，${uniquePeripheralLeads} 根独立线都不足以按一口一线服务 ${backplane.inlets} 个背板口。`);
    if (peripheralSockets !== null && peripheralSockets > uniquePeripheralLeads) {
      notes.push("面板仍有外围插座；可加购同型号原厂 / 授权外围线补足独立线数，但必须先核对缺口所需的 SATA/Molex 端子类型。");
    }
    return {
      ...base,
      oneLeadPerInlet: false,
      daisyChainOnly: connectorCapable,
      verdict: "bad",
      evidence: leadEvidence,
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
      verdict: mergeVerdict("unknown"),
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
          `而且加线也解决不了：该型号 SATA/PATA 模组插座只有 ${peripheralSockets} 个（少于 ${backplane.inlets} 口），原盒线已占满，下一根线没有插座可插。要做到一口一线只能换外围插座 ≥${backplane.inlets} 的电源，或用双电源让一颗专供背板（那颗同样要有 ${backplane.inlets} 个外围插座）。`,
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
            `注意：${peripheralSockets} 个外围插座是按原盒线材清单推算的，不是逐座点数；走 ① 之前先确认面板真有第 ${backplane.inlets} 个空位。`,
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
      verdict: mergeVerdict(leadEvidence === "official" ? "ok" : "warn"),
    evidence: leadEvidence,
    notes,
  };
}

/**
 * Case-profile wiring planner.
 * Exact SlimSAS breakout / HBA lane mapping stays `inferred` or `unknown`
 * until a concrete cable SKU and port photo are locked.
 */
export function planCaseWiring(config: BuildConfig, catalog: SkuCatalog, profile: CaseWiringProfile): WiringPlan {
  assertCaseWiringProfile(profile);
  const diskCount = config.selection.diskCount;
  const boot = config.selection.boot;
  const populatedBackplane = diskCount > 0 || boot === "bay";
  const sataDeviceCount = diskCount + (boot === "bay" ? 1 : 0);
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
        (s) => s.id === (config.selection.hbaSkuId ?? profile.hba.defaultSkuId),
      )
    : undefined;
  const hbaPorts = Number(hbaSku?.attrs?.["ports"]);
  const hbaPortCount = Number.isSafeInteger(hbaPorts) && hbaPorts > 0 ? hbaPorts : 0;
  const perConnector = Number(hbaSku?.attrs?.["portsPerConnector"]);
  const fanout = Number.isSafeInteger(perConnector) && perConnector > 0 ? perConnector : 4;
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
  for (let i = 1; i <= profile.trayCount; i++) {
    const isBootBay = boot === "bay" && i === profile.trayCount;
    const isDataBay = i <= diskCount && !(isBootBay && diskCount === profile.trayCount && i === profile.trayCount);

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
        note: `2.5″ SATA boot occupies tray ${profile.trayCount} — cannot also count ${profile.trayCount} data HDDs${slot.viaSlim ? "；且它是第 " + (slot.slot + 1) + " 个 SATA 设备，已超出 " + boardPorts.nativeSata + " 路原生口，要占 SlimSAS 扩展" : ""}`,
      });
      continue;
    }

    if (!isDataBay) {
      bayPaths.push({
        bayId: `bay-${i}`,
        bayIndex: i,
        target: "empty",
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

  const backplaneHarness = checkBackplaneHarness(config, catalog, profile);
  const backplanePower: BackplanePowerFeed[] = Array.from(
    { length: populatedBackplane ? profile.backplanePower.inlets : 0 },
    (_, index) => index + 1,
  ).map((n) => {
    const connector = inletConnector(n, profile);
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
      requiredQty: Math.max(0, nvmeCount - profile.defaults.ownedNvmeQty),
      label: `额外 NVMe（超出自有 ${profile.defaults.ownedNvmeQty} 块，型号未锁定）`,
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
  if (sataDeviceCount > 0 && boardCeiling === 0) {
    warnings.push(
      `主板 ${config.boardId} 的 SKU 没有记录 SATA 端口数（nativeSataPorts / slimsasSataPorts），规划器不会替它假设端口：先补齐这两项，否则数据链路和 HBA 触发都不可信。`,
    );
  }
  if (useHba && hbaPortCount === 0) {
    warnings.push(
      `${hbaSku?.name ?? config.selection.hbaSkuId ?? "所选 HBA"} 的 SKU 缺少可用的 ports 字段，规划器只能把全部盘位压回主板端口。`,
    );
  }
  if (useHba && hbaSku?.attrs?.["portsPerConnector"] !== undefined
    && (!Number.isSafeInteger(perConnector) || perConnector <= 0)) {
    warnings.push(
      `${hbaSku.name} 的 portsPerConnector 不是正安全整数，不能据此生成分线端口组；暂按每组 4 口展示，购买前必须核实真实连接器拓扑。`,
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
  if (boot === "bay" && diskCount === profile.trayCount) {
    warnings.push(
      `SATA boot on tray ${profile.trayCount} conflicts with ${profile.trayCount} data HDDs — clamp data disks to ${profile.trayCount - 1} or move boot to M.2/USB.`,
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
