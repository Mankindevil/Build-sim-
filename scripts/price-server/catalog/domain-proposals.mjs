import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  atomicWriteFile,
  atomicWriteJson,
  confined,
  ensurePrivateDirectory,
  sha256Bytes,
  withDirectoryLock,
} from "../../../src/runtime/fs.mjs";
import { RuntimeCoordinator } from "../../../src/runtime/coordinator.mjs";
import {
  OFFICIAL_DOMAIN_SEED_PATH,
  activateOfficialRegistry,
  activateOfficialRegistryRepository,
  loadOfficialRegistry,
  loadOfficialRegistryRepository,
  mergeOfficialRegistry,
  officialRegistryDocument,
  registryForUrl,
  assertOfficialDomainOverlayDocument,
  assertOfficialDomainRegistryDocument,
} from "./registry.mjs";

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeText(value) { return String(value ?? "").slice(0, 240); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function exactKeys(value, allowed) { return Object.keys(value).every((key) => allowed.has(key)); }
function sha256Hash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function domainApprovalId(value) { return typeof value === "string" && /^domain-approval-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value); }

function assertDomainHostname(value) {
  if (typeof value !== "string" || value !== value.trim() || value !== value.toLocaleLowerCase()) throw new Error("domain proposal hostname is invalid");
  let parsed;
  try { parsed = new URL(`https://${value}`); } catch { throw new Error("domain proposal hostname is invalid"); }
  if (parsed.hostname !== value || parsed.port || parsed.username || parsed.password || !value.includes(".")) throw new Error("domain proposal hostname is invalid");
}

function assertHttpsUrl(value, expectedHostname, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
    || (expectedHostname && parsed.hostname.toLocaleLowerCase() !== expectedHostname)) throw new Error(`${label} is invalid`);
}

