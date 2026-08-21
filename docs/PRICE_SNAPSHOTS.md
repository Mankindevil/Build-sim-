# Price snapshots

Auditable CNY retail quotes for catalog SKUs. Snapshots are **committed JSON**, not browser live crawls.

## Layout

```
data/prices/
  latest.json              # bundled into the lab (derived — do not hand-edit)
  manual-quotes.json       # curated paste-in input
  local-quotes.json        # quotes confirmed in the price panel
  snapshots/YYYY-MM-DD.json
  candidates/YYYY-MM-DD.json   # fetch output, evidence always unknown
  candidates/YYYY-MM-DD.md     # clickable cheat sheet
```

`latest.json` = `manual-quotes.json` + `local-quotes.json`, audited rows only, local winning
on conflict. Rebuild with `npm run price:refresh`.

## Search keywords: part number vs spec words

Part numbers do **not** work on Taobao / PDD. Searching `KSM48E40BD8KM-32HM` there returns
unrelated industrial parts, while `金士顿 DDR5 4800 32G ECC UDIMM` returns the actual sticks.
So every SKU gets two kinds of query (`src/price/queries.mjs`):

| Query | Built from | Used first on |
| --- | --- | --- |
| 料号 | `mpn`, minus notes like `(Ver 5.43.13)` | 京东 / 亚马逊 / 官网 |
| 规格 | brand (in Chinese) + DDR gen + speed + capacity + ECC | 淘宝 / 拼多多 |

Capacity follows how the part is sold: ECC server sticks use the per-module size (64GB ÷ 2 =
`32G`), consumer XMP kits use the boxed total (`32G` for 2×16GB). Override the derived spec
query per SKU with `attrs.searchTerms` in `data/skus/catalog.json`.

A SKU is fetchable when it has an `mpn` or an explicit `attrs.searchTerms`, so "抓取全部"
stays bounded.

## Local collector service

```bash
npm run price:serve      # 127.0.0.1:5174, proxied by Vite at /api/price
npm run dev              # price panel appears under 价格与配件
npm run price:login      # sign in once per marketplace (Taobao/PDD need it)
```

Channel order is official API first, headed browser second:

| Channel | API | Browser fallback |
| --- | --- | --- |
| 京东 | `jd.union.open.goods.query` (`JD_APP_KEY`/`JD_APP_SECRET`) | yes |
| 淘宝 | `taobao.tbk.dg.material.optional.upgrade` (`TAOBAO_APP_KEY`/`TAOBAO_APP_SECRET`/`TAOBAO_ADZONE_ID`) | yes, login required |
| 拼多多 | `pdd.ddk.goods.search` (`PDD_CLIENT_ID`/`PDD_CLIENT_SECRET`) | yes, login required |
| 亚马逊 | none — Creators API needs Associates qualifying sales | yes |
| 官网 | schema.org JSON-LD on the brand page | n/a |

Keys go in `.env.local` (git-ignored). Without keys the browser path is used; without
Playwright the channel reports why it is unavailable instead of guessing a price.

Endpoints: `GET /api/price/state`, `POST /api/price/collect`, `POST /api/price/audit`,
`DELETE /api/price/audit`, `POST /api/price/rebuild`.

## Confirming a candidate

Fetched rows are always `evidence: "unknown"`. The panel scores each title against the SKU:

- **料号匹配** — title contains the part number → one-click 确认入账.
- **规格匹配** — brand, DDR generation, speed, capacity and ECC all confirmed, no part
  number → needs the 「我已核对标题」 checkbox.
- **需人工核对** — something unconfirmed (e.g. brand missing) → needs the checkbox.
- **已排除** — 二手 / 拆机 / 散片 / 兼容品, or a spec that contradicts the SKU (wrong
  capacity, wrong speed, DDR4 vs DDR5, single stick for a kit part number).

确认入账 writes `local-quotes.json`, rebuilds `latest.json` plus the dated snapshot, and
re-merges prices in the open page without a reload.

## Schema (`latest.json`)

```json
{
  "schemaVersion": "1.0.0",
  "asOf": "2026-08-21",
  "quotes": [
    {
      "skuId": "memory.corsair-cmk32gx5m2x6400c38",
      "platform": "jd",
      "priceCny": 599,
      "currency": "CNY",
      "listingUrl": "https://item.jd.com/...",
      "match": "mpn",
      "evidence": "audited",
      "note": "Title contains MPN; Ver checked manually"
    }
  ]
}
```

- `evidence` must be `audited` to affect the UI.
- Never invent `historicalLow`.
- UI stamp: `snapshot YYYY-MM-DD · jd` (never "live market").

## Offline cheat sheet

```bash
npm run price:search                    # all fetchable SKUs, links only
npm run price:search -- --category=memory
npm run price:search -- --sku=memory.kingston-kf564c32rsk2-32 --fetch
```

Writes both queries and one link per channel to `data/prices/candidates/`, for when you would
rather click through by hand.

## Runtime merge

`loadBundledCatalog()` applies `data/prices/latest.json` via `applyPriceSnapshot`.

## Scraper policy

No captcha or login bypass. When a marketplace shows a challenge the browser window stays
open for you to sign in and the channel reports `needsLogin`; when it throttles, the channel
is parked for 5 minutes and reports that instead of returning a price. Searches are spaced
3 s apart per channel and capped at two keyword variants.
