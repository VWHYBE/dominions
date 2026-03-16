import fs from "fs/promises";
import path from "path";
import { getModuleDir } from "../utils/getModuleDir.js";

const __dirname = getModuleDir(import.meta.url);
export const CONFIG_PATH = path.join(__dirname, "config.json");

/**
 * @typedef {Object} Minion
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string} systemPrompt
 * @property {number} order
 * @property {string} [model]
 * @property {boolean} [active] — if false, agent is excluded from pipeline runs (default true)
 * @property {string[]} [skills] — capability tags; used for skill knowledge accumulation
 */

/**
 * @typedef {{ minions: Minion[] }} MinionsConfig
 */

function isValidMinion(m) {
  return m && typeof m.id === "string" && typeof m.systemPrompt === "string";
}

function withActiveDefault(m) {
  return { ...m, active: m.active !== false };
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data?.minions) ? data.minions : [];
    return { minions: list.filter(isValidMinion).map(withActiveDefault) };
  } catch (err) {
    if (err.code === "ENOENT") return { minions: [] };
    throw err;
  }
}

async function saveConfig(config) {
  await fs.writeFile(
    CONFIG_PATH,
    JSON.stringify({ minions: config.minions }, null, 2),
    "utf-8"
  );
}

function normalizeOrder(minions) {
  return [...minions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * @returns {Promise<Minion[]>}
 */
export async function getMinions() {
  const { minions } = await loadConfig();
  return normalizeOrder(minions);
}

/**
 * @param {string} id
 * @returns {Promise<Minion|null>}
 */
export async function getMinion(id) {
  const minions = await getMinions();
  return minions.find((m) => m.id === id) ?? null;
}

/**
 * @param {Omit<Minion, 'order'> & { order?: number }} input
 * @returns {Promise<Minion>}
 */
export async function addMinion(input) {
  const config = await loadConfig();
  if (config.minions.some((m) => m.id === input.id)) {
    throw new Error(`Minion with id "${input.id}" already exists`);
  }
  const nextOrder =
    input.order ??
    Math.max(0, ...config.minions.map((m) => m.order ?? 0)) + 1;
  const entry = {
    id: input.id,
    name: input.name ?? input.id,
    systemPrompt: input.systemPrompt ?? "",
    order: nextOrder,
    active: input.active !== false,
    ...(input.description !== undefined && input.description !== "" && { description: input.description }),
    ...(input.model && { model: input.model }),
    ...(Array.isArray(input.skills) && input.skills.length > 0 && { skills: input.skills }),
  };
  config.minions.push(entry);
  await saveConfig(config);
  return entry;
}

/**
 * @param {string} id
 * @param {{ name?: string; description?: string; systemPrompt?: string; order?: number; model?: string; active?: boolean }} updates
 * @returns {Promise<Minion|null>}
 */
export async function updateMinion(id, updates) {
  const config = await loadConfig();
  const idx = config.minions.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const prev = config.minions[idx];
  config.minions[idx] = {
    ...prev,
    ...(updates.name !== undefined && { name: updates.name }),
    ...(updates.description !== undefined && { description: updates.description }),
    ...(updates.systemPrompt !== undefined && { systemPrompt: updates.systemPrompt }),
    ...(updates.order !== undefined && { order: updates.order }),
    ...(updates.model !== undefined && { model: updates.model }),
    ...(updates.active !== undefined && { active: Boolean(updates.active) }),
    ...(updates.skills !== undefined && { skills: Array.isArray(updates.skills) ? updates.skills : [] }),
  };
  await saveConfig(config);
  return config.minions[idx];
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function removeMinion(id) {
  const config = await loadConfig();
  const before = config.minions.length;
  config.minions = config.minions.filter((m) => m.id !== id);
  if (config.minions.length === before) return false;
  await saveConfig(config);
  return true;
}
