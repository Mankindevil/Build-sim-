import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeFlags } from "../scripts/runtime/flags.mjs";
import { atomicWriteJson, restoreLatestRollback } from "../scripts/price-server/store.mjs";

describe("G0 upgrade guardrails", () => {
  it("keeps catalog writes and advice disabled by default", async () => {
    const flags = await loadRuntimeFlags({});
    expect(flags).toEqual({
      catalogWriteEnabled: false,
      catalogAutoEnrichTrustedOfficial: true,
      catalogAutoAcceptExactMpn: false,
      catalogAutoTrustNewDomains: false,
      adviceEnabled: false,
      topologyV3Enabled: false,
      factGraphEnabled: false,
      userObservationsEnabled: false,
      genericAdaptersEnabled: false,
      progressiveEvaluationEnabled: false,
      wholeBuildSolverEnabled: false,
      scenarioWhatIfEnabled: false,
      buildExecutionV3Enabled: false,
      storageLayoutEnabled: false,
      priceHistoryEnabled: false,
      priceTargetsEnabled: false,
      durableJobsEnabled: false,
      portabilityEnabled: false,
      backupRestoreEnabled: false,
      doctorRepairEnabled: false,
    });
  });

  it("enables each universal-platform rollout surface independently", async () => {
    const flags = await loadRuntimeFlags({
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_FACT_GRAPH_ENABLED: "1",
      BUILD_SIM_USER_OBSERVATIONS_ENABLED: "yes",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "on",
      BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
      BUILD_SIM_WHOLE_BUILD_SOLVER_ENABLED: "true",
      BUILD_SIM_SCENARIO_WHAT_IF_ENABLED: "true",
      BUILD_SIM_BUILD_EXECUTION_V3_ENABLED: "true",
      BUILD_SIM_STORAGE_LAYOUT_ENABLED: "true",
      BUILD_SIM_PRICE_HISTORY_ENABLED: "true",
      BUILD_SIM_PRICE_TARGETS_ENABLED: "true",
      BUILD_SIM_DURABLE_JOBS_ENABLED: "true",
      BUILD_SIM_PORTABILITY_ENABLED: "true",
      BUILD_SIM_BACKUP_RESTORE_ENABLED: "true",
      BUILD_SIM_DOCTOR_REPAIR_ENABLED: "true",
    });

    expect(flags).toMatchObject({
      topologyV3Enabled: true,
      factGraphEnabled: true,
      userObservationsEnabled: true,
      genericAdaptersEnabled: true,
      progressiveEvaluationEnabled: true,
      wholeBuildSolverEnabled: true,
      scenarioWhatIfEnabled: true,
      buildExecutionV3Enabled: true,
      storageLayoutEnabled: true,
      priceHistoryEnabled: true,
      priceTargetsEnabled: true,
      durableJobsEnabled: true,
      portabilityEnabled: true,
      backupRestoreEnabled: true,
      doctorRepairEnabled: true,
    });
  });

  it("rejects malformed rollout flag values", async () => {
    await expect(loadRuntimeFlags({ BUILD_SIM_TOPOLOGY_V3_ENABLED: "sometimes" })).rejects.toThrow(/must be true or false/);
  });

  it("writes through a temporary file and records an old-value rollback", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "build-sim-g0-"));
    const target = path.join(dir, "catalog.json");
    const first = { schemaVersion: "1.0.0", value: "old" };
    const second = { schemaVersion: "1.0.0", value: "new" };
    const rollbackRoot = path.join(dir, "rollback");
    await atomicWriteJson(target, first, { rollbackRoot, manifestPath: path.join(rollbackRoot, "manifest.json") });
    await atomicWriteJson(target, second, { rollbackRoot, manifestPath: path.join(rollbackRoot, "manifest.json") });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(second);
    expect((await readFile(target, "utf8"))).not.toContain(".tmp");
  });

  it("restores the pre-migration config through the rollback manifest", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "build-sim-g2-rollback-"));
    const target = path.join(dir, "config.json");
    const manifest = path.join(dir, "rollback", "manifest.json");
    await atomicWriteJson(target, { schemaVersion: "1.0.0", diskCount: 1 }, { rollbackRoot: path.join(dir, "rollback"), manifestPath: manifest });
    await atomicWriteJson(target, { schemaVersion: "2.0.0", diskCount: 2 }, { operation: "config-migration", rollbackRoot: path.join(dir, "rollback"), manifestPath: manifest });
    await restoreLatestRollback(target, { manifestPath: manifest });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ schemaVersion: "1.0.0", diskCount: 1 });
  });
});
