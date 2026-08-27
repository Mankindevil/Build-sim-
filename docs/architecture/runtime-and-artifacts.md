# Runtime, hashes, prices, jobs, portability, backup, and Doctor

This document freezes §§4.0, 4.5, 4.10, 4.11, and 4.12. These are replay and
operations contracts for a future implementation; they do not imply that
runtime services are currently deployed.

## Server-issued trust boundary

Contexts named `trusted` are never accepted from request JSON. Server-facing
code receives only a stable ref/ID and an injected `AuthoritativeResolver<T>`
created by the server composition root. The resolver and each
`TrustedResolution<T>` are authenticated at runtime through module-private
`WeakSet` membership; the brand is not a serializable field. A hand-written
lookalike, `JSON.parse(JSON.stringify(...))` clone, missing ref, wrong authority
kind, or mismatched resolution fails closed. Pure context-taking validators are
retained only for testing already-resolved values. HTTP/RPC handlers must call
the `*Authoritatively` entrypoints.

## HashSpec and artifact lock

```ts
interface HashSpec {
  version: "hash-spec-v1";
  algorithm: "sha256";
  canonicalization: "rfc8785-jcs-with-buildsim-domain-prefix";
  unicode: "utf8-nfc";
  numberPolicy: "finite-json-number";
  excludes: ["the-hash-field-itself"];
}

interface SnapshotHashes {
  configHash: string; requirementSpecHash: string; factSnapshotHash: string;
  userObservationSnapshotHash: string; priceSnapshotHash: string;
  ruleSetHash: string; systemProfileHash: string; adapterSnapshotHash: string;
  engineHash: string; simulationModelHash: string; simulationInputHash: string;
}

interface DomainHashes {
  compatibilityHash: string; spatialHash: string; simulationHash: string;
  procedureSafetyHash: string; priceHash: string;
}

interface ArtifactLockfile {
  schemaVersion: "artifact-lockfile-v1";
  hashSpecVersion: "hash-spec-v1";
  artifacts: {
    ruleSet: LockedArtifactRef;
    standardSet: LockedArtifactRef;
    systemProfile: LockedArtifactRef;
    adapterSnapshot: LockedArtifactRef;
    engine: LockedArtifactRef;
    simulationModel: LockedArtifactRef;
  };
  lockfileHash: string;
}

interface LockedArtifactRef {
  ref: `sha256:${string}`; hashSpecVersion: "hash-spec-v1";
  algorithm: "sha256";
  contentHash: string;
  canonicalizationPolicyId: string;
  domain: string;
  schemaVersion: string;
  role: keyof ArtifactLockfile["artifacts"];
  artifactId: string;
  mediaType: string;
  requiredForReplay: true;
}
```

Every hash has a schema/domain prefix. Canonicalization fixes object-key and
collection order, units, finite numbers, UTF-8 NFC, and self-hash exclusion.
The frozen domain registry selects a versioned canonicalization policy; the
policy ID is carried in every content-addressed ref so verification never asks
the caller to reconstruct an unrecorded exclusion/unit/set policy. Node,
browser, workers, export, and restore use the same vectors. A runtime
mismatch blocks release. `ArtifactLockfile` stores content-addressed refs for
rules, standards, system profiles, adapters, engines, and models—not just
hash strings. An old evaluation missing any replay-required artifact is
explicitly non-replayable.

The formal U0 content-hash registrations align the domain schema version with
the validated object's own `schemaVersion`:

| Object | Domain registration | Canonicalization policy |
| --- | --- | --- |
| `BuildConfigV3` | `build-config@3.0.0` | `config-v3-v1` |
| `RequirementSpec` | `requirement-spec@1.0.0` | `requirement-spec-v1` |
| `FactSnapshot` | `fact-snapshot@fact-snapshot-v1` | `fact-snapshot-content-v1` |
| `UserObservationSnapshot` | `user-observation-snapshot@user-observation-snapshot-v1` | `observation-snapshot-content-v1` |
| `AdapterSnapshot` | `adapter-snapshot@adapter-snapshot-v1` | `adapter-snapshot-content-v1` |
| `SimulationModelArtifact` | `simulation-model@simulation-model-artifact-v1` | `simulation-model-artifact-v1` |
| `ArtifactPayload` | `artifact@artifact-payload-v1` | `artifact-payload-v1` |

