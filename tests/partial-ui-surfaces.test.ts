// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { clearPartialResolvedSurfaces, markResolvedSurfacesReady } from "../src/lab/partial-surfaces";

describe("partial evaluation UI surfaces", () => {
  it("removes resolved values, tables, spatial nodes, and stale evaluation hashes", () => {
    document.body.innerHTML = `<main id="n6-lab" data-evaluation-readiness="ready" data-evaluation-hash="old-hash">
      <strong id="kpi-wall">412 W</strong><small id="kpi-wall-note">old power</small>
      <p id="route-copy" title="old finding">old route</p>
      <div id="routing-table"><span>old cable</span></div>
      <div id="air-balance"><span>old thermal result</span></div>
      <div id="product-gallery"><span>old BOM card</span></div>
      <strong id="stage-total">¥8,888</strong><strong id="remaining-total">¥9,999</strong>
      <strong id="grand-total">¥10,888</strong><strong id="future-total">¥12,888</strong>
      <strong id="purchased-total">¥1,234</strong>
      <h2 id="route-title">旧方案可安装</h2><h2 id="wiring-title">旧方案九盘接线</h2>
      <h2 id="gpu-title">旧方案显卡</h2><p id="gpu-safe-basis">旧显卡安全依据</p>
      <span id="selected-total-label">所选 9 盘待购</span><span id="grand-total-label">旧整机合计</span>
      <svg><g id="spatial-scene"><path data-old-spatial></path></g></svg>
      <div id="spatial-stage" data-evaluation-hash="old-hash"></div>
    </main>`;

    const message = "方案还缺 8 项核心选择";
    clearPartialResolvedSurfaces(document, message);

    expect(document.getElementById("n6-lab")?.dataset.evaluationReadiness).toBe("incomplete");
    expect(document.getElementById("kpi-wall")?.textContent).toBe("—");
    expect(document.getElementById("kpi-wall-note")?.textContent).toBe(message);
    expect(document.getElementById("route-copy")?.textContent).toBe(message);
    expect(document.getElementById("route-copy")?.hasAttribute("title")).toBe(false);
    expect(document.querySelector("[data-old-spatial]")).toBeNull();
    expect(document.getElementById("routing-table")?.childElementCount).toBe(0);
    expect(document.getElementById("air-balance")?.childElementCount).toBe(0);
    expect(document.getElementById("product-gallery")?.childElementCount).toBe(0);
    for (const id of ["purchased-total", "stage-total", "remaining-total", "grand-total", "future-total"]) {
      expect(document.getElementById(id)?.textContent).toBe("—");
    }
    for (const id of ["route-title", "wiring-title", "gpu-title", "gpu-safe-basis"]) {
      expect(document.getElementById(id)?.textContent).toBe(message);
    }
    expect(document.getElementById("selected-total-label")?.textContent).toBe(message);
    expect(document.getElementById("grand-total-label")?.textContent).toBe(message);
    expect(document.querySelector("[data-evaluation-hash]")).toBeNull();

    markResolvedSurfacesReady(document);
    expect(document.getElementById("n6-lab")?.dataset.evaluationReadiness).toBe("ready");
  });
});
