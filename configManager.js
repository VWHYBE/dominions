/**
 * Runtime config manager — persists user-changeable settings to runtime-config.json.
 * Values here override the corresponding .env defaults at call time (not module load).
 */
import fs from "fs/promises";
import path from "path";
import { getModuleDir } from "./utils/getModuleDir.js";

const __dirname = getModuleDir(import.meta.url);
const CONFIG_FILE = path.join(__dirname, "runtime-config.json");

const DEFAULT_MAX_TOKENS_ENV = process.env.OPENROUTER_MAX_TOKENS
  ? Number(process.env.OPENROUTER_MAX_TOKENS)
  : 16384; // Higher default for reasoning models (o1, minimax, deepseek-r1) that consume tokens for thinking

const DEFAULTS = {
  budget: (process.env.OPENROUTER_BUDGET || "max").toLowerCase(),
  maxTokens: Number.isFinite(DEFAULT_MAX_TOKENS_ENV) && DEFAULT_MAX_TOKENS_ENV > 0
    ? DEFAULT_MAX_TOKENS_ENV
    : 16384,
};

/** @type {Record<string,unknown>|null} */
let _cache = null;

async function load() {
  if (_cache) return _cache;
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const maxTokens = parsed.maxTokens;
    _cache = {
      ...DEFAULTS,
      ...parsed,
      maxTokens: Number.isFinite(maxTokens) && maxTokens >= 256 && maxTokens <= 128000
        ? Math.round(maxTokens)
        : DEFAULTS.maxTokens,
    };
  } catch {
    _cache = { ...DEFAULTS };
  }
  return _cache;
}

/** @returns {Promise<{ budget: string; maxTokens: number }>} */
export async function getConfig() {
  return load();
}

/**
 * Merge patch into the current config and persist to disk.
 * @param {Partial<{ budget: string; maxTokens: number }>} patch
 * @returns {Promise<{ budget: string; maxTokens: number }>}
 */
export async function updateConfig(patch) {
  const current = await load();
  let next = { ...current, ...patch };
  if (patch.maxTokens !== undefined) {
    const n = Number(patch.maxTokens);
    next.maxTokens = Number.isFinite(n) && n >= 256 && n <= 128000 ? Math.round(n) : current.maxTokens;
  }
  _cache = next;
  await fs.writeFile(CONFIG_FILE, JSON.stringify(_cache, null, 2), "utf-8");
  return _cache;
}
