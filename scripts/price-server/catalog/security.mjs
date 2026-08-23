import net from "node:net";
import { registryForUrl } from "./registry.mjs";

export const DEFAULT_FETCH_LIMITS = Object.freeze({ maxBytes: 5_000_000, timeoutMs: 15_000, maxRedirects: 4 });

function ipv4Private(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isPrivateHostname(hostname) {
  const value = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "localhost.localdomain"].includes(value) || value.endsWith(".local") || value.endsWith(".internal")) return true;
  if (net.isIPv4(value)) return ipv4Private(value);
  if (net.isIPv6(value)) return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  return false;
}

export function validateOfficialUrl(raw, { allowHttp = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (!allowHttp && url.protocol !== "https:") throw new Error("official URL must use https");
  if (allowHttp && !["https:", "http:"].includes(url.protocol)) throw new Error("official URL protocol is not allowed");
  if (isPrivateHostname(url.hostname)) throw new Error("private or local URL is blocked");
  if (!registryForUrl(url)) throw new Error("official domain is not allowlisted");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

export function validateRedirect(raw, options = {}) {
  return validateOfficialUrl(raw, options);
}
