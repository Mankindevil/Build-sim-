import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { initializeArtifactRepositoryCli } from "../scripts/runtime/initialize-artifact-repository.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

describe("initialize artifact repository CLI", () => {
  it("creates the governed empty repository once and then replays idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-artifact-init-cli-"));
    const now = () => "2026-08-31T05:00:00.000Z";
    const first = await initializeArtifactRepositoryCli(["--runtime-root", root], { now });
    const second = await initializeArtifactRepositoryCli(["--runtime-root", root], { now });
    const coordinator = new RuntimeCoordinator({ root });
    const inspection = await (await coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => (
      new FileArtifactRepository({ root: path.join(activeRoot, "artifacts") }).inspect()
    ))).result;

    expect(first.initialized).toBe(true);
    expect(second.initialized).toBe(false);
    expect(inspection.ok).toBe(true);
  });

  it("refuses to cover existing files with a fresh empty manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-artifact-init-cli-"));
    const coordinator = new RuntimeCoordinator({ root });
    await coordinator.initialize();
    const state = await coordinator.readState();
    const artifacts = path.join(coordinator.activeRoot(state), "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "orphan.bin"), "not governed");

    await expect(initializeArtifactRepositoryCli(["--runtime-root", root])).rejects.toThrow(
      "artifact repository manifest is missing while repository files already exist",
    );
  });
});
