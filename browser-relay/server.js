#!/usr/bin/env node
/**
 * Dominions Browser Relay Server
 *
 * Dua mode relay dalam satu server satu port:
 *
 * ── MODE A: High-level (existing browser_task) ─────────────────────────────
 *   Extension  → WS path /          (existing, ping/result/announce)
 *   Client     → POST /command      { action, params }
 *   GET /status, GET /json/list
 *
 * ── MODE B: Full CDP proxy (browser_task_cdp) ──────────────────────────────
 *   Extension  → WS path /extension-cdp  (forwardCDPCommand ↔ forwardCDPEvent)
 *   CDP client → WS path /cdp            (raw CDP: Playwright/Puppeteer)
 *   GET /json/version  (webSocketDebuggerUrl → ws://127.0.0.1:PORT/cdp)
 *
 * ENV: RELAY_PORT (default 18792)
 */

import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const PORT = Number(process.env.RELAY_PORT) || 18792;
const HOST = "127.0.0.1";
const COMMAND_TIMEOUT_MS = 30_000;
const CDP_COMMAND_TIMEOUT_MS = 30_000;
const EXTENSION_RECONNECT_GRACE_MS = 20_000;

// ─── High-level relay state ───────────────────────────────────────────────────

const pending = new Map();                         // high-level command pending
let extensionWs = null;                            // high-level extension WS
let attachedTabInfo = { tabId: null, url: null, title: null };

// ─── CDP relay state ──────────────────────────────────────────────────────────

let cdpExtWs = null;                               // CDP extension WS (/extension-cdp)
const cdpClients = new Set();                      // CDP client WSs (/cdp)
const cdpPending = new Map();                      // id → { resolve, reject, timer }
let cdpNextId = 1;

/** Playwright requires targetInfo.browserContextId; ensure it is always set. */
function normalizeTargetInfo(info) {
  if (!info || !info.targetId) return info;
  return { ...info, browserContextId: info.browserContextId || "default" };
}

// Known targets (from extension attachedToTarget events)
// sessionId → { sessionId, targetId, targetInfo }
const connectedTargets = new Map();

let cdpExtDisconnectTimer = null;

function clearCdpExtDisconnectTimer() {
  if (cdpExtDisconnectTimer) { clearTimeout(cdpExtDisconnectTimer); cdpExtDisconnectTimer = null; }
}

