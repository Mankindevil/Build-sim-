import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import type { BuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

function progressive(runtimeRoot: string) {
  return {
    RUNTIME_ROOT: runtimeRoot,
    BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
    BUILD_SIM_FACT_GRAPH_ENABLED: "true",
    BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
    BUILD_SIM_PROGRESSIVE_EVALUATION_ENABLED: "true",
    BUILD_SIM_SYSTEM_PROFILES_ENABLED: "true",
  };
}

describe("production rollout composition", () => {
  it("creates portability only when its dedicated switch and backup authority are both enabled", async () => {
    const disabled = createWorkspaceRepositories({
      RUNTIME_ROOT: await root("buildsim-portability-gate-off-"),
      BUILD_SIM_BACKUP_RESTORE_ENABLED: "true",
      BUILD_SIM_PORTABILITY_ENABLED: "false",
    });
    expect(disabled.operations).toBeDefined();
    expect(disabled.portability).toBeUndefined();

    const enabled = createWorkspaceRepositories({
      RUNTIME_ROOT: await root("buildsim-portability-gate-on-"),
      BUILD_SIM_BACKUP_RESTORE_ENABLED: "true",
      BUILD_SIM_PORTABILITY_ENABLED: "true",
    });
    expect(enabled.portability).toBeDefined();

    expect(() => createWorkspaceRepositories({
      RUNTIME_ROOT: path.join(os.tmpdir(), "buildsim-portability-invalid"),
      BUILD_SIM_BACKUP_RESTORE_ENABLED: "false",
      BUILD_SIM_PORTABILITY_ENABLED: "true",
    })).toThrow(/portability requires backup and restore/);
  });

  it("keeps build execution and storage layout behind their independent dependency-checked switches", async () => {
    const disabled = createWorkspaceRepositories<BuildConfigV3>(progressive(await root("buildsim-execution-gate-off-")));
    expect(disabled.systemExecution).toBeUndefined();

    const buildOnly = createWorkspaceRepositories<BuildConfigV3>({
      ...progressive(await root("buildsim-execution-gate-on-")),
      BUILD_SIM_BUILD_EXECUTION_V3_ENABLED: "true",
      BUILD_SIM_STORAGE_LAYOUT_ENABLED: "false",
    });
    expect(buildOnly.systemExecution).toBeDefined();

    expect(() => createWorkspaceRepositories<BuildConfigV3>({
      ...progressive(path.join(os.tmpdir(), "buildsim-storage-invalid")),
      BUILD_SIM_BUILD_EXECUTION_V3_ENABLED: "false",
      BUILD_SIM_STORAGE_LAYOUT_ENABLED: "true",
    })).toThrow(/storage layout requires build execution V3/);
  });

  it("rejects observation activation without topology and fact authorities", async () => {
    expect(() => createWorkspaceRepositories({
      RUNTIME_ROOT: path.join(os.tmpdir(), "buildsim-observation-invalid"),
      BUILD_SIM_USER_OBSERVATIONS_ENABLED: "true",
    })).toThrow(/user observations require topology V3 and fact graph/);
  });
});
