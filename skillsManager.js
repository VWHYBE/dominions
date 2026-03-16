import fs from "fs/promises";
import path from "path";
import { getModuleDir } from "./utils/getModuleDir.js";

const __dirname = getModuleDir(import.meta.url);
const AGENTS_DIR = path.join(__dirname, "agents");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function agentSkillsDir(agentId) {
  return path.join(AGENTS_DIR, agentId, "skills");
}

function skillFilePath(agentId, skill) {
  return path.join(agentSkillsDir(agentId), `${skill}.md`);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Extract bullet-point learnings from agent output text.
 * Heuristic: grab lines starting with - or * or numbered, plus the first
 * meaningful sentence that contains keywords matching the skill name.
 * @param {string} output
 * @param {string} skill
 * @returns {string[]}
 */
function extractLearnings(output, skill) {
  if (!output || typeof output !== "string") return [];

  const lines = output.split("\n");
  const learnings = new Set();
  const skillKeywords = skill.toLowerCase().replace(/-/g, " ").split(" ");

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.length < 20 || line.length > 300) continue;

    // Bullet / numbered lines
    const isBullet = /^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
    // Lines containing skill keywords
    const hasKeyword = skillKeywords.some((kw) =>
      kw.length > 2 && line.toLowerCase().includes(kw)
    );

    if (isBullet || hasKeyword) {
      // Strip markdown formatting for storage
      const clean = line
        .replace(/^[-*•\d.)\s]+/, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .trim();
      if (clean.length >= 20) learnings.add(clean);
    }
  }

  // Return at most 5 learnings per run to keep files lean
  return [...learnings].slice(0, 5);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read skill knowledge file for a given agent + skill.
 * Returns empty string if file doesn't exist yet.
 * @param {string} agentId
 * @param {string} skill
 * @returns {Promise<string>}
 */
export async function readSkillKnowledge(agentId, skill) {
  try {
    return await fs.readFile(skillFilePath(agentId, skill), "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Get combined skill knowledge block for all skills of an agent.
 * Returns a formatted string ready to inject into LLM context, or "" if none.
 * @param {string} agentId
 * @param {string[]} skills
 * @returns {Promise<string>}
 */
export async function getSkillKnowledge(agentId, skills) {
  if (!Array.isArray(skills) || skills.length === 0) return "";

  const blocks = [];
  for (const skill of skills) {
    const content = await readSkillKnowledge(agentId, skill);
    if (content.trim()) {
      blocks.push(`### ${skill}\n${content.trim()}`);
    }
  }

  return blocks.length > 0 ? blocks.join("\n\n") : "";
}

/**
 * Extract learnings from agent output and append to each relevant skill file.
 * @param {string} agentId
 * @param {string[]} skills
 * @param {string} output
 * @returns {Promise<void>}
 */
export async function updateSkillKnowledge(agentId, skills, output) {
  if (!Array.isArray(skills) || skills.length === 0) return;

  await ensureDir(agentSkillsDir(agentId));
  const timestamp = new Date().toISOString().slice(0, 10);

  for (const skill of skills) {
    const learnings = extractLearnings(output, skill);
    if (learnings.length === 0) continue;

    const filePath = skillFilePath(agentId, skill);
    const lines = learnings.map((l) => `- [${timestamp}] ${l}`).join("\n");

    let existing = "";
    try {
      existing = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // New file: write header
      existing = `# ${skill} — ${agentId} Skill Knowledge\n## Learned Patterns\n`;
    }

    await fs.writeFile(filePath, existing.trimEnd() + "\n" + lines + "\n", "utf-8");
  }
}

/**
 * Get stats for all skills of an agent.
 * @param {string} agentId
 * @param {string[]} skills
 * @returns {Promise<Array<{ skill: string; entries: number; lastUpdated: string|null; hasKnowledge: boolean }>>}
 */
export async function listAgentSkills(agentId, skills) {
  if (!Array.isArray(skills)) return [];

  return Promise.all(
    skills.map(async (skill) => {
      const filePath = skillFilePath(agentId, skill);
      try {
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, "utf-8");
        const entries = (content.match(/^- \[/gm) || []).length;
        return {
          skill,
          entries,
          lastUpdated: stat.mtime.toISOString(),
          hasKnowledge: entries > 0,
        };
      } catch {
        return { skill, entries: 0, lastUpdated: null, hasKnowledge: false };
      }
    })
  );
}

/**
 * Clear all skill knowledge files for an agent.
 * @param {string} agentId
 * @returns {Promise<void>}
 */
export async function clearAgentSkills(agentId) {
  const dir = agentSkillsDir(agentId);
  try {
    const files = await fs.readdir(dir);
    await Promise.all(
      files
        .filter((f) => f.endsWith(".md"))
        .map((f) => fs.unlink(path.join(dir, f)))
    );
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
