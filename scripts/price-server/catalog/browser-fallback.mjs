import crypto from "node:crypto";
import { DEFAULT_FETCH_LIMITS, validateOfficialUrl, validateOfficialUrlResolved, validatePublicSubresourceUrl } from "./security.mjs";

/** Optional headless fallback for official pages that render specs in JS. */
export async function renderOfficialFallback(rawUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_LIMITS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULT_FETCH_LIMITS.maxBytes;
  const url = validateOfficialUrl(rawUrl).toString();
  await validateOfficialUrlResolved(url, options);
  let playwright = options.playwrightModule;
  if (!playwright) {
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error("official Playwright fallback unavailable");
    }
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    await page.route("**/*", async (route) => {
      const request = route.request();
      try {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          await validateOfficialUrlResolved(request.url(), options);
        } else {
          await validatePublicSubresourceUrl(request.url(), options);
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const navigationResponse = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const finalUrl = (await validateOfficialUrlResolved(page.url(), options)).toString();
    const body = await page.content();
    if (Buffer.byteLength(body) > maxBytes) throw new Error("official rendered response exceeds size limit");
    const navigationStatus = typeof navigationResponse?.status === "function" ? Number(navigationResponse.status()) : 200;
    const status = Number.isInteger(navigationStatus) && navigationStatus >= 100 && navigationStatus <= 599 ? navigationStatus : 200;
    const responseContentType = typeof navigationResponse?.headerValue === "function" ? await navigationResponse.headerValue("content-type") : null;
    const contentType = String(responseContentType ?? "text/html").split(";")[0].trim() || "text/html";
    return {
      requestedUrl: rawUrl,
      finalUrl,
      status,
      contentType,
      retrievedAt: new Date().toISOString(),
      body,
      contentHash: crypto.createHash("sha256").update(body).digest("hex"),
      redirects: finalUrl === url ? [] : [finalUrl],
      fallback: "playwright",
    };
  } finally {
    await browser.close();
  }
}
