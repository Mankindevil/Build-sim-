import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDeepSeekConfig } from "./config.mjs";
import { requestDeepSeek } from "./client.mjs";
import { DEEPSEEK_PRICING, DEEPSEEK_PRICING_HASH, priceDeepSeekUsage, summarizeBillingCalls } from "./pricing.mjs";
import { atomicWriteJson, ensurePrivateDirectory, sha256Json } from "../../src/runtime/fs.mjs";
import { FileArtifactRepository } from "../../src/artifacts/repository.mjs";
import { DurableJobAdapter, durableJobId } from "./durable-job-adapter.mjs";
import { validateRuntimeJobSideEffectFence } from "../../src/jobs/runtime-validation.mjs";

export const ADVICE_SCHEMA_VERSION = "1.0.0";
export const ADVICE_PROMPT_VERSION = "build-advice-1.0.0";
const MAX_TEXT = 2_000;
const MAX_ARRAY = 64;
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

const digest = hash;

function dateNow(now) {
  const value = (now ?? (() => new Date().toISOString()))();
  return value instanceof Date ? value.toISOString() : String(value);
}

function auditRoot(options = {}) {
  return options.auditRoot ?? process.env.BUILD_SIM_ADVICE_AUDIT_ROOT ?? path.resolve("data/audit/advice-events");
}

function jobRoot(options = {}) {
  return options.jobRoot ?? process.env.BUILD_SIM_ADVICE_JOB_ROOT ?? path.resolve("data/audit/advice-jobs");
}

async function atomicJson(file, payload) {
  await atomicWriteJson(file, payload);
}

async function runtimeAdviceRoot(options, kind, activeRoot) {
  const explicit = kind === "audit" ? options.auditRoot : kind === "job" ? options.jobRoot : options.rollbackRoot;
  if (explicit) return path.resolve(explicit);
  if (options.coordinator) {
    await options.coordinator.initialize();
    const baseRoot = activeRoot ?? options.coordinator.activeRoot(await options.coordinator.readState());
    const base = path.join(baseRoot, "audit");
    return kind === "audit" ? path.join(base, "advice-events") : kind === "job" ? path.join(base, "advice-jobs") : path.join(base, "rollback");
  }
  return kind === "audit" ? auditRoot(options) : kind === "job" ? jobRoot(options) : path.join(path.dirname(auditRoot(options)), "rollback");
}

async function coordinatedAdviceWrite(options, operation) {
  if (!options.coordinator) return operation(undefined);
  await options.coordinator.initialize();
  return (await options.coordinator.withWrite((context) => {
    if (options.runtimeFence && context.state.runtimeGeneration !== options.runtimeFence.runtimeGeneration) {
      throw new Error("advice write fenced by runtime generation");
    }
    if (options.runtimeFence?.jobId) {
      return readFile(path.join(context.activeRoot, "jobs", "records", `${options.runtimeFence.jobId}.json`), "utf8").then((raw) => {
        const envelope = JSON.parse(raw);
        if (envelope?.schemaVersion !== "job-store-envelope-v1" || envelope.kind !== "background-job" || envelope.checksum !== sha256Json(envelope.payload)
          || validateRuntimeJobSideEffectFence(envelope.payload, options.runtimeFence, dateNow(options.now)).length > 0) {
          throw new Error("advice write fenced by stale job lease");
        }
        return operation(context);
      });
    }
    return operation(context);
  }, options)).result;
}

async function rollbackManifestPath(options = {}) {
  if (options.rollbackManifestPath) return options.rollbackManifestPath;
  return path.join(await runtimeAdviceRoot(options, "rollback"), "advice-manifest.json");
}

