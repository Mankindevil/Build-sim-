# Provenance

## Primary Codex thread

- Session id: `01a018a5-d534-7be3-90cf-24ebf45ab620`
- Rollout: `~/.codex/sessions/2026/08/19/rollout-2026-08-19T15-11-56-01a018a5-d534-7be3-90cf-24ebf45ab620.jsonl`
- Visualization bundle: `~/.codex/visualizations/2026/08/19/01a018a5-d534-7be3-90cf-24ebf45ab620/`

## Related Codex sessions (build / fork / review)

| Session file | Role |
|---|---|
| `…/08/20/rollout-…-01a01e3f-…` | Request for interactive HTML |
| `…/08/20/rollout-…-01a01e76-…` | 3D / heatmap refinement asks |
| `…/08/20/rollout-…-01a01e45-…` / `01a01ec2` / `01a01ed6` | Large forked build sessions |
| `…/08/20/rollout-…-01a01e16-…` | Full layout / power / alternatives |

## Locked purchased anchors (user transaction prices)

| Part | Paid (CNY) | Notes |
|---|---:|---|
| JONSBO N6 | 629 | MSRP / JD-PDD history: unknown |
| ASUS Pro WS W680M-ACE SE | 2,799 | MSRP / history: unknown |
| Intel Core i5-14500 | 1,380 | Intel tray/box USD is not CN retail MSRP |

## JONSBO N6 manual page citations

Manual has no text layer; pages read from the scanned images in
`public/assets/reference/` (`n6-pN.jpg` shows printed page `N-2`).

| Manual section | Page | Fact used |
|---|---|---|
| §8 下置电源安装 | 9 (`n6-p11.jpg`) | Bottom bay is SFX-only, on the lower PSU rack; step 8.1 removes the **left fan bracket** |
| §9 双电源安装位置 | 10 (`n6-p12.jpg`) | "supports dual power supply installation and **independent power supply for hard disk backplane**"; combos ATX+SFX and SFX+SFX |
| §11 整理线缆 | 12 (`n6-p14.jpg`) | CPU + HDD power route through area A, fan + SATA data through area B |
| §13 硬盘背板供电连接 | 14 (`n6-p16.jpg`) | 4 inlets = **SATA×2 + PATA(Molex)×2**; fill all four; **one PSU lead per inlet, daisy-chaining discouraged**; 13.1 removes the fan bracket for access |
| §14 风扇安装 | 15 (`n6-p17.jpg`) | Mounts: front 120×2 **or** 140×2 (240 rad) / **left side 120×2** / right side 120×2 / rear 120×1. No airflow, static pressure or coexistence matrix is published, and no fans ship with the case |

§8.1 and §14 together settle a constraint the sim previously only hinted at: the left-side
120×2 mounts sit **on the bracket the bottom PSU rack requires you to remove**, so a bottom
SFX and that fan pair are mutually exclusive — four side-fan mounts become two.
Encoded as `fanMounts` and consumed by `leftFanMountAvailable` in `src/core/thermal.ts`.

Encoded in `data/cases/jonsbo-n6/profile.json` (`backplanePower`, `bottomPsu`) and audited by
`checkBackplaneHarness` in `src/wiring/plan.ts`.

## PSU cable inventory (vendor pages)

The case rule is about **cables**, but most vendors publish only **connector totals**, so
`HarnessSpec` tracks both and `leadEvidence` stays `unknown` until a cable table is found.

