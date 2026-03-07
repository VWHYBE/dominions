import fs from "fs/promises";
import path from "path";

/**
 * Local tools callable by minions (no external services).
 * All paths are resolved relative to process.cwd() or given basePath.
 */

/**
 * Read file contents.
 * @param {string} filePath - Path relative to basePath or absolute
 * @param {string} [basePath] - Base directory (default: process.cwd())
 * @returns {Promise<{ ok: boolean; content?: string; error?: string }>}
 */
export async function readFile(filePath, basePath = process.cwd()) {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(basePath, filePath);
    const content = await fs.readFile(resolved, "utf-8");
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Write content to file.
 * @param {string} filePath
 * @param {string} content
 * @param {string} [basePath]
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
export async function writeFile(filePath, content, basePath = process.cwd()) {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(basePath, filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * List entries in a directory (names only, no recursion).
 * @param {string} dirPath
 * @param {string} [basePath]
 * @returns {Promise<{ ok: boolean; entries?: string[]; error?: string }>}
 */
export async function listDir(dirPath = ".", basePath = process.cwd()) {
  try {
    const resolved = path.isAbsolute(dirPath) ? dirPath : path.join(basePath, dirPath);
    const entries = await fs.readdir(resolved);
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Tool registry for minions: name -> async function.
 * Each tool receives (args: object) and returns a result object.
 */
export const tools = {
  read_file: async (args) => {
    const { path: filePath, basePath } = args || {};
    if (!filePath || typeof filePath !== "string") {
      return { ok: false, error: "path is required" };
    }
    return readFile(filePath, basePath);
  },
  write_file: async (args) => {
    const { path: filePath, content, basePath } = args || {};
    if (!filePath || typeof filePath !== "string") {
      return { ok: false, error: "path is required" };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "content is required (string)" };
    }
    return writeFile(filePath, content, basePath);
  },
  list_folder: async (args) => {
    const { path: dirPath = ".", basePath } = args || {};
    return listDir(dirPath, basePath);
  },
};

/**
 * Run a tool by name with given args.
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<unknown>}
 */
export async function runTool(name, args) {
  const fn = tools[name];
  if (!fn) {
    return { ok: false, error: `Unknown tool: ${name}. Available: ${Object.keys(tools).join(", ")}` };
  }
  return fn(args);
}
