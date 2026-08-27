# Topology V3 contract

This document freezes the canonical plan shape from §4.1 of the authoritative
universal hardware plan. It is a future implementation contract, not a claim
that V3 is currently accepted by the runtime.

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

Scenario branches belong to `ScenarioRepository`, not this object. Thus a
what-if label cannot change a topology hash or mutate the active plan.

## Cross-document references

- Hash inputs and replay locks: [runtime and artifact contracts](./runtime-and-artifacts.md)
- Facts and identity: [fact resolution](./fact-resolution.md)
- Verdicts and progressive evaluation: [decision semantics](./decision-semantics.md)
- Requirements, solver, scenarios, and allowlists: [requirements and scenarios](./requirements-and-scenarios.md)
- Assembly, firmware, and NAS: [execution and storage](./execution-and-storage.md)
