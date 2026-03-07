/**
 * Minions module — registry and config for pipeline agents.
 * Config file: minions/config.json
 */
export {
  CONFIG_PATH,
  getMinions,
  getMinion,
  addMinion,
  updateMinion,
  removeMinion,
} from "./registry.js";
