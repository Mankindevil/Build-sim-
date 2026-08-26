const GENERIC_TOKENS = new Set([
  "official", "product", "products", "series", "spec", "specification", "specifications", "support", "manual",
  "power", "supply", "hard", "drive", "disk", "graphics", "card", "gaming", "edition", "desktop", "internal",
]);

const CATEGORY_DIMENSIONS = Object.freeze({
  psu: ["psuSeries", "psuVariant", "psuMpnSuffix", "wattage", "generation", "atxVersion"],
  storage: ["storageFamily", "storageTier", "capacity", "interface", "generation"],
  gpu: ["gpuChip", "coolerVariant", "capacity", "generation"],
  memory: ["memoryGeneration", "memorySpeed", "capacity", "memoryKind", "kitCount"],
  motherboard: ["chipset", "memoryGeneration", "generation"],
});

function clean(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[™®]/g, " ")
    .replace(/[‐‑‒–—−_/]+/g, "-")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9.+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparable(value) { return clean(value).replace(/[^a-z0-9]+/g, ""); }
function first(text, pattern, map = (match) => match[1]?.toLocaleLowerCase()) { const match = text.match(pattern); return match ? map(match) : undefined; }
function fieldValue(fields, name) { return fields?.find((field) => field.field === name)?.value; }
function unique(values) { return [...new Set(values.filter(Boolean))]; }

function identityTokens(value) {
  return unique(clean(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 2 && !GENERIC_TOKENS.has(token)));
}

function capacity(text) {
  return first(text, /\b(\d+(?:\.\d+)?)\s*(tb|gb|mb)\b/i, (match) => `${Number(match[1])}${match[2].toLocaleUpperCase()}`);
}

function wattage(text) {
  return first(text, /\b(\d{3,4})\s*w\b/i, (match) => `${Number(match[1])}W`)
    ?? first(text, /\b(?:gx|px|fx)[-\s]?(\d{3,4})\b/i, (match) => `${Number(match[1])}W`);
}

function fingerprint(textValue, category, explicit = {}) {
  const text = clean(textValue);
  const result = {
    brand: explicit.brand ? clean(explicit.brand) : undefined,
    mpn: explicit.mpn ? comparable(explicit.mpn) : undefined,
    model: explicit.model ? clean(explicit.model) : undefined,
    capacity: explicit.capacity ? String(explicit.capacity).toLocaleUpperCase().replace(/\s+/g, "") : capacity(text),
    interface: explicit.interface ? clean(explicit.interface) : first(text, /\b(sata|sas|nvme|pcie|pci-e|ide)\b/i),
    generation: first(text, /\b(?:v|gen(?:eration)?)[-\s]?(\d+)\b/i, (match) => `v${Number(match[1])}`),
    tokens: identityTokens(text),
  };
  if (category === "psu") {
    result.psuSeries = first(text, /\b(vertex|focus|prime|core)\b/i);
    result.psuVariant = first(text, /\b(gx|px|sgx|spx)\b/i);
    result.psuMpnSuffix = first(text, /\b(?:ssr[- ]?\d{3,4})?[- ]?(fx\d*|fm\d*)\b/i);
    result.wattage = wattage(text);
    result.atxVersion = first(text, /\batx\s*(3(?:\.\d+)?)\b/i, (match) => `atx-${match[1]}`);
  }
  if (category === "storage") {
    result.storageFamily = first(text, /\b(red|blue|black|gold|purple|ultrastar|exos|ironwolf)\b/i);
    result.storageTier = first(text, /\b(pro|plus)\b/i);
  }
  if (category === "gpu") {
    result.gpuChip = first(text, /\b(rtx|gtx|rx)\s*[- ]?(\d{3,4})(?:\s*[- ]?(ti|super|xtx|xt))?\b/i, (match) => [match[1], match[2], match[3]].filter(Boolean).join("-"));
    result.coolerVariant = first(text, /\b(ventus\s*[23]x|gaming\s*x\s*trio|gaming\s*trio|suprim\s*x|tuf\s*gaming|dual|strix)\b/i, (match) => clean(match[1]).replace(/\s+/g, "-"));
  }
  if (category === "memory" || category === "motherboard") {
    result.memoryGeneration = first(text, /\bddr\s*([345])\b/i, (match) => `ddr${match[1]}`);
  }
  if (category === "memory") {
    result.memorySpeed = first(text, /\b(?:ddr[345][ -]?)?(\d{4,5})\s*(?:mt\/s|mhz)?\b/i, (match) => Number(match[1]));
    result.memoryKind = first(text, /\b(ecc|rdimm|udimm|sodimm)\b/i);
    result.kitCount = first(text, /\b(\d+)\s*[x×]\s*\d+\s*(?:gb|tb)\b/i, (match) => Number(match[1]));
  }
  if (category === "motherboard") result.chipset = first(text, /\b([abxzwh]\d{3,4})\b/i);
  return result;
}

