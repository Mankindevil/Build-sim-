import { describe, expect, it } from "vitest";
import { createCandidatePromotionRecord } from "../src/recommendation/policy";
import { PURCHASE_ELIGIBILITY_POLICY, type GovernedPurchaseEligibilityContext, type SolverCandidate } from "../src/solver/contracts";
import type { SnapshotHashes } from "../src/hash";

const h = "b".repeat(64);
const hashes: SnapshotHashes = { configHash: h, requirementSpecHash: h, factSnapshotHash: h, userObservationSnapshotHash: h, priceSnapshotHash: h, ruleSetHash: h, systemProfileHash: h, adapterSnapshotHash: h, engineHash: h, simulationModelHash: h, simulationInputHash: h };
const candidate = (): SolverCandidate => ({ candidateId: "candidate", requirementSpecId: "requirements", basePlanVersionId: "version", baseConfigHash: h, candidateConfigRef: "config", operationsRef: "ops", buildConfigHash: h, inputHashes: hashes, evaluationHash: h, candidateKind: "feasibility_candidate", domainCoverage: PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map((domain) => ({ domain, verdict: "pass", domainHash: h, evaluationHash: h, requiredForPurchase: true })), residualRequirementIds: [], excludedReasonIds: [] });
const context = (): GovernedPurchaseEligibilityContext => ({ policy: PURCHASE_ELIGIBILITY_POLICY, currentInputHashes: hashes, coverage: candidate().domainCoverage, coverageHash: h, coverageArtifactRef: "coverage", authoritativeEvaluation: { evaluationHash: h, evaluatorId: "evaluator", evaluatorVersion: "1", evaluatorContractVersion: "build-evaluation-v1", evaluatorArtifactRef: "artifact", evaluatorArtifactHash: h }, hardRequirementClosure: { requirementSpecHash: h, evaluationHash: h, closureArtifactRef: "closure", closureArtifactHash: h, residualMustRequirementIds: [], unsatisfiedHardConstraintIds: [] } });

describe("U10 late-domain candidate promotion", () => {
  it("promotes only the complete current domain set with zero residual must requirements", async () => {
    await expect(createCandidatePromotionRecord({ candidate: candidate(), context: context(), createdAt: "2026-08-29T00:00:00.000Z" })).resolves.toMatchObject({ outcome: "purchase_eligible", residualMustRequirementIds: [] });
  });

  it("records exclusion when a late required domain no longer passes", async () => {
    const failed = context();
    failed.coverage = failed.coverage.map((coverage) => coverage.domain === "acoustic" ? { ...coverage, verdict: "blocked" as const } : coverage);
    const result = await createCandidatePromotionRecord({ candidate: candidate(), context: failed, createdAt: "2026-08-29T00:00:00.000Z" });
    expect(result.outcome).toBe("excluded");
  });
});
