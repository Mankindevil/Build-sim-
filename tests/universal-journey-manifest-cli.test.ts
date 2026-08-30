import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUniversalJourneyManifestCli } from "../scripts/release/create-universal-journey-evidence";
import type { UniversalJourneyEvidenceMaterial } from "../src/release/universal-journey";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function material(): UniversalJourneyEvidenceMaterial {
  const hash = (digit: string) => digit.repeat(64);
  const plan = (planId: string, planVersionId: string) => ({
    planId, planVersionId, configHash: hash("a"), evaluationHash: hash("b"), evaluationLockHash: hash("c"), factSnapshotHash: hash("d"),
  });
  const job = (digit: string) => `job-${hash(digit)}`;
  return {
    schemaVersion: "universal-journey-evidence-v1",
    runtimeGeneration: 2,
    createdAt: "2026-08-30T14:30:00.000Z",
    stageB: {
      plan: plan("plan-stage-b", "version-stage-b"),
      solverJobId: job("1"),
      recommendationSetRef: `sha256:${hash("2")}`,
      executionSessionId: "execution-stage-b",
      nasPlan: plan("plan-stage-b-nas", "version-stage-b-nas"),
    },
    journey: {
      blankPlan: plan("plan-journey", "version-blank"),
      acceptedPlan: plan("plan-journey", "version-accepted"),
      feasibleSolverJobId: job("3"),
      unsatSolverJobId: job("4"),
      scenarios: { case: "scenario-case", system: "scenario-system", storage: "scenario-storage", nas: "scenario-nas" },
      provisionalCase: {
        planId: "plan-journey", caseInstanceId: "case-new", candidateId: `provisional-case-adapter-sha256-${hash("5")}`,
        registryRef: `sha256:${hash("6")}`, skuId: "case.new", region: "CN", revision: "rev-a",
      },
      priceTargetIds: ["target-one"],
      recoveryJobs: [
        { role: "evidence_download", jobId: job("7"), expectedType: "evidence.pipeline" },
        { role: "ocr", jobId: job("8"), expectedType: "evidence.pipeline" },
        { role: "solver", jobId: job("9"), expectedType: "solver.whole-build" },
        { role: "price_recheck", jobId: job("a"), expectedType: "price.target-recheck" },
        { role: "adapter_generation", jobId: job("b"), expectedType: "evidence.pipeline" },
      ],
    },
  };
}

describe("universal journey manifest CLI", () => {
  it("creates a deterministic private content-addressed manifest only at an explicit output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-journey-manifest-cli-")); roots.push(root);
    const input = path.join(root, "material.json");
    const output = path.join(root, "review", "universal-journey.json");
    await writeFile(input, `${JSON.stringify(material(), null, 2)}\n`, { mode: 0o600 });
    const preview = await runUniversalJourneyManifestCli(["--input", input]);
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    const written = await runUniversalJourneyManifestCli(["--input", input, "--output", output]);
    expect(written).toEqual(preview);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(preview);
    expect((await lstat(output)).mode & 0o777).toBe(0o600);
    await expect(runUniversalJourneyManifestCli(["--input", input, "--output", output])).rejects.toThrow(/already exists/);
    await expect(runUniversalJourneyManifestCli(["--input", input, "--output", input, "--replace"])).rejects.toThrow(/must differ/);
    await expect(runUniversalJourneyManifestCli(["--input", input, "--output", output, "--replace"])).resolves.toEqual(preview);
  });

  it("rejects a pre-hashed, unknown-field, symlink or duplicated argument input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-journey-manifest-invalid-")); roots.push(root);
    const input = path.join(root, "material.json");
    await writeFile(input, `${JSON.stringify({ ...material(), passed: true })}\n`, { mode: 0o600 });
    await expect(runUniversalJourneyManifestCli(["--input", input])).rejects.toThrow(/fields are invalid/);
    await writeFile(input, `${JSON.stringify({ ...material(), contentHash: "a".repeat(64) })}\n`, { mode: 0o600 });
    await expect(runUniversalJourneyManifestCli(["--input", input])).rejects.toThrow(/unhashed material/);
    const linked = path.join(root, "linked.json");
    await symlink(input, linked);
    await expect(runUniversalJourneyManifestCli(["--input", linked])).rejects.toThrow(/bounded regular file/);
    await expect(runUniversalJourneyManifestCli(["--input", input, "--input", input])).rejects.toThrow(/only be provided once/);
    await expect(runUniversalJourneyManifestCli(["--input", input, "--replace"])).rejects.toThrow(/requires --output/);
  });
});
