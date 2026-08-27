#!/usr/bin/env node
import { restoreBackup } from "../../src/backup/runtime.mjs";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { fail, parseArguments, readPassword } from "./cli.mjs";

try {
  const args = parseArguments(process.argv.slice(2));
  if (!args["runtime-root"] || !args.input) throw new Error("--runtime-root and --input are required");
  const coordinator = new RuntimeCoordinator({ root: args["runtime-root"] });
  const result = await restoreBackup({ coordinator, inputFile: args.input, password: await readPassword(args) });
  process.stdout.write(`${JSON.stringify({ ok: true, runtimeGeneration: result.state.runtimeGeneration })}\n`);
} catch (error) { fail(error); }
