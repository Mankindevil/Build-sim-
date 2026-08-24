import crypto from "node:crypto";
import path from "node:path";
import { atomicWriteJson, readJson, restoreLatestRollback, root as repoRoot } from "../store.mjs";
import { loadOfficialRegistry, registryForUrl } from "./registry.mjs";

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeText(value) { return String(value ?? "").slice(0, 240); }
function resolved(options = {}) {
  const persistRoot = options.persistRoot ?? repoRoot;
  const proposalPath = options.proposalPath ?? path.join(persistRoot, "data/catalog-domain-proposals/proposals.json");
  const registryPath = options.registryPath ?? path.join(persistRoot, "data/catalog/official-domains.json");
  const rollbackRoot = options.rollbackRoot ?? path.join(persistRoot, "data/audit/rollback");
  const proposalManifestPath = options.proposalManifestPath ?? path.join(rollbackRoot, "domain-proposals-manifest.json");
  const registryManifestPath = options.registryManifestPath ?? path.join(rollbackRoot, "official-registry-manifest.json");
  return { ...options, persistRoot, proposalPath, registryPath, rollbackRoot, proposalManifestPath, registryManifestPath };
}
async function loadFile(options) { return (await readJson(options.proposalPath, { schemaVersion: "1.0.0", proposals: [], events: [] })) ?? { schemaVersion: "1.0.0", proposals: [], events: [] }; }
async function saveFile(file, options) { await atomicWriteJson(options.proposalPath, file, { operation: "catalog-domain-proposals", rollbackRoot: options.rollbackRoot, manifestPath: options.proposalManifestPath }); }

export async function createDomainProposal(input, options = {}) {
  const config = resolved(options);
  if (!input?.brand) return { status: "blocked", reasons: ["proposal brand is required"] };
  let url;
  try { url = new URL(input.url); } catch { return { status: "blocked", reasons: ["proposal URL is invalid"] }; }
  if (url.protocol !== "https:") return { status: "blocked", reasons: ["proposal URL must use https"] };
  const domain = url.hostname.toLocaleLowerCase();
  if (registryForUrl(url)) return { status: "blocked", reasons: ["domain already exists in registry"] };
  const inputHash = sha256(JSON.stringify({ brand: input.brand, domain, url: url.toString(), provider: input.provider, mpn: input.mpn }));
  const proposalId = `domain-proposal-${sha256(`${String(input.brand).toLocaleLowerCase()}|${domain}`).slice(0, 20)}`;
  const file = await loadFile(config);
  const existing = file.proposals.find((proposal) => proposal.proposalId === proposalId);
  if (existing) return existing;
  const timestamp = now();
  const proposal = { schemaVersion: "1.0.0", proposalId, inputHash, brand: safeText(input.brand), domain, trustStatus: "proposed", discoveryProvider: safeText(input.provider), discoveredUrl: url.toString(), ...(input.finalUrl ? { finalUrl: String(input.finalUrl) } : {}), redirects: Array.isArray(input.redirects) ? input.redirects.slice(0, 8).map(String) : [], ...(input.mpn ? { exactMpnEvidence: { mpn: safeText(input.mpn), locator: "discovery query and candidate URL", snippet: safeText(`${input.title ?? ""} ${url.pathname}`) } } : {}), reason: safeText(input.reason ?? "discovered brand domain is not in the governed registry"), createdAt: timestamp, updatedAt: timestamp };
  const event = { eventId: `proposal-event-${sha256(`create|${proposalId}`).slice(0, 20)}`, operation: "create", proposalId, inputHash, createdAt: timestamp };
  await saveFile({ ...file, proposals: [...file.proposals, proposal], events: [...file.events, event] }, config);
  return proposal;
}

export async function listDomainProposals(options = {}) { const file = await loadFile(resolved(options)); return { schemaVersion: file.schemaVersion, proposals: file.proposals, events: file.events }; }

export async function decideDomainProposal(proposalId, decision, expectedHash, options = {}) {
  const config = resolved(options);
  if (!["approved", "rejected"].includes(decision)) throw new Error("proposal decision must be approved or rejected");
  const file = await loadFile(config);
  const proposal = file.proposals.find((entry) => entry.proposalId === proposalId);
  if (!proposal) return { status: "blocked", proposalId, reasons: ["proposal not found"] };
  if (!expectedHash || proposal.inputHash !== expectedHash) return { status: "blocked", proposalId, reasons: ["proposal hash mismatch"] };
  if (proposal.trustStatus !== "proposed") return { status: proposal.trustStatus, proposalId, inputHash: proposal.inputHash };
  const timestamp = now();
  if (decision === "approved") {
    const registry = await readJson(config.registryPath, null);
    if (!registry) throw new Error("official registry file not found");
    const existingBrand = registry.brands.find((entry) => [entry.brand, ...(entry.aliases ?? [])].some((brand) => brand.toLocaleLowerCase() === proposal.brand.toLocaleLowerCase()));
    const brands = existingBrand ? registry.brands.map((entry) => entry === existingBrand ? { ...entry, domains: [...new Set([...entry.domains, proposal.domain])], trustStatus: "trusted", source: "manual", approvedAt: timestamp } : entry) : [...registry.brands, { brand: proposal.brand, domains: [proposal.domain], trustStatus: "trusted", source: "manual", approvedAt: timestamp }];
    const nextRegistry = { ...registry, updatedAt: timestamp, brands };
    loadOfficialRegistry(nextRegistry);
    await atomicWriteJson(config.registryPath, nextRegistry, { operation: "approve-official-domain", rollbackRoot: config.rollbackRoot, manifestPath: config.registryManifestPath });
  }
  const next = { ...proposal, trustStatus: decision === "approved" ? "trusted" : "rejected", decidedAt: timestamp, updatedAt: timestamp };
  const event = { eventId: `proposal-event-${sha256(`${decision}|${proposalId}|${expectedHash}`).slice(0, 20)}`, operation: decision, proposalId, inputHash: expectedHash, ...(decision === "approved" ? { registryManifest: config.registryManifestPath } : {}), createdAt: timestamp };
  await saveFile({ ...file, proposals: file.proposals.map((entry) => entry.proposalId === proposalId ? next : entry), events: [...file.events, event] }, config);
  return { status: next.trustStatus, proposalId, inputHash: expectedHash, ...(decision === "approved" ? { registryManifest: config.registryManifestPath } : {}) };
}

export async function rollbackDomainApproval(options = {}) { const config = resolved(options); return restoreLatestRollback(config.registryPath, { manifestPath: config.registryManifestPath }); }