`FactSnapshot` contains `factIds`/`conflictSetIds`; `UserObservationSnapshot`
contains `observationIds`. Neither embeds mutable `FactRecord` or
`UserObservation` records. `AdapterSnapshot` contains only registered,
serializable `HardwareAdapterManifest` values—never executable adapter
methods. `SimulationModelArtifact` contains versioned assumptions and finite
numeric coefficients and remains distinct from `SimulationInput`.
`ArtifactPayload` is a typed envelope around inert, finite JSON data.

These five snapshot/artifact objects use `contentHash` as their sole self-hash
field. Their formal policies exclude only `/contentHash`; governed ID/manifest
sets are sorted at their declared paths. The earlier `@1.0.0` snapshot/model/
artifact registrations and their original policies remain readable for
compatibility. New golden vectors and new persisted objects use the formal
registrations above. In `adapter-snapshot-content-v1`, adapter order and each
manifest's `componentKindIds`/`emittedFacetIds` are all set-semantic; reordering
any of those arrays cannot change the content hash.

## Price observations and history

Formal `PriceObservation` is derived from an immutable server-side
`listingCapture`, never accepted as an audited client assertion:

```ts
interface PriceObservation {
  observationId: string;
  skuId: string;
  variantIdentityFactIds: string[];
  platform: "jd" | "tmall" | "taobao" | "pdd" | "official" | "other_cn";
  sellerId?: string; sellerName?: string;
  sellerTier: "S1" | "S2" | "S3" | "S4" | "unknown";
  condition: "new";
  stockStatus: "in_stock" | "seller_claimed" | "unknown";
  priceCny: number; shippingCny?: number; comparableTotalCny: number;
  requiredDiscountConditions?: string[];
  invoiceStatus: "yes" | "no" | "unknown";
  warrantyStatus: "mainland" | "seller" | "cross_border" | "unknown";
  canonicalUrl: string; listingCaptureId: string; capturedAt: string;
  recheckedAt?: string;
}
```

China-first policy uses `age <=72h` preferred, `<=7d` usable, and older
observations only as history. One precise valid new quote may display at low
confidence; two independent sellers form a market range. Cross-border,
no-invoice, no-mainland-warranty, second-hand, preorder, and out-of-stock rows
are labelled and never silently mixed into current-new budget.

```ts
interface PriceHistoryPoint {
  historyPointId: string; skuId: string; variantIdentityFactIds: string[];
  bucketStart: string; bucketEnd: string; timeZone: "Asia/Shanghai";
  policyHash: string; priceBasis: "comparable_total_cny"; condition: "new";
  region: "CN"; currency: "CNY"; minCny: number; maxCny: number;
  medianCny?: number; sampleCount: number; sellerCount: number;
  platformCounts: Record<string, number>; observationIds: string[];
  confidence: "low" | "medium" | "high"; snapshotId: string;
}

interface PriceTarget {
  targetId: string; planId: string; instanceId?: string; skuId: string;
  variantIdentityFactIds: string[]; targetTotalCny: number;
  sellerTierMinimum?: "S1" | "S2" | "S3" | "S4";
  requireMainlandWarranty?: boolean; expiresAt?: string; enabled: boolean;
  status: "watching" | "met" | "paused" | "unavailable"; revisionHash: string;
  updatedAt: string; nextCheckAt?: string; lastEvaluatedSnapshotId?: string;
  lastTriggeredAt?: string;
}
```

History uses the same exact variant, policy, timezone bucket, and immutable
observations. “Buy/wait” displays window, sample coverage, current historical
position, coupons/member/cross-store conditions, and uncertainty. Append-only
target events are deduplicated by target revision + price snapshot + transition
and alert only on a crossing. Schedules survive restart, catch up at most one
missed bucket, and do not create a task storm. Initial release has no external
notifications.

`validatePriceObservationAuthoritatively` resolves only the declared
`listingCaptureId`, recomputes the capture's registered
`listing-capture@listing-capture-v1` content hash, then exact-matches every
observation field. A caller-supplied `Map` is only supported by the internal
pure helper and has no server-facing authority.

## Durable jobs

