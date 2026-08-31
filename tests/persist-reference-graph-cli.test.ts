import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { persistReferenceGraphCli, resolveRuntimeRoot } from "../scripts/runtime/persist-reference-graph.mjs";

describe("persist reference graph CLI", () => {
  it("requires a value after --runtime-root", () => {
    expect(() => resolveRuntimeRoot(["--runtime-root"])).toThrow("--runtime-root requires a value");
  });

  it("persists a graph bound to the committed runtime revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-reference-graph-cli-"));
    const result = await persistReferenceGraphCli(["--runtime-root", root], {
      now: () => "2026-08-31T05:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.runtimeGeneration).toBe(1);
    expect(result.runtimeRevision).toBe(1);
    expect(result.graphHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
