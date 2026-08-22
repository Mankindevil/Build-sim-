# Roadmap

## Done (V1 import)

- Interactive N6 preview (primary UI at `index.html`)
- Local manuals + appearance assets under `public/assets/`
- Constraint registry with evidence levels
- Scenario / assertion QA corpus (`tests/config-scenarios.json`)

## V2.0 (in progress) — extend V1 in place

| Track | Status |
|---|---|
| SKU | Catalog-driven selects (SKU ids); appearance gallery follows selection |
| Engine | `evaluateBuild` feeds FIT chip + wiring panel |
| Geometry | One mm source (`geometry.json`) in one case-local frame; volumetric AABB conflicts, graded by evidence |
| Thermal field | Heatmap sampled from the 0D result at real part centroids; deck blocks diffusion; both bounds drawn |
| Wiring | 9-bay paths + backplane + checklist in existing Wiring tab |
| Config | JSON / checklist export-import in Configure header |
| Maintainability | Case `profile.json` + shared `needsHba` policy |
| Price | Auditable JD/TB/PDD **snapshots** (`data/prices/`); variant-level prices, opening prices marked non-auditable, amazon.com reference-only (see `docs/PRICE_SNAPSHOTS.md`) |

## Next up

| Track | State |
|---|---|
| Cable routing | Phases 1–2 done — `routing.json` port anchors and waypoint graph, `src/core/routing.ts`, the four checks in `evaluateBuild`, the routing table in the wiring tab and the polyline overlay in the isometric view. Phase 3 (`assembly.ts` ordering) still open. Spec: `docs/superpowers/specs/2026-08-22-cable-routing-design.md` |
| Part rotation | Every geometry box is axis-aligned today. Angled cards and cable bend radius need θ before routing verdicts can be more than `warn` |

## V2.1 (explicitly later)

- Price **history** series + optional SMZDM OpenAPI over the same snapshot schema
- Post-build calibration (wall power, temps, SMART, noise)
- Richer spatial views / product textures on 3D envelopes (manual pages remain evidence only)

## Future (not scheduled)

- Additional case adapters beyond JONSBO N6
- General ATX / mATX / ITX desktop build flows
- Multi-board catalogs without a locked NAS baseline
