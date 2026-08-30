import { describe, expect, it } from "vitest";
import {
  createUniversalJourneyEvidenceManifest,
  validateUniversalJourneyEvidenceManifest,
  type UniversalJourneyEvidenceMaterial,
} from "../src/release/universal-journey";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function plan(planId: string, planVersionId: string) {
  return {
    planId,
    planVersionId,
    configHash: HASH,
    evaluationHash: OTHER_HASH,
    evaluationLockHash: "c".repeat(64),
    factSnapshotHash: "d".repeat(64),
  };
}

function material(): UniversalJourneyEvidenceMaterial {
  const job = (digit: string) => `job-${digit.repeat(64)}`;
  return {
    schemaVersion: "universal-journey-evidence-v1",
    runtimeGeneration: 3,
    createdAt: "2026-08-30T13:00:00.000Z",
    stageB: {
      plan: plan("plan-stage-b", "version-stage-b"),
      solverJobId: job("1"),
      recommendationSetRef: `sha256:${"2".repeat(64)}`,
      executionSessionId: "execution-stage-b",
      nasPlan: plan("plan-stage-b-nas", "version-stage-b-nas"),
    },
    journey: {
      blankPlan: plan("plan-cross-product", "version-blank"),
      acceptedPlan: plan("plan-cross-product", "version-accepted"),
      feasibleSolverJobId: job("3"),
      unsatSolverJobId: job("4"),
      scenarios: {
        case: "scenario-case",
        system: "scenario-system",
        storage: "scenario-storage",
        nas: "scenario-nas",
      },
      provisionalCase: {
        planId: "plan-cross-product",
        caseInstanceId: "case-runtime-discovered",
        candidateId: `provisional-case-adapter-sha256-${"5".repeat(64)}`,
        registryRef: `sha256:${"6".repeat(64)}`,
        skuId: "case.runtime-discovered",
        region: "CN",
        revision: "rev-a",
      },
      priceTargetIds: ["price-target-cpu", "price-target-case"],
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

describe("universal journey evidence manifest", () => {
  it("content-addresses only server-owned journey identities and exact hashes", async () => {
    const manifest = await createUniversalJourneyEvidenceManifest(material());
    await expect(validateUniversalJourneyEvidenceManifest(manifest)).resolves.toEqual([]);
    expect(manifest.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain("status\":\"pass");
  });

  it("rejects unknown fields and a checksum-correct-looking mutation", async () => {
    const manifest = await createUniversalJourneyEvidenceManifest(material());
    const changed = structuredClone(manifest) as typeof manifest & { passed?: boolean };
    changed.passed = true;
    await expect(validateUniversalJourneyEvidenceManifest(changed)).resolves.toContain("universal journey evidence fields are invalid");

    const stale = structuredClone(manifest);
    stale.journey.acceptedPlan.configHash = "f".repeat(64);
    await expect(validateUniversalJourneyEvidenceManifest(stale)).resolves.toContain("universal journey evidence contentHash mismatch");
  });

  it("requires distinct scenarios, both solver outcomes, every recovery role, and plan-scoped provisional evidence", async () => {
    const duplicate = material();
    duplicate.journey.scenarios.system = duplicate.journey.scenarios.case;
    duplicate.journey.unsatSolverJobId = duplicate.journey.feasibleSolverJobId;
    duplicate.journey.provisionalCase.planId = "plan-foreign";
    duplicate.journey.recoveryJobs[4] = { ...duplicate.journey.recoveryJobs[3]! };
    const manifest = await createUniversalJourneyEvidenceManifest(duplicate);
    await expect(validateUniversalJourneyEvidenceManifest(manifest)).resolves.toEqual(expect.arrayContaining([
      "journey scenario identities must be unique",
      "journey solver job IDs must be distinct",
      "journey provisional case must belong to the accepted plan",
      "journey recovery job roles are incomplete or duplicated",
      "journey recovery job IDs must be unique",
    ]));
  });

  it("requires the blank and accepted versions to belong to one plan", async () => {
    const value = material();
    value.journey.acceptedPlan.planId = "plan-other";
    value.journey.provisionalCase.planId = "plan-other";
    await expect(validateUniversalJourneyEvidenceManifest(
      await createUniversalJourneyEvidenceManifest(value),
    )).resolves.toContain("journey blank and accepted versions must be distinct versions of one plan");
  });
});
