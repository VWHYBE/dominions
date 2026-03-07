/**
 * OpenRouter client — direct fetch to https://openrouter.ai/api/v1/chat/completions
 * (no @openrouter/sdk wrapper, which wraps fetch in a way that hides real errors).
 *
 * Env: OPENROUTER_API_KEY (required), OPENROUTER_MODEL (optional).
 */
import { getConfig } from "./configManager.js";

const API_KEY     = process.env.OPENROUTER_API_KEY || "";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "";
const BASE_URL    = "https://openrouter.ai/api/v1/chat/completions";

/** Default max completion tokens. Overridden by runtime config from UI. */
const DEFAULT_MAX_TOKENS = process.env.OPENROUTER_MAX_TOKENS
  ? Number(process.env.OPENROUTER_MAX_TOKENS)
  : 4096;

// ─── Budget presets ──────────────────────────────────────────────────────────
const BUDGET_PRESETS = {
  free: {
    sortBy:                    "price",
    partition:                 "none",
    maxPrice:                  { prompt: "0",  completion: "0"  },
    preferredMinThroughputP90: 0,
    preferredMaxLatency:       0,
  },
  min: {
    sortBy:                    "price",
    partition:                 "none",
    maxPrice:                  { prompt: "1",  completion: "5"  },
    preferredMinThroughputP90: 0,
    preferredMaxLatency:       0,
  },
  mid: {
    sortBy:                    "price",
    partition:                 "none",
    maxPrice:                  { prompt: "3",  completion: "15" },
    preferredMinThroughputP90: 30,
    preferredMaxLatency:       15,
  },
  max: {
    sortBy:                    "latency",
    partition:                 "none",
    maxPrice:                  null,
    preferredMinThroughputP90: 50,
    preferredMaxLatency:       5,
  },
};

// Env-only overrides — take priority over the active preset.
const ENV_SORT           = process.env.OPENROUTER_PROVIDER_SORT || "";
const ENV_PARTITION      = process.env.OPENROUTER_PROVIDER_PARTITION || "";
const ENV_MAX_LATENCY    = process.env.OPENROUTER_PREFERRED_MAX_LATENCY
  ? Number(process.env.OPENROUTER_PREFERRED_MAX_LATENCY) : null;
const ENV_MIN_THROUGHPUT = process.env.OPENROUTER_PREFERRED_MIN_THROUGHPUT_P90
  ? Number(process.env.OPENROUTER_PREFERRED_MIN_THROUGHPUT_P90) : null;
const CUSTOM_PROMPT_PRICE     = process.env.OPENROUTER_MAX_PRICE_PROMPT?.trim()     || "";
const CUSTOM_COMPLETION_PRICE = process.env.OPENROUTER_MAX_PRICE_COMPLETION?.trim() || "";

/** Build the provider routing block (REST API uses snake_case). */
async function buildProvider(omitMaxPrice = false) {
  const { budget = "max" } = await getConfig();
  const preset = BUDGET_PRESETS[budget] ?? BUDGET_PRESETS.max;

  const sortBy    = ENV_SORT      || preset.sortBy;
  const partition = ENV_PARTITION || preset.partition;
  const maxLatency    = ENV_MAX_LATENCY    ?? preset.preferredMaxLatency;
  const minThroughput = ENV_MIN_THROUGHPUT ?? preset.preferredMinThroughputP90;

  const provider = { sort: { by: sortBy, partition } };
  if (maxLatency > 0)    provider.preferred_max_latency    = maxLatency;
  if (minThroughput > 0) provider.preferred_min_throughput = { p90: minThroughput };

  if (!omitMaxPrice) {
    const useCustom = (CUSTOM_PROMPT_PRICE || CUSTOM_COMPLETION_PRICE) && budget !== "max";
    const maxPrice = useCustom
      ? {
          ...(CUSTOM_PROMPT_PRICE     && { prompt:     CUSTOM_PROMPT_PRICE     }),
          ...(CUSTOM_COMPLETION_PRICE && { completion: CUSTOM_COMPLETION_PRICE }),
        }
      : preset.maxPrice;
    if (maxPrice && Object.keys(maxPrice).length > 0) provider.max_price = maxPrice;
  }

  return provider;
}

