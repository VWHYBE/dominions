import fs from "fs/promises";
import path from "path";
import { getModuleDir } from "./utils/getModuleDir.js";

const __dirname = getModuleDir(import.meta.url);
const MEMORY_PATH = path.join(__dirname, "memory.json");
const AGENTS_DIR = path.join(__dirname, "agents");

// ─── Long-term memory helpers ──────────────────────────────────────────────

function agentMemoryPath(agentId) {
  return path.join(AGENTS_DIR, `${agentId}.memory.md`);
}

const LTM_ENTRY_SEPARATOR = "\n---\n";

/**
 * Parse long-term memory file into an array of entry strings.
 * @param {string} raw
 * @returns {string[]}
 */
function parseLtmEntries(raw) {
  return raw
    .split(LTM_ENTRY_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Serialize entry array back to file content.
 * @param {string} agentId
 * @param {string[]} entries
 * @returns {string}
 */
function serializeLtm(agentId, entries) {
  const header = `# ${agentId} — Long-term Memory\n`;
  if (entries.length === 0) return header;
  return header + entries.join(LTM_ENTRY_SEPARATOR) + LTM_ENTRY_SEPARATOR;
}

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

// ─── Long-term memory (per-agent markdown files) ──────────────────────────

/**
 * Read an agent's long-term memory file.
 * Returns the raw markdown content, or "" if not yet created.
 * @param {string} agentId
 * @returns {Promise<string>}
 */
export async function readAgentLongTermMemory(agentId) {
  try {
    return await fs.readFile(agentMemoryPath(agentId), "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Append a new run entry to an agent's long-term memory file.
 * @param {string} agentId
 * @param {{ task: string; output: string; timestamp?: string }} entry
 * @returns {Promise<void>}
 */
export async function appendAgentLongTermMemory(agentId, { task, output, timestamp }) {
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  const ts = timestamp || new Date().toISOString().slice(0, 16).replace("T", " ");
  const summary = String(output || "").slice(0, 500).replace(/\n+/g, " ").trim();
  const newEntry = `## Run: ${ts} | Task: ${String(task).slice(0, 120)}\n**Summary:** ${summary}${output.length > 500 ? "…" : ""}`;

  const existing = await readAgentLongTermMemory(agentId);
  const entries = existing ? parseLtmEntries(existing.replace(/^# .*\n/, "")) : [];
  entries.push(newEntry);

  await fs.writeFile(agentMemoryPath(agentId), serializeLtm(agentId, entries), "utf-8");
}

/**
 * Prune agent memory to keep only the most recent `maxEntries` entries.
 * @param {string} agentId
 * @param {number} [maxEntries=8]
 * @returns {Promise<void>}
 */
export async function pruneAgentMemory(agentId, maxEntries = 8) {
  const raw = await readAgentLongTermMemory(agentId);
  if (!raw) return;
  const entries = parseLtmEntries(raw.replace(/^# .*\n/, ""));
  if (entries.length <= maxEntries) return;
  const pruned = entries.slice(entries.length - maxEntries);
  await fs.writeFile(agentMemoryPath(agentId), serializeLtm(agentId, pruned), "utf-8");
}

/**
 * Clear an agent's long-term memory file (reset to empty).
 * @param {string} agentId
 * @returns {Promise<void>}
 */
export async function clearAgentMemory(agentId) {
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  await fs.writeFile(agentMemoryPath(agentId), serializeLtm(agentId, []), "utf-8");
}

/**
 * Get the number of entries in an agent's long-term memory.
 * @param {string} agentId
 * @returns {Promise<number>}
 */
export async function getAgentMemoryStats(agentId) {
  const raw = await readAgentLongTermMemory(agentId);
  if (!raw) return 0;
  return parseLtmEntries(raw.replace(/^# .*\n/, "")).length;
}

export { MEMORY_PATH };
