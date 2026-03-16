// ─── DOM refs ───
const budgetBtns        = document.querySelectorAll(".budget-btn");
const maxTokensInput    = document.getElementById("max-tokens-input");
const statusEl          = document.getElementById("status");
const minionsGrid       = document.getElementById("minions-grid");
const createMinionForm  = document.getElementById("create-minion-form");
const createMinionStatus = document.getElementById("create-minion-status");
const createNameInput   = document.getElementById("create-name");
const createDescInput   = document.getElementById("create-description");
const createPromptInput = document.getElementById("create-system-prompt");
const createSubmitBtn   = document.getElementById("create-submit-btn");
const createCancelEditBtn = document.getElementById("create-cancel-edit-btn");
const createPanelTitle  = document.getElementById("create-panel-title");
const createPanelHint   = document.getElementById("create-panel-hint");
const createViewTitle   = document.getElementById("create-view-title");
const taskInput         = document.getElementById("task-input");
const runBtn            = document.getElementById("run-btn");
const clearMemoryBtn    = document.getElementById("clear-memory-btn");
const taskAgentList     = document.getElementById("task-agent-list");
const taskResultPlaceholder = document.getElementById("task-result-placeholder");
const taskResultContent = document.getElementById("task-result-content");
const headerTime        = document.getElementById("header-time");
const tickerText        = document.getElementById("ticker-text");
const agentsCountNum    = document.getElementById("agents-count-num");
const resultPanelTitle  = document.getElementById("result-panel-title");
const resultStatusBadge = document.getElementById("result-status-badge");
const copyResultBtn     = document.getElementById("copy-result-btn");

// ─── Pipeline live view refs ───
const pipelineLanes        = document.getElementById("pipeline-lanes");
const pipelineGlobalStatus = document.getElementById("pipeline-global-status");
const pipelineTaskBanner   = document.getElementById("pipeline-task-banner");
const pipelineTaskText     = document.getElementById("pipeline-task-text");
const navPipelineDot       = document.getElementById("nav-pipeline-dot");

// ─── Preview panel & sidebar toggles ───
const taskSidebar          = document.getElementById("task-sidebar");
const taskAgentsToggle     = document.getElementById("task-agents-toggle");
const taskPreviewPanel     = document.getElementById("task-preview-panel");
const taskPreviewToggle    = document.getElementById("task-preview-toggle");
const taskPreviewPlaceholder = document.getElementById("task-preview-placeholder");
const taskPreviewIframe    = document.getElementById("task-preview-iframe");
const pipelinePreviewPanel = document.getElementById("pipeline-preview-panel");
const pipelinePreviewToggle = document.getElementById("pipeline-preview-toggle");
const pipelinePreviewPlaceholder = document.getElementById("pipeline-preview-placeholder");
const pipelinePreviewIframe = document.getElementById("pipeline-preview-iframe");
const pipelinePreviewPanelTitle = document.getElementById("pipeline-preview-panel-title");
const pipelinePreviewDeviceWrap = document.getElementById("pipeline-preview-device-wrap");
const pipelinePreviewDeviceImg = document.getElementById("pipeline-preview-device-img");
const pipelinePreviewDeviceRefresh = document.getElementById("pipeline-preview-device-refresh");

// ─── State ───
const VIEW_IDS = ["minions-list", "create-minion", "task", "pipeline"];
const STORAGE_AGENTS_VISIBLE = "dominions_task_agents_visible";
const STORAGE_PREVIEW_VISIBLE = "dominions_preview_visible";
let previewPollTimer = null;
let deviceScreenshotPollTimer = null;
let previewPanelMode = "browser"; // "browser" | "device"
let editingMinionId = null;
let minions = [];
let selectedAgentId = null;
let lastResults = null;
// Live pipeline state from SSE
let currentRunId = null;
let currentRunSource = null; // "task" | "mcp" — determines which view to update
let agentStatuses = {}; // id -> "pending" | "running" | "done"
let agentMemoryStats = {}; // id -> { entries: number }

// ─── Clock ───
function updateClock() {
  if (!headerTime) return;
  const n = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  headerTime.textContent = pad(n.getUTCHours()) + ":" + pad(n.getUTCMinutes()) + ":" + pad(n.getUTCSeconds()) + " UTC";
}
setInterval(updateClock, 1000);
updateClock();

// ─── Ticker ───
function setTicker(msg) {
  if (tickerText) tickerText.textContent = msg;
}

// ─── Status ───
function setStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function setCreateStatus(msg, isError = false) {
  if (!createMinionStatus) return;
  createMinionStatus.textContent = msg;
  createMinionStatus.classList.toggle("error", isError);
}

const STATUS_ICONS = { idle: "● IDLE", running: "◉ RUNNING", done: "● DONE", error: "✕ ERROR" };
function setResultStatus(status) {
  if (!resultStatusBadge) return;
  resultStatusBadge.setAttribute("data-status", status);
  resultStatusBadge.textContent = STATUS_ICONS[status] || status.toUpperCase();
}

// ─── Helpers ───
function escapeHtml(s) {
  if (s == null) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Configure marked once: use highlight.js for code blocks, sanitize links
(function initMarked() {
  if (typeof marked === "undefined") return;
  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight: function (code, lang) {
      if (typeof hljs === "undefined") return escapeHtml(code);
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch {}
      }
      try { return hljs.highlightAuto(code).value; } catch {}
      return escapeHtml(code);
    },
  });
})();

/**
 * Render markdown text to safe HTML.
 * Falls back to a <pre> block if marked is not loaded.
 * @param {string} text
 * @returns {string} HTML string (safe to set as innerHTML)
 */
function renderMarkdown(text) {
  if (!text || text.trim() === "") return "<p class=\"md-empty\">(No output)</p>";
  if (typeof marked === "undefined") {
    return "<pre class=\"output-pre\">" + escapeHtml(text) + "</pre>";
  }
  try {
    return "<div class=\"md-body\">" + marked.parse(text) + "</div>";
  } catch {
    return "<pre class=\"output-pre\">" + escapeHtml(text) + "</pre>";
  }
}

function slugFromName(name) {
  return String(name).trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
}

