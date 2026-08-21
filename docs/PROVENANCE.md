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
