#!/usr/bin/env node
/**
 * Start Browser Relay + Dominions server together.
 * Use: npm run start:all
 * Relay must be running for browser_task_cdp and for the extension WebSocket (ws://127.0.0.1:18792/).
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const relay = spawn("node", ["browser-relay/server.js"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

relay.on("error", (err) => {
  console.error("[start:all] Failed to start relay:", err.message);
  process.exit(1);
});

relay.on("exit", (code) => {
  if (code !== 0 && code !== null) process.exit(code);
});

const server = spawn("node", ["server.js"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

server.on("error", (err) => {
  console.error("[start:all] Failed to start server:", err.message);
  relay.kill();
  process.exit(1);
});

function shutdown() {
  relay.kill();
  server.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
