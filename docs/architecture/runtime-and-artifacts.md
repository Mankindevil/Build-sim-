# Runtime, hashes, prices, jobs, portability, backup, and Doctor

This document freezes §§4.0, 4.5, 4.10, 4.11, and 4.12. The U1 filesystem
foundation implements the local repository, snapshot, backup and diagnostic
boundaries described below; provider-specific repositories and later portable
import/export workflows still compose on those boundaries.

## U1 runtime generation and repository boundary

`RuntimeCoordinator` owns one cross-process writer barrier, a private control
directory, an atomic `active-pointer.json`, monotonic `runtimeGeneration` and
revision, maintenance leases, and inaccessible staging generations. Repository
code must resolve its root from the coordinator's `activeRoot` inside every
`withWrite` or `withConsistentSnapshot` call; it must not cache an absolute
generation path. Snapshot providers receive the already-resolved active root
and must not re-enter the coordinator lock.

The frozen active-generation root registry includes plans, transactions,
catalog/domain overlays, facts, prices, snapshots, evidence, attachments,
observations, jobs (including records/idempotency/rollback), artifacts, config,
audit, execution sessions, exports, backups, diagnostics and migrations. All
directories and private files use `0700`/`0600`. `FileArtifactRepository`
stores content-addressed blobs separately from checksummed metadata and the
repository manifest. Its reference snapshot feeds the same consistent graph
used by backup, Doctor and mark-and-sweep GC.

GC is dry-run unless explicitly applied. Apply takes a maintenance lease,
rejects a stale graph/generation, protects active snapshot/audit/backup/export
roots, traverses references, and moves eligible objects into a recoverable
quarantine rather than deleting them immediately.

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

The U1 backup runner only emits `full_local_backup`. Calling it with
`plan_portable` fails closed because selecting one plan and proving its complete
offline reference closure belongs to the later scoped exporter; relabelling a
recursive runtime backup as portable would disclose unrelated plan data.
Execution-session IDs are derived from checksummed active-generation envelopes,
not caller options. When execution results reference observations, the supplied
consistent graph must contain `execution-session:<id> -> observation:<id>`
required edges. U1 records a limitation for plan/procedure/evaluation/safety
artifacts, whose persisted refs are not yet available, instead of inventing
closure. Restore advances execution generations, replaces old leases with an
expired fence, and changes active sessions to `stale` with the stable
`runtime_restored_requires_review` reason.

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
requirements. The U1 runner takes a coordinator read barrier, encrypts the
inner manifest and private payload using scrypt plus AES-256-GCM, verifies a
temporary `/tmp` restore, then uses a maintenance lease and staging generation
for an active restore. The pointer write is the commit point; any earlier
failure leaves the prior pointer selected. Restore recursively rewrites both
the general job store and `jobs/catalog-search/records`: every record advances
to the new runtime generation, non-terminal jobs lose old leases and enter
`paused_restore_review`, and terminal jobs retain their terminal status.
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
refetch, or alter permissions. The U1 runner executes the frozen check registry
without initializing or mutating a repository, returns content-addressed
evidence values for optional caller persistence. Frozen exit codes are healthy
`0`, degraded `1`, and unhealthy `2`; `--strict` also refuses a nominally
healthy report containing an unverified/skipped check. The repair
executor remains disabled unless a version-bound plan, current preconditions,
verified backup, explicit approval and explicit repair flag all pass.
Server-facing verification and repair use `verifyDoctorReportAuthoritatively`
and `verifyRepairExecutionAuthoritatively`; both resolve runner/repository state
by stable ref before invoking the pure cryptographic checks.

An older container-owned subtree can make the normal "verified backup before
repair" sequence impossible because the application cannot traverse the bytes
that must be backed up. This narrow bootstrap case uses
`npm run runtime:bootstrap-access`. Its default plan mode is read-only and
binds the active-pointer hash, runtime generation, runtime device/inode and the
device/inode/mode/owner of only three frozen legacy locations:
`<active-generation>/plans/.locks`, `plans/.agent-context-audit`, and
`transactions`. It never accepts an arbitrary path.

