import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
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

/** @param {string} hostname @param {{lookup?: (hostname:string, options:{all:true, verbatim:true}) => Promise<Array<{address:string, family:number}>>}} [options] */
export async function assertPublicHostname(hostname, options = {}) {
  const lookup = options.lookup ?? dnsLookup;
  if (isPrivateHostname(hostname)) throw new Error("private or local URL is blocked");
  if (net.isIP(hostname)) return hostname;
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`official DNS lookup failed: ${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error("official DNS lookup returned no addresses");
  if (addresses.some((entry) => isPrivateHostname(entry.address))) throw new Error("official domain resolves to a private or local address");
  return hostname;
}

/** @param {string} raw @param {{allowHttp?: boolean, registry?: any}} [options] */
export function validateOfficialUrl(raw, options = {}) {
  const { allowHttp = false, registry } = options;
  let url;
  try { url = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (!allowHttp && url.protocol !== "https:") throw new Error("official URL must use https");
  if (allowHttp && !["https:", "http:"].includes(url.protocol)) throw new Error("official URL protocol is not allowed");
  if (isPrivateHostname(url.hostname)) throw new Error("private or local URL is blocked");
  if (registryForUrl(url, registry)?.trustStatus !== "trusted") throw new Error("official domain is not trusted or allowlisted");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

export function validateRedirect(raw, options = {}) {
  return validateOfficialUrl(raw, options);
}

export async function validateOfficialUrlResolved(raw, options = {}) {
  const url = validateOfficialUrl(raw, options);
  await assertPublicHostname(url.hostname, options);
  return url;
}

export async function validatePublicSubresourceUrl(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("invalid subresource URL"); }
  if (["data:", "blob:"].includes(url.protocol)) return url;
  if (url.protocol !== "https:") throw new Error("browser subresource URL must use https");
  await assertPublicHostname(url.hostname, options);
  return url;
}
