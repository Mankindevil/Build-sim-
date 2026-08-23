import { loadDeepSeekConfig } from "./config.mjs";

const SYSTEM_PROMPT = `You are a constrained Build Sim advice formatter. Return JSON only matching the supplied schema. Use only facts in the input. Cite finding ids, SKU provenance ids, or user-goal. Never change ok/warn/bad, never turn unknown into a known fact, and never invent numbers. If a fact is missing, say unknown. The deterministic findings remain authoritative.`;

export const ADVICE_SYSTEM_PROMPT = SYSTEM_PROMPT;

function abortAfter(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

export async function requestDeepSeek(input, { config, fetchImpl = fetch } = {}) {
  const resolved = config ?? await loadDeepSeekConfig();
  const timeout = abortAfter(resolved.timeoutMs);
  const startedAt = Date.now();
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
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("DeepSeek response was not JSON");
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("DeepSeek response missing JSON content");
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      throw new Error("DeepSeek content was not JSON");
    }
    return { result, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const message = error?.name === "AbortError" ? "DeepSeek request timed out" : error?.message ?? "DeepSeek request failed";
    const wrapped = new Error(message);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    timeout.close();
  }
}
