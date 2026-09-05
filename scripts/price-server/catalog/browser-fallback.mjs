import crypto from "node:crypto";
import { DEFAULT_FETCH_LIMITS, resolvePublicAddresses, validateOfficialUrl, validateOfficialUrlResolved, validatePublicSubresourceUrl } from "./security.mjs";
import { detectAccessBarrier } from "./access-barrier.mjs";

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
  const resolverArgs = options.pinnedHostname && options.pinnedAddress
    ? [`--host-resolver-rules=MAP ${options.pinnedHostname} ${options.pinnedAddress},EXCLUDE localhost`]
    : [];
  if (kind === "cloakbrowser") {
    const cloak = options.cloakModule ?? await import("cloakbrowser");
    if (typeof cloak.launch !== "function") throw new Error("official CloakBrowser fallback unavailable");
    return await cloak.launch({
      headless: true,
      humanize: false,
      ...(options.cloakBrowserVersion ?? process.env.CLOAKBROWSER_VERSION ? { browserVersion: options.cloakBrowserVersion ?? process.env.CLOAKBROWSER_VERSION } : {}),
      ...(options.cloakLicenseKey ?? process.env.CLOAKBROWSER_LICENSE_KEY ? { licenseKey: options.cloakLicenseKey ?? process.env.CLOAKBROWSER_LICENSE_KEY } : {}),
      launchOptions: { timeout: timeoutMs, args: resolverArgs },
    });
  }
  const playwright = options.playwrightModule ?? await import("playwright").catch(() => null);
  if (!playwright?.chromium) throw new Error("official Playwright fallback unavailable");
  return await playwright.chromium.launch({ headless: true, timeout: timeoutMs, args: resolverArgs });
}

async function renderWith(kind, rawUrl, url, timeoutMs, maxBytes, options) {
  const browser = await launchRenderer(kind, timeoutMs, options);
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    const maxRequests = options.maxRequests ?? boundedInt(process.env.CATALOG_BROWSER_MAX_REQUESTS, 80, 1, 500);
    const allowedResourceTypes = new Set(["document", "script", "stylesheet", "xhr", "fetch"]);
    let requestCount = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      try {
        requestCount += 1;
        if (requestCount > maxRequests) throw new Error("official browser request count exceeds limit");
        const method = String(request.method?.() ?? "GET").toLocaleUpperCase();
        if (!["GET", "HEAD"].includes(method)) throw new Error("official browser request method is blocked");
        const resourceType = String(request.resourceType?.() ?? (request.isNavigationRequest() ? "document" : "other")).toLocaleLowerCase();
        if (!allowedResourceTypes.has(resourceType)) throw new Error("official browser resource type is blocked");
        const requestUrl = new URL(request.url());
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          if (requestUrl.hostname !== options.pinnedHostname) throw new Error("official browser cross-host navigation is blocked");
          await validateOfficialUrlResolved(requestUrl.toString(), options);
        } else {
          if (!["data:", "blob:"].includes(requestUrl.protocol) && requestUrl.hostname !== options.pinnedHostname) throw new Error("official browser cross-origin subresource is blocked");
          await validatePublicSubresourceUrl(requestUrl.toString(), options);
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
  const timeoutMs = options.timeoutMs ?? boundedInt(process.env.CATALOG_FETCH_TIMEOUT_MS, DEFAULT_FETCH_LIMITS.timeoutMs, 1_000, 60_000);
  const maxBytes = options.maxBytes ?? boundedInt(process.env.CATALOG_FETCH_MAX_BYTES, DEFAULT_FETCH_LIMITS.maxBytes, 100_000, 25_000_000);
  const validatedUrl = validateOfficialUrl(rawUrl);
  const addresses = await resolvePublicAddresses(validatedUrl.hostname, options);
  const pinnedAddress = addresses.find((entry) => entry.family === 4)?.address ?? addresses[0].address;
  const url = validatedUrl.toString();
  const securedOptions = {
    ...options,
    pinnedHostname: validatedUrl.hostname,
    pinnedAddress,
    // Every routed network request is same-host and Chromium is pinned to this
    // answer. Reuse the already validated DNS set instead of resolving again
    // for each script/XHR and reopening a DNS-rebinding window.
    lookup: async (hostname) => {
      if (hostname !== validatedUrl.hostname) throw new Error("official browser hostname is not pinned");
      return addresses;
    },
  };
  const selected = selectedRenderer(options);
  const order = selected === "auto" ? ["cloakbrowser", "playwright"] : [selected];
  return await serialized(async () => {
    const failures = [];
    const rendererAttempts = [];
    let lastHttpResult = null;
    for (const kind of order) {
      try {
        const rendered = await renderWith(kind, rawUrl, url, timeoutMs, maxBytes, securedOptions);
        const accessBarrier = detectAccessBarrier(rendered);
        if (rendered.status >= 200 && rendered.status < 300 && !accessBarrier) {
          rendererAttempts.push({ renderer: kind, outcome: "succeeded", httpStatus: rendered.status });
          return { ...rendered, rendererAttempts };
        }
        rendererAttempts.push({ renderer: kind, outcome: "http-error", httpStatus: rendered.status, ...(accessBarrier ? { error: `access barrier: ${accessBarrier.kind}` } : {}) });
        lastHttpResult = rendered;
        // Authentication/paywall/not-found/rate-limit responses are terminal;
        // swapping browser fingerprints is not a valid retry policy for them.
        if ([401, 402, 404, 429].includes(rendered.status)) break;
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 240);
        failures.push(`${kind}: ${message}`);
        rendererAttempts.push({ renderer: kind, outcome: "failed", error: message });
      }
    }
    // Preserve the final governed error page for access-barrier diagnostics
    // after every available renderer has been tried.
    if (lastHttpResult) return { ...lastHttpResult, rendererAttempts };
    throw new Error(`official browser fallback failed (${failures.join("; ")})`);
  });
}
