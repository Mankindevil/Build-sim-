import { describe, expect, it } from "vitest";
import type { SnapshotHashes } from "../src/hash";
import {
  validateCandidatePromotion,
  validateCandidatePromotionAuthoritatively,
  validateSolveRequest,
  validateSolveResult,
  validateSolverCandidate,
  PURCHASE_ELIGIBILITY_POLICY,
  type CandidatePromotionRecord,
  type DomainCoverage,
  type GovernedPurchaseEligibilityContext,
  type SolverCandidate,
} from "../src/solver/contracts";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";

const digest = (letter: string) => letter.repeat(64);
const hashes = (): SnapshotHashes => ({
  configHash: digest("a"), requirementSpecHash: digest("b"), factSnapshotHash: digest("c"), userObservationSnapshotHash: digest("d"), priceSnapshotHash: digest("e"),
  ruleSetHash: digest("f"), systemProfileHash: digest("0"), adapterSnapshotHash: digest("1"), engineHash: digest("2"), simulationModelHash: digest("3"), simulationInputHash: digest("4"),
});
const currentHashes = (): SnapshotHashes => ({ ...hashes(), configHash: digest("8") });
const coverage = (verdict: DomainCoverage["verdict"] = "pass"): DomainCoverage[] => PURCHASE_ELIGIBILITY_POLICY.requiredDomains.map((domain) => (
  { domain, verdict, domainHash: digest("5"), evaluationHash: digest("6"), requiredForPurchase: true }
));
const candidate = (domainCoverage = coverage()): SolverCandidate => ({
  candidateId: "candidate", requirementSpecId: "spec", basePlanVersionId: "v1", baseConfigHash: digest("7"), candidateConfigRef: "config-ref", operationsRef: "operations-ref",
  buildConfigHash: digest("8"), inputHashes: currentHashes(), evaluationHash: digest("6"), candidateKind: "feasibility_candidate", domainCoverage, residualRequirementIds: [], excludedReasonIds: [],
});
const promotion = (): CandidatePromotionRecord => ({
  promotionRecordId: "promotion", candidateId: "candidate", candidateBuildConfigHash: digest("8"), revalidatedInputHashes: currentHashes(), coverageHash: digest("9"), outcome: "purchase_eligible", residualMustRequirementIds: [], createdAt: "2026-08-27T00:00:00.000Z",
});
const eligibilityContext = (overrides: Partial<GovernedPurchaseEligibilityContext> = {}): GovernedPurchaseEligibilityContext => ({
  policy: PURCHASE_ELIGIBILITY_POLICY,
  currentInputHashes: currentHashes(),
  coverage: coverage(),
  coverageHash: digest("9"),
  coverageArtifactRef: "evaluation/coverage",
  authoritativeEvaluation: {
    evaluationHash: digest("6"), evaluatorId: "universal-evaluator", evaluatorVersion: "1", evaluatorContractVersion: "build-evaluation-v1",
    evaluatorArtifactRef: "artifacts/evaluator", evaluatorArtifactHash: digest("a"),
  },
  hardRequirementClosure: {
    requirementSpecHash: currentHashes().requirementSpecHash, evaluationHash: digest("6"), closureArtifactRef: "evaluation/requirement-closure",
    closureArtifactHash: digest("b"), residualMustRequirementIds: [], unsatisfiedHardConstraintIds: [],
  },
  ...overrides,
});