| SKU | Source | SATA leads / conn | Molex leads / conn |
|---|---|---|---|
| Corsair SF750 ATX 3.1 (`CP-9020284`) | [product page](https://www.corsair.com/ww/en/p/psu/cp-9020284-na/sf-series-sf750-fully-modular-80-plus-platinum-sfx-power-supply-cp-9020284-na) cable table + [SF ATX 3.1 explorer page](https://www.corsair.com/us/en/explorer/diy-builder/power-supply-units/sf750sf850sf1000-platinum-atx-31-everything-you-need-to-know/) | **2** / 8 | **1** / 3 |
| Corsair SF1000 ATX 3.1 (`CP-9020257`) | same explorer page; cross-checked against a PDD listing spec image (`public/assets/reference/corsair-sf-cable-spec-pdd.png`) | **2** / 8 | **1** / 3 |
| SilverStone SX750-G | [official product page](https://www.silverstonetek.com/en/product/info/power-supplies/SX750Gold/) — connectors only; manual notes a 60W ceiling per peripheral connector | unknown / 8 | unknown / 3 |
| FSP DAGGER PRO 850W ATX 3.1 (`SDA2-850 GEN5`) | [official page](https://www.fsplifestyle.com/us/product/DAGGERPRO850W_GEN5.html) + [LanOC photos](https://lanoc.org/review/power-supplies/fsp-dagger-pro-850w-psu?start=2) — the two peripheral cables are **mixed**: 2×SATA+1×Molex+FDD and 3×SATA+1×Molex | 2 / 6 | 2 / 2 |
| Seasonic FOCUS GX-850 | [Cybenetics (ATX v3.1)](https://www.cybenetics.com/evaluations/psus/2573/en/) + [TechPowerUp (ATX 3.0)](https://www.techpowerup.com/review/seasonic-focus-gx-atx-3-0-850-w/2.html) cable tables | **2** / 8 | **1** / 3 |

The whole Corsair SF series ships **one** peripheral cable, so it cannot give each of the
four N6 inlets its own lead: `checkBackplaneHarness` returns `bad` with `daisyChainOnly`.

### No candidate PSU satisfies one-lead-per-inlet as shipped

Two independent walls, and each SKU hits at least one:

| SKU | Form | Peripheral sockets | Molex leads in box | Verdict |
|---|---|---|---|---|
| Corsair SF750 / SF1000 | SFX | 3 (inferred) | 1 | `bad` — socket-limited |
| SilverStone SX750 | SFX | 3 (inferred, from the Platinum panel) | unknown | `bad` — socket-limited |
| FSP DAGGER PRO 850W | SFX | **2** (official) | 2, but on shared SATA+Molex cables | `bad` — socket-limited |
| Seasonic FOCUS GX-850 | ATX | 4 (inferred) | **1** | `bad` — one Molex lead short |

So ATX is *not* automatically compliant. The GX-850 clears the socket wall but still ships a
single Molex cable, and the two PATA inlets are physically typed — spare SATA leads cannot
substitute, and a SATA→Molex adapter would re-concentrate the spin-up surge on an
already-loaded lead. The ATX route is the only *fixable* one: buy one more same-generation
Seasonic peripheral cable, after counting the panel sockets by hand (the 4 is inferred from
the ATX 3.0 bundle, and the ATX 3.1 sample ships only three peripheral cables).

Socket counts for `psu.seasonic-focus-gx-750-v5` and `psu.gw-f8-850` remain `unknown`; they are
not evidence of compliance.

### PSU-side socket ceiling (why buying a cable does not fix it)

No Corsair page or manual states how many modular sockets the panel has. Two independent
sources agree on three SATA/PATA sockets:

- `public/assets/reference/corsair-sf-modular-panel.png` — Type-5 panel artwork from the SF1000
  listing. Counted from the image: `PCIe / CPU` **6**, `SATA / PATA` **3** (1 mid-left + 2
  lower-left), `MOTHERBOARD` **2** wide sockets — 11 total.
- [Hardware Busters SF750 (2024) teardown](https://hwbusters.com/psus/corsair-sf750-atx-v3-1-psu-review/2/)
  counts **nine sockets** total on the SF750, and notes the 12V-2x6 cable occupies two 8-pin
  sockets rather than a dedicated one. 9 − 2 (24-pin) − 3 (peripheral) leaves 4 in the 8-pin group.

The two sources disagree on the 8-pin group only (6 on the SF1000 artwork vs 4 derived for the
SF750), which is expected across models in a series. They agree on the number that decides the
backplane question: **the peripheral group is 3 sockets on both**. The per-group split is stored
as `modularPanel` and drawn socket-by-socket in the wiring panel, so any future correction shows
up visually instead of hiding in a total.

The same ceiling shows up across the SFX form factor, which is why it reads as a rear-panel
area limit rather than a Corsair choice:

- [EnosTech SX750 Platinum](https://www.enostech.com/silverstone-sx750-platinum-sfx-psu-overview/)
  itemises all 8 sockets — top row 1 peripheral + 3 CPU/PCIe + 1 sense, bottom row 2 peripheral
  + 24-pin — so **3** are peripheral. [Tom's Hardware](https://www.tomshardware.com/reviews/silverstone-sx750-platinum-sfx-power-supply-review)
  independently notes only three sockets serve EPS and PCIe on that panel.
- [LanOC](https://lanoc.org/review/power-supplies/fsp-dagger-pro-850w-psu?start=2) and
  [APH Networks](https://aphnetworks.com/reports/fsp-dagger-pro-850w/2) both describe the FSP
  DAGGER PRO panel as "**two** 5-pin vertical plugs for the peripheral cables".

Three sockets are fully consumed by the bundled 2× SATA + 1× PATA cables, so the spare
Type-5 peripheral lead (`accessory.corsair-type5-peripheral-cable`, `CP-8920315`) has nowhere
to plug in on SF750 / SF1000. `checkBackplaneHarness` therefore fails on `socketLimited`
before it even looks at lead counts.

## Seagate Exos X24 power

[Product manual §2.5](https://www.seagate.com/content/dam/seagate/assets/support/internal-hard-drive/enterprise-hard-drives/exos-x24/_shared/files/Seagate_EXOS24_CMR_ISE_SED\(10-12-16-20-24TB\)_Rev-C.pdf)
gives a typical 12V startup peak of **2.6A** (optionally 2.0A via Smart Command Transport);
the [datasheet DS2080](https://www.seagate.com/content/dam/seagate/en_sg/content-fragments/products/datasheets/exos-x24/exos-x24-DS2080-2307US-en_SG.pdf)
gives idle 6.3W and max operating 8.9W. Used by `spinUpLoad` to size the surge one shared
lead would have to carry, and by `computeThermal` as the per-drive chamber load.

## Data path: HBA ports and which breakout fits what

The board exposes 4 native SATA plus a SlimSAS port that can carry 4 more, so eight SATA
devices is the native ceiling. Both counts live on the board SKU
(`board.asus-w680m-ace-se` → `nativeSataPorts` / `slimsasSataPorts`, manual p.1-9), not on
the case profile: the case has trays, the board has ports, and only the latter changes
when you swap boards. `needsHba` adds them up instead of reading a stored threshold, so
the trigger cannot drift away from the ports it describes. A board with no audited counts
reports zero and forces an HBA rather than inheriting this one's ports.

Those four SlimSAS ports are conditional, and the condition is now modelled rather than
assumed. `w680m.storage.slimSasModes` records `simultaneousModeUse: false`: the connector
is four PCIe lanes that firmware gives either to one NVMe drive or to four SATA ports, never
both. With only two M.2 slots on the board, a third NVMe has nowhere else to go — so
`selection.nvmeCount > m2Slots` flips `slimsasMode` to `nvme`, zeroes `slimsasSata`, and the
board ceiling drops 8 → 4. Previously the four were counted unconditionally, which was
correct only because the UI offered no way to add a third NVMe.

Neither the third drive nor the SlimSAS-to-NVMe adapter has an audited MPN, so both are
raised as `unknown` checklist items instead of being invented into the BOM. Its physical
position is not in the geometry model either, and the warning says so.

Three facts the planner now enforces, because getting any of them wrong buys the wrong part:

- **Port count is a ceiling.** `hba.lsi-9300-8i-it` has `ports: 8` across two SFF-8643
  connectors (4 lanes each). Nine data drives therefore cannot all land on the card; the
  ninth falls back to a board port and `planN6Wiring` emits a warning about running two
  controllers. Earlier the planner labelled it `HBA P8`, a port that does not exist.
- **The board is a ceiling too.** Board fallback stops at `nativeSataPorts +
  slimsasSataPorts`. A bay past both controllers is emitted as `target: "none"` with a
  warning, because the alternative — printing a SlimSAS lane that does not exist — is a
  plan you cannot build.
- **SFF-8643 ≠ SFF-8654.** The HBA takes Mini-SAS HD (SFF-8643,
  `accessory.minisas-hd-4xsata`); the board's extra lanes take SlimSAS (SFF-8654,
  `accessory.slimsas-4xsata`). The plugs are not interchangeable, so they are separate
  SKUs and the BOM is derived from the checklist rather than from a second copy of the
  branch logic.

Both breakout SKUs stay `unknown` on price: no MPN has been audited yet.

The HBA draws from the PCIe slot, so it never touches the PSU peripheral leads — the
backplane's four-lead requirement is unchanged by fitting one. Card cooling and slot
width are separate questions: the x4 slot's open-ended status is not confirmed in our
board data, so `hba.slot-width` is raised as `unknown` when a GPU takes the x16.

## Lower-chamber structure (why the bottom half is not empty)

Manual §8.1–8.3 p.9 and §13.1 p.14 (both imported under `public/assets/reference/`) settle the
structural relationships; neither gives a single dimension for these parts.

- The left fan bracket is held by **four screws** and carries the left 120×2. It must come off
  to reach the backplane power inlets at all (§13.1), and when a bottom PSU is fitted the
  **shipped PSU rack replaces it** and it does not go back (§8.1–8.3: remove bracket → mount
  SFX on the rack → refit the rack).
- The four backplane inlets sit in one row, **SATA×2 then PATA×2** (§13 figure).

`profile.json.lowerChamber` records exactly that and nothing more. Everything geometric —
the tray cage, the backplane PCB outline, the bracket and rack plate shapes — is a planning
envelope drawn as `inferred`, because the manual gives no outline, thickness or hole
positions. `buildN6Slots` registers `backplane.pcb`, `tray.frame` and `fan.left_bracket` so
the space they occupy is not modelled as free, and the bracket is declared `exclusiveWith`
`psu.bottom_sfx`.

While adding these, one drawing error surfaced and was corrected: the left drive-bay fans
were anchored at y = −77, which put a 120 mm frame through the y = −38 deck. The lower
chamber is only ~119 mm tall, so they now sit centred at y = −99.

## Geometry: one frame, and what its numbers are worth

`data/cases/jonsbo-n6/geometry.json` is the only place a millimetre is written down. It used to
be three places that disagreed: pixel constants in the V1 canvas, slot names in the occupancy
engine, and a hand-tuned gradient in the heatmap. Whichever one you read, you could not tell
whether the others agreed.

**Frame.** Origin is the geometric centre of the case envelope; `x` is width (positive right),
`y` height (positive up), `z` depth (positive rearward). For the N6's 305 × 353 × 318 that puts
every envelope point inside `|x| ≤ 152.5`, `|y| ≤ 159`, `|z| ≤ 176.5`. Boxes are stored centred
(`{ c, w, h, d }`) because an anchor is reasoned about that way — "the tray stack is centred
96 mm forward of the middle" — and `toBoxMm` is the single conversion to the min-corner form the
overlap test wants.

**Two evidence tags per part, not one.** `sizeEvidence` and `anchorEvidence` are separate fields
because they almost never match: a 3.5″ drive body is the standard `101.6 × 147 × 26.1`
(`standard`) sitting at a tray pitch nobody published (`inferred`). Collapsing them into one
label would either promote a guessed position to official or bury a measured dimension.

| Layer | Status | Basis |
|---|---|---|
| Case outer envelope, interior height | `official` | JONSBO spec sheet + manual §1 |
| mATX board outline, M.2 2280 length, LGA1700 keep-out, 3.5″ drive body | `standard` | Form-factor standards / vendor datasheets |
| Drive tray pitch, backplane PCB outline, deck height, PSU rack plate | `inferred` | Reconstructed so the parts stack inside the published interior; the manual gives no outline, thickness or hole positions |
| Absolute anchor of anything mounted on the board (M.2 slots, SATA cluster, DIMM row) | `inferred` | Board manual figures are schematic; no dimensioned drawing exists |
| Part rotation | **not modelled** | Every box is axis-aligned. A card at an angle, a cable's bend radius and any tolerance stack are outside this model |

**Collisions are measured, not bookkept.** Each part carries an AABB, and a conflict is the
intersection volume of two of them — so the answer comes with a number and a drawable box
(`kind: "conflict"`) instead of a slot-name coincidence. Pairs linked by `mountedOn` or sharing a
`group` are exempt, because a cooler is *supposed* to interpenetrate its CPU.

Verdicts are graded by evidence, not by depth. A `bad` requires both anchors to be `official` or
`standard`: a box whose position is a planning reconstruction cannot prove incompatibility, however
deep the overlap looks, so those come back as `warn` with the reason said out loud. Intrusions into
a clearance volume are always `warn` — losing service space is a trade-off, not a failure to
assemble.

That exemption is why the cooler is three parts (`cooler.base`, `cooler.column`,
`cooler.overhang`) rather than one block: as a single solid it reported a false hit against the
M.2 heatsink it actually clears, and giving the column a `slotId` merged its envelope back into
the base. Two conflicts the model found in its own data, both real and both previously invisible:
M.2 #1 sat 1.8 mm inside the HBA envelope, and the deck was drawn below the drive cage.

## Port anchors: reconstructed positions, and what follows from that

`data/cases/jonsbo-n6/routing.json` adds connectivity on top of the geometry: where each
connector sits, and which holes a cable may pass through. **Not one coordinate in it is
published.** The W680M-ACE SE manual draws the SATA cluster, the 24-pin and the EPS socket
schematically; the N6 manual §13 shows four backplane inlets in a row without positions; §11
circles two cable areas (A and B) without an opening, an aperture or a section. So every entry
carries `anchorEvidence: "inferred"` and its own `source` line, and three rules follow:

- **No routing verdict may exceed `warn`,** and every message ends with "接口锚点为按手册图示重建的推算值，需实物核对". This matches the rule the envelope conflicts already use: a reconstruction cannot prove incompatibility.
- **A port is a face plus an offset,** never an absolute point. Swap a 140 mm PSU for a 180 mm one and its sockets move 40 mm forward, because the rear panel is what stays put; move the unit from the rear shelf to the front bay and `whenSlot` turns the modular face around. Writing absolute coordinates would recreate the second source of truth the geometry round just deleted.
- **A missing path is a gap in the manual, not a verdict.** When the graph has no route the finding says the path is undocumented and asks for a physical check; it never claims the cable cannot be fitted.

The two deck openings are the most consequential guesses in the file. Manual §11 routes drive
power through area A and SATA data through area B, and in both cases one end of the cable is in
the other chamber — so an opening must exist in each. Its size and position are ours. Take those
two waypoints out and no cable reaches the lower chamber without cutting through the deck, which
is exactly how the model reports it.

## Insertion clearance: the space a hand needs, not just the part

Each port declares `insertionMm` and a plug section, and `insertionSweep` extrudes that section
along the face normal. Anything solid inside that volume is reported, with the depth it reaches
and the part named. The port's own part, its parent and its children are exempt — a socket is
supposed to be inside the component carrying it.

This is what turns "it fits on paper" into "it fits with the cable attached". A worked example
from the baseline build: with a rear-upper ATX unit, the HBA's second SFF-8643 connector has the
PSU 27.9 mm into its upward sweep. Where the obstruction stops short of the socket plane, the
finding says an angled connector is the fix (`routing.needs-angled-connector`) rather than
reporting a generic warning — the difference between a part to buy and a wall.

Cable lengths are reported the same way: `requiredLengthMm` is the polyline plus a declared 15%
assembly slack (`SERVICE_SLACK`, an allowance, not a physical quantity). A cable SKU with no
`lengthMm` in the catalog yields `unknown` plus "at least X mm", because inventing a length is
how a wrong cable gets bought.

Both the routing table and the isometric overlay read the solved runs, never their own copy: each
`insertion` entry carries the very sweep box the check tested, so a dashed box in the preview is
the volume that produced the finding. The table's status column separates the three kinds of doubt
it can report — an obstruction, a length that is too short, and a length nobody published — since
"we found a problem" and "we cannot tell" are not the same answer. Waypoints of kind
`deck_opening` are marked in the route, because a cross-chamber run is only as good as an opening
whose size and position the manual never states.

## Assembly order: derived from corridors, except where the manual says it outright

`src/core/assembly.ts` produces the order; nothing in this repo stores a list of steps. Three
things decide it:

- **The mounting tree.** `mountedOn` already says a cooler bolts to the CPU and the bottom PSU
  bolts to the shipped rack, so it also says which of the two goes in first.
- **Install corridors.** Each family in `data/cases/jonsbo-n6/assembly.json` declares the travel a
  part makes on its way to its seat (`+y`, `"self"` for a DIMM: it has to clear the slot by its own
  height). `installSweep` extrudes that corridor from the entry face **excluding** the seat — a
  part in the seat is a collision, which the occupancy engine owns; a part in the corridor is an
  ordering question, which this module owns. Whatever stands in A's corridor goes in after A.
- **Plug access.** A connector something will later cover has to be plugged first, which comes
  straight from the insertion sweeps the routing module already computed.

Every travel value is a reconstruction: no manual and no vendor sheet publishes an insertion
travel. So a derived edge is `inferred`, and the finding it produces is phrased as later servicing
("swap the memory afterwards and this cooler comes off again") rather than as a defect.

What the manual states outright stays a **declared** rule in that same file, with its section
number and `official` evidence — §13.1 takes the left fan bracket off before the backplane inlets
are wired. That rule is not derivable here: the bracket panel we reconstructed does not intersect
those inlets' sweeps, so the geometry would never have found it. A declared rule addresses steps by
pattern, so it names the backplane end of the power runs and nothing else. It also disappears on
its own once a bottom PSU replaces the bracket, because the bracket is then absent from the
geometry — the §8 behaviour falls out of the data rather than a second hand-written branch.

A removable part that has to come off produces a pair of steps around the work it blocks, which is
what "take it off, wire it, put it back" actually is. Where the obstruction is structure the manual
never shows removing, no order can help, and that is reported as a finding instead of being
quietly reordered. Same for a loop: if two steps each demand to be first, the loop is named. Two
rules that used to be typed into the UI — the fan bracket note in `wiring/plan.ts` and the
"swapping memory means pulling the IS-55" warning in `v1-runtime.js` — are now this module's
output, one declared and one derived.

## Thermal field: an interpolation of the 0D result, and nothing more

The heatmap is drawn by `src/core/thermal-field.ts`, which adds **no physics** to
`computeThermal`. Every source temperature is a number that model already produced; the module
places it at the part's real centroid and decays it with distance so a picture can exist.

- σ per axis is the part's own half-extent plus a fixed 26 mm spreading length, so a 147 mm drive
  reads as a bar and a CPU die as a point. That 26 mm is a drawing choice, not a measurement.
- Sources superpose root-sum-square and clip to the hottest declared source: two independent hot
  parts do not add their full rises, and nothing in a lumped model justifies a point hotter than
  its own inputs.
- The deck blocks diffusion (`y = −23` in the N6 data). The 0D model treats the case as two chambers coupled
  only through a bottom-mounted PSU, so smearing CPU heat onto the drive cage would contradict
  the model being drawn. With a bottom PSU fitted, one declared coefficient
  (`BARRIER_LEAK_COUPLED = 0.35`) lets a bounded fraction across — the manual publishes no
  opening geometry, so this is a stated number, not a derived one.
- Both bounds are sampled and shown separately; the optimistic surface is never presented alone.

What it therefore cannot show: velocities, pressure drop, recirculation, or a hot spot that is
not already a component in the 0D result. The legend names the node behind each peak so a reading
can be traced back rather than trusted. Invariants are pinned in `tests/thermal-field.test.ts`.

## Thermal model: what is physics and what is a guess

`src/core/thermal.ts` is a lumped-parameter (0D) air balance, not CFD. It cannot produce local
velocities, pressure drops or hot spots. The split matters, so it is explicit:

| Layer | Status | Basis |
|---|---|---|
| ΔT = Q / (ρ·cp·V̇) | **Exact** | Energy conservation. Dry air at 25 °C: ρ = 1.184 kg/m³, cp = 1005 J/(kg·K) → **0.562 W/(K·CFM)** |
| Chamber heat load | `official` | Exos X24 datasheet watts × drive count; PSU loss from `dc·(1/η − 1)` |
| Fan free-air CFM | `inferred` | Planning envelope per size and RPM band; no fan SKU is locked, and free-air ratings assume zero back-pressure |
| System impedance derate | `inferred` | ×0.35–0.65 for filters + backplane + nine trays; JONSBO publishes no P-Q curve, so it cannot be back-solved |
| Passive leakage (no fan) | `inferred` | 2–6 CFM buoyancy envelope, deliberately wide |
| HDD case-to-air θ | `inferred` | 0.8–1.9 K/W; Seagate publishes an operating range, not a resistance. Narrowable from SMART temperatures after assembly |
| Bottom PSU airflow direction | **`unknown`** | Manual §8 draws mechanical fitment only. Results therefore span "exhausts out of the case" to "dumps all loss into the drive chamber" |

Every one of these is returned in `ThermalResult.assumptions` with its own evidence label, and
`ThermalResult.evidence` degrades to the weakest input — a bottom-PSU build is `unknown`
overall, by construction.

## Imported local references

- `data/cases/jonsbo-n6/jonsbo-n6-manual.pdf`
- `data/boards/asus-w680m-ace-se/asus-w680m-manual.pdf`
- `data/constraints/constraint-registry.json`
- `data/boards/asus-w680m-ace-se/memory-price-audit.md`
- `data/prices/latest.json` (+ `manual-quotes.json`, dated `snapshots/`)
- `public/assets/reference/corsair-sf-cable-spec-pdd.png` (user screenshot, SF-series cable spec)
- `public/assets/reference/corsair-sf-modular-panel.png` (user screenshot, Type-5 socket panel)
- `docs/PRICE_SNAPSHOTS.md`
- `legacy/v1/n6-build-preview.html` (+ standalone snapshot)
