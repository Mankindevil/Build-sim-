# Roadmap

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

## Next up

| Track | State |
|---|---|
| Part rotation | Every geometry box is axis-aligned today. Angled cards and cable bend radius need θ before routing verdicts can be more than `warn` |
| Install corridors | Only five part families declare a travel (`assembly.json`); trays, PSUs and the board have none, so nothing orders around them. Each addition needs a stated basis, not a guessed millimetre |
| Channel capacity | Cable cross-section vs. waypoint aperture, and minimum bend radius: both need wire gauge and vendor bend limits the catalog does not carry (see the routing spec's deferred section) |
| Legacy shell reduction | Continue extracting the remaining detail-panel template only after the current uncommitted UI work is integrated; do not risk silently dropping working controls |
| Public hosting | Authentication, tenancy, application rate limiting, backup/restore automation, and deployment-specific hardening remain prerequisites |

## V2.1 (explicitly later)

- Price **history** series + optional SMZDM OpenAPI over the same snapshot schema
- Post-build calibration (wall power, temps, SMART, noise)
- Richer spatial views / product textures on 3D envelopes (manual pages remain evidence only)

## Future (not scheduled)

- Additional case adapters beyond JONSBO N6
- General ATX / mATX / ITX desktop build flows
- Multi-board catalogs without a locked NAS baseline
