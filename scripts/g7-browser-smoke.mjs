import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("500")) errors.push(message.text());
});

await page.goto("http://127.0.0.1:5173/index.html", { waitUntil: "networkidle" });
for (const selector of ["#fit-chip", "#price-table", "#advice-deterministic", "#calibration-status", "#cfg-export-checklist"]) {
  if (!(await page.$(selector))) throw new Error(`missing ${selector}`);
}

const calibration = await page.locator("#calibration-status").textContent();
const deterministicBefore = await page.locator("#advice-deterministic").textContent();
if (!calibration?.includes("n6-calibration-1.0.0") || !calibration.includes("unknown")) throw new Error("calibration snapshot is not visible");
if (!deterministicBefore?.includes("physical-rules-1.0.0") || !deterministicBefore.includes("n6-calibration-1.0.0")) throw new Error("advice input does not display physical/calibration provenance");

await page.selectOption("#nvme-select", "3");
await page.selectOption("#boot-select", "m2");
await page.fill("#disk-range", "9");
await page.selectOption("#psu-position", "dual");
await page.selectOption("#dual-start-select", "sync");
await page.waitForTimeout(300);
const evaluation = await page.evaluate(() => window.__N6_LAB__.evaluate());
if (evaluation.config.selection.diskCount !== 9 || evaluation.config.selection.nvmeCount !== 3) throw new Error("parameterized config did not reach BuildEvaluation");
if (!evaluation.physical.hash || !evaluation.calibration.hash) throw new Error("cross-layer hashes missing from BuildEvaluation");

const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#cfg-export-checklist"),
]);
const exportPath = await download.path();
if (!exportPath) throw new Error("checklist download did not produce a file");
const exported = await readFile(exportPath, "utf8");
if (!exported.includes(evaluation.physical.hash) || !exported.includes(evaluation.calibration.hash)) throw new Error("export diverged from BuildEvaluation hashes");

await page.click("#advice-generate");
await page.waitForFunction(() => !document.querySelector("#advice-generate")?.hasAttribute("disabled"));
const adviceStatus = await page.locator("#advice-status").textContent();
const deterministicAfter = await page.locator("#advice-deterministic").textContent();
if (!adviceStatus?.includes("AI 建议已关闭") && !adviceStatus?.includes("AI 建议暂不可用")) throw new Error(`unexpected advice downgrade status: ${adviceStatus}`);
if (!deterministicAfter?.includes(evaluation.physical.hash) || !deterministicAfter.includes(evaluation.calibration.hash)) throw new Error("advice downgrade lost deterministic hashes");
if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);

console.log("G7 browser cross-layer smoke passed", {
  physicalHash: evaluation.physical.hash,
  calibrationHash: evaluation.calibration.hash,
  adviceStatus,
});
await browser.close();
