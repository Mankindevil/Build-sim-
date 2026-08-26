import { priceDeepSeekUsage } from "../../deepseek/pricing.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 2_048;

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function endpoint(value) {
  let url;
  try { url = new URL(value || "https://api.deepseek.com"); } catch { throw new Error("DEEPSEEK_OCR_API_URL must be a valid HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("DEEPSEEK_OCR_API_URL must use http or https");
  return url.toString().replace(/\/$/, "");
}

function abortAfter(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

/**
 * Calls DeepSeek's public vision model by default. A self-hosted
 * deepseek-ai/DeepSeek-OCR vLLM endpoint remains an explicit rollback option.
 */
export async function requestDeepSeekOcr(buffer, mimeType, options = {}) {
  const apiUrl = endpoint(options.apiUrl);
  const model = String(options.model || "deepseek-v4-flash-vision-exp").trim();
  if (!model || model.length > 200) throw new Error("DEEPSEEK_OCR_MODEL is invalid");
  const selfHosted = model === "deepseek-ai/DeepSeek-OCR" || model.endsWith("/DeepSeek-OCR");
  if (!selfHosted && !options.apiKey) throw new Error("DEEPSEEK_API_KEY is required for DeepSeek vision OCR");
  const timeoutMs = boundedInteger(options.timeoutMs, 5_000, 180_000, DEFAULT_TIMEOUT_MS);
  const maxTokens = boundedInteger(options.maxTokens, 128, 8_192, DEFAULT_MAX_TOKENS);
  const startedAt = new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timer = abortAfter(timeoutMs);
    try {
      const headers = { "Content-Type": "application/json" };
      if (options.apiKey) headers.Authorization = `Bearer ${String(options.apiKey)}`;
      const response = await fetchImpl(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: selfHosted ? "Free OCR." : "请完整识别这张交易截图中的可见文字，保留商品型号、数量、成交价和订单字段。只输出识别文字，不要解释。" },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}`, ...(selfHosted ? {} : { detail: "original" }) } },
            ],
          }],
          max_tokens: maxTokens,
          temperature: 0,
          ...(selfHosted ? {
            skip_special_tokens: false,
            vllm_xargs: { ngram_size: 30, window_size: 90, whitelist_token_ids: [128821, 128822] },
          } : {}),
        }),
        signal: timer.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        const error = new Error(`DeepSeek-OCR HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Error("DeepSeek-OCR response was not JSON"); }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek-OCR response contained no text");
      return {
        text: content.trim(),
        confidence: null,
        engine: `${selfHosted ? "deepseek-ocr" : "deepseek-vision"}:${typeof payload?.model === "string" ? payload.model : model}`,
        billing: selfHosted ? null : priceDeepSeekUsage(typeof payload?.model === "string" ? payload.model : model, payload?.usage, { occurredAt: startedAt }),
      };
    } catch (error) {
      const normalized = error?.name === "AbortError" ? new Error("DeepSeek-OCR request timed out") : error;
      if (normalized && error?.name === "AbortError") normalized.retryable = true;
      lastError = normalized;
      if (attempt === 1 || normalized?.retryable === false) throw normalized;
    } finally {
      timer.close();
    }
  }
  throw lastError ?? new Error("DeepSeek-OCR request failed");
}
