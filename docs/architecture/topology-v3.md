# Topology V3 contract

This document records the U2 implementation boundary for the canonical plan
shape in §4.1 of the authoritative universal hardware plan. The schema below
is now accepted by the V3-enabled plan/config paths; the remaining platform
evaluator is intentionally outside this document. U2 status checkboxes and
release evidence remain in the follow plan.

## Implemented U2 boundary

- `validateBuildConfigV3` is a total, strict input validator. It rejects
  unknown/derived fields, malformed Unicode, unregistered component kinds,
  invalid states, duplicate identities, dangling placement/connection/layout
  references, occupied mounts, reused disks/cables, invalid vdev minima and
  unregistered firmware settings. It does not infer defaults, resolve catalog
  facts, normalize the caller's object, or mutate it.
- `normalizeBuildConfigV3` validates before and after canonicalization. It
  applies NFC text and `-0` normalization and sorts governed collections (and
  delegates RequirementSpec ordering to `normalizeRequirementSpec`) while
  retaining stable IDs and human note order. The returned value is a clone;
  the input object is not modified.
- `configV3Hash` hashes the normalized persisted input in the registered
  `build-config@3.0.0` domain. `hashPlanConfig` preserves the legacy unscoped
  V2 hash and selects this domain hash for V3. `spatialTopologyHash` hashes a
  separate `spatial-topology@1.0.0` projection containing physical component
  identity, placements and connection endpoints, so purchase state, source,
  claim IDs, requirements, notes, firmware targets and connection status do
  not perturb the spatial hash. These are the U2 domain hashes; they are not a
  claim that the full compatibility/thermal/procedure evaluator exists.
- `projectTopologyBom` is a lossless one-line-per-component projection with
  `quantity: 1`. It preserves instance, role, state and unresolved user text;
  consumers may aggregate only for display. Role decisions are not BOM rows,
  and the projection does not inject a case-profile default or SKU.

The implementation is split across `src/topology/{contracts,validation,normalize,hash,projections}.ts`.

## Canonical object

```ts
interface BuildConfigV3 {
  schemaVersion: "3.0.0";
  id: string;
  name: string;
  updatedAt: string;
  intent: RequirementDraftField<MachineIntent> | null;
  requirementSpec: RequirementSpec | null;
  system: SystemSelection | null;
  components: ComponentInstance[];
  roleDecisions: RoleDecision[];
  placements: PlacementEdge[];
  connections: ConnectionEdge[];
  logicalLayouts: LogicalLayoutSelection[];
  firmwareTargets: FirmwareTarget[];
  notes?: string[];
}

interface ComponentInstance {
  instanceId: string;
  kind: ComponentKindId;
  role: string;
  state: "planned" | "ordered";
  identity:
    | { status: "unresolved"; userText: string; candidateIds?: string[] }
    | { status: "resolved"; skuId: string; identityClaimIds: string[] };
  source: "user" | "agent" | "migration";
}

interface RoleDecision {
  roleDecisionId: string;
  role: string;
  decision: "not_needed";
  source: "user" | "migration";
  confirmedAt: string;
}

interface SystemSelection {
  profileId: SystemProfileId;
  versionFactId: string;
  source: "defaulted" | "user";
  lockedByUser: boolean;
}

interface FirmwareTarget {
  instanceId: string;
  targetReleaseFactId: string;
  requestedSettings: Array<{ settingId: FirmwareSettingId; desiredValue: string }>;
  source: "user" | "system_requirement";
}

type VdevTopology = "mirror" | "raidz1" | "raidz2" | "raidz3" | "stripe";

interface LogicalLayoutSelection {
  layoutId: string;
  bootPoolDiskIds: string[];
  vdevs: Array<{ vdevId: string; topology: VdevTopology; diskInstanceIds: string[] }>;
  spareDiskIds: string[];
}

interface PlacementEdge {
  placementId: string;
  componentInstanceId: string;
  mountOwnerInstanceId: string;
  mountId: string;
}

interface ConnectionEdge {
  connectionId: string;
  from: { instanceId: string; portId: string };
  to: { instanceId: string; portId: string };
  cableInstanceId?: string;
  status: "required" | "planned" | "satisfied" | "blocked";
}
```