// ─── View switching ───
function showView(viewId) {
  VIEW_IDS.forEach((id) => {
    const view = document.getElementById("view-" + id);
    const link = document.querySelector(".nav-link[data-view=\"" + id + "\"]");
    if (view) view.hidden = id !== viewId;
    if (link) link.classList.toggle("active", id === viewId);
  });
  stopPreviewPoll();
  if (viewId === "task" || viewId === "pipeline") {
    if (viewId === "task") updateTaskPreview();
    else applyPreviewPanelFromDeviceStatus();
    startPreviewPoll();
  }
}

// ─── Task sidebar: show/hide Active agents ───
function getAgentsVisible() {
  try {
    const v = localStorage.getItem(STORAGE_AGENTS_VISIBLE);
    return v === null || v === "true";
  } catch { return true; }
}

function setAgentsVisible(visible) {
  try { localStorage.setItem(STORAGE_AGENTS_VISIBLE, String(visible)); } catch {}
}

function applyAgentsVisiblePreference() {
  if (!taskSidebar) return;
  const visible = getAgentsVisible();
  taskSidebar.classList.toggle("task-sidebar--agents-hidden", !visible);
  if (taskAgentsToggle) {
    taskAgentsToggle.setAttribute("aria-expanded", String(visible));
    const chev = taskAgentsToggle.querySelector(".toggle-chevron");
    if (chev) chev.textContent = visible ? "◀" : "▶";
  }
}

// ─── Preview panel: show/hide (collapse right panel) ───
function getPreviewVisible() {
  try {
    const v = localStorage.getItem(STORAGE_PREVIEW_VISIBLE);
    return v === null || v === "true";
  } catch { return true; }
}

function setPreviewVisible(visible) {
  try { localStorage.setItem(STORAGE_PREVIEW_VISIBLE, String(visible)); } catch {}
}

function applyPreviewVisiblePreference() {
  const visible = getPreviewVisible();
  [taskPreviewPanel, pipelinePreviewPanel].forEach((panel) => {
    if (!panel) return;
    panel.classList.toggle("preview-panel--collapsed", !visible);
  });
  [taskPreviewToggle, pipelinePreviewToggle].forEach((btn) => {
    if (!btn) return;
    btn.setAttribute("aria-expanded", String(visible));
    const chev = btn.querySelector(".toggle-chevron");
    if (chev) chev.textContent = visible ? "▶" : "◀";
  });
}

// ─── Browser preview: fetch current URL and set iframe ───
async function updatePreview(placeholderEl, iframeEl) {
  if (!placeholderEl || !iframeEl) return;
  try {
    const res = await fetch("/api/browser/current-url");
    const data = await res.json();
    if (data.ok && data.url && /^https?:\/\//i.test(data.url)) {
      iframeEl.src = data.url;
      iframeEl.hidden = false;
      placeholderEl.hidden = true;
    } else {
      iframeEl.removeAttribute("src");
      iframeEl.hidden = true;
      placeholderEl.hidden = false;
    }
  } catch {
    iframeEl.removeAttribute("src");
    iframeEl.hidden = true;
    placeholderEl.hidden = false;
  }
}

function updateTaskPreview() {
  updatePreview(taskPreviewPlaceholder, taskPreviewIframe);
}

function updatePipelinePreview() {
  updatePreview(pipelinePreviewPlaceholder, pipelinePreviewIframe);
}

// ─── Device bridge (ADB): single panel shows BROWSER or DEVICES ─────────────

async function getDeviceStatus() {
  try {
    const res = await fetch("/api/device/status");
    const data = await res.json();
    return { available: !!data.available, devices: data.devices || [] };
  } catch {
    return { available: false, devices: [] };
  }
}

function stopDeviceScreenshotPoll() {
  if (deviceScreenshotPollTimer) {
    clearInterval(deviceScreenshotPollTimer);
    deviceScreenshotPollTimer = null;
  }
}

function refreshDeviceScreenshot() {
  if (!pipelinePreviewDeviceImg) return;
  pipelinePreviewDeviceImg.src = "/api/device/screenshot?t=" + Date.now();
}

function setPreviewPanelMode(mode) {
  if (previewPanelMode === mode) return;
  previewPanelMode = mode;
  if (pipelinePreviewPanelTitle) {
    pipelinePreviewPanelTitle.textContent = mode === "device" ? "DEVICES" : "BROWSER";
  }
  if (pipelinePreviewDeviceWrap) pipelinePreviewDeviceWrap.hidden = mode !== "device";
  if (pipelinePreviewPlaceholder) pipelinePreviewPlaceholder.hidden = mode === "device";
  if (pipelinePreviewIframe) {
    pipelinePreviewIframe.hidden = mode === "device";
    if (mode === "browser") pipelinePreviewIframe.removeAttribute("src");
  }
  if (mode === "device") {
    refreshDeviceScreenshot();
    stopDeviceScreenshotPoll();
    const pipelineView = document.getElementById("view-pipeline");
    if (pipelineView && !pipelineView.hidden) {
      deviceScreenshotPollTimer = setInterval(refreshDeviceScreenshot, DEVICE_SCREENSHOT_POLL_MS);
    }
  } else {
    stopDeviceScreenshotPoll();
    updatePipelinePreview();
  }
}

async function applyPreviewPanelFromDeviceStatus() {
  const status = await getDeviceStatus();
  if (status.available) {
    setPreviewPanelMode("device");
  } else {
    setPreviewPanelMode("browser");
  }
}

const PREVIEW_POLL_MS = 8000;
const DEVICE_SCREENSHOT_POLL_MS = 2500;

function startPreviewPoll() {
  stopPreviewPoll();
  const tick = () => {
    const taskView = document.getElementById("view-task");
    const pipelineView = document.getElementById("view-pipeline");
    if (taskView && !taskView.hidden) updateTaskPreview();
    else if (pipelineView && !pipelineView.hidden) applyPreviewPanelFromDeviceStatus();
  };
  previewPollTimer = setInterval(tick, PREVIEW_POLL_MS);
}

function stopPreviewPoll() {
  if (previewPollTimer) {
    clearInterval(previewPollTimer);
    previewPollTimer = null;
  }
  stopDeviceScreenshotPoll();
}

