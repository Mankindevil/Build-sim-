import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeCoordinator } from "../../src/runtime/coordinator.mjs";
import { FileArtifactRepository } from "../../src/artifacts/repository.mjs";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../../src/topology/contracts";
import { configV3Hash } from "../../src/topology/hash";
import { createFactSnapshot } from "../../src/facts/snapshots";
import { createFactRecord } from "../../src/facts/hash";
import type { FactRecord } from "../../src/facts/contracts";
import { createEvidenceClaim } from "../../src/evidence/claims";
import type { EvidenceClaim } from "../../src/evidence/contracts";
import type { FactSnapshot } from "../../src/facts/contracts";
import type { CapabilityRecord } from "../../src/capabilities/facets";
import { capabilityFactSnapshotRef, createCapabilityRecord } from "../../src/capabilities/facets";
import { AuthoritativeCapabilityCandidateService, type RootBoundCapabilityIndexAuthority } from "../../src/solver/capability-candidates";
import { SolverArtifactStore } from "../../src/server/solver-service";
import type { AuthoritativeSolverEvaluator } from "../../src/solver/solve";
import type { SolverComponentRequirement } from "../../src/solver/candidate-index";
import type { SnapshotHashes } from "../../src/hash";
import { canonicalize } from "../../src/hash";
import { sha256Json } from "../../src/runtime/fs.mjs";
import { PURCHASE_ELIGIBILITY_POLICY } from "../../src/solver/contracts";

const digest = (character: string): string => character.repeat(64);
const now = "2026-08-28T00:00:00.000Z";

export interface SolverFixture {
  root: string;
  coordinator: RuntimeCoordinator;
  artifactRepository: FileArtifactRepository;
  artifacts: SolverArtifactStore;
  candidateService: AuthoritativeCapabilityCandidateService;
  evaluator: AuthoritativeSolverEvaluator;
  evaluationCalls: BuildConfigV3[];
  baseConfig: BuildConfigV3;
  snapshotHashes: SnapshotHashes;
  requirements: SolverComponentRequirement[];
  factSnapshot: FactSnapshot;
  facts: FactRecord[];
  claims: EvidenceClaim[];
  capabilityRecords: CapabilityRecord[];
  close(): Promise<void>;
}