An administrator may explicitly persist the reviewed plan outside the runtime,
then apply it with the exact `RESTORE_RUNTIME_READ_ACCESS` confirmation and an
exact `--expected-plan-hash`, plus an external private rollback-file destination. Apply rescans every descendant,
rejects symlinks, special files, hard-linked regular files and mount/device
crossings, fsyncs a content-addressed ownership/mode manifest before mutation,
and changes ownership through `O_NOFOLLOW` descriptor-bound writes only—never
content or modes. Partial failure restores all already-touched entries.
Rollback additionally requires both the original plan and its private manifest,
their exact expected hashes, plus `ROLLBACK_RUNTIME_READ_ACCESS`; a self-hashed
manifest alone has no authority. The bootstrap does not replace the ordinary
repair flow: immediately after access is restored, the operator must create and
verify the encrypted full backup, rerun Doctor, and use the governed repair
plan for any permission-mode changes or migrations.

## Legacy runtime migration v1

Pre-generation deployments must not be started against generation-aware
repositories until `scripts/migrations/migrate-runtime-v1.mjs` has completed.
The command is read-only by default. It inventories every legacy file,
directory, mode, size, and SHA-256 twice and prints only counts, hashes, and
status. Secret paths such as `.env`, provider keys, cookies, and browser
profiles are identified from the path without opening their contents. Apply
requires the exact `--expected-source-manifest-hash` returned by that dry-run.

Known repository layouts are copied to their registered active-generation
roots. This includes plans, evidence, agent sessions/audit, transactions,
advice events/jobs, catalog drafts, catalog/domain overlays, and catalog audit
records. Unknown `data`, legacy evidence backups, agent-context audit, and
untyped catalog candidates are retained under
`migrations/quarantine/legacy-runtime-v1`; they cannot become current
authority. Plan, evidence, Agent, and transaction records must also satisfy
their current envelope/path/identity baseline; a readable but unrecognized
legacy schema is moved to the same quarantine instead of being reported as an
active repository record. Any symlink, special file, unreadable
JSON/checksummed envelope, or different-content destination collision blocks
the migration. Content is scanned with the backup secret-key policy as it is
copied: secret-bearing legacy content is excluded with only a hashed path and
reason in the manifest, while secret-bearing content already present in the
active generation blocks the merge.

Legacy transaction screenshots are never copied, including into migration
quarantine: PNG/JPEG/WebP/GIF bytes remain only in the unchanged legacy source
and the migration records a hashed path plus
`legacy_transaction_raw_image`. A transaction JSON that references or embeds
an image is projected to a no-image summary, drops the screenshot/filename,
redacts labeled personal text and phone patterns, and retains only hash/byte
length/media-type verification metadata. Legacy transaction rollback journals
are excluded because their prior-value payloads may embed the same private
bytes.

The governed historical product catalog is an explicit second input. Export
`data/skus/catalog.json` from commit `0a29861`, whose required SHA-256 is
`faccd64f63a9483862777ec032d175955e63598152da6457aba547ec98d5cc99`,
and pass both `--legacy-catalog` and `--expected-legacy-catalog-hash`. The
static `data/migrations/catalog-user-data-v1.json` binds the sanitized output
hash and the expected 23 fields/10 unattributed records. Values are written
only at runtime in a checksummed `0600`
`migrations/catalog-user-data-v1/quarantine/catalog-user-data.json`; no value
is logged or stored in this repository. Because the file is inside the active
generation, `full_local_backup` includes it as encrypted private runtime data.

Apply acquires a cross-process migration lock and maintenance lease, copies the
already-active generation plus legacy data into a private staging generation,
verifies every copied byte and record, rechecks the unchanged source manifest,
then atomically commits the active pointer. `preparing`, `prepared`, and
`committed` control journals recover crashes before and after the pointer
commit. Legacy source files are never renamed or deleted.

