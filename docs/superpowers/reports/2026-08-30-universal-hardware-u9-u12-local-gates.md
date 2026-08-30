# Universal hardware platform U9-U12 local gate report

Date: 2026-08-30
Release: `0.2.0-alpha`
Scope: local worktree and isolated `/tmp` runtimes only; no remote push, production mutation, or external provider request was performed.

## Outcome

- U9 workload-driven thermal intervals and standardized hardware acoustics: local gate passed.
- U10 China price history/targets and whole-build recommendation: local gate passed.
- U11 unified Workspace/Agent experience: local gate passed.
- U12 software implementation, portability/recovery, migration rehearsal, and local production-shape validation: passed.
- U12 production-default release: **not yet passed**. Independent physical ATX/ITX/NAS holdouts, the recorded release canaries, operator review of the real runtime migration, remote push/deploy approval, production deployment, and post-deploy verification remain outstanding.

This report deliberately separates software fixture evidence from physical or live-market evidence. Passing deterministic tests does not prove a measured clearance, cable length, temperature, acoustic interval, current listing, or deployed service.

## Implemented

### Authoritative runtime and evaluation

- Generation-fenced runtime repositories cover plans, facts/claims, observations, evidence, prices, jobs, execution sessions, adapter registries, artifacts, decisions, operations, backup verifications, and indexes.
- V3 target-only evaluation resolves and locks config, facts, observations, price state, scenario/simulation input, adapter/runtime model, rules, standards, providers, engine, and implementation bytes server-side.
- Immutable versions replay their locked artifacts without consulting newer active catalog or adapter state.
- Fact updates, conflict resolution, inference approval, Agent writes, and provisional adapters use durable optimistic guards and exact active-root revalidation.

### Universal hardware model

- BuildConfig V3 topology, hard/soft requirements, role decisions, placements, connections, logical layouts, system/firmware/storage state, and scenarios are persisted without hidden components.
- Generic case manifest/runtime-model compilation covers N6 regression data plus ATX, Micro-ATX, Mini-ITX and honest partial adapters.
- Capabilities, standards, package supply, requirement allocation, firmware paths, storage, geometry, routing, assembly, electrical checks, and observation overrides share strict runtime validators.
- The bounded solver and read-only what-if path consume authoritative candidates and reject incomplete purchase coverage.

### Evidence, simulation, price, and experience

- Official, third-party, user-observation, and inference ladders retain immutable bytes/locators, exact identity, plan scope, approval, and replay closure.
- Durable evidence/OCR/adapter/solver/price jobs support restart, offline pause, cancellation, idempotency, and stale-generation fencing.
- Thermal/acoustic evaluation reports intervals, assumptions, operating points, contributions, and plan-scoped calibration.
- Price captures produce governed observations, immutable history, current snapshots, target revisions/events/schedules, and conservative buy/wait explanations.
- Recommendations require a current purchase-eligibility promotion, preserve ordered components, and expose scoring, penalties, evidence gaps, and alternatives.
- Workspace UI includes progressive requirements, solver, what-if, attachments/annotations, update inbox, 3D/routes, thermal/acoustic, history/targets, recommendations, execution, NAS, jobs, portability, backup, and Doctor projections.

### Portability, migration, recovery, and operations

- Slim/complete/redacted `.buildsim` export and ImportPlan dry-run support no-op, copy-as-new, explicit replace-after-backup, ID remap, rollback, path/schema limits, and exact offline replay.
- Full local backup is encrypted, authenticated, permission-restricted, reference-closed, verified through a temporary restore, and restored through staging plus one runtime-pointer change.
- Doctor is read-only by default, has frozen strict exit semantics, validates repository/reference closure and operational prerequisites, and gates repairs behind backup, preview, exact preconditions, approval, idempotency, and rollback.
- V2-to-V3 plan migration defaults to dry-run, hashes the exact source manifest, requires an external verified backup for apply, retains archived V2 history, and restores the verified backup on failure.
- Osaka Compose/deploy scripts now run the strict universal canary and independent physical-holdout gate inside the candidate Runtime image before backup or service recreation, followed by verified backup, bounded health checks, and strict Doctor. They were not executed against production in this report.