describe("U0 solver boundary", () => {
  it("returns request contract errors for malformed imported input", () => {
    expect(validateSolveRequest(null)).toContain("solve request must be an object");
    expect(validateSolveRequest({})).toEqual(expect.arrayContaining(["baseConfigHash invalid", "solve limits must be an object", "lockedInstanceIds must be unique non-empty strings"]));
  });

  it("keeps solver output at feasibility_candidate and requires evaluator coverage", () => {
    expect(validateSolverCandidate(candidate())).toEqual([]);
    expect(validateSolverCandidate({ ...candidate(), candidateKind: "purchase_eligible" as never })).toContain("solver may only emit feasibility_candidate records");
    expect(validateSolverCandidate(candidate(coverage("blocked")))).toContain("failed or blocked purchase domain requires an exclusion reason");
  });

  it("promotes only current, fully passing, zero-must-residual candidates", () => {
    expect(validateCandidatePromotion(candidate(), promotion(), eligibilityContext())).toEqual([]);
    expect(validateCandidatePromotion(candidate(), { ...promotion(), residualMustRequirementIds: ["must-budget"] }, eligibilityContext())).toContain("promotion residual must requirements do not match authoritative closure");
    expect(validateCandidatePromotion(candidate(), promotion(), eligibilityContext({ coverage: coverage("fail") }))).toContain("purchase eligibility requires every governed purchase domain to pass");
    expect(validateCandidatePromotion(candidate(), promotion(), eligibilityContext({ currentInputHashes: { ...currentHashes(), priceSnapshotHash: digest("b") } }))).toContain("promotion input hashes are stale");
    expect(validateCandidatePromotion(candidate(), promotion(), eligibilityContext({ coverageHash: digest("0") }))).toContain("promotion coverage hash is stale or not bound to an authoritative artifact");
  });

  it("resolves promotion evidence through a server-issued resolver", async () => {
    const resolver = createAuthoritativeResolver("purchase-eligibility-context", (ref) => ref === "eligibility/candidate" ? eligibilityContext() : undefined);
    await expect(validateCandidatePromotionAuthoritatively(candidate(), promotion(), "eligibility/candidate", resolver)).resolves.toEqual([]);
    await expect(validateCandidatePromotionAuthoritatively(candidate(), promotion(), "missing", resolver)).resolves.toEqual([
      expect.stringContaining("promotion authoritative context resolution failed"),
    ]);
    await expect(validateCandidatePromotionAuthoritatively(candidate(), promotion(), "eligibility/candidate", eligibilityContext() as never)).resolves.toEqual([
      expect.stringContaining("resolver was not issued by the server composition root"),
    ]);
    const tampered = createAuthoritativeResolver("purchase-eligibility-context", () => eligibilityContext({ coverageHash: digest("0") }));
    await expect(validateCandidatePromotionAuthoritatively(candidate(), promotion(), "eligibility/candidate", tampered))
      .resolves.toContain("promotion coverage hash is stale or not bound to an authoritative artifact");
  });

  it("does not let a candidate self-select purchase domains or self-report hard closure", () => {
    expect(validateCandidatePromotion(candidate(), promotion(), eligibilityContext({ coverage: coverage().slice(0, 1) }))).toContain("purchase eligibility requires the complete governed domain set");
    expect(validateCandidatePromotion(candidate(), promotion(), eligibilityContext({
      hardRequirementClosure: { ...eligibilityContext().hardRequirementClosure, residualMustRequirementIds: ["must-workload"] },
    }))).toEqual(expect.arrayContaining([
      "promotion residual must requirements do not match authoritative closure",
      "purchase eligibility requires RequirementSpec hard closure with zero residuals",
    ]));
    expect(validateCandidatePromotion(candidate(), promotion(), { ...eligibilityContext(), policy: { ...PURCHASE_ELIGIBILITY_POLICY } } as never)).toContain("promotion requires the governed purchase eligibility policy context");
    expect(validateCandidatePromotion(candidate(), promotion(), eligibilityContext({
      authoritativeEvaluation: { ...eligibilityContext().authoritativeEvaluation, evaluatorArtifactHash: "caller-claimed" },
    }))).toContain("promotion authoritative evaluator artifact/version binding invalid");
  });

  it("rejects malformed or incomplete evaluator bindings", () => {
    expect(validateSolverCandidate({ ...candidate(), evaluationHash: "not-a-hash" })).toEqual(expect.arrayContaining(["evaluationHash invalid", "domain coverage must come from the candidate evaluation"]));
    expect(validateSolverCandidate(candidate([]))).toContain("candidate requires authoritative evaluator domain coverage");
  });

  it("reserves unsat_proven for exhaustive or formal proof", () => {
    const result = { status: "unsat_proven" as const, solverVersion: "1", seed: "fixed", effectiveLimits: { maxEvaluations: 10, maxDurationMs: 100, maxCandidatesPerRequirement: 2 }, explored: 10, pruned: 4, candidates: [], unsatisfiedHardConstraintIds: ["socket"], irreducibleConflictSets: [["socket", "locked-cpu"]], searchSummaryRef: "summary" };
    expect(validateSolveResult(result)).toContain("unsat_proven requires exhaustive or formal proof");
    expect(validateSolveResult(result, { kind: "exhaustive", exploredSearchSpaceHash: digest("a") })).toEqual([]);
    expect(validateSolveResult({ ...result, status: "blocked_inputs", candidates: [candidate()] }, undefined)).toContain("blocked_inputs cannot contain candidates built from guessed inputs");
  });
});