`BackgroundJob` is an append/revisioned record with job type/handler version,
idempotency key, input/payload refs, optional plan, lifecycle status (including
waiting user/retry, offline pause, restore review, dead letter), attempt and
lease fields, runtime generation, dependencies, progress, checkpoint/result
refs, commit hash, and redacted error. Its minimum status set is
`queued | running | waiting_user | waiting_retry | paused_offline |
paused_restore_review | succeeded | failed | cancelled | dead_letter`.
Payloads contain references; large web/PDF/model output belongs in
`ArtifactRepository`.

Checkpoint/result commit requires expected revision, active lease token, and
runtime generation (CAS). Expired workers cannot commit. Repository/proposal/
inbox side effects are exactly-once by idempotency key; read-only fetches may be
at-least-once but captures are content-addressed. Offline pauses do not burn
retries. Restore pauses all non-terminal work for review and fences old leases.
Jobs produce candidates, updates, or proposals; they cannot bypass approval to
mutate a plan.

## Portable package and full backup

`.buildsim` `plan_portable` (`slim` or `complete`) and `full_local_backup` are
different products. Both have schema/app/runtime generation, manifest entries,
logical paths, byte lengths, SHA-256, privacy class, included/excluded roots,
referenced plan/snapshot/evaluation IDs, artifact-lock reference, and a
self-excluding `manifestHash`. The envelope keeps payload hash outside the
payload. Structural validation is total and deliberately makes no cryptographic
claim. `verifyBackupManifestHash` recomputes `manifestHash` with the registered
`backup-manifest@backup-v1` HashSpec policy, which excludes only
`/manifestHash`; malformed canonical input fails closed. Authenticated
encryption uses scrypt (`N` power-of-two and at least 32768, `r >= 8`, `p >= 1`)
and AES-256-GCM with a 256-bit key, at least 16-byte salt, 12-byte nonce, and
16-byte tag. Keys remain outside the package. It is mandatory for any
`private_user` entry and every full backup. Names, phones, addresses, provider
keys, cookies, browser profiles, and `.env` are excluded or encrypted by
policy.

```ts
interface BackupManifest {
  schemaVersion: "backup-v1"; backupId: string; createdAt: string;
  appVersion: string; runtimeGeneration: number;
  mode: "plan_portable" | "full_local_backup";
  portableProfile?: "slim" | "complete";
  entries: Array<{ logicalPath: string; kind: string; byteLength: number; sha256: string; privacyClass: "public_source" | "private_user" | "runtime_internal" }>;
  includedRoots: string[];
  excludedEntries: Array<{ kind: string; reason: string }>;
  planIds: string[]; requirementSpecHashes: string[]; factSnapshotIds: string[];
  userObservationSnapshotIds: string[]; priceSnapshotIds: string[];
  evaluationHashes: string[]; artifactLockfileRef: string;
  executionSessionIds: string[]; manifestHash: string;
}
```

Slim packages may re-evaluate with current runtime. Complete packages include
all `required_for_replay` facts, observations, prices, rules, systems,
adapters, engines, and simulation artifacts; vendor originals may remain
external URL/hash/locator excerpts as `optional_for_audit`. Same ID+hash is a
no-op; same ID with a different hash requires copy-as-new or backup-before-
replace, never silent overwrite. Imports are dry-run first and reject absolute
paths, `..`, symlinks, duplicate paths, invalid schema/hash closure, or path
traversal. Full backup covers repositories, config, audit, jobs, executions,
and referenced archives.

Exact replay cannot be proven by edges, roots, or included-ref lists supplied
inside the package. `verifyPortableProfileClosure` accepts a trusted consistent
Repository reference graph, trusted required roots, the independently measured
staged ref inventory, and a cryptographically verified `ArtifactLockfile`. It
walks every transitive `required_for_replay` edge and also requires the
content-addressed lockfile plus all six locked rule/standard/system/adapter/
engine/model refs. Omitting a root or an edge target therefore fails even when
the manifest labels itself `complete`. `optional_for_audit` originals do not
block exact replay.

The server-facing gate is `verifyPortableProfileClosureAuthoritatively`; it
resolves that context by stable ref and recomputes the repository graph through
`portable-reference-graph@portable-reference-graph-v1`. The raw-context helper
does not authorize an import on its own.

