import type { BuildConfig } from "../config/types";
import type { BuildPlanMetadata } from "./contracts";
import n6Profile from "../../data/cases/jonsbo-n6/profile.json";

export function createDefaultN6Config(planId: string, timestamp: string): BuildConfig {
  return {
    schemaVersion: "2.0.0",
    id: planId,
    name: "N6 Build Lab",
    updatedAt: timestamp,
    caseId: "case.jonsbo-n6",
    boardId: "board.asus-w680m-ace-se",
    cpuId: "cpu.i5-14500",
    selection: {
      psuId: "psu.seasonic-focus-gx-850-v5",
      psuTopology: "auto",
      coolerId: "cooler.thermalright-axp90-x53-full",
      gpuId: "gpu.none",
      memoryId: "memory.kingston-ksm48e40bd8km-32hm-x2",
      diskCount: 1,
      diskSkuId: n6Profile.defaults.diskSkuId,
      nvmeCount: n6Profile.defaults.ownedNvmeQty,
      boot: "bay",
      hbaMode: "auto",
      hbaSkuId: null,
      fanMode: "balanced",
      fanGroups: [{ mountId: "front", sizeMm: 140, count: 2 }],
    },
    bom: [],
  };
}

/** A real empty draft: no hidden case or component selection is implied. */
export function createEmptyBuildConfig(planId: string, timestamp: string): BuildConfig {
  return {
    schemaVersion: "2.0.0",
    id: planId,
    name: "空白装机方案",
    updatedAt: timestamp,
    caseId: "",
    boardId: "",
    cpuId: "",
    selection: {
      psuId: "",
      psuTopology: "auto",
      coolerId: "",
      gpuId: "",
      memoryId: "",
      diskCount: 0,
      nvmeCount: 0,
      boot: "m2",
      hbaMode: "auto",
      hbaSkuId: null,
      fanMode: "balanced",
      fanGroups: [],
    },
    bom: [],
  };
}

/** Agent and ordinary blank plans share the same honest, incrementally editable draft. */
export function createAgentInitializationScaffold(planId: string, timestamp: string): { config: BuildConfig; metadata: BuildPlanMetadata } {
  return { config: createEmptyBuildConfig(planId, timestamp), metadata: {} };
}
