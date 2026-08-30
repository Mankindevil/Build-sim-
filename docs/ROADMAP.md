# Roadmap

> Status note (2026-08-30): U0-U11 are implemented and locally verified in the
> current worktree. U12 release engineering is in progress. Production flags,
> remote push, and deployment remain gated until physical holdouts, canaries,
> migration review, and explicit deployment approval are complete.

The authoritative plan is [Universal Hardware Platform Follow Plan](./superpowers/plans/2026-08-27-universal-hardware-platform-follow-plan.md).
It replaces the former “additional case adapters are unscheduled” position.
JONSBO N6 remains the first regression adapter, not the product boundary.

## Done (V1 import)

- Interactive N6 preview (primary UI at `index.html`)
- Local manuals + appearance assets under `public/assets/`
- Constraint registry with evidence levels
- Scenario / assertion QA corpus (`tests/config-scenarios.json`)

## V2.0 platform lifecycle (completed locally, not deployed)

| Track | Status |
|---|---|
| SKU | Catalog-driven selects (SKU ids); appearance gallery follows selection |
| Engine | `evaluateBuild` feeds FIT chip + wiring panel |
| Geometry | One mm source (`geometry.json`) in one case-local frame; volumetric AABB conflicts, graded by evidence |
| Thermal field | Heatmap sampled from the 0D result at real part centroids; deck blocks diffusion; both bounds drawn |
| Wiring | 9-bay paths + backplane + checklist in existing Wiring tab |
| Cable routing | Port anchors + waypoint graph (`routing.json`), four checks in `evaluateBuild`, routing table + isometric polylines |
| Assembly order | Derived in `src/core/assembly.ts` from the mounting tree, declared install corridors and plug clearances; manual rules stay declared with their section |
| Config | JSON / checklist export-import in Configure header |
| Maintainability | Case `profile.json` + shared `needsHba` policy |
| Price | Auditable JD/TB/PDD **snapshots** (`data/prices/`); variant-level prices, opening prices marked non-auditable, amazon.com reference-only (see `docs/PRICE_SNAPSHOTS.md`) |
| Plans | Active BuildPlan + PlanStore/PlanRepository, independent drafts, immutable versions, restore/archive, offline cache, and atomic Agent initialization from a pending blank-plan scaffold |
| 3D | Evidence-aware lazy Three.js scene with finding/route/dimension/thermal/assembly overlays and SVG fallback |
| Agent | Plan/evaluation/3D/purchase/task context; local SKU discovery; requirement-aware `plan-initializer`; allowlisted change and atomic initialization proposals require explicit human approval and server revalidation |
| Transactions | Staged review, exact plan-item links, version-at-capture, server archive, retry and privacy deletion |
| Build execution | Stable sourceRef tasks reconciled from BOM/assembly/wiring/findings; saved-version checklist hashes |
| Quality gates | Full lifecycle E2E, desktop/tablet/mobile screenshots, offline/corruption/failure tests, accessibility, cleanup and performance budgets |

## Universal platform implementation status

| Stage | State | Evidence class |
|---|---|---|
| U0 contracts and flags | Complete | Frozen contracts, registries, cross-runtime hash vectors, architecture gates |
| U1 runtime foundation | Complete | Generation coordinator, durable repositories/jobs, backup SPI, Doctor |
| U2 topology and plans | Complete | BuildConfig V3, requirements, scenarios, logical layout, V2 reader/migration |
| U3 facts and observations | Complete | Claims/facts/snapshots, reversible updates, conflict and evaluation locks |
| U4 evidence ladder | Complete | Official/third-party/inference/attachment jobs and durable approval |
| U5 adapters and capabilities | Complete | Generic manifests/runtime models, package supply, standards, provisional flow |
| U6 compatibility and solver | Complete | Progressive domains, requirement allocation, bounded solver and what-if |
| U7 systems and execution | Complete | Windows/Linux/TrueNAS profiles, firmware path, first boot, storage layout |
| U8 spatial and assembly | Complete | Generic geometry/routing/tolerance/electrical checks and procedures |
| U9 simulation | Complete | Workload-driven thermal intervals and standardized hardware acoustics |
| U10 price and recommendation | Complete | Durable observations/history/targets and purchase-eligible whole-build ranking |
| U11 unified experience | Complete | Requirements, solver, what-if, attachments, execution, jobs, portability, Doctor UI |
| U12 release gates | In progress | Software gates are green locally; physical holdouts, release canaries and deployment remain |

## Remaining before production-default rollout

| Track | Required evidence |
|---|---|
| Physical holdouts | Independent ATX, ITX, and NAS measurements for clearance, required cable length, temperature interval, and standardized hardware-acoustic interval |
| Release canaries | Recorded N6 partial/complete and non-N6 blank-plan flows, including worker restart and portable/full-restore round trips |
| Migration | Operator-reviewed V2→V3 dry-run manifest, verified external backup, apply report, post-migration diffs, and rollback rehearsal on a copy |
| Deployment | Full local report, clean reviewed commit, explicit remote/deploy approval, release-gate Compose profile, post-deploy health/evaluation/persistence/Doctor checks |
| Public hosting | Authentication, tenancy, application rate limiting, and deployment-specific policy remain outside the U0-U12 local/single-user product scope |

## V2.1 (superseded by the U plan where overlapping)

- Post-build calibration (wall power, temps, SMART, noise)
- Richer spatial views / product textures on 3D envelopes (manual pages remain evidence only)

## Future (not scheduled)

- Capabilities outside the authoritative U0–U12 contract (for example,
  multi-user tenancy or public-hosting features)
- Product behavior that would silently broaden the frozen safety, evidence, or
  topology boundaries