// ─── Budget preset ───
function setBudgetUI(budget) {
  budgetBtns.forEach((btn) => {
    const active = btn.getAttribute("data-budget") === budget;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

async function loadConfig() {
  try {
    const res  = await fetch("/api/config");
    const data = await res.json();
    if (data.ok) {
      setBudgetUI(data.config.budget);
      if (maxTokensInput && data.config.maxTokens != null) {
        maxTokensInput.value = String(data.config.maxTokens);
      }
    }
  } catch { /* silent — server may not be ready yet */ }
}

async function handleBudgetChange(budget) {
  try {
    const res = await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget }),
    });
    if (!res.ok) {
      setStatus("Budget update failed: HTTP " + res.status, true);
      return;
    }
    const data = await res.json();
    if (data.ok) {
      setBudgetUI(data.config.budget);
      setTicker(
        "BUDGET PRESET → " + budget.toUpperCase() +
        " — PROVIDER ROUTING UPDATED — NEXT PIPELINE WILL USE NEW SETTINGS"
      );
    } else {
      setStatus("Budget update failed: " + (data.error || "unknown error"), true);
    }
  } catch (err) {
    setStatus("BUDGET ERROR: " + err.message, true);
  }
}

budgetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const budget = btn.getAttribute("data-budget");
    if (budget) handleBudgetChange(budget);
  });
});

// ─── Max tokens ───
async function handleMaxTokensChange() {
  const raw = maxTokensInput && maxTokensInput.value.trim();
  if (!raw) return;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 256 || n > 128000) {
    setStatus("MAX TOKENS must be between 256 and 128000", true);
    return;
  }
  try {
    const res = await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxTokens: n }),
    });
    const data = await res.json();
    if (data.ok) {
      setTicker("MAX TOKENS → " + n + " — NEXT PIPELINE RUN WILL USE THIS LIMIT");
    } else {
      setStatus("Max tokens update failed: " + (data.error || "unknown error"), true);
    }
  } catch (err) {
    setStatus("MAX TOKENS ERROR: " + err.message, true);
  }
}

if (maxTokensInput) {
  maxTokensInput.addEventListener("blur", handleMaxTokensChange);
  maxTokensInput.addEventListener("change", handleMaxTokensChange);
}

/** Minions that are active (included in pipeline runs). */
function getActiveMinions() {
  return minions.filter((m) => m.active !== false);
}

// ─── Load minions ───
async function loadMinions() {
  try {
    const res  = await fetch("/api/minions");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    minions = data.minions || [];
    if (agentsCountNum) agentsCountNum.textContent = minions.length;
    renderMinionsGrid();
    renderTaskAgentList();
    renderPipelineLanes();
    const activeList = getActiveMinions();
    setTicker(
      minions.length > 0
        ? "AGENTS: " + minions.length + " TOTAL, " + activeList.length + " ACTIVE — " + activeList.map((m) => m.name.toUpperCase()).join(" → ") + " — PIPELINE READY"
        : "NO AGENTS CONFIGURED — NAVIGATE TO CREATE TAB TO DEPLOY AN AGENT"
    );
    // Fetch memory stats for all agents (non-blocking)
    fetchAllAgentMemoryStats();
  } catch (err) {
    setStatus("Could not load minions: " + err.message, true);
    minions = [];
  }
}

async function fetchAllAgentMemoryStats() {
  const results = await Promise.allSettled(
    minions.map(async (m) => {
      const res = await fetch("/api/agents/" + encodeURIComponent(m.id) + "/memory");
      const data = await res.json();
      return { id: m.id, entries: data.entries || 0 };
    })
  );
  results.forEach((r) => {
    if (r.status === "fulfilled") agentMemoryStats[r.value.id] = { entries: r.value.entries };
  });
  renderMinionsGrid();
  renderTaskAgentList();
}

// ─── Minions grid ───
async function handleToggleActive(e) {
  const id = e.currentTarget.closest(".minion-card")?.getAttribute("data-id");
  if (!id) return;
  const m = minions.find((x) => x.id === id);
  if (!m) return;
  const nextActive = !(m.active !== false);
  e.currentTarget.disabled = true;
  try {
    const res = await fetch("/api/minions/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: nextActive }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Update failed", true);
      return;
    }
    m.active = nextActive;
    renderMinionsGrid();
    renderTaskAgentList();
    renderPipelineLanes();
    const activeList = getActiveMinions();
    setTicker(
      nextActive ? "AGENT ENABLED: " + m.name.toUpperCase() + " — " + activeList.length + " ACTIVE IN PIPELINE"
        : "AGENT DISABLED: " + m.name.toUpperCase() + " — " + activeList.length + " ACTIVE IN PIPELINE"
    );
  } catch (err) {
    setStatus("Toggle failed: " + err.message, true);
  } finally {
    e.currentTarget.disabled = false;
  }
}

