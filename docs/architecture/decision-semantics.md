# Decision and requirement semantics

This document freezes §4.3 and the false-green rules in §1.3. A result is a
claim bounded by its declared evidence, assumptions, tolerances, and snapshots.

## Verdicts and domains

```ts
type DecisionVerdict = "pass" | "fail" | "blocked";

interface EvaluationDecision {
  decisionId: string;
  verdict: DecisionVerdict;
  domain: "identity" | "mechanical" | "electrical" | "firmware" | "system" |
    "storage" | "assembly" | "commissioning" | "routing" | "thermal" |
    "acoustic" | "procurement";
  message: string;
  instanceIds: string[];
  factIds: string[];
  ruleId: string;
  ruleVersion: string;
  assumptions: string[];
  remediation: RequirementNode[];
}
```

`pass` proves the constraint within declared bounds. `fail` proves a known
violation. `blocked` means safe use cannot be proven and requires evidence,
measurement, a plan change, or a user decision. Internal `unresolved` is not a
user verdict. Missing parts are requirements, not failures. Inference ranges
may pass only when every value in the range satisfies the rule. The
safety-critical false-green target is zero.

## Derived requirements

```ts
interface RequirementNode {
  requirementId: string;
  kind: "component" | "accessory" | "fastener" | "cable" | "consumable" |
    "tool" | "evidence" | "measurement" | "firmware_action" |
    "system_action" | "user_decision";
  predicates: FacetPredicate[];
  quantity: number;
  criticality: "normal" | "boot" | "safety";
  requiredBefore?: "assembly" | "pre_power" | "first_boot" | "os_install";
  producedBy: { ruleId: string; ruleVersion: string; instanceIds: string[] };
  evidenceRefs: string[];
}

interface RequirementSatisfaction {
  requirementId: string;
  status: "open" | "satisfied" | "blocked";
  allocations: Array<{
    source: "component" | "package_content" | "user_resource" | "purchase";
    refId: string;
    ownerInstanceId?: string;
    quantity: number;
    availability: "planned" | "ordered" | "present_verified";
    verificationStatus: "unverified" | "verified";
    satisfiesBefore?: "assembly" | "pre_power" | "first_boot" | "os_install";
    evidenceRefs: string[];
    observationRefs: string[];
  }>;
  residualQuantity: number;
}
```

`FacetPredicate` is a governed, allowlisted JSON DSL; arbitrary expressions,
code, or free-form Agent predicates are forbidden. Requirement closure reaches
a fixed point, detects cycles, and can emit newly required brackets, screws,
thermal materials, or tools. Allocation is conserved: one non-shareable cable,
screw, or tool cannot satisfy two simultaneous needs. `ordered` and “included
in box” prove a purchase/package declaration only; boot and safety gates need a
`present_verified` allocation or an equivalent safety checkpoint. Safety
requirements cannot be bypassed by a checkbox.

## Progressive evaluation and hashes

The sole authoritative evaluator consumes the topology, requirements, fact and
observation snapshots, prices, rules/standards/policy, system profile, adapter,
engine, simulation model, and simulation input. Its identity is:

`configHash + requirementSpecHash + factSnapshotHash + userObservationSnapshotHash + priceSnapshotHash + ruleSetHash + systemProfileHash + adapterSnapshotHash + engineHash + simulationModelHash + simulationInputHash`.

It also emits `compatibilityHash`, `spatialHash`, `simulationHash`,
`procedureSafetyHash`, and `priceHash`. Independent domain refreshes invalidate
only dependent procedures/checkpoints. Price or unrelated acoustic refreshes do
not erase mechanical or electrical confirmation.

Evaluation is progressive: a partial topology retains known facts, prices,
BOM, local compatibility, geometry, and domain conclusions. Unknown optional
parts do not clear the known subgraph. A safety unknown remains blocked.

The solver may generate candidates, but every candidate is submitted to this
same evaluator. UI, 3D, Agent, BOM, purchase, and recommendation surfaces
consume that output; none may reimplement compatibility or downgrade blocked
to pass.

## Safety and physical boundaries

Official/standard anchors are required for a mechanical `fail`; inferred
anchors produce at most a qualified warning or blocked measurement request.
Clearance passes only when it exceeds both evidence error and tolerance,
bend-radius, and service allowances. Thermal output is a conservative workload
interval (default ambient 20–30°C), not CFD. Acoustic output aggregates only
standardized hardware sources and is not a prediction of room loudness;
coil-whine is risk only.

Electrical safety, modular PSU pinout/cable-family, current/ampacity, CPU/BIOS,
EPS/PCIe/12V-2x6 bend, and tolerance-critical clearances must not be greened by
ordinary Agent inference. System usability includes a real firmware upgrade
path and target OS support, not merely a theoretical compatibility fact.
