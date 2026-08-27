import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { registryForUrl } from "./registry.mjs";

export const DEFAULT_FETCH_LIMITS = Object.freeze({ maxBytes: 5_000_000, timeoutMs: 15_000, maxRedirects: 4 });

function ipv4NonGlobal(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Groups(hostname) {
  const raw = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0];
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => part ? part.split(":").filter(Boolean) : [];
  const left = parse(halves[0]);
  const right = parse(halves[1]);
  const expandIpv4 = (groups) => {
    if (!groups.length || !groups.at(-1).includes(".")) return groups;
    const tail = groups.at(-1);
    if (!net.isIPv4(tail)) return null;
    const bytes = tail.split(".").map(Number);
    return [...groups.slice(0, -1), ((bytes[0] << 8) | bytes[1]).toString(16), ((bytes[2] << 8) | bytes[3]).toString(16)];
  };
  const expandedLeft = expandIpv4(left);
  const expandedRight = expandIpv4(right);
  if (!expandedLeft || !expandedRight) return null;
  const missing = 8 - expandedLeft.length - expandedRight.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...expandedLeft, ...Array.from({ length: missing }, () => "0"), ...expandedRight];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function ipv6NonGlobal(hostname) {
  const groups = ipv6Groups(hostname);
  if (!groups) return true;
  const [a, b, c, d, e, f, g, h] = groups;
  const mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  if (mapped) return ipv4NonGlobal(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  // IPv4-compatible ::/96 addresses are deprecated/reserved; only the
  // explicit ::ffff:0:0/96 mapped form above may inherit IPv4 reachability.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return true;
  // Today, public global-unicast IPv6 space is 2000::/3. Everything else is
  // link-local, unique-local, multicast, documentation, transition or reserved.
  if ((a & 0xe000) !== 0x2000) return true;
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2001 && (b === 0 || b === 2 || (b & 0xfff0) === 0x20)) return true; // Teredo/benchmark/ORCHID
  if (a === 0x2002) return true; // deprecated 6to4 can embed non-global IPv4
  if (a === 0x3fff && (b & 0xf000) === 0) return true; // documentation 3fff::/20
  return false;
}

export function isPrivateHostname(hostname) {
  const value = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "localhost.localdomain"].includes(value) || value.endsWith(".local") || value.endsWith(".internal")) return true;
  if (net.isIPv4(value)) return ipv4NonGlobal(value);
  if (net.isIPv6(value)) return ipv6NonGlobal(value);
  return false;
}

/** @param {string} hostname @param {{lookup?: (hostname:string, options:{all:true, verbatim:true}) => Promise<Array<{address:string, family:number}>>}} [options] */
export async function resolvePublicAddresses(hostname, options = {}) {
  const lookup = options.lookup ?? dnsLookup;
  if (isPrivateHostname(hostname)) throw new Error("private or local URL is blocked");
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) }];
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`official DNS lookup failed: ${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error("official DNS lookup returned no addresses");
  if (addresses.some((entry) => isPrivateHostname(entry.address))) throw new Error("official domain resolves to a private or local address");
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

export async function assertPublicHostname(hostname, options = {}) {
  await resolvePublicAddresses(hostname, options);
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
  const registryEntry = registry === undefined ? registryForUrl(url) : registryForUrl(url, registry);
  if (registryEntry?.trustStatus !== "trusted") throw new Error("official domain is not trusted or allowlisted");
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
