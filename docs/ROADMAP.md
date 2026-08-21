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
| Wiring | 9-bay paths + backplane + checklist in existing Wiring tab |
| Config | JSON / checklist export-import in Configure header |
| Maintainability | Case `profile.json` + shared `needsHba` policy |
| Price | Auditable JD/TB/PDD **snapshots** (`data/prices/`; see `docs/PRICE_SNAPSHOTS.md`) |

## V2.1 (explicitly later)

- Price **history** series + optional SMZDM OpenAPI over the same snapshot schema
- Post-build calibration (wall power, temps, SMART, noise)
- Richer spatial views / product textures on 3D envelopes (manual pages remain evidence only)

## Future (not scheduled)

- Additional case adapters beyond JONSBO N6
- General ATX / mATX / ITX desktop build flows
- Multi-board catalogs without a locked NAS baseline
