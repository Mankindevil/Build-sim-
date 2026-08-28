# Requirements, solver, scenarios, and allowlists

This document records the U2 implementation boundary for §4.6 and the U0
registry boundary. Requirements are user intent; the solver is bounded
candidate generation; scenarios are immutable what-if derivations. None may
invent an SKU or weaken evaluation. The scenario repository and strict
production closure are implemented, while authoritative replayable evaluation
of a `WhatIfResult` is deliberately deferred (see below).

## RequirementSpec

```ts
type RequirementDraftField<T> =
  | { state: "answered"; value: T; source: "user" | "defaulted" | "agent_proposed"; confirmedByUser: boolean }
  | { state: "deferred"; value?: never; source: "user" | "defaulted" | "agent_proposed"; confirmedByUser: boolean }
  | { state: "not_applicable"; value?: never; source: "user" | "defaulted" | "agent_proposed"; confirmedByUser: boolean };

interface RequirementSpec {
  requirementSpecId: string;
  schemaVersion: "1.0.0";
  budget?: RequirementDraftField<{ targetCny?: number; hardCapCny?: number; reserveCny?: number }>;
  workloads: Array<{ workloadId: string; name: string; metrics: RequirementMetric[]; evidenceOrBenchmarkRefs?: string[] }>;
  constraints: Array<{ constraintId: string; predicate: FacetPredicate; strength: "hard" | "soft"; source: "user" | "migration" | "agent_proposed"; confirmedByUser: boolean }>;
  horizonYears?: RequirementDraftField<number>;
}

interface RequirementMetric {
  metricId: string;
  operator: "eq" | "gte" | "lte" | "between" | "includes";
  value: number | string | boolean | [number, number];
  unitId?: string;
  priority: "must" | "important" | "nice_to_have";
  benchmarkId?: string;
  benchmarkContext?: Record<string, string>;
}
```

Every draft field can be saved independently, including budget-only,
workload-only, or all-deferred requests. A proposed Agent hard constraint does
not enter solving until the user confirms it. Only confirmed `must` metrics map
to hard constraints; important/nice-to-have metrics are soft objectives.
Metrics come from the governed registry. `performance.cpu.multicore` and
`performance.gpu.frame_rate` require a registered `benchmarkId` plus the
benchmark's exact context keys (for example software version and power profile,
or title/version/resolution/preset/API). A bare `score` or FPS number is invalid;
there is no cross-purpose “universal performance score”. External
devices are not topology nodes or BOM items, but their target FPS, throughput,
or USB count may become internal requirements.

U2 also exposes granular stable selectors for progressive edits. The top-level
`config.requirementBudget` and `config.requirementHorizonYears` selectors
replace one draft field at a time; `workloads` and `constraints` use their
stable IDs, and `metrics` uses `(workloadId, metricId)` rather than an array
index. A non-null existing RequirementSpec cannot be replaced wholesale by
`PlanProposalService`; it must be edited through governed field/entity
operations. `solverAnsweredDraftValue`, `solverActiveMetrics` and
`solverActiveConstraints` are the solver-facing safe projections: a
deferred/not-applicable field, an unconfirmed workload/metric/constraint, and
an `agent_proposed` hard constraint are persisted data but not active solver
authority. Legacy metric/workload shapes remain readable for compatibility, but
missing confirmation metadata never becomes authority.

The ordinary blank-plan Agent path is progressive. A first proposal may save
only a requirement field (including an all-empty hardware topology); later
proposals add only the explicitly identified component/edge/requirement. An
unresolved identity retains the user's text and is not replaced by a default
SKU. Human approval, revision/hash compare-and-swap and the governed selector
validator remain required. The Agent does not auto-fill a case, board, GPU,
storage, cable or other unmentioned component, and does not promote its
interpretation to a user-confirmed hard constraint.

## Scenarios