## Invariants

- Every SSD, DIMM, GPU, expansion card, fan, and safety-relevant cable is an
  independent instance. The UI may aggregate equal instances, but evaluation
  never collapses them into `SKU × quantity`.
- Quantity entry expands during canonicalization into stable instance IDs.
  Unresolved user text is valid and is never replaced by a default SKU.
- `not_needed` is a role decision and never creates a component with a fake
  identity. Real instances use only `planned` or `ordered`; `ordered` means a
  purchase commitment, not receipt, installation, health, or ownership proof.
- Empty plans have zero components, decisions, placements, connections,
  layouts, firmware targets, BOM rows, and geometry. A saved requirement or
  default system suggestion does not create hardware nodes.
- NAS disks are components. Pools, vdevs, mirrors, and RAIDZ live only in
  `logicalLayouts`; a synthetic “RAID component” is forbidden.
- Every boot/vdev/spare disk reference resolves to a `storage_drive`, and one
  physical disk may occur in only one active logical-layout assignment.
- `connection.cableInstanceId`, when present, resolves to a `cable` component;
  direct board/backplane/adapter connections omit that field.
- `requirementSpec` stores user goals. Evaluator-generated `RequirementNode`
  remediation is derived output and must not be written back into config.
- Current BIOS versions are observations. Desired releases/settings alone are
  persisted in `firmwareTargets`.
- Attachments, observation bodies, job state, and generated procedures are
  referenced artifacts or evaluation outputs; they do not become hidden
  topology fields.

## Authority and migration

`PlanRepository` owns drafts and immutable versions. BOM is a projection of
components and requirements, never an alternate topology. Legacy `owned`
migrates to `ordered`; `buy_now`, `upgrade_later`, and `optional` migrate to
`planned` with priority expressed in recommendation/task data. Migration must
be dry-run-able, produce a manifest, preserve rollback data, and never infer a
missing identity or add N6 defaults.

The V2-to-V3 path is lazy/explicit: the first V3 edit uses
`migrateDraftToV3`, retains an immutable V2 `migration-source` version and
records a source-byte hash, deterministic diff/warnings, rollback reference,
and a content-addressed projection of the exact governed catalog input used by
the migration rule. The projection is deliberately narrow: it proves only the
resolved identity emitted by that migration and cannot authorize later edits
or unrelated SKUs. The migration closure is rechecked on reads, writes, backup
and restore; a tampered source, catalog binding, or audit record is rejected.
Historical migrated versions continue to validate against this immutable
authority when the active catalog later changes, while newly resolved
identities still require the current governed catalog. It maps only explicit V2 fields:
`diskCount` expands to instances, an NVMe count without a SKU becomes
unresolved storage instances, `gpu.none` becomes a `not_needed` role decision,
fan groups become unresolved fan instances, and legacy HBA/topology/layout or
unrecorded BOM rows are omitted with warnings. No workload, budget, BIOS,
system, pool/vdev, accessory, tool or user observation is guessed.

`BUILD_SIM_TOPOLOGY_V3_ENABLED` is the compatibility/rollback gate. With the
flag off, V2 remains readable and writable and V3 creation/edit is rejected.
A V3-backed plan can be exposed only through the explicit
`v3ReadFallback: "migration_source"` mode, which returns the immutable V2
source as `configAccess.mode: "v2_fallback"`; that view is read-only and cannot
silently rewrite V3 as V2. Flag-off config parsing likewise requires immutable
V2 fallback bytes whose plan identity matches the V3 input.

Scenario branches belong to `ScenarioRepository`, not this object. Thus a
what-if label cannot change a topology hash or mutate the active plan.

## Cross-document references

- Hash inputs and replay locks: [runtime and artifact contracts](./runtime-and-artifacts.md)
- Facts and identity: [fact resolution](./fact-resolution.md)
- Verdicts and progressive evaluation: [decision semantics](./decision-semantics.md)
- Requirements, solver, scenarios, and allowlists: [requirements and scenarios](./requirements-and-scenarios.md)
- Assembly, firmware, and NAS: [execution and storage](./execution-and-storage.md)
