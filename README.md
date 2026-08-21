# PC Build Sim

Modular desktop / NAS build simulator.

**Current focus (v0.2 / V2.0):** JONSBO N6 + ASUS Pro WS W680M-ACE SE + i5-14500  
**Later:** pluggable cases and general desktop builds

## V2.0 scope

1. **Exact SKU library** — concrete models with dimensions, power, harness, warranty, and price evidence (links + paid prices). No invented historical lows.
2. **Unified occupancy / conflict engine** — bays, PCIe, fans, PSU, radiator slots as one placement model; verdicts labeled `official` / `standard` / `inferred` / `unknown`.
3. **Full wiring plans** — per-bay data paths, backplane power feeds, port tables, cable BOM.
4. **Config save / load** — JSON configs, switch ATX/SFX/GPU/disk scenarios, export checklist.

Deferred to **V2.1:** live price tracking, measured calibration, richer product textures / views.

## Quick start

```bash
npm install
npm run dev
```

```bash
npm test
npm run build
```

## Layout

```
data/           Case, board, SKU, constraint, and saved config JSON
src/core/       Occupancy + conflict engine
src/sku/        SKU loaders and validation
src/wiring/     Port / harness planning
src/config/     Build config schema, import/export
src/adapters/   Case-specific adapters (jonsbo-n6 first)
src/ui/         Preview UI
legacy/v1/      Frozen N6 Build Lab HTML from Codex V1 (porting reference)
docs/           Roadmap and provenance
tests/          Engine + scenario tests
```

## Evidence policy

Never present inferred geometry, heatmaps, or planning prices as manufacturer CAD, CFD, or measured data. If evidence is missing, the UI must say `unknown`.

## Provenance

V1 interactive lab and manuals were imported from:

`~/.codex/visualizations/2026/08/19/01a018a5-d534-7be3-90cf-24ebf45ab620/`

See `docs/PROVENANCE.md` and `docs/ROADMAP.md`.