/** Semantic validator shared by the live proposal repository and production operations. */
export function assertDomainProposalDocument(value, label = "domain proposal repository", options = {}) {
  const proposalKeys = new Set(["schemaVersion", "proposalId", "inputHash", "brand", "domain", "trustStatus", "discoveryProvider", "discoveredUrl", "finalUrl", "redirects", "exactMpnEvidence", "reason", "createdAt", "updatedAt", "decidedAt", "rollbackAt"]);
  const eventKeys = new Set(["eventId", "operation", "proposalId", "inputHash", "registryTransactionId", "registryManifest", "createdAt"]);
  if (!object(value) || value.schemaVersion !== "1.0.0" || !exactKeys(value, new Set(["schemaVersion", "proposals", "events"]))
    || !Array.isArray(value.proposals) || !Array.isArray(value.events)) throw new Error(`${label} schema is invalid`);
  const proposals = new Map();
  for (const proposal of value.proposals) {
    if (!object(proposal) || !exactKeys(proposal, proposalKeys) || proposal.schemaVersion !== "1.0.0"
      || !/^domain-proposal-[a-f0-9]{20}$/.test(String(proposal.proposalId ?? "")) || proposals.has(proposal.proposalId)
      || !sha256Hash(proposal.inputHash) || typeof proposal.brand !== "string" || !proposal.brand || proposal.brand.length > 240
      || typeof proposal.discoveryProvider !== "string" || proposal.discoveryProvider.length > 240
      || !["proposed", "trusted", "rejected"].includes(proposal.trustStatus)
      || typeof proposal.reason !== "string" || proposal.reason.length > 240 || !iso(proposal.createdAt) || !iso(proposal.updatedAt)
      || !Array.isArray(proposal.redirects) || proposal.redirects.length > 8
      || (proposal.decidedAt !== undefined && !iso(proposal.decidedAt)) || (proposal.rollbackAt !== undefined && !iso(proposal.rollbackAt))) {
      throw new Error(`${label} contains an invalid proposal`);
    }
    assertDomainHostname(proposal.domain);
    assertHttpsUrl(proposal.discoveredUrl, proposal.domain, "domain proposal discovered URL");
    if (proposal.finalUrl !== undefined) assertHttpsUrl(proposal.finalUrl, undefined, "domain proposal final URL");
    for (const redirect of proposal.redirects) assertHttpsUrl(redirect, undefined, "domain proposal redirect URL");
    if (proposal.exactMpnEvidence !== undefined && (!object(proposal.exactMpnEvidence)
      || !exactKeys(proposal.exactMpnEvidence, new Set(["mpn", "locator", "snippet"]))
      || [proposal.exactMpnEvidence.mpn, proposal.exactMpnEvidence.locator, proposal.exactMpnEvidence.snippet]
        .some((entry) => typeof entry !== "string" || !entry || entry.length > 240))) throw new Error(`${label} contains invalid exact-MPN evidence`);
    const expectedId = `domain-proposal-${sha256(`${proposal.brand.toLocaleLowerCase()}|${proposal.domain}`).slice(0, 20)}`;
    const expectedInputHash = sha256(JSON.stringify({
      brand: proposal.brand,
      domain: proposal.domain,
      url: proposal.discoveredUrl,
      provider: proposal.discoveryProvider,
      mpn: proposal.exactMpnEvidence?.mpn,
    }));
    if (proposal.proposalId !== expectedId || proposal.inputHash !== expectedInputHash
      || (["trusted", "rejected"].includes(proposal.trustStatus) && !iso(proposal.decidedAt))) {
      throw new Error(`${label} proposal identity/state is invalid`);
    }
    proposals.set(proposal.proposalId, proposal);
  }
  const eventIds = new Set();
  for (const event of value.events) {
    if (!object(event) || !exactKeys(event, eventKeys) || eventIds.has(event.eventId)
      || !["create", "approved", "rejected", "rollback"].includes(event.operation)
      || !/^proposal-event-[a-f0-9]{20}$/.test(String(event.eventId ?? ""))
      || !/^domain-proposal-[a-f0-9]{20}$/.test(String(event.proposalId ?? "")) || !sha256Hash(event.inputHash)
      || !iso(event.createdAt)) throw new Error(`${label} contains an invalid event`);
    const proposal = proposals.get(event.proposalId);
    if (!proposal || proposal.inputHash !== event.inputHash) throw new Error(`${label} event references a missing or changed proposal`);
    const expectedId = event.operation === "create"
      ? `proposal-event-${sha256(`create|${event.proposalId}`).slice(0, 20)}`
      : event.operation === "rollback"
        ? `proposal-event-${sha256(`rollback|${event.registryTransactionId}`).slice(0, 20)}`
        : `proposal-event-${sha256(`${event.operation}|${event.proposalId}|${event.inputHash}`).slice(0, 20)}`;
    if (event.eventId !== expectedId
      || (event.operation === "rollback" && !domainApprovalId(event.registryTransactionId))
      || (event.operation === "approved" && (!domainApprovalId(event.registryTransactionId)
        || (options.requirePortableTransactions
          ? event.registryManifest !== "audit/rollback/domain/official-registry-manifest.json"
          : typeof event.registryManifest !== "string" || !event.registryManifest)))
      || (["create", "rejected", "rollback"].includes(event.operation) && event.registryManifest !== undefined)
      || (["create", "rejected"].includes(event.operation) && event.registryTransactionId !== undefined)) {
      throw new Error(`${label} event identity/transaction binding is invalid`);
    }
    eventIds.add(event.eventId);
  }
  for (const proposal of proposals.values()) {
    if (!value.events.some((event) => event.proposalId === proposal.proposalId && event.operation === "create")) throw new Error(`${label} proposal creation audit is missing`);
    if (proposal.trustStatus === "trusted" && !value.events.some((event) => event.proposalId === proposal.proposalId && event.operation === "approved")) throw new Error(`${label} trusted proposal approval audit is missing`);
    if (proposal.trustStatus === "rejected" && !value.events.some((event) => event.proposalId === proposal.proposalId && event.operation === "rejected")) throw new Error(`${label} rejected proposal audit is missing`);
    if (proposal.rollbackAt !== undefined && !value.events.some((event) => event.proposalId === proposal.proposalId && event.operation === "rollback")) throw new Error(`${label} rollback audit is missing`);
  }
  return value;
}

