/**
 * Screenshots lab panels from the dev server. Local verification helper only:
 * `node scripts/shot.mjs [outDir]`.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "/tmp/shots";
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  // The price collector is a separate opt-in service; its proxy 500 is not a page fault.
  if (m.type() === "error" && !m.text().includes("500")) errors.push(m.text());
});

await page.goto("http://localhost:5173/index.html", { waitUntil: "networkidle" });

async function shot(tab, selector, name, tweak) {
  if (tweak) await tweak();
  await page.click(`.lab-tab[data-tab="${tab}"]`);
  await page.waitForTimeout(350);
  const el = await page.$(selector);
  if (!el) throw new Error(`missing ${selector}`);
  await el.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${name}.png`);
}

const setPsu = async (psuId, topology) => {
  await page.selectOption("#psu-select", psuId);
  await page.selectOption("#psu-position", topology);
  await page.waitForTimeout(250);
};

const setInput = (sel, value) =>
  page.$eval(
    sel,
    (el, v) => {
      if (el.type === "checkbox") el.checked = v === "true";
      else el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );

// Boot from M.2 first: the bay boot mode caps the data-disk slider at 8.
await setInput("#boot-select", "m2");
await setInput("#disk-range", "9");

await setPsu("psu.corsair-sf750-atx31", "bottom");
await shot("wiring", '#panel-wiring-card', "panel-sf750-bottom");
await shot("thermal", "#air-balance-card", "air-sf750-bottom");

await setPsu("psu.seasonic-focus-gx-850-v5", "auto");
await setInput("#drive-fans", "true");
await shot("wiring", '#panel-wiring-card', "panel-gx850-atx");
await shot("thermal", "#air-balance-card", "air-gx850-atx");

await browser.close();
if (errors.length) {
  console.error("PAGE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no page errors");
