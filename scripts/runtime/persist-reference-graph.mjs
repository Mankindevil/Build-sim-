#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { persistProductionReferenceGraph } from "../../src/runtime/production-reference-graph.mjs";

export function resolveRuntimeRoot(args, environment = process.env, cwd = process.cwd()) {
  const rootIndex = args.indexOf("--runtime-root");
  if (rootIndex >= 0 && !args[rootIndex + 1]) throw new Error("--runtime-root requires a value");
  return path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : environment.RUNTIME_ROOT ?? path.join(cwd, "runtime"));
}

export async function persistReferenceGraphCli(args, options = {}) {
  const runtimeRoot = resolveRuntimeRoot(args, options.environment, options.cwd);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
  await coordinator.initialize();
  const graph = await persistProductionReferenceGraph({ coordinator, now: options.now });
  return {
    ok: true,
    runtimeGeneration: graph.runtimeGeneration,
    runtimeRevision: graph.runtimeRevision,
    graphHash: graph.graphHash,
  };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  persistReferenceGraphCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "reference graph persistence failed" })}\n`);
    process.exitCode = 1;
  });
}
