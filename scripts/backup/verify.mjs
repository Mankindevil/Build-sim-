#!/usr/bin/env node
import { persistBackupVerification, verifyBackup } from "../../src/backup/runtime.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { persistProductionReferenceGraph } from "../../src/runtime/production-reference-graph.mjs";
import { fail, parseArguments, readPassword } from "./cli.mjs";

export async function runBackupVerifyCli(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArguments(argv);
  if (!args.input) throw new Error("--input is required");
  const result = await verifyBackup({ inputFile: args.input, password: await readPassword(args, environment) });
  let persisted = false;
  if (!args["no-persist"]) {
    const runtimeRoot = args["runtime-root"] ?? environment.RUNTIME_ROOT;
    if (!runtimeRoot) throw new Error("--runtime-root is required unless --no-persist is explicit");
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
    await persistBackupVerification({ coordinator, verification: result });
    await persistProductionReferenceGraph({ coordinator });
    persisted = true;
  }
  return { ok: result.valid, persisted, report: result.report };
}

if (import.meta.url === `file://${process.argv[1]}`) runBackupVerifyCli().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(fail);
