#!/usr/bin/env node
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";

try {
  const args = process.argv.slice(2);
  if (args.includes("--repair")) throw new Error("repair is disabled; submit a version-bound approved RepairPlan through the repair executor");
  const rootIndex = args.indexOf("--runtime-root");
  const runtimeRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  if (!runtimeRoot) throw new Error("--runtime-root is required");
  const result = await runDoctor({ coordinator: new RuntimeCoordinator({ root: runtimeRoot }), strict: args.includes("--strict"), offline: args.includes("--offline") });
  process.stdout.write(`${JSON.stringify(result.report)}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "Doctor failed" })}\n`);
  process.exitCode = 2;
}
