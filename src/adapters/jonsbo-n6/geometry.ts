import type { BuildConfig } from "../../config/types";
import type { SkuCatalog, SkuRecord } from "../../sku/types";
import type { EvidenceLevel } from "../../core/evidence";
import type { CenteredBox, PlacedPart, Vec3 } from "../../core/geometry";
import { chamberOf } from "../../core/geometry";
import { buildSataPorts, needsHba } from "../../core/policy";
import n6Profile from "../../../data/cases/jonsbo-n6/profile.json";
import geo from "../../../data/cases/jonsbo-n6/geometry.json";

/**
 * The single geometry source for the N6. Everything that needs to know where a
 * part sits — the occupancy engine, the thermal field, the spatial preview —
 * reads this one list. Sizes come from the SKU catalog, anchors from
 * `geometry.json`, and both carry their own evidence label so nothing here can
 * be mistaken for vendor CAD.
 */

export const N6_ENVELOPE_BOX: CenteredBox = {
  c: [0, 0, 0],
  w: geo.envelope.w,
  h: geo.envelope.h,
  d: geo.envelope.d,
};

/**
 * Usable volume: the published 318 mm height includes a 6 mm plinth, so the
 * floor a part can actually rest on is 6 mm above the envelope's bottom face.
 */
export const N6_INTERIOR_BOX: CenteredBox = {
  c: [0, (geo.interior.yFloor + geo.envelope.h / 2) / 2, 0],
  w: geo.envelope.w,
  h: geo.envelope.h / 2 - geo.interior.yFloor,
  d: geo.envelope.d,
};

/** Height of the chamber divider. Also the thermal model's chamber boundary. */
export const N6_DECK_Y = geo.deck.y;

export type PsuPlacement =
  | "rearUpperAtx"
  | "frontSfx"
  | "bottomSfx"
  | "rearUpperAtx+bottomSfx"
  | "frontSfx+bottomSfx"
  | "invalidAtxBottom";

/** Runtime knobs the build config does not carry (fan population, custom card). */
export interface GeometryEnv {
  frontFans?: "none" | "140x2" | "120x2";
  rearFan?: boolean;
  driveFans?: boolean;
  sideFans?: boolean;
  /** Keep the chipset x4 envelope drawn even before an HBA is bought. */
  reserveHbaSlot?: boolean;
  /** User-entered card envelope; the V1 "custom GPU" path has no SKU. */
  gpuOverride?: {
    name: string;
    lengthMm: number;
    slots: number;
    workstation?: boolean;
  } | null;
}

const INFERRED: EvidenceLevel = "inferred";

function sku(catalog: SkuCatalog, id: string): SkuRecord | undefined {
  return catalog.skus.find((s) => s.id === id);
}

function psuForm(catalog: SkuCatalog, id: string): "ATX" | "SFX" {
  return (sku(catalog, id)?.attrs?.["form"] as "ATX" | "SFX" | undefined) ?? "ATX";
}

export function n6PsuPlacement(config: BuildConfig, catalog: SkuCatalog): PsuPlacement {
  const form = psuForm(catalog, config.selection.psuId);
  const topo = config.selection.psuTopology;
  if (topo === "dual") return form === "ATX" ? "rearUpperAtx+bottomSfx" : "frontSfx+bottomSfx";
  if (topo === "bottom") return form === "SFX" ? "bottomSfx" : "invalidAtxBottom";
  return form === "ATX" ? "rearUpperAtx" : "frontSfx";
}

export function psuInLowerChamber(placement: PsuPlacement): boolean {
  return placement.includes("bottomSfx");
}

/** GPU card height is nowhere in the catalog; derive it from class + length. */
function gpuHeightMm(workstation: boolean, lengthMm: number): number {
  if (!workstation) return geo.gpu.heightConsumerMm;
  return lengthMm < 180 ? geo.gpu.heightWorkstationLowMm : geo.gpu.heightWorkstationMm;
}

