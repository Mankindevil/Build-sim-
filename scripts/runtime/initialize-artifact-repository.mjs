#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileArtifactRepository } from "../../src/artifacts/repository.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { confined, listRegularFiles, pathExists } from "../../src/runtime/fs.mjs";
import { resolveRuntimeRoot } from "./persist-reference-graph.mjs";

export async function initializeArtifactRepositoryCli(args, options = {}) {
  const runtimeRoot = resolveRuntimeRoot(args, options.environment, options.cwd);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
  await coordinator.initialize();
  const written = await coordinator.withWrite(async ({ activeRoot }) => {
    const artifactRoot = confined(activeRoot, "artifacts");
    const manifest = confined(artifactRoot, "repository-manifest.json");
    if (await pathExists(manifest)) return { initialized: false };
    const existingFiles = await listRegularFiles(artifactRoot);
    if (existingFiles.length > 0) {
      throw new Error("artifact repository manifest is missing while repository files already exist");
    }
    await new FileArtifactRepository({ root: artifactRoot, now: options.now }).initialize();
    return { initialized: true };
  });
  return {
    ok: true,
    initialized: written.result.initialized,
    runtimeGeneration: written.state.runtimeGeneration,
    runtimeRevision: written.state.revision,
  };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  initializeArtifactRepositoryCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "artifact repository initialization failed" })}\n`);
    process.exitCode = 1;
  });
}
