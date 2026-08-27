#!/usr/bin/env node
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { runArtifactGc } from "../src/runtime/gc.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";

try {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const runtimeRoot = value("--runtime-root");
  if (!runtimeRoot) throw new Error("--runtime-root is required");
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
  const repository = new FileArtifactRepository({ coordinator });
  const referenceGraph = await createProductionReferenceGraph({ coordinator });
  const result = await runArtifactGc({
    repository, referenceGraph, dryRun: !args.includes("--apply"),
    quotaBytes: value("--quota-bytes") === undefined ? Number.POSITIVE_INFINITY : Number(value("--quota-bytes")),
    retentionMs: value("--retention-ms") === undefined ? 30 * 24 * 60 * 60 * 1000 : Number(value("--retention-ms")),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "runtime GC failed" })}\n`);
  process.exitCode = 1;
}
