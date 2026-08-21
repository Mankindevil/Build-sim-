# N6 Build Lab reference manifest

This folder is the single local reference set used by `n6-build-preview.html`.
Do not re-search these sources unless a revision check is explicitly needed.

## Mechanical manuals

| Local file | Source | SHA-256 | Usage |
|---|---|---|---|
| `jonsbo-n6-manual.pdf` | https://www.jonsbo.com/en/products/N6Black.html | `15f026946a18b5e4fc0ebf585f8b60ed8e3044f41efe699326adfa0ee3d480cd` | case envelope, drive trays, PSU topologies, supported fan/radiator positions, published compatibility ranges |
| `asus-w680m-manual.pdf` | https://www.asus.com/us/motherboards-components/motherboards/workstation/pro-ws-w680m-ace-se/helpdesk_manual/ | `dbb482ef25ababeae9d4d1063e176a78c0544f18dacffd16dc830a1a2f203d2e` | board dimensions, PCIe/M.2/SATA/SlimSAS connectors and slot relationships |

## Official product appearance sources

The cached files under `../assets/official/` are presentation thumbnails only.
They are not geometry/CAD references.

| Cached file | Official product page | Meaning |
|---|---|---|
| `n6.webp` | https://www.jonsbo.com/en/products/N6Black.html | N6 exterior appearance |
| `w680m.png` | https://www.asus.com/us/motherboards-components/motherboards/workstation/pro-ws-w680m-ace-se/ | motherboard appearance |
| `focus-gx.webp` | https://seasonic.com/focus-gx-atx-3/ | FOCUS GX family / revision reference; verify exact SKU before purchase |
| `axp90.png` | https://www.thermalright.com/product/axp90-x53-full-black/ | AXP90-X53 FULL BLACK appearance |
| `a4000.jpg` | https://www.nvidia.com/en-au/products/workstations/rtx-a4000/ | RTX A4000 appearance |
| `exos-x24.png` | https://www.seagate.com/ca/en/support/internal-hard-drives/enterprise-hard-drives/exos-x24/ | Exos X24 appearance |
| `980-pro.jpg` | https://www.samsung.com/us/memory-storage/nvme-ssd/980-pro-pcie-4-0-nvme-ssd-1tb-sku-mz-v8p1t0b-am/ | Samsung 980 PRO appearance; capacity shown by the photo may differ from the owned drives |

## Evidence tiers used in the UI

1. `official`: dimensions or positions explicitly stated by a manufacturer.
2. `standard`: form-factor envelope such as mATX, M.2 2280, 2.5-inch SSD, or 3.5-inch HDD.
3. `inferred`: reconstructed internal anchor, clearance, airflow, temperature, noise, or collision planning. It must never be presented as manufacturer CAD, CFD, or measured data.

## Incremental compatibility and price audit

`memory-price-audit.md` records the official W680M-ACE SE / i5-14500 memory
compatibility sources and the 2026-08-20 price-evidence policy. It is the local
index for DDR5 UDIMM/ECC/XMP decisions and for distinguishing user transaction
prices, current visible prices, planning estimates, official suggested prices,
and unknown historical lows.
