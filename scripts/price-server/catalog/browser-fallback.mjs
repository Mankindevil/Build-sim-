import crypto from "node:crypto";
import { DEFAULT_FETCH_LIMITS, validateOfficialUrl, validateOfficialUrlResolved, validatePublicSubresourceUrl } from "./security.mjs";

const RENDERERS = new Set(["auto", "playwright", "cloakbrowser"]);
let rendererQueue = Promise.resolve();

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function selectedRenderer(options) {
  const explicit = options.renderer ?? (options.cloakModule ? "cloakbrowser" : options.playwrightModule ? "playwright" : undefined);
  const renderer = String(explicit ?? process.env.CATALOG_OFFICIAL_BROWSER_RENDERER ?? "auto").trim().toLowerCase();
  if (!RENDERERS.has(renderer)) throw new Error("CATALOG_OFFICIAL_BROWSER_RENDERER must be auto, playwright, or cloakbrowser");
  return renderer;
}

async function serialized(task) {
  const previous = rendererQueue;
  let release;
  rendererQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

async function launchRenderer(kind, timeoutMs, options) {
  if (kind === "cloakbrowser") {
    const cloak = options.cloakModule ?? await import("cloakbrowser");
    if (typeof cloak.launch !== "function") throw new Error("official CloakBrowser fallback unavailable");
    return await cloak.launch({
      headless: true,
      humanize: false,
      ...(options.cloakBrowserVersion ?? process.env.CLOAKBROWSER_VERSION ? { browserVersion: options.cloakBrowserVersion ?? process.env.CLOAKBROWSER_VERSION } : {}),
      ...(options.cloakLicenseKey ?? process.env.CLOAKBROWSER_LICENSE_KEY ? { licenseKey: options.cloakLicenseKey ?? process.env.CLOAKBROWSER_LICENSE_KEY } : {}),
      launchOptions: { timeout: timeoutMs },
    });
  }
  const playwright = options.playwrightModule ?? await import("playwright").catch(() => null);
  if (!playwright?.chromium) throw new Error("official Playwright fallback unavailable");
  return await playwright.chromium.launch({ headless: true, timeout: timeoutMs });
}

async function renderWith(kind, rawUrl, url, timeoutMs, maxBytes, options) {
  const browser = await launchRenderer(kind, timeoutMs, options);
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
    const hydrationWaitMs = options.hydrationWaitMs ?? (options.playwrightModule || options.cloakModule
      ? 0
      : boundedInt(process.env.CATALOG_BROWSER_HYDRATION_WAIT_MS, 1_200, 0, 10_000));
    if (hydrationWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, hydrationWaitMs));
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
      fallback: kind,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Optional browser fallback for public official pages that require JS rendering.
 * `auto` prefers CloakBrowser and falls back to stock Playwright when the signed
 * CloakBrowser binary is unavailable. URL, redirect, DNS, subresource, timeout,
 * and response-size checks remain identical for both renderers.
 */
export async function renderOfficialFallback(rawUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_LIMITS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULT_FETCH_LIMITS.maxBytes;
  const url = validateOfficialUrl(rawUrl).toString();
  await validateOfficialUrlResolved(url, options);
  const selected = selectedRenderer(options);
  const order = selected === "auto" ? ["cloakbrowser", "playwright"] : [selected];
  return await serialized(async () => {
    const failures = [];
    for (const kind of order) {
      try {
        return await renderWith(kind, rawUrl, url, timeoutMs, maxBytes, options);
      } catch (error) {
        failures.push(`${kind}: ${error?.message ?? error}`);
      }
    }
    throw new Error(`official browser fallback failed (${failures.join("; ")})`);
  });
}
