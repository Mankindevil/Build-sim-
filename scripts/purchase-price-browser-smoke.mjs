import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

await page.goto("http://127.0.0.1:5173/index.html", { waitUntil: "networkidle" });
await page.waitForSelector("#kpi-price", { state: "attached" });
const result = await page.evaluate(async () => {
  const price = document.getElementById("kpi-price");
  const note = document.getElementById("kpi-price-note");
  const noiseNote = document.getElementById("kpi-noise-note");
  const candidate = [...document.querySelectorAll("#next-buy-list .bom-stage-select")]
    .find((element) => element.value === "candidate");
  if (!price || !note || !candidate) throw new Error("purchase price controls are missing");
  const before = price.textContent;
  candidate.value = "purchased";
  candidate.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { before, after: price.textContent, note: note.textContent, noiseNote: noiseNote?.textContent };
});

if (result.before === result.after) throw new Error(`remaining price did not change: ${JSON.stringify(result)}`);
if (!result.note?.includes("已投入")) throw new Error(`recorded spend is missing: ${JSON.stringify(result)}`);
if (!result.noiseNote?.includes("风扇具体型号与噪音曲线")) throw new Error(`noise evidence gap is unclear: ${JSON.stringify(result)}`);

const editResult = await page.evaluate(async () => {
  document.getElementById("build-base-edit")?.click();
  const row = document.querySelector('[data-progress-row][data-progress-id="case.jonsbo-n6"]');
  const name = row?.querySelector(".build-editor-name");
  const category = row?.querySelector(".build-editor-category");
  const qty = row?.querySelector(".build-editor-qty");
  const price = row?.querySelector(".build-editor-price");
  const stage = row?.querySelector(".build-editor-stage");
  if (!name || !category || !qty || !price || !stage) throw new Error("existing catalog row editor is incomplete");
  const editable = !name.readOnly && !category.disabled && !qty.readOnly && !price.readOnly && !stage.disabled;
  name.value = "我的旧 N6";
  category.value = "accessory";
  qty.value = "2";
  price.value = "688";
  stage.value = "installed";
  document.getElementById("build-base-save")?.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.getElementById("build-base-edit")?.click();
  const saved = document.querySelector('[data-progress-row][data-progress-id="case.jonsbo-n6"]');
  return {
    editable,
    name: saved?.querySelector(".build-editor-name")?.value,
    category: saved?.querySelector(".build-editor-category")?.value,
    qty: saved?.querySelector(".build-editor-qty")?.value,
    price: saved?.querySelector(".build-editor-price")?.value,
    stage: saved?.querySelector(".build-editor-stage")?.value,
  };
});
if (!editResult.editable) throw new Error(`existing catalog row still contains locked fields: ${JSON.stringify(editResult)}`);
if (JSON.stringify(editResult) !== JSON.stringify({ editable: true, name: "我的旧 N6", category: "accessory", qty: "2", price: "688", stage: "installed" })) {
  throw new Error(`existing catalog edits were not persisted: ${JSON.stringify(editResult)}`);
}
if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("Purchase price and editable-history browser smoke passed", { result, editResult });
await browser.close();