function renderMinionsGrid() {
  if (minions.length === 0) {
    minionsGrid.innerHTML = "<p class=\"muted\">NO AGENTS DEPLOYED. CREATE ONE FROM THE &quot;CREATE&quot; TAB.</p>";
    return;
  }
  minionsGrid.innerHTML = minions.map((m) => {
    const isActive = m.active !== false;
    const prompt = (m.systemPrompt || "").slice(0, 90);
    const truncated = (m.systemPrompt || "").length > 90;
    const skills = Array.isArray(m.skills) ? m.skills : [];
    const memStats = agentMemoryStats[m.id];
    const memEntries = memStats ? memStats.entries : 0;
    const skillBadges = skills.map((s) =>
      "<span class=\"skill-badge\">" + escapeHtml(s) + "</span>"
    ).join("");
    return (
      "<article class=\"minion-card" + (isActive ? "" : " minion-card--inactive") + "\" data-id=\"" + escapeHtml(m.id) + "\">" +
        "<div class=\"panel-header\">" +
          "<span class=\"panel-icon\">⚡</span>" +
          "<span class=\"panel-title\">" + escapeHtml(m.name.toUpperCase()) + "</span>" +
          "<div class=\"minion-card-header-right\">" +
            "<span class=\"agent-active-badge agent-active-badge--" + (isActive ? "on" : "off") + "\">" + (isActive ? "ACTIVE" : "OFF") + "</span>" +
            "<label class=\"toggle-switch\" aria-label=\"Toggle " + escapeHtml(m.name) + " active\">" +
              "<input type=\"checkbox\" class=\"toggle-switch-input\" " + (isActive ? "checked" : "") + " data-id=\"" + escapeHtml(m.id) + "\" />" +
              "<span class=\"toggle-switch-slider\"></span>" +
            "</label>" +
          "</div>" +
        "</div>" +
        "<div class=\"minion-card-body\">" +
          "<div class=\"minion-stat\"><span class=\"stat-label\">ID</span><span class=\"stat-value cyan\">" + escapeHtml(m.id) + "</span></div>" +
          "<div class=\"minion-stat\"><span class=\"stat-label\">ORDER</span><span class=\"stat-value accent\">" + (m.order ?? 0) + "</span></div>" +
          (m.description
            ? "<div class=\"minion-stat\"><span class=\"stat-label\">DESC</span><span class=\"stat-value\">" + escapeHtml(m.description) + "</span></div>"
            : "") +
          "<p class=\"minion-prompt-preview\">" + escapeHtml(prompt) + (truncated ? "…" : "") + "</p>" +
          (skills.length > 0
            ? "<div class=\"minion-skills\"><span class=\"stat-label\">SKILLS</span><div class=\"skill-badges\">" + skillBadges + "</div></div>"
            : "") +
          "<div class=\"minion-memory-row\">" +
            "<span class=\"stat-label\">MEMORY</span>" +
            "<span class=\"memory-stat" + (memEntries > 0 ? " memory-stat--active" : "") + "\">" +
              (memEntries > 0 ? "◉ " + memEntries + " ENTR" + (memEntries === 1 ? "Y" : "IES") : "◎ EMPTY") +
            "</span>" +
          "</div>" +
        "</div>" +
        "<div class=\"minion-card-footer\">" +
          "<button type=\"button\" class=\"btn btn-small btn-edit\" data-id=\"" + escapeHtml(m.id) + "\" aria-label=\"Edit " + escapeHtml(m.name) + "\">◻ EDIT</button>" +
          "<button type=\"button\" class=\"btn btn-small btn-clear-mem\" data-id=\"" + escapeHtml(m.id) + "\" aria-label=\"Clear memory for " + escapeHtml(m.name) + "\"" + (memEntries === 0 ? " disabled" : "") + ">◻ CLEAR MEM</button>" +
          "<button type=\"button\" class=\"btn btn-small btn-remove\" data-id=\"" + escapeHtml(m.id) + "\" aria-label=\"Remove " + escapeHtml(m.name) + "\">◻ REMOVE</button>" +
        "</div>" +
      "</article>"
    );
  }).join("");

  minionsGrid.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", handleRemoveMinion);
  });
  minionsGrid.querySelectorAll(".btn-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      const m = minions.find((x) => x.id === id);
      if (m) openEditForm(m);
    });
  });
  minionsGrid.querySelectorAll(".toggle-switch-input").forEach((input) => {
    input.addEventListener("change", handleToggleActive);
  });
  minionsGrid.querySelectorAll(".btn-clear-mem").forEach((btn) => {
    btn.addEventListener("click", handleClearAgentMemory);
  });
}

async function handleClearAgentMemory(e) {
  const id = e.currentTarget.getAttribute("data-id");
  if (!id) return;
  const m = minions.find((x) => x.id === id);
  if (!m || !confirm("Clear memory for agent \"" + m.name + "\"?")) return;
  e.currentTarget.disabled = true;
  try {
    const res = await fetch("/api/agents/" + encodeURIComponent(id) + "/memory", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || "Failed", true); return; }
    agentMemoryStats[id] = { entries: 0 };
    setStatus("MEMORY CLEARED: " + m.name.toUpperCase());
    renderMinionsGrid();
    renderTaskAgentList();
  } catch (err) {
    setStatus("Error: " + err.message, true);
  }
}

// ─── Remove minion ───
async function handleRemoveMinion(e) {
  const id = e.currentTarget.getAttribute("data-id");
  if (!id || !confirm("Remove agent \"" + id + "\"?")) return;
  try {
    const res  = await fetch("/api/minions/" + id, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) { setStatus(data.error || "Failed", true); return; }
    setStatus("AGENT REMOVED: " + id.toUpperCase());
    await loadMinions();
  } catch (err) {
    setStatus("Error: " + err.message, true);
  }
}

// ─── Edit minion: open create form in edit mode ───
function openEditForm(m) {
  editingMinionId = m.id;
  if (createNameInput) createNameInput.value = m.name || "";
  if (createDescInput) createDescInput.value = m.description || "";
  if (createPromptInput) createPromptInput.value = m.systemPrompt || "";
  if (createPanelTitle) createPanelTitle.textContent = "EDIT AGENT";
  if (createPanelHint) createPanelHint.textContent = "Update " + (m.name || m.id);
  if (createSubmitBtn) createSubmitBtn.textContent = "▶ UPDATE AGENT";
  if (createViewTitle) createViewTitle.textContent = "EDIT AGENT";
  if (createCancelEditBtn) {
    createCancelEditBtn.hidden = false;
  }
  setCreateStatus("");
  showView("create-minion");
}

function resetCreateForm() {
  editingMinionId = null;
  if (createMinionForm) createMinionForm.reset();
  if (createPanelTitle) createPanelTitle.textContent = "NEW AGENT CONFIGURATION";
  if (createPanelHint) createPanelHint.textContent = "DEPLOY A NEW MINION TO THE PIPELINE";
  if (createSubmitBtn) createSubmitBtn.textContent = "▶ DEPLOY AGENT";
  if (createViewTitle) createViewTitle.textContent = "CREATE AGENT";
  if (createCancelEditBtn) createCancelEditBtn.hidden = true;
  setCreateStatus("");
}

