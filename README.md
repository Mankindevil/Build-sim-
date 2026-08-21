# PC Build Sim

Modular desktop / NAS build simulator.

**UI rule:** V2 **extends** the V1 interactive Build Lab in place — same spatial preview, thermal field, wiring, and BOM panels. No separate workbench product UI.

**Current focus (v0.2 / V2.0):** JONSBO N6 + ASUS Pro WS W680M-ACE SE + i5-14500  
**Later:** pluggable cases and general desktop builds

## V2.0 scope

1. **Exact SKU library** — concrete models; dropdown values are SKU ids from `data/skus/catalog.json`.
2. **Unified occupancy / conflict engine** — drives the existing FIT chip and wiring panel via `evaluateBuild`. Every millimetre lives in `data/cases/jonsbo-n6/geometry.json`, in one case-local frame (origin at the envelope centre; `x` right, `y` up, `z` rearward), and both the engine and the preview read it. Conflicts are **volumetric**: an overlap is a measured AABB intersection with a drawable box, not a slot-name coincidence, and `mountedOn` pairs are exempt because a cooler is supposed to interpenetrate its CPU. A `bad` verdict needs both anchors evidenced — a reconstructed anchor can only raise `warn`. Frame and per-part evidence split: `docs/PROVENANCE.md`.
3. **Full wiring plans** — per-bay paths + backplane feeds + cable checklist (same Wiring tab), plus a socket-level **PSU panel diagram**: every modular socket of the selected PSU, which cable occupies it, and which backplane inlet ends up sharing a lead or getting none. Panels are drawn only from counted evidence; uncounted groups are left blank rather than implied. Data paths respect the HBA's real port count — the ninth drive falls back to a board port instead of a port the card does not have — and Mini-SAS HD (SFF-8643) breakouts are billed separately from the board's SlimSAS (SFF-8654) cable.
   **Lower-chamber structure** (spatial preview) — tray cage, backplane PCB with its four inlets, and either the removable left fan bracket or the shipped bottom-PSU rack that replaces it, so the bottom half reads as occupied space rather than void. Shapes are planning envelopes; only the structural relationships are from the manual.
   **Air balance** (Thermal tab) — `ΔT = Q /(ρ·cp·V̇)` per chamber, so airflow is a first-class input instead of a fudge offset. Fan CFM, case impedance and drive θ are labelled planning envelopes; the bottom-PSU / drive-bay coupling is bounded, not guessed. See `docs/PROVENANCE.md` for the physics-vs-guess split.
   **Thermal field** (spatial preview) — the heatmap is sampled from that same result at the same part centroids, so a millimetre on the canvas is a millimetre in the case and every hot spot names the component behind it. It interpolates a 0D model and adds no physics: it cannot exceed its hottest source, the deck blocks diffusion unless a bottom PSU couples the chambers, and both bounds are drawn rather than the optimistic one alone. Not CFD — no velocities, no pressure drop.
   **Cable routing** (phase 1, no UI yet) — connectors are declared as a face plus an offset in `data/cases/jonsbo-n6/routing.json`, so they travel with their part when a PSU gets longer or moves to another bay. Cables are routed over a waypoint graph, which is why the deck stops a run: nothing crosses it except a declared opening. Four checks per run — insertion clearance, required length, connector orientation, blocked access — and every one caps at `warn`, because not one anchor in that file is published.
4. **Config save / load** — export/import JSON and checklist from the Configure header.
5. **Official appearance** — gallery switches with the selected SKU; missing art stays unknown (not V2.1 3D texture mapping).

**Price:** auditable snapshots in `data/prices/` (see `docs/PRICE_SNAPSHOTS.md`).  
`npm run price:serve` starts a local-only collector; the 价格与配件 tab then fetches 京东/淘宝/拼多多/亚马逊/官网 candidates and only writes a quote after you confirm the listing. Part numbers are used where they index (京东/亚马逊/官网) and spec keywords where they don't (淘宝/拼多多). A search card quotes the listing's **cheapest** variant, so a card price is stamped as an opening price and cannot be audited — an auditable number is read from the detail page's variant table, with the option's own wording stored beside it. amazon.com prices carry a declared exchange rate and stay reference-only. `npm run price:search` emits the same links as a clickable cheat sheet; `npm run price:refresh` rebuilds `latest.json`; `npm run price:fixture` captures a real card into `tests/fixtures/` so an extraction fix stays fixed. UI stamps `snapshot YYYY-MM-DD · platform` — never invents live market or history.

Deferred to **V2.1:** price history series, measured calibration, product textures on 3D envelopes.

## Quick start

```bash
npm install
npm run dev
```

Opens the N6 Build Lab. Change PSU/cooler/GPU/etc.; FIT + wiring update from the engine; appearance gallery follows SKU.

```bash
npm test
npm run build
```

## Layout

```
index.html              V1 Build Lab (primary UI)
src/lab/boot.ts         Boots catalog + engine into the lab
src/lab/v1-runtime.js   V1 interactive renderer (SKU-keyed)
src/lab/view-models.ts  SKU → display DTOs for the lab
data/skus/catalog.json  Exact SKU library (+ appearance)
data/prices/            Audited retail snapshots (latest + dated) + fx.json
scripts/price-refresh/  Snapshot rebuild + offline search cheat sheet
scripts/price-server/   Local-only price collector (APIs + headed browser, variant resolver)
data/cases/jonsbo-n6/   Case profile + geometry.json (single mm source) + assets
scripts/shot.mjs        Screenshots lab panels from the dev server (local check)
src/core/               Geometry + occupancy + evaluateBuild + policy + thermal air balance & field + cable routing
src/price/              Snapshot merge, search queries, title matching, plausibility gates
src/wiring/             Wiring plans + PSU panel socket plan
src/adapters/jonsbo-n6/ Case geometry + occupancy adapters
docs/superpowers/specs/ Designs written before the code (cable routing)
legacy/v1/              Frozen V1 reference HTML
```

## Evidence policy

Never present inferred geometry, heatmaps, or planning prices as manufacturer CAD, CFD, or measured data. If evidence is missing, the UI must say `unknown`.

## Provenance

See `docs/PROVENANCE.md` and `docs/ROADMAP.md`.
