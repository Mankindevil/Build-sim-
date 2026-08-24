import { AGENT_CONTRACT_VERSION, type AgentToolContext, type AgentToolResult, type AgentToolSpec, type JsonSchema } from "../agent/contracts";
import { loadBundledCatalog, loadBundledPriceSnapshot } from "../sku/catalog";
import type { BuildConfig, BuildSelection } from "../config/types";
import type { BuildEvaluation } from "../core/evaluate";
import { evaluateBuildAuthoritatively } from "./evaluation-service";

const PRICE_SERVICE = "http://127.0.0.1:5174";
const SECTION_NAMES = ["findings", "bom", "occupancy", "wiring", "routing", "assembly", "power", "price", "noise", "physical", "calibration", "thermal"] as const;
type Section = typeof SECTION_NAMES[number];

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function requireConfig(context: AgentToolContext): BuildConfig {
  if (!context.buildConfig) throw new Error("Active Agent session has no validated BuildConfig");
  return context.buildConfig;
}

function verdict(evaluation: BuildEvaluation): "ok" | "warn" | "bad" {
  return evaluation.findings.some((finding) => finding.verdict === "bad") ? "bad" : evaluation.findings.some((finding) => finding.verdict === "warn") ? "warn" : "ok";
}

function evaluationProjection(evaluation: BuildEvaluation, sections: Section[]) {
  const projection: Record<string, unknown> = {};
  for (const name of sections) {
    projection[name] = name === "thermal" && evaluation.thermal === undefined
      ? { status: "unknown", reason: "thermal inputs were not supplied" }
      : evaluation[name];
  }
  return projection;
}

function selectedSections(input: unknown): Section[] {
  const requested = (input as { sections?: Section[] }).sections;
  return requested?.length ? requested : ["findings", "bom", "power", "price", "noise", "physical", "calibration"];
}

