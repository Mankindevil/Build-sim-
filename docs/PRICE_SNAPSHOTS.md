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

## A card price is not the SKU's price

A search result shows one number for a listing that may sell several products. A real capture of
`乔思伯 N6 机箱` returned ¥579 for a listing whose options are N6 nine-bay ¥629 / N3 eight-bay ¥679 /
N5 twelve-bay ¥1109 / N2 five-bay ¥579 — the card was quoting the cheapest one, an N2. So the
pipeline runs in two stages:

1. **Search** gives the listing link and a headline number stamped `priceKind: "from"`, shown as
   「起价 · 未定规格」. It can never be audited.
2. **Variant resolution** (`POST /api/price/variants`) opens the detail page and reads the
   per-option price table. Only such a row can be audited, and the option's own wording is stored
   in `variantLabel` so the number can be re-checked later.

Resolution tries three things in order and records which one answered:

| Attempt | How | Notes |
| --- | --- | --- |
| the page's own JSON | intercept `mtop…pcdetail.data.get` (Taobao/Tmall), `window.rawData` (PDD), `p.3.cn/prices/mgets` (JD) | fastest, whole table at once; breaks when the site changes |
| embedded JSON | `g_page_config` / `__INITIAL_DATA__` in the HTML | older Taobao pages |
| clicking | click each option and read the price that appears | survives API changes; the path that actually worked on Taobao in testing |

All three failing yields `unknown`. Nothing infers a variant price.

After a capture the panel resolves up to five listings per SKU automatically (best title matches
first); every row also has a 「解析规格价」 button. The option matching the part number is
preselected and labelled 「按料号自动选中」; when none matches, nothing is selected.

## Reading the price off a card

`textContent` concatenates sibling nodes with no separator, so a card whose price and sales count
sit in adjacent spans reads as `¥69948人付款` — the old greedy regex banked 69948 for a ¥699 case.
Extraction (`scripts/price-server/adapters/extract-price.mjs`) therefore locates the price
structurally: find the currency sign, then climb to the largest ancestor whose entire text is still
nothing but a price. The sales count lives in a different subtree and cannot be reached.

When there is no such boundary — one text node holding `¥16948人付款` — the reading is refused
(`amount: null`, `glued: true`) rather than split on a hunch. Every row keeps `priceText`,
`priceSource` and `salesText` so a wrong number can be diagnosed instead of guessed at.

`npm run price:fixture -- --channel taobao --query "乔思伯 N6 机箱"` saves real cards to
`tests/fixtures/price-cards/`; `tests/price-extract.test.ts` asserts the parser reads ¥699 where
the old rule read ¥69948.

## Plausibility gates

`src/price/sanity.mjs` marks rows; it never repairs one. A row that fails is shown in yellow,
sorted to the bottom of its group, and cannot be audited:

| Code | Meaning |
| --- | --- |
| `glued` | price and sales count could not be separated |
| `no-price` | no trustworthy price node on the card |
| `magnitude` | more than 4× the median reading captured for that SKU |

The magnitude check is one-sided: only rows far **above** the median are flagged, because
concatenation can only inflate a number (`699` → `69948`, never `6`). Flagging cheap rows too meant
flagging real prices — a search page always mixes the part with accessories, and one ¥680 listing
was enough to make the genuine ¥2799–¥3609 boards look suspect. It is a backstop only; a
concatenated reading is refused outright during extraction. Listings the matcher rejected are
excluded from the median.

## Foreign currency

亚马逊 points at **amazon.com**, so its prices are USD. `data/prices/fx.json` holds hand-written
rates with an `asOf` date and no rate source — it exists only to give a foreign listing a
comparable CNY magnitude. Converted rows are labelled 「含汇率假设」 and **cannot be audited**: a
recorded price has to be what was actually paid in CNY. Update that file by hand before trusting
the converted figures.

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
| 亚马逊 | none — Creators API needs Associates qualifying sales | yes, amazon.com (USD) |
| 官网 | schema.org JSON-LD on the brand page | n/a |

On amazon.com only the part-number query is sent; Chinese spec wording returns noise there.

Keys go in `.env.local` (git-ignored). Without keys the browser path is used; without
Playwright the channel reports why it is unavailable instead of guessing a price.

Endpoints: `GET /api/price/state`, `POST /api/price/collect`, `POST /api/price/variants`,
`POST /api/price/audit`, `DELETE /api/price/audit`, `POST /api/price/rebuild`.

## Confirming a candidate

Candidates are grouped per SKU in collapsible sections; each header shows the cheapest
variant-level price, the spread of plausible card prices and how many readings are suspect. Two
filters narrow the list: 只看料号匹配 and 隐藏可疑价格.

Fetched rows are always `evidence: "unknown"`. The panel scores each title against the SKU:

- **料号匹配** — title contains the part number → one-click 确认入账.
- **规格匹配** — DDR generation, speed, capacity and ECC all confirmed, no part number → needs
  the 「我已核对标题」 checkbox. The brand alone never earns this: it cannot tell an N6 from
  anything else JONSBO sells.
- **需人工核对** — something unconfirmed (e.g. brand missing) → needs the checkbox.
- **已排除** — 二手 / 拆机 / 散片 / 兼容品, or a spec that contradicts the SKU (wrong
  capacity, wrong speed, DDR4 vs DDR5, single stick for a kit part number).

Some parts have no part number beyond their model name (`N6`), and there a substring test is
worthless: `N6` sits inside `N600`, and JONSBO also sells a C6, N2, N3 and N5. Such a designator
must appear as its own word — CJK counts as a word boundary, so `乔思伯N6机箱` qualifies — and a
title that never names it is **rejected**, not merely weakened. There is nothing else to check on
a part whose identity *is* the model name, so pricing an unnamed one would be a guess dressed up
as a quote. A listing that offers siblings alongside ours (`N2/N3/N5/N6` under one link) still
matches, because the variant picker is what separates them.

On top of the title score, a row must also clear the audit gates: a resolved variant price, in CNY,
with no plausibility flag. The button's tooltip states which of those is missing.

确认入账 writes `local-quotes.json` (including `variantLabel`), rebuilds `latest.json` plus the dated
snapshot, and re-merges prices in the open page without a reload.

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
      "variantLabel": "n6 中型钢板机箱 9盘位热插拔",
      "note": "Title contains MPN; Ver checked manually"
    }
  ]
}
```

- `evidence` must be `audited` to affect the UI.
- `variantLabel` names the option the price belongs to; without it a price on a multi-variant
  listing cannot be re-checked.
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

Variant resolution opens one detail page per request through the same throttle and cooldown, and
the click fallback interacts only with the option controls — no cart, no checkout, no account
actions. Automatic resolution is limited to five listings per SKU; anything beyond that is a
deliberate button press.
