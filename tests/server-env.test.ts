import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boolEnv, intEnv, loadEnv } from "../scripts/price-server/env.mjs";

describe("server env precedence", () => {
  it("merges each key as process > local > env > example", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-env-"));
    await writeFile(path.join(root, ".env.example"), "SHARED=example\nEXAMPLE_ONLY=example\nEMPTY_VALUE=example\n", "utf8");
    await writeFile(path.join(root, ".env"), "SHARED=env\nENV_ONLY=env\n", "utf8");
    await writeFile(path.join(root, ".env.local"), "SHARED=local\nLOCAL_ONLY=local\n", "utf8");

    const withoutProcessValue = await loadEnv({ rootDir: root, processEnv: { PROCESS_ONLY: "process" } });
    expect(withoutProcessValue).toMatchObject({
      SHARED: "local",
      EXAMPLE_ONLY: "example",
      ENV_ONLY: "env",
      LOCAL_ONLY: "local",
      PROCESS_ONLY: "process",
    });

    const withProcessValue = await loadEnv({ rootDir: root, processEnv: { SHARED: "process", EMPTY_VALUE: "" } });
    expect(withProcessValue.SHARED).toBe("process");
    expect(withProcessValue.EMPTY_VALUE).toBe("");
  });

  it("validates bounded integers and booleans", () => {
    expect(intEnv({ LIMIT: "5" }, "LIMIT", 3, { min: 1, max: 10 })).toBe(5);
    expect(() => intEnv({ LIMIT: "11" }, "LIMIT", 3, { min: 1, max: 10 })).toThrow(/LIMIT/);
    expect(boolEnv({ ENABLED: "yes" }, "ENABLED", false)).toBe(true);
    expect(() => boolEnv({ ENABLED: "maybe" }, "ENABLED", false)).toThrow(/ENABLED/);
  });
});