// ─── Task agent list (only active agents run in pipeline) ───
function renderTaskAgentList() {
  const activeMinions = getActiveMinions();
  if (activeMinions.length === 0) {
    taskAgentList.innerHTML = "<p class=\"muted\">NO ACTIVE AGENTS. ENABLE AGENTS IN MINIONS TAB.</p>";
    return;
  }
  taskAgentList.innerHTML = activeMinions.map((m) => {
    const status = agentStatuses[m.id] || "idle";
    return (
      "<div class=\"task-agent-item\" data-id=\"" + escapeHtml(m.id) + "\">" +
        "<div class=\"task-agent-row\">" +
          "<button type=\"button\" class=\"task-agent-btn\" data-id=\"" + escapeHtml(m.id) + "\" role=\"listitem\">" +
            "<span class=\"agent-btn-name\">" + escapeHtml(m.name.toUpperCase()) + "</span>" +
            "<span class=\"agent-btn-status\" data-status=\"" + status + "\" data-id=\"" + escapeHtml(m.id) + "\"></span>" +
          "</button>" +
        "</div>" +
        "<div class=\"task-agent-output\" aria-hidden=\"true\"></div>" +
      "</div>"
    );
  }).join("");

  taskAgentList.querySelectorAll(".task-agent-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedAgentId = btn.getAttribute("data-id");
      taskAgentList.querySelectorAll(".task-agent-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      const m = getActiveMinions().find((x) => x.id === selectedAgentId);
      if (resultPanelTitle) resultPanelTitle.textContent = m ? m.name.toUpperCase() + " — OUTPUT" : "OUTPUT STREAM";
      renderTaskResult();
    });
  });

  taskAgentList.querySelectorAll(".task-agent-toggle").forEach((toggleBtn) => {
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = toggleBtn.closest(".task-agent-item");
      if (!item) return;
      const outputEl = item.querySelector(".task-agent-output");
      const id = item.getAttribute("data-id");
      const isExpanded = item.classList.toggle("task-agent-item--expanded");
      toggleBtn.setAttribute("aria-label", isExpanded ? "Sembunyikan output" : "Tampilkan output");
      toggleBtn.textContent = isExpanded ? "▼" : "▶";
      if (outputEl && isExpanded && !outputEl.hasChildNodes() && lastResults && lastResults[id] != null) {
        outputEl.innerHTML = renderMarkdown(String(lastResults[id]));
        outputEl.setAttribute("aria-hidden", "false");
      } else if (outputEl && !isExpanded) {
        outputEl.setAttribute("aria-hidden", "true");
      }
    });
  });
}

// ─── Pipeline lane rendering ───
const LANE_STATUS_TEXT = {
  idle:    "● IDLE",
  pending: "◎ QUEUED",
  running: "◉ RUNNING…",
  done:    "● DONE",
  error:   "✕ ERROR",
};

const LANE_PLACEHOLDER_TEXT = {
  idle:    "IDLE — AWAITING PIPELINE RUN",
  pending: "QUEUED — WAITING FOR PREVIOUS AGENT…",
  running: "◉ PROCESSING…",
  done:    "(no output)",
  error:   "ERROR",
};

function renderPipelineLanes() {
  if (!pipelineLanes) return;
  const activeMinions = getActiveMinions();
  if (activeMinions.length === 0) {
    pipelineLanes.innerHTML = "<p class=\"muted pipeline-empty\">NO ACTIVE AGENTS — ENABLE AGENTS IN MINIONS TAB (TOGGLE SWITCH).</p>";
    return;
  }
  pipelineLanes.innerHTML = activeMinions.map((m) => {
    const status = agentStatuses[m.id] || "idle";
    return (
      "<div class=\"lane-card\" data-id=\"" + escapeHtml(m.id) + "\" data-status=\"" + status + "\">" +
        "<div class=\"lane-card-header\">" +
          "<button type=\"button\" class=\"lane-card-toggle\" aria-label=\"Collapse output\" title=\"Expand/collapse\">▼</button>" +
          "<div class=\"lane-card-header-left\">" +
            "<span class=\"lane-icon\">⚡</span>" +
            "<span class=\"lane-name\">" + escapeHtml(m.name.toUpperCase()) + "</span>" +
            "<span class=\"lane-meta\">ORDER " + (m.order ?? 0) + "</span>" +
            (m.model ? "<span class=\"lane-meta\">" + escapeHtml(m.model) + "</span>" : "") +
          "</div>" +
          "<div class=\"lane-card-header-actions\">" +
            "<button type=\"button\" class=\"btn btn-ghost btn-small lane-copy-btn\" data-id=\"" + escapeHtml(m.id) + "\" aria-label=\"Copy this agent output\">◻ COPY</button>" +
            "<span class=\"lane-status-badge\" data-status=\"" + status + "\">" +
              (LANE_STATUS_TEXT[status] || status.toUpperCase()) +
            "</span>" +
          "</div>" +
        "</div>" +
        "<div class=\"lane-card-body\">" +
          "<div class=\"lane-output\" id=\"lane-output-" + escapeHtml(m.id) + "\">" +
            "<p class=\"lane-placeholder\">" + (LANE_PLACEHOLDER_TEXT[status] || "") + "</p>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }).join("");

  pipelineLanes.querySelectorAll(".lane-card-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".lane-card");
      if (!card) return;
      card.classList.toggle("lane-card--collapsed");
      const collapsed = card.classList.contains("lane-card--collapsed");
      btn.setAttribute("aria-label", collapsed ? "Expand output" : "Collapse output");
      btn.textContent = collapsed ? "▶" : "▼";
    });
  });
}

function updatePipelineLaneStatus(id, status) {
  if (!pipelineLanes) return;
  const card = pipelineLanes.querySelector(".lane-card[data-id=\"" + id + "\"]");
  if (!card) return;
  card.setAttribute("data-status", status);
  const badge = card.querySelector(".lane-status-badge");
  if (badge) {
    badge.setAttribute("data-status", status);
    badge.textContent = LANE_STATUS_TEXT[status] || status.toUpperCase();
  }
  const outputEl = card.querySelector(".lane-output");
  if (outputEl && !outputEl.querySelector("pre")) {
    const placeholder = outputEl.querySelector(".lane-placeholder");
    if (placeholder) placeholder.textContent = LANE_PLACEHOLDER_TEXT[status] || "";
  }
}

function updatePipelineLaneOutput(id, output) {
  if (!pipelineLanes) return;
  const outputEl = pipelineLanes.querySelector("#lane-output-" + id);
  if (outputEl) {
    outputEl.innerHTML = renderMarkdown(output);
  }
}

