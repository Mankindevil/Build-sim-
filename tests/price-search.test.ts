import { describe, expect, it } from "vitest";
import {
  buildSearchQueries,
  buildChannelSearchLinks,
  buildSkuSearchLinks,
  channelQueries,
  pickOfficialUrl,
  searchQueryFromMpn,
} from "../src/price/search";
import { loadRawCatalog } from "../src/sku/catalog";
import type { SkuRecord } from "../src/sku/types";

function sku(id: string): SkuRecord {
  const found = loadRawCatalog().skus.find((s) => s.id === id);
  if (!found) throw new Error(`missing fixture sku ${id}`);
  return found;
}

describe("MPN multi-channel search", () => {
  it("strips Ver notes from Corsair MPN", () => {
    expect(searchQueryFromMpn("CMK32GX5M2X6400C38 (Ver 5.43.13)")).toBe("CMK32GX5M2X6400C38");
  });

  it("builds jd taobao pdd amazon and official links", () => {
    const links = buildChannelSearchLinks(
      "KF564C32RSK2-32",
      "https://www.kingston.com/en/memory/search?partid=KF564C32RSK2-32",
    );
    const channels = links.map((l) => l.channel);
    expect(channels).toEqual(["jd", "taobao", "pdd", "amazon_cn", "amazon", "official"]);
    expect(links[0]?.url).toContain("search.jd.com");
    expect(links[0]?.url).toContain(encodeURIComponent("KF564C32RSK2-32"));
    expect(links[1]?.url).toContain("s.taobao.com");
    expect(links[2]?.url).toContain("yangkeduo.com");
    expect(links[3]?.url).toContain("amazon.cn");
    expect(links[4]?.url).toContain("amazon.com");
    expect(links[5]?.url).toContain("kingston.com");
  });

  it("adds spec keywords, because Taobao cannot find memory by part number", () => {
    const ecc = buildSearchQueries(sku("memory.kingston-ksm48e40bd8km-32hm-x2"));
    expect(ecc.exact).toBe("KSM48E40BD8KM-32HM");
    // Server ECC sticks are sold singly, so the per-module 32G is the search term.
    expect(ecc.spec[0]).toBe("金士顿 DDR5 4800 32G ECC UDIMM");
    expect(ecc.spec[1]).toBe("DDR5 4800 32G ECC UDIMM");

    const kit = buildSearchQueries(sku("memory.kingston-kf564c32rsk2-32"));
    expect(kit.spec[0]).toBe("金士顿 DDR5 6400 32G");
  });

  it("puts spec words first on Taobao and PDD, part number first on JD", () => {
    const target = sku("memory.kingston-ksm48e40bd8km-32hm-x2");
    expect(channelQueries("taobao", target)[0]).toBe("金士顿 DDR5 4800 32G ECC UDIMM");
    expect(channelQueries("pdd", target)[0]).toBe("金士顿 DDR5 4800 32G ECC UDIMM");
    expect(channelQueries("jd", target)[0]).toBe("KSM48E40BD8KM-32HM");
  });

  it("uses each channel's preferred query in the per-SKU links", () => {
    const links = buildSkuSearchLinks(sku("memory.kingston-ksm48e40bd8km-32hm-x2"));
    const taobao = links.find((l) => l.channel === "taobao");
    expect(taobao?.url).toContain(encodeURIComponent("金士顿 DDR5 4800 32G ECC UDIMM"));
    expect(links.find((l) => l.channel === "jd")?.url).toContain("KSM48E40BD8KM-32HM");
  });

  it("omits marketplace listingUrl as official", () => {
    expect(
      pickOfficialUrl({
        price: { listingUrl: "https://item.jd.com/123.html" },
      }),
    ).toBeUndefined();
    expect(
      pickOfficialUrl({
        appearance: { page: "https://seasonic.com/focus-gx-atx-3/" },
        price: { listingUrl: "https://item.jd.com/123.html" },
      }),
    ).toBe("https://seasonic.com/focus-gx-atx-3/");
  });
});