function evidenceId(fields, name) { return fields?.find((field) => field.field === name)?.provenanceId; }

export function classifyOfficialPage(fetchResult, extracted, urlValue = fetchResult?.finalUrl) {
  const status = Number(fetchResult?.status ?? 0);
  if (status < 200 || status >= 300 || extracted?.accessBarrier) return { kind: "blocked", reasons: [`official fetch returned HTTP ${status || "unknown"}`] };
  let url;
  try { url = new URL(urlValue); } catch { return { kind: "unknown", reasons: ["canonical URL is invalid"] }; }
  const path = url.pathname.toLocaleLowerCase();
  if (fetchResult?.contentType?.includes("pdf")) return { kind: "datasheet", reasons: ["official PDF"] };
  if (/\/(?:search|search-result)(?:\/|$)/.test(path)) return { kind: "search", reasons: ["official site-search path"] };
  if (/(?:forum|community)/.test(url.hostname) || /\/(?:forum|community|t5)\//.test(path)) return { kind: "forum", reasons: ["official community/forum path"] };
  if (/\/(?:news|blog|insights|press)(?:\/|$)/.test(path)) return { kind: "article", reasons: ["official editorial path"] };
  if (/\/(?:support|supportonly|helpdesk|download|manual)(?:\/|$|_)/.test(path)) return { kind: "support", reasons: ["official support path"] };
  const fields = extracted?.fields ?? [];
  const identityCount = fields.filter((field) => ["brand", "model", "mpn"].includes(field.field)).length;
  const specificationCount = fields.filter((field) => /^(?:dims|power|attrs|harness)\./.test(field.field)).length;
  if (/specification|specifications|specs/.test(path) && identityCount) return { kind: "spec", reasons: ["official specification path with identity fields"] };
  if (identityCount >= 2 && specificationCount >= 1) return { kind: "product", reasons: ["identity and specification fields extracted"] };
  if (identityCount >= 1 && specificationCount >= 1) return { kind: "spec", reasons: ["model and specification fields extracted"] };
  if (identityCount === 1) return { kind: "unknown", reasons: ["only one identity field was extracted"] };
  return { kind: "unknown", reasons: ["no product-page identity evidence"] };
}

export function assessCatalogIdentity(candidate, extracted, officialEntry) {
  const fields = extracted?.fields ?? [];
  const category = candidate.category ?? candidate.query?.category;
  const queryText = [candidate.query?.raw, candidate.query?.model, candidate.query?.mpn].filter(Boolean).join(" ");
  // Discovery titles/snippets are intentionally excluded: only the fetched
  // official artifact, its canonical URL and extracted fields may prove identity.
  const candidateText = [extracted?.title, fieldValue(fields, "model"), fieldValue(fields, "mpn"), candidate.canonicalUrl].filter(Boolean).join(" ");
  const query = fingerprint(queryText, category, {
    brand: candidate.query?.brand ?? candidate.brand,
    model: candidate.query?.model ?? candidate.model,
    mpn: candidate.query?.mpn ?? candidate.mpn,
    capacity: candidate.query?.capacity,
    interface: candidate.query?.interface,
  });
  const found = fingerprint(candidateText, category, {
    brand: fieldValue(fields, "brand") ?? officialEntry?.brand,
    model: fieldValue(fields, "model"),
    mpn: fieldValue(fields, "mpn"),
    capacity: fieldValue(fields, "attrs.capacity"),
    interface: fieldValue(fields, "attrs.interface"),
  });
  const criticalMatches = [];
  const criticalConflicts = [];
  const unknowns = [];
  const compare = (field, left, right, provenanceId) => {
    if (left === undefined || left === "") return;
    if (right === undefined || right === "") { unknowns.push(field); return; }
    const entry = { field, input: left, candidate: right, ...(provenanceId ? { evidenceId: provenanceId } : {}) };
    if (String(left) === String(right)) criticalMatches.push(entry); else criticalConflicts.push(entry);
  };
  compare("brand", query.brand, found.brand, evidenceId(fields, "brand"));
  compare("mpn", query.mpn, found.mpn, evidenceId(fields, "mpn"));
  const modelEvidenceId = evidenceId(fields, "model");
  for (const dimension of CATEGORY_DIMENSIONS[category] ?? ["capacity", "interface", "generation"]) {
    compare(dimension, query[dimension], found[dimension], evidenceId(fields, dimension === "capacity" ? "attrs.capacity" : dimension === "interface" ? "attrs.interface" : dimension) ?? modelEvidenceId);
  }
  if (criticalConflicts.length) {
    return { verdict: "conflict", score: 0, criticalMatches, criticalConflicts, unknowns: unique(unknowns), queryFingerprint: query, candidateFingerprint: found, reasons: criticalConflicts.map((entry) => `${entry.field} conflicts: ${entry.input} != ${entry.candidate}`), agentReviewRequired: false };
  }
  const exactMpn = Boolean(query.mpn && found.mpn && query.mpn === found.mpn);
  const queryTokens = query.tokens.filter((token) => !query.brand || comparable(token) !== comparable(query.brand));
  const foundTokenSet = new Set(found.tokens);
  const overlap = queryTokens.filter((token) => foundTokenSet.has(token));
  const tokenCoverage = queryTokens.length ? overlap.length / queryTokens.length : 0;
  const brandProven = Boolean(query.brand && found.brand && comparable(query.brand) === comparable(found.brand));
  const comparedDimensions = criticalMatches.filter((entry) => entry.field !== "brand" && entry.field !== "mpn").length;
  const missingCritical = unknowns.length > 0;
  const strongStructured = brandProven && comparedDimensions >= 2 && !missingCritical && tokenCoverage >= 0.55;
  const exactModel = Boolean(query.model && found.model && comparable(query.model) === comparable(found.model) && brandProven);
  if (exactMpn || exactModel || strongStructured) {
    return { verdict: "exact", score: exactMpn ? 1 : exactModel ? 0.95 : Math.min(0.94, 0.75 + tokenCoverage * 0.2), criticalMatches, criticalConflicts, unknowns: [], queryFingerprint: query, candidateFingerprint: found, tokenCoverage, reasons: exactMpn ? ["official MPN exactly matches"] : exactModel ? ["official brand and model exactly match"] : ["all supplied category discriminators match"], agentReviewRequired: false };
  }
  const familyOverlap = overlap.filter((token) => /[a-z]/.test(token) || token.length >= 3).length;
  if (brandProven && (familyOverlap >= 1 || criticalMatches.length >= 2)) {
    return { verdict: "same-family", score: Math.min(0.69, 0.35 + tokenCoverage * 0.3), criticalMatches, criticalConflicts, unknowns: unique(unknowns), queryFingerprint: query, candidateFingerprint: found, tokenCoverage, reasons: ["official page appears related but exact variant is not proven"], agentReviewRequired: true };
  }
  return { verdict: "insufficient-evidence", score: Math.min(0.39, tokenCoverage * 0.3), criticalMatches, criticalConflicts, unknowns: unique([...(query.brand && !found.brand ? ["brand"] : []), ...unknowns, "exact model identity"]), queryFingerprint: query, candidateFingerprint: found, tokenCoverage, reasons: ["official page does not prove the same product identity"], agentReviewRequired: true };
}

export function summarizeCatalogCandidates(candidates = [], discoveredCount = candidates.length) {
  const summary = { discovered: discoveredCount, inspected: 0, fetchSucceeded: 0, productPages: 0, exact: 0, sameFamily: 0, conflicts: 0, insufficientEvidence: 0, blocked: 0, searchLinks: 0 };
  for (const candidate of candidates) {
    if (candidate.extraction?.status !== "not-run") summary.inspected += 1;
    if (candidate.source?.httpStatus >= 200 && candidate.source?.httpStatus < 300) summary.fetchSucceeded += 1;
    if (["product", "spec", "datasheet", "support"].includes(candidate.official?.pageKind)) summary.productPages += 1;
    if (candidate.official?.pageKind === "blocked") summary.blocked += 1;
    if (candidate.official?.pageKind === "search") summary.searchLinks += 1;
    if (candidate.identity?.verdict === "exact") summary.exact += 1;
    else if (candidate.identity?.verdict === "same-family") summary.sameFamily += 1;
    else if (candidate.identity?.verdict === "conflict") summary.conflicts += 1;
    else if (candidate.identity?.verdict === "insufficient-evidence") summary.insufficientEvidence += 1;
  }
  return summary;
}
