import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDeepSeekConfig } from "./config.mjs";
import { requestDeepSeek } from "./client.mjs";
import { DEEPSEEK_PRICING, DEEPSEEK_PRICING_HASH, priceDeepSeekUsage, summarizeBillingCalls } from "./pricing.mjs";

export const ADVICE_SCHEMA_VERSION = "1.0.0";
export const ADVICE_PROMPT_VERSION = "build-advice-1.0.0";
const MAX_TEXT = 2_000;
const MAX_ARRAY = 64;
const jobs = new Map();
const cache = new Map();
const rollbackQueues = new Map();
const auditQueues = new Map();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function dateNow(now) {
  return (now ?? (() => new Date().toISOString()))();
}

function auditRoot(options = {}) {
  return options.auditRoot ?? process.env.BUILD_SIM_ADVICE_AUDIT_ROOT ?? path.resolve("data/audit/advice-events");
}

function jobRoot(options = {}) {
  return options.jobRoot ?? process.env.BUILD_SIM_ADVICE_JOB_ROOT ?? path.resolve("data/audit/advice-jobs");
}

async function atomicJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function rollbackManifestPath(options = {}) {
  return options.rollbackManifestPath ?? path.join(options.rollbackRoot ?? path.join(path.dirname(auditRoot(options)), "rollback"), "advice-manifest.json");
}

async function appendRollback(entry, options = {}) {
  const file = rollbackManifestPath(options);
  const prior = rollbackQueues.get(file) ?? Promise.resolve();
  const current = prior.then(async () => {
    let payload = { schemaVersion: "1.0.0", entries: [] };
    try { payload = JSON.parse(await readFile(file, "utf8")); } catch { /* first write */ }
    await atomicJson(file, { schemaVersion: "1.0.0", entries: [...(payload.entries ?? []), entry] });
  });
  rollbackQueues.set(file, current.catch(() => {}));
  await current;
}

async function writeWithRollback(file, payload, operation, options = {}) {
  const previous = await readFile(file, "utf8").catch(() => null);
  const rollbackRoot = options.rollbackRoot ?? path.join(path.dirname(auditRoot(options)), "rollback");
  let backup = null;
  if (previous !== null) {
    await mkdir(rollbackRoot, { recursive: true });
    backup = path.join(rollbackRoot, `${path.basename(file)}.${Date.now()}.bak`);
    await copyFile(file, backup);
  }
  await atomicJson(file, payload);
  await appendRollback({
    eventId: `advice-write-${hash({ file, operation, previous, payload })}`,
    operation,
    target: file,
    backup,
    previousHash: previous ? hash(previous) : null,
    nextHash: hash(payload),
    createdAt: new Date().toISOString(),
  }, options);
}

async function appendAudit(event, options = {}) {
  const root = auditRoot(options);
  const day = event.generatedAt.slice(0, 10);
  const file = path.join(root, `${day}.json`);
  const prior = auditQueues.get(file) ?? Promise.resolve();
  const current = prior.then(async () => {
    let payload = { schemaVersion: "1.0.0", events: [] };
    try { payload = JSON.parse(await readFile(file, "utf8")); } catch { /* first event */ }
    const events = Array.isArray(payload.events) ? payload.events : [];
    const existing = events.findIndex((item) => item.eventId === event.eventId);
    if (existing >= 0) events[existing] = event;
    else events.push(event);
    await writeWithRollback(file, { schemaVersion: "1.0.0", events }, "advice-audit", options);
  });
  auditQueues.set(file, current.catch(() => {}));
  await current;
}

async function persistJob(job, options = {}) {
  const safe = { ...job };
  await writeWithRollback(path.join(jobRoot(options), `${job.requestId}.json`), safe, "advice-job", options);
}

function refsFor(input) {
  const refs = new Set(["user-goal"]);
  for (const finding of input.evaluation.findings ?? []) refs.add(finding.id);
  for (const fact of input.selectedSkuFacts ?? []) {
    refs.add(fact.skuId);
    for (const provenance of fact.provenance ?? []) refs.add(provenance.provenanceId);
  }
  return refs;
}

