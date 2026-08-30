import { registryForUrl } from "../../scripts/price-server/catalog/registry.mjs";
import { validateOfficialUrl } from "../../scripts/price-server/catalog/security.mjs";
import { fetchOfficial } from "../../scripts/price-server/catalog/fetch.mjs";
import { evidenceSearchReasonForFailureCode } from "./search-outcome.mjs";

const PDF_PATH = /\.pdf(?:$|[?#])/i;
const DOCUMENT_WORDS = /\b(?:manual|user[ -]?guide|installation|instructions?|datasheet|data[ -]?sheet|specification|quick[ -]?start|qsg|documentation)\b|说明书|用户手册|使用手册|安装指南|规格书/i;
const SUPPORT_WORDS = /\b(?:support|downloads?|documents?|resources?)\b|支持|下载|文档/i;
const REJECT_WORDS = /\b(?:driver|firmware|bios|utility|software|wallpaper|image|video|rohs|compliance|declaration|certificate|warranty|legal)\b/i;
const REJECT_PATH = /(?:\/(?:modal)(?:$|[?#]))|\.(?:png|jpe?g|gif|webp|svg|zip|exe|dmg|msi)(?:$|[?#])/i;
const MAX_ERROR_MESSAGE = 240;
const MAX_DISCOVERED_REFERENCES = 512;

function boundedErrorText(value, max = MAX_ERROR_MESSAGE) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export class EvidenceDiscoveryError extends Error {
  constructor(code, message, manualAction, cause) {
    const detail = cause ? boundedErrorText(cause instanceof Error ? cause.message : cause, 120) : "";
    super(boundedErrorText(`${message}${detail ? `: ${detail}` : ""}`), cause ? { cause } : undefined);
    this.name = "EvidenceDiscoveryError";
    this.code = code;
    this.reason = evidenceSearchReasonForFailureCode(code);
    this.manualAction = boundedErrorText(manualAction);
  }
}

function fail(code, message, manualAction, cause) {
  throw new EvidenceDiscoveryError(code, message, manualAction, cause);
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(
      "document_discovery_options_invalid",
      `${label} must be an integer between ${min} and ${max}`,
      "Correct the discovery request and retry.",
    );
  }
  return value;
}

function classifyFetchFailure(error) {
  if (error instanceof EvidenceDiscoveryError) throw error;
  const detail = boundedErrorText(error instanceof Error ? error.message : error, 160);
  if (/size limit|exceeds.*limit/i.test(detail)) {
    fail("document_discovery_too_large", "Official document discovery response exceeded the configured size limit", "Use a narrower official product or support page.", error);
  }
  if (/timeout|timed out|aborted/i.test(detail)) {
    fail("document_discovery_timeout", "Official document discovery timed out", "Retry later or inspect the official page manually.", error);
  }
  fail("document_discovery_fetch_failed", "Official document discovery fetch failed", "Retry later or inspect the official page manually.", error);
}

async function fetchPage(fetcher, url, fetchOptions, expectedBrand) {
  let result;
  try {
    result = await fetcher(url, { ...fetchOptions, expectedBrand, includeBody: false });
  } catch (error) {
    classifyFetchFailure(error);
  }
  if (!result || typeof result !== "object" || !Number.isInteger(result.status)) {
    fail("document_discovery_response_invalid", "Official document discovery received an invalid fetch result", "Retry through the built-in official fetcher.");
  }
  if (result.status < 200 || result.status >= 300) {
    fail("document_discovery_http_status", `Official document discovery returned HTTP ${result.status}`, "Review access on the official site or retry later.");
  }
  if (typeof result.finalUrl !== "string" || typeof result.body !== "string") {
    fail("document_discovery_response_invalid", "Official document discovery received an invalid fetch result", "Retry through the built-in official fetcher.");
  }
  let finalUrl;
  try {
    finalUrl = validateOfficialUrl(result.finalUrl).toString();
  } catch (error) {
    fail("document_discovery_response_invalid", "Official document discovery returned an invalid final URL", "Retry through the built-in official fetcher.", error);
  }
  return { ...result, finalUrl };
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 240);
}

function canonicalUrl(raw, base) {
  const resolved = new URL(decodeHtml(raw), base);
  resolved.hash = "";
  return validateOfficialUrl(resolved.toString()).toString();
}

function unescapeEmbedded(value) {
  return decodeHtml(value)
    .replace(/\\u002f/gi, "/")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/");
}

function addReference(output, seen, raw, base, title = "") {
  if (output.length >= MAX_DISCOVERED_REFERENCES) return;
  const value = unescapeEmbedded(String(raw ?? "")).trim();
  if (!value || value.length > 4_096) return;
  try {
    const url = canonicalUrl(value, base);
    if (seen.has(url)) return;
    seen.add(url);
    output.push({ url, title: stripTags(title) });
  } catch {
    // Invalid, non-HTTPS and non-official references are discovery misses.
  }
}

function anchors(html, base) {
  const output = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html ?? "").matchAll(anchor)) {
    const href = match[1] ?? match[2] ?? match[3];
    addReference(output, seen, href, base, match[4]);
    if (output.length >= MAX_DISCOVERED_REFERENCES) break;
  }
  return output;
}

function embeddedReferences(html, base) {
  const output = anchors(html, base);
  const seen = new Set(output.map((candidate) => candidate.url));
  const source = unescapeEmbedded(String(html ?? ""));
  const tagPattern = /<[a-z][^>]{0,8192}>/gi;
  const attributePattern = /\b(href|src|download|data-[a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const labelPattern = /\b(?:title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  for (const tagMatch of source.matchAll(tagPattern)) {
    const tag = tagMatch[0];
    const labelMatch = labelPattern.exec(tag);
    const label = labelMatch?.[1] ?? labelMatch?.[2] ?? labelMatch?.[3] ?? "";
    for (const attribute of tag.matchAll(attributePattern)) {
      const raw = attribute[2] ?? attribute[3] ?? attribute[4];
      const evidenceText = `${attribute[1]} ${raw ?? ""} ${label}`;
      if (!PDF_PATH.test(String(raw ?? "")) && !DOCUMENT_WORDS.test(evidenceText) && !SUPPORT_WORDS.test(evidenceText)) continue;
      addReference(output, seen, raw, base, label);
      if (output.length >= MAX_DISCOVERED_REFERENCES) return output;
    }
  }

  const explicitPdf = /(?<![a-z0-9._~:-])(?:https?:\/\/|\/\/|\.\.?\/|\/)[^\s"'<>\\]{1,4096}\.pdf(?:[?#][^\s"'<>\\]{0,1024})?/gi;
  for (const match of source.matchAll(explicitPdf)) {
    addReference(output, seen, match[0], base, "Embedded official PDF");
    if (output.length >= MAX_DISCOVERED_REFERENCES) return output;
  }
  const assignedPdf = /[:=]\s*["']([^"'<>\r\n]{1,4096}\.pdf(?:[?#][^"'<>\r\n]{0,1024})?)["']/gi;
  for (const match of source.matchAll(assignedPdf)) {
    addReference(output, seen, match[1], base, "Embedded official PDF");
    if (output.length >= MAX_DISCOVERED_REFERENCES) return output;
  }
  return output;
}

function normalizedTokens(values) {
  return [...new Set((values ?? []).flatMap((value) => String(value ?? "").toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)).filter((token) => token.length >= 2))].slice(0, 24);
}

function scoreCandidate(candidate, tokens) {
  const text = `${candidate.title ?? ""} ${candidate.url}`;
  if (REJECT_PATH.test(candidate.url) || REJECT_WORDS.test(text)) return -1;
  let score = 0;
  if (PDF_PATH.test(candidate.url)) score += 100;
  if (DOCUMENT_WORDS.test(text)) score += 50;
  if (SUPPORT_WORDS.test(text)) score += 15;
  score += Math.min(30, tokens.filter((token) => text.toLocaleLowerCase().includes(token)).length * 10);
  return score;
}

function kindHint(candidate) {
  const text = `${candidate.title ?? ""} ${candidate.url}`;
  if (/data[ -]?sheet|规格书/i.test(text)) return "datasheet";
  if (/quick[ -]?(?:start|installation)|qsg/i.test(text)) return "support-document";
  return "manufacturer-manual";
}

function sameOfficialBrand(left, right) {
  const a = registryForUrl(new URL(left));
  const b = registryForUrl(new URL(right));
  return Boolean(a?.trustStatus === "trusted" && b?.trustStatus === "trusted" && a.brand === b.brand);
}

function officialFailure(candidates, warnings = []) {
  if (candidates.length > 0) return null;
  const terminalWarning = warnings.at(-1);
  const reason = terminalWarning?.reason ?? "official_search_exhausted";
  return Object.freeze({
    reason,
    detail: terminalWarning
      ? `Official discovery completed without a usable exact document after a governed page failure: ${boundedErrorText(terminalWarning.message, 240)}`
      : "Official discovery completed without a usable exact document candidate.",
    manualAction: reason === "official_access_blocked"
      ? "Retry the official site later without bypassing its access controls, or inspect it manually."
      : "Confirm the exact model/revision and inspect another governed official support or document page.",
  });
}

function ranked(candidates, startUrl, tokens, limit, options = {}) {
  const byUrl = new Map();
  for (const candidate of candidates) {
    if (!sameOfficialBrand(startUrl, candidate.url)) continue;
    const score = scoreCandidate(candidate, tokens);
    if (score < 40) continue;
    const candidateText = `${candidate.title ?? ""} ${candidate.url}`;
    const pdf = PDF_PATH.test(candidate.url);
    if (!options.forFollow && !pdf && !DOCUMENT_WORDS.test(candidateText)) continue;
    if (!options.forFollow && !pdf && tokens.length > 1) {
      const normalized = candidateText.toLocaleLowerCase();
      if (!tokens.slice(1).some((token) => normalized.includes(token))) continue;
    }
    const row = {
      url: candidate.url,
      title: candidate.title || new URL(candidate.url).pathname.split("/").filter(Boolean).at(-1) || "Official document",
      mediaTypeHint: pdf ? "application/pdf" : "text/html",
      kindHint: kindHint(candidate),
      score,
      discoveredFrom: candidate.discoveredFrom ?? startUrl,
    };
    const current = byUrl.get(row.url);
    if (!current || row.score > current.score) byUrl.set(row.url, row);
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, limit);
}

/**
 * Discover manual/datasheet links from one trusted official page. This does
 * not persist content. At most `followPageLimit` same-brand support pages are
 * fetched once, keeping discovery bounded and SSRF checks inside fetchOfficial.
 */
export async function discoverOfficialDocumentLinks(rawUrl, options = {}) {
  let startUrl;
  try {
    startUrl = validateOfficialUrl(String(rawUrl ?? "")).toString();
  } catch (error) {
    fail("document_discovery_url_invalid", "Official document discovery requires a trusted HTTPS URL", "Provide a public URL from the governed official-domain registry.", error);
  }
  const fetcher = options.fetcher ?? fetchOfficial;
  const limit = boundedInteger(options.limit, 12, 1, 30, "limit");
  const followPageLimit = boundedInteger(options.followPageLimit, 2, 0, 3, "followPageLimit");
  if (options.queryTokens !== undefined && !Array.isArray(options.queryTokens)) {
    fail("document_discovery_options_invalid", "queryTokens must be an array", "Correct the discovery request and retry.");
  }
  const tokens = normalizedTokens(options.queryTokens);
  const startBrand = registryForUrl(new URL(startUrl))?.brand;
  const initial = await fetchPage(fetcher, startUrl, options.fetchOptions ?? {}, startBrand);
  const finalUrl = initial.finalUrl;
  if (!sameOfficialBrand(startUrl, finalUrl)) {
    fail("document_discovery_brand_mismatch", "Official document discovery crossed to another manufacturer brand", "Review the exact official URL before continuing.");
  }
  if (String(initial.contentType ?? "").toLocaleLowerCase().includes("pdf") || PDF_PATH.test(finalUrl)) {
    const candidates = ranked([{ url: finalUrl, title: options.title ?? "Official document", discoveredFrom: startUrl }], startUrl, tokens, limit);
    return {
      startUrl,
      finalUrl,
      officialBrand: registryForUrl(new URL(finalUrl))?.brand ?? null,
      candidates,
      pagesInspected: 1,
      warnings: [],
      officialFailure: officialFailure(candidates),
    };
  }

  const direct = embeddedReferences(initial.body, finalUrl).map((candidate) => ({ ...candidate, discoveredFrom: finalUrl }));
  const supportPages = ranked(direct.filter((candidate) => !PDF_PATH.test(candidate.url)), startUrl, tokens, followPageLimit, { forFollow: true });
  const followed = [];
  const warnings = [];
  const warningAudits = [];
  for (const page of supportPages) {
    try {
      const response = await fetchPage(fetcher, page.url, options.fetchOptions ?? {}, startBrand);
      const followedUrl = response.finalUrl;
      if (!sameOfficialBrand(startUrl, followedUrl)) {
        fail("document_discovery_brand_mismatch", "Official support-page discovery crossed to another manufacturer brand", "Review the exact official URL before continuing.");
      }
      if (String(response.contentType ?? "").toLocaleLowerCase().includes("pdf") || PDF_PATH.test(followedUrl)) followed.push({ url: followedUrl, title: page.title, discoveredFrom: page.url });
      else followed.push(...embeddedReferences(response.body, followedUrl).map((candidate) => ({ ...candidate, discoveredFrom: followedUrl })));
    } catch (error) {
      warnings.push(`${page.url}: ${String(error?.message ?? error).slice(0, 240)}`);
      warningAudits.push({
        reason: error?.reason ?? evidenceSearchReasonForFailureCode(error?.code),
        message: error?.message ?? error,
      });
    }
  }
  const candidates = ranked([...direct, ...followed], startUrl, tokens, limit);
  return {
    startUrl,
    finalUrl,
    officialBrand: registryForUrl(new URL(finalUrl))?.brand ?? null,
    candidates,
    pagesInspected: 1 + supportPages.length,
    warnings,
    officialFailure: officialFailure(candidates, warningAudits),
  };
}