```ts
interface ScenarioBranch {
  scenarioId: string;
  familyId: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  patch: TopologyV3StablePatchOperation[];
  simulationInputPatch?: JsonPatchOperation[];
}

interface ScenarioFamily {
  schemaVersion: "1.0.0";
  familyId: string;
  planId: string;
  name: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  createdAt: string;
  updatedAt: string;
}

interface TopologyV3StablePatchOperation {
  op: "add" | "replace" | "remove";
  selector: {
    collection: "config" | "components" | "roleDecisions" | "placements" |
      "connections" | "logicalLayouts" | "vdevs" | "firmwareTargets" |
      "workloads" | "metrics" | "constraints";
    id?: string;       // the collection's frozen ID field, never an array index
    parentId?: string; // layoutId for vdevs, workloadId for metrics
    field?: string;    // only for registry-allowed replace operations
  };
  value?: unknown;     // required for add/replace, forbidden for remove
}

interface WhatIfResult {
  scenarioId: string;
  beforeEvaluationHash: string;
  afterEvaluationHash: string;
  decisionDiffRef: string;
  domainDiffRefs: string[];
  snapshotAttribution: "same_snapshots" | "refreshed";
}
```

Branches are rooted at an immutable plan version and never mutate the active
plan. Default comparisons lock fact, price, rule, system, and simulation
snapshots, so differences are attributable to the patch. If the user requests
a refresh, input changes and market changes are labelled separately. A stale
base version is rejected. `ScenarioFamily` and `ScenarioBranch` are persisted
as immutable repository envelopes. Every family/branch snapshot set has a
content-addressed `scenario-snapshot-set-v1` manifest whose ID is derived from
the complete snapshot-hash tuple; the family and branch must bind to the same
manifest and config hash. Materialization re-resolves the exact base plan
version and rejects changed version/config/snapshot state with `stale` rather
than silently rebasing. Acceptance returns a normal plan proposal with the
expected base revision/hash; it does not mutate the active plan.

Branch creation and materialization validate resolved identities against the
active generation's merged catalog. Unresolved identities remain valid, but a
resolved SKU absent from or mismatched with that catalog is rejected. Patch
authority is actor-bound (`user`, `agent`, `solver`, `system`): non-user actors
cannot assert user source/confirmation/lock timestamps, role decisions are
user-only, system mutations are limited to governed defaults/firmware paths,
and interactive branches cannot mint `migration` provenance.

Production validation scans the family, branch and snapshot-set envelopes and
requires closure edges to the immutable base plan version, family and snapshot
set. Unknown paths, symlinks, dangling bases/manifests, forged materialized
hashes, semantically invalid materializations and resolved identities not
proven by the active merged catalog fail backup, restore and Doctor checks.
Until U3 replaces catalog-derived identity with a locked fact snapshot, an
existing scenario whose resolved identity disappears from the active catalog
therefore fails closed as stale rather than being silently reinterpreted. This
interim freshness check does not mutate the branch or its base plan version.

U2 intentionally does not persist what-if evaluation results. `WhatIfResult`
has a structural validator for hashes and governed diff references, but
`FileScenarioRepository.saveResult` and reads of persisted result/evaluation
records return `evaluation_authority_unavailable`; production scanning rejects
`results/`, `evaluations/` and `evaluation-snapshots/` authority paths. This is
fail-closed until U6 supplies a governed, authoritative, replayable evaluator
and verifier. A branch/materialized config is therefore not evidence that a
before/after evaluation was run.

## Bounded solver

The solver exposes explicit `SolveRequest`, `SolveResult`, `SolverCandidate`,
`DomainCoverage`, `CandidatePromotionRecord`, and `RankedSolution` records.
Requests include base hashes, locked instances, requirement ID, seed/version,
maximum evaluations, duration, and candidates per requirement. Results record
explored/pruned counts, candidate/config/operation references, excluded and
unsatisfied IDs, conflict sets, limits, and a search summary. `unsat_proven`
is allowed only after exhaustive or formally proven search; an irreducible
conflict set is not called globally minimal without a minimality proof.

