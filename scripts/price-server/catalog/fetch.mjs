import crypto from "node:crypto";
import { DEFAULT_FETCH_LIMITS, validateOfficialUrl, validateRedirect } from "./security.mjs";

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("official response exceeds size limit");
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("official response exceeds size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchOfficial(rawUrl, options = {}) {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...options };
  let current = validateOfficialUrl(rawUrl, limits);
  const redirects = [];
  const retrievedAt = new Date().toISOString();
  let response;
  for (let attempt = 0; attempt <= limits.maxRedirects; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "Build-Sim catalog verifier/1.0", accept: "text/html,application/xhtml+xml,application/pdf;q=0.9" },
      });
    } catch (error) {
      throw new Error(error?.name === "AbortError" ? "official fetch timeout" : `official fetch failed: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect without location");
    const next = validateRedirect(new URL(location, current).toString(), limits);
    redirects.push(next.toString());
    current = next;
  }
  if (!response) throw new Error("official fetch returned no response");
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("too many redirects");
  const body = await readLimited(response, limits.maxBytes);
  return {
    requestedUrl: rawUrl,
    finalUrl: current.toString(),
    status: response.status,
    contentType: response.headers.get("content-type")?.split(";")[0]?.trim() ?? "",
    retrievedAt,
    body,
    contentHash: crypto.createHash("sha256").update(body).digest("hex"),
    ...(response.headers.get("etag") ? { etag: response.headers.get("etag") } : {}),
    ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified") } : {}),
    redirects,
  };
}
