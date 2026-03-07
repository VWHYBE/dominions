#!/usr/bin/env node
/**
 * Diagnose Ollama connectivity from WSL2.
 * Tries localhost and the Windows host gateway IP.
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (dotenv may not be available here as a bare script)
function loadEnv() {
  try {
    const raw = readFileSync(resolve(__dirname, "../.env"), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env — use process.env as-is */ }
}

function getWindowsHostIP() {
  // Default gateway in WSL2 is usually the Windows host
  try {
    const route = execSync("ip route show default 2>/dev/null", { encoding: "utf-8" });
    const match = route.match(/via\s+([\d.]+)/);
    if (match) return match[1];
  } catch { /* ignore */ }
  // Fallback: first nameserver in resolv.conf (sometimes the host)
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf-8");
    const match = resolv.match(/nameserver\s+([\d.]+)/);
    if (match && !match[1].startsWith("127.")) return match[1];
  } catch { /* ignore */ }
  return "172.30.16.1";
}

async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  }
}

loadEnv();

const windowsHostIp = getWindowsHostIP();
const envBase       = (process.env.OLLAMA_BASE_URL || "").replace(/\/$/, "");
const envModel      = process.env.OLLAMA_MODEL || "llama3.2";
const provider      = (process.env.LLM_PROVIDER || "").toLowerCase();

const candidates = [
  ...(envBase ? [{ label: ".env OLLAMA_BASE_URL", url: envBase }] : []),
  { label: "localhost",          url: "http://localhost:11434" },
  { label: `Windows host (${windowsHostIp})`, url: `http://${windowsHostIp}:11434` },
];

console.log("═══════════════════════════════════════════");
console.log("  DOMINIONS — Ollama Connectivity Check");
console.log("═══════════════════════════════════════════");
console.log(`  LLM_PROVIDER   : ${provider || "(not set)"}`);
console.log(`  OLLAMA_BASE_URL: ${envBase || "(using default)"}`);
console.log(`  OLLAMA_MODEL   : ${envModel}`);
console.log(`  Windows host IP: ${windowsHostIp}`);
console.log("───────────────────────────────────────────");

let found = null;

for (const { label, url } of candidates) {
  process.stdout.write(`  Trying ${label} (${url})... `);
  const result = await checkUrl(url);
  if (result.ok) {
    console.log("✅ REACHABLE");
    if (result.models.length > 0) {
      console.log(`     Models: ${result.models.join(", ")}`);
      const modelOk = result.models.some((m) => m === envModel || m.startsWith(envModel.split(":")[0]));
      if (!modelOk) {
        console.log(`  ⚠️  OLLAMA_MODEL="${envModel}" not found — run: ollama pull ${envModel}`);
        console.log(`     Available: ${result.models.join(", ")}`);
      } else {
        console.log(`     ✅ Model "${envModel}" found`);
      }
    } else {
      console.log(`  ⚠️  No models pulled yet. Run: ollama pull ${envModel}`);
    }
    found = url;
    break;
  } else {
    console.log(`❌ ${result.error}`);
  }
}

console.log("───────────────────────────────────────────");

if (!found) {
  console.log("\n  ❌ Ollama is not reachable from WSL2.\n");
  console.log("  You are running WSL2. Ollama runs on Windows and by default");
  console.log("  binds only to Windows loopback (127.0.0.1), which is NOT");
  console.log("  accessible from inside WSL2.\n");
  console.log("  ── FIX (Windows side) ──────────────────────────────────────");
  console.log("  1. Stop Ollama (tray icon → Quit, or kill the process).");
  console.log("  2. Open PowerShell or CMD:");
  console.log("       $env:OLLAMA_HOST = \"0.0.0.0\"");
  console.log("       ollama serve");
  console.log("     Or set a permanent Windows env var OLLAMA_HOST=0.0.0.0");
  console.log("     then restart Ollama from the Start Menu.");
  console.log("");
  console.log("  ── FIX (.env in WSL) ───────────────────────────────────────");
  console.log(`  Set OLLAMA_BASE_URL=http://${windowsHostIp}:11434`);
  console.log(`  (Current .env: OLLAMA_BASE_URL=${envBase || "not set"})`);
  console.log("");
  console.log("  Then run this check again: npm run check:ollama");
} else if (found !== envBase && envBase !== found) {
  console.log(`\n  💡 Update your .env:`);
  console.log(`     OLLAMA_BASE_URL=${found}`);
} else {
  console.log("\n  ✅ Ollama is correctly configured. You can run: npm start");
}
console.log("═══════════════════════════════════════════\n");
