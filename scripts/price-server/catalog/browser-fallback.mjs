import crypto from "node:crypto";
import { validateOfficialUrl } from "./security.mjs";

/** Optional headless fallback for official pages that render specs in JS. */
export async function renderOfficialFallback(rawUrl, { timeoutMs = 15_000 } = {}) {
  const url = validateOfficialUrl(rawUrl).toString();
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("official Playwright fallback unavailable");
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const body = await page.content();
    return {
      requestedUrl: rawUrl,
      finalUrl: page.url(),
      status: 200,
      contentType: "text/html",
      retrievedAt: new Date().toISOString(),
      body,
      contentHash: crypto.createHash("sha256").update(body).digest("hex"),
      redirects: [],
      fallback: "playwright",
    };
  } finally {
    await browser.close();
  }
}