function scheduleCdpExtDisconnect() {
  clearCdpExtDisconnectTimer();
  cdpExtDisconnectTimer = setTimeout(() => {
    cdpExtDisconnectTimer = null;
    if (cdpExtWs?.readyState === 1) return;
    connectedTargets.clear();
    for (const ws of cdpClients) {
      try { ws.close(1011, "extension disconnected"); } catch {}
    }
    cdpClients.clear();
  }, EXTENSION_RECONNECT_GRACE_MS);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── GET /status ───────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/status") {
    // If CDP extension is up but no targets yet, prod it for an announce
    if (cdpExtWs?.readyState === 1 && connectedTargets.size === 0) {
      try { cdpExtWs.send(JSON.stringify({ method: "requestCdpAnnounce" })); } catch {}
    }
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      extensionConnected: extensionWs?.readyState === 1,
      cdpExtensionConnected: cdpExtWs?.readyState === 1,
      attachedTabId: attachedTabInfo.tabId ?? null,
      cdpTargets: Array.from(connectedTargets.values()).map((t) => ({
        sessionId: t.sessionId, targetId: t.targetId, url: t.targetInfo?.url,
      })),
      pendingCommands: pending.size,
    }));
    return;
  }

  // ── GET /json (list) ──────────────────────────────────────────────────────
  const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
  if (req.method === "GET" && listPaths.has(url.pathname)) {
    const hostHeader = req.headers.host || `${HOST}:${PORT}`;
    const cdpWsUrl = `ws://${hostHeader}/cdp`;
    const list = Array.from(connectedTargets.values()).map((t) => ({
      id: t.targetId,
      type: t.targetInfo?.type ?? "page",
      title: t.targetInfo?.title ?? "",
      description: t.targetInfo?.title ?? "",
      url: t.targetInfo?.url ?? "",
      webSocketDebuggerUrl: cdpWsUrl,
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
    }));
    // Fallback: if no CDP targets but high-level has a tab, expose it too
    if (list.length === 0 && attachedTabInfo.tabId) {
      list.push({
        id: String(attachedTabInfo.tabId), type: "page",
        title: attachedTabInfo.title ?? "", url: attachedTabInfo.url ?? "",
        webSocketDebuggerUrl: cdpWsUrl,
      });
    }
    res.writeHead(200);
    res.end(JSON.stringify(list));
    return;
  }

  // ── GET /json/version ─────────────────────────────────────────────────────
  if (req.method === "GET" && (url.pathname === "/json/version" || url.pathname === "/json/version/")) {
    const hostHeader = req.headers.host || `${HOST}:${PORT}`;
    const cdpWsUrl = `ws://${hostHeader}/cdp`;
    const payload = {
      Browser: "Dominions/CDP-Relay",
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: cdpWsUrl,
    };
    res.writeHead(200);
    res.end(JSON.stringify(payload));
    return;
  }

  // ── POST /command (high-level) ────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/command") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" })); return;
      }
      const { action, params } = parsed;
      if (!action || typeof action !== "string") {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "action (string) is required" })); return;
      }
      if (!extensionWs || extensionWs.readyState !== 1) {
        res.writeHead(503); res.end(JSON.stringify({
          ok: false, error: "Extension not connected. Load extension and click Attach on a tab.",
        })); return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        const p = pending.get(id); if (!p) return;
        pending.delete(id);
        p.reject(new Error(`Command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, timer });
        try {
          extensionWs.send(JSON.stringify({ type: "command", id, action, params: params ?? {} }));
        } catch (err) { pending.delete(id); clearTimeout(timer); reject(err); }
      })
        .then((data) => {
          if (action === "getUrl" && data?.url)    attachedTabInfo.url   = data.url;
          if (action === "getTitle" && data?.title) attachedTabInfo.title = data.title;
          if (action === "navigate" && data?.url)   attachedTabInfo.url   = data.url;
          res.writeHead(200); res.end(JSON.stringify({ ok: true, data: data ?? null }));
        })
        .catch((err) => {
          res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
        });
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

// ─── WebSocket servers ────────────────────────────────────────────────────────

const wssHighLevel   = new WebSocketServer({ noServer: true }); // /  (existing extension)
const wssExtCdp      = new WebSocketServer({ noServer: true }); // /extension-cdp
const wssCdpClients  = new WebSocketServer({ noServer: true }); // /cdp

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}`);
  const path = url.pathname;

  if (path === "/extension-cdp") {
    wssExtCdp.handleUpgrade(req, socket, head, (ws) => wssExtCdp.emit("connection", ws, req));
  } else if (path === "/cdp") {
    wssCdpClients.handleUpgrade(req, socket, head, (ws) => wssCdpClients.emit("connection", ws, req));
  } else {
    // Default: high-level extension WS (path "/" or anything else)
    wssHighLevel.handleUpgrade(req, socket, head, (ws) => wssHighLevel.emit("connection", ws, req));
  }
});

// ─── High-level extension WS handler ─────────────────────────────────────────

wssHighLevel.on("connection", (ws, req) => {
  console.log("[relay:hl] Extension connected from", req.socket.remoteAddress);
  if (extensionWs && extensionWs.readyState === 1) { extensionWs.terminate(); }
  extensionWs = ws;
  ws.send(JSON.stringify({ type: "hello", message: "Dominions relay ready" }));

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (msg.type === "announce" && msg.tabId) {
      console.log("[relay:hl] Tab announced:", msg.tabId);
      attachedTabInfo.tabId = msg.tabId;
      return;
    }
    if (msg.type === "result" && msg.id) {
      const p = pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data ?? null);
      else p.reject(new Error(msg.error || "Extension error"));
    }
  });

  ws.on("close", () => {
    console.log("[relay:hl] Extension disconnected");
    if (extensionWs === ws) extensionWs = null;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Extension disconnected"));
      pending.delete(id);
    }
  });

  ws.on("error", (err) => console.error("[relay:hl] WS error:", err.message));
});

// ─── CDP extension WS handler (/extension-cdp) ───────────────────────────────