export async function createSolverFixture(options: {
  candidateCount?: number;
  includeIdentityClaims?: boolean;
  verdict?: "pass" | "fail" | "blocked";
  residualRequirementIds?: string[];
  incompleteCoverage?: boolean;
  root?: string;
} = {}): Promise<SolverFixture> {
  const root = options.root ?? await mkdtemp(path.join(os.tmpdir(), "buildsim-solver-fixture-"));
  const coordinator = new RuntimeCoordinator({ root, now: () => now });
  await coordinator.initialize();
  const artifactRepository = new FileArtifactRepository({ coordinator, now: () => now });
  await artifactRepository.initialize();
  const artifacts = new SolverArtifactStore(artifactRepository, () => now);
  const baseConfig = createEmptyBuildConfigV3("plan-solver", "Solver", now);
  baseConfig.requirementSpec = { requirementSpecId: "requirements-solver", schemaVersion: "1.0.0", workloads: [], constraints: [] };
  baseConfig.components.push({
    instanceId: "board-user-locked", kind: "motherboard", role: "motherboard", state: "planned",
    identity: { status: "resolved", skuId: "board.user-locked", identityClaimIds: ["claim-board-user-locked"] }, source: "user",
  });
  const baseConfigHash = await configV3Hash(baseConfig);
  const candidateCount = options.candidateCount ?? 2;
  const claims: EvidenceClaim[] = [];
  const facts: FactRecord[] = [];
  for (let index = 0; index < candidateCount; index += 1) {
    const skuId = `memory.fixture-${index + 1}`;
    const subject = {
      skuId, familyId: "memory.fixture-family", modelId: "memory.fixture-model",
      variantId: `memory.fixture-variant-${index + 1}`,
    };
    if (options.includeIdentityClaims !== false) {
      const documentHash = sha256Json({ document: skuId });
      const claim = await createEvidenceClaim({
        schemaVersion: "evidence-claim-v1", subject, scope: "variant", fieldId: "memory.type", value: "ddr5",
        authority: "official",
        source: {
          documentId: `doc-sha256-${documentHash}`, documentSha256: documentHash,
          captureId: `capture-sha256-${sha256Json({ capture: skuId })}`, locator: { field: "memory.type" },
        },
        retrievedAt: now, status: "active",
      });
      claims.push(claim);
      facts.push(await createFactRecord({
        schemaVersion: "fact-record-v1", factId: `fact-memory-${index + 1}`,
        subject: { kind: "product", ...subject }, field: "memory.type", value: "ddr5", scope: "variant",
        authority: "official", safetyClass: "compatibility_critical", status: "active",
        evidenceRefs: [claim.claimId], derivedFromFactIds: [], confidence: 1, retrievedAt: now,
      }));
    } else {
      facts.push(await createFactRecord({
        schemaVersion: "fact-record-v1", factId: `fact-memory-${index + 1}`,
        subject: { kind: "product", ...subject }, field: "memory.type", value: "ddr5", scope: "variant",
        authority: "agent_inference", safetyClass: "compatibility_critical", status: "active",
        evidenceRefs: [], derivedFromFactIds: [`fact-memory-source-${index + 1}`],
        inferenceTraceId: `inference-sha256-${sha256Json({ inference: skuId })}`,
        extractorOrRuleVersion: "fixture-memory-inference@1.0.0", assumptions: ["fixture-only"], confidence: 1, retrievedAt: now,
      }));
    }
  }
  const factRefs = facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash }));
  const factSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2", factRefs, conflictRefs: [], createdAt: now,
  });
  const factSnapshotRef = capabilityFactSnapshotRef(factSnapshot);
  const records = await Promise.all(Array.from({ length: candidateCount }, (_, index) => createCapabilityRecord({
    schemaVersion: "capability-record-v1",
    subjectSkuId: `memory.fixture-${index + 1}`,
    componentKindId: "memory_module",
    factSnapshotRef,
    facets: [{
      facetId: "memory.type", value: "ddr5", sourceFactIds: [`fact-memory-${index + 1}`], safetyClass: "boot",
    }],
    providerRefs: ["provider.fixture@1.0.0"],
  })));
  const factById = new Map<string, FactRecord>(facts.map((fact) => [fact.factId, fact]));
  const claimById = new Map<string, EvidenceClaim>(claims.map((claim) => [claim.claimId, claim]));
  const authority: RootBoundCapabilityIndexAuthority = {
    authorityKind: "root-bound-capability-index-authority-v1",
    async resolveAtRoot(_activeRoot, planId) {
      return { planId, factSnapshot, capabilityRecords: records };
    },
    async getFactAtRoot(_activeRoot, factId) { return structuredClone(factById.get(factId) ?? null); },
    async getEvidenceClaimAtRoot(_activeRoot, claimId) { return structuredClone(claimById.get(claimId) ?? null); },
  };
  const candidateService = new AuthoritativeCapabilityCandidateService({ coordinator, authority });
  const snapshotHashes: SnapshotHashes = {
    configHash: baseConfigHash,
    requirementSpecHash: digest("1"), factSnapshotHash: factSnapshot.contentHash,
    userObservationSnapshotHash: digest("2"), priceSnapshotHash: digest("3"), ruleSetHash: digest("4"),
    systemProfileHash: digest("5"), adapterSnapshotHash: digest("6"), engineHash: digest("7"),
    simulationModelHash: digest("8"), simulationInputHash: digest("9"),
  };
  const requirements: SolverComponentRequirement[] = [{
    requirementId: "requirement-memory", componentKindId: "memory_module", role: "system_memory",
    predicates: [{ facetId: "memory.type", operator: "eq", value: "ddr5" }],
    quantity: 1, hardConstraintIds: ["constraint-memory-required"],
  }];
  const evaluationCalls: BuildConfigV3[] = [];
  const verdict = options.verdict ?? "pass";
  const evaluator: AuthoritativeSolverEvaluator = {
    authorityKind: "authoritative-solver-evaluator-v1",
    async evaluate(input) {
      evaluationCalls.push(structuredClone(input.candidateConfig));
      const buildConfigHash = await configV3Hash(input.candidateConfig);
      const evaluationHash = sha256Json({ authority: "fixture-authoritative-evaluator", buildConfigHash });
      const coverage = (options.incompleteCoverage ? PURCHASE_ELIGIBILITY_POLICY.requiredDomains.slice(0, 1) : PURCHASE_ELIGIBILITY_POLICY.requiredDomains).map((domain) => ({
        domain, verdict, domainHash: sha256Json({ evaluationHash, domain, verdict }), evaluationHash, requiredForPurchase: true,
      }));
      const receiptArtifact = await artifactRepository.put({
        bytes: Buffer.from(canonicalize({ schemaVersion: "fixture-evaluation-receipt-v1", evaluationHash, buildConfigHash }), "utf8"),
        mediaType: "application/json", privacyClass: "runtime_internal", kind: "fixture-authoritative-evaluation-receipt", references: [], createdAt: now,
      });
      const coverageArtifact = await artifactRepository.put({
        bytes: Buffer.from(canonicalize({ schemaVersion: "fixture-coverage-v1", evaluationHash, coverage }), "utf8"),
        mediaType: "application/json", privacyClass: "runtime_internal", kind: "fixture-authoritative-evaluation-coverage", references: [], createdAt: now,
      });
      return {
        schemaVersion: "authoritative-solver-evaluation-v1",
        planId: input.planId,
        basePlanVersionId: input.basePlanVersionId,
        buildConfigHash,
        inputHashes: { ...input.expectedInputHashes, configHash: buildConfigHash },
        evaluationHash,
        evaluationReceiptRef: receiptArtifact.record.ref,
        coverageArtifactRef: coverageArtifact.record.ref,
        domainCoverage: coverage,
        residualRequirementIds: [...(options.residualRequirementIds ?? [])],
        unsatisfiedHardConstraintIds: verdict === "fail" ? ["constraint-authoritative-failure"] : [],
        excludedReasonIds: verdict === "blocked" ? ["identity-authority-blocked"] : [],
      };
    },
  };
  return {
    root, coordinator, artifactRepository, artifacts, candidateService, evaluator, evaluationCalls,
    baseConfig, snapshotHashes, requirements, factSnapshot, facts, claims, capabilityRecords: records,
    close: async () => { if (!options.root) await rm(root, { recursive: true, force: true }); },
  };
}