export function assertDomainApprovalManifest(value, { allowTransient = false, requirePortableTransactions = false } = {}) {
  if (!object(value) || value.schemaVersion !== "1.0.0" || !exactKeys(value, new Set(["schemaVersion", "transactions"])) || !Array.isArray(value.transactions)) throw new Error("official domain approval manifest is invalid");
  const ids = new Set();
  for (const transaction of value.transactions) {
    const allowed = new Set(["transactionId", "operation", "proposalId", "proposalInputHash", "status", "createdAt", "files", "appliedAt", "rollbackStartedAt", "rolledBackAt"]);
    if (!object(transaction) || !exactKeys(transaction, allowed) || !domainApprovalId(transaction.transactionId)
      || ids.has(transaction.transactionId) || transaction.operation !== "approve-official-domain"
      || !/^domain-proposal-[a-f0-9]{20}$/.test(String(transaction.proposalId ?? "")) || !sha256Hash(transaction.proposalInputHash)
      || !["applying", "applied", "rolling_back", "rolled_back"].includes(transaction.status)
      || (!allowTransient && ["applying", "rolling_back"].includes(transaction.status)) || !iso(transaction.createdAt)
      || (transaction.status === "applied" && !iso(transaction.appliedAt))
      || (transaction.status === "rolled_back" && (!iso(transaction.rollbackStartedAt) || !iso(transaction.rolledBackAt)))
      || !Array.isArray(transaction.files) || transaction.files.length !== 2) throw new Error("official domain approval transaction is invalid or incomplete");
    const roles = new Set();
    for (const file of transaction.files) {
      const expectedTarget = file?.role === "registry" ? "domain-overlays/official-domains.json"
        : file?.role === "overlay" ? "domain-overlays/official-domains.overlay.json" : null;
      const expectedBackup = expectedTarget && `audit/rollback/domain/${transaction.transactionId}/${path.posix.basename(expectedTarget)}.bak`;
      const pathBindingValid = requirePortableTransactions
        ? file?.target === expectedTarget && file?.backup === expectedBackup
        : typeof file?.target === "string" && typeof file?.backup === "string"
          && path.basename(file.target) === path.posix.basename(expectedTarget ?? "")
          && path.basename(file.backup) === `${path.posix.basename(expectedTarget ?? "")}.bak`
          && path.basename(path.dirname(file.backup)) === transaction.transactionId;
      if (!object(file) || !exactKeys(file, new Set(["role", "target", "backup", "previousHash", "nextHash"]))
        || !expectedTarget || roles.has(file.role) || !pathBindingValid
        || !sha256Hash(file.previousHash) || !sha256Hash(file.nextHash)) throw new Error("official domain approval transaction file binding is invalid");
      roles.add(file.role);
    }
    ids.add(transaction.transactionId);
  }
  return value;
}

export function assertDomainMigrationMarker(value) {
  if (!object(value) || value.schemaVersion !== "domain-legacy-migration-v1" || value.status !== "applied"
    || !exactKeys(value, new Set(["schemaVersion", "status", "sources", "targets", "runtimeGeneration", "migratedAt"]))
    || !Array.isArray(value.sources) || value.sources.length === 0 || !Array.isArray(value.targets) || value.targets.length !== 3
    || !Number.isInteger(value.runtimeGeneration) || value.runtimeGeneration < 1 || !iso(value.migratedAt)
    || value.sources.some((entry) => !object(entry) || !exactKeys(entry, new Set(["role", "hash"]))
      || !["proposals", "registry", "overlay"].includes(entry.role) || !sha256Hash(entry.hash))
    || value.targets.some((target) => typeof target !== "string" || !target || path.posix.isAbsolute(target)
      || target.split("/").some((segment) => !segment || segment === "." || segment === ".."))) throw new Error("legacy domain migration audit marker is invalid");
  return value;
}

function domainUsesCoordinator(options = {}) {
  if (options.coordinator || options.generationAware === true) return true;
  if (options.direct === true || options.generationAware === false || options.proposalPath || options.registryPath || options.overlayPath) return false;
  return options.persistRoot === undefined && process.env.CATALOG_PERSIST_ROOT === undefined;
}

function domainCoordinator(options = {}) {
  return options.coordinator ?? new RuntimeCoordinator({
    root: options.runtimeRoot ?? options.persistRoot ?? process.env.RUNTIME_ROOT ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"),
    now: options.now,
  });
}

