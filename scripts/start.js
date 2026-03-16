#!/usr/bin/env node
/**
 * Launcher for npm start / npm start relay.
 * - npm start          → main Dominions server (server.js)
 * - npm start relay    → browser relay (browser-relay/server.js)
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const runRelay = process.argv[2] === "relay";
const script = runRelay ? "browser-relay/server.js" : "server.js";

const child = spawn("node", [script], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

child.on("error", (err) => {
  console.error(runRelay ? "[relay]" : "[server]", err.message);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