wssExtCdp.on("connection", (ws, req) => {
  console.log("[relay:cdp-ext] CDP extension connected from", req.socket.remoteAddress);

  if (cdpExtWs && cdpExtWs.readyState === 1) {
    console.warn("[relay:cdp-ext] Previous CDP extension WS replaced");
    cdpExtWs.terminate();
  }
  cdpExtWs = ws;
  clearCdpExtDisconnectTimer();

  // Ask extension to announce attached tab so we have at least one target
  try { ws.send(JSON.stringify({ method: "requestCdpAnnounce" })); } catch {}

  // Retry announce every 2s until targets populate (covers timing races on SW startup)
  let announceRetries = 0;
  const announceRetry = setInterval(() => {
    if (connectedTargets.size > 0 || cdpExtWs !== ws || ++announceRetries >= 10) {
      clearInterval(announceRetry);
      return;
    }
    try { ws.send(JSON.stringify({ method: "requestCdpAnnounce" })); } catch {}
  }, 2000);

  // Ping keep-alive
  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ method: "ping" }));
  }, 5000);

  ws.on("message", (raw) => {
    if (cdpExtWs !== ws) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // Pong
    if (msg?.method === "pong") return;

    // Response to a pending CDP command
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const p = cdpPending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); cdpPending.delete(msg.id);
      if (msg.error) p.reject(new Error(typeof msg.error === "string" ? msg.error : (msg.error?.message || "CDP error")));
      else p.resolve(msg.result);
      return;
    }

    // CDP event forwarded from extension
    if (msg?.method === "forwardCDPEvent") {
      const { method, params, sessionId } = msg.params ?? {};
      if (!method) return;

      // Track targets
      if (method === "Target.attachedToTarget") {
        const { sessionId: sid, targetInfo } = params ?? {};
        if (sid && targetInfo?.targetId) {
          const normalized = normalizeTargetInfo(targetInfo);
          // Extension cuma attach satu tab; tab lama tidak kirim detached — buang target lain
          const newTid = normalized.targetId;
          for (const [s, t] of connectedTargets) {
            if (t.targetId !== newTid) connectedTargets.delete(s);
          }
          const isNew = !connectedTargets.has(sid);
          connectedTargets.set(sid, { sessionId: sid, targetId: normalized.targetId, targetInfo: normalized });
          if (isNew) console.log("[relay:cdp-ext] Target attached:", normalized.targetId, normalized.url);
          // Jangan broadcast duplicate — extension sering kirim ulang; Playwright throw "Duplicate target" / "Session not found"
          if (!isNew) return;
        }
      }
      if (method === "Target.detachedFromTarget") {
        const { sessionId: sid } = params ?? {};
        if (sid) connectedTargets.delete(sid);
      }
      if (method === "Target.targetInfoChanged") {
        const info = params?.targetInfo;
        if (info?.targetId) {
          for (const [sid, t] of connectedTargets) {
            if (t.targetId === info.targetId) {
              connectedTargets.set(sid, { ...t, targetInfo: { ...t.targetInfo, ...info } });
            }
          }
        }
      }
      if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
        const tid = params?.targetId;
        if (tid) {
          for (const [sid, t] of connectedTargets) {
            if (t.targetId === tid) connectedTargets.delete(sid);
          }
        }
      }

      // Broadcast event to all CDP clients (ensure targetInfo has browserContextId for Playwright)
      let outParams = params;
      if (method === "Target.attachedToTarget" && params?.targetInfo) {
        outParams = { ...params, targetInfo: normalizeTargetInfo(params.targetInfo) };
      }
      if (method === "Target.targetCreated" && params?.targetInfo) {
        outParams = { ...params, targetInfo: normalizeTargetInfo(params.targetInfo) };
      }

      // Drop events that carry a sessionId Playwright didn't negotiate.
      // Extension sub-session events (workers, iframes) arrive with session IDs
      // that only the extension knows about — forwarding them causes Playwright's
      // internal CDP assert to throw "Session with given id not found".
      if (sessionId && !connectedTargets.has(sessionId)) return;

      const evt = JSON.stringify({ method, params: outParams, ...(sessionId ? { sessionId } : {}) });
      for (const client of cdpClients) {
        if (client.readyState === 1) client.send(evt);
      }
    }
  });

  ws.on("close", () => {
    clearInterval(ping);
    clearInterval(announceRetry);
    if (cdpExtWs !== ws) return;
    cdpExtWs = null;
    for (const [, p] of cdpPending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP extension disconnected"));
    }
    cdpPending.clear();
    scheduleCdpExtDisconnect();
    console.log("[relay:cdp-ext] CDP extension disconnected");
  });

  ws.on("error", (err) => console.error("[relay:cdp-ext] WS error:", err.message));
});

// ─── CDP client WS handler (/cdp) ─────────────────────────────────────────────

/**
 * Send a CDP command to the extension and wait for response.
 */
async function sendCdpToExtension(method, params, sessionId) {
  if (!cdpExtWs || cdpExtWs.readyState !== 1) throw new Error("CDP extension not connected");
  const id = cdpNextId++;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdpPending.delete(id);
      reject(new Error(`CDP command '${method}' timed out`));
    }, CDP_COMMAND_TIMEOUT_MS);
    cdpPending.set(id, { resolve, reject, timer });
    cdpExtWs.send(JSON.stringify({
      id,
      method: "forwardCDPCommand",
      params: { method, params, ...(sessionId ? { sessionId } : {}) },
    }));
  });
}

/**
 * Route a CDP command — some methods are handled by relay directly.
 */