/** Footprints are per-SKU where we have them; the type default is a planning value. */
function coolerFootprintMm(skuId: string, type: string): number {
  const known = (geo.cooler.footprintBySku as Record<string, number>)[skuId];
  if (typeof known === "number") return known;
  return type === "tower" ? geo.cooler.towerFootprintMm : geo.cooler.downdraftFootprintMm;
}

interface Builder {
  parts: PlacedPart[];
  push: (part: PlacedPart) => PlacedPart;
}

function builder(): Builder {
  const parts: PlacedPart[] = [];
  return {
    parts,
    push(part) {
      parts.push(part);
      return part;
    },
  };
}

function chassis(
  id: string,
  name: string,
  box: CenteredBox,
  dimsLabel: string,
  note?: string,
  slotId?: string,
): PlacedPart {
  return {
    id,
    name,
    kind: "chassis",
    box,
    sizeEvidence: INFERRED,
    anchorEvidence: INFERRED,
    dimsLabel,
    group: "chassis",
    chamber: chamberOf(box, N6_DECK_Y),
    ...(note ? { note } : {}),
    ...(slotId ? { slotId } : {}),
  };
}

function centered(c: Vec3, w: number, h: number, d: number): CenteredBox {
  return { c, w, h, d };
}

/** Union AABB of a set of boxes — used for the tray cage and fan walls. */
export function unionBox(boxes: CenteredBox[]): CenteredBox {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const size = (b: CenteredBox): Vec3 => [b.w, b.h, b.d];
  for (const box of boxes) {
    const s = size(box);
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i]!, box.c[i]! - s[i]! / 2);
      hi[i] = Math.max(hi[i]!, box.c[i]! + s[i]! / 2);
    }
  }
  return {
    c: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2],
    w: hi[0]! - lo[0]!,
    h: hi[1]! - lo[1]!,
    d: hi[2]! - lo[2]!,
  };
}

/** The cage envelope the nine trays live in, derived from its own frame bars. */
export function trayCageBox(): CenteredBox {
  return unionBox(geo.trayFrame.bars.map((bar) => centered(bar.c as Vec3, bar.w, bar.h, bar.d)));
}