function numericTokens(input) {
  const known = new Set();
  const visit = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) known.add(String(value));
    else if (typeof value === "string") for (const token of value.match(/(?<![A-Za-z])[+-]?\d+(?:\.\d+)?/g) ?? []) known.add(token);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(input);
  return known;
}

function unsupportedNumbers(text, known) {
  return (String(text).match(/(?<![A-Za-z])[+-]?\d+(?:\.\d+)?/g) ?? []).filter((token) => !known.has(token));
}

function text(value) { return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT; }

function validateInput(input) {
  const errors = [];
  if (!input || typeof input !== "object") return ["input must be an object"];
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,120}$/.test(input.requestId)) errors.push("requestId invalid");
  if (!["zh-CN", "en-US", "ja-JP"].includes(input.locale)) errors.push("locale invalid");
  if (input.userGoal !== undefined && !text(input.userGoal)) errors.push("userGoal invalid");
  if (!input.buildConfig || typeof input.buildConfig !== "object") errors.push("buildConfig missing");
  const evaluation = input.evaluation;
  if (!evaluation || typeof evaluation !== "object") errors.push("evaluation missing");
  else {
    if (!Array.isArray(evaluation.findings) || evaluation.findings.length > MAX_ARRAY) errors.push("evaluation.findings invalid");
    if (!Array.isArray(evaluation.bom) || evaluation.bom.length > MAX_ARRAY) errors.push("evaluation.bom invalid");
    if (!Array.isArray(evaluation.unknown) || evaluation.unknown.length > MAX_ARRAY) errors.push("evaluation.unknown invalid");
    if (!evaluation.physical || typeof evaluation.physical !== "object" || typeof evaluation.physical.hash !== "string") errors.push("evaluation.physical invalid");
    if (!evaluation.calibration || typeof evaluation.calibration !== "object" || typeof evaluation.calibration.hash !== "string") errors.push("evaluation.calibration invalid");
    for (const finding of evaluation.findings ?? []) if (!finding || typeof finding.id !== "string" || !["ok", "warn", "bad"].includes(finding.verdict) || !text(finding.message)) errors.push("finding invalid");
  }
  if (!Array.isArray(input.selectedSkuFacts) || input.selectedSkuFacts.length > MAX_ARRAY) errors.push("selectedSkuFacts invalid");
  for (const fact of input.selectedSkuFacts ?? []) if (!fact || typeof fact.skuId !== "string" || !text(fact.name) || !fact.fields || !Array.isArray(fact.provenance)) errors.push("selected SKU fact invalid");
  if (input.constraints?.cannotDowngradeBad !== true || input.constraints?.unknownMustStayUnknown !== true || input.constraints?.citeSourceFields !== true) errors.push("safety constraints missing");
  if (JSON.stringify(input).length > 500_000) errors.push("input too large");
  return [...new Set(errors)];
}

function validateRefs(refs, allowed, errors, pathName) {
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 12 || refs.some((ref) => typeof ref !== "string" || !allowed.has(ref))) errors.push(`${pathName} refs invalid`);
}