function resolved(options = {}, activeRoot = null) {
  const persistRoot = path.resolve(options.persistRoot ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"));
  const seedPath = path.resolve(options.seedPath ?? OFFICIAL_DOMAIN_SEED_PATH);
  const domainRoot = activeRoot ? path.join(activeRoot, "domain-overlays") : persistRoot;
  const proposalPath = path.resolve(options.proposalPath ?? (activeRoot ? path.join(domainRoot, "proposals.json") : path.join(persistRoot, "data/catalog-domain-proposals/proposals.json")));
  const registryPath = path.resolve(options.registryPath ?? (activeRoot ? path.join(domainRoot, "official-domains.json") : path.join(persistRoot, "data/catalog/official-domains.json")));
  const overlayPath = path.resolve(options.overlayPath ?? (activeRoot ? path.join(domainRoot, "official-domains.overlay.json") : path.join(persistRoot, "data/catalog/official-domains.overlay.json")));
  const rollbackRoot = path.resolve(options.rollbackRoot ?? (activeRoot ? path.join(activeRoot, "audit/rollback/domain") : path.join(persistRoot, "data/audit/rollback")));
  const proposalManifestPath = path.resolve(options.proposalManifestPath ?? path.join(rollbackRoot, "domain-proposals-manifest.json"));
  const registryManifestPath = path.resolve(options.registryManifestPath ?? path.join(rollbackRoot, "official-registry-manifest.json"));
  const lockPath = path.resolve(options.lockPath ?? (activeRoot ? path.join(domainRoot, ".domain-registry-lock") : path.join(persistRoot, "coordination/domain-registry.lock")));
  return { ...options, persistRoot, activeRoot, seedPath, proposalPath, registryPath, overlayPath, rollbackRoot, proposalManifestPath, registryManifestPath, lockPath };
}

async function ensureDomainLayout(config) {
  await Promise.all([path.dirname(config.proposalPath), path.dirname(config.registryPath), config.rollbackRoot].map(ensurePrivateDirectory));
}

async function withDomainRead(options, operation) {
  if (!domainUsesCoordinator(options)) return operation(resolved(options));
  const coordinator = domainCoordinator(options);
  await coordinator.initialize(options.appVersion);
  return (await coordinator.withConsistentSnapshot(({ activeRoot }) => operation(resolved(options, activeRoot)))).result;
}

async function withDomainWrite(options, operation) {
  if (!domainUsesCoordinator(options)) {
    const config = resolved(options);
    await ensureDomainLayout(config);
    return withRepositoryLock(config, () => operation(config));
  }
  const coordinator = domainCoordinator(options);
  await coordinator.initialize(options.appVersion);
  return (await coordinator.withWrite(async ({ activeRoot }) => {
    const config = resolved(options, activeRoot);
    await ensureDomainLayout(config);
    return withRepositoryLock(config, () => operation(config));
  }, {
    ...(options.expectedRuntimeRevision !== undefined ? { expectedRevision: options.expectedRuntimeRevision } : {}),
    ...(options.maintenanceLeaseToken ? { maintenanceLeaseToken: options.maintenanceLeaseToken } : {}),
  })).result;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}

function emptyProposalFile() { return { schemaVersion: "1.0.0", proposals: [], events: [] }; }
async function loadFile(options) {
  return assertDomainProposalDocument((await readJson(options.proposalPath, emptyProposalFile())) ?? emptyProposalFile(), "domain proposal repository", {
    requirePortableTransactions: Boolean(options.activeRoot),
  });
}
async function saveFile(file, options, expectedFile) {
  if (expectedFile) {
    const current = await loadFile(options);
    if (sha256(JSON.stringify(current)) !== sha256(JSON.stringify(expectedFile))) throw new Error("domain proposal repository changed concurrently");
  }
  assertDomainProposalDocument(file, "domain proposal repository", { requirePortableTransactions: Boolean(options.activeRoot) });
  await atomicWriteJson(options.proposalPath, file);
}

function emptyOverlay(seed) {
  return {
    schemaVersion: "1.0.0",
    overlayKind: "official_domain_overlay",
    baseRegistryVersion: seed.version,
    updatedAt: seed.updatedAt,
    brands: [],
  };
}

function legacyDomainPaths(options = {}) {
  const root = path.resolve(options.runtimeRoot ?? options.persistRoot ?? options.coordinator?.root ?? process.env.RUNTIME_ROOT ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"));
  return {
    proposalPath: path.join(root, "data/catalog-domain-proposals/proposals.json"),
    registryPath: path.join(root, "data/catalog/official-domains.json"),
    overlayPath: path.join(root, "data/catalog/official-domains.overlay.json"),
  };
}

/** Explicit, idempotent import for the pre-generation domain repository. */
export async function migrateLegacyDomainRepository(options = {}) {
  const coordinator = domainCoordinator({ ...options, generationAware: true });
  await coordinator.initialize(options.appVersion);
  const legacy = legacyDomainPaths(options);
  const markerPath = path.join(coordinator.controlRoot, "domain-legacy-migration.json");
  const readOptional = (file) => readFile(file).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  const [proposalBytes, registryBytes, overlayBytes] = await Promise.all([
    readOptional(legacy.proposalPath), readOptional(legacy.registryPath), readOptional(legacy.overlayPath),
  ]);
  const sources = [
    ["proposals", proposalBytes], ["registry", registryBytes], ["overlay", overlayBytes],
  ].filter((entry) => entry[1] !== null).map(([role, bytes]) => ({ role, hash: sha256Bytes(bytes) }));
  if (!sources.length) return { status: "not_found" };
  const sourceHash = sha256(JSON.stringify(sources));
  const existingMarker = await readJson(markerPath, null);
  if (existingMarker) {
    if (JSON.stringify(existingMarker.sources) !== JSON.stringify(sources)) throw new Error("legacy domain repository changed after migration; refusing ambiguous import");
    if (options.dryRun === false && options.expectedSourceHash !== sourceHash) throw new Error("legacy domain migration expected source hash mismatch");
    return { status: "already_migrated", sources, sourceHash };
  }
  let proposals = emptyProposalFile();
  if (proposalBytes) {
    proposals = JSON.parse(proposalBytes.toString("utf8"));
    assertDomainProposalDocument(proposals, "legacy domain proposal repository");
  }
  const seedDocument = await readJson(options.seedPath ?? OFFICIAL_DOMAIN_SEED_PATH, null);
  if (!seedDocument) throw new Error("official domain seed not found");
  const seed = loadOfficialRegistry(seedDocument);
  const overlay = overlayBytes ? JSON.parse(overlayBytes.toString("utf8")) : emptyOverlay(seed);
  assertOfficialDomainOverlayDocument(overlay, { baseRegistryVersion: seed.version, label: "legacy official domain overlay" });
  const merged = mergeOfficialRegistry(seedDocument, overlay);
  if (registryBytes && assertOfficialDomainRegistryDocument(JSON.parse(registryBytes.toString("utf8")), "legacy official domain registry").version !== merged.version) {
    throw new Error("legacy official registry diverges from seed + overlay; refusing migration");
  }
  if (options.dryRun !== false) return { status: "dry_run", sources, sourceHash, proposalCount: proposals.proposals.length, overlayBrandCount: overlay.brands.length };
  if (options.expectedSourceHash !== sourceHash) throw new Error("legacy domain migration requires the exact dry-run source hash");
  const applied = await coordinator.withWrite(async ({ activeRoot, state }) => {
    const config = resolved(options, activeRoot);
    await ensureDomainLayout(config);
    for (const target of [config.proposalPath, config.overlayPath, config.registryPath]) {
      if (await readOptional(target)) throw new Error("active domain repository already exists; refusing legacy overwrite");
    }
    await atomicWriteJson(config.proposalPath, proposals);
    await atomicWriteJson(config.overlayPath, overlay);
    await atomicWriteJson(config.registryPath, officialRegistryDocument(merged));
    const marker = {
      schemaVersion: "domain-legacy-migration-v1", status: "applied", sources,
      targets: [config.proposalPath, config.overlayPath, config.registryPath].map((target) => path.relative(coordinator.root, target).split(path.sep).join("/")),
      runtimeGeneration: state.runtimeGeneration, migratedAt: now(),
    };
    assertDomainMigrationMarker(marker);
    await atomicWriteJson(path.join(config.rollbackRoot, "legacy-domain-migration.json"), marker);
    await atomicWriteJson(markerPath, marker);
    return { status: "applied", sources, sourceHash, runtimeGeneration: state.runtimeGeneration };
  });
  return applied.result;
}

async function repositoryState(config) {
  const seedDocument = await readJson(config.seedPath, null);
  if (!seedDocument) throw new Error("official domain seed not found");
  const seed = loadOfficialRegistry(seedDocument);
  const fallbackOverlay = emptyOverlay(seed);
  const overlayBytes = await readFile(config.overlayPath).catch((error) => error?.code === "ENOENT" ? jsonBytes(fallbackOverlay) : Promise.reject(error));
  const overlay = JSON.parse(overlayBytes.toString("utf8"));
  assertOfficialDomainOverlayDocument(overlay, { baseRegistryVersion: seed.version });
  const merged = mergeOfficialRegistry(seedDocument, overlay);
  let registryMissing = false;
  const registryBytes = await readFile(config.registryPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
    registryMissing = true;
    return jsonBytes(officialRegistryDocument(merged));
  });
  const materialized = JSON.parse(registryBytes.toString("utf8"));
  const materializedRegistry = assertOfficialDomainRegistryDocument(materialized, "materialized official domain registry");
  if (!registryMissing && materializedRegistry.version !== merged.version) throw new Error("official registry materialization diverges from seed + overlay repository");
  return { seed, seedDocument, overlay, merged, materialized: officialRegistryDocument(materializedRegistry), registryBytes, overlayBytes };
}

function overlayWithApprovedDomain(state, proposal, timestamp) {
  const current = state.merged.brands.find((entry) => [entry.brand, ...(entry.aliases ?? [])]
    .some((brand) => brand.toLocaleLowerCase() === proposal.brand.toLocaleLowerCase()));
  const approved = current
    ? { ...current, aliases: [...(current.aliases ?? [])], domains: [...new Set([...current.domains, proposal.domain])], trustStatus: "trusted", source: "manual", approvedAt: timestamp }
    : { brand: proposal.brand, aliases: [], domains: [proposal.domain], trustStatus: "trusted", source: "manual", approvedAt: timestamp };
  const byBrand = new Map((state.overlay.brands ?? []).map((entry) => [entry.brand.toLocaleLowerCase(), entry]));
  byBrand.set(approved.brand.toLocaleLowerCase(), approved);
  return {
    schemaVersion: "1.0.0",
    overlayKind: "official_domain_overlay",
    baseRegistryVersion: state.seed.version,
    updatedAt: timestamp,
    brands: [...byBrand.values()],
  };
}

async function withRepositoryLock(config, operation) {
  return withDirectoryLock(config.lockPath, operation, { timeoutMs: config.lockTimeoutMs, staleMs: config.lockStaleMs });
}

export async function createDomainProposal(input, options = {}) {
  if (!input?.brand) return { status: "blocked", reasons: ["proposal brand is required"] };
  let url;
  try { url = new URL(input.url); } catch { return { status: "blocked", reasons: ["proposal URL is invalid"] }; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return { status: "blocked", reasons: ["proposal URL must use canonical https"] };
  return withDomainWrite(options, async (config) => {
    const domain = url.hostname.toLocaleLowerCase();
    const brand = safeText(input.brand);
    const provider = safeText(input.provider);
    const mpn = input.mpn ? safeText(input.mpn) : undefined;
    const state = await repositoryState(config);
    if (registryForUrl(url, state.merged)) return { status: "blocked", reasons: ["domain already exists in registry"] };
    const inputHash = sha256(JSON.stringify({ brand, domain, url: url.toString(), provider, mpn }));
    const proposalId = `domain-proposal-${sha256(`${brand.toLocaleLowerCase()}|${domain}`).slice(0, 20)}`;
    const file = await loadFile(config);
    const existing = file.proposals.find((proposal) => proposal.proposalId === proposalId);
    if (existing) return existing;
    const timestamp = now();
    const proposal = {
      schemaVersion: "1.0.0",
      proposalId,
      inputHash,
      brand,
      domain,
      trustStatus: "proposed",
      discoveryProvider: provider,
      discoveredUrl: url.toString(),
      ...(input.finalUrl ? { finalUrl: String(input.finalUrl) } : {}),
      redirects: Array.isArray(input.redirects) ? input.redirects.slice(0, 8).map(String) : [],
      ...(mpn ? { exactMpnEvidence: { mpn, locator: "discovery query and candidate URL", snippet: safeText(`${input.title ?? ""} ${url.pathname}`) } } : {}),
      reason: safeText(input.reason ?? "discovered brand domain is not in the governed registry"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const event = { eventId: `proposal-event-${sha256(`create|${proposalId}`).slice(0, 20)}`, operation: "create", proposalId, inputHash, createdAt: timestamp };
    await saveFile({ ...file, proposals: [...file.proposals, proposal], events: [...file.events, event] }, config, file);
    return proposal;
  });
}

export async function listDomainProposals(options = {}) {
  return withDomainRead(options, async (config) => {
    const file = await loadFile(config);
    return { schemaVersion: file.schemaVersion, proposals: file.proposals, events: file.events };
  });
}

async function writeApprovalTransaction(config, state, nextOverlay, nextRegistry, proposal, timestamp) {
  const transactionId = `domain-approval-${crypto.randomUUID()}`;
  const backupRoot = path.join(config.rollbackRoot, transactionId);
  const priorRegistryBytes = state.registryBytes;
  const priorOverlayBytes = state.overlayBytes;
  const nextRegistryBytes = jsonBytes(nextRegistry);
  const nextOverlayBytes = jsonBytes(nextOverlay);
  const registryBackupPath = path.join(backupRoot, "official-domains.json.bak");
  const overlayBackupPath = path.join(backupRoot, "official-domains.overlay.json.bak");
  const persistedPath = (file) => config.activeRoot ? path.relative(config.activeRoot, file).split(path.sep).join("/") : file;
  await atomicWriteFile(registryBackupPath, priorRegistryBytes);
  await atomicWriteFile(overlayBackupPath, priorOverlayBytes);
  const manifestOptions = { requirePortableTransactions: Boolean(config.activeRoot) };
  const manifest = assertDomainApprovalManifest(await readJson(config.registryManifestPath, { schemaVersion: "1.0.0", transactions: [] }), manifestOptions);
  const transaction = {
    transactionId,
    operation: "approve-official-domain",
    proposalId: proposal.proposalId,
    proposalInputHash: proposal.inputHash,
    status: "applying",
    createdAt: timestamp,
    files: [
      { role: "registry", target: persistedPath(config.registryPath), backup: persistedPath(registryBackupPath), previousHash: sha256Bytes(priorRegistryBytes), nextHash: sha256Bytes(nextRegistryBytes) },
      { role: "overlay", target: persistedPath(config.overlayPath), backup: persistedPath(overlayBackupPath), previousHash: sha256Bytes(priorOverlayBytes), nextHash: sha256Bytes(nextOverlayBytes) },
    ],
  };
  assertDomainApprovalManifest({ ...manifest, transactions: [...(manifest.transactions ?? []), transaction] }, { ...manifestOptions, allowTransient: true });
  await atomicWriteJson(config.registryManifestPath, { ...manifest, transactions: [...(manifest.transactions ?? []), transaction] });
  const currentRegistry = await readFile(config.registryPath).catch((error) => error?.code === "ENOENT" ? priorRegistryBytes : Promise.reject(error));
  const currentOverlay = await readFile(config.overlayPath).catch((error) => error?.code === "ENOENT" ? priorOverlayBytes : Promise.reject(error));
  if (sha256Bytes(currentRegistry) !== transaction.files[0].previousHash || sha256Bytes(currentOverlay) !== transaction.files[1].previousHash) throw new Error("official registry changed concurrently before approval commit");
  await atomicWriteFile(config.overlayPath, nextOverlayBytes);
  await atomicWriteFile(config.registryPath, nextRegistryBytes);
  const committedRegistryHash = sha256Bytes(await readFile(config.registryPath));
  const committedOverlayHash = sha256Bytes(await readFile(config.overlayPath));
  if (committedRegistryHash !== transaction.files[0].nextHash || committedOverlayHash !== transaction.files[1].nextHash) throw new Error("official registry approval commit hash mismatch");
  return transaction;
}

async function finalizeApprovalTransaction(config, transactionId) {
  const manifestOptions = { requirePortableTransactions: Boolean(config.activeRoot) };
  const manifest = assertDomainApprovalManifest(await readJson(config.registryManifestPath, { schemaVersion: "1.0.0", transactions: [] }), { ...manifestOptions, allowTransient: true });
  const transaction = (manifest.transactions ?? []).find((entry) => entry.transactionId === transactionId);
  if (!transaction || transaction.status !== "applying") throw new Error("official registry approval transaction is not applying");
  const resolveStored = (file) => config.activeRoot ? confined(config.activeRoot, file) : path.resolve(file);
  for (const file of transaction.files) {
    if (sha256Bytes(await readFile(resolveStored(file.target))) !== file.nextHash) throw new Error(`official registry ${file.role} changed before approval finalization`);
  }
  const applied = { ...transaction, status: "applied", appliedAt: now() };
  assertDomainApprovalManifest({ ...manifest, transactions: (manifest.transactions ?? []).map((entry) => entry.transactionId === transactionId ? applied : entry) }, manifestOptions);
  await atomicWriteJson(config.registryManifestPath, {
    ...manifest,
    transactions: (manifest.transactions ?? []).map((entry) => entry.transactionId === transactionId ? applied : entry),
  });
  return applied;
}

export async function decideDomainProposal(proposalId, decision, expectedHash, options = {}) {
  if (!["approved", "rejected"].includes(decision)) throw new Error("proposal decision must be approved or rejected");
  const result = await withDomainWrite(options, async (config) => {
    const file = await loadFile(config);
    const proposal = file.proposals.find((entry) => entry.proposalId === proposalId);
    if (!proposal) return { status: "blocked", proposalId, reasons: ["proposal not found"] };
    if (!expectedHash || proposal.inputHash !== expectedHash) return { status: "blocked", proposalId, reasons: ["proposal hash mismatch"] };
    if (proposal.trustStatus !== "proposed") return { status: proposal.trustStatus, proposalId, inputHash: proposal.inputHash };
    const timestamp = now();
    let registryTransaction = null;
    if (decision === "approved") {
      const state = await repositoryState(config);
      const nextOverlay = overlayWithApprovedDomain(state, proposal, timestamp);
      const nextMerged = mergeOfficialRegistry(state.seedDocument, nextOverlay);
      const nextRegistry = officialRegistryDocument(nextMerged);
      registryTransaction = await writeApprovalTransaction(config, state, nextOverlay, nextRegistry, proposal, timestamp);
      if (!domainUsesCoordinator(options)) activateOfficialRegistry(nextMerged);
    }
    const next = { ...proposal, trustStatus: decision === "approved" ? "trusted" : "rejected", decidedAt: timestamp, updatedAt: timestamp };
    const event = {
      eventId: `proposal-event-${sha256(`${decision}|${proposalId}|${expectedHash}`).slice(0, 20)}`,
      operation: decision,
      proposalId,
      inputHash: expectedHash,
      ...(registryTransaction ? { registryTransactionId: registryTransaction.transactionId, registryManifest: config.activeRoot ? path.relative(config.activeRoot, config.registryManifestPath).split(path.sep).join("/") : config.registryManifestPath } : {}),
      createdAt: timestamp,
    };
    await saveFile({
      ...file,
      proposals: file.proposals.map((entry) => entry.proposalId === proposalId ? next : entry),
      events: [...file.events.filter((entry) => entry.eventId !== event.eventId), event],
    }, config, file);
    if (registryTransaction) registryTransaction = await finalizeApprovalTransaction(config, registryTransaction.transactionId);
    return {
      status: next.trustStatus,
      proposalId,
      inputHash: expectedHash,
      ...(registryTransaction ? { registryTransactionId: registryTransaction.transactionId, registryManifest: config.activeRoot ? path.relative(config.activeRoot, config.registryManifestPath).split(path.sep).join("/") : config.registryManifestPath } : {}),
    };
  });
  if (result.status === "trusted" && domainUsesCoordinator(options)) await activateOfficialRegistryRepository({ ...options, coordinator: domainCoordinator(options), generationAware: true });
  return result;
}

export async function rollbackDomainApproval(options = {}) {
  const result = await withDomainWrite(options, async (config) => {
    const manifestOptions = { requirePortableTransactions: Boolean(config.activeRoot) };
    const manifest = assertDomainApprovalManifest(await readJson(config.registryManifestPath, { schemaVersion: "1.0.0", transactions: [] }), { ...manifestOptions, allowTransient: true });
    const transaction = [...(manifest.transactions ?? [])].reverse().find((entry) => ["applied", "applying", "rolling_back"].includes(entry.status));
    if (!transaction) throw new Error("No rollback transaction for official registry");
    const resolveStored = (file) => config.activeRoot ? confined(config.activeRoot, file) : path.resolve(file);
    for (const file of transaction.files) {
      const currentBytes = await readFile(resolveStored(file.target)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
        return transaction.status === "applying" ? readFile(resolveStored(file.backup)) : Promise.reject(error);
      });
      const currentHash = sha256Bytes(currentBytes);
      const allowed = ["applying", "rolling_back"].includes(transaction.status) ? [file.previousHash, file.nextHash] : [file.nextHash];
      if (!allowed.includes(currentHash)) throw new Error(`rollback refused because ${file.role} has a newer write`);
      const backupBytes = await readFile(resolveStored(file.backup));
      if (sha256Bytes(backupBytes) !== file.previousHash) throw new Error(`rollback ${file.role} backup hash mismatch`);
    }
    const rollingBack = { ...transaction, status: "rolling_back", rollbackStartedAt: transaction.rollbackStartedAt ?? now() };
    assertDomainApprovalManifest({ ...manifest, transactions: (manifest.transactions ?? []).map((entry) => entry.transactionId === transaction.transactionId ? rollingBack : entry) }, { ...manifestOptions, allowTransient: true });
    await atomicWriteJson(config.registryManifestPath, {
      ...manifest,
      transactions: (manifest.transactions ?? []).map((entry) => entry.transactionId === transaction.transactionId ? rollingBack : entry),
    });
    for (const file of transaction.files) await atomicWriteFile(resolveStored(file.target), await readFile(resolveStored(file.backup)));
    const proposalFile = await loadFile(config);
    const rolledBackAt = now();
    const proposals = proposalFile.proposals.map((proposal) => proposal.proposalId === transaction.proposalId && proposal.inputHash === transaction.proposalInputHash
      ? { ...proposal, trustStatus: "proposed", updatedAt: rolledBackAt, rollbackAt: rolledBackAt }
      : proposal);
    const rollbackEvent = {
      eventId: `proposal-event-${sha256(`rollback|${transaction.transactionId}`).slice(0, 20)}`,
      operation: "rollback",
      proposalId: transaction.proposalId,
      inputHash: transaction.proposalInputHash,
      registryTransactionId: transaction.transactionId,
      createdAt: rolledBackAt,
    };
    await saveFile({ ...proposalFile, proposals, events: [...proposalFile.events.filter((event) => event.eventId !== rollbackEvent.eventId), rollbackEvent] }, config, proposalFile);
    const rolledBack = { ...rollingBack, status: "rolled_back", rolledBackAt };
    assertDomainApprovalManifest({ ...manifest, transactions: (manifest.transactions ?? []).map((entry) => entry.transactionId === transaction.transactionId ? rolledBack : entry) }, manifestOptions);
    await atomicWriteJson(config.registryManifestPath, {
      ...manifest,
      transactions: (manifest.transactions ?? []).map((entry) => entry.transactionId === transaction.transactionId ? rolledBack : entry),
    });
    if (!domainUsesCoordinator(options)) {
      const active = await loadOfficialRegistryRepository({ seedPath: config.seedPath, overlayPath: config.overlayPath });
      activateOfficialRegistry(active);
    }
    return { transactionId: transaction.transactionId, restored: transaction.files.map((file) => file.role), status: "rolled_back" };
  });
  if (domainUsesCoordinator(options)) await activateOfficialRegistryRepository({ ...options, coordinator: domainCoordinator(options), generationAware: true });
  return result;
}
