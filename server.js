import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
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
import { scrapePage } from "./services/pageScraper.js";
import { extractSections } from "./services/sectionExtractor.js";
import { executeHandoff } from "./services/executor.js";

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

pipelineEvents.on("pipeline:start",  (d) => broadcast("pipeline:start",  d));
pipelineEvents.on("agent:start",     (d) => broadcast("agent:start",     d));
pipelineEvents.on("agent:result",    (d) => broadcast("agent:result",    d));
pipelineEvents.on("pipeline:done",   (d) => broadcast("pipeline:done",   d));
pipelineEvents.on("pipeline:error",  (d) => broadcast("pipeline:error",  d));

const VALID_BUDGETS = ["free", "min", "mid", "max"];
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 128000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_ATTEMPTS = 100;

app.use(express.json());
app.use(express.static(path.join(__dirname, "frontend")));

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
  broadcast("pipeline:start", { runId, task: task.trim(), total: total || 0 });
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
    broadcast("pipeline:done", { runId, task: run.task, results: run.results, completedAt });
    mcpRuns.delete(runId);
    return res.json({ ok: true, results: run.results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post("/api/pipeline/mcp/error", (req, res) => {
  const { runId, error: errMsg } = req.body || {};
  if (!runId) return res.status(400).json({ error: "runId is required" });

  broadcast("pipeline:error", { runId, error: errMsg || "Unknown error" });
  mcpRuns.delete(runId);
  return res.json({ ok: true });
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
  const server = app.listen(port, () => {
    console.log("Dominions API at http://localhost:" + server.address().port);
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
