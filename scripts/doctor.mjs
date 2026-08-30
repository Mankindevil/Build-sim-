#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { probeProductionDoctorCapabilities } from "../src/doctor/production-probes.mjs";

export function resolveDoctorRuntimeRoot(args, environment = process.env, cwd = process.cwd()) {
  const rootIndex = args.indexOf("--runtime-root");
  if (rootIndex >= 0 && !args[rootIndex + 1]) throw new Error("--runtime-root requires a value");
  return path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : environment.RUNTIME_ROOT ?? path.join(cwd, "runtime"));
}

export async function executeDoctorCli(args, options = {}) {
  if (args.includes("--repair")) throw new Error("repair is disabled; submit a version-bound approved RepairPlan through the repair executor");
  const environment = options.environment ?? process.env;
  const runtimeRoot = resolveDoctorRuntimeRoot(args, environment, options.cwd ?? process.cwd());
  const offline = args.includes("--offline");
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
  const probes = await (options.probeCapabilities ?? probeProductionDoctorCapabilities)({ coordinator, environment, offline });
  return runDoctor({ coordinator, strict: args.includes("--strict"), offline, ...probes });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await executeDoctorCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "Doctor failed" })}\n`);
    process.exitCode = 2;
  }
}
