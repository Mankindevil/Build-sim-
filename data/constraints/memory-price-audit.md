# W680M-ACE SE memory and price audit

Audit date: 2026-08-20 (JST). This note is the incremental reference for the
simulator. Reuse it instead of repeating the same searches; refresh only when
the user wants a new price snapshot or locks a concrete memory SKU.

## Official memory compatibility

- ASUS technical specifications:
  https://www.asus.com/us/motherboards-components/motherboards/workstation/pro-ws-w680m-ace-se/techspec/
  - Four DDR5 DIMM slots, up to 192 GB.
  - ECC and non-ECC unbuffered memory are supported; RDIMM/LRDIMM are not.
- ASUS CPU support table:
  https://www.asus.com/us/motherboards-components/motherboards/workstation/pro-ws-w680m-ace-se/helpdesk_qvl_cpu?model2Name=Pro-WS-W680M-ACE-SE
  - i5-14500 is listed and the table marks ECC-DIMM support as yes.
- ASUS memory QVL:
  https://www.asus.com/motherboards-components/motherboards/workstation/pro-ws-w680m-ace-se/helpdesk_qvl_memory?model2Name=Pro-WS-W680M-ACE-SE
  - The current filters include U-DIMM and ECC-UDIMM, 16/24/32/48 GB modules,
    and speeds up to 6600 MT/s.
  - A QVL entry is SKU-specific; it does not guarantee every kit at the same
    capacity/speed.
- Intel Core i5-14500 specification:
  https://www.intel.co.jp/content/www/jp/ja/products/sku/236784/intel-core-i5-processor-14500-24m-cache-up-to-5-00-ghz/specifications.html
  - Maximum memory 192 GB, two channels, DDR5-4800 / DDR4-3200, ECC supported.
  - The board is DDR5-only even though the CPU memory controller can also
    support DDR4 on a different motherboard.
- Intel W680 specification and platform brief:
  https://www.intel.com/content/www/us/en/products/sku/218834/intel-w680-chipset/specifications.html
  https://www.intel.com/content/dam/www/central-libraries/us/en/documents/2024-01/w680-chipset-brief-14thgen.pdf
  - W680 supports ECC and memory overclocking. XMP remains overclocking, not a
    CPU-guaranteed speed.

Simulator policy:

- Stable baseline: DDR5-4800 UDIMM.
- DDR4, RDIMM and LRDIMM: hard reject for this motherboard.
- ECC: conditional on a concrete ECC UDIMM SKU, QVL/BIOS recognition, CPU and
  chipset support.
- DDR5-6000/6400 XMP: conditional overclocking branch.
- DDR5-8000: physical insertion may be possible, but it is not in the current
  board QVL and is far above the i5-14500 official DDR5-4800 baseline. Model it
  only as downclock / training-failure risk, never as verified 8000 MT/s.

## Price evidence policy

- Purchased N6: user transaction CNY 629. JONSBO product page does not list an
  MSRP. Current auditable JD/PDD price and trustworthy historical low: unknown.
- Purchased W680M-ACE SE: user transaction CNY 2,799. ASUS product page does not
  list an MSRP. Current auditable JD/PDD price and trustworthy historical low:
  unknown.
- Purchased i5-14500: user transaction CNY 1,380. Intel suggested customer
  price is USD 232 tray / USD 242 box; this is not a China retail MSRP.
  Trustworthy JD/PDD current price and historical low: unknown.
- RAM screenshots supplied on 2026-08-19 show same-capacity desktop DDR5 price
  anchors, not validated low-profile or QVL SKUs:
  - 1x16 GB: about CNY 94.9-139.9.
  - 2x16 GB kits: about CNY 269.9-388.9. A lower CNY 190-280 number is only the
    arithmetic of two low-price single modules, not an observed kit range.
  - 1x32 GB: one visible anchor around CNY 255.9; CNY 256-320 remains a planning
    band until a concrete SKU is selected.
- DDR5-8000 and ECC UDIMM prices in the simulator are planning estimates;
  current/historical prices remain unknown until a concrete SKU is locked.

The simulator must say `unknown` when historical price evidence is unavailable;
it must not fabricate a history chart or call a planning range a JD/PDD quote.
