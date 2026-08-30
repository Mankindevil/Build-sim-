import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { canonicalJson, confined } from "../runtime/fs.mjs";
import {
  solverArtifactReferencesRuntime,
  validateSolverApprovalClosureRuntime,
  validateSolverArtifactRuntime,
  validateSolverCandidateIndexAuthorityClosureRuntime,
  validateSolverCandidateClosureRuntime,
  validateSolverProgressiveEvaluationClosureRuntime,
  validateSolverWhatIfClosureRuntime,
} from "./runtime-validation.mjs";

const SOLVER_MEDIA_TYPE = "application/vnd.buildsim.solver+json";

function invariant(condition, message) { if (!condition) throw new Error(message); }
function same(left, right) { try { return canonicalJson(left) === canonicalJson(right); } catch { return false; } }
function parse(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}
function canonicalReferences(references) {
  return [...new Map(references.map((item) => [`${item.ref}\0${item.necessity}`, item])).values()]
    .sort((left, right) => `${left.ref}\0${left.necessity}`.localeCompare(`${right.ref}\0${right.necessity}`));
}

/** Kind-specific, cross-artifact solver replay closure for graph/Doctor/backup/restore. */
export async function validateSolverProductionClosureAtRoot({ activeRoot, factSnapshots = [], facts = [], evidenceClaims = [] }) {
  const repositoryRoot = confined(activeRoot, "artifacts");
  const repository = new FileArtifactRepository({ root: repositoryRoot });
  const listing = await repository.listAt(repositoryRoot, { initialize: false });
  const solver = new Map();
  for (const record of listing.records) {
    if (!record.kind.startsWith("solver-")) continue;
    const item = await repository.getAt(repositoryRoot, record.ref, { initialize: false });
    invariant(record.mediaType === SOLVER_MEDIA_TYPE && record.privacyClass === "runtime_internal",
      `solver ${record.kind} artifact metadata is invalid`);
    const value = parse(item.bytes, `solver ${record.kind} artifact`);
    const errors = validateSolverArtifactRuntime(record.kind, value);
    invariant(errors.length === 0, `solver ${record.kind} artifact is invalid: ${errors.join("; ")}`);
    const expectedRefs = canonicalReferences(solverArtifactReferencesRuntime(record.kind, value));
    invariant(same(canonicalReferences(record.references), expectedRefs),
      `solver ${record.kind} artifact references are incomplete or forged`);
    solver.set(record.ref, { record, value });
  }
  const opened = (ref, kind) => {
    const item = solver.get(ref);
    invariant(item?.record.kind === kind, `solver ${kind} referenced artifact is missing or wrong-kind`);
    return item.value;
  };

  const snapshotById = new Map(factSnapshots.map((value) => [value.snapshotId, value]));
  const factById = new Map(facts.map((value) => [value.factId, value]));
  const claimById = new Map(evidenceClaims.map((value) => [value.claimId, value]));

  for (const { record, value } of solver.values()) {
    if (record.kind === "solver-candidate-index") {
      const snapshot = snapshotById.get(value.factSnapshotRef.snapshotId);
      const requiredFactIds = [...new Set(value.capabilityRecords
        .flatMap((candidate) => candidate.facets.flatMap((facet) => facet.sourceFactIds)))].sort();
      const requiredClaimIds = [...new Set(value.pools.flatMap((pool) => pool.candidates
        .flatMap((candidate) => candidate.identityClaimRefs.map((reference) => reference.claimId))))].sort();
      const errors = validateSolverCandidateIndexAuthorityClosureRuntime(value, {
        factSnapshot: snapshot,
        capabilityRecords: value.capabilityRecords,
        facts: requiredFactIds.map((factId) => factById.get(factId)).filter(Boolean),
        evidenceClaims: requiredClaimIds.map((claimId) => claimById.get(claimId)).filter(Boolean),
      });
      invariant(errors.length === 0, `solver candidate index authority closure is invalid: ${errors.join("; ")}`);
    }
    if (record.kind === "solver-progressive-evaluation-receipt") {
      const coverage = opened(value.coverageArtifactRef, "solver-progressive-evaluation-coverage");
      const errors = validateSolverProgressiveEvaluationClosureRuntime(value, coverage);
      invariant(errors.length === 0, `solver progressive evaluation closure is invalid: ${errors.join("; ")}`);
    }
    if (record.kind === "solver-request") {
      const baseVersion = opened(value.basePlanVersionRef, "solver-base-plan-version");
      const lock = opened(value.evaluationLockRef, "solver-base-evaluation-lock");
      const baseConfig = opened(value.baseConfigRef, "solver-candidate-config");
      opened(value.requirementClosureRef, "solver-requirement-closure");
      invariant(baseVersion.planId === value.planId && baseVersion.id === value.request.basePlanVersionId
        && baseVersion.configHash === value.request.baseConfigHash && same(baseVersion.config, baseConfig)
        && baseVersion.evaluationLock?.contentHash === lock.contentHash
        && same(lock.snapshotHashes, value.request.baseSnapshotHashes),
      "solver request base version/lock/config closure is invalid");
    }
    if (record.kind === "solver-result") {
      const request = opened(value.requestRef, "solver-request");
      opened(value.checkpointRef, "solver-job-checkpoint");
      const baseConfig = opened(request.baseConfigRef, "solver-candidate-config");
      for (const candidate of value.result.candidates) {
        const candidateValue = opened(candidate.candidateArtifactRef, "solver-candidate");
        const candidateConfig = opened(candidate.candidateConfigRef, "solver-candidate-config");
        const operations = opened(candidate.operationsRef, "solver-candidate-operations");
        const errors = validateSolverCandidateClosureRuntime(
          { ref: candidate.candidateArtifactRef, value: candidateValue }, request,
          { ref: request.baseConfigRef, value: baseConfig },
          { ref: candidate.candidateConfigRef, value: candidateConfig },
          { ref: candidate.operationsRef, value: operations },
        );
        invariant(errors.length === 0, `solver candidate closure is invalid: ${errors.join("; ")}`);
      }
    }
    if (record.kind === "solver-approval" && value.status === "committed") {
      const pending = opened(value.previousApprovalRef, "solver-approval");
      const request = opened(value.requestRef, "solver-request");
      const result = opened(value.resultRef, "solver-result");
      const proposal = opened(value.proposalRef, "solver-acceptance-proposal");
      const selected = result.result.candidates.find((candidate) => candidate.candidateId === value.candidateId);
      invariant(selected, "solver approval selected candidate is absent from its result");
      const candidateValue = opened(selected.candidateArtifactRef, "solver-candidate");
      const operations = opened(selected.operationsRef, "solver-candidate-operations");
      const errors = validateSolverApprovalClosureRuntime(
        value, pending, request, result, proposal,
        { ref: selected.candidateArtifactRef, value: candidateValue },
        { ref: selected.operationsRef, value: operations },
      );
      invariant(errors.length === 0, `solver approval closure is invalid: ${errors.join("; ")}`);
    }
    if (record.kind === "solver-what-if-result") {
      const decision = opened(value.decisionDiffRef, "solver-what-if-decision-diff");
      const domainEntries = value.domainDiffRefs.map((ref) => ({ ref, value: opened(ref, "solver-what-if-domain-diff") }));
      const beforeReceipt = opened(value.beforeReceiptRef, "solver-progressive-evaluation-receipt");
      const afterReceipt = opened(value.afterReceiptRef, "solver-progressive-evaluation-receipt");
      const beforeCoverage = opened(value.beforeCoverageRef, "solver-progressive-evaluation-coverage");
      const afterCoverage = opened(value.afterCoverageRef, "solver-progressive-evaluation-coverage");
      const errors = validateSolverWhatIfClosureRuntime(
        value, { ref: value.decisionDiffRef, value: decision }, domainEntries,
      );
      invariant(errors.length === 0, `solver what-if closure is invalid: ${errors.join("; ")}`);
      const beforeErrors = validateSolverProgressiveEvaluationClosureRuntime(beforeReceipt, beforeCoverage);
      const afterErrors = validateSolverProgressiveEvaluationClosureRuntime(afterReceipt, afterCoverage);
      invariant(beforeErrors.length === 0 && afterErrors.length === 0,
        `solver what-if evaluator receipt closure is invalid: ${[...beforeErrors, ...afterErrors].join("; ")}`);
      invariant(beforeReceipt.basePlanVersionId === value.basePlanVersionId
        && afterReceipt.basePlanVersionId === value.basePlanVersionId
        && beforeReceipt.evaluationHash === value.beforeEvaluationHash
        && afterReceipt.evaluationHash === value.afterEvaluationHash
        && beforeReceipt.coverageArtifactRef === value.beforeCoverageRef
        && afterReceipt.coverageArtifactRef === value.afterCoverageRef
        && same(beforeReceipt.inputHashes, value.beforeInputHashes)
        && same(afterReceipt.inputHashes, value.afterInputHashes),
      "solver what-if result does not bind its exact evaluator receipts/coverage");
    }
  }

  const capabilityRecords = [...solver.values()]
    .filter(({ record }) => record.kind === "solver-candidate-index")
    .flatMap(({ value }) => value.capabilityRecords);
  const nodes = [...new Set([
    ...solver.keys(),
    ...capabilityRecords.map((value) => `capability-record:sha256:${value.contentHash}`),
  ])].sort();
  const edges = [...solver].flatMap(([fromRef, { record }]) => record.references.map((reference) => ({
    fromRef, toRef: reference.ref, necessity: reference.necessity,
  }))).concat(capabilityRecords.flatMap((value) => [
    { fromRef: `capability-record:sha256:${value.contentHash}`, toRef: `fact-snapshot:${value.factSnapshotRef.snapshotId}`, necessity: "required_for_replay" },
    ...value.facets.flatMap((facet) => facet.sourceFactIds.map((factId) => ({
      fromRef: `capability-record:sha256:${value.contentHash}`,
      toRef: `fact:${factId}`,
      necessity: "required_for_replay",
    }))),
  ]));
  return { nodes, edges, pointers: [] };
}