function validateResult(result, input) {
  const errors = [];
  if (!result || typeof result !== "object") return ["result must be an object"];
  const allowed = refsFor(input);
  const known = numericTokens(input);
  if (result.schemaVersion !== ADVICE_SCHEMA_VERSION || !text(result.model) || !text(result.generatedAt) || !text(result.summary)) errors.push("result header invalid");
  const rec = result.recommendation;
  if (!rec || !["recommended", "conditional", "not-recommended", "insufficient-data"].includes(rec.verdict) || !Array.isArray(rec.reasons) || rec.reasons.length > MAX_ARRAY) errors.push("recommendation invalid");
  else {
    for (const [i, claim] of rec.reasons.entries()) {
      if (!claim || !text(claim.text) || !["engine-finding", "official-field", "user-goal", "model-inference"].includes(claim.kind)) errors.push(`recommendation.reasons[${i}] invalid`);
      else { validateRefs(claim.refs, allowed, errors, `recommendation.reasons[${i}]`); if (unsupportedNumbers(claim.text, known).length) errors.push(`recommendation.reasons[${i}] contains unsupported number`); }
    }
  }
  if (rec?.verdict === "recommended" && input.evaluation.findings.some((finding) => finding.verdict === "bad")) errors.push("recommended cannot override bad finding");
  if (!Array.isArray(result.risks) || result.risks.length > MAX_ARRAY) errors.push("risks invalid");
  else for (const [i, risk] of result.risks.entries()) {
    if (!risk || !text(risk.text) || !["high", "medium", "low", "unknown"].includes(risk.level) || !["mechanical", "electrical", "thermal", "maintenance", "price", "data"].includes(risk.category)) errors.push(`risks[${i}] invalid`);
    else { validateRefs(risk.refs, allowed, errors, `risks[${i}]`); if (unsupportedNumbers(`${risk.text} ${risk.mitigation ?? ""}`, known).length) errors.push(`risks[${i}] contains unsupported number`); }
  }
  if (!Array.isArray(result.actions) || result.actions.length > MAX_ARRAY) errors.push("actions invalid");
  else for (const [i, action] of result.actions.entries()) {
    if (!action || !text(action.action) || !Number.isInteger(action.priority) || action.priority < 1 || action.priority > 99 || typeof action.blocking !== "boolean") errors.push(`actions[${i}] invalid`);
    else { validateRefs(action.refs, allowed, errors, `actions[${i}]`); if (unsupportedNumbers(action.action, known).length) errors.push(`actions[${i}] contains unsupported number`); }
  }
  if (!Array.isArray(result.alternatives) || result.alternatives.length > MAX_ARRAY) errors.push("alternatives invalid");
  else for (const [i, alternative] of result.alternatives.entries()) {
    if (!alternative || !text(alternative.title) || !Array.isArray(alternative.changes) || !Array.isArray(alternative.benefits) || !Array.isArray(alternative.tradeoffs)) errors.push(`alternatives[${i}] invalid`);
    else {
      validateRefs(alternative.refs, allowed, errors, `alternatives[${i}]`);
      for (const item of [...alternative.changes, ...alternative.benefits, ...alternative.tradeoffs]) if (!text(item) || unsupportedNumbers(item, known).length) errors.push(`alternatives[${i}] contains invalid text`);
    }
  }
  if (!Array.isArray(result.unknowns) || result.unknowns.length > MAX_ARRAY || result.unknowns.some((item) => !text(item))) errors.push("unknowns invalid");
  if (!Array.isArray(result.sourceRefs) || result.sourceRefs.some((ref) => !allowed.has(ref))) errors.push("sourceRefs invalid");
  if (unsupportedNumbers(result.summary ?? "", known).length) errors.push("summary contains unsupported number");
  return [...new Set(errors)];
}

function deterministic(input) {
  const findings = input.evaluation.findings ?? [];
  return {
    findings,
    bom: input.evaluation.bom ?? [],
    unknown: input.evaluation.unknown ?? [],
    verdict: findings.some((f) => f.verdict === "bad") ? "bad" : findings.some((f) => f.verdict === "warn") ? "warn" : "ok",
  };
}

function safeRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(value) ? value : `advice-${randomUUID()}`;
}

async function audit(job, options = {}) {
  const event = {
    eventId: `advice-${hash({ requestId: job.requestId })}`,
    eventType: "advice",
    requestId: job.requestId,
    provider: job.provider,
    model: job.model,
    promptVersion: job.promptVersion,
    inputHash: job.inputHash,
    engineHash: job.engineHash,
    responseHash: job.advice ? hash(job.advice) : null,
    status: job.status,
    failureStage: job.failureStage ?? null,
    validationErrors: job.validationErrors ?? [],
    latencyMs: job.latencyMs ?? null,
    retries: job.retries ?? 0,
    billing: job.billing,
    calls: job.calls ?? [],
    generatedAt: job.generatedAt,
  };
  await appendAudit(event, options);
  await persistJob(job, options);
}

