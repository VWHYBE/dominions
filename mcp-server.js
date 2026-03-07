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

      const minionsData = await api("GET", "/api/minions");
      if (!minionsData.ok) return err(minionsData.error || "Failed to fetch minions");
      const minions = minionsData.minions || [];
      if (minions.length === 0) return err("No minions configured. Add minions first.");

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

      const data = await api("POST", "/api/pipeline/mcp/result", {
        runId,
        id: minionId,
        name: minionName || minionId,
        output: String(output),
        index: index ?? 0,
        total: total ?? 1,
      });

      if (!data.ok) return err(data.error || "Failed to report result");
      return ok(
        "Streamed result for [" + minionId + "] (step " + ((index ?? 0) + 1) + "/" + (total ?? 1) + ")"
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