## Verification evidence

### Full code gate

- `npm test -- --testTimeout=30000`: 327 files, 1615 tests. In the default sandbox 325 files / 1612 tests passed; the only three failures were `listen EPERM` for two loopback test files. Those exact files were rerun with local-loopback permission and passed 2 files / 11 tests.
- `npm run typecheck`: passed.
- `npm run build`: client, Agent SSR, and Workspace SSR passed. The existing Vite chunk-size warning remains non-blocking.
- `npm run agent:secret-scan`: 1039 files scanned after the release-canary and physical-holdout gate follow-ups, zero findings.
- `git diff --check`: passed after the report and documentation update.

### Stage gates

- U9 focused: 13 files / 62 tests passed.
- U10 focused: 20 files / 46 tests passed.
- U11 focused: 17 files / 45 tests passed.
- U12 focused, including migration rehearsal: 34 files / 105 tests passed.
- Full V2-to-V3 rehearsal: dry-run remained read-only; wrong manifest produced zero migration writes; apply created and verified an encrypted backup; active V2 migrated to V3; archived V2 remained readable; rollback authority remained valid.

### Executable release canary

- `npm run release:canary` now runs the exact N6 partial configuration through the production repository, fact migration, locked evaluation, saved version, and spatial-scene composition.
- Eight checks pass: two distinct 980 PRO instances, zero profile-default components, partial/not-power-ready evaluation with explicit requirements, zero empty-bay cable instances, locked spatial output with inferred coordinates/tolerances and exact component-placement/routing/assembly blockers, blocked thermal/acoustic output without fabricated point values, unknown price output without fabricated listings, and no executable first-power completion.
- The command intentionally exits `2`: CPU/SSD/legacy-PSU official fact closure is incomplete, and no official `power.load` fact proves the i5-14500 maximum turbo power. It records those exact blockers and confirms that no `65 W × 1.35` fallback was used.
- `npm run release:holdouts` is a second strict gate. It requires independent ATX, Mini-ITX, and NAS datasets that were not used for tuning; exact plan/version/config/evaluation/adapter/simulation hashes; calibrated protocol/instrument identity; and bounded clearance, cable-length, temperature, and 1-metre standardized acoustic measurements. With no real datasets present it exits `2` and lists all three missing layouts.
- `deploy/osaka/deploy.sh` invokes both gates from the just-built Runtime image and reads the reviewed holdout set from `/app/runtime/release-evidence/physical-holdouts`; either non-zero result stops before backup creation and before the candidate stack is started.

### Current local persistent-runtime preflight

- A strictly offline, read-only Doctor run against runtime generation `1` produced report hash `0d498e7092f86f5117bf4862a3b4f34151b0abb269cde86623f04bf9a4a8e5ac`. Reference closure, pending-migration state, job leases, dead-letter state, free space, clock, and log redaction passed; all service probes were skipped or local-only.
- The blocking result is `runtime.permissions`: 48 regular files still use mode `0644` and 37 directories use mode `0755`; 151 files already use `0600` and 77 directories use `0700`. The repair is deliberately not applied before an encrypted verified backup and explicit repair-plan confirmation.
- The same run reports that no recent verified backup is recorded and that the artifact repository is not initialized. The local deployment environment currently has no `BUILDSIM_BACKUP_PASSWORD`, so no production-runtime backup or repair was attempted.
- The real runtime V2-to-V3 read-only projection is `ready` with source manifest hash `b379a3fce81d8ea124b3c756a79360ad3cdd4fbee350e109d819e86d2d104eac`; it contains zero plans, so there is no plan draft to transform. The catalog user-data dry-run scanned 38 SKUs and found zero fields to remove or quarantine.
- The fact migration dry-run is stable at source hash `1bf946f7aa56c9c26be28dc2028f065bb8c9780157fa001e62080cd12bfcc6f5`: two bundled manuals yield 10 formal facts, while 237 legacy attributes remain `legacy_unverified` and 13 remain `planning_or_inferred`. The real runtime has not applied this migration; apply remains gated by the verified backup and operator review.