export function isConfigured() {
  return API_KEY.length > 0;
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

const MAX_RETRIES        = 3;
const RETRY_BASE_DELAY   = 500;   // ms
const REQUEST_TIMEOUT_MS = 60000; // 60 s per attempt

/**
 * Determine if an error is a transient network failure worth retrying.
 * @param {Error} err
 */
function isRetryable(err) {
  const msg = (err?.message ?? "").toLowerCase();
  const cause = (err?.cause?.message ?? "").toLowerCase();
  const combined = msg + " " + cause;
  return (
    combined.includes("fetch failed") ||
    combined.includes("econnreset") ||
    combined.includes("econnrefused") ||
    combined.includes("etimedout") ||
    combined.includes("socket hang up") ||
    combined.includes("network")
  );
}

/**
 * POST to OpenRouter with retries on transient network errors.
 * @param {object} body  Request body (JSON-serialisable).
 * @returns {Promise<object>} Parsed JSON response.
 */
async function postWithRetry(body) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + API_KEY,
          "Content-Type":  "application/json",
          "HTTP-Referer":  "https://dominions.local",
          "X-Title":       "Dominions",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      const text = await res.text().catch(() => "");
      if (!res.ok) {
        throw new Error("HTTP " + res.status + " " + res.statusText + (text ? ": " + text.slice(0, 200) : ""));
      }
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        lastErr = new Error("Invalid JSON from OpenRouter: " + (parseErr.message || "parse error"));
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY * 2 ** (attempt - 1)));
          continue;
        }
        throw lastErr;
      }

    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      if (err.name === "AbortError") {
        lastErr = new Error("Request timed out after " + REQUEST_TIMEOUT_MS / 1000 + "s");
      }

      const retryable = isRetryable(lastErr);
      const isLast    = attempt === MAX_RETRIES;

      if (retryable && !isLast) {
        const delay = RETRY_BASE_DELAY * 2 ** (attempt - 1);
        console.warn(
          "[OpenRouter] attempt " + attempt + "/" + MAX_RETRIES +
          " failed (" + lastErr.message + "), retrying in " + delay + "ms…"
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw lastErr;
    }
  }

  throw lastErr;
}

// ─── Content extractor ───────────────────────────────────────────────────────

/**
 * @param {string|Array|null|undefined} raw
 * @returns {string}
 */
function extractContent(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.trim();
  if (!Array.isArray(raw)) return String(raw);
  return raw
    .map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") {
        if (typeof p.text    === "string") return p.text;
        if (typeof p.content === "string") return p.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

const MAX_PRICE_ERROR = "no endpoints found that satisfy the max price";

// ─── complete ────────────────────────────────────────────────────────────────

/**
 * Non-streaming chat completion.
 * @param {string} userContent
 * @param {string} [systemContent]
 * @param {{ model?: string; maxTokens?: number }} [options]
 * @returns {Promise<string|null>}
 */
export async function complete(userContent, systemContent, options = {}) {
  if (!isConfigured()) return null;

  const messages = [];
  if (systemContent?.trim()) messages.push({ role: "system", content: systemContent.trim() });
  messages.push({ role: "user", content: userContent });

  const model     = options.model || DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const sendRequest = async (omitMaxPrice) => {
    const body = {
      model,
      messages,
      stream:     false,
      max_tokens: maxTokens,
      provider:   await buildProvider(omitMaxPrice),
    };
    return postWithRetry(body);
  };

  try {
    const result  = await sendRequest(false);
    const content = extractBestContent(result, model, maxTokens);
    return content || null;
  } catch (err) {
    const msg = (err?.message ?? "").toLowerCase();

    if (msg.includes(MAX_PRICE_ERROR)) {
      console.warn("[OpenRouter] max price excluded all endpoints, retrying without price cap");
      try {
        const result = await sendRequest(true);
        return extractBestContent(result, model, maxTokens) || null;
      } catch (retryErr) {
        console.error("[OpenRouter] error (after max-price retry):", retryErr?.message ?? retryErr);
        return null;
      }
    }

    const cause = err?.cause ? " — " + (err.cause?.message ?? err.cause) : "";
    console.error("[OpenRouter] complete error:", err.message + cause);
    return null;
  }
}

/**
 * Extract the best available text from an OpenRouter response.
 * Handles reasoning/thinking models (e.g. minimax-m2.5, o1, deepseek-r1) where
 * content may be null when max_tokens is exhausted during the thinking phase.
 */
function extractBestContent(result, model, maxTokens) {
  const choice    = result?.choices?.[0];
  const message   = choice?.message;
  const finish    = choice?.finish_reason;
  const usage     = result?.usage;

  const rawContent  = message?.content;
  const rawReasoning = message?.reasoning;

  const content   = extractContent(rawContent);

  // content is present — use it
  if (content) return content;

  // content is null/empty — this is a reasoning model (o1, minimax, deepseek-r1, etc.)
  // Two sub-cases:
  //   A) finish_reason=stop  → model finished but content intentionally empty (edge case — use reasoning)
  //   B) finish_reason=length → max_tokens exhausted during thinking phase — warn and suggest increase
  if (finish === "length" && !content) {
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    console.warn(
      `[OpenRouter] max_tokens (${maxTokens}) exhausted — model "${model}" used ${reasoningTokens} reasoning tokens.` +
      " Increase MAX TOKENS in the UI header or set OPENROUTER_MAX_TOKENS in .env (e.g. 32768)."
    );
    // Return whatever reasoning we have as fallback so pipeline doesn't halt
    const partialReasoning = extractContent(rawReasoning);
    return partialReasoning
      ? `[NOTE: max_tokens exhausted during reasoning. Partial thinking below — increase MAX TOKENS.]\n\n${partialReasoning}`
      : null;
  }

  // finish=stop but content null — return reasoning as the response
  const reasoning = extractContent(rawReasoning);
  if (reasoning) {
    console.warn(`[OpenRouter] content null but reasoning present (model: ${model}) — using reasoning as output`);
    return reasoning;
  }

  console.warn("[OpenRouter] empty content — model:", model, "finish_reason:", finish);
  return null;
}
