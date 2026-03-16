import fs from "fs/promises";
import path from "path";
import { getModuleDir } from "./utils/getModuleDir.js";
import { EventEmitter } from "events";
import * as memoryManager from "./memoryManager.js";
import * as skillsManager from "./skillsManager.js";
import * as minionRegistry from "./minions/index.js";
import * as llm from "./llm.js";
import { getConfig } from "./configManager.js";

const __dirname = getModuleDir(import.meta.url);
const LAST_RESULTS_FILE = path.join(__dirname, "last-results.json");

/**
 * Pipeline event bus.
 * Events:
 *   pipeline:start  { runId, task, total }
 *   agent:start     { runId, id, name, index, total }
 *   agent:result    { runId, id, name, output, index, total }
 *   pipeline:done   { runId, task, results, completedAt }
 *   pipeline:error  { runId, error }
 */
export const pipelineEvents = new EventEmitter();
pipelineEvents.setMaxListeners(50);

async function saveLastResults(task, results) {
  try {
    await fs.writeFile(
      LAST_RESULTS_FILE,
      JSON.stringify({ task, results, completedAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );
  } catch { /* non-fatal — UI still works via memory */ }
}

export async function saveResults(task, results) {
  return saveLastResults(task, results);
}

export async function getLastResults() {
  try {
    const raw = await fs.readFile(LAST_RESULTS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Agent Manager — menjalankan pipeline minion dinamis (urutan dari minions/config.json).
 * Setiap minion memanggil OpenRouter dengan systemPrompt + konteks; hasil disimpan ke memory.
 */

/**
 * Parse HANDOFF: {...} from agent output. Returns null if not found or invalid.
 */
function parseHandoff(output) {
  if (typeof output !== "string") return null;
  const idx = output.indexOf("HANDOFF:");
  if (idx === -1) return null;
  const after = output.slice(idx + "HANDOFF:".length).trim();
  try {
    return JSON.parse(after);
  } catch {
    const match = after.match(/\{[\s\S]*\}/);
    if (match) try { return JSON.parse(match[0]); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Run pipeline: untuk setiap minion (urut order), panggil LLM, simpan ke memory.
 * Semua agent bisa saling komunikasi lewat HANDOFF (baca/tulis di konteks).
 * @param {string} task
 * @returns {Promise<{ results: Record<string, string>; shared: object[]; handoff: object }>}
 */
export async function runPipeline(task) {
  if (!llm.isConfigured()) {
    const prov = (process.env.LLM_PROVIDER || "").toLowerCase();
    const hint = prov === "openrouter"
      ? "LLM_PROVIDER=openrouter tapi OPENROUTER_API_KEY tidak diset atau kosong."
      : prov === "ollama"
        ? "LLM_PROVIDER=ollama tapi OLLAMA_BASE_URL tidak diset."
        : "Set OPENROUTER_API_KEY (OpenRouter) atau OLLAMA_BASE_URL + LLM_PROVIDER=ollama (Ollama).";
    throw new Error(hint);
  }

  const allMinions = await minionRegistry.getMinions();
  const minions = allMinions.filter((m) => m.active !== false);
  if (minions.length === 0) {
    throw new Error("No active agents. Enable at least one agent via the Minions tab (toggle switch) or add minions.");
  }

  const runId = Date.now().toString(36);
  const total = minions.length;

  pipelineEvents.emit("pipeline:start", { runId, task, total });

  await memoryManager.appendShared(`[Task] ${task}`);

  const config = await getConfig();
  const maxTokens = config.maxTokens;

  const results = {};
  let contextForNext = `Task: ${task}\n\n`;
  /** Shared handoff: setiap agent bisa baca pesan dari agent lain dan mengirim pesan (HANDOFF: {...}). */
  const handoff = { messages: [] };

  try {
    for (let index = 0; index < minions.length; index++) {
      const minion = minions[index];

      pipelineEvents.emit("agent:start", { runId, id: minion.id, name: minion.name, index, total });

      await memoryManager.appendToRole(minion.id, `Input: ${contextForNext.slice(0, 300)}...`);

      // Long-term memory: inject past runs context for this agent
      const ltm = await memoryManager.readAgentLongTermMemory(minion.id);
      const memoryBlock = ltm.trim()
        ? "\n\n[LONG-TERM MEMORY — past runs]\n" + ltm.trim() + "\n"
        : "";

      // Skill knowledge: inject accumulated expertise for this agent's skills
      const skillKnowledge = await skillsManager.getSkillKnowledge(minion.id, minion.skills || []);
      const skillsBlock = skillKnowledge
        ? "\n\n[SKILL KNOWLEDGE]\n" + skillKnowledge + "\n"
        : "";

      // Only append handoff block (inter-agent messages) which is separate metadata.
      const handoffBlock = handoff.messages.length > 0
        ? "\n\n[HANDOFF — pesan antar agent]\n" + JSON.stringify(handoff, null, 2) + "\n\n"
        : "";
      const userContent = contextForNext + handoffBlock + memoryBlock + skillsBlock;

      const output = await llm.complete(
        userContent,
        minion.systemPrompt,
        { model: minion.model, maxTokens }
      );

      const text = output || "(No output)";
      results[minion.id] = text;
      contextForNext = contextForNext + "\n\n[" + minion.id + "]:\n" + text + "\n\n";

      const handoffPayload = parseHandoff(text);
      if (handoffPayload && typeof handoffPayload === "object") {
        handoff.messages.push({ from: minion.id, at: new Date().toISOString(), ...handoffPayload });
      }

      await memoryManager.appendToRole(minion.id, text);

      // Persist long-term memory and update skill knowledge (non-fatal)
      await memoryManager.appendAgentLongTermMemory(minion.id, { task, output: text }).catch(() => {});
      await memoryManager.pruneAgentMemory(minion.id, 8).catch(() => {});
      await skillsManager.updateSkillKnowledge(minion.id, minion.skills || [], text).catch(() => {});

      pipelineEvents.emit("agent:result", { runId, id: minion.id, name: minion.name, output: text, index, total });
    }
  } catch (err) {
    pipelineEvents.emit("pipeline:error", { runId, error: err.message || String(err) });
    throw err;
  }

  const completedAt = new Date().toISOString();
  await saveLastResults(task, results);
  pipelineEvents.emit("pipeline:done", { runId, task, results, completedAt, handoff });

  return {
    results,
    shared: await memoryManager.getMemory("shared"),
    handoff,
  };
}

export async function getMemory(role = null) {
  return memoryManager.getMemory(role);
}

export async function clearMemory(role = null) {
  return memoryManager.clearMemory(role);
}

export async function getMinions() {
  return minionRegistry.getMinions();
}

export async function addMinion(minion) {
  return minionRegistry.addMinion(minion);
}

export async function updateMinion(id, updates) {
  return minionRegistry.updateMinion(id, updates);
}

export async function removeMinion(id) {
  return minionRegistry.removeMinion(id);
}
