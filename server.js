import "dotenv/config";
import express from "express";

// Prevent Playwright's internal CDP assertion errors from crashing the server.
// These surface as uncaught exceptions when the CDP relay forwards events that
// contain session IDs Playwright didn't create (e.g. extension sub-sessions).
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception (suppressed crash):", err.message);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[server] Unhandled rejection (suppressed crash):", msg);
});
import path from "path";
import { fileURLToPath } from "url";
import os from "node:os";
import fs from "fs/promises";
import { spawn } from "child_process";
import {
  runPipeline,
  getMemory,
  clearMemory,
  getMinions,
  addMinion,
  updateMinion,
  removeMinion,
  getLastResults,
  saveResults,
  pipelineEvents,
} from "./agentManager.js";
import { getConfig, updateConfig } from "./configManager.js";
import { getProviderName, isConfigured as llmConfigured } from "./llm.js";
import * as memoryManagerDirect from "./memoryManager.js";
import * as skillsManager from "./skillsManager.js";
import { scrapePage } from "./services/pageScraper.js";
import { extractSections } from "./services/sectionExtractor.js";
import { executeHandoff } from "./services/executor.js";
import * as browserRelay from "./services/browserRelayClient.js";
import { runTask as runBrowserTask } from "./services/browserTaskRunner.js";
import { runCdpTask } from "./services/browserCdpRunner.js";
import * as deviceBridge from "./services/deviceBridge.js";
import * as mobileWebRunner from "./services/mobileWebRunner.js";

// ─── SSE client registry ───────────────────────────────────────────────────
const sseClients = new Set();

// ─── In-memory store for active MCP pipeline runs ──────────────────────────
const mcpRuns = new Map();

function broadcast(event, data) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

/** Extract first HTML document from pipeline results (e.g. Coder or UI/UX output with ```html ... ``` or raw HTML). Prefers ui-ux minion output when it contains HTML. */
function extractHtmlFromResults(results) {
  if (!results || typeof results !== "object") return null;
  const pickHtml = (s) => {
    if (typeof s !== "string") s = String(s);
    const trimmed = s.trim();
    if (!trimmed.includes("<!DOCTYPE") && !trimmed.includes("<html")) return null;
    const codeBlock = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (codeBlock) return codeBlock[1].trim();
    const start = Math.min(
      trimmed.indexOf("<!DOCTYPE") >= 0 ? trimmed.indexOf("<!DOCTYPE") : Infinity,
      trimmed.indexOf("<html") >= 0 ? trimmed.indexOf("<html") : Infinity
    );
    if (start !== Infinity) return trimmed.slice(start);
    return trimmed;
  };
  if (results["ui-ux"]) {
    const html = pickHtml(results["ui-ux"]);
    if (html) return html;
  }
  for (const output of Object.values(results)) {
    const html = pickHtml(output);
    if (html) return html;
  }
  return null;
}

const IMAGE_DATA_URL_RE = /data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/g;
const VIDEO_DATA_URL_RE = /data:video\/(mp4|webm);base64,([A-Za-z0-9+/=]+)/g;
const CODE_BLOCK_RE = /```(\w+)?\s*([\s\S]*?)```/g;

const LANG_TO_EXT = {
  js: "js", javascript: "js", ts: "ts", typescript: "ts",
  batch: "bat", bat: "bat", sh: "sh", bash: "sh", shell: "sh",
  ps1: "ps1", powershell: "ps1", py: "py", python: "py",
  html: "html", css: "css", json: "json", md: "md", markdown: "md",
  txt: "txt", text: "txt",
};
const EXECUTABLE_EXTENSIONS = new Set(["bat", "sh", "ps1", "js", "py"]);
const MAX_CODE_FILES = 20;
const EXEC_TIMEOUT_MS = 30000;

function concatResults(results) {
  if (!results || typeof results !== "object") return "";
  return Object.values(results).map((v) => (typeof v === "string" ? v : String(v))).join("\n\n");
}

/** Extract first image (data URL) from results. Returns { mime, buffer } or null. */
function extractImageFromResults(results) {
  const text = concatResults(results);
  const match = IMAGE_DATA_URL_RE.exec(text);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  try {
    const buffer = Buffer.from(base64, "base64");
    return { mime, buffer };
  } catch {
    return null;
  }
}

/** Extract first video (data URL) from results. Returns { mime, buffer } or null. */
function extractVideoFromResults(results) {
  const text = concatResults(results);
  const match = VIDEO_DATA_URL_RE.exec(text);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  try {
    const buffer = Buffer.from(base64, "base64");
    return { mime, buffer };
  } catch {
    return null;
  }
}

