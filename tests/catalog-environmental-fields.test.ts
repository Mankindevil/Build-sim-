import { describe, expect, it } from "vitest";
import { extractOfficialHtml } from "../scripts/price-server/catalog/extract.mjs";

describe("official environmental field extraction", () => {
  it("keeps published acoustic and temperature values as reviewable fields", () => {
    const extracted = extractOfficialHtml({
      requestedUrl: "https://example.com/gpu",
      finalUrl: "https://example.com/gpu",
      canonicalUrl: "https://example.com/gpu",
      status: 200,
      contentType: "text/html",
      retrievedAt: "2026-08-26T00:00:00.000Z",
      contentHash: "a".repeat(64),
      redirects: [],
      body: `<!doctype html><title>Example GPU</title><table>
        <tr><th>Noise Level</th><td>34.5 dBA</td></tr>
        <tr><th>Maximum GPU Temperature</th><td>93 °C</td></tr>
        <tr><th>Graphics Power</th><td>220 W</td></tr>
        <tr><th>Length</th><td>232 mm</td></tr>
      </table>`,
    });

    expect(extracted.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "attrs.noiseDba", value: 34.5, evidence: "official" }),
      expect.objectContaining({ field: "attrs.maxOperatingTempC", value: 93, evidence: "official" }),
      expect.objectContaining({ field: "power.tgpW", value: 220, evidence: "official" }),
      expect.objectContaining({ field: "dims.lengthMm", value: 232, evidence: "official" }),
    ]));
  });
});