async function appendRollback(entry, options = {}) {
  const file = await rollbackManifestPath(options);
  const prior = rollbackQueues.get(file) ?? Promise.resolve();
  const current = prior.then(async () => {
    let payload = { schemaVersion: "advice-rollback-v2", entries: [], checksum: null };
    try { payload = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT" && options.coordinator) throw error; }
    const unsigned = { schemaVersion: payload.schemaVersion, entries: payload.entries };
    if (payload.schemaVersion !== "advice-rollback-v2" || (payload.checksum && payload.checksum !== digest(unsigned))) throw new Error("advice rollback manifest is corrupt");
    const entries = entry.state === "committed" && entry.eventId
      ? (payload.entries ?? []).map((candidate) => candidate.eventId === entry.eventId ? entry : candidate)
      : [...(payload.entries ?? []), entry];
    const nextUnsigned = { schemaVersion: "advice-rollback-v2", entries };
    await atomicJson(file, { ...nextUnsigned, checksum: digest(nextUnsigned) });
  });
  rollbackQueues.set(file, current.catch(() => {}));
  await current;
}

async function validateAdviceManifest(options = {}) {
  const file = await rollbackManifestPath(options);
  try {
    const payload = JSON.parse(await readFile(file, "utf8"));
    const unsigned = { schemaVersion: payload.schemaVersion, entries: payload.entries };
    const base = path.dirname(path.dirname(file));
    const incomplete = await Promise.all((payload.entries ?? []).filter((entry) => entry.state === "prepared").map(async (entry) => {
      if (typeof entry.target !== "string" || entry.target.startsWith("/") || entry.target.includes("..")) return true;
      try { const value = JSON.parse(await readFile(path.resolve(base, entry.target), "utf8")); return digest(value) !== entry.nextHash; } catch { return true; }
    }));
    if (payload.schemaVersion !== "advice-rollback-v2" || !Array.isArray(payload.entries) || payload.checksum !== digest(unsigned) || incomplete.some(Boolean)) throw new Error("advice rollback manifest is corrupt or incomplete");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function writeWithRollback(file, payload, operation, options = {}) {
  const previous = await readFile(file, "utf8").catch(() => null);
  const rollbackRoot = options.rollbackRoot ?? await runtimeAdviceRoot(options, "rollback");
  let backup = null;
  if (previous !== null) {
    await ensurePrivateDirectory(rollbackRoot);
    backup = path.join(rollbackRoot, `${path.basename(file)}.${Date.now()}.bak`);
    await copyFile(file, backup);
    await chmod(backup, 0o600);
  }
  const targetRelative = path.relative(path.dirname(rollbackRoot), file).split(path.sep).join("/");
  const entry = { eventId: `advice-write-${hash({ file, operation, previous, payload })}`, operation, target: targetRelative, backup: backup ? path.relative(path.dirname(rollbackRoot), backup).split(path.sep).join("/") : null, previousBase64: previous ? Buffer.from(previous).toString("base64") : null, previousHash: previous ? hash(previous) : null, nextHash: hash(payload), state: "prepared", createdAt: new Date().toISOString() };
  await appendRollback(entry, options);
  await atomicJson(file, payload);
  await appendRollback({ ...entry, state: "committed", committedAt: new Date().toISOString() }, options);
}

async function appendAudit(event, options = {}) {
  const queueKey = options.auditRoot ?? `${options.coordinator?.root ?? "legacy"}:${event.generatedAt.slice(0, 10)}`;
  const prior = auditQueues.get(queueKey) ?? Promise.resolve();
  const current = prior.then(() => coordinatedAdviceWrite(options, async (context) => {
    const root = await runtimeAdviceRoot(options, "audit", context?.activeRoot);
    const day = event.generatedAt.slice(0, 10);
    const file = path.join(root, `${day}.json`);
    let payload = { schemaVersion: "1.0.0", events: [] };
    try { payload = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT" && options.coordinator) throw error; }
    const events = Array.isArray(payload.events) ? payload.events : [];
    const existing = events.findIndex((item) => item.eventId === event.eventId);
    if (existing >= 0) events[existing] = event;
    else events.push(event);
    await writeWithRollback(file, { schemaVersion: "1.0.0", events }, "advice-audit", options);
  }));
  auditQueues.set(queueKey, current.catch(() => {}));
  await current;
}

async function persistJob(job, options = {}) {
  const safe = { ...job };
  await coordinatedAdviceWrite(options, async (context) => writeWithRollback(path.join(await runtimeAdviceRoot(options, "job", context?.activeRoot), `${job.requestId}.json`), safe, "advice-job", options));
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
  if (!options.durableClaim) await persistJob(job, options);
}

function usesDurableJobs(options = {}) {
  return Boolean(options.coordinator && !options.jobRoot);
}

function durableComponents(options = {}) {
  const adapter = options.durableAdapter ?? new DurableJobAdapter({
    coordinator: options.coordinator,
    now: options.now ? () => dateNow(options.now) : undefined,
    leaseToken: options.leaseToken,
    leaseDurationMs: options.leaseDurationMs,
  });
  const artifacts = options.artifacts ?? new FileArtifactRepository({ coordinator: options.coordinator, now: options.now ? () => dateNow(options.now) : undefined });
  return { adapter, artifacts };
}

async function loadDurablePayload(artifacts, ref) {
  const artifact = await artifacts.get(ref);
  if (!artifact) throw new Error("advice job payload artifact is missing");
  let payload;
  try { payload = JSON.parse(artifact.bytes.toString("utf8")); } catch { throw new Error("advice job payload artifact is corrupt"); }
  if (payload?.schemaVersion !== "advice-job-payload-v1" || !payload.input || !payload.publicJob) throw new Error("advice job payload artifact is invalid");
  return payload;
}

async function executeDurableAdvice(jobId, options = {}) {
  const { adapter, artifacts } = durableComponents(options);
  await adapter.initialize();
  const claim = await adapter.claim(jobId, options.workerId ?? `advice-${process.pid}`);
  if (!claim) return adapter.get(jobId);
  const payload = await loadDurablePayload(artifacts, claim.job.payloadRef);
  let completed;
  if (payload.execute === false) {
    completed = payload.publicJob;
    await audit(completed, { ...options, durableClaim: claim, runtimeFence: { runtimeGeneration: claim.job.runtimeGeneration, jobId: claim.job.jobId, ...claim.lease } });
  } else {
    let config;
    try { config = options.config ?? await loadDeepSeekConfig(); }
    catch {
      await adapter.fail(jobId, claim.lease, "config", "Advice provider configuration is unavailable", false);
      return null;
    }
    completed = await runAdviceJob(payload.publicJob, payload.input, {
      ...options,
      config,
      cacheKey: payload.cacheKey,
      durableAdapter: adapter,
      durableClaim: claim,
      runtimeFence: { runtimeGeneration: claim.job.runtimeGeneration, jobId: claim.job.jobId, ...claim.lease },
    });
  }
  const currentLease = completed.__durableLease ?? claim.lease;
  const resultArtifact = await artifacts.put({
    bytes: Buffer.from(JSON.stringify(completed), "utf8"),
    mediaType: "application/json",
    privacyClass: "private_user",
    kind: "advice-result",
    references: [{ ref: claim.job.payloadRef, necessity: "required_for_replay" }],
  }, { expectedRuntimeGeneration: claim.job.runtimeGeneration, expectedJobLease: { jobId: claim.job.jobId, ...currentLease } });
  delete completed.__durableLease;
  await adapter.succeed(jobId, currentLease, [resultArtifact.record.ref], hash(completed));
  return completed;
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
  if (usesDurableJobs(options)) {
    const { adapter } = durableComponents(options);
    await adapter.initialize();
    const existing = await adapter.get(durableJobId(`advice:${requestId}`));
    if (existing) {
      if (existing.inputHash !== inputHash) throw new Error("advice requestId was reused for different input");
      return (await getAdviceJob(requestId, options)) ?? { ...baseJob(input, inputHash, engineHash, null, dateNow(options.now)), status: existing.status };
    }
  }
  let config;
  try { config = options.config ?? await loadDeepSeekConfig(); } catch (error) {
    const job = { ...baseJob(input, inputHash, engineHash, null, dateNow(options.now)), status: "advice-unavailable", failureStage: "config", validationErrors: [error.message] };
    if (usesDurableJobs(options)) return createDurableAdvice(input, job, null, false, options);
    await audit(job, options); return job;
  }
  const flags = options.flags ?? { adviceEnabled: false };
  if (!flags.adviceEnabled || !config.enabled) {
    const job = { ...baseJob(input, inputHash, engineHash, config.enabled ? config.model : null, dateNow(options.now)), status: "disabled", failureStage: undefined };
    if (!usesDurableJobs(options)) { await audit(job, options); return job; }
    return createDurableAdvice(input, job, null, false, options);
  }
  const cacheKey = `${ADVICE_PROMPT_VERSION}:${inputHash}:${engineHash}:${config.model}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    const job = { ...baseJob(input, inputHash, engineHash, config.model, dateNow(options.now)), status: "completed", advice: cached, cacheHit: true, billing: summarizeBillingCalls([], { cacheServed: true }) };
    if (!usesDurableJobs(options)) { await audit(job, options); return job; }
    return createDurableAdvice(input, job, cacheKey, false, options);
  }
  const job = baseJob(input, inputHash, engineHash, config.model, dateNow(options.now));
  if (usesDurableJobs(options)) return createDurableAdvice(input, job, cacheKey, true, { ...options, config });
  await audit(job, options);
  void runAdviceJob(job, input, { ...options, config, cacheKey });
  return job;
}

async function createDurableAdvice(input, publicJob, cacheKey, execute, options) {
  const { adapter, artifacts } = durableComponents(options);
  await adapter.initialize();
  const payload = { schemaVersion: "advice-job-payload-v1", input, publicJob, cacheKey, execute };
  const artifact = await artifacts.put({
    bytes: Buffer.from(JSON.stringify(payload), "utf8"), mediaType: "application/json",
    privacyClass: "private_user", kind: "advice-input", references: [],
  });
  const created = await adapter.create({
    type: "agent.advice", handlerVersion: "1", idempotencyKey: `advice:${input.requestId}`,
    inputHash: publicJob.inputHash, payloadRef: artifact.record.ref, networkRequired: execute, maxAttempts: 3,
  });
  if (!created.created) return (await getAdviceJob(input.requestId, options)) ?? publicJob;
  if (!execute) {
    await executeDurableAdvice(created.job.jobId, options);
    return (await getAdviceJob(input.requestId, options)) ?? publicJob;
  }
  void executeDurableAdvice(created.job.jobId, options).catch(() => {
    // Generic job state and redacted audit remain authoritative after a crash.
  }).finally(() => options.onDurableWorkerSettled?.(created.job.jobId));
  return publicJob;
}

export async function runAdviceJob(job, input, options = {}) {
  let durableClaim = options.durableClaim;
  if (durableClaim && options.durableAdapter) durableClaim = await options.durableAdapter.heartbeat(durableClaim.job.jobId, durableClaim.lease);
  job.status = "running";
  job.failureStage = "request";
  job.retries = 0;
  try {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (durableClaim && options.durableAdapter) durableClaim = await options.durableAdapter.heartbeat(durableClaim.job.jobId, durableClaim.lease);
        response = await requestDeepSeek(input, { config: options.config, fetchImpl: options.fetchImpl, now: options.now });
        if (durableClaim && options.durableAdapter) durableClaim = await options.durableAdapter.heartbeat(durableClaim.job.jobId, durableClaim.lease);
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
  if (durableClaim) options.runtimeFence = { runtimeGeneration: durableClaim.job.runtimeGeneration, jobId: durableClaim.job.jobId, ...durableClaim.lease };
  await audit(job, options);
  if (durableClaim) Object.defineProperty(job, "__durableLease", { value: durableClaim.lease, enumerable: false, configurable: true });
  return job;
}

export async function getAdviceBillingSummary({ limit = 100, ...options } = {}) {
  await validateAdviceManifest(options);
  const root = await runtimeAdviceRoot(options, "audit");
  const files = (await readdir(root).catch(() => [])).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort();
  const events = [];
  for (const file of files) {
    try {
      const payload = JSON.parse(await readFile(path.join(root, file), "utf8"));
      events.push(...(Array.isArray(payload.events) ? payload.events : []));
    } catch (error) {
      if (options.coordinator) throw error;
      /* malformed historical files remain isolated for explicit legacy roots */
    }
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
  if (usesDurableJobs(options)) {
    const { adapter, artifacts } = durableComponents(options);
    await adapter.initialize();
    const jobId = durableJobId(`advice:${requestId}`);
    let durable = await adapter.get(jobId);
    if (!durable) return null;
    if (durable.status === "running" && Date.parse(durable.leaseExpiresAt ?? "") <= Date.parse(dateNow(options.now))) {
      await adapter.recover("agent.advice");
      durable = await adapter.get(jobId);
    }
    if (durable?.status === "waiting_retry" && Date.parse(durable.runAfter) <= Date.parse(dateNow(options.now))) {
      await adapter.promote("agent.advice");
      durable = await adapter.get(jobId);
    }
    if (durable.status === "queued") {
      void executeDurableAdvice(jobId, options).catch(() => {}).finally(() => options.onDurableWorkerSettled?.(jobId));
      durable = await adapter.get(jobId);
    }
    if (durable.status === "succeeded") {
      const resultRef = durable.resultRefs[0];
      if (!resultRef) throw new Error("completed advice job has no result artifact");
      const result = await artifacts.get(resultRef);
      if (!result) throw new Error("completed advice result artifact is missing");
      return JSON.parse(result.bytes.toString("utf8"));
    }
    const payload = await loadDurablePayload(artifacts, durable.payloadRef);
    if (["failed", "dead_letter", "cancelled"].includes(durable.status)) {
      return { ...payload.publicJob, status: "advice-unavailable", failureStage: durable.lastError?.code ?? "durable-job", validationErrors: [durable.lastError?.message ?? "Advice job did not complete"] };
    }
    return { ...payload.publicJob, status: durable.status, durableRevision: durable.revision, runtimeGeneration: durable.runtimeGeneration };
  }
  await validateAdviceManifest(options);
  try { return JSON.parse(await readFile(path.join(await runtimeAdviceRoot(options, "job"), `${requestId}.json`), "utf8")); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
}

export async function waitForAdviceJob(requestId, { timeoutMs = 5_000, intervalMs = 10, ...options } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await getAdviceJob(requestId, options);
    if (job && ["completed", "disabled", "advice-unavailable", "paused_restore_review"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return getAdviceJob(requestId, options);
}

/** Resume only ordinary crash/retry work. Restored jobs stay paused for review. */
export async function resumeAdviceJobs(options = {}) {
  if (!usesDurableJobs(options)) return { recovered: 0, promoted: 0, resumed: 0 };
  const { adapter } = durableComponents(options);
  await adapter.initialize();
  const recovered = await adapter.recover("agent.advice");
  const promoted = await adapter.promote("agent.advice");
  const queued = (await adapter.list("agent.advice")).filter((job) => job.status === "queued");
  for (const job of queued) void executeDurableAdvice(job.jobId, options).catch(() => {}).finally(() => options.onDurableWorkerSettled?.(job.jobId));
  const running = (await adapter.list("agent.advice")).filter((job) => job.status === "running" && job.leaseExpiresAt)
    .sort((left, right) => left.leaseExpiresAt.localeCompare(right.leaseExpiresAt));
  if (running[0]?.leaseExpiresAt) {
    const timer = setTimeout(() => { void resumeAdviceJobs(options).catch(() => {}); }, Math.max(1, Date.parse(running[0].leaseExpiresAt) - Date.now() + 5));
    timer.unref?.();
  }
  return { recovered, promoted, resumed: queued.length };
}

export async function restoreAdviceRollback(file, { manifestPath } = {}) {
  const manifestFile = manifestPath ?? path.join(path.dirname(file), "rollback", "advice-manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const manifestBase = path.dirname(path.dirname(manifestFile));
  const entry = [...(manifest.entries ?? [])].reverse().find((candidate) => (candidate.target === file || path.resolve(manifestBase, candidate.target ?? "") === path.resolve(file)) && candidate.backup);
  if (!entry?.backup) throw new Error(`No rollback backup for ${file}`);
  const previous = await readFile(file, "utf8").catch(() => null);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(path.isAbsolute(entry.backup) ? entry.backup : path.resolve(manifestBase, entry.backup), temp);
  await chmod(temp, 0o600);
  await rename(temp, file);
  await appendRollback({ eventId: `advice-rollback-${hash({ file, previous })}`, operation: "advice-rollback", target: path.relative(manifestBase, file).split(path.sep).join("/"), backup: entry.backup, previousHash: previous ? hash(previous) : null, nextHash: hash(await readFile(file, "utf8")), state: "committed", createdAt: new Date().toISOString() }, { rollbackManifestPath: manifestFile, rollbackRoot: path.dirname(manifestFile) });
  return { target: file, backup: entry.backup };
}

export const __testing = { validateInput, validateResult, canonicalize, hash, cache, auditQueues };
