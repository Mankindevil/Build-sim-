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
    });
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