async function routeCdpCommand(cmd) {
  const { method, params = {}, sessionId } = cmd;
  switch (method) {
    case "Browser.getVersion":
      return { protocolVersion: "1.3", product: "Chrome/Dominions-CDP-Relay", revision: "0", userAgent: "Dominions-CDP-Relay", jsVersion: "V8" };
    case "Browser.setDownloadBehavior":
      return {};
    case "Target.setAutoAttach":
    case "Target.setDiscoverTargets":
      return {};
    case "Target.getTargets":
      return { targetInfos: Array.from(connectedTargets.values()).map((t) => ({ ...normalizeTargetInfo(t.targetInfo), attached: true })) };
    case "Target.getTargetInfo": {
      const tid = params?.targetId;
      const found = tid
        ? Array.from(connectedTargets.values()).find((t) => t.targetId === tid)
        : Array.from(connectedTargets.values())[0];
      return { targetInfo: found ? normalizeTargetInfo(found.targetInfo) : undefined };
    }
    case "Target.attachToTarget": {
      const tid = params?.targetId;
      const found = Array.from(connectedTargets.values()).find((t) => t.targetId === tid);
      if (!found) throw new Error("Target not found: " + tid);
      return { sessionId: found.sessionId };
    }
    default:
      return await sendCdpToExtension(method, params, sessionId);
  }
}

wssCdpClients.on("connection", (ws) => {
  cdpClients.add(ws);
  console.log("[relay:cdp-client] CDP client connected (total:", cdpClients.size, ")");

  // Ask extension to announce attached tab so we have a target for this client
  if (cdpExtWs?.readyState === 1) {
    try { cdpExtWs.send(JSON.stringify({ method: "requestCdpAnnounce" })); } catch {}
  }

  ws.on("message", async (raw) => {
    let cmd; try { cmd = JSON.parse(raw); } catch { return; }
    if (!cmd || typeof cmd.id !== "number" || typeof cmd.method !== "string") return;

    if (!cdpExtWs || cdpExtWs.readyState !== 1) {
      ws.send(JSON.stringify({ id: cmd.id, sessionId: cmd.sessionId, error: { message: "CDP extension not connected" } }));
      return;
    }

    // If client asks for targets but we have none, request announce and wait for extension
    if ((cmd.method === "Target.setDiscoverTargets" || cmd.method === "Target.setAutoAttach") && connectedTargets.size === 0) {
      for (let i = 0; i < 4 && connectedTargets.size === 0; i++) {
        try { cdpExtWs.send(JSON.stringify({ method: "requestCdpAnnounce" })); } catch {}
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    try {
      const result = await routeCdpCommand(cmd);

      // Kirim target ke client kalau relay sudah punya (dari extension). Tanpa ini
      // client kadang tidak dapat target (extension announce timing).
      if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId && connectedTargets.size > 0) {
        for (const t of connectedTargets.values()) {
          const ti = normalizeTargetInfo(t.targetInfo);
          ws.send(JSON.stringify({
            method: "Target.attachedToTarget",
            params: { sessionId: t.sessionId, targetInfo: { ...ti, attached: true }, waitingForDebugger: false },
          }));
        }
      }

      ws.send(JSON.stringify({ id: cmd.id, ...(cmd.sessionId ? { sessionId: cmd.sessionId } : {}), result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: cmd.id, ...(cmd.sessionId ? { sessionId: cmd.sessionId } : {}), error: { message: err.message } }));
    }
  });

  ws.on("close", () => {
    cdpClients.delete(ws);
    console.log("[relay:cdp-client] CDP client disconnected (remaining:", cdpClients.size, ")");
  });

  ws.on("error", (err) => console.error("[relay:cdp-client] WS error:", err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, HOST, () => {
  console.log(`\n[relay] Dominions Browser Relay running on ${HOST}:${PORT}`);
  console.log(`[relay]   ── High-level ──────────────────────────────────────`);
  console.log(`[relay]   POST /command          → high-level action`);
  console.log(`[relay]   GET  /status           → relay + extension status`);
  console.log(`[relay]   GET  /json/list        → attached tab info`);
  console.log(`[relay]   WS   /                → extension (high-level)`);
  console.log(`[relay]   ── Full CDP Proxy ─────────────────────────────────`);
  console.log(`[relay]   GET  /json/version     → Playwright/Puppeteer endpoint`);
  console.log(`[relay]   WS   /extension-cdp   → extension (CDP mode)`);
  console.log(`[relay]   WS   /cdp             → CDP clients (Playwright)\n`);
});

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[relay] Port ${PORT} in use. Set RELAY_PORT= in .env`);
  } else {
    console.error("[relay] Server error:", err.message);
  }
  process.exit(1);
});
