#!/usr/bin/env node
/**
 * Dominions MCP Server (stdio transport).
 *
 * Exposes the Dominions pipeline as MCP tools so AI assistants like
 * Cursor can run tasks, inspect results, and manage agents.
 *
 * Requires the Dominions Express server to be running (default: http://localhost:3000).
 * Set DOMINIONS_API_URL env var to override.
 *
 * Add to Cursor → Settings → MCP:
 *   {
 *     "dominions": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/dominions/mcp-server.js"],
 *       "env": { "DOMINIONS_API_URL": "http://localhost:3000" }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_URL = (process.env.DOMINIONS_API_URL || "http://localhost:3000").replace(/\/$/, "");

// Optional: log to stderr if server unreachable (visible in Cursor MCP output)
try {
  const h = await fetch(API_URL + "/api/minions", { method: "GET" }).catch(() => null);
  if (!h || !h.ok) {
    process.stderr.write("[dominions MCP] Server not reachable at " + API_URL + ". Start with: npm run start:server\n");
  }
} catch (_) {}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API_URL + path, opts);
  return res.json();
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "run_pipeline",
    description:
      "Run a task through the full Dominions agent pipeline. " +
      "All configured minions process the task in order, one after another. " +
      "Each agent's result is pushed to the Web UI in real-time as it completes " +
      "(open http://localhost:3000 → TASK tab to watch live). " +
      "This call blocks until all agents finish, then returns every agent's output.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task or prompt to send to the agent pipeline.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "run_pipeline_mcp",
    description:
      "Run the Dominions agent pipeline using the MCP client's own AI (Cursor / VS Code) " +
      "instead of an external API. Returns the full pipeline context and minion system prompts. " +
      "Requires the Dominions server to be running (e.g. npm start or node server.js on port 3000). " +
      "AFTER calling this tool you MUST: process each minion in order using its system prompt, " +
      "call `report_mcp_result` for every minion as you complete it (streams live to the Pipeline UI), " +
      "then call `finish_mcp_pipeline` when all minions are done.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task or prompt to send to the agent pipeline.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "report_mcp_result",
    description:
      "Report a single minion's output during an MCP pipeline run. " +
      "Call this immediately after generating each minion's response — the result is " +
      "streamed live to the Pipeline UI as soon as you call it.",
    inputSchema: {
      type: "object",
      properties: {
        runId:      { type: "string", description: "Run ID returned by run_pipeline_mcp." },
        minionId:   { type: "string", description: "The minion's id." },
        minionName: { type: "string", description: "The minion's display name." },
        output:     { type: "string", description: "The response you generated for this minion." },
        index:      { type: "number", description: "Zero-based index of this minion in the pipeline." },
        total:      { type: "number", description: "Total number of minions in the pipeline." },
      },
      required: ["runId", "minionId", "output", "index", "total"],
    },
  },
  {
    name: "finish_mcp_pipeline",
    description:
      "Finalise an MCP pipeline run after ALL minions have been processed via report_mcp_result. " +
      "Saves results to disk and broadcasts pipeline completion to the Pipeline UI.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run ID returned by run_pipeline_mcp." },
      },
      required: ["runId"],
    },
  },
  {
    name: "get_last_results",
    description:
      "Get the results from the most recently executed pipeline run. " +
      "Returns the task, each agent's output, and the completion timestamp.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_minions",
    description: "List all configured minion agents in the pipeline (name, id, order, description).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_minion",
    description: "Add a new minion agent to the pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        id:           { type: "string",  description: "Unique slug id, e.g. 'code-reviewer'" },
        name:         { type: "string",  description: "Display name, e.g. 'Code Reviewer'" },
        systemPrompt: { type: "string",  description: "System prompt defining the agent's role and behavior." },
        description:  { type: "string",  description: "Short description of what this agent does (optional)." },
        order:        { type: "number",  description: "Execution order (ascending). Optional." },
        model:        { type: "string",  description: "Override model for this agent (optional)." },
      },
      required: ["id", "name", "systemPrompt"],
    },
  },
  {
    name: "delete_minion",
    description: "Remove a minion agent from the pipeline by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The minion id to delete." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_memory",
    description:
      "Read agent memory. Omit 'role' to get all shared memory, " +
      "or pass a minion id as 'role' to get that agent's memory.",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "Minion id to retrieve memory for, or omit for shared memory.",
        },
      },
    },
  },
  {
    name: "clear_memory",
    description:
      "Clear agent memory. Omit 'role' to clear all memory, " +
      "or pass a minion id to clear only that agent's memory.",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "Minion id to clear memory for, or omit to clear all.",
        },
      },
    },
  },
  {
    name: "get_config",
    description: "Get the current runtime configuration: budget preset and max completion tokens.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_config",
    description:
      "Update runtime configuration. Changes take effect on the next pipeline run " +
      "with no server restart needed. Also reflected in the Web UI.",
    inputSchema: {
      type: "object",
      properties: {
        budget: {
          type: "string",
          enum: ["free", "min", "mid", "max"],
          description: "Budget preset: free=$0 only, min=cheapest paid, mid=balanced, max=best/no cap.",
        },
        maxTokens: {
          type: "number",
          description: "Max completion tokens per agent call (256–128000).",
          minimum: 256,
          maximum: 128000,
        },
      },
    },
  },

  // ─── Browser Relay tools ───────────────────────────────────────────────────
  {
    name: "browser_relay_status",
    description:
      "Check if the browser relay server is running and if the Chrome extension is attached to a tab. " +
      "Always call this first before using other browser_relay_* tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_relay_navigate",
    description: "Navigate the attached Chrome tab to a URL. Waits ~1.5s for the page to start loading.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to navigate to (must start with http:// or https://)." },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_relay_snapshot",
    description: "Get the full HTML source of the current page in the attached tab.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_relay_text",
    description: "Get the visible text content of the current page (no HTML tags).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_relay_click",
    description: "Click an element in the attached tab by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click." },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_relay_type",
    description:
      "Type text into an element in the attached tab. Optionally focus it by selector first.",
    inputSchema: {
      type: "object",
      properties: {
        text:     { type: "string", description: "Text to type." },
        selector: { type: "string", description: "Optional CSS selector to focus before typing." },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_relay_scroll",
    description: "Scroll the page by pixels or scroll an element into view.",
    inputSchema: {
      type: "object",
      properties: {
        x:        { type: "number", description: "Horizontal pixels to scroll (default 0)." },
        y:        { type: "number", description: "Vertical pixels to scroll (default 0)." },
        selector: { type: "string", description: "Optional CSS selector to scroll into view." },
      },
    },
  },
  {
    name: "browser_relay_screenshot",
    description: "Take a screenshot of the attached tab. Returns a base64-encoded JPEG data URL.",
    inputSchema: {
      type: "object",
      properties: {
        format:  { type: "string", enum: ["jpeg", "png"], description: "Image format (default: jpeg)." },
        quality: { type: "number", description: "JPEG quality 1–100 (default: 80).", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "browser_relay_evaluate",
    description: "Evaluate arbitrary JavaScript in the attached tab and return the result.",
    inputSchema: {
      type: "object",
      properties: {
        expression:   { type: "string", description: "JavaScript expression to evaluate." },
        awaitPromise: { type: "boolean", description: "Await the returned Promise (default false)." },
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_relay_get_url",
    description: "Get the current URL of the attached tab.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_relay_get_title",
    description: "Get the page title of the attached tab.",
    inputSchema: { type: "object", properties: {} },
  },

  // ─── Browser Task (natural language) ───────────────────────────────────────
  {
    name: "browser_task",
    description:
      "Run a natural-language browser task in the attached Chrome tab. " +
      "The LLM interprets your command and drives the browser (navigate, click, type, scroll) until the task is done or max steps. " +
      "Example: 'Buka tiket.com, cari kereta Jakarta–Bandung tanggal 5 Maret 2026' or 'Klik tombol Login lalu isi email dan password'. " +
      "Requires: relay running (npm run relay), extension attached to a tab, and LLM configured.",
    inputSchema: {
      type: "object",
      properties: {
        perintah: {
          type: "string",
          description: "The task in natural language (e.g. 'Buka halaman X', 'Klik tombol Y', 'Isi form dengan Z').",
        },
        maxSteps: {
          type: "number",
          description: "Maximum number of automation steps (default 15).",
          minimum: 1,
          maximum: 30,
        },
        simulateTime: {
          type: "string",
          description: "Optional. Simulate current time for ticket war, e.g. '15:51' or '3.52' (WIB).",
        },
      },
      required: ["perintah"],
    },
  },
  {
    name: "browser_task_cdp",
    description:
      "Run a natural-language browser task using Playwright over full CDP proxy — more robust than browser_task. " +
      "Playwright handles navigation waits, element visibility, and proper fill/click interactions automatically. " +
      "Best for complex tasks: hotel/train search with date pickers, form filling, multi-step flows. " +
      "Requires: relay running (npm run relay), extension attached and CDP mode active (/extension-cdp connected). " +
      "Example: 'Cari hotel di Bandung tanggal 25 Maret 2025 di tiket.com'.",
    inputSchema: {
      type: "object",
      properties: {
        perintah: {
          type: "string",
          description: "The task in natural language.",
        },
        maxSteps: {
          type: "number",
          description: "Maximum number of automation steps (default 20).",
          minimum: 1,
          maximum: 40,
        },
        simulateTime: {
          type: "string",
          description: "Optional. Simulate current time for ticket war, e.g. '15:51' or '3.52' (WIB).",
        },
      },
      required: ["perintah"],
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case "run_pipeline": {
      const { task } = args || {};
      if (!task || typeof task !== "string" || !task.trim()) {
        return err("task is required (non-empty string)");
      }
      const data = await api("POST", "/api/run", { task: task.trim() });
      if (!data.ok) return err(data.error || "Pipeline failed");

      const lines = ["Pipeline complete.\n"];
      for (const [id, output] of Object.entries(data.results || {})) {
        lines.push("─── " + id.toUpperCase() + " ───");
        lines.push(output);
        lines.push("");
      }
      return ok(lines.join("\n").trim());
    }

    case "run_pipeline_mcp": {
      const { task } = args || {};
      if (!task || typeof task !== "string" || !task.trim()) {
        return err("task is required (non-empty string)");
      }

      let minionsData;
      try {
        minionsData = await api("GET", "/api/minions");
      } catch (e) {
        const msg = e?.message ?? String(e);
        const hint = msg.includes("ECONNREFUSED") || msg.includes("fetch failed")
          ? " Pastikan server Dominions jalan (npm start atau node server.js), bukan hanya npm run relay."
          : "";
        return err("Tidak bisa hubung ke server Dominions: " + msg + hint);
      }

      if (!minionsData.ok) return err(minionsData.error || "Failed to fetch minions");
      const allMinions = minionsData.minions || [];
      const minions = allMinions.filter((m) => m.active !== false);
      if (minions.length === 0) {
        return err(
          allMinions.length === 0
            ? "No minions configured. Add minions first (via list_minions / create_minion or Minions tab)."
            : "No active minions. Enable at least one minion in the Minions tab (toggle active)."
        );
      }

      const runId = Date.now().toString(36);
      const total = minions.length;

      const started = await api("POST", "/api/pipeline/mcp/start", {
        runId,
        task: task.trim(),
        total,
      });
      if (!started.ok) return err(started.error || "Failed to start MCP pipeline");

      const lines = [
        "MCP Pipeline started.",
        "Run ID: " + runId,
        "Task: " + task.trim(),
        "",
        "INSTRUCTIONS — process each minion IN ORDER:",
        "  1. Read the minion's System Prompt below.",
        "  2. Generate a response to the Task (use previous outputs as context).",
        "  3. Call `report_mcp_result` with runId, minionId, your output, index, and total=" + total + ".",
        "     This streams the result to the Pipeline UI immediately.",
        "  4. Repeat for every minion.",
        "  5. After the LAST minion, call `finish_mcp_pipeline` with the runId.",
        "",
        "Minions (" + total + " total):",
        "",
      ];

      minions.forEach((m, i) => {
        lines.push("── [" + i + "] " + m.name + "  (id: " + m.id + ") ──");
        if (m.description) lines.push("Description: " + m.description);
        lines.push("System Prompt:");
        lines.push(m.systemPrompt);
        lines.push("");
      });

      return ok(lines.join("\n").trimEnd());
    }

    case "report_mcp_result": {
      const { runId, minionId, minionName, output, index, total } = args || {};
      if (!runId || !minionId || output === undefined) {
        return err("runId, minionId, and output are required");
      }

      const text     = String(output);
      const id       = minionId;
      const name     = minionName || minionId;
      const idx      = index ?? 0;
      const tot      = total ?? 1;

      // Signal agent start so the lane switches to "running" state immediately
      await api("POST", "/api/pipeline/mcp/agent-start", { runId, id, name, index: idx, total: tot });

      // Stream output word-by-word so the Pipeline UI shows live progress
      const CHUNK_SIZE = 6; // words per chunk
      const words = text.split(" ");
      for (let i = 0; i < words.length; i += CHUNK_SIZE) {
        const chunk = words.slice(i, i + CHUNK_SIZE).join(" ") + (i + CHUNK_SIZE < words.length ? " " : "");
        await api("POST", "/api/pipeline/mcp/chunk", { runId, id, name, chunk, index: idx, total: tot });
        // Small yield so Node.js can flush SSE writes between chunks
        await new Promise((r) => setTimeout(r, 0));
      }

      // Finalize with the complete output
      const data = await api("POST", "/api/pipeline/mcp/result", {
        runId, id, name, output: text, index: idx, total: tot,
      });

      if (!data.ok) return err(data.error || "Failed to report result");
      return ok(
        "Streamed result for [" + id + "] (step " + (idx + 1) + "/" + tot + ")"
      );
    }

    case "finish_mcp_pipeline": {
      const { runId } = args || {};
      if (!runId) return err("runId is required");

      const data = await api("POST", "/api/pipeline/mcp/done", { runId });
      if (!data.ok) return err(data.error || "Failed to finalise pipeline");

      const lines = ["MCP Pipeline complete.\n"];
      for (const [id, output] of Object.entries(data.results || {})) {
        lines.push("─── " + id.toUpperCase() + " ───");
        lines.push(output);
        lines.push("");
      }
      return ok(lines.join("\n").trim());
    }

    case "get_last_results": {
      const data = await api("GET", "/api/results/last");
      if (!data.ok) return err(data.error || "Failed to retrieve results");
      if (!data.data) return ok("No pipeline run found yet. Use run_pipeline first.");

      const { task, results, completedAt } = data.data;
      const lines = [
        "Last run: " + completedAt,
        "Task: " + task,
        "",
      ];
      for (const [id, output] of Object.entries(results || {})) {
        lines.push("─── " + id.toUpperCase() + " ───");
        lines.push(output);
        lines.push("");
      }
      return ok(lines.join("\n").trim());
    }

    case "list_minions": {
      const data = await api("GET", "/api/minions");
      if (!data.ok) return err(data.error || "Failed to list minions");
      const minions = data.minions || [];
      if (minions.length === 0) return ok("No minions configured yet.");
      const lines = minions.map((m) =>
        `[${m.order ?? 0}] ${m.name} (${m.id})` +
        (m.description ? " — " + m.description : "")
      );
      return ok(lines.join("\n"));
    }

    case "create_minion": {
      const { id, name, systemPrompt, description, order, model } = args || {};
      if (!id || !name || !systemPrompt) {
        return err("id, name, and systemPrompt are required");
      }
      const data = await api("POST", "/api/minions", { id, name, systemPrompt, description, order, model });
      if (!data.ok) return err(data.error || "Failed to create minion");
      return ok("Minion created: " + data.minion.name + " (" + data.minion.id + ")");
    }

    case "delete_minion": {
      const { id } = args || {};
      if (!id) return err("id is required");
      const data = await api("DELETE", "/api/minions/" + encodeURIComponent(id));
      if (!data.ok) return err(data.error || "Failed to delete minion");
      return ok("Minion deleted: " + id);
    }

    case "get_memory": {
      const role = args?.role || null;
      const url = role ? "/api/memory?role=" + encodeURIComponent(role) : "/api/memory";
      const data = await api("GET", url);
      if (!data.ok) return err(data.error || "Failed to get memory");
      const entries = Array.isArray(data.data) ? data.data : [];
      if (entries.length === 0) return ok("Memory is empty.");
      return ok(entries.map((e) => JSON.stringify(e)).join("\n"));
    }

    case "clear_memory": {
      const body = args?.role ? { role: args.role } : {};
      const data = await api("POST", "/api/memory/clear", body);
      if (!data.ok) return err(data.error || "Failed to clear memory");
      return ok(args?.role ? "Memory cleared for: " + args.role : "All memory cleared.");
    }

    case "get_config": {
      const data = await api("GET", "/api/config");
      if (!data.ok) return err(data.error || "Failed to get config");
      const c = data.config;
      return ok(
        "Budget: " + c.budget + "\n" +
        "Max tokens: " + c.maxTokens
      );
    }

    case "set_config": {
      const patch = {};
      if (args?.budget !== undefined)    patch.budget    = args.budget;
      if (args?.maxTokens !== undefined) patch.maxTokens = args.maxTokens;
      if (Object.keys(patch).length === 0) return err("Provide at least one of: budget, maxTokens");
      const data = await api("PATCH", "/api/config", patch);
      if (!data.ok) return err(data.error || "Failed to update config");
      const c = data.config;
      return ok("Config updated — Budget: " + c.budget + ", Max tokens: " + c.maxTokens);
    }

    // ─── Browser Relay ───────────────────────────────────────────────────────

    case "browser_relay_status": {
      const data = await api("GET", "/api/browser/status");
      if (!data.ok && !("extensionConnected" in data)) return err(data.error || "Relay unreachable");
      return ok(
        "Relay server:   " + (data.ok ? "RUNNING" : "NOT REACHABLE") + "\n" +
        "Extension:      " + (data.extensionConnected ? "CONNECTED (tab attached)" : "NOT CONNECTED") + "\n" +
        (data.error ? "Error: " + data.error : "")
      );
    }

    case "browser_relay_navigate": {
      const { url } = args || {};
      if (!url) return err("url is required");
      const data = await api("POST", "/api/browser/action", { action: "navigate", params: { url } });
      if (!data.ok) return err(data.error || "Navigate failed");
      return ok("Navigated to: " + (data.data?.url || url));
    }

    case "browser_relay_snapshot": {
      const data = await api("POST", "/api/browser/action", { action: "getContent" });
      if (!data.ok) return err(data.error || "getContent failed");
      const html = data.data?.html || "";
      const truncated = html.length > 50000;
      return ok((truncated ? html.slice(0, 50000) + "\n\n[…truncated to 50 000 chars]" : html));
    }

    case "browser_relay_text": {
      const data = await api("POST", "/api/browser/action", { action: "getText" });
      if (!data.ok) return err(data.error || "getText failed");
      const text = data.data?.text || "";
      const truncated = text.length > 30000;
      return ok(truncated ? text.slice(0, 30000) + "\n\n[…truncated]" : text);
    }

    case "browser_relay_click": {
      const { selector } = args || {};
      if (!selector) return err("selector is required");
      const data = await api("POST", "/api/browser/action", { action: "click", params: { selector } });
      if (!data.ok) return err(data.error || "Click failed");
      return ok("Clicked: " + selector + " at (" + data.data?.x + ", " + data.data?.y + ")");
    }

    case "browser_relay_type": {
      const { text, selector } = args || {};
      if (text === undefined) return err("text is required");
      const data = await api("POST", "/api/browser/action", { action: "type", params: { text, selector } });
      if (!data.ok) return err(data.error || "Type failed");
      return ok("Typed: " + String(text).slice(0, 80) + (text.length > 80 ? "…" : ""));
    }

    case "browser_relay_scroll": {
      const { x = 0, y = 0, selector } = args || {};
      const data = await api("POST", "/api/browser/action", { action: "scroll", params: { x, y, selector } });
      if (!data.ok) return err(data.error || "Scroll failed");
      return ok(selector ? "Scrolled to: " + selector : "Scrolled by (" + x + ", " + y + ")");
    }

    case "browser_relay_screenshot": {
      const { format = "jpeg", quality = 80 } = args || {};
      const data = await api("POST", "/api/browser/action", { action: "screenshot", params: { format, quality } });
      if (!data.ok) return err(data.error || "Screenshot failed");
      return ok("Screenshot taken.\ndata URL (base64): " + (data.data?.dataUrl || "").slice(0, 100) + "…");
    }

    case "browser_relay_evaluate": {
      const { expression, awaitPromise = false } = args || {};
      if (!expression) return err("expression is required");
      const data = await api("POST", "/api/browser/action", { action: "evaluate", params: { expression, awaitPromise } });
      if (!data.ok) return err(data.error || "Evaluate failed");
      return ok("Result: " + JSON.stringify(data.data?.result));
    }

    case "browser_relay_get_url": {
      const data = await api("POST", "/api/browser/action", { action: "getUrl" });
      if (!data.ok) return err(data.error || "getUrl failed");
      return ok(data.data?.url || "");
    }

    case "browser_relay_get_title": {
      const data = await api("POST", "/api/browser/action", { action: "getTitle" });
      if (!data.ok) return err(data.error || "getTitle failed");
      return ok(data.data?.title || "");
    }

    case "browser_task": {
      const { perintah, maxSteps, simulateTime } = args || {};
      if (!perintah || typeof perintah !== "string" || !perintah.trim()) {
        return err("perintah is required (non-empty string)");
      }
      const data = await api("POST", "/api/browser/task", {
        perintah: perintah.trim(),
        ...(typeof maxSteps === "number" && maxSteps >= 1 && maxSteps <= 30 ? { maxSteps } : {}),
        ...(simulateTime && typeof simulateTime === "string" && simulateTime.trim() ? { simulateTime: simulateTime.trim() } : {}),
      });
      if (!data.ok) {
        const stepLog = data.steps?.length
          ? "\nSteps: " + data.steps.map((s) => `${s.step}. ${s.action} ${JSON.stringify(s.params || {})} → ${s.result || ""}`).join("; ")
          : "";
        return err((data.error || "Task failed") + stepLog);
      }
      const stepLog = data.steps?.length
        ? "\nSteps executed: " + data.steps.map((s) => `${s.step}. ${s.action}`).join(", ")
        : "";
      return ok((data.summary || "Done.") + stepLog);
    }

    case "browser_task_cdp": {
      const { perintah, maxSteps, simulateTime } = args || {};
      if (!perintah || typeof perintah !== "string" || !perintah.trim()) {
        return err("perintah is required (non-empty string)");
      }
      const data = await api("POST", "/api/browser/cdp-task", {
        perintah: perintah.trim(),
        ...(typeof maxSteps === "number" && maxSteps >= 1 && maxSteps <= 40 ? { maxSteps } : {}),
        ...(simulateTime && typeof simulateTime === "string" && simulateTime.trim() ? { simulateTime: simulateTime.trim() } : {}),
      });
      if (!data.ok) return err(data.error || "CDP task failed");
      const stepLog = data.steps?.length
        ? "\nSteps executed:\n" + data.steps.map((s) => `  ${s.step}. ${s.action}${s.params ? " " + JSON.stringify(s.params) : ""}${s.error ? " → ERROR: " + s.error : ""}${s.summary ? " → " + s.summary : ""}`).join("\n")
        : "";
      return ok((data.finalSummary || "Done.") + stepLog);
    }

    default:
      return err("Unknown tool: " + name);
  }
}

function ok(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function err(message) {
  return { content: [{ type: "text", text: "Error: " + message }], isError: true };
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "dominions", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await handleTool(name, args || {});
  } catch (e) {
    const msg = e?.message ?? String(e);
    const hint = msg.includes("ECONNREFUSED") || msg.includes("fetch failed")
      ? " (Is the Dominions server running at " + API_URL + "?)"
      : "";
    return err(msg + hint);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