function setPipelineGlobalStatus(status, text) {
  if (!pipelineGlobalStatus) return;
  pipelineGlobalStatus.setAttribute("data-status", status);
  pipelineGlobalStatus.textContent = text || LANE_STATUS_TEXT[status] || status.toUpperCase();
}

function setPipelineRunDot(active) {
  if (!navPipelineDot) return;
  navPipelineDot.classList.toggle("nav-run-dot--active", active);
}

function refreshExpandedTaskOutputs() {
  if (!taskAgentList || !lastResults) return;
  taskAgentList.querySelectorAll(".task-agent-item--expanded").forEach((item) => {
    const id = item.getAttribute("data-id");
    const outputEl = item.querySelector(".task-agent-output");
    if (outputEl && id && lastResults[id] != null) {
      outputEl.innerHTML = renderMarkdown(String(lastResults[id]));
      outputEl.setAttribute("aria-hidden", "false");
    }
  });
}

function updateAgentStatus(id, status) {
  agentStatuses[id] = status;
  // Update badge in-place without full re-render
  const badge = taskAgentList.querySelector(".agent-btn-status[data-id=\"" + id + "\"]");
  if (badge) badge.setAttribute("data-status", status);
}

/** Copy the currently displayed markdown result to the clipboard. */
async function handleCopyResult() {
  const raw = selectedAgentId && lastResults && lastResults[selectedAgentId] != null
    ? String(lastResults[selectedAgentId]).trim()
    : "";
  if (!raw) {
    setStatus("No output to copy.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(raw);
    setStatus("Copied to clipboard.");
    if (copyResultBtn) {
      const label = copyResultBtn.textContent;
      copyResultBtn.textContent = "✓ COPIED";
      copyResultBtn.disabled = true;
      setTimeout(() => {
        copyResultBtn.textContent = label;
        copyResultBtn.disabled = false;
      }, 1500);
    }
  } catch (err) {
    setStatus("Copy failed: " + (err.message || "clipboard unavailable"), true);
  }
}

// ─── Task result ───
function renderTaskResult() {
  const displayText = (s) => (s != null && String(s).trim() !== "" ? String(s) : "(No output)");
  if (lastResults && selectedAgentId !== null) {
    const text = displayText(lastResults[selectedAgentId]);
    taskResultPlaceholder.hidden = true;
    taskResultContent.hidden = false;
    taskResultContent.innerHTML = renderMarkdown(text);
    setResultStatus("done");
  } else if (lastResults && Object.keys(lastResults).length > 0 && selectedAgentId === null) {
    const activeList = getActiveMinions();
    const firstId = (activeList[0] || {}).id || Object.keys(lastResults)[0];
    selectedAgentId = firstId;
    const btn = taskAgentList.querySelector("[data-id=\"" + firstId + "\"]");
    if (btn) btn.classList.add("selected");
    const m = getActiveMinions().find((x) => x.id === firstId);
    if (resultPanelTitle) resultPanelTitle.textContent = m ? m.name.toUpperCase() + " — OUTPUT" : "OUTPUT STREAM";
    const text = displayText(lastResults[firstId]);
    taskResultPlaceholder.hidden = true;
    taskResultContent.hidden = false;
    taskResultContent.innerHTML = renderMarkdown(text);
    setResultStatus("done");
  } else {
    taskResultPlaceholder.hidden = false;
    taskResultContent.hidden = true;
    taskResultContent.innerHTML = "";
    if (!lastResults) setResultStatus("idle");
  }
}

// ─── Run pipeline ───
async function handleRun() {
  const task = taskInput.value.trim();
  if (!task) { setStatus("ENTER A TASK DIRECTIVE FIRST.", true); return; }
  runBtn.disabled = true;

  // Reset state
  lastResults = {};
  agentStatuses = {};
  selectedAgentId = null;
  getActiveMinions().forEach((m) => { agentStatuses[m.id] = "pending"; });
  renderTaskAgentList();
  if (resultPanelTitle) resultPanelTitle.textContent = "OUTPUT STREAM";

  setStatus("PIPELINE EXECUTING...");
  setResultStatus("running");
  taskResultPlaceholder.textContent = "PIPELINE ACTIVE — WAITING FOR FIRST AGENT…";
  taskResultPlaceholder.hidden = false;
  taskResultContent.hidden = true;
  setTicker("PIPELINE ACTIVE — TASK: " + task.slice(0, 80) + (task.length > 80 ? "…" : ""));

  // Fire the pipeline (live results via SSE; fallback: apply response body when request completes)
  fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus("ERROR: " + (data.error || res.statusText), true);
      setResultStatus("error");
      return;
    }
    // Fallback: if SSE didn't deliver results (e.g. connection issue), apply response body so output is visible
    if (data.ok && data.results && typeof data.results === "object") {
      applyResultsToUI(data.results);
    }
  }).catch((err) => {
    setStatus("NETWORK ERROR: " + err.message, true);
    setResultStatus("error");
  }).finally(() => {
    runBtn.disabled = false;
  });
}

/** Apply results to task panel and pipeline lanes (used by SSE and by /api/run fallback). */
function applyResultsToUI(results) {
  if (!results || typeof results !== "object") return;
  if (!lastResults) lastResults = {};
  const display = (s) => (s != null && String(s).trim() !== "" ? String(s) : "(No output)");
  for (const [id, output] of Object.entries(results)) {
    lastResults[id] = output;
    updatePipelineLaneOutput(id, display(output));
  }
  if (selectedAgentId && lastResults[selectedAgentId] !== undefined) {
    taskResultPlaceholder.hidden = true;
    taskResultContent.hidden = false;
    taskResultContent.innerHTML = renderMarkdown(display(lastResults[selectedAgentId]));
  } else if (Object.keys(lastResults).length > 0) {
    const activeList = getActiveMinions();
    const firstId = activeList[0]?.id ?? Object.keys(lastResults)[0];
    selectedAgentId = firstId;
    const btn = taskAgentList?.querySelector("[data-id=\"" + firstId + "\"]");
    taskAgentList?.querySelectorAll(".task-agent-btn").forEach((b) => b.classList.remove("selected"));
    if (btn) btn.classList.add("selected");
    const m = activeList.find((x) => x.id === firstId);
    if (resultPanelTitle) resultPanelTitle.textContent = m ? m.name.toUpperCase() + " — OUTPUT" : "OUTPUT STREAM";
    taskResultPlaceholder.hidden = true;
    taskResultContent.hidden = false;
    taskResultContent.innerHTML = renderMarkdown(display(lastResults[firstId]));
  }
  setResultStatus("done");
}

