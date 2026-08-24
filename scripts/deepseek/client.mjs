import { loadDeepSeekConfig } from "./config.mjs";
import { priceDeepSeekUsage } from "./pricing.mjs";

const SYSTEM_PROMPT = `You are a constrained Build Sim advice formatter. Return JSON only matching the supplied schema. Use only facts in the input. Cite finding ids, SKU provenance ids, or user-goal. Never change ok/warn/bad, never turn unknown into a known fact, and never invent numbers. If a fact is missing, say unknown. The deterministic findings remain authoritative.`;

export const ADVICE_SYSTEM_PROMPT = SYSTEM_PROMPT;

function abortAfter(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

export async function requestDeepSeek(input, { config, fetchImpl = fetch, now = () => new Date() } = {}) {
  const resolved = config ?? await loadDeepSeekConfig();
  const timeout = abortAfter(resolved.timeoutMs);
  const startedAt = now().toISOString();
  const startedAtMs = Date.now();
  try {
    const response = await fetchImpl(`${resolved.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        temperature: resolved.temperature,
        max_tokens: resolved.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: timeout.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`DeepSeek HTTP ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("DeepSeek response was not JSON");
    }
    const providerModel = typeof payload?.model === "string" ? payload.model : resolved.model;
    const providerMetadata = {
      providerRequestId: typeof payload?.id === "string" ? payload.id : null,
      providerModel,
      startedAt,
      billing: priceDeepSeekUsage(providerModel, payload?.usage, { occurredAt: startedAt }),
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      const error = new Error("DeepSeek response missing JSON content");
      error.providerMetadata = providerMetadata;
      throw error;
    }
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      const error = new Error("DeepSeek content was not JSON");
      error.providerMetadata = providerMetadata;
      throw error;
    }
    return { result, latencyMs: Date.now() - startedAtMs, ...providerMetadata };
  } catch (error) {
    const message = error?.name === "AbortError" ? "DeepSeek request timed out" : error?.message ?? "DeepSeek request failed";
    const wrapped = new Error(message);
    wrapped.cause = error;
    if (error?.providerMetadata) wrapped.providerMetadata = error.providerMetadata;
    if (error?.httpStatus) wrapped.httpStatus = error.httpStatus;
    wrapped.startedAt = error?.providerMetadata?.startedAt ?? startedAt;
    wrapped.latencyMs = Date.now() - startedAtMs;
    throw wrapped;
  } finally {
    timeout.close();
  }
}
