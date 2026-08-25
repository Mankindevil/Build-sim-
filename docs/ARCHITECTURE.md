# Build Sim platform architecture

## Authoritative state

- `PlanRepository` is the durable authority for `BuildPlan`, active drafts, immutable `PlanVersion` records, soft deletion, and restore.
- Browser `PlanStore` is the single active-plan state machine. DOM controls are projections/adapters and never become a second durable plan.
- `BuildEvaluation` is deterministic and is the sole compatibility/geometry/wiring/assembly/power/price fact envelope used by the workspace, Three.js scene, Agent tools, and version hashes.
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
| Vite/browser | `127.0.0.1:5173` | Plan UI, deterministic evaluation, task and purchase projections |
| Price/Catalog/Advice | `127.0.0.1:5174` | Price/OCR/catalog workflows and their audit/evidence stores |
| Agent | `127.0.0.1:5175` | Provider-neutral sessions, streaming runs, bounded Tools/Skills and audit |
| Workspace | `127.0.0.1:5176` | Plans, versions, proposals, context audit, concurrency and file integrity |

Provider credentials are server-only. The workspace service revalidates proposal revision, config hash, SKU/path allowlists, selected operations, and deterministic impact after the browser records explicit human approval.

## Compatibility boundary

The original N6 detail panels remain a page-lifetime compatibility adapter in `index.html`, `boot.ts`, and `v1-runtime.js`. New lifecycle responsibilities live in TypeScript modules. `configFromDomLegacy()` may translate legacy controls into the active draft, while PlanStore subscriptions immediately project the authoritative draft back to those controls and rerun `BuildEvaluation`. New code must not add durable state to the legacy DOM/runtime.

R10 moved the inert detail template to `src/lab/app-document.html` and reduced `index.html` to the Vite app loader. Pre-existing, uncommitted UI work formerly in `index.html` remains an unstaged diff on that moved template; it is not absorbed into the platform commit. Further template decomposition should happen after that work is integrated, using the frozen legacy regression suites as the removal gate.

## Persistence and migration

- Plans: file repository envelopes with integrity hashes; corrupt data fails closed.
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

No deployment is performed by the lifecycle redesign. Each R0-R10 commit is independently revertible. To disable the platform UI while retaining data, remove the dynamic Plan shell/workspace/task mounts and keep the deterministic legacy adapter. Do not delete `runtime/plans`, transaction archives, or browser caches during code rollback; new fields/formats have compatibility readers, and transaction v1 data is never rewritten merely by reading it.