// ─── Clear memory ───
async function handleClearMemory() {
  if (!confirm("Clear all agent memory?")) return;
  clearMemoryBtn.disabled = true;
  setStatus("CLEARING MEMORY...");
  try {
    const res  = await fetch("/api/memory/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) { setStatus("ERROR: " + (data.error || res.statusText), true); return; }
    setStatus("MEMORY CLEARED.");
    setTicker("MEMORY CLEARED — ALL AGENT CONTEXT RESET — PIPELINE READY FOR NEW TASK");
    lastResults = null;
    selectedAgentId = null;
    taskResultPlaceholder.hidden = false;
    taskResultPlaceholder.textContent = "SELECT AN AGENT AND EXECUTE A TASK TO VIEW OUTPUT";
    taskResultContent.hidden = true;
    taskResultContent.innerHTML = "";
    if (resultPanelTitle) resultPanelTitle.textContent = "OUTPUT STREAM";
    setResultStatus("idle");
    taskAgentList.querySelectorAll(".task-agent-btn").forEach((b) => b.classList.remove("selected"));
  } catch (err) {
    setStatus("NETWORK ERROR: " + err.message, true);
  } finally {
    clearMemoryBtn.disabled = false;
  }
}

// ─── Create minion ───
createMinionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name         = (createNameInput && createNameInput.value.trim()) || "";
  const description  = (createDescInput && createDescInput.value.trim()) || "";
  const systemPrompt = (createPromptInput && createPromptInput.value.trim()) || "";
  if (!name || !systemPrompt) return;

  if (editingMinionId) {
    setCreateStatus("UPDATING AGENT...");
    try {
      const res = await fetch("/api/minions/" + encodeURIComponent(editingMinionId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || undefined, systemPrompt }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateStatus(data.error || "Update failed", true); return; }
      setCreateStatus("AGENT UPDATED: " + name.toUpperCase());
      resetCreateForm();
      await loadMinions();
      showView("minions-list");
    } catch (err) {
      setCreateStatus("ERROR: " + err.message, true);
    }
    return;
  }

  const id = slugFromName(name) || "minion";
  setCreateStatus("DEPLOYING AGENT...");
  try {
    const res  = await fetch("/api/minions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, description: description || undefined, systemPrompt }),
    });
    const data = await res.json();
    if (!res.ok) { setCreateStatus(data.error || "Failed", true); return; }
    setCreateStatus("AGENT DEPLOYED: " + name.toUpperCase());
    createMinionForm.reset();
    await loadMinions();
  } catch (err) {
    setCreateStatus("ERROR: " + err.message, true);
  }
});

if (createCancelEditBtn) {
  createCancelEditBtn.addEventListener("click", () => {
    resetCreateForm();
    showView("minions-list");
  });
}

// ─── Nav ───
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const viewId = link.getAttribute("data-view");
    if (!viewId) return;
    if (viewId === "create-minion") resetCreateForm();
    showView(viewId);
  });
});

// ─── Events ───
runBtn.addEventListener("click", handleRun);
clearMemoryBtn.addEventListener("click", handleClearMemory);
if (copyResultBtn) copyResultBtn.addEventListener("click", handleCopyResult);

if (taskAgentsToggle) {
  taskAgentsToggle.addEventListener("click", () => {
    const next = !getAgentsVisible();
    setAgentsVisible(next);
    applyAgentsVisiblePreference();
  });
}

function handlePreviewToggle(panelId) {
  const next = !getPreviewVisible();
  setPreviewVisible(next);
  applyPreviewVisiblePreference();
}

if (taskPreviewToggle) taskPreviewToggle.addEventListener("click", () => handlePreviewToggle("task"));
if (pipelinePreviewToggle) pipelinePreviewToggle.addEventListener("click", () => handlePreviewToggle("pipeline"));
if (pipelinePreviewDeviceRefresh) pipelinePreviewDeviceRefresh.addEventListener("click", refreshDeviceScreenshot);

taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    handleRun();
  }
});

// ─── Pipeline lane copy (delegated) ───
if (pipelineLanes) {
  pipelineLanes.addEventListener("click", async (e) => {
    const btn = e.target.closest(".lane-copy-btn");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    const raw = id && lastResults && lastResults[id] != null ? String(lastResults[id]).trim() : "";
    if (!raw) {
      setStatus("No output to copy for this agent.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(raw);
      setStatus("Copied to clipboard.");
      const label = btn.textContent;
      btn.textContent = "✓ COPIED";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = label;
        btn.disabled = false;
      }, 1500);
    } catch (err) {
      setStatus("Copy failed: " + (err.message || "clipboard unavailable"), true);
    }
  });
}