Production safety order is fixed: stop all legacy workspace, price, Agent, and
worker processes; take a filesystem-level backup/snapshot of the unchanged
legacy tree and record its hash; export the governed old catalog from commit
`0a29861` to a private change-record location; run and record the zero-write
dry-run; apply using both reviewed expected hashes; run `--verify`; create and
verify an encrypted `full_local_backup`; only then start the new services.
Maintenance lease protects generation-aware writers, but cannot fence an old
binary that does not know that lease, so stopping every legacy writer is a hard
precondition rather than an optional optimization.

Osaka runs one dedicated, one-shot `runtime-preflight` service before any
runtime-backed business service. Price and workspace require its successful
completion, and Agent starts through the price dependency, avoiding concurrent
fresh-root inventories while preserving fail-closed ordering. The gate permits
only a genuinely empty fresh runtime, an initialized active generation, or a
signed committed migration whose active pointer, source inventory, and staged
payload still verify. A non-empty legacy tree without that proof exits nonzero
and all runtime-backed services remain stopped.

```bash
# zero-write inventory
node scripts/migrations/migrate-runtime-v1.mjs \
  --runtime-root /app/runtime \
  --legacy-catalog /secure/change-record/catalog-at-0a29861.json \
  --expected-legacy-catalog-hash faccd64f63a9483862777ec032d175955e63598152da6457aba547ec98d5cc99

# apply after recording/reviewing the dry-run sourceManifestHash
node scripts/migrations/migrate-runtime-v1.mjs --apply \
  --runtime-root /app/runtime \
  --expected-source-manifest-hash '<dry-run hash>' \
  --legacy-catalog /secure/change-record/catalog-at-0a29861.json \
  --expected-legacy-catalog-hash faccd64f63a9483862777ec032d175955e63598152da6457aba547ec98d5cc99

# read-only verification and rollback preview
node scripts/migrations/migrate-runtime-v1.mjs --verify --runtime-root /app/runtime \
  --legacy-catalog /secure/change-record/catalog-at-0a29861.json \
  --expected-legacy-catalog-hash faccd64f63a9483862777ec032d175955e63598152da6457aba547ec98d5cc99
node scripts/migrations/migrate-runtime-v1.mjs --rollback --runtime-root /app/runtime
node scripts/migrations/migrate-runtime-v1.mjs --preflight --runtime-root /app/runtime
```

Rollback refuses if the committed generation has any newer write. If a prior
pointer existed, it copies the verified prior generation into a new monotonic
generation and activates that copy. If this migration created the first
pointer, it can remove only that pointer when its exact revision is unchanged;
all legacy files and generated audit material remain recoverable.

## Current price snapshot v2 migration

`scripts/migrations/migrate-price-snapshot-v2.ts` is the explicit bridge from
the historical `prices/latest.json` shape to the content-addressed current
snapshot consumed by evaluation. Its default mode is a strictly read-only
projection using the optimistic pointer/lock/pointer barrier. The report binds
the runtime generation and revision, raw current-file hash, governed capture
and observation bytes, merged catalog hash, selected/omitted observation IDs,
target date, and deterministic effective time into one source-manifest hash.

Apply requires that exact reviewed hash and an encrypted backup path outside
the runtime root. It creates and verifies the backup first, then rechecks the
complete source manifest under the runtime writer barrier. A legacy current
file is copied byte-for-byte to
`prices/snapshots/legacy-<contentHash>.json`; current state is rebuilt only from
valid immutable price observations. Missing observations therefore produce an
empty v2 current snapshot instead of promoting a historical quote. A source
revision change before commit produces zero migration writes. A failure after
the first write restores the verified backup into a new generation and
regenerates the production reference graph.

```bash
# read-only review
npm run runtime:migrate-price-v2 -- \
  --runtime-root <runtime-copy> \
  --as-of YYYY-MM-DD \
  --output <dry-run-report.json>

# apply only after reviewing the report and creating a private password input
npm run runtime:migrate-price-v2 -- --apply \
  --runtime-root <runtime-copy> \
  --as-of YYYY-MM-DD \
  --expected-source-manifest-hash '<dry-run hash>' \
  --backup-output <outside-runtime.backup> \
  --password-file <0600-password-file>
```

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
