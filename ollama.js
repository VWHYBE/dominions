/**
 * Ollama client — streaming chat completion via local Ollama (e.g. http://localhost:11434).
 * Uses stream:true so the connection stays alive (no idle-timeout kill) even for long generations.
 * Env: OLLAMA_BASE_URL (default http://localhost:11434), OLLAMA_MODEL, OLLAMA_TIMEOUT_MS.
 */

// BASE_URL has no hardcoded default — if OLLAMA_BASE_URL is not set, Ollama is NOT considered configured.
// This prevents Ollama from silently winning when LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is missing.
const BASE_URL = (process.env.OLLAMA_BASE_URL || "").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
// Total wall-clock timeout for the entire streaming response (default 10 min).
// Streaming keeps the TCP connection alive, so even 10+ min generations work fine.
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 600000;

export function isConfigured() {
  return BASE_URL.length > 0;
}

/**
 * Streaming chat completion — collects all chunks and returns the full text.
 * Streaming prevents idle-TCP-timeout that kills non-streaming long requests in WSL2.
 * @param {string} userContent
 * @param {string} [systemContent]
 * @param {{ model?: string; maxTokens?: number }} [options]
 * @returns {Promise<string|null>}
 */
export async function complete(userContent, systemContent, options = {}) {
  if (!isConfigured()) return null;

  const model = options.model || DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 4096;

  const messages = [];
  if (systemContent?.trim()) messages.push({ role: "system", content: systemContent.trim() });
  messages.push({ role: "user", content: userContent });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    console.warn("[Ollama] hard timeout after", REQUEST_TIMEOUT_MS / 1000, "s — increase OLLAMA_TIMEOUT_MS if needed");
  }, REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: { num_predict: maxTokens },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status} ${res.statusText}${text ? ": " + text.slice(0, 200) : ""}`);
    }

    // Consume the stream — each line is a JSON chunk { message: { content }, done }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          const token = chunk?.message?.content;
          if (typeof token === "string") accumulated += token;
          if (chunk?.done) break;
        } catch { /* skip unparseable lines */ }
      }
    }

    clearTimeout(timer);
    return accumulated.trim() || null;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      console.warn("[Ollama] aborted — increase OLLAMA_TIMEOUT_MS in .env for very long pipelines");
      return null;
    }
    console.error("[Ollama] complete error:", err?.message ?? err);
    return null;
  }
}
