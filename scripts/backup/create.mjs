#!/usr/bin/env node
import { createBackup } from "../../src/backup/runtime.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { persistProductionReferenceGraph } from "../../src/runtime/production-reference-graph.mjs";
import { fail, parseArguments, readPassword } from "./cli.mjs";

export async function runBackupCreateCli(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArguments(argv);
  if (!args["runtime-root"] || !args.output) throw new Error("--runtime-root and --output are required");
  const password = await readPassword(args, environment);
  const coordinator = new RuntimeCoordinator({ root: args["runtime-root"] });
  const createdAt = new Date().toISOString();
  const now = () => createdAt;
  const persistedGraph = await persistProductionReferenceGraph({ coordinator, now });
  const result = await createBackup({ coordinator, outputFile: args.output, password, mode: args.mode ?? "full_local_backup", portableProfile: args.profile, referenceGraph: persistedGraph, now });
  return { ok: true, backupId: result.manifest.backupId, manifestHash: result.manifest.manifestHash, runtimeGeneration: result.manifest.runtimeGeneration, referenceGraphHash: persistedGraph.graphHash };
}

if (import.meta.url === `file://${process.argv[1]}`) runBackupCreateCli().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(fail);
