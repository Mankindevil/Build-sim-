// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CARD_SELECTORS, extractCardsInPage } from "../scripts/price-server/adapters/extract-price.mjs";
import { flagCandidates, auditBlockReason } from "../src/price/sanity";
import type { PriceCandidate } from "../src/price/sanity";

interface Row {
  title: string;
  url: string;
  amount: number | null;
  currency: string | null;
  priceText: string;
  priceSource: string;
  salesText: string;
  glued: boolean;
  gluedAmount: number | null;
  reason?: string;
}

function run(html: string, channel: keyof typeof CARD_SELECTORS, limit = 5): Row[] {
  document.body.innerHTML = html;
  return extractCardsInPage({ sel: CARD_SELECTORS[channel], limit }) as Row[];
}

/** What the old parser did: first yuan figure in the concatenated card text. */
function naiveParse(html: string): number | null {
  document.body.innerHTML = html;
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  const m = text.match(/[￥¥]\s*(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

// Structure taken from a real Tmall card. The nodes are written without
// whitespace between them exactly as the site renders them, because that is what
// makes `textContent` concatenate the price and the sales count into `¥69948`.
const TMALL_CARD =
  `<a href="https://detail.tmall.com/item.htm?id=998503870947">` +
  `<div class="Title--title--jCOPvpf"><span>乔思伯JONSBO电脑NAS机箱N6黑9盘位家用网络存储240水冷MATX主板</span></div>` +
  `<div class="Price--priceWrapper--Q0Dn7pN"><span class="Price--symbol--vGrnjTx">¥</span>` +
  `<span class="Price--priceInt--ZlsSi_b">699</span></div>` +
  `<span class="Price--realSales--FhTZc7U">48人付款</span>` +
  `<div class="Price--procity--_7Vt3mX">江苏徐州</div></a>`;

/** Same card, but the price carries a fractional span the way Tmall often renders it. */
const TMALL_CARD_DECIMAL = TMALL_CARD.replace(
  `>699</span></div>`,
  `>699</span><span class="Price--priceFloat--h2RR0RO">.50</span></div>`,
);

const JD_CARD = `
<li class="gl-item">
  <div class="p-name"><a href="//item.jd.com/100012345678.html"><em>华硕 Pro WS W680M-ACE SE 主板</em></a></div>
  <div class="p-price"><strong><i>2799.00</i></strong></div>
  <div class="p-commit"><strong>1.2万+条评价</strong></div>
</li>`;

const AMAZON_CARD = `
<div data-asin="B0TEST" data-component-type="s-search-result">
  <h2><span>Seagate Exos X24 24TB Enterprise HDD</span></h2>
  <a class="a-link-normal" href="/dp/B0TEST"></a>
  <div class="a-price"><span class="a-offscreen">$429.99</span><span class="a-price-whole">429</span></div>
  <span>1,203 ratings</span>
</div>`;

describe("card price extraction", () => {
  it("reads the Tmall price without swallowing the sales count", () => {
    // The bug this whole module exists for: the old rule returned 69948.
    expect(naiveParse(TMALL_CARD)).toBe(69948);

    const [row] = run(TMALL_CARD, "taobao");
    expect(row!.amount).toBe(699);
    expect(row!.currency).toBe("CNY");
    expect(row!.glued).toBe(false);
    // The sales figure is read structurally too, so it is 48 buyers and not `69948人付款`.
    expect(row!.salesText).toBe("48人付款");
    expect(row!.priceText).toContain("699");
  });

  it("keeps the fractional part when the price is split across spans", () => {
    expect(run(TMALL_CARD_DECIMAL, "taobao")[0]!.amount).toBe(699.5);
  });

  it("refuses a number it cannot separate from the sales count", () => {
    // Worst case: one text node, no boundary. Reporting nothing beats reporting 16948.
    const html = `<a href="https://item.taobao.com/item.htm?id=1">
      <span>乔思伯JONSBO C6 MATX机箱小巧多孔散热风冷 全新¥16948人付款江苏徐州</span></a>`;
    const [row] = run(html, "taobao");
    expect(row!.amount).toBeNull();
    expect(row!.glued).toBe(true);
    expect(row!.gluedAmount).toBe(16948);
    expect(row!.reason).toContain("无分隔符");
  });

  it("still reads a price when a non-digit follows it", () => {
    const html = `<a href="https://item.taobao.com/item.htm?id=2">
      <span>乔思伯N6机箱 ¥699券后价3人付款广东深圳</span></a>`;
    const [row] = run(html, "taobao");
    expect(row!.amount).toBe(699);
    expect(row!.glued).toBe(false);
  });

  it("takes JD's symbol-less price as CNY because that is the storefront", () => {
    const [row] = run(JD_CARD, "jd");
    expect(row!.amount).toBe(2799);
    expect(row!.currency).toBe("CNY");
    expect(row!.url).toBe("https://item.jd.com/100012345678.html");
  });

  it("does not mistake a review count for a price", () => {
    const [row] = run(JD_CARD, "jd");
    expect(row!.amount).not.toBe(1.2);
    expect(row!.amount).toBe(2799);
  });

  it("reads amazon.com as USD, not as yuan", () => {
    const [row] = run(AMAZON_CARD, "amazon");
    expect(row!.amount).toBe(429.99);
    expect(row!.currency).toBe("USD");
  });

  it("reports a card with no price node instead of inventing one", () => {
    const html = `<a href="https://item.taobao.com/item.htm?id=3"><span>乔思伯 N6 机箱 咨询客服</span></a>`;
    const [row] = run(html, "taobao");
    expect(row!.amount).toBeNull();
    expect(row!.priceSource).toBe("none");
    expect(row!.reason).toBeTruthy();
  });
});

// Fixtures come from `npm run price:fixture` and only exist after a real capture;
// the synthetic cases above cover the same rules without a network.
const fixtureDir = path.join(process.cwd(), "tests/fixtures/price-cards");
const fixtures = (() => {
  try {
    return readdirSync(fixtureDir).filter((f) => f.endsWith(".html"));
  } catch {
    return [];
  }
})();

if (fixtures.length > 0) {
  describe("captured fixtures", () => {
    it.each(fixtures)("%s parses to plausible prices", (file) => {
      const html = readFileSync(path.join(fixtureDir, file), "utf8");
      const channel = (html.match(/<!-- channel: (\w+) -->/)?.[1] ??
        "taobao") as keyof typeof CARD_SELECTORS;
      const rows = run(html, channel, 10);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        if (row.amount === null) {
          expect(row.reason ?? row.glued).toBeTruthy();
          continue;
        }
        expect(row.amount).toBeLessThan(200000);
        // The sales count must never end up inside the number.
        const sales = row.salesText.match(/\d[\d.,]*/)?.[0]?.replace(/[.,]/g, "") ?? "";
        if (sales.length >= 2) expect(String(row.amount)).not.toContain(sales);
      }
    });
  });
}

describe("audit gates", () => {
  const base: PriceCandidate = {
    skuId: "case.jonsbo-n6",
    mpn: "N6",
    query: "乔思伯 N6 机箱",
    channel: "taobao",
    platform: "taobao",
    title: "乔思伯 N6 机箱",
    url: "https://detail.tmall.com/item.htm?id=1",
    fetchedAt: "2026-08-22T00:00:00.000Z",
    evidence: "unknown",
    priceCny: 699,
    priceAmount: 699,
    priceCurrency: "CNY",
    priceKind: "from",
    priceText: "¥699.00",
    priceSource: "cluster",
    salesText: "48人付款",
    glued: false,
    gluedAmount: null,
    suspect: null,
  };

  it("refuses to bank a listing headline price until a variant is resolved", () => {
    expect(auditBlockReason(base)).toContain("列表起价");
    expect(auditBlockReason({ ...base, priceKind: "variant", variantLabel: "N6 九盘位" })).toBeNull();
  });

  it("refuses a converted foreign price outright", () => {
    const row = {
      ...base,
      priceKind: "variant" as const,
      priceCurrency: "USD",
      priceAmount: 99,
      priceCny: 712.8,
      fxAssumed: { rate: 7.2, asOf: "2026-08-22", source: "手填" },
    };
    expect(auditBlockReason(row)).toContain("汇率假设");
  });

  it("flags a reading far above the group and leaves the plausible ones alone", () => {
    const rows = flagCandidates([
      { ...base, priceCny: 699 },
      { ...base, priceCny: 693, channel: "jd", platform: "jd" },
      { ...base, priceCny: 600, channel: "pdd", platform: "pdd" },
      { ...base, priceCny: 69948, channel: "amazon", platform: "amazon" },
    ]);
    expect(rows.slice(0, 3).map((r) => r.suspect)).toEqual([null, null, null]);
    expect(rows[3]!.suspect?.code).toBe("magnitude");
    expect(auditBlockReason(rows[3]!)).toContain("中位数");
  });

  it("never flags a row for being cheap, because search pages mix in accessories", () => {
    // A real capture: one ¥680 listing next to the actual ¥2799–¥3609 boards. With
    // the cheapest row as the baseline, every genuine price was marked suspect.
    const rows = flagCandidates([
      { ...base, priceCny: 2700 },
      { ...base, priceCny: 680, channel: "jd", platform: "jd" },
      { ...base, priceCny: 2799, channel: "pdd", platform: "pdd" },
      { ...base, priceCny: 3609, channel: "amazon", platform: "amazon" },
    ]);
    expect(rows.map((r) => r.suspect)).toEqual([null, null, null, null]);
  });

  it("stays quiet when a SKU has too few readings to compare", () => {
    const rows = flagCandidates([{ ...base, priceCny: 69948 }, { ...base, priceCny: 699 }]);
    expect(rows.map((r) => r.suspect)).toEqual([null, null]);
  });

  it("does not let a rejected listing skew the baseline", () => {
    const rejected = { ...base, priceCny: 90000, title: "机箱 展示柜", channel: "pdd", platform: "pdd" };
    const flagged = flagCandidates(
      [{ ...base, priceCny: 699 }, { ...base, priceCny: 693 }, { ...base, priceCny: 600 }, rejected],
      { reference: (row) => row.title !== "机箱 展示柜" },
    );
    expect(flagged[3]!.suspect?.code).toBe("magnitude");
    expect(flagged[0]!.suspect).toBeNull();
  });

  it("marks a glued reading regardless of the median", () => {
    const rows = flagCandidates([{ ...base, priceCny: null, glued: true, gluedAmount: 69948 }]);
    expect(rows[0]!.suspect?.code).toBe("glued");
  });
});
