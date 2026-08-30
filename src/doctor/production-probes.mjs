import { readFile } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function loopbackUrl(value, label) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label} must be a valid URL`); }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error(`${label} must use an unauthenticated loopback HTTP URL`);
  }
  return url;
}

async function fetchLoopback(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await options.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: options.accept ?? "application/json" },
    });
  } finally { clearTimeout(timer); }
}

async function probeJsonService(urlValue, expectedService, expectedVersion, options) {
  try {
    const url = loopbackUrl(urlValue, `${expectedService} health URL`);
    const response = await fetchLoopback(url, options);
    if (!response.ok) return { available: false };
    const body = await response.json();
    const dateMs = Date.parse(response.headers.get("date") ?? "");
    return {
      available: body?.ok === true && body?.service === expectedService && body?.version === expectedVersion,
      ...(Number.isFinite(dateMs) ? { dateMs } : {}),
    };
  } catch { return { available: false }; }
}

async function probeSearxng(urlValue, options) {
  try {
    const url = loopbackUrl(urlValue, "SearXNG URL");
    const response = await fetchLoopback(url, { ...options, accept: "text/html,application/json" });
    const dateMs = Date.parse(response.headers.get("date") ?? "");
    return { available: response.ok, ...(Number.isFinite(dateMs) ? { dateMs } : {}) };
  } catch { return { available: false }; }
}

export async function probeBrowserWebgl() {
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    return await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    });
  } catch { return false; }
  finally { await browser?.close().catch(() => undefined); }
}

export async function probePdfParser() {
  try {
    const module = await import("pdf-parse");
    return typeof module.PDFParse === "function";
  } catch { return false; }
}

async function packageVersion() {
  try {
    const value = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof value?.version === "string" && value.version ? value.version : undefined;
  } catch { return undefined; }
}

/**
 * Probes only local process capabilities and loopback services. It never sends
 * a request to a non-loopback address and never changes runtime state.
 */
export async function probeProductionDoctorCapabilities(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = positiveInteger(environment.DOCTOR_PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const pricePort = positiveInteger(environment.PRICE_SERVER_PORT, 5174);
  const agentPort = positiveInteger(environment.AGENT_SERVER_PORT, 5175);
  const workspacePort = positiveInteger(environment.WORKSPACE_SERVER_PORT, 5176);
  const healthOptions = { fetchImpl, timeoutMs };
  const currentPackageVersion = await packageVersion();
  const serviceResults = await Promise.all([
    probeJsonService(environment.DOCTOR_PRICE_HEALTH_URL ?? `http://127.0.0.1:${pricePort}/api/price/health`, "build-sim-price", currentPackageVersion, healthOptions),
    probeJsonService(environment.DOCTOR_AGENT_HEALTH_URL ?? `http://127.0.0.1:${agentPort}/api/agent/health`, "build-sim-agent", currentPackageVersion, healthOptions),
    probeJsonService(environment.DOCTOR_WORKSPACE_HEALTH_URL ?? `http://127.0.0.1:${workspacePort}/api/workspace/health`, "build-sim-workspace", currentPackageVersion, healthOptions),
  ]);
  const [browserWebglAvailable, pdfParserAvailable] = await Promise.all([
    (options.browserWebglProbe ?? probeBrowserWebgl)(),
    (options.pdfParserProbe ?? probePdfParser)(),
  ]);
  const searxng = options.offline === true ? undefined : await probeSearxng(
    environment.SEARXNG_BASE_URL ?? "http://127.0.0.1:8080/",
    healthOptions,
  );
  let runtimeVersion;
  try { runtimeVersion = (await options.coordinator?.readState())?.appVersion; } catch { runtimeVersion = undefined; }
  const serviceDates = [...serviceResults, ...(searxng ? [searxng] : [])]
    .flatMap((result) => Number.isFinite(result.dateMs) ? [result.dateMs] : [])
    .sort((left, right) => left - right);
  const referenceClockMs = serviceDates.length ? serviceDates[Math.floor(serviceDates.length / 2)] : undefined;
  return {
    serviceVersionsVerified: serviceResults.every((result) => result.available)
      && !!currentPackageVersion && runtimeVersion === currentPackageVersion,
    browserWebglAvailable,
    pdfParserAvailable,
    ...(searxng ? { searxngAvailable: searxng.available } : {}),
    ...(Number.isFinite(referenceClockMs) ? { referenceClockMs } : {}),
  };
}