// ─── SSE: live pipeline updates ───────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource("/api/stream");

  es.addEventListener("pipeline:start", (e) => {
    const { runId, task, total, source } = JSON.parse(e.data);
    currentRunId = runId;
    currentRunSource = source || "task";

    if (currentRunSource === "mcp") {
      // MCP run: update only Pipeline view
      lastResults = {};
      agentStatuses = {};
      getActiveMinions().forEach((m) => { agentStatuses[m.id] = "pending"; });
      if (pipelineTaskBanner) pipelineTaskBanner.hidden = false;
      if (pipelineTaskText)   pipelineTaskText.textContent = task;
      setPipelineGlobalStatus("running", "◉ RUNNING");
      setPipelineRunDot(true);
      renderPipelineLanes();
      showView("pipeline");
      setTicker("PIPELINE (MCP) — TASK: " + task.slice(0, 80) + (task.length > 80 ? "…" : ""));
      return;
    }

    // Task run: update Task view (and keep Pipeline lanes in sync)
    lastResults = {};
    agentStatuses = {};
    getActiveMinions().forEach((m) => { agentStatuses[m.id] = "pending"; });
    if (pipelineTaskBanner) pipelineTaskBanner.hidden = false;
    if (pipelineTaskText)   pipelineTaskText.textContent = task;
    setPipelineGlobalStatus("running", "◉ RUNNING");
    setPipelineRunDot(true);
    renderPipelineLanes();
    showView("task");
    renderTaskAgentList();
    selectedAgentId = null;
    if (resultPanelTitle) resultPanelTitle.textContent = "OUTPUT STREAM";
    setResultStatus("running");
    taskResultPlaceholder.textContent = "PIPELINE ACTIVE — " + total + " AGENT" + (total !== 1 ? "S" : "") + " QUEUED…";
    taskResultPlaceholder.hidden = false;
    taskResultContent.hidden = true;
    setTicker("PIPELINE ACTIVE — TASK: " + task.slice(0, 80) + (task.length > 80 ? "…" : ""));
    runBtn.disabled = true;
  });

  es.addEventListener("agent:start", (e) => {
    const { id, name, index, total, source } = JSON.parse(e.data);
    updatePipelineLaneStatus(id, "running");
    if (currentRunSource === "mcp") {
      setTicker(
        "RUNNING AGENT " + (index + 1) + "/" + total + " — " + name.toUpperCase() +
        " — AWAITING RESPONSE…"
      );
      return;
    }
    updateAgentStatus(id, "running");
    setTicker(
      "RUNNING AGENT " + (index + 1) + "/" + total + " — " + name.toUpperCase() +
      " — AWAITING RESPONSE…"
    );
    if (!selectedAgentId || selectedAgentId === id) {
      selectedAgentId = id;
      taskAgentList.querySelectorAll(".task-agent-btn").forEach((b) => {
        b.classList.toggle("selected", b.getAttribute("data-id") === id);
      });
      if (resultPanelTitle) resultPanelTitle.textContent = name.toUpperCase() + " — RUNNING…";
      taskResultPlaceholder.textContent = "◉ " + name.toUpperCase() + " IS PROCESSING…";
      taskResultPlaceholder.hidden = false;
      taskResultContent.hidden = true;
    }
  });

  es.addEventListener("agent:result", (e) => {
    const { id, name, output, index, total } = JSON.parse(e.data);
    const text = (output != null && String(output).trim() !== "") ? String(output) : "(No output)";
    updateAgentStatus(id, "done");
    updatePipelineLaneStatus(id, "done");
    updatePipelineLaneOutput(id, text);
    if (!lastResults) lastResults = {};
    lastResults[id] = text;
    refreshExpandedTaskOutputs();

    const done = index + 1;
    setTicker("AGENT " + done + "/" + total + " DONE — " + name.toUpperCase() + " — " + (total - done) + " REMAINING");

    if (currentRunSource === "mcp") return;

    if (selectedAgentId === id || !selectedAgentId) {
      selectedAgentId = id;
      taskAgentList.querySelectorAll(".task-agent-btn").forEach((b) => {
        b.classList.toggle("selected", b.getAttribute("data-id") === id);
      });
      if (resultPanelTitle) resultPanelTitle.textContent = name.toUpperCase() + " — OUTPUT";
      taskResultPlaceholder.hidden = true;
      taskResultContent.hidden = false;
      taskResultContent.innerHTML = renderMarkdown(text);
      setResultStatus("done");
    }
  });

  es.addEventListener("pipeline:done", (e) => {
    const { task, results, completedAt, source, previewUrl } = JSON.parse(e.data);
    lastResults = results || {};
    const count = Object.keys(lastResults).length;
    setPipelineGlobalStatus("done", "● DONE — " + count + " AGENT" + (count !== 1 ? "S" : ""));
    setPipelineRunDot(false);

    if (previewUrl && pipelinePreviewIframe && pipelinePreviewPlaceholder && previewPanelMode === "browser") {
      pipelinePreviewIframe.src = previewUrl + "?t=" + Date.now();
      pipelinePreviewIframe.hidden = false;
      pipelinePreviewPlaceholder.hidden = true;
    }

    if (currentRunSource === "mcp") {
      const display = (s) => (s != null && String(s).trim() !== "" ? String(s) : "(No output)");
      for (const [id, output] of Object.entries(lastResults)) {
        updatePipelineLaneOutput(id, display(output));
      }
      setTicker(
        "PIPELINE (MCP) COMPLETE — " + count + " AGENTS — " +
        task.slice(0, 70) + (task.length > 70 ? "…" : "")
      );
      currentRunSource = null;
      return;
    }

    applyResultsToUI(lastResults);
    refreshExpandedTaskOutputs();
    setStatus("PIPELINE COMPLETE — " + count + " AGENT" + (count !== 1 ? "S" : "") + " PROCESSED.");
    setTicker(
      "PIPELINE COMPLETE — " + count + " AGENTS — TASK: " +
      task.slice(0, 70) + (task.length > 70 ? "…" : "")
    );
    setResultStatus("done");
    runBtn.disabled = false;
    currentRunSource = null;
    const activeList = getActiveMinions();
    if (!selectedAgentId && activeList.length > 0) {
      selectedAgentId = activeList[0].id;
      const btn = taskAgentList.querySelector(".task-agent-btn[data-id=\"" + selectedAgentId + "\"]");
      if (btn) btn.classList.add("selected");
      const m = activeList[0];
      if (resultPanelTitle) resultPanelTitle.textContent = m.name.toUpperCase() + " — OUTPUT";
      renderTaskResult();
    }
  });

  es.addEventListener("pipeline:error", (e) => {
    const { error, source } = JSON.parse(e.data);
    setPipelineGlobalStatus("error", "✕ ERROR");
    setPipelineRunDot(false);
    if (currentRunSource === "task") {
      setStatus("PIPELINE ERROR: " + error, true);
      setResultStatus("error");
      runBtn.disabled = false;
      taskResultPlaceholder.textContent = "PIPELINE ERROR — " + error;
      taskResultPlaceholder.hidden = false;
      taskResultContent.hidden = true;
    }
    setTicker(currentRunSource === "mcp" ? "PIPELINE (MCP) ERROR — " + error : "PIPELINE ERROR — " + error);
    currentRunSource = null;
  });

  es.onerror = () => {
    // SSE auto-reconnects — no action needed
  };
}

// ─── Init ───
showView("minions-list");
applyAgentsVisiblePreference();
applyPreviewVisiblePreference();
loadConfig();
loadMinions();
connectSSE();
