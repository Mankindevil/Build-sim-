import { describe, expect, it } from "vitest";
import {
  canAuditWithoutOverride,
  mpnCore,
  mpnVersionNote,
  normalizeForMatch,
  scoreTitleAgainstMpn,
  specFromSku,
} from "../src/price/match";
import { extractProductOffer } from "../scripts/price-server/adapters/official-page.mjs";
import { normalizePddResponse } from "../scripts/price-server/adapters/api-pdd.mjs";
import { normalizeJdResponse } from "../scripts/price-server/adapters/api-jd.mjs";

describe("normalizeForMatch", () => {
  it("ignores separators and case so listings match part numbers", () => {
    expect(normalizeForMatch("KF564C32RSK2-32")).toBe(normalizeForMatch("kf564c32rsk2 32"));
  });
});

describe("mpnCore / mpnVersionNote", () => {
  it("strips the board revision suffix but keeps it as a review note", () => {
    expect(mpnCore("CMK32GX5M2B5600Z40 (Ver 5.43.13)")).toBe("CMK32GX5M2B5600Z40");
    expect(mpnVersionNote("CMK32GX5M2B5600Z40 (Ver 5.43.13)")).toContain("5.43.13");
    expect(mpnVersionNote("KF564C32RSK2-32")).toBeNull();
  });
});

describe("scoreTitleAgainstMpn", () => {
  it("accepts a title containing the exact part number", () => {
    const result = scoreTitleAgainstMpn("金士顿 FURY Beast DDR5 KF564C32RSK2-32 6400", "KF564C32RSK2-32");
    expect(result.kind).toBe("mpn");
    expect(canAuditWithoutOverride(result)).toBe(true);
  });

  it("downgrades to weak when the part number is absent", () => {
    const result = scoreTitleAgainstMpn("金士顿 DDR5 32G 套装 6400", "KF564C32RSK2-32");
    expect(result.kind).toBe("weak");
    expect(canAuditWithoutOverride(result)).toBe(false);
  });

  it("rejects second-hand and compatible-part listings", () => {
    expect(scoreTitleAgainstMpn("二手 KF564C32RSK2-32", "KF564C32RSK2-32").kind).toBe("reject");
    expect(scoreTitleAgainstMpn("适用于 KF564C32RSK2-32 散热片", "KF564C32RSK2-32").kind).toBe("reject");
  });

  it("rejects a single stick when the part number is a two-module kit", () => {
    const result = scoreTitleAgainstMpn("KF564C32RSK2-32 单条 16G", "KF564C32RSK2-32", { modules: 2 });
    expect(result.kind).toBe("reject");
  });
});

describe("spec matching for spec-word searches", () => {
  const eccSpec = { brand: "Kingston", ddr: 5, speedMt: 4800, capacityGb: 64, modules: 2, ecc: true };

  it("promotes a listing whose specs all line up even without the part number", () => {
    const result = scoreTitleAgainstMpn(
      "金士顿 32G DDR5 4800 ECC UDIMM 服务器内存",
      "KSM48E40BD8KM-32HM",
      { spec: eccSpec },
    );
    expect(result.kind).toBe("spec");
    expect(canAuditWithoutOverride(result)).toBe(false);
  });

  it("rejects the wrong capacity, speed or DDR generation", () => {
    for (const title of [
      "金士顿 16G DDR5 4800 ECC UDIMM",
      "金士顿 32G DDR5 5600 ECC UDIMM",
      "金士顿 32G DDR4 4800 ECC UDIMM",
    ]) {
      expect(scoreTitleAgainstMpn(title, "KSM48E40BD8KM-32HM", { spec: eccSpec }).kind).toBe("reject");
    }
  });

  it("keeps a listing weak when the brand or ECC wording is missing", () => {
    const result = scoreTitleAgainstMpn("32G DDR5 4800 服务器内存条", "KSM48E40BD8KM-32HM", {
      spec: eccSpec,
    });
    expect(result.kind).toBe("weak");
    expect(result.reasons.join()).toContain("品牌未出现");
  });

  it("reads the checkable specs straight off a catalog record", () => {
    const catalogSku = {
      id: "memory.kingston-ksm48e40bd8km-32hm-x2",
      name: "Kingston Server Premier",
      category: "memory",
      brand: "Kingston",
      attrs: { modules: 2, capacityGb: 64, speedMt: 4800, ecc: true },
    } as unknown as Parameters<typeof specFromSku>[0];
    expect(specFromSku(catalogSku)).toEqual(eccSpec);
  });
});