Restore acquires maintenance lease, freezes writers/workers, stages and
validates, then atomically switches the root pointer and increments
`runtimeGeneration`; old processes are fenced. A verification report must
bind the independently measured staged ciphertext hash, manifest hash, and one
byte-length/SHA-256 result for every manifest entry. It also carries
content-addressed temporary-restore artifact and report refs, bound to the same
backup, manifest, generation, and entry count. `verifyBackupForPointerSwitch`
rehashes those artifacts and is the only U0 authorization contract for an
active-root pointer switch; a reported `pass`, or legacy
`hashClosureValid`/`temporaryRestoreTested` booleans, has no authority by
itself. Backup freshness and a passing trusted verification are Doctor
requirements. U1 remains responsible for implementing the Repository snapshot,
staging reader, temporary restore, maintenance lease, and atomic pointer switch.
The public pointer-switch boundary is
`verifyBackupForPointerSwitchAuthoritatively`, which resolves runner-measured
state by ref; `verifyBackupForPointerSwitch` remains an internal pure helper.

## Doctor

```ts
interface DoctorCheckResult {
  checkId: string; checkVersion: string;
  category: "storage" | "integrity" | "migration" | "services" | "network" |
    "security" | "jobs" | "backup" | "runtime";
  status: "pass" | "warn" | "fail" | "skipped";
  severity: "info" | "degraded" | "blocking";
  summary: string;
  evidence: Array<{ code: string; redactedDisplay?: string; valueHash?: string }>;
  evidenceArtifactRefs: ContentAddressedRef[];
  remediation?: string; repairable: boolean;
}

interface DoctorReport {
  schemaVersion: "doctor-v1"; doctorVersion: string;
  checkRegistryVersion: string; runtimeGeneration: number;
  generatedAt: string; appVersion: string;
  overall: "healthy" | "degraded" | "unhealthy";
  checks: DoctorCheckResult[]; reportHash: string;
}
```

Doctor is read-only by default and can run offline. Stable JSON checks cover
runtime permissions/space, repository hashes and reference closure, pending
migrations, service versions, stuck leases/dead letters, recent verified
backup, browser/WebGL, search/PDF parser, offline state, clock skew, and log
redaction. Evidence is structured redacted codes/displays/hashes only—never
raw paths, page contents, or user fields. `overall` derives only from checks;
status/severity combinations and strict exit codes are governed.

Structural report validation does not trust a check's declared status.
`verifyDoctorReport` recomputes `reportHash` through the registered
`doctor-report@doctor-v1` self-excluding policy, binds the report to the trusted
Doctor version, check-registry version, and runtime generation, and verifies a
content-addressed measurement artifact for every check. Each measurement binds
the registered check ID/version/category to its status/severity and generation.
A package cannot invent a mandatory check, substitute a check version, or copy
an unrelated evidence hash and still obtain a verified report. Validator errors
use stable index/code descriptions and never echo untrusted paths or values.

Repairs consume a version-bound `RepairPlan` with report/precondition hashes,
Doctor/check-registry versions, runtime generation, impact summary, backup ID,
idempotency key, approval, and rollback refs. Before execution it verifies the
current Doctor report, rechecks the exact precondition set and generation,
requires a verified pre-repair backup, shows impact, requires confirmation, and
remains idempotent/reversible. Doctor must not silently migrate, delete caches,
refetch, or alter permissions. U1 remains responsible for the read-only Doctor
runner, trusted check registry, ArtifactRepository writes, and repair executor;
these U0 types do not self-attest that an operational check was actually run.
Server-facing verification and repair use `verifyDoctorReportAuthoritatively`
and `verifyRepairExecutionAuthoritatively`; both resolve runner/repository state
by stable ref before invoking the pure cryptographic checks.

## SimulationInput

```ts
interface SimulationInput {
  workloadMetricRefs: string[];
  ambientC: { min: number; max: number };
  fanPolicyId: string;
  storageActivity: Array<{ logicalLayoutId: string; dutyCycle: number; concurrentDiskCount: number }>;
  placementIds: string[];
  routeIds: string[];
  modelVersion: string;
}
```

All default inputs show their source and are user-overridable. What-if keeps
the same simulation input by default; changing only a NAS layout changes
layout/path refs and both simulation hashes without drifting ambient or
workload. Inputs are immutable evaluation inputs, not hidden mutable model
state.
