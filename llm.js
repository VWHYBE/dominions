/**
 * LLM router: picks OpenRouter or Ollama from env.
 * Env: LLM_PROVIDER=openrouter|ollama (optional). If unset: OpenRouter when API key present, else Ollama when base URL set.
 */
import * as openRouter from "./openRouter.js";
import * as ollama from "./ollama.js";

const PROVIDER_OPENROUTER = "openrouter";
const PROVIDER_OLLAMA = "ollama";

const PROVIDERS = [
  { id: PROVIDER_OPENROUTER, isReady: () => openRouter.isConfigured() },
  { id: PROVIDER_OLLAMA, isReady: () => ollama.isConfigured() },
];

const readEnvProvider = () => (process.env.LLM_PROVIDER || "").toLowerCase().trim();

/** Resolve the active provider: "openrouter" | "ollama" | null. */
function resolveActiveProvider() {
  const env = readEnvProvider();
  if (env) {
    const match = PROVIDERS.find((p) => p.id === env && p.isReady());
    return match ? match.id : null;
  }
  const firstReady = PROVIDERS.find((p) => p.isReady());
  return firstReady ? firstReady.id : null;
}

/** True if at least one backend (OpenRouter or Ollama) is configured. */
export function isConfigured() {
  return PROVIDERS.some((p) => p.isReady());
}

/** Active provider id or null. */
export function getProviderName() {
  return resolveActiveProvider();
}

/**
 * Run chat completion with the active provider.
 * @param {string} userContent
 * @param {string} [systemContent]
 * @param {{ model?: string; maxTokens?: number }} [options]
 * @returns {Promise<string|null>}
 */
export async function complete(userContent, systemContent, options = {}) {
  const provider = resolveActiveProvider();
  if (!provider) return null;
  if (provider === PROVIDER_OLLAMA) {
    return ollama.complete(userContent, systemContent, options);
  }
  return openRouter.complete(userContent, systemContent, options);
}