describe("bare model designators (N6, C6) instead of a real part number", () => {
  const n6 = { brand: "JONSBO" };

  it("accepts the case when the title names the model", () => {
    const result = scoreTitleAgainstMpn("乔思伯JONSBO电脑NAS机箱N6黑9盘位", "N6", { spec: n6 });
    expect(result.kind).toBe("mpn");
  });

  it("still accepts a listing that offers sibling models alongside ours", () => {
    // A real Taobao listing sells N2 / N3 / N5 / N6 under one link; the variant
    // picker is what separates them, so the listing itself is not wrong.
    expect(scoreTitleAgainstMpn("乔思伯 NAS机箱 N2 N3 N5 N6 多规格", "N6", { spec: n6 }).kind).toBe("mpn");
  });

  it("rejects a sibling model, which brand-only matching used to call a spec match", () => {
    const result = scoreTitleAgainstMpn("乔思伯C6机箱MATX台式电脑机箱", "N6", { spec: n6 });
    expect(result.kind).toBe("reject");
    expect(result.reasons.join()).toContain("C6");
  });

  it("does not accept a longer model that merely starts with ours", () => {
    expect(scoreTitleAgainstMpn("乔思伯 N600 中塔机箱", "N6", { spec: n6 }).kind).toBe("reject");
    expect(scoreTitleAgainstMpn("乔思伯 N6P 机箱", "N6", { spec: n6 }).kind).toBe("reject");
  });

  it("rejects a title that never names the model, brand match or not", () => {
    // The brand is not a spec: it cannot tell an N6 from anything else JONSBO
    // sells, and for a part whose only identity is its model name there is
    // nothing else left to check.
    const result = scoreTitleAgainstMpn("乔思伯 机箱 9盘位", "N6", { spec: n6 });
    expect(result.kind).toBe("reject");
    expect(result.reasons.join()).toContain("未出现型号 N6");
    expect(canAuditWithoutOverride(result)).toBe(false);
  });

  it("does not call an interface name a rival model", () => {
    const result = scoreTitleAgainstMpn("乔思伯 机箱 支持M2固态", "N6", { spec: n6 });
    expect(result.kind).toBe("reject");
    expect(result.reasons.join()).not.toContain("M2");
  });

  it("leaves long part numbers to the substring rule", () => {
    expect(scoreTitleAgainstMpn("Corsair SF750 CP-9020284 电源", "CP-9020284").kind).toBe("mpn");
  });
});

describe("scoring a page of scraped titles", () => {
  const kit = { brand: "Kingston", ddr: 5, speedMt: 6400, capacityGb: 32, modules: 2, ecc: false };
  const ecc = { brand: "Kingston", ddr: 5, speedMt: 4800, capacityGb: 64, modules: 2, ecc: true };

  it("sorts a realistic result set into audit / reject", () => {
    const rows: [string, string, typeof kit, string][] = [
      [
        "金士顿 Kingston FURY Renegade KF564C32RSK2-32 DDR5 6400 32G(16G×2)套装",
        "KF564C32RSK2-32",
        kit,
        "mpn",
      ],
      ["二手 拆机 金士顿 KF564C32RSK2-32", "KF564C32RSK2-32", kit, "reject"],
      [
        "金士顿 32G DDR5 4800 ECC UDIMM 服务器内存 KSM48E40BD8KM-32HM",
        "KSM48E40BD8KM-32HM",
        ecc,
        "mpn",
      ],
      ["金士顿 16G DDR5 4800 ECC UDIMM 服务器内存", "KSM48E40BD8KM-32HM", ecc, "reject"],
    ];
    for (const [title, mpn, spec, expected] of rows) {
      expect(scoreTitleAgainstMpn(title, mpn, { spec }).kind, title).toBe(expected);
    }
  });
});

describe("adapter normalizers", () => {
  it("reads a CNY JSON-LD offer from a brand page", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"AXP90-X53","offers":{"@type":"Offer","price":"159.00","priceCurrency":"CNY"}}
    </script>`;
    expect(extractProductOffer(html)).toEqual({ title: "AXP90-X53", price: 159, currency: "CNY" });
  });

  it("returns null when the page has no product markup", () => {
    expect(extractProductOffer("<html><body>no markup</body></html>")).toBeNull();
  });

  it("converts PDD fen to yuan", () => {
    const rows = normalizePddResponse({
      goods_search_response: { goods_list: [{ goods_name: "DDR5", min_group_price: 85000, goods_sign: "abc" }] },
    });
    expect(rows[0]?.priceCny).toBe(850);
  });

  it("unwraps the stringified JD union result", () => {
    const rows = normalizeJdResponse({
      jd_union_open_goods_query_response: {
        result: JSON.stringify({ data: [{ skuId: 123, skuName: "Exos X24", priceInfo: { price: 2899 } }] }),
      },
    });
    expect(rows[0]).toEqual({ title: "Exos X24", priceCny: 2899, url: "https://item.jd.com/123.html" });
  });
});
