#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import {
  FRESH_GOVERNED_REBUILD_CONFIRMATION,
  applyFreshGovernedRebuildPlan,
  createFreshGovernedRebuildPlan,
  readFreshGovernedRebuildPlan,
  writeFreshGovernedRebuildPlan,
} from "../../src/runtime/fresh-governed-rebuild.mjs";
import { readPassword } from "../backup/cli.mjs";

function parse(argv) {
  const values = new Map();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (apply) throw new TypeError("--apply may only be provided once");
      apply = true;
      continue;
    }
    if (!["--runtime-root", "--output", "--plan", "--expected-plan-hash", "--backup-output", "--password-file", "--confirmation"].includes(argument)) {
      throw new TypeError(`unknown fresh rebuild argument: ${argument}`);
    }
    if (values.has(argument)) throw new TypeError(`${argument} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  const runtimeRoot = values.get("--runtime-root");
  if (!runtimeRoot) throw new TypeError("--runtime-root is required");
  if (!apply) {
    if ([...values.keys()].some((key) => !["--runtime-root", "--output"].includes(key))) {
      throw new TypeError("plan mode accepts only --runtime-root and optional --output");
    }
    return { mode: "plan", runtimeRoot: path.resolve(runtimeRoot), ...(values.get("--output") ? { output: path.resolve(values.get("--output")) } : {}) };
  }
  for (const required of ["--plan", "--expected-plan-hash", "--backup-output", "--confirmation"]) {
    if (!values.get(required)) throw new TypeError(`apply requires ${required}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(values.get("--expected-plan-hash"))) throw new TypeError("--expected-plan-hash is invalid");
  return {
    mode: "apply",
    runtimeRoot: path.resolve(runtimeRoot),
    plan: path.resolve(values.get("--plan")),
    expectedPlanHash: values.get("--expected-plan-hash"),
    backupOutput: path.resolve(values.get("--backup-output")),
    confirmation: values.get("--confirmation"),
    ...(values.get("--password-file") ? { passwordFile: path.resolve(values.get("--password-file")) } : {}),
  };
}

export async function runFreshGovernedRebuildCli(argv = process.argv.slice(2), environment = process.env, options = {}) {
  const input = parse(argv);
  const coordinator = new RuntimeCoordinator({ root: input.runtimeRoot, ...(options.now ? { now: options.now } : {}) });
  if (input.mode === "plan") {
    const plan = await createFreshGovernedRebuildPlan({ coordinator, ...(options.now ? { now: options.now } : {}) });
    if (input.output) await writeFreshGovernedRebuildPlan(input.output, plan, input.runtimeRoot);
    return {
      schemaVersion: "fresh-governed-rebuild-cli-result-v1",
      mode: "plan",
      planHash: plan.contentHash,
      sourceRuntimeGeneration: plan.sourceRuntimeGeneration,
      sourceRuntimeRevision: plan.sourceRuntimeRevision,
      legacyDisposition: plan.legacyDisposition,
      written: Boolean(input.output),
    };
  }
  if (input.confirmation !== FRESH_GOVERNED_REBUILD_CONFIRMATION) throw new TypeError("fresh governed rebuild apply confirmation is invalid");
  const plan = await readFreshGovernedRebuildPlan(input.plan);
  const passwordArgs = input.passwordFile ? { "password-file": input.passwordFile } : {};
  return applyFreshGovernedRebuildPlan({
    coordinator,
    plan,
    expectedPlanHash: input.expectedPlanHash,
    backupOutput: input.backupOutput,
    password: await readPassword(passwordArgs, environment),
    confirmation: input.confirmation,
    ...(options.now ? { now: options.now } : {}),
    ...(options.beforePointerSwitch ? { beforePointerSwitch: options.beforePointerSwitch } : {}),
  });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFreshGovernedRebuildCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "fresh governed rebuild failed"}\n`);
    process.exitCode = 1;
  });
}