### Browser acceptance

All browser scripts used local bundled fixtures and `127.0.0.1` services only:

- `test:g1:browser`
- `test:purchase-price:browser`
- `test:g7:browser`
- `test:u7:browser`
- `test:workspace:browser`
- `test:spatial:browser`
- `test:agent-plan:browser`
- `test:agent-initialization:browser`
- `test:transactions:browser`
- `test:build-tasks:browser`
- `test:platform:browser`
- `test:c7:browser`

The platform run covered desktop/tablet/mobile, exact browser hash vectors, plan isolation, save/reload, staged transaction review, build-task reconciliation, accessibility labels/live regions, horizontal overflow, memory release, and bounded API payloads.

### Production-shape Doctor and backup

An isolated runtime under `/tmp` started the built Price, Agent-disabled, and Workspace services plus a static local search fixture. A full encrypted backup was created outside the runtime root and verified/persisted. `npm run runtime:doctor -- --strict` returned `overall: healthy` and exit code `0`, including service-version, WebGL, PDF parser, clock, recent-backup, repository, and reference-closure checks. All temporary services and files were removed afterward.

## Data integrity, privacy, and rollback

- Backup/portable tests reject traversal, absolute paths, duplicate entries, symlinks, unknown schemas, missing required references, wrong passwords, authenticated tampering, and plaintext private-user/secret material.
- Deleted attachment bytes cannot enter new exports; stale jobs and approvals cannot commit after restore; a failed restore cannot change the active pointer.
- Historical prices never become current listings; expired observations leave current budgets; target events are idempotent across edit, restart, catch-up, and restore.
- Rollback keeps V2 readers and the isolated legacy case runtime, disables new writers/projections by flag, and never deletes immutable V3 data. Data rollback requires a verified backup and pointer-level restore.

## Not implemented or not yet evidenced

1. No repository artifact contains the required independent, not-used-for-tuning physical ATX, ITX, and NAS holdouts for measured clearance, minimum cable length, reproducible temperature interval, and standardized hardware-acoustic interval.
2. The exact N6 phase-A canary is now executable and records eight passing checks plus two precise evidence blockers. Phase B and the cross-product blank-plan canary still lack one passing end-to-end release artifact.
3. The deployed runtime has not been migrated. A real apply requires an operator-reviewed dry-run report and source-manifest hash, an external verified backup, a maintenance window, and rollback readiness.
4. Remote push, production deployment, and post-deploy verification have not run and require explicit user approval after local review.
5. Live retail coverage and optional model-provider behavior were not tested; no external request was made. The platform must continue to show unavailable/unknown where live evidence is absent.
6. Geometry remains a bounded planning model rather than manufacturer CAD; thermal is not CFD; hardware acoustic intervals are not room-noise predictions.

## Next release actions

1. Capture and review the three physical holdout datasets with exact plan/instance/instrument/method/error scope.
2. Supply reviewed official document bytes for the exact i5-14500, Samsung 980 PRO variant, and SSR-850FX facts required by the phase-A canary; then rerun it to green.
3. Run and record phase B and the non-N6 blank-plan release canary, including worker restart and portable/full-restore round trips.
4. Review local commit `30b0ed0` plus the canary follow-up commit before any remote action.
5. Generate the real runtime V2-to-V3 dry-run report without writes and present its manifest for approval.
6. After explicit approval, push the reviewed commits, execute the Osaka release gate and deployment, then verify public health, one authoritative evaluation, persistence across restart, and strict Doctor.