function baseJob(input, inputHash, engineHash, model, generatedAt) {
  return {
    requestId: input.requestId,
    status: "queued",
    provider: "deepseek",
    model: model ?? null,
    promptVersion: ADVICE_PROMPT_VERSION,
    inputHash,
    engineHash,
    deterministic: deterministic(input),
    calls: [],
    billing: summarizeBillingCalls([]),
    generatedAt,
  };
}

function billingCall(job, attempt, status, metadata = {}, extra = {}) {
  const providerModel = metadata.providerModel ?? job.model;
  const startedAt = metadata.startedAt ?? extra.startedAt ?? new Date().toISOString();
  return {
    callId: `${job.requestId}:${attempt}`,
    requestId: job.requestId,
    attempt,
    status,
    provider: "deepseek",
    requestedModel: job.model,
    providerModel,
    providerRequestId: metadata.providerRequestId ?? null,
    latencyMs: extra.latencyMs ?? null,
    httpStatus: extra.httpStatus ?? null,
    failureStage: extra.failureStage ?? null,
    startedAt,
    billing: metadata.billing ?? priceDeepSeekUsage(providerModel, null, { occurredAt: startedAt }),
    generatedAt: new Date().toISOString(),
  };
}

export async function createAdviceJob(body, options = {}) {
  const requestId = safeRequestId(body?.requestId);
  const input = { ...(body ?? {}), requestId };
  const inputErrors = validateInput(input);
  if (inputErrors.length) throw new Error(`invalid advice input: ${inputErrors.join(", ")}`);
  const inputHash = hash({ ...input, requestId: undefined, evaluation: { ...input.evaluation, engineHash: undefined } });
  const engineHash = hash(input.evaluation);
  let config;
  try { config = options.config ?? await loadDeepSeekConfig(); } catch (error) {
    const job = { ...baseJob(input, inputHash, engineHash, null, new Date().toISOString()), status: "advice-unavailable", failureStage: "config", validationErrors: [error.message] };
    jobs.set(requestId, job); await audit(job, options); return job;
  }
  const flags = options.flags ?? { adviceEnabled: false };
  if (!flags.adviceEnabled || !config.enabled) {
    const job = { ...baseJob(input, inputHash, engineHash, config.enabled ? config.model : null, new Date().toISOString()), status: "disabled", failureStage: undefined };
    jobs.set(requestId, job); await audit(job, options); return job;
  }
  const cacheKey = `${ADVICE_PROMPT_VERSION}:${inputHash}:${engineHash}:${config.model}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    const job = { ...baseJob(input, inputHash, engineHash, config.model, new Date().toISOString()), status: "completed", advice: cached, cacheHit: true, billing: summarizeBillingCalls([], { cacheServed: true }) };
    jobs.set(requestId, job); await audit(job, options); return job;
  }
  const job = baseJob(input, inputHash, engineHash, config.model, new Date().toISOString());
  jobs.set(requestId, job);
  await audit(job, options);
  void runAdviceJob(job, input, { ...options, config, cacheKey });
  return job;
}

export async function runAdviceJob(job, input, options = {}) {
  job.status = "running";
  job.failureStage = "request";
  job.retries = 0;
  try {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await requestDeepSeek(input, { config: options.config, fetchImpl: options.fetchImpl, now: options.now });
        const errors = validateResult(response.result, input);
        const call = billingCall(job, attempt + 1, errors.length ? "validation-failed" : "completed", response, { latencyMs: response.latencyMs, failureStage: errors.length ? "validation" : null });
        job.calls.push(call);
        if (errors.length) throw Object.assign(new Error("DeepSeek output validation failed"), { validationErrors: errors, stage: "validation", billingRecorded: true });
        break;
      } catch (error) {
        if (!error.billingRecorded) job.calls.push(billingCall(job, attempt + 1, "failed", error.providerMetadata, { startedAt: error.startedAt, latencyMs: error.latencyMs, httpStatus: error.httpStatus, failureStage: error.stage ?? "request" }));
        job.retries = attempt + 1;
        if (attempt === 1) throw error;
      }
    }
    job.status = "completed";
    job.failureStage = undefined;
    job.advice = response.result;
    job.latencyMs = response.latencyMs;
    cache.set(options.cacheKey, response.result);
  } catch (error) {
    job.status = "advice-unavailable";
    job.failureStage = error.stage ?? "request";
    job.validationErrors = error.validationErrors ?? [error.message];
  }
  job.retries = Math.max(0, job.calls.length - 1);
  job.billing = summarizeBillingCalls(job.calls);
  await audit(job, options);
  jobs.set(job.requestId, job);
  return job;
}

export async function getAdviceBillingSummary({ limit = 100, ...options } = {}) {
  const root = auditRoot(options);
  const files = (await readdir(root).catch(() => [])).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort();
  const events = [];
  for (const file of files) {
    try {
      const payload = JSON.parse(await readFile(path.join(root, file), "utf8"));
      events.push(...(Array.isArray(payload.events) ? payload.events : []));
    } catch { /* malformed historical files remain isolated */ }
  }
  const calls = events.flatMap((event) => (event.calls ?? []).map((call) => ({ ...call, jobStatus: event.status }))).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  const bounded = calls.slice(0, Math.min(500, Math.max(1, Number(limit) || 100)));
  const totals = summarizeBillingCalls(calls);
  const byModel = Object.values(calls.reduce((acc, call) => {
    const model = call.providerModel ?? call.requestedModel ?? "unknown";
    const row = acc[model] ?? { model, calls: [] };
    row.calls.push(call);
    acc[model] = row;
    return acc;
  }, {})).map((row) => ({ model: row.model, ...summarizeBillingCalls(row.calls) }));
  const byPricingBand = Object.values(calls.reduce((acc, call) => {
    const pricingBand = call.billing?.pricing?.pricingBand?.id ?? "unknown";
    const row = acc[pricingBand] ?? { pricingBand, label: call.billing?.pricing?.pricingBand?.label ?? "unknown", calls: [] };
    row.calls.push(call);
    acc[pricingBand] = row;
    return acc;
  }, {})).map((row) => ({ pricingBand: row.pricingBand, label: row.label, ...summarizeBillingCalls(row.calls) }));
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    pricing: { ...DEEPSEEK_PRICING, pricingHash: DEEPSEEK_PRICING_HASH },
    jobs: events.length,
    cacheServedJobs: events.filter((event) => event.billing?.cacheServed).length,
    totals,
    byModel,
    byPricingBand,
    calls: bounded,
    returnedCalls: bounded.length,
    totalCalls: calls.length,
  };
}

export async function getAdviceJob(requestId, options = {}) {
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(requestId)) return null;
  const current = jobs.get(requestId);
  if (current) return current;
  try { return JSON.parse(await readFile(path.join(jobRoot(options), `${requestId}.json`), "utf8")); } catch { return null; }
}

export async function waitForAdviceJob(requestId, { timeoutMs = 5_000, intervalMs = 10, ...options } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await getAdviceJob(requestId, options);
    if (job && ["completed", "disabled", "advice-unavailable"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return getAdviceJob(requestId, options);
}

export async function restoreAdviceRollback(file, { manifestPath } = {}) {
  const manifestFile = manifestPath ?? path.join(path.dirname(file), "rollback", "advice-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const entry = [...(manifest.entries ?? [])].reverse().find((candidate) => candidate.target === file && candidate.backup);
  if (!entry?.backup) throw new Error(`No rollback backup for ${file}`);
  const previous = await readFile(file, "utf8").catch(() => null);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(entry.backup, temp);
  await rename(temp, file);
  await appendRollback({ eventId: `advice-rollback-${hash({ file, previous })}`, operation: "advice-rollback", target: file, backup: entry.backup, previousHash: previous ? hash(previous) : null, nextHash: hash(await readFile(file, "utf8")), createdAt: new Date().toISOString() }, { rollbackManifestPath: manifestFile, rollbackRoot: path.dirname(manifestFile) });
  return { target: file, backup: entry.backup };
}

export const __testing = { validateInput, validateResult, canonicalize, hash, jobs, cache, auditQueues };
