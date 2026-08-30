#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION,
  OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION,
  applyOwnershipBootstrapPlan,
  createOwnershipBootstrapPlan,
  readOwnershipBootstrapPlan,
  readOwnershipBootstrapRollback,
  rollbackOwnershipBootstrap,
  writeOwnershipBootstrapArtifact,
} from "../../src/runtime/ownership-bootstrap.mjs";

function parseInteger(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) throw new TypeError(`${label} must be a non-root integer identity`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0xffff_ffff) throw new TypeError(`${label} is outside the supported identity range`);
  return parsed;
}

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--apply", "--rollback"].includes(argument)) {
      if (flags.has(argument)) throw new TypeError(`${argument} may only be provided once`);
      flags.add(argument);
      continue;
    }
    if (!["--runtime-root", "--uid", "--gid", "--output", "--plan", "--rollback-output", "--manifest", "--confirmation", "--expected-plan-hash", "--expected-rollback-hash"].includes(argument)) {
      throw new TypeError(`unknown ownership bootstrap argument: ${argument}`);
    }
    if (values.has(argument)) throw new TypeError(`${argument} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  if (flags.has("--apply") && flags.has("--rollback")) throw new TypeError("ownership bootstrap cannot apply and rollback together");
  const runtimeRoot = values.get("--runtime-root");
  if (!runtimeRoot) throw new TypeError("--runtime-root is required");
  if (flags.has("--apply")) {
    const plan = values.get("--plan");
    const rollbackOutput = values.get("--rollback-output");
    const confirmation = values.get("--confirmation");
    const expectedPlanHash = values.get("--expected-plan-hash");
    if (!plan || !rollbackOutput || !confirmation || !expectedPlanHash || !/^[a-f0-9]{64}$/u.test(expectedPlanHash) || values.size !== 5) {
      throw new TypeError("apply requires only --runtime-root, --plan, --expected-plan-hash, --rollback-output and --confirmation");
    }
    return { mode: "apply", runtimeRoot: path.resolve(runtimeRoot), plan: path.resolve(plan), expectedPlanHash, rollbackOutput: path.resolve(rollbackOutput), confirmation };
  }
  if (flags.has("--rollback")) {
    const plan = values.get("--plan");
    const manifest = values.get("--manifest");
    const confirmation = values.get("--confirmation");
    const expectedPlanHash = values.get("--expected-plan-hash");
    const expectedRollbackHash = values.get("--expected-rollback-hash");
    if (!plan || !manifest || !confirmation || !expectedPlanHash || !expectedRollbackHash
      || !/^[a-f0-9]{64}$/u.test(expectedPlanHash) || !/^[a-f0-9]{64}$/u.test(expectedRollbackHash) || values.size !== 6) {
      throw new TypeError("rollback requires only --runtime-root, --plan, --expected-plan-hash, --manifest, --expected-rollback-hash and --confirmation");
    }
    return { mode: "rollback", runtimeRoot: path.resolve(runtimeRoot), plan: path.resolve(plan), expectedPlanHash, manifest: path.resolve(manifest), expectedRollbackHash, confirmation };
  }
  const uid = values.get("--uid");
  const gid = values.get("--gid");
  if (!uid || !gid || [...values.keys()].some((key) => !["--runtime-root", "--uid", "--gid", "--output"].includes(key))) {
    throw new TypeError("plan mode requires only --runtime-root, --uid, --gid and optional --output");
  }
  return {
    mode: "plan",
    runtimeRoot: path.resolve(runtimeRoot),
    targetUid: parseInteger(uid, "--uid"),
    targetGid: parseInteger(gid, "--gid"),
    ...(values.get("--output") ? { output: path.resolve(values.get("--output")) } : {}),
  };
}

export async function runOwnershipBootstrapCli(argv = process.argv.slice(2), options = {}) {
  const input = parseArguments(argv);
  if (input.mode === "plan") {
    const plan = await createOwnershipBootstrapPlan({
      runtimeRoot: input.runtimeRoot,
      targetUid: input.targetUid,
      targetGid: input.targetGid,
      ...(options.now ? { now: options.now } : {}),
    });
    if (input.output) await writeOwnershipBootstrapArtifact(input.output, plan, input.runtimeRoot);
    return {
      schemaVersion: "runtime-ownership-bootstrap-cli-result-v1",
      mode: "plan",
      planHash: plan.contentHash,
      runtimeGeneration: plan.runtimeGeneration,
      targetCount: plan.targets.length,
      ownershipChangeTargetCount: plan.targets.filter(({ ownershipChangeRequired }) => ownershipChangeRequired).length,
      written: Boolean(input.output),
    };
  }
  if (input.mode === "apply") {
    if (input.confirmation !== OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION) throw new TypeError("ownership bootstrap apply confirmation is invalid");
    const plan = await readOwnershipBootstrapPlan(input.plan);
    return applyOwnershipBootstrapPlan({
      runtimeRoot: input.runtimeRoot,
      plan,
      expectedPlanHash: input.expectedPlanHash,
      rollbackOutput: input.rollbackOutput,
      confirmation: input.confirmation,
      ...(options.now ? { now: options.now } : {}),
      ...(options.requirePrivileged === false ? { requirePrivileged: false } : {}),
      ...(options.ownershipWriter ? { ownershipWriter: options.ownershipWriter } : {}),
    });
  }
  if (input.confirmation !== OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION) throw new TypeError("ownership bootstrap rollback confirmation is invalid");
  const plan = await readOwnershipBootstrapPlan(input.plan);
  const rollback = await readOwnershipBootstrapRollback(input.manifest);
  return rollbackOwnershipBootstrap({
    runtimeRoot: input.runtimeRoot,
    plan,
    expectedPlanHash: input.expectedPlanHash,
    rollback,
    expectedRollbackHash: input.expectedRollbackHash,
    confirmation: input.confirmation,
    ...(options.requirePrivileged === false ? { requirePrivileged: false } : {}),
    ...(options.ownershipWriter ? { ownershipWriter: options.ownershipWriter } : {}),
  });
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runOwnershipBootstrapCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : "runtime ownership bootstrap failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
