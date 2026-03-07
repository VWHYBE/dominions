/**
 * Resolve the directory of the current ES module (replaces repeated fileURLToPath + dirname).
 * @param {string} importMetaUrl - pass import.meta.url from the calling module
 * @returns {string} absolute path to the directory containing the calling module
 */
import path from "path";
import { fileURLToPath } from "url";

export function getModuleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}
