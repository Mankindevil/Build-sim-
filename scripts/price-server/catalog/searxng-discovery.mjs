import crypto from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { intEnv } from "../env.mjs";
import { atomicWriteJson, readJson } from "../store.mjs";
import { OFFICIAL_REGISTRY_VERSION } from "./registry.mjs";

const memoryCache = new Map();
const MAX_QUERY_CHARS = 240;
const MAX_DOMAINS = 16;
const MAX_RESPONSE_BYTES = 1_000_000;

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function now() { return new Date().toISOString(); }

export function validateSearXngBaseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("SEARXNG_BASE_URL is invalid"); }
  const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(hostname)) throw new Error("SEARXNG_BASE_URL must be a fixed loopback HTTP endpoint");
  if (url.username || url.password || url.search || url.hash) throw new Error("SEARXNG_BASE_URL must not contain credentials, query or fragment");
  return url;
}

async function readLimitedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("SearXNG response exceeds size limit");
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("SearXNG response exceeds size limit");
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("SearXNG returned invalid JSON"); }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) throw new Error("SearXNG response schema is invalid");
  return payload;
}

async function mapLimit(items, concurrency, worker) {
  const output = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return output;
}

export class SearXngDiscoveryProvider {
  id = "searxng";
  constructor(options = {}) {
    this.baseUrl = validateSearXngBaseUrl(options.baseUrl ?? "http://127.0.0.1:8080");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.resultLimit = options.resultLimit ?? 10;
    this.cacheTtlMs = options.cacheTtlMs ?? 86_400_000;
    this.cacheRoot = options.cacheRoot;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.registryVersion = options.registryVersion ?? OFFICIAL_REGISTRY_VERSION;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.concurrency = Math.min(4, Math.max(1, options.concurrency ?? 3));
  }

  cacheKey(query, domains, limit) {
    return sha256(JSON.stringify({ provider: this.id, query, domains, limit, registryVersion: this.registryVersion }));
  }

  async loadCache(key) {
    const memory = memoryCache.get(key);
    if (memory && Date.now() - Date.parse(memory.cachedAt) <= this.cacheTtlMs) return memory.results;
    if (!this.cacheRoot) return null;
    const file = path.join(this.cacheRoot, `${key}.json`);
    const disk = await readJson(file, null);
    if (!disk || disk.key !== key || !Array.isArray(disk.results) || Date.now() - Date.parse(disk.cachedAt) > this.cacheTtlMs) return null;
    memoryCache.set(key, disk);
    return disk.results;
  }

  async saveCache(key, results) {
    const record = { schemaVersion: "1.0.0", key, provider: this.id, registryVersion: this.registryVersion, cachedAt: now(), results };
    memoryCache.set(key, record);
    if (!this.cacheRoot) return;
    await mkdir(this.cacheRoot, { recursive: true });
    await atomicWriteJson(path.join(this.cacheRoot, `${key}.json`), record, { operation: "searxng-discovery-cache", rollbackRoot: path.join(this.cacheRoot, "rollback"), manifestPath: path.join(this.cacheRoot, "rollback", "manifest.json") });
  }

  async discover({ query, allowedDomains, limit, signal }) {
    const queryText = String(query.mpn ?? query.raw ?? "").trim().slice(0, MAX_QUERY_CHARS);
    if (!queryText) throw new Error("SearXNG discovery query is empty");
    const domains = [...new Set(allowedDomains.map((domain) => String(domain).toLocaleLowerCase()))].slice(0, MAX_DOMAINS);
    if (!domains.length) return [];
    const boundedLimit = Math.min(this.resultLimit, Math.max(1, limit));
    const key = this.cacheKey(queryText, domains, boundedLimit);
    const cached = await this.loadCache(key);
    if (cached) return cached;
    const groups = await mapLimit(domains, this.concurrency, async (domain) => {
      const endpoint = new URL("/search", this.baseUrl);
      endpoint.searchParams.set("q", `${queryText} site:${domain}`);
      endpoint.searchParams.set("format", "json");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, this.timeoutMs);
      try {
        const response = await this.fetchImpl(endpoint, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
        const payload = await readLimitedJson(response, this.maxResponseBytes);
        return payload.results.flatMap((entry, index) => {
          if (!entry || typeof entry !== "object" || typeof entry.url !== "string") return [];
          return [{ url: entry.url, ...(typeof entry.title === "string" ? { title: entry.title.slice(0, 240) } : {}), ...(typeof entry.content === "string" ? { snippet: entry.content.slice(0, 240) } : {}), ...(typeof entry.engine === "string" ? { engine: entry.engine.slice(0, 80) } : {}), provider: this.id, retrievedAt: now(), rank: index }];
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("SearXNG discovery timeout or cancellation");
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    });
    const results = groups.flat().slice(0, boundedLimit);
    await this.saveCache(key, results);
    return results;
  }
}

export function createSearXngDiscoveryProvider(env, options = {}) {
  return new SearXngDiscoveryProvider({
    baseUrl: env.SEARXNG_BASE_URL || "http://127.0.0.1:8080",
    timeoutMs: intEnv(env, "SEARXNG_TIMEOUT_MS", 10_000, { min: 1_000, max: 60_000 }),
    resultLimit: intEnv(env, "SEARXNG_RESULT_LIMIT", 10, { min: 1, max: 20 }),
    cacheTtlMs: intEnv(env, "CATALOG_DISCOVERY_CACHE_TTL_MS", 86_400_000, { min: 1_000, max: 604_800_000 }),
    ...options,
  });
}