async function localService(pathname: string, body: unknown, signal: AbortSignal, method: "GET" | "POST" = "POST"): Promise<AgentToolResult> {
  try {
    const response = await fetch(`${PRICE_SERVICE}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    const payload = await response.json().catch(() => ({ error: "local service returned invalid JSON" }));
    if (!response.ok) return { ok: false, content: payload, errorCode: "local_service_rejected", message: `Local price/catalog service returned HTTP ${response.status}`, provenance: [`local-service:${pathname}`] };
    return { ok: true, content: payload, provenance: [`local-service:${pathname}`] };
  } catch (error) {
    return { ok: false, content: null, errorCode: "local_service_unavailable", message: error instanceof Error ? error.message : "Local price/catalog service unavailable", provenance: [`local-service:${pathname}`] };
  }
}

const getBuildEvaluation: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "get_build_evaluation",
  title: "读取当前装机评估",
  description: "Recompute the active BuildConfig on the server and return selected authoritative BuildEvaluation sections, hashes, versions, verdict, and explicit unknowns. Use this before making compatibility, wiring, power, thermal, physical, calibration, BOM, or price claims.",
  effect: "read",
  approval: "never",
  timeoutMs: 5_000,
  maxResultBytes: 160_000,
  inputSchema: schema({ sections: { type: "array", items: { type: "string", enum: SECTION_NAMES }, maxItems: SECTION_NAMES.length, uniqueItems: true } }),
  async execute(input, context) {
    const result = evaluateBuildAuthoritatively(requireConfig(context));
    return {
      ok: true,
      content: {
        schemaVersion: result.schemaVersion,
        configHash: result.configHash,
        evaluationHash: result.evaluationHash,
        catalogVersion: result.catalogVersion,
        priceSnapshotVersion: result.priceSnapshotVersion,
        verdict: verdict(result.evaluation),
        sections: evaluationProjection(result.evaluation, selectedSections(input)),
      },
      provenance: ["BuildEvaluation", result.catalogVersion, result.priceSnapshotVersion],
    };
  },
};

const selectionProperties: Record<keyof BuildSelection, unknown> = {
  psuId: { type: "string", minLength: 1, maxLength: 120 },
  psuTopology: { type: "string", enum: ["auto", "bottom", "dual"] },
  secondaryPsuId: { type: "string", minLength: 1, maxLength: 120 },
  dualStart: { type: "string", enum: ["sync", "none"] },
  coolerId: { type: "string", minLength: 1, maxLength: 120 },
  gpuId: { type: "string", minLength: 1, maxLength: 120 },
  memoryId: { type: "string", minLength: 1, maxLength: 120 },
  diskCount: { type: "integer", minimum: 0, maximum: 9 },
  diskSkuId: { type: "string", minLength: 1, maxLength: 120 },
  nvmeCount: { type: "integer", minimum: 0, maximum: 16 },
  boot: { type: "string", enum: ["bay", "m2", "usbssd"] },
  hbaMode: { type: "string", enum: ["auto", "always"] },
  hbaSkuId: { type: "string", minLength: 1, maxLength: 120 },
};

const compareBuilds: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "compare_builds",
  title: "比较候选配置",
  description: "Apply a bounded selection patch to a copy of the active configuration, validate it, recompute both builds, and return deterministic differences. This never mutates the active Build Lab configuration.",
  effect: "read",
  approval: "never",
  timeoutMs: 8_000,
  maxResultBytes: 100_000,
  inputSchema: schema({ selectionPatch: { type: "object", properties: selectionProperties, additionalProperties: false } }, ["selectionPatch"]),
  async execute(input, context) {
    const baselineConfig = requireConfig(context);
    const patch = (input as { selectionPatch: Partial<BuildSelection> }).selectionPatch;
    const candidateConfig: BuildConfig = { ...baselineConfig, selection: { ...baselineConfig.selection, ...patch } };
    const baseline = evaluateBuildAuthoritatively(baselineConfig);
    const candidate = evaluateBuildAuthoritatively(candidateConfig);
    const before = new Map(baseline.evaluation.findings.map((finding) => [finding.id, finding]));
    const after = new Map(candidate.evaluation.findings.map((finding) => [finding.id, finding]));
    return {
      ok: true,
      content: {
        selectionPatch: patch,
        baseline: { evaluationHash: baseline.evaluationHash, verdict: verdict(baseline.evaluation), power: baseline.evaluation.power, price: baseline.evaluation.price, physical: baseline.evaluation.physical },
        candidate: { evaluationHash: candidate.evaluationHash, verdict: verdict(candidate.evaluation), power: candidate.evaluation.power, price: candidate.evaluation.price, physical: candidate.evaluation.physical },
        findingChanges: {
          added: [...after.values()].filter((finding) => !before.has(finding.id)),
          removed: [...before.values()].filter((finding) => !after.has(finding.id)),
          changed: [...after.values()].filter((finding) => before.has(finding.id) && JSON.stringify(before.get(finding.id)) !== JSON.stringify(finding)),
        },
      },
      provenance: ["BuildEvaluation:baseline", "BuildEvaluation:candidate", baseline.catalogVersion, baseline.priceSnapshotVersion],
    };
  },
};

const getSkuFacts: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "get_sku_facts",
  title: "读取 SKU 参数与证据",
  description: "Return bounded catalog fields and field-level provenance for exact SKU ids. Missing values remain absent or unknown; this tool does not search the web or infer a product identity.",
  effect: "read",
  approval: "never",
  timeoutMs: 3_000,
  maxResultBytes: 80_000,
  inputSchema: schema({
    skuIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, minItems: 1, maxItems: 12, uniqueItems: true },
    fields: { type: "array", items: { type: "string", enum: ["identity", "dims", "power", "harness", "modularPanel", "interfaceNotes", "warrantyMonths", "attrs", "price", "appearance", "provenance"] }, maxItems: 11, uniqueItems: true },
  }, ["skuIds"]),
  async execute(input) {
    const catalog = loadBundledCatalog();
    const value = input as { skuIds: string[]; fields?: string[] };
    const fields = value.fields?.length ? value.fields : ["identity", "dims", "power", "attrs", "price", "provenance"];
    const records = value.skuIds.map((skuId) => {
      const sku = catalog.skus.find((entry) => entry.id === skuId);
      if (!sku) return { skuId, status: "unknown-sku" };
      const all: Record<string, unknown> = {
        identity: { id: sku.id, category: sku.category, brand: sku.brand, model: sku.model, name: sku.name, mpn: sku.mpn ?? null },
        dims: sku.dims, power: sku.power, harness: sku.harness ?? null, modularPanel: sku.modularPanel ?? null,
        interfaceNotes: sku.interfaceNotes ?? [], warrantyMonths: sku.warrantyMonths ?? null, attrs: sku.attrs ?? {}, price: sku.price,
        appearance: sku.appearance ?? null, provenance: sku.provenance ?? [],
      };
      return { skuId, status: "found", fields: Object.fromEntries(fields.map((field) => [field, all[field]])) };
    });
    return { ok: true, content: { catalogVersion: catalog.catalogVersion ?? `${catalog.schemaVersion}:${catalog.updatedAt}`, records }, provenance: ["data/skus/catalog.json", "data/prices/latest.json"] };
  },
};

const getPriceSnapshot: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "get_price_snapshot",
  title: "读取审计价格快照",
  description: "Read locally audited price snapshot rows for requested SKU ids. It never presents opening prices, search cards, or unaudited candidates as confirmed current prices.",
  effect: "read",
  approval: "never",
  timeoutMs: 3_000,
  maxResultBytes: 60_000,
  inputSchema: schema({ skuIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 32, uniqueItems: true } }),
  async execute(input) {
    const snapshot = loadBundledPriceSnapshot();
    const requested = new Set((input as { skuIds?: string[] }).skuIds ?? []);
    const quotes = requested.size ? snapshot.quotes.filter((quote) => requested.has(quote.skuId)) : snapshot.quotes;
    return { ok: true, content: { schemaVersion: snapshot.schemaVersion, asOf: snapshot.asOf, note: snapshot.note, quotes }, provenance: ["data/prices/latest.json", `snapshot:${snapshot.asOf}`] };
  },
};

const searchOfficialCatalog: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "search_official_catalog",
  title: "搜索官方型号候选",
  description: "Queue an allowlisted official-domain model search through the existing local catalog service. Results are candidates only and cannot enter the formal SKU catalog without separate human confirmation.",
  effect: "external-read",
  approval: "never",
  timeoutMs: 30_000,
  maxResultBytes: 80_000,
  inputSchema: schema({ query: { type: "string", minLength: 2, maxLength: 240 }, brand: { type: "string", minLength: 1, maxLength: 80 }, category: { type: "string", maxLength: 40 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
  async execute(input, context) { return localService("/api/catalog/search", { ...input as object, officialOnly: true }, context.signal); },
};

const inspectCatalogCandidate: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "inspect_catalog_candidate",
  title: "检查官方商品页",
  description: "Inspect one explicit official product URL through the existing canonical-URL, allowlist, redirect, private-IP, response-size, conflict, and field-provenance safeguards.",
  effect: "external-read",
  approval: "never",
  timeoutMs: 30_000,
  maxResultBytes: 100_000,
  inputSchema: schema({ url: { type: "string", minLength: 10, maxLength: 2_000, pattern: "^https://" }, query: { type: "string", maxLength: 240 }, brand: { type: "string", maxLength: 80 }, category: { type: "string", maxLength: 40 } }, ["url"]),
  async execute(input, context) { return localService("/api/catalog/inspect", input, context.signal); },
};

const listOfficialDomainProposals: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "list_official_domain_proposals",
  title: "列出待治理官网域名",
  description: "List governed domain proposals from the fixed local catalog service. Proposed and rejected domains remain non-official and cannot be inspected as trusted sources.",
  effect: "external-read",
  approval: "never",
  timeoutMs: 10_000,
  maxResultBytes: 80_000,
  inputSchema: schema({}),
  async execute(_input, context) { return localService("/api/catalog/domain-proposals", null, context.signal, "GET"); },
};

const enrichOfficialCatalog: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "enrich_official_catalog",
  title: "按已核验候选补齐目录",
  description: "Write only one already-inspected candidate id and its expected immutable hash through the governed local enrichment policy. The Tool cannot submit fields, URLs, trust decisions, or model-authored values and always requires an out-of-band approval envelope.",
  effect: "write",
  approval: "required",
  timeoutMs: 30_000,
  maxResultBytes: 100_000,
  inputSchema: schema({ candidateId: { type: "string", minLength: 10, maxLength: 160 }, expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["candidateId", "expectedHash"]),
  async execute(input, context) {
    const value = input as { candidateId: string; expectedHash: string };
    return localService(`/api/catalog/candidates/${encodeURIComponent(value.candidateId)}/enrich`, { expectedHash: value.expectedHash }, context.signal);
  },
};

const searchPriceCandidates: AgentToolSpec = {
  contractVersion: AGENT_CONTRACT_VERSION,
  name: "search_price_candidates",
  title: "搜索价格候选",
  description: "Collect bounded marketplace and official-page price candidates through the existing local service. Every returned card remains unaudited and must not be used as a confirmed price until a human validates the exact variant.",
  effect: "external-read",
  approval: "never",
  timeoutMs: 60_000,
  maxResultBytes: 120_000,
  inputSchema: schema({
    skuIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, minItems: 1, maxItems: 12, uniqueItems: true },
    channels: { type: "array", items: { type: "string", enum: ["jd", "taobao", "pdd", "amazon", "official"] }, minItems: 1, maxItems: 5, uniqueItems: true },
    limit: { type: "integer", minimum: 1, maximum: 10 },
  }, ["skuIds"]),
  async execute(input, context) { return localService("/api/price/collect", input, context.signal); },
};

export function createBuildSimTools(): AgentToolSpec[] {
  return [getBuildEvaluation, compareBuilds, getSkuFacts, getPriceSnapshot, searchOfficialCatalog, inspectCatalogCandidate, listOfficialDomainProposals, enrichOfficialCatalog, searchPriceCandidates];
}