Candidates are `feasibility_candidate` only. They become
`purchase_eligible` through a promotion record after U7–U9 domains are
revalidated by the same evaluator and hashes are bound. Hard failures or
blocked purchase-required domains cannot be offset by scoring. Economic,
balanced, and long-term results are complete bootable topologies, not a list of
incompatible individually ranked parts.

Server-facing promotion and ranking never accept raw coverage, closure,
benchmark score, price snapshot, or evaluator context from request JSON.
`validateCandidatePromotionAuthoritatively` and
`validateRecommendationEligibilityAuthoritatively` resolve the frozen
eligibility context by stable ref. `validateWholeBuildRecommendationAuthoritatively`
resolves the candidate, promotion, eligibility context, score, artifact refs,
and input hashes as one repository-owned recommendation context, then reruns all
pure validators and exact bindings. The raw-context functions are internal
helpers only and cannot authorize purchase/ranking at an API boundary.

## Frozen registries and patch boundary

U0 freezes versioned registries for:

- capability facets and their types/safety classes;
- serializable `HardwareAdapterManifest` IDs/versions, supported component
  kinds, emitted facets, minimum pass-source policy and maximum safety class;
- executable `HardwareAdapter` instances with the exact §4.4
  `subjectSkuId`, `capabilities()`, `geometry()`, `routing()`, `assembly()`,
  `thermal()`, and `provenance()` boundary;
- metric IDs, units, normalization and allowed operators;
- benchmark IDs and their required context keys;
- observation field IDs, subject scopes, methods and uncertainty rules;
- system profiles/releases and firmware setting IDs;
- `FacetPredicate` JSON operators and value types;
- V3 stable-selector targets/fields, legacy V2 patch paths, and simulation-input
  JSON Patch paths.

V3 plan changes are not RFC 6902. JSON Pointer cannot select a moving array
element by identity, so V3 uses the structured selector contract above. Every
component/edge/workload/layout/vdev target carries its immutable registry ID;
numeric array-index paths and `/-` appends are rejected. Legacy V2 keeps its
existing, separate JSON Patch allowlist and is not widened.

Allowed V3 operations are limited to explicit topology/requirement fields:
component identity/state, role decisions, placements, connections, logical
layout selections, firmware targets, system selection when not user-locked,
and requirement draft fields. Allowed simulation patches are only registered
`SimulationInput` fields and retain their separate JSON Patch contract. The
validator checks operation shape and the value schema for the selected target,
not only its name. No hash fields, repository paths, evidence bytes, job status,
current observations, derived evaluation/eligibility fields, or other unknown
properties may be patched. Non-user actors cannot assert `source: "user"`,
`confirmedByUser: true`, `confirmedAt`, or `system.lockedByUser: true`.

The U0 operation validator checks exact operation/selector fields, registry
membership, selected value schema, immutable IDs, and actor authority. Agent
text cannot mutate a plan. U2 repository/application code must additionally
size-limit and canonicalize proposals, then revalidate base revision, config
hash, selector existence/non-existence, referential integrity, selected
operations, resulting BuildConfigV3, and deterministic impact after explicit
approval. Those application-time checks are an explicit U2 runtime gate; U0
freezes the operation contract but does not claim that applying it is
implemented.

## Adapter boundary

Solver candidate generation may use registered capability facets, but never
imports a case-specific JSON or duplicates evaluator rules. A concrete case
adapter belongs in its explicit adapter module/manifest; generic code consumes
the executable `HardwareAdapter` interface and validates its identity/version
against the frozen `HardwareAdapterManifest` registry. A manifest is hashable
metadata and must never masquerade as the executable adapter. `sourcePolicy`
is the minimum source class allowed to support a positive verdict, not a source
ingestion allowlist. Adapter versions, standards, policies, and models are
replay artifacts locked by hash. UPS and ordinary tools/fasteners/consumables
are outside component topology; the latter are modeled as requirements and
supplies when needed.
