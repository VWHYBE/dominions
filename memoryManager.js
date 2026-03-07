import fs from "fs/promises";
import path from "path";
import { getModuleDir } from "./utils/getModuleDir.js";

const __dirname = getModuleDir(import.meta.url);
const MEMORY_PATH = path.join(__dirname, "memory.json");

/**
 * @typedef {Object} MemoryEntry
 * @property {string} role
 * @property {string} timestamp
 * @property {string} message
 */

/**
 * Memory store: dynamic keys (shared + minion ids). Each value is MemoryEntry[].
 * @typedef {Record<string, MemoryEntry[]>} MemoryStore
 */

function ensureArray(val) {
  return Array.isArray(val) ? val.filter((e) => e && typeof e.message === "string") : [];
}

export async function loadMemory() {
  try {
    const raw = await fs.readFile(MEMORY_PATH, "utf-8");
    const data = JSON.parse(raw);
    const store = {};
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (k && typeof k === "string") store[k] = ensureArray(v);
      }
    }
    if (!Array.isArray(store.shared)) store.shared = [];
    return store;
  } catch (err) {
    if (err.code === "ENOENT") {
      const store = { shared: [] };
      await saveMemory(store);
      return store;
    }
    throw err;
  }
}

export async function saveMemory(store) {
  const out = {};
  for (const [k, v] of Object.entries(store)) {
    if (k && typeof k === "string" && Array.isArray(v)) {
      out[k] = v.filter((e) => e && typeof e.role === "string" && typeof e.message === "string");
    }
  }
  if (!Array.isArray(out.shared)) out.shared = [];
  await fs.writeFile(MEMORY_PATH, JSON.stringify(out, null, 2), "utf-8");
}

/**
 * Append one entry to a role (any string key). Creates key if missing.
 * @param {string} role
 * @param {string} message
 * @returns {Promise<MemoryEntry>}
 */
export async function appendToRole(role, message) {
  if (!role || typeof role !== "string") {
    throw new Error("role is required (non-empty string)");
  }
  const store = await loadMemory();
  if (!Array.isArray(store[role])) store[role] = [];
  const entry = {
    role,
    timestamp: new Date().toISOString(),
    message,
  };
  store[role].push(entry);
  await saveMemory(store);
  return entry;
}

export async function appendShared(message) {
  return appendToRole("shared", message);
}

/**
 * @param {string|null} [role]
 * @returns {Promise<MemoryEntry[]|MemoryStore>}
 */
export async function getMemory(role = null) {
  const store = await loadMemory();
  if (role) return store[role] ?? [];
  return store;
}

/**
 * Clear one role or all. If role is null, clears every key.
 * @param {string|null} [role]
 */
export async function clearMemory(role = null) {
  const store = await loadMemory();
  if (role) {
    store[role] = [];
  } else {
    for (const k of Object.keys(store)) store[k] = [];
  }
  await saveMemory(store);
}

export { MEMORY_PATH };