export function buildN6Geometry(
  config: BuildConfig,
  catalog: SkuCatalog,
  env: GeometryEnv = {},
): PlacedPart[] {
  const b = builder();
  const boardTop = geo.board.topY;
  const placement = n6PsuPlacement(config, catalog);
  const lowerPsu = psuInLowerChamber(placement);
  const boardSku = sku(catalog, config.boardId);
  const cpuSku = sku(catalog, config.cpuId);

  // ---- chassis shell ----------------------------------------------------
  b.push(
    chassis(
      "chassis.deck",
      "分层托盘",
      centered([0, geo.deck.y, 0], geo.envelope.w, geo.deck.thicknessMm, geo.envelope.d),
      "位置与板厚推算",
      geo.deck.note,
    ),
  );

  // ---- board and everything bolted to it -------------------------------
  b.push({
    id: "board",
    name: boardSku?.name ?? config.boardId,
    kind: "board",
    box: centered(geo.board.c as Vec3, geo.board.w, geo.board.h, geo.board.d),
    sizeEvidence: "standard",
    anchorEvidence: INFERRED,
    dimsLabel: geo.board.dimsLabel,
    skuId: config.boardId,
    chamber: "upper",
  });

  const socketC: Vec3 = [geo.socket.c[0]!, boardTop + geo.socket.h / 2, geo.socket.c[1]!];
  b.push({
    id: "cpu",
    name: cpuSku?.name ?? config.cpuId,
    kind: "cpu",
    box: centered(socketC, geo.socket.w, geo.socket.h, geo.socket.d),
    sizeEvidence: "standard",
    anchorEvidence: INFERRED,
    dimsLabel: geo.socket.dimsLabel,
    skuId: config.cpuId,
    mountedOn: "board",
    thermalId: "cpu",
    chamber: "upper",
  });

  const memory = sku(catalog, config.selection.memoryId);
  const ramModules = memory?.attrs?.["modules"] as number | undefined;
  const ramHeight = memory?.dims.heightMm;
  const ramXs = typeof ramModules === "number" && ramModules >= 2 ? geo.memory.xTwoModules : geo.memory.xOneModule;
  if (typeof ramHeight === "number" && Number.isFinite(ramHeight) && typeof ramModules === "number" && ramModules > 0) ramXs.slice(0, ramModules).forEach((x, i) => {
    b.push({
      id: `ram.${i + 1}`,
      name: `DDR5 DIMM ${i + 1}`,
      kind: "ram",
      box: centered(
        [x, boardTop + ramHeight / 2, geo.memory.zCenter],
        geo.memory.w,
        ramHeight,
        geo.memory.d,
      ),
      sizeEvidence: memory?.dims.evidence ?? INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: `133.35×${ramHeight}×约 5mm · 锚点推算`,
      ...(config.selection.memoryId ? { skuId: config.selection.memoryId } : {}),
      mountedOn: "board",
      chamber: "upper",
    });
  });

  const nvme = sku(catalog, n6Profile.defaults.ownedNvmeSkuId);
  const m2Names =
    config.selection.boot === "m2"
      ? [`${nvme?.name ?? n6Profile.defaults.ownedNvmeSkuId} #1 · TrueNAS Boot`, `${nvme?.name ?? n6Profile.defaults.ownedNvmeSkuId} #2 · 单盘 / 待用`]
      : [`${nvme?.name ?? n6Profile.defaults.ownedNvmeSkuId} #1 · fast pool`, `${nvme?.name ?? n6Profile.defaults.ownedNvmeSkuId} #2 · fast pool`];
  geo.m2.slots.forEach((slot, i) => {
    b.push({
      id: `m2.${i + 1}`,
      name: m2Names[i] ?? slot.id,
      kind: "m2",
      box: centered(
        [slot.c[0]!, boardTop + geo.m2.h / 2 + 0.5, slot.c[1]!],
        geo.m2.w,
        geo.m2.h,
        geo.m2.d,
      ),
      sizeEvidence: "standard",
      anchorEvidence: INFERRED,
      dimsLabel: geo.m2.dimsLabel,
      skuId: n6Profile.defaults.ownedNvmeSkuId,
      mountedOn: "board",
      chamber: "upper",
      ...(slot.note ? { note: slot.note } : {}),
    });
  });

  // ---- PSU -------------------------------------------------------------
  const primary = sku(catalog, config.selection.psuId);
  const primaryLen = primary?.dims.lengthMm;

  const pushPsu = (
    id: string,
    name: string,
    anchor: typeof geo.psu.rearUpperAtx | typeof geo.psu.frontSfx | typeof geo.psu.bottomSfx,
    lengthMm: number,
    skuId: string,
    slotId: string,
    parent?: string,
  ): void => {
    const zRear = (anchor as { zRear?: number }).zRear;
    const zFront = (anchor as { zFront?: number }).zFront;
    const z = zRear !== undefined ? zRear - lengthMm / 2 : (zFront ?? 0) + lengthMm / 2;
    b.push({
      id,
      name,
      kind: "psu",
      box: centered([anchor.c[0]!, anchor.c[1]!, z], anchor.w, anchor.h, lengthMm),
      sizeEvidence: "standard",
      anchorEvidence: INFERRED,
      dimsLabel: `${anchor.w}×${anchor.h}×${lengthMm}mm`,
      skuId,
      slotId,
      thermalId: "psu",
      chamber: anchor.c[1]! < N6_DECK_Y ? "lower" : "upper",
      ...(parent ? { mountedOn: parent } : {}),
    });
  };

  if (primaryLen !== undefined && (placement === "rearUpperAtx" || placement === "rearUpperAtx+bottomSfx" || placement === "invalidAtxBottom")) {
    pushPsu(
      "psu.primary",
      primary?.name ?? "ATX 电源",
      geo.psu.rearUpperAtx,
      primaryLen,
      config.selection.psuId,
      "psu.rear_upper",
    );
  }
  if (primaryLen !== undefined && (placement === "frontSfx" || placement === "frontSfx+bottomSfx")) {
    pushPsu(
      "psu.primary",
      primary?.name ?? "SFX 电源",
      geo.psu.frontSfx,
      primaryLen,
      config.selection.psuId,
      "psu.front_sfx",
    );
  }

  // ---- lower-left wall: bracket XOR the shipped PSU rack ----------------
  const wall = geo.lowerLeftWall;
  if (lowerPsu) {
    b.push(
      chassis(
        "chassis.psu_rack_plate",
        "下置电源架 · 随箱件",
        centered(wall.psuRackPlate.c as Vec3, wall.psuRackPlate.w, wall.psuRackPlate.h, wall.psuRackPlate.d),
        wall.dimsLabel,
        "电源不是直接拧在机箱上，而是先装到随箱电源架上再整体装回（手册 §8.1–8.3）。",
      ),
    );
    b.push(
      chassis(
        "chassis.psu_rack_side",
        "下置电源架 · 侧固定板",
        centered(wall.psuRackSide.c as Vec3, wall.psuRackSide.w, wall.psuRackSide.h, wall.psuRackSide.d),
        wall.dimsLabel,
      ),
    );
    const secondaryId =
      config.selection.psuTopology === "dual"
        ? (config.selection.secondaryPsuId ?? n6Profile.defaults.secondaryPsuSkuId)
        : config.selection.psuId;
    const secondary = sku(catalog, secondaryId);
    if (typeof secondary?.dims.lengthMm === "number") {
      pushPsu(
        config.selection.psuTopology === "dual" ? "psu.secondary" : "psu.primary",
        config.selection.psuTopology === "dual"
          ? `${secondary?.name ?? "第二颗 SFX"} · 背板电源`
          : `${primary?.name ?? "SFX 电源"} · 下置`,
        geo.psu.bottomSfx,
        secondary.dims.lengthMm,
        secondaryId,
        "psu.bottom_sfx",
        "chassis.psu_rack_plate",
      );
    }
  } else {
    b.push(
      chassis(
        "fan.left_bracket",
        "左侧风扇架（4 螺丝可拆）",
        centered(wall.fanBracket.c as Vec3, wall.fanBracket.w, wall.fanBracket.h, wall.fanBracket.d),
        wall.fanBracket.dimsLabel,
        wall.fanBracket.source,
        "fan.left_bracket",
      ),
    );
    b.push({
      id: "psu.bottom_reserve",
      name: "下置 SFX 电源位 · 空置",
      kind: "reserve",
      box: centered(
        [geo.psu.bottomSfx.c[0]!, geo.psu.bottomSfx.c[1]!, geo.psu.bottomSfx.zRear - n6Profile.psuLimits.sfxMaxLengthMm / 2],
        geo.psu.bottomSfx.w,
        geo.psu.bottomSfx.h,
        n6Profile.psuLimits.sfxMaxLengthMm,
      ),
      sizeEvidence: "standard",
      anchorEvidence: INFERRED,
      dimsLabel: `125×63.5×${n6Profile.psuLimits.sfxMaxLengthMm}mm · 要用得先拆左侧风扇架`,
      group: "chassis",
      chamber: "lower",
    });
  }

  // ---- cooler ----------------------------------------------------------
  const cooler = sku(catalog, config.selection.coolerId);
  const coolerType = (cooler?.attrs?.["type"] as string | undefined) ?? "down-draft";
  const coolerHeight = typeof cooler?.dims.heightMm === "number" ? cooler.dims.heightMm : null;
  const maxRam = cooler?.attrs?.["maxRamHeightMm"] as number | undefined;
  const radiatorMm = cooler?.attrs?.["radiatorMm"] as number | undefined;

  if (coolerHeight === null) {
    // No vendor height means no geometry claim; the evaluator/UI must surface unknown.
  } else if (coolerType === "aio") {
    const pump = geo.cooler.aioPump;
    b.push({
      id: "cooler.pump",
      name: "冷头 / 泵",
      kind: "cooler",
      box: centered(pump.c as Vec3, pump.w, pump.h, pump.d),
      sizeEvidence: INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: "75×55×75mm 包络",
      skuId: config.selection.coolerId,
      slotId: "cooler.cpu",
      mountedOn: "cpu",
      chamber: "upper",
    });
    const front = radiatorMm === 240;
    const rad = front ? geo.fanMounts.radiator240Front : geo.fanMounts.radiator120Rear;
    b.push({
      id: "cooler.radiator",
      name: front ? "240 冷排" : "120 冷排",
      kind: "radiator",
      box: centered(rad.c as Vec3, rad.w, rad.h, rad.d),
      sizeEvidence: INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: `${rad.w}×${rad.h}×${rad.d}mm 参考`,
      skuId: config.selection.coolerId,
      ...(front ? { slotId: "radiator.front_240" } : {}),
      chamber: "upper",
    });
    if (front) {
      const mount = geo.fanMounts.front120;
      mount.xOffsets.forEach((x, i) => {
        b.push({
          id: `fan.radiator.${i + 1}`,
          name: "120mm 冷排风扇",
          kind: "fan",
          box: centered(
            [x, mount.c[1]!, geo.fanMounts.front120.c[2]!],
            mount.frameMm,
            mount.frameMm,
            mount.thicknessMm,
          ),
          sizeEvidence: "standard",
          anchorEvidence: INFERRED,
          dimsLabel: "120×120×25mm 标准框",
          slotId: "fan.front",
          mountedOn: "cooler.radiator",
          chamber: "upper",
        });
      });
    }
  } else {
    const footprint = coolerFootprintMm(config.selection.coolerId, coolerType);
    const keepout = Math.min(footprint, geo.socket.keepoutMm);
    const baseHeight = Math.min(geo.cooler.baseHeightMm, coolerHeight);
    // The vendor publishes total height and a RAM ceiling and nothing else. So the
    // cooler is drawn in three layers: a mounting base spanning the LGA1700 hole
    // pitch, a socket-keepout column above it, and — only when the footprint reaches
    // past the keepout — an overhang whose underside sits at the published RAM
    // ceiling. That turns "内存限高" from a sentence into a box something can collide
    // with, while keeping board-level parts (M.2 with heatsink) under the base plate
    // instead of inside it.
    b.push({
      id: "cooler.base",
      name: `${(cooler?.name ?? "散热器").split(" ")[0] ?? "散热器"} · 底座`,
      kind: "cooler",
      box: centered(
        [socketC[0], boardTop + baseHeight / 2, socketC[2]],
        geo.socket.mountPitchMm,
        baseHeight,
        geo.socket.mountPitchMm,
      ),
      sizeEvidence: "standard",
      anchorEvidence: INFERRED,
      dimsLabel: `${geo.socket.mountPitchMm}×${geo.socket.mountPitchMm}mm LGA1700 安装孔距 · 底座高 ${baseHeight}mm 为推算`,
      skuId: config.selection.coolerId,
      slotId: "cooler.cpu",
      mountedOn: "cpu",
      chamber: "upper",
    });
    b.push({
      id: "cooler.column",
      name: (cooler?.name ?? "散热器").split(" ")[0] ?? "散热器",
      kind: "cooler",
      box: centered(
        [socketC[0], boardTop + (baseHeight + coolerHeight) / 2, socketC[2]],
        keepout,
        coolerHeight - baseHeight,
        keepout,
      ),
      sizeEvidence: cooler?.dims.evidence ?? INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: `${footprint}×${footprint}×${coolerHeight}mm · 高度为厂商规格，底座/外伸分层为推算`,
      skuId: config.selection.coolerId,
      mountedOn: "cooler.base",
      chamber: "upper",
    });
    const overhangBase = Math.max(geo.cooler.baseHeightMm, maxRam ?? 0);
    if (footprint > keepout + 1 && overhangBase < coolerHeight) {
      b.push({
        id: "cooler.overhang",
        name: `${cooler?.name ?? "散热器"} · 外伸鳍片`,
        kind: "cooler",
        box: centered(
          [socketC[0], boardTop + (overhangBase + coolerHeight) / 2, socketC[2]],
          footprint,
          coolerHeight - overhangBase,
          footprint,
        ),
        sizeEvidence: INFERRED,
        anchorEvidence: INFERRED,
        dimsLabel: `外伸段下缘抬到板面 +${overhangBase}mm（厂商公布的内存限高）`,
        skuId: config.selection.coolerId,
        mountedOn: "cooler.column",
        chamber: "upper",
        ...(maxRam
          ? { note: `厂商内存限高 ${maxRam}mm：低于此高度的内存从鳍片下方通过，高于则相交。` }
          : {}),
      });
    }
  }

  // ---- expansion cards -------------------------------------------------
  const gpuSku = config.selection.gpuId === "gpu.none" ? undefined : sku(catalog, config.selection.gpuId);
  const gpuEnvelope = env.gpuOverride
    ? {
        name: env.gpuOverride.name,
        lengthMm: env.gpuOverride.lengthMm,
        slots: env.gpuOverride.slots,
        workstation: env.gpuOverride.workstation ?? false,
        skuId: config.selection.gpuId,
      }
    : gpuSku
      ? {
          name: gpuSku.name,
          lengthMm: gpuSku.dims.lengthMm ?? null,
          slots: gpuSku.dims.slots ?? null,
          workstation: (gpuSku.tags ?? []).includes("workstation"),
          skuId: gpuSku.id,
        }
      : null;

  if (gpuEnvelope && gpuEnvelope.lengthMm !== null && gpuEnvelope.slots !== null && gpuEnvelope.lengthMm > 0) {
    const height = gpuHeightMm(gpuEnvelope.workstation, gpuEnvelope.lengthMm);
    const thickness = Math.max(geo.gpu.slotPitchMm, gpuEnvelope.slots * geo.gpu.slotPitchMm);
    // The PCB sits in slot 1; extra slots are consumed toward the chipset x4,
    // which is why a 2.5-slot cooler eats the HBA's space instead of growing
    // symmetrically into the case wall.
    const slot1Face = geo.gpu.x - geo.gpu.slotPitchMm / 2;
    b.push({
      id: "gpu",
      name: gpuEnvelope.name,
      kind: "gpu",
      box: centered(
        [slot1Face + thickness / 2, boardTop + height / 2, geo.gpu.zRear - gpuEnvelope.lengthMm / 2],
        thickness,
        height,
        gpuEnvelope.lengthMm,
      ),
      sizeEvidence: INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: `${gpuEnvelope.lengthMm}×${height}×${thickness.toFixed(0)}mm · 卡高为推算`,
      skuId: gpuEnvelope.skuId,
      slotId: "pcie.slot1",
      mountedOn: "board",
      thermalId: "gpu",
      chamber: "upper",
    });
  }

  const hbaNeeded = needsHba(config.selection, buildSataPorts(catalog, config));
  if (hbaNeeded || env.reserveHbaSlot) {
    b.push({
      id: hbaNeeded ? "hba" : "hba.reserve",
      name: hbaNeeded ? "LSI 9300-8i" : "HBA 预留包络",
      kind: hbaNeeded ? "hba" : "reserve",
      box: centered(
        [geo.hba.c[0]!, boardTop + geo.hba.h / 2, geo.hba.c[1]!],
        geo.hba.w,
        geo.hba.h,
        geo.hba.d,
      ),
      sizeEvidence: "standard",
      anchorEvidence: INFERRED,
      dimsLabel: geo.hba.dimsLabel,
      skuId: config.selection.hbaSkuId ?? n6Profile.hba.defaultSkuId,
      slotId: "pcie.slot2",
      mountedOn: "board",
      ...(hbaNeeded ? { thermalId: "hba" as const } : {}),
      chamber: "upper",
    });
  }

  // ---- drive cage ------------------------------------------------------
  // The cage is one occupancy claim (its union envelope); the individual bars
  // exist only so the preview draws steel instead of an empty rectangle.
  b.push(
    chassis(
      "tray.frame",
      "9 托架钢框",
      trayCageBox(),
      geo.trayFrame.dimsLabel,
      geo.trayFrame.source,
      "tray.frame",
    ),
  );
  for (const bar of geo.trayFrame.bars) {
    b.push({
      ...chassis(
        `tray.frame.${bar.id}`,
        "9 托架钢框",
        centered(bar.c as Vec3, bar.w, bar.h, bar.d),
        geo.trayFrame.dimsLabel,
      ),
      mountedOn: "tray.frame",
    });
  }

  const diskSkuId = config.selection.diskSkuId ?? n6Profile.defaults.diskSkuId;
  const bootInBay = config.selection.boot === "bay";
  for (let i = 0; i < geo.trays.count; i++) {
    const x = (i - 4) * geo.trays.pitchMm;
    const active = i < config.selection.diskCount;
    if (bootInBay && i === geo.trays.count - 1) {
      const boot = geo.trays.boot25;
      b.push({
        id: "tray.9.boot",
        name: "TrueNAS 2.5″ SATA Boot SSD",
        kind: "boot",
        box: centered([x, geo.trays.bootC[1]!, geo.trays.bootC[2]!], boot.w, boot.h, boot.d),
        sizeEvidence: "standard",
        anchorEvidence: INFERRED,
        dimsLabel: "约 69.85×100×7mm · 第 9 托架",
        skuId: n6Profile.defaults.bootBaySkuId,
        slotId: `bay.${geo.trays.count}`,
        mountedOn: "tray.frame",
        chamber: "lower",
      });
      continue;
    }
    const drive = geo.trays.drive35;
    b.push({
      id: `tray.${i + 1}`,
      name: active ? `HDD ${i + 1}` : `空盘位 ${i + 1}`,
      kind: active ? "drive" : "empty",
      box: centered([x, geo.trays.c[1]!, geo.trays.c[2]!], drive.w, drive.h, drive.d),
      sizeEvidence: "standard",
      anchorEvidence: INFERRED,
      dimsLabel: geo.trays.dimsLabel,
      ...(active
        ? { skuId: diskSkuId, slotId: `bay.${i + 1}`, thermalId: "hdd" as const }
        : {}),
      mountedOn: "tray.frame",
      chamber: "lower",
    });
  }

  b.push(
    chassis(
      "backplane.pcb",
      "硬盘背板 PCB",
      centered(
        geo.backplane.pcb.c as Vec3,
        geo.backplane.pcb.w,
        geo.backplane.pcb.h,
        geo.backplane.pcb.d,
      ),
      geo.backplane.dimsLabel,
      geo.backplane.source,
      "backplane.pcb",
    ),
  );
  const inletZh: Record<string, string> = { sata: "SATA供电", molex: "PATA供电" };
  n6Profile.lowerChamber.backplane.inletRowOrder.forEach((type, i) => {
    const inlet = geo.backplane.inlet;
    b.push({
      id: `backplane.inlet.${i + 1}`,
      name: `背板供电口 ${i + 1} · ${inletZh[type] ?? type}`,
      kind: "connector",
      box: centered(
        [inlet.x0 + i * inlet.pitchMm, inlet.c[1]!, inlet.c[2]!],
        inlet.w,
        inlet.h,
        inlet.d,
      ),
      sizeEvidence: INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: "手册 §13 图示排列 · 位置推算",
      mountedOn: "backplane.pcb",
      chamber: "lower",
    });
  });

  // ---- case fans -------------------------------------------------------
  const pushFanRow = (
    idBase: string,
    name: string,
    mount: { c: number[]; frameMm: number; thicknessMm: number; xOffsets?: number[]; zOffsets?: number[] },
    axis: "x" | "z",
    parent?: string,
    slotId?: string,
  ): void => {
    const offsets = (axis === "x" ? mount.xOffsets : mount.zOffsets) ?? [0];
    offsets.forEach((off, i) => {
      const box: CenteredBox =
        axis === "x"
          ? centered([off, mount.c[1]!, mount.c[2]!], mount.frameMm, mount.frameMm, mount.thicknessMm)
          : centered([mount.c[0]!, mount.c[1]!, off], mount.thicknessMm, mount.frameMm, mount.frameMm);
      b.push({
        id: `${idBase}.${i + 1}`,
        name,
        kind: "fan",
        box,
        sizeEvidence: "standard",
        anchorEvidence: INFERRED,
        dimsLabel: `${mount.frameMm >= 130 ? 140 : 120}×${mount.frameMm >= 130 ? 140 : 120}×25mm 标准框 · 位置推算`,
        chamber: chamberOf(box, N6_DECK_Y),
        ...(parent ? { mountedOn: parent } : {}),
        ...(slotId ? { slotId } : {}),
      });
    });
  };

  if (coolerType !== "aio" || radiatorMm !== 240) {
    if (env.frontFans === "140x2") {
      pushFanRow("fan.front", "140mm 前进风", geo.fanMounts.front140, "x", undefined, "fan.front");
    } else if (env.frontFans === "120x2") {
      pushFanRow("fan.front", "120mm 前进风", geo.fanMounts.front120, "x", undefined, "fan.front");
    }
  }
  if (env.rearFan) pushFanRow("fan.rear", "后置 120mm 排风", geo.fanMounts.rear120, "x");
  if (env.sideFans) {
    pushFanRow("fan.side_right", "GPU/HBA 侧吹 120mm", geo.fanMounts.sideRight120, "z");
  }
  // Manual §14 puts the drive-area 120×2 on the bracket §8.1 removes.
  if (env.driveFans && !lowerPsu) {
    const mount = {
      c: [wall.driveFanC[0]!, wall.driveFanC[1]!, 0],
      frameMm: 116,
      thicknessMm: 15,
      zOffsets: wall.driveFanZ,
    };
    pushFanRow("fan.drive", "盘区 120mm 风扇", mount, "z", "fan.left_bracket");
  }

  if (config.selection.boot === "usbssd") {
    const usb = geo.externalUsbBoot;
    b.push({
      id: "boot.usb_external",
      name: "外置 USB TrueNAS Boot SSD",
      kind: "usb",
      box: centered(usb.c as Vec3, usb.w, usb.h, usb.d),
      sizeEvidence: INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: usb.dimsLabel,
      group: "external",
      chamber: "lower",
    });
  }

  // ---- clearance volumes ----------------------------------------------
  for (const c of geo.clearances) {
    if (c.onlyWithGpu && !gpuEnvelope) continue;
    b.push({
      id: c.id,
      name: c.name,
      kind: "clearance",
      box: centered(c.c as Vec3, c.w, c.h, c.d),
      sizeEvidence: INFERRED,
      anchorEvidence: INFERRED,
      dimsLabel: c.dimsLabel,
      chamber: chamberOf(centered(c.c as Vec3, c.w, c.h, c.d), N6_DECK_Y),
      note: c.source,
      ...(c.id === "clearance.gpu_tail_power" ? { mountedOn: "gpu" } : {}),
    });
  }

  return b.parts;
}
