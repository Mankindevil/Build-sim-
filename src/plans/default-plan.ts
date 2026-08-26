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
    },
    bom: [],
  };
}

/**
 * A pending Agent plan still carries a valid internal config so the existing
 * deterministic UI can render while requirements are being collected. The
 * metadata flag is authoritative: none of these scaffold selections represent
 * a user recommendation until an initialization proposal is approved.
 */
export function createAgentInitializationScaffold(planId: string, timestamp: string): { config: BuildConfig; metadata: BuildPlanMetadata } {
  const config = createDefaultN6Config(planId, timestamp);
  config.name = "待 Agent 初始化方案";
  return {
    config,
    metadata: {
      tags: ["agent-initialization"],
      initialization: { status: "pending", source: "agent" },
    },
  };
}
