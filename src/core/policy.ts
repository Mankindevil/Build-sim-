import type { BootMode, BuildConfig, BuildSelection } from "../config/types";
import type { SkuCatalog } from "../sku/types";

/** SATA ports a board offers: native headers plus what its SlimSAS port breaks out. */
export interface SataPortCapacity {
  nativeSata: number;
  slimsasSata: number;
}

/** What a board's SKU claims about storage, before any of it is spoken for. */
export interface BoardStorage extends SataPortCapacity {
  m2Slots: number;
}

/**
 * SlimSAS is one connector wired to four PCIe lanes, and the board's firmware gives it two
 * mutually exclusive personalities: PCIe x4 for an NVMe drive, or four SATA ports through a
 * breakout cable. Only NVMe drives past the M.2 slots have anywhere else to go, so they are
 * what flips it.
 */
export type SlimsasMode = "sata" | "nvme";

function portCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Storage facts from the board's own SKU, so swapping boards moves the data-path plan with
 * it. A board with no audited counts reports zero rather than inheriting the baseline's:
 * the planner would otherwise route drives to ports no manual promises.
 */
export function boardStorage(catalog: SkuCatalog, boardId: string): BoardStorage {
  const attrs = catalog.skus.find((s) => s.id === boardId)?.attrs;
  return {
    nativeSata: portCount(attrs?.["nativeSataPorts"]),
    slimsasSata: portCount(attrs?.["slimsasSataPorts"]),
    m2Slots: portCount(attrs?.["m2Slots"]),
  };
}

export function slimsasMode(board: BoardStorage, nvmeCount: number): SlimsasMode {
  return nvmeCount > board.m2Slots ? "nvme" : "sata";
}

/**
 * SATA ports this build can still reach. An undeclared NVMe count claims nothing: the
 * caller has not said anything occupies SlimSAS, so it stays in SATA mode.
 */
export function boardSataPorts(
  catalog: SkuCatalog,
  boardId: string,
  nvmeCount = 0,
): SataPortCapacity {
  const board = boardStorage(catalog, boardId);
  return {
    nativeSata: board.nativeSata,
    slimsasSata: slimsasMode(board, nvmeCount) === "nvme" ? 0 : board.slimsasSata,
  };
}

/** The same, resolved straight from a build. Every caller in the engine uses this one. */
export function buildSataPorts(catalog: SkuCatalog, config: BuildConfig): SataPortCapacity {
  return boardSataPorts(catalog, config.boardId, config.selection.nvmeCount);
}

export function sataDeviceCount(diskCount: number, boot: BootMode): number {
  return diskCount + (boot === "bay" ? 1 : 0);
}

/**
 * SATA devices the board can host without a card. Derived rather than stored, so editing
 * a port count can never leave the HBA trigger disagreeing with the ports it describes.
 */
export function nativeSataCeiling(ports: SataPortCapacity): number {
  return ports.nativeSata + ports.slimsasSata;
}

/** Shared HBA trigger — used by evaluate, occupancy, and wiring. */
export function needsHba(
  selection: Pick<BuildSelection, "hbaMode" | "diskCount" | "boot">,
  ports: SataPortCapacity,
): boolean {
  if (selection.hbaMode === "always") return true;
  return sataDeviceCount(selection.diskCount, selection.boot) > nativeSataCeiling(ports);
}