/** Extract all code blocks from results. Returns [{ lang, content, ext }]. Skips HTML-only blocks when used for code preview. */
function extractAllCodeBlocksFromResults(results) {
  const text = concatResults(results);
  const blocks = [];
  let m;
  CODE_BLOCK_RE.lastIndex = 0;
  while ((m = CODE_BLOCK_RE.exec(text)) !== null && blocks.length < MAX_CODE_FILES) {
    const lang = (m[1] || "").toLowerCase().trim();
    const content = (m[2] || "").trim();
    if (!content) continue;
    const ext = LANG_TO_EXT[lang] || "txt";
    const isHtml = ext === "html" && (content.includes("<!DOCTYPE") || content.includes("<html"));
    if (isHtml) continue;
    blocks.push({ lang: lang || "txt", content, ext });
  }
  return blocks;
}

/** Build minimal HTML wrapper that displays an image. */
function buildWrapperHtmlImage(srcPath) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview</title></head><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;"><img src="${srcPath}" style="max-width:100%;height:auto;" alt="Preview"></body></html>`;
}

/** Build minimal HTML wrapper that displays a video. */
function buildWrapperHtmlVideo(srcPath) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview</title></head><body style="margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;"><video src="${srcPath}" controls style="max-width:100%;"></video></body></html>`;
}

/** Build HTML wrapper for code: tabs, syntax highlight, Run buttons, terminal output. */
function buildWrapperHtmlCode(manifest) {
  const items = manifest.map((item, i) => ({
    ...item,
    id: "code-" + i,
  }));
  const list = items.map((item) => `<li><a href="#${item.id}" data-file="${item.file}" data-executable="${item.executable}">${item.file}</a></li>`).join("");
  const panels = items.map((item) => `
    <div id="${item.id}" class="code-panel" data-file="${item.file}">
      <div class="code-header">
        <span>${item.file}</span>
        ${item.executable ? `<button type="button" class="run-btn" data-file="${item.file}">Run</button>` : ""}
      </div>
      <pre><code class="language-${item.lang}"></code></pre>
      ${item.executable ? `<pre class="terminal-output" aria-live="polite"></pre>` : ""}
    </div>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Code preview</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/tokyo-night-dark.min.css" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; }
    .tabs { display: flex; gap: 0; padding: 0 12px; background: #16213e; overflow-x: auto; }
    .tabs a { padding: 10px 14px; color: #a0a0a0; text-decoration: none; white-space: nowrap; }
    .tabs a:hover, .tabs a.active { color: #fff; background: #0f3460; }
    .code-panel { display: none; padding: 12px; }
    .code-panel.active { display: block; }
    .code-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .run-btn { padding: 6px 12px; background: #e94560; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    .run-btn:hover { background: #c73e54; }
    .run-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    pre { margin: 0; overflow: auto; font-size: 13px; }
    pre.terminal-output { background: #0d0d0d; padding: 10px; margin-top: 8px; border-radius: 4px; min-height: 60px; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <nav class="tabs" id="tabs">${list}</nav>
  <div id="panels">${panels}</div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
  <script>
    const manifest = ${JSON.stringify(manifest)};
    const panels = document.querySelectorAll(".code-panel");
    const tabs = document.getElementById("tabs");
    tabs.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      if (!a) return;
      e.preventDefault();
      const id = a.getAttribute("href").slice(1);
      panels.forEach((p) => p.classList.toggle("active", p.id === id));
      document.querySelectorAll(".tabs a").forEach((x) => x.classList.toggle("active", x === a));
    });
    document.querySelector(".code-panel").classList.add("active");
    document.querySelector(".tabs a").classList.add("active");
    (async function loadCode() {
      for (const p of panels) {
        const file = p.dataset.file;
        const res = await fetch("/result/" + file);
        const text = await res.text();
        const code = p.querySelector("code");
        code.textContent = text;
        if (window.hljs) hljs.highlightElement(code);
      }
    })();
    document.getElementById("panels").addEventListener("click", async (e) => {
      const btn = e.target.closest(".run-btn");
      if (!btn) return;
      const file = btn.dataset.file;
      const panel = btn.closest(".code-panel");
      const out = panel.querySelector(".terminal-output");
      if (!out) return;
      btn.disabled = true;
      out.textContent = "Running...";
      try {
        const res = await fetch("/api/result/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file }) });
        const data = await res.json();
        if (data.ok) {
          out.textContent = (data.stdout || "") + (data.stderr ? "\\nSTDERR:\\n" + data.stderr : "") || "(no output)";
        } else {
          out.textContent = "Error: " + (data.error || data.stderr || "Unknown");
        }
      } catch (err) {
        out.textContent = "Error: " + err.message;
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;
}

/** Write pipeline result to result/ for BROWSER panel. Tries HTML → image → video → all code blocks. Returns true if any preview was saved. */
async function extractAndSavePreview(results, __dir) {
  const resultDir = path.join(__dir, "result");
  await fs.mkdir(resultDir, { recursive: true });

  const html = extractHtmlFromResults(results);
  if (html) {
    const previewFile = path.join(resultDir, "preview.html");
    await fs.writeFile(previewFile, html, "utf-8");
    return true;
  }

  const image = extractImageFromResults(results);
  if (image) {
    const ext = image.mime === "jpeg" || image.mime === "jpg" ? "jpg" : image.mime;
    const imagePath = path.join(resultDir, "preview." + ext);
    await fs.writeFile(imagePath, image.buffer);
    const wrapper = buildWrapperHtmlImage("/result/preview." + ext);
    await fs.writeFile(path.join(resultDir, "preview.html"), wrapper, "utf-8");
    return true;
  }

  const video = extractVideoFromResults(results);
  if (video) {
    const videoPath = path.join(resultDir, "preview." + video.mime);
    await fs.writeFile(videoPath, video.buffer);
    const wrapper = buildWrapperHtmlVideo("/result/preview." + video.mime);
    await fs.writeFile(path.join(resultDir, "preview.html"), wrapper, "utf-8");
    return true;
  }

  const blocks = extractAllCodeBlocksFromResults(results);
  if (blocks.length > 0) {
    const manifest = [];
    for (let i = 0; i < blocks.length; i++) {
      const { ext, content } = blocks[i];
      const fileName = "preview-code-" + (i + 1) + "." + ext;
      const filePath = path.join(resultDir, fileName);
      await fs.writeFile(filePath, content, "utf-8");
      manifest.push({
        file: fileName,
        lang: blocks[i].lang,
        executable: EXECUTABLE_EXTENSIONS.has(ext),
      });
    }
    await fs.writeFile(path.join(resultDir, "preview-manifest.json"), JSON.stringify(manifest), "utf-8");
    const wrapper = buildWrapperHtmlCode(manifest);
    await fs.writeFile(path.join(resultDir, "preview.html"), wrapper, "utf-8");
    return true;
  }

  return false;
}

pipelineEvents.on("pipeline:start",  (d) => broadcast("pipeline:start",  { ...d, source: "task" }));
pipelineEvents.on("agent:start",     (d) => broadcast("agent:start",     { ...d, source: "task" }));
pipelineEvents.on("agent:result",    (d) => broadcast("agent:result",    { ...d, source: "task" }));
pipelineEvents.on("pipeline:done",   async (d) => {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const saved = await extractAndSavePreview(d.results, __dir);
  broadcast("pipeline:done", { ...d, source: "task", ...(saved ? { previewUrl: "/preview" } : {}) });
});
pipelineEvents.on("pipeline:error",   (d) => broadcast("pipeline:error",  { ...d, source: "task" }));

const VALID_BUDGETS = ["free", "min", "mid", "max"];
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 128000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_ATTEMPTS = 100;

app.use(express.json());

/** Serve result folder first so /result/* is not caught by frontend static. */
app.use("/result", express.static(path.join(__dirname, "result"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    }
  },
}));

app.use(express.static(path.join(__dirname, "frontend")));

/** GET /preview — serve last pipeline result as HTML for BROWSER panel (e.g. landing page from MCP). */
app.get("/preview", async (_req, res) => {
  const previewFile = path.join(__dirname, "result", "preview.html");
  try {
    const html = await fs.readFile(previewFile, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).setHeader("Content-Type", "text/html").send(
        "<!DOCTYPE html><html><head><meta charset='utf-8'><title>No preview</title></head><body><p>No pipeline preview yet. Run a pipeline that produces HTML (e.g. landing page).</p></body></html>"
      );
      return;
    }
    res.status(500).send("Preview error");
  }
});

/** GET /result/:name — serve HTML from result folder (e.g. /result/landing-bahaya-narkoba.html). */
app.get("/result/:name", (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+\.html$/i.test(name)) {
    return res.status(400).send("Only .html files allowed");
  }
  const filePath = path.join(__dirname, "result", name);
  if (!path.resolve(filePath).startsWith(path.resolve(path.join(__dirname, "result")))) {
    return res.status(403).send("Forbidden");
  }
  res.sendFile(filePath, { headers: { "Content-Type": "text/html; charset=utf-8" } }, (err) => {
    if (err && err.code === "ENOENT") res.status(404).send("Not found");
    else if (err) res.status(500).send("Error");
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.post("/api/run", async (req, res) => {
  const task = req.body?.task;
  if (typeof task !== "string" || !task.trim()) {
    return res.status(400).json({ error: "task is required (non-empty string)" });
  }
  try {
    const result = await runPipeline(task.trim());
    return res.json({ ok: true, results: result.results, handoff: result.handoff });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

// ─── Run pipeline with URL: scrape → AI extract sections → pipeline ───────

/** Infer section preference from task text for autonomous click (e.g. "VIP A", "vip-a"). */
function inferSectionFromTask(task) {
  if (typeof task !== "string" || !task.trim()) return {};
  const t = task.trim().toLowerCase();
  const rules = [
    { pattern: /\bvip\s*a\b|\bvip-a\b/, clickSectionLabel: "VIP A" },
    { pattern: /\bvip\s*b\b|\bvip-b\b/, clickSectionLabel: "VIP B" },
    { pattern: /\btreasure\s*box\b/, clickSectionId: "treasure-box-seating" },
    { pattern: /\bcat\s*1\s*a\b|\bcat-1a\b/, clickSectionId: "cat-1a" },
    { pattern: /\bcat\s*1\s*b\b|\bcat-1b\b/, clickSectionId: "cat-1b" },
    { pattern: /\bcat\s*1\s*c\b|\bcat-1c\b/, clickSectionId: "cat-1c" },
    { pattern: /\bcat\s*2\b|\bcat-2\b/, clickSectionId: "cat-2" },
    { pattern: /\bcat\s*3\s*a\b|\bcat-3a\b/, clickSectionId: "cat-3a" },
    { pattern: /\bcat\s*3\s*b\b|\bcat-3b\b/, clickSectionId: "cat-3b" },
    { pattern: /\brestricted\s*view\s*a\b/, clickSectionId: "restricted-view-a" },
    { pattern: /\brestricted\s*view\s*b\b/, clickSectionId: "restricted-view-b" },
  ];
  for (const { pattern, clickSectionLabel, clickSectionId } of rules) {
    if (pattern.test(t)) return clickSectionLabel ? { clickSectionLabel } : { clickSectionId };
  }
  return {};
}

app.post("/api/run-with-url", async (req, res) => {
  const url = req.body?.url;
  const taskHint = req.body?.task;
  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "url is required (non-empty string)" });
  }
  const trimmedUrl = url.trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return res.status(400).json({ error: "url must start with http:// or https://" });
  }
  try {
    const clickOpts = {};
    if (req.body?.clickFirstButton === true) clickOpts.clickFirstButton = true;
    else if (typeof req.body?.clickButtonIndex === "number") clickOpts.clickButtonIndex = req.body.clickButtonIndex;
    else if (typeof req.body?.clickButtonText === "string" && req.body.clickButtonText.trim()) clickOpts.clickButtonText = req.body.clickButtonText.trim();
    if (typeof req.body?.clickSectionLabel === "string" && req.body.clickSectionLabel.trim()) clickOpts.clickSectionLabel = req.body.clickSectionLabel.trim();
    else if (typeof req.body?.clickSectionId === "string" && req.body.clickSectionId.trim()) clickOpts.clickSectionId = req.body.clickSectionId.trim();
    else {
      const inferred = inferSectionFromTask(taskHint || "");
      if (inferred.clickSectionLabel) clickOpts.clickSectionLabel = inferred.clickSectionLabel;
      else if (inferred.clickSectionId) clickOpts.clickSectionId = inferred.clickSectionId;
    }

    const pageContent = await scrapePage(trimmedUrl, clickOpts);
    const extracted = await extractSections(pageContent, trimmedUrl);
    const payload = {
      url: extracted.url,
      pageTitle: extracted.pageTitle,
      sections: extracted.sections,
      buttons: Array.isArray(pageContent.buttons) ? pageContent.buttons : [],
      pageText: (pageContent.text || "").slice(0, 25000),
    };
    if (clickOpts.clickSectionLabel) payload.userChosenSectionLabel = clickOpts.clickSectionLabel;
    if (clickOpts.clickSectionId) payload.userChosenSectionId = clickOpts.clickSectionId;
    if (pageContent.afterClick) {
      payload.afterClick = {
        clickedButton: pageContent.afterClick.clickedButton,
        url: pageContent.afterClick.url,
        title: pageContent.afterClick.title,
        textSnippet: (pageContent.afterClick.text || "").slice(0, 18000),
        buttons: pageContent.afterClick.buttons || [],
      };
    }
    const task =
      (taskHint && taskHint.trim()) || "Bantu saya pilih paket/section tiket yang sesuai.";
    let fullTask = `${task}\n\nData hasil scan halaman (sections + tombol + isi halaman setelah klik jika ada):\n${JSON.stringify(payload, null, 2)}`;
    if (payload.userChosenSectionLabel || payload.userChosenSectionId) {
      const hint = payload.userChosenSectionLabel || payload.userChosenSectionId;
      fullTask = `PILIHAN SECTION USER (WAJIB DIPAKAI): ${hint}. Section Chooser HARUS set chosen ke id section yang cocok dengan "${hint}", jangan tanya user pilih lagi.\n\n` + fullTask;
    }
    const result = await runPipeline(fullTask);
    const extractedOut = {
      url: payload.url,
      pageTitle: payload.pageTitle,
      sections: payload.sections,
      buttons: payload.buttons,
    };
    if (payload.afterClick) extractedOut.afterClick = payload.afterClick;

    let executedAction = null;
    if (result.handoff?.messages?.length) {
      try {
        const execResult = await executeHandoff(trimmedUrl, result.handoff);
        if (execResult.executed) {
          executedAction = {
            executed: true,
            selector: execResult.selector,
            chosen: execResult.chosen,
            afterClick: execResult.afterClick,
          };
          if (execResult.afterClick) extractedOut.afterClick = execResult.afterClick;
        } else {
          executedAction = { executed: false, error: execResult.error };
        }
      } catch (err) {
        executedAction = { executed: false, error: err?.message || String(err) };
      }
    }

    return res.json({
      ok: true,
      results: result.results,
      extracted: extractedOut,
      handoff: result.handoff,
      executedAction,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

app.get("/api/memory", async (req, res) => {
  const role = req.query.role || null;
  try {
    const data = await getMemory(role || undefined);
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

app.post("/api/memory/clear", async (req, res) => {
  const role = req.body?.role ?? null;
  try {
    await clearMemory(role || undefined);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

// ─── Agent long-term memory endpoints ──────────────────────────────────────

app.get("/api/agents/:id/memory", async (req, res) => {
  try {
    const content = await memoryManagerDirect.readAgentLongTermMemory(req.params.id);
    const entries = await memoryManagerDirect.getAgentMemoryStats(req.params.id);
    return res.json({ ok: true, content, entries });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.delete("/api/agents/:id/memory", async (req, res) => {
  try {
    await memoryManagerDirect.clearAgentMemory(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ─── Agent skills endpoints ─────────────────────────────────────────────────

app.get("/api/agents/:id/skills", async (req, res) => {
  try {
    const minions = await getMinions();
    const minion = minions.find((m) => m.id === req.params.id);
    if (!minion) return res.status(404).json({ ok: false, error: "Agent not found" });
    const skills = await skillsManager.listAgentSkills(req.params.id, minion.skills || []);
    return res.json({ ok: true, skills });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/agents/:id/skills/:skill", async (req, res) => {
  try {
    const content = await skillsManager.readSkillKnowledge(req.params.id, req.params.skill);
    return res.json({ ok: true, skill: req.params.skill, content });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.delete("/api/agents/:id/skills", async (req, res) => {
  try {
    await skillsManager.clearAgentSkills(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/minions", async (_req, res) => {
  try {
    const minions = await getMinions();
    return res.json({ ok: true, minions });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

app.post("/api/minions", async (req, res) => {
  const { id, name, description, systemPrompt, order, model } = req.body || {};
  if (!id || typeof id !== "string" || !id.trim()) {
    return res.status(400).json({ error: "id is required (non-empty string)" });
  }
  if (typeof systemPrompt !== "string") {
    return res.status(400).json({ error: "systemPrompt is required (string)" });
  }
  try {
    const minion = await addMinion({
      id: id.trim(),
      name: name?.trim() || id.trim(),
      description: typeof description === "string" ? description.trim() : undefined,
      systemPrompt,
      order,
      model,
    });
    return res.json({ ok: true, minion });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

app.put("/api/minions/:id", async (req, res) => {
  const { id } = req.params;
  const { name, description, systemPrompt, order, model, active } = req.body || {};
  try {
    const minion = await updateMinion(id, {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(order !== undefined && { order }),
      ...(model !== undefined && { model }),
      ...(active !== undefined && { active: Boolean(active) }),
    });
    if (!minion) return res.status(404).json({ ok: false, error: "Minion not found" });
    return res.json({ ok: true, minion });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

app.delete("/api/minions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const removed = await removeMinion(id);
    if (!removed) return res.status(404).json({ ok: false, error: "Minion not found" });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

// ─── MCP pipeline endpoints (driven by Cursor / VS Code AI) ───────────────

app.post("/api/pipeline/mcp/start", (req, res) => {
  const { runId, task, total } = req.body || {};
  if (!runId || typeof task !== "string" || !task.trim()) {
    return res.status(400).json({ error: "runId and task are required" });
  }
  mcpRuns.set(runId, { task: task.trim(), total: total || 0, results: {} });
  broadcast("pipeline:start", { runId, task: task.trim(), total: total || 0, source: "mcp" });
  return res.json({ ok: true });
});

/** Signal that a specific MCP agent has started processing. */
app.post("/api/pipeline/mcp/agent-start", (req, res) => {
  const { runId, id, name, index, total } = req.body || {};
  if (!runId || !id) return res.status(400).json({ error: "runId and id are required" });
  const run = mcpRuns.get(runId);
  if (!run) return res.status(404).json({ error: "Run not found: " + runId });
  broadcast("agent:start", {
    runId, id, name: name || id,
    index: index ?? 0, total: total ?? run.total, source: "mcp",
  });
  return res.json({ ok: true });
});

/** Stream a partial text chunk for a running MCP agent — broadcasts agent:chunk SSE. */
app.post("/api/pipeline/mcp/chunk", (req, res) => {
  const { runId, id, name, chunk, index, total } = req.body || {};
  if (!runId || !id || chunk === undefined) {
    return res.status(400).json({ error: "runId, id, and chunk are required" });
  }
  const run = mcpRuns.get(runId);
  if (!run) return res.status(404).json({ error: "Run not found: " + runId });
  broadcast("agent:chunk", {
    runId, id, name: name || id, chunk: String(chunk),
    index: index ?? 0, total: total ?? run.total, source: "mcp",
  });
  return res.json({ ok: true });
});

app.post("/api/pipeline/mcp/result", (req, res) => {
  const { runId, id, name, output, index, total } = req.body || {};
  if (!runId || !id) {
    return res.status(400).json({ error: "runId and id are required" });
  }
  const run = mcpRuns.get(runId);
  if (!run) return res.status(404).json({ error: "Run not found: " + runId });

  run.results[id] = output || "";
  broadcast("agent:result", {
    runId,
    id,
    name: name || id,
    output: output || "",
    index: index ?? 0,
    total: total ?? run.total,
    source: "mcp",
  });
  return res.json({ ok: true });
});

app.post("/api/pipeline/mcp/done", async (req, res) => {
  const { runId } = req.body || {};
  if (!runId) return res.status(400).json({ error: "runId is required" });

  const run = mcpRuns.get(runId);
  if (!run) return res.status(404).json({ error: "Run not found: " + runId });

  try {
    const completedAt = new Date().toISOString();
    await saveResults(run.task, run.results);
    const saved = await extractAndSavePreview(run.results, __dirname);
    broadcast("pipeline:done", {
      runId,
      task: run.task,
      results: run.results,
      completedAt,
      source: "mcp",
      ...(saved ? { previewUrl: "/preview" } : {}),
    });
    mcpRuns.delete(runId);
    return res.json({ ok: true, results: run.results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post("/api/pipeline/mcp/error", (req, res) => {
  const { runId, error: errMsg } = req.body || {};
  if (!runId) return res.status(400).json({ error: "runId is required" });

  broadcast("pipeline:error", { runId, error: errMsg || "Unknown error", source: "mcp" });
  mcpRuns.delete(runId);
  return res.json({ ok: true });
});

// ─── Result execute (run code from result/ in BROWSER UI) ───────────────────

const RESULT_EXECUTABLE_EXTS = new Set(["bat", "sh", "ps1", "js", "py"]);
const RESULT_DIR = path.join(__dirname, "result");

function runResultFile(filePath, ext) {
  return new Promise((resolve) => {
    const isWin = os.platform() === "win32";
    let cmd;
    let args;
    if (ext === "bat" && isWin) {
      cmd = "cmd";
      args = ["/c", filePath];
    } else if (ext === "ps1" && isWin) {
      cmd = "powershell";
      args = ["-ExecutionPolicy", "Bypass", "-File", filePath];
    } else if (ext === "sh" || ext === "bash") {
      cmd = "sh";
      args = [filePath];
    } else if (ext === "js") {
      cmd = "node";
      args = [filePath];
    } else if (ext === "py") {
      cmd = "python3";
      args = [filePath];
    } else if (ext === "bat" && !isWin) {
      resolve({
        ok: false,
        error: "File .bat hanya bisa dijalankan di Windows. Di Linux/WSL: jalankan file ini di CMD/PowerShell pada mesin Windows, atau copy result/belajar-berhitung.bat ke Windows lalu double-click.",
        stdout: "",
        stderr: "",
      });
      return;
    } else {
      resolve({ ok: false, error: "Unsupported extension for execution" });
      return;
    }
    const child = spawn(cmd, args, {
      cwd: path.dirname(filePath),
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: stdout.slice(0, 100000),
        stderr: stderr.slice(0, 100000),
        code: code ?? null,
        signal: signal || null,
      });
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch (_) {}
      resolve({
        ok: false,
        error: "Execution timeout",
        stdout: stdout.slice(0, 100000),
        stderr: stderr.slice(0, 100000),
      });
    }, EXEC_TIMEOUT_MS);
  });
}

app.post("/api/result/execute", async (req, res) => {
  const { filename } = req.body || {};
  if (typeof filename !== "string" || !filename.trim()) {
    return res.status(400).json({ error: "filename is required" });
  }
  const base = path.basename(filename);
  if (base !== filename || base.includes("..")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const ext = path.extname(base).toLowerCase().slice(1);
  if (!RESULT_EXECUTABLE_EXTS.has(ext)) {
    return res.status(400).json({ error: "File type not allowed for execution. Allowed: .bat, .sh, .ps1, .js, .py" });
  }
  const filePath = path.join(RESULT_DIR, base);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(RESULT_DIR))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    await fs.access(filePath);
  } catch {
    return res.status(404).json({ error: "File not found" });
  }
  const result = await runResultFile(filePath, ext);
  if (result.error && !result.stdout && !result.stderr) {
    return res.json({ ok: false, error: result.error });
  }
  return res.json({
    ok: result.ok,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || undefined,
    code: result.code,
  });
});

// ─── Browser Relay endpoints ──────────────────────────────────────────────────

app.get("/api/browser/status", async (_req, res) => {
  const data = await browserRelay.status();
  return res.status(data.ok ? 200 : 503).json(data);
});

/** GET /api/browser/current-url — for Desktop/Browser preview panel (iframe source). */
app.get("/api/browser/current-url", async (_req, res) => {
  const statusData = await browserRelay.status();
  if (!statusData.ok || !statusData.extensionConnected) {
    return res.status(200).json({ ok: false, url: null });
  }
  const urlRes = await browserRelay.getUrl();
  const url = urlRes.ok && urlRes.data?.url ? urlRes.data.url : null;
  return res.status(200).json({ ok: !!url, url });
});

// ─── Device Bridge (ADB) endpoints ───────────────────────────────────────────

app.get("/api/device/status", async (_req, res) => {
  try {
    const data = await deviceBridge.status();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, available: false, devices: [], error: err?.message || String(err) });
  }
});

app.get("/api/device/screenshot", async (req, res) => {
  const deviceId = req.query.deviceId || undefined;
  try {
    const result = await deviceBridge.screenshot(deviceId);
    if (!result.ok) {
      return res.status(result.error === "No devices" ? 404 : 503).json({ ok: false, error: result.error });
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    return res.send(result.buffer);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/**
 * POST /api/browser/action
 * body: { action: string, params?: object }
 * Supported actions: navigate, getContent, getText, getUrl, getTitle,
 *                    screenshot, click, type, scroll, evaluate
 */
app.post("/api/browser/action", async (req, res) => {
  const { action, params } = req.body || {};
  if (!action || typeof action !== "string") {
    return res.status(400).json({ ok: false, error: "action (string) is required" });
  }
  const result = await browserRelay[action]
    ? (async () => {
        switch (action) {
          case "navigate":   return browserRelay.navigate(params?.url);
          case "getContent": return browserRelay.getContent();
          case "getText":    return browserRelay.getText();
          case "getUrl":     return browserRelay.getUrl();
          case "getTitle":   return browserRelay.getTitle();
          case "screenshot": return browserRelay.screenshot(params?.format, params?.quality);
          case "click":      return browserRelay.click(params?.selector);
          case "type":       return browserRelay.type(params?.text, params?.selector);
          case "scroll":     return browserRelay.scroll(params?.x, params?.y, params?.selector);
          case "evaluate":   return browserRelay.evaluate(params?.expression, params?.awaitPromise);
          default:           return { ok: false, error: `Unknown action: ${action}` };
        }
      })()
    : Promise.resolve({ ok: false, error: `Unknown action: ${action}` });
  const data = await result;
  return res.status(data.ok ? 200 : 400).json(data);
});

/**
 * POST /api/browser/task
 * body: { perintah: string, maxSteps?: number, simulateTime?: string }
 * simulateTime: optional "HH:mm" or "H.mm" (e.g. "15:51") to simulate current time for ticket war.
 */
app.post("/api/browser/task", async (req, res) => {
  const { perintah, maxSteps, simulateTime } = req.body || {};
  if (!perintah || typeof perintah !== "string" || !perintah.trim()) {
    return res.status(400).json({ ok: false, error: "perintah (non-empty string) is required" });
  }
  try {
    const result = await runBrowserTask(perintah.trim(), { maxSteps, simulateTime });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/**
 * POST /api/browser/cdp-task
 * body: { perintah: string, maxSteps?: number, simulateTime?: string }
 * Uses Playwright connectOverCDP → more robust selector / navigation handling.
 */
app.post("/api/browser/cdp-task", async (req, res) => {
  const { perintah, maxSteps, simulateTime } = req.body || {};
  if (!perintah || typeof perintah !== "string" || !perintah.trim()) {
    return res.status(400).json({ ok: false, error: "perintah (non-empty string) is required" });
  }

  const relayPort = Number(process.env.RELAY_PORT) || 18792;
  const relayHost = process.env.RELAY_HOST || "127.0.0.1";
  const relayStatusUrl = `http://${relayHost}:${relayPort}/status`;

  let relayOk = false;
  try {
    const r = await fetch(relayStatusUrl, { signal: AbortSignal.timeout(2000) });
    relayOk = r.ok;
  } catch (e) {
    const msg = e?.message || String(e);
    const isRefused = msg.includes("ECONNREFUSED") || msg.includes("fetch failed");
    if (isRefused) {
      return res.status(503).json({
        ok: false,
        error: "Browser relay not running. WebSocket connection refused. Start the relay in a separate terminal: npm run relay",
        hint: "Then attach the extension to a tab (Attach This Tab) and try again.",
      });
    }
  }
  if (!relayOk) {
    return res.status(503).json({
      ok: false,
      error: "Browser relay responded but status not ok. Ensure relay is running: npm run relay",
    });
  }

  try {
    const result = await runCdpTask(perintah.trim(), { maxSteps, simulateTime });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn("[api] browser/cdp-task error:", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// ─── MobAI mobile web automation endpoints ────────────────────────────────

/** GET /api/mobai/devices — list Android devices connected via ADB. */
app.get("/api/mobai/devices", async (_req, res) => {
  try {
    const result = await mobileWebRunner.listDevices();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/**
 * POST /api/mobai/execute
 * body: { deviceId: string, script: { version: string, steps: object[] } }
 * Executes a DSL script on the Android device via ADB + Playwright CDP.
 */
app.post("/api/mobai/execute", async (req, res) => {
  const { deviceId, script } = req.body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ ok: false, error: "deviceId (non-empty string) is required" });
  }
  if (!script || !Array.isArray(script.steps)) {
    return res.status(400).json({ ok: false, error: "script.steps (array) is required" });
  }
  try {
    const result = await mobileWebRunner.executeDsl(deviceId, script);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/**
 * GET /api/mobai/screenshot/:deviceId — capture screenshot from Android device via ADB.
 */
app.get("/api/mobai/screenshot/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await mobileWebRunner.captureScreenshot(deviceId);
    if (!result.ok) return res.status(503).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ─── SSE stream endpoint ───────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx compatibility
  res.flushHeaders();

  // Initial heartbeat so the browser knows the connection is alive
  res.write(": connected\n\n");

  sseClients.add(res);

  // Keep-alive ping every 20 s
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(ping); }
  }, 20000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

app.get("/api/results/last", async (_req, res) => {
  try {
    const data = await getLastResults();
    if (!data) return res.json({ ok: true, data: null });
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/config", async (_req, res) => {
  try {
    const config = await getConfig();
    return res.json({ ok: true, config });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/api/llm-provider", (_req, res) => {
  res.json({ ok: true, provider: getProviderName(), configured: llmConfigured() });
});

app.patch("/api/config", async (req, res) => {
  const { budget, maxTokens: maxTokensRaw } = req.body || {};
  if (budget !== undefined && !VALID_BUDGETS.includes(budget)) {
    return res.status(400).json({
      error: "budget must be one of: " + VALID_BUDGETS.join(", "),
    });
  }
  if (maxTokensRaw !== undefined) {
    const n = Number(maxTokensRaw);
    if (!Number.isFinite(n) || n < MIN_MAX_TOKENS || n > MAX_MAX_TOKENS) {
      return res.status(400).json({
        error: "maxTokens must be a number between " + MIN_MAX_TOKENS + " and " + MAX_MAX_TOKENS,
      });
    }
  }
  try {
    const config = await updateConfig({
      ...(budget !== undefined && { budget }),
      ...(maxTokensRaw !== undefined && { maxTokens: Math.round(Number(maxTokensRaw)) }),
    });
    return res.json({ ok: true, config });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

function tryListen(port) {
  const server = app.listen(port, HOST, () => {
    const p = server.address().port;
    console.log("Dominions API at http://localhost:" + p);
    if (HOST === "0.0.0.0") {
      const ifaces = os.networkInterfaces();
      for (const list of Object.values(ifaces || {})) {
        if (!Array.isArray(list)) continue;
        for (const iface of list) {
          if (iface.family === "IPv4" && !iface.internal) {
            console.log("  Network: http://" + iface.address + ":" + p);
          }
        }
      }
    }
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < PORT + MAX_ATTEMPTS) {
      console.warn("Port " + port + " in use, trying " + (port + 1) + "...");
      tryListen(port + 1);
    } else {
      throw err;
    }
  });
}

tryListen(PORT);
