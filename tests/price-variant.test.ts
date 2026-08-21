import { describe, expect, it } from "vitest";
import {
  listingKey,
  parseJdPrices,
  parsePddDetail,
  parseTaobaoDetail,
  parseVariantPayload,
} from "../scripts/price-server/adapters/variant.mjs";
import { channelQueries } from "../src/price/queries.mjs";

/**
 * Shape of a Taobao/Tmall detail payload: `skuBase` names the options and
 * `skuCore.sku2info` prices them, joined by `propPath`. Trimmed to the fields the
 * parser reads.
 */
const TAOBAO_PAYLOAD = {
  data: {
    skuBase: {
      props: [
        {
          pid: "1627207",
          name: "颜色分类",
          values: [
            { vid: "28320", name: "n6 中型钢板机箱9盘位热插拔" },
            { vid: "28321", name: "N2铝合金ITX 5盘位热插拔" },
          ],
        },
      ],
      skus: [
        { skuId: "5001", propPath: "1627207:28320" },
        { skuId: "5002", propPath: "1627207:28321" },
      ],
    },
    skuCore: {
      sku2info: {
        "0": { price: { priceText: "579" } },
        "5001": { price: { priceText: "629" }, quantity: "12" },
        "5002": { price: { priceText: "579" }, quantity: "3" },
      },
    },
  },
};

describe("taobao variant table", () => {
  it("prices each option by name instead of taking the listing headline", () => {
    const hit = parseTaobaoDetail(TAOBAO_PAYLOAD)!;
    expect(hit.source).toBe("taobao:skuCore");
    expect(hit.variants).toHaveLength(2);
    const n6 = hit.variants.find((v) => v.label.includes("n6"))!;
    // The card for this listing shows ¥579 — the cheapest variant, an N2, not our N6.
    expect(n6.amount).toBe(629);
    expect(n6.skuId).toBe("5001");
    expect(n6.stock).toBe(12);
    expect(hit.variants.map((v) => v.amount)).not.toContain(579 * 100);
  });

  it("returns null when the payload is not a variant table", () => {
    expect(parseTaobaoDetail({ data: { item: { title: "x" } } })).toBeNull();
    expect(parseVariantPayload("taobao", { hello: 1 })).toBeNull();
  });
});

describe("pdd variant table", () => {
  it("converts fen to yuan", () => {
    const hit = parsePddDetail({
      store: {
        initDataObj: {
          goods: {
            skus: [
              { skuId: "9001", specs: [{ spec_key: "款式", spec_value: "N6 九盘位" }], groupPrice: 62900 },
              { skuId: "9002", specs: [{ spec_key: "款式", spec_value: "N2 五盘位" }], groupPrice: 57900 },
            ],
          },
        },
      },
    })!;
    expect(hit.variants[0]!.amount).toBe(629);
    expect(hit.variants[0]!.label).toContain("N6");
    expect(hit.variants[1]!.amount).toBe(579);
  });
});

describe("jd prices", () => {
  it("reads the price endpoint's own shape", () => {
    const hit = parseJdPrices([{ id: "J_100012345678", p: "2799.00" }], "华硕 W680M-ACE SE")!;
    expect(hit.variants[0]!.amount).toBe(2799);
    expect(hit.variants[0]!.skuId).toBe("100012345678");
  });

  it("drops rows without a usable price rather than reporting zero", () => {
    expect(parseJdPrices([{ id: "J_1", p: "-1.00" }], "x")).toBeNull();
  });
});

describe("listing identity", () => {
  it("ignores the tracking tail so two links to one product match", () => {
    const long =
      "https://item.taobao.com/item.htm?id=1023366651771&ns=1&abbucket=7&mi_id=0000SQ&spm=a21n57.1.item.2";
    expect(listingKey(long)).toBe("1023366651771");
    expect(listingKey("https://item.taobao.com/item.htm?id=1023366651771")).toBe(listingKey(long));
  });

  it("keys jd by sku id and amazon by asin", () => {
    expect(listingKey("https://item.jd.com/100012345678.html")).toBe("100012345678");
    expect(listingKey("https://www.amazon.com/dp/B0TEST12345?ref=x")).toBe("B0TEST1234");
  });
});

describe("amazon.com queries", () => {
  it("sends the part number only, since the US site does not index Chinese specs", () => {
    const sku = {
      id: "hdd.x",
      name: "Seagate Exos X24",
      mpn: "ST24000NM002H",
      category: "storage",
      attrs: { searchTerms: ["24TB 企业级硬盘"] },
    } as never;
    expect(channelQueries("amazon", sku)).toEqual(["ST24000NM002H"]);
    expect(channelQueries("taobao", sku).length).toBeGreaterThan(1);
  });
});
