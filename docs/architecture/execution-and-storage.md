# Assembly, firmware, and NAS contract

This document freezes §§4.7–4.9. It separates package truth, procedure
instructions, executable firmware paths, storage layout choices, and
plan-scoped observations.

## Package contents and procedure

```ts
interface BundleItem {
  bundleItemId: string;
  ownerSkuId: string;
  kind: "cable" | "fastener" | "standoff" | "bracket" | "adapter" | "tool" | "consumable";
  specification: FacetPredicate[];
  quantity: number;
  region?: string;
  revision?: string;
  variantScopeFactIds: string[];
  evidenceFactIds: string[];
}

interface BuildProcedureStep {
  stepId: string;
  phase: "prepare" | "bench_test" | "mechanical" | "wiring" | "firmware" | "first_power" | "system_install" | "verification";
  action: string;
  dependsOn: string[];
  instanceIds: string[];
  requirementIds: string[];
  expectedResult: string;
  failureAction: string;
  riskLevel: "normal" | "caution" | "safety_critical" | "destructive";
  stopConditions: string[];
  failureBranchStepIds: string[];
  confirmationPolicy: "none" | "user_confirm" | "measurement" | "observation_required";
  safetyCritical: boolean;
  dependencyHashes: Partial<DomainHashes>;
  dependencyHash: string;
  evidenceRefs: string[];
}

interface ExecutionSession {
  executionSessionId: string;
  planVersionId: string;
  procedureId: string;
  evaluationHash: string;
  procedureSafetyHash: string;
  status: "active" | "completed" | "stale" | "abandoned";
  staleReason?: string;
  results: Array<{ stepId: string; result: "confirmed" | "failed" | "skipped_non_safety"; at: string; actor: "user"; confirmedAgainstDependencyHash: string; note?: string; observationIds?: string[] }>;
}
```

The full `BuildProcedure` also carries input evaluation/procedure hashes and
ordered phases. Steps name prerequisites, affected instances, required
accessories/tools, expected result, risk, stop condition, failure branch,
evidence/inference references, and confirmation policy. Safety steps cannot be
skipped. Results bind the confirmation-time dependency hash; a price refresh
does not stale an unrelated mechanical step, while a changed board, EPS cable,
mount, or firmware target stales affected steps. Readiness flags are derived
from requirements/checkpoints, never writable booleans.

At server boundaries, expected checkpoint hashes, evaluator dependency hashes,
required readiness gates, and the current procedure are supplied only through
server-issued resolvers. The authoritative entrypoints are
`validateSafetyCheckpointRecordAuthoritatively`,
`deriveBuildReadinessAuthoritatively`, `validateBuildProcedureAuthoritatively`,
and `validateExecutionSessionAuthoritatively`. Request JSON supplies only the
record under validation plus a stable context ref; raw context-taking helpers
remain internal unit-test primitives.

“Included”, “buy”, and “reuse but unconfirmed” remain distinct allocations.
Fasteners, standoffs, adapters, brackets, cables, consumables, and tools are
first-class requirements, including package quantity and revision.

## Firmware path

`FirmwarePlan` records current-version observation, minimum and target release
facts, explicit transitions, required temporary CPU/RAM/GPU, version detection,
file/media format, filename/checksum, power prerequisites, settings, official
steps, recovery transitions, and reset behavior. A transition declares whether
it needs a working CPU and whether it uses UEFI, USB flashback, BMC, or an OS
tool. Version comparisons use vendor fact IDs, not assumed semver. If no
executable upgrade path exists, first-boot remains `blocked` even when the
target release theoretically supports the CPU.

## NAS layout

```ts
interface StorageLayoutEvaluation {
  layoutSelectionHash: string;
  systemProfileId: string;
  usableBytes: { min: number; max: number };
  vdevResults: Array<{ vdevId: string; estimatedUsableBytes: { min: number; max: number }; faultTolerance: { diskFailures: number; conditions: string[] } }>;
  hbaAndPathDecisionIds: string[];
  expansionOptions: Array<{ optionId: string; operation: "add_vdev" | "replace_drives" | "add_spare"; requiredInstanceCount: number; constraints: FacetPredicate[]; riskDecisionIds: string[] }>;
  decisions: EvaluationDecision[];
  assumptions: string[];
}

interface DestructiveActionPlan {
  actionId: string;
  diskInstanceIds: string[];
  locatorObservationIds: string[];
  inputProcedureSafetyHash: string;
  confirmation: "required" | "confirmed";
  confirmationAt?: string;
}
```

Config stores only `LogicalLayoutSelection`; capacity, redundancy, failure
domain, HBA/expander path, IT mode, expansion, resilver/drive replacement
risk, and destructive-action readiness are evaluation outputs. The planner
checks actual capacity mismatch, CMR/SMR, sector format, boot-pool isolation,
ports and path ceilings. RAID/RAIDZ is never described as backup. Clearing or
installing a disk requires a unique plan-scoped locator observation for every
disk and a separate confirmation bound to `procedureSafetyHash`; changed input
invalidates that confirmation.

`validateDestructiveActionPlanAuthoritatively` is the execution-facing gate. It
resolves current plan/config/procedure hashes, disk revisions, and active locator
observations from runner/repository state. A client-supplied context, even when
structurally identical, cannot authorize a destructive action.

## User observation boundary

The observation schema and lifecycle are defined in
[fact resolution](./fact-resolution.md). It is the only route for current
BIOS screenshots, photos, labels, port visibility, measurements, and assembly
verification to affect a plan. Observations cannot be promoted to global
catalog facts or extrapolated across a slot, port, revision, or product.
