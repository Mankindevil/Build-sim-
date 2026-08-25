import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("500")) errors.push(message.text());
});

await page.goto("http://127.0.0.1:5173/index.html", { waitUntil: "networkidle" });
for (const selector of ["#fit-chip", "#kpi-wall", "#temperature-bars", "#port-map", "#price-table"]) {
  if (!(await page.$(selector))) throw new Error(`missing ${selector}`);
}

const initialFit = await page.locator("#fit-chip").textContent();
await page.selectOption("#psu-position", "dual");
await page.selectOption("#dual-start-select", "sync");
await page.selectOption("#cooler-select", "cooler.aio-240-front");
await page.waitForTimeout(250);
const dualWiring = await page.locator("#wiring-title").textContent();
const dualPrice = await page.locator("#price-table").textContent();
if (!dualWiring?.includes("HDD")) throw new Error("dual PSU did not re-render wiring from BuildEvaluation");
if (!dualPrice || dualPrice.includes("¥4,500") || dualPrice.includes("4500×")) throw new Error("price table contains legacy hardcoded disk price");

await page.selectOption("#psu-position", "auto");
await page.selectOption("#cooler-select", "cooler.thermalright-axp90-x53-full");
await page.waitForTimeout(250);
const currentFit = await page.locator("#fit-chip").textContent();
if (!currentFit || !initialFit) throw new Error("fit chip did not render");
if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("G1 browser smoke passed", { initialFit, currentFit });
await browser.close();
