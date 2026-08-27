# Fact resolution and evidence contract

This document freezes §4.2 and the evidence rules in §§1.4–1.5. Facts are
claim-level records, not a permanent “confirmed SKU” label. The implementation
must preserve uncertainty and make every downstream claim replayable.

## FactRecord

```ts
interface FactRecord {
  factId: string;
  subject:
    | { kind: "product"; skuId: string; revision?: string; region?: string; familyId?: string }
    | { kind: "plan_subject"; planId: string; subjectRef: ObservationSubjectRef };
  field: string;
  value: unknown;
  unit?: string;
  scope: "family" | "model" | "variant" | "revision" | "plan_subject";
  authority: "official" | "third_party" | "user_observation" | "agent_inference";
  safetyClass: "normal" | "compatibility_critical" | "electrical_safety";
  status: "active" | "superseded" | "conflicted" | "unresolved_blocker";
  evidenceRefs: string[];
  derivedFromFactIds: string[];
  extractorOrRuleVersion?: string;
  assumptions?: string[];
  confidence: number;
  retrievedAt: string;
  validFrom?: string;
  supersedesFactId?: string;
}
```

The repository also defines immutable `FactSnapshot`, `ConflictSet`,
`IdentityResolution`, `UpdateDecision`, `InferenceTrace`, and
`EvidenceSearchOutcome` records. A snapshot names the exact active facts used
by an evaluation; replacing a fact creates a new snapshot, never an in-place
edit.

## Evidence ladder

Resolution proceeds in this order: (1) exact model/revision official manual,
errata, support, QVL, or firmware page; (2) exact model official technical
page; (3) official family material only where the field is proven invariant;
(4) one clear, high-quality independent measurement; (5) two or more
independent, consistent third-party sources; (6) a replayable Agent inference.
Official manuals are official evidence. E-commerce pages establish listing
variant and seller claims, not technical specifications by default. Forums,
reviews, and reposts are leads unless promoted through the evidence policy.

The authority label always reflects the source. Third-party evidence never
renders as official. A website, PDF, model response, or search snippet is an
untrusted input; retrieval must retain source bytes/content hash, URL, method,
retrieval time, and bounded parsing metadata.

## Identity, scope, and conflicts

Identity is resolved per claim. Family-level invariants may support family
facts, but capacity, power, dimensions, cooler revision, bundled cables,
warranty, region SKU, revision, and purchase link remain variant-sensitive.
When a new rule needs a sensitive field, identity resolution reopens.

Official/measurement disagreement produces a `ConflictSet` and a blocked or
explicitly qualified decision; it does not silently choose a winner.

An inference records all input fact IDs, rule/model version, assumptions,
confidence, output interval, and invalidation conditions. Inference is a source
of evidence, not a verdict. Safety-critical inference cannot by itself green
PSU modular pinout, CPU/BIOS support, current/ampacity, EPS/PCIe/12V-2x6
connections, or a tolerance-critical clearance.

## Search outcomes and updates

An exhausted search must explain whether the official page was absent, a field
was missing, identity was ambiguous, access was blocked, parsing failed, sources
conflicted, or the search was exhausted. Update records retain old and new
facts, field-level diff, downstream domains affected, and a user decision:
accept, reject, defer, or undo. Decisions are remembered by
`subject + claim + revision`; changed revision or claim content can ask again.
Rejecting a safety correction never removes the visible warning.

## User observations

```ts
interface UserObservation {
  observationId: string;
  planId: string;
  subjectRef: ObservationSubjectRef;
  fieldId: string;
  value: unknown;
  unit?: string;
  uncertainty?: { plusMinus?: number; min?: number; max?: number };
  method: "measurement" | "photo" | "label" | "visual_confirmation" | "user_assertion";
  attachmentRefs: string[];
  confirmedByUser: boolean;
  observedAgainstConfigHash: string;
  subjectRevisionHash: string;
  capturedAt: string;
  validatedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
  status: "proposed" | "active" | "superseded" | "retracted";
  supersedesObservationId?: string;
  contentHash: string;
}
```

Observations are plan-scoped and can concern a plan, instance, placement,
connection, port, mount, or firmware instance. Only confirmed, validated,
scope-valid observations whose `planId`, `observedAgainstConfigHash`, and
subject revision all match the current plan project to
`authority: "user_observation"`. A stale UI status is derived from a config or
subject hash mismatch; it is not another stored status. Slot/port/route changes, BIOS
flashes, or revision changes invalidate affected observations. Measurements
need an uncertainty where a boundary could matter.

Photos and labels retain content hash, privacy class, and deletion policy.
Deleting bytes leaves a tombstone/hash and invalidates dependent facts; a new
export excludes the bytes, while old backups remain historically immutable.
Observation withdrawal/supersession invalidates derived facts, checkpoints, and
evaluation cache. User observations can resolve a plan-specific geometry
blocker but never become global SKU specifications or replace electrical or
safety evidence.

## Security boundary

Official-domain trust is governed by a registry, not by model judgment. URL
canonicalization, HTTPS, registry matching, every redirect/final URL, DNS
private-address rejection, bounded source/PDF sizes, and safe browser
subresources are mandatory. Unknown hosts produce reviewable domain proposals;
Agent catalog writes accept only an approved candidate ID and expected hash.
