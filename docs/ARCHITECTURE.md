# Build Sim platform architecture

## U0-U12 production shape

The platform is a local, generation-fenced authority graph rather than a browser-side calculator. `RuntimeCoordinator` owns one active root under `runtime/generations/<n>` and serializes pointer-changing writes. Plans, facts, evidence claims, user observations, prices, background jobs, execution sessions, adapter registries, immutable artifacts, evaluation receipts, decisions, and backup verifications all live under that root. Restore validates a staging root before one pointer switch; stale workers and approvals from an older generation cannot commit.

V3 evaluation is target-only at the transport boundary. The Workspace service resolves current plan state, FactSnapshot, UserObservationSnapshot, price state, rule/standard/provider sets, adapter/runtime model, simulation input, and implementation bytes, then creates an `ArtifactLockfile`, `EvaluationLock`, and immutable receipt. A saved `PlanVersion` replays its locked bytes and never consults newer active catalog or adapter data. Browser, Agent, solver, recommendation, spatial, procedure, and what-if surfaces consume that authority instead of supplying hashes.

Case behavior is data-driven. `CaseAdapterManifest` and `CaseRuntimeModel` are total-validated and compiled by the generic runtime. JONSBO N6 is a regression data package; primitive ATX, Micro-ATX, and Mini-ITX fixtures use the same compiler. Evidence-insufficient or newly discovered cases remain domain-specific `blocked`/`partial` until a reviewed provisional adapter is registered. The isolated legacy runtime exists only for flag-off V2 rollback.

## Authoritative state

- `RuntimeCoordinator` and the active generation are the outer durable authority and consistency barrier.
- `PlanRepository` is the plan authority for `BuildPlan`, active drafts, immutable `PlanVersion` records, soft deletion, and restore.
- Browser `PlanStore` is the single active-plan state machine. DOM controls are projections/adapters and never become a second durable plan.
- V2 `BuildEvaluation` remains the rollback envelope. V3 `ProgressiveBuildEvaluation` is the authoritative compatibility/requirements/geometry/wiring/assembly/system/storage/simulation/price envelope and is bound to complete snapshot and artifact hashes.
- Transactions remain evidence records. Only an exact `PlanTransactionLink` may affect the matching purchase task.
- `BuildTaskStore` derives tasks from BOM, assembly, wiring, and findings, then reconciles only by `kind + sourceRef`; titles never migrate completion.

```text
PlanRepository ──> PlanStore(active plan/draft/version)
                       │
                       ├──> BuildEvaluation ──> workspace / Three.js / Agent context
                       │
Transaction archive ──┴──> plan-scoped purchase facts
                                      │
BuildEvaluation ──────────────────────┴──> BuildTaskStore ──> workspace / build / export / Agent summary
```

## Service boundaries

| Process | Default | Responsibility |
|---|---:|---|
| Vite/browser | `127.0.0.1:5173` | Plan UI and authority projections; no server authority hashes originate here |
| Price/Catalog/Advice | `127.0.0.1:5174` | Price/OCR/catalog workflows and their audit/evidence stores |
| Agent | `127.0.0.1:5175` | Provider-neutral sessions, streaming runs, bounded Tools/Skills and audit |
| Workspace | `127.0.0.1:5176` | Plans, locked evaluation, facts/observations, solver/what-if, prices/recommendations, jobs, operations, portability and execution |

Provider credentials are server-only. The workspace and Agent services revalidate proposal revision, config hash, candidate identity, plan context, runtime generation, Tool definition/input hashes, durable approval artifact closure, and deterministic impact inside the active-root writer.

## Compatibility boundary

The original N6 detail panels remain a page-lifetime compatibility adapter in `index.html`, `boot.ts`, and `v1-runtime.js`. New lifecycle responsibilities live in TypeScript modules. `configFromDomLegacy()` may translate legacy controls into the active draft, while PlanStore subscriptions immediately project the authoritative draft back to those controls and rerun `BuildEvaluation`. New code must not add durable state to the legacy DOM/runtime.

R10 moved the inert detail template to `src/lab/app-document.html` and reduced `index.html` to the Vite app loader. Pre-existing, uncommitted UI work formerly in `index.html` remains an unstaged diff on that moved template; it is not absorbed into the platform commit. Further template decomposition should happen after that work is integrated, using the frozen legacy regression suites as the removal gate.

## Persistence, migration, and recovery

- Runtime: generation roots plus one atomic active pointer; maintenance and restore use leases and staging.
- Plans: file repository envelopes with integrity hashes; corrupt data fails closed. V2-to-V3 migration defaults to dry-run and applies only against the reviewed source-manifest hash after a verified encrypted backup.
- Evaluation: immutable snapshot/lock/receipt/artifact closure; current pointers are projections, not authority.
- Facts/evidence/observations/prices: immutable records and content-addressed blobs with explicit current indexes and plan scope.
- Jobs/execution: durable attempts, idempotency keys, fenced leases, rollback checkpoints, and restore quarantine.
- Portability: profile-specific `.buildsim` packages with dry-run import plans, conflict policy, path/schema limits, and required replay references.
- Full recovery: encrypted backup, verification report, staging restore, reference graph validation, and strict Doctor.
- Active plan/cache: `build-sim.workspace.*`; cache is best effort and never presented as a server save.
- Purchases: `build-sim.progress.v2:<planId>`; legacy v1 is read idempotently and backed up without guessed plan links.
- Tasks: `build-sim.tasks.v1:<planId>`; malformed rows are discarded and rebuilt deterministically.
- Transactions: archive schema v2; v1 reads as unlinked inbox without silent rewrite.

## Failure and cleanup behavior

- Offline/stale saves retain the local draft and surface `offline`, `failed`, or `conflict`; they do not claim success.
- OCR cancellation/failure retains the selected file for retry; staged records are not archives.
- Agent text cannot mutate a plan; failed/stale proposals leave the draft unchanged.
- WebGL failure/context loss selects SVG fallback. Three.js disposes controls, geometries, materials, observers, and the renderer.
- Page teardown closes Agent SSE, aborts OCR, revokes preview/object URLs, clears timers/listeners, and disposes PlanStore, workspace, spatial, task/purchase controllers.

## Rollback

Rollout flags disable U-stage writers and projections without deleting V3 data. Generic-adapter rollback loads the isolated legacy runtime lazily; V2 readers remain available and immutable V2 versions are never rewritten. A deployment rollback must restore code/config first and use only a verified runtime snapshot pointer when data rollback is required. Do not delete immutable plan versions, evidence documents, price history, migration manifests, jobs, decisions, or artifacts during a code rollback.
