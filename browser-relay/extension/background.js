/**
 * Dominions Browser Relay — Chrome Extension Background (Service Worker, MV3)
 *
 * Dua mode relay:
 *
 * ── MODE A: High-level (/  path) ──────────────────────────────────────────────
 *   Opsi-B improvements:
 *   - persistState / rehydrateState: tab survive MV3 service worker restart
 *   - re-attach on navigation: auto retry after debugger detach (max 5 attempts)
 *   - reconnect backoff: 3s → 48s
 *   - re-announce on reconnect
 *   - keepalive alarm tiap 30s
 *
 * ── MODE B: Full CDP proxy (/extension-cdp path) ──────────────────────────────
 *   - Separate WS to relay /extension-cdp
 *   - Receive forwardCDPCommand → chrome.debugger.sendCommand → reply
 *   - Forward chrome.debugger.onEvent → forwardCDPEvent
 *   - Handle Target.attachedToTarget on attach to report targets
 *
 * Protocol (relay → background → relay):
 *   IN:  { type:"command", id, action, params }
 *   OUT: { type:"result",  id, ok, data? }  or  { type:"result", id, ok:false, error }
 *   EXT: { type:"announce", tabId } → extension → relay
 */

const RELAY_URL        = "ws://127.0.0.1:18792";
const RELAY_CDP_URL    = "ws://127.0.0.1:18792/extension-cdp";
const PING_INTERVAL_MS = 20_000;
const ATTACHED_KEY     = "dominions_attached_tab";
const REATTACH_DELAYS  = [200, 500, 1000, 2000, 4000]; // backoff ms per attempt

let ws              = null;
let attachedTabId   = null;
let pingTimer       = null;
let reconnectTimer  = null;
let reconnectAttempt = 0;

// Guard: prevent concurrent re-attach attempts for the same tab
const reattachPending = new Set();

// ─── Reconnect (exponential backoff) ─────────────────────────────────────────

function reconnectDelayMs(attempt) {
  return Math.min(3000 * 2 ** attempt, 48_000);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt++;
  console.log(`[bg] Relay reconnect in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(RELAY_URL);

  ws.onopen = () => {
    console.log("[bg] Relay connected");
    cancelReconnect();
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);
    broadcastStatus();
    // Re-announce tab ke relay supaya relay tahu tab mana yang attached
    void reannounceAttachedTab();
    // CDP socket only after relay is up — avoids ERR_CONNECTION_REFUSED on load when relay is down
    connectCdp();
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "pong") return;

    if (msg.type === "command" && msg.id) {
      const result = await handleCommand(msg.action, msg.params ?? {});
      ws.send(JSON.stringify({ type: "result", id: msg.id, ...result }));
    }
  };

  ws.onclose = () => {
    console.log("[bg] Relay disconnected — scheduling reconnect");
    ws = null;
    clearInterval(pingTimer);
    pingTimer = null;
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose fires after onerror */ };
}

// ─── Re-announce: kirim ke relay bahwa tab X masih attached ──────────────────

async function reannounceAttachedTab() {
  if (!attachedTabId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Verifikasi debugger masih attached
  try {
    await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Runtime.evaluate", {
      expression: "1",
      returnByValue: true,
    });
  } catch {
    // Debugger sudah tidak attached; clear state
    attachedTabId = null;
    await chrome.storage.local.remove(ATTACHED_KEY);
    broadcastStatus();
    return;
  }

  try {
    ws.send(JSON.stringify({ type: "announce", tabId: attachedTabId }));
    console.log("[bg] Re-announced tab", attachedTabId, "to relay");
  } catch {
    // WS mungkin sudah tutup di antara cek
  }
}

// ─── CDP helper ───────────────────────────────────────────────────────────────

async function cdp(method, params = {}) {
  if (!attachedTabId) throw new Error("No tab attached. Click the Dominions extension icon to attach a tab.");
  return chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params);
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleCommand(action, params) {
  try {
    let data = null;

    switch (action) {

      // ── Navigate ─────────────────────────────────────────────────────────
      case "navigate": {
        const { url } = params;
        if (!url) throw new Error("url is required");
        await cdp("Page.navigate", { url });
        await waitMs(1500);
        data = { url };
        break;
      }

      // ── Get full HTML ─────────────────────────────────────────────────────
      case "getContent": {
        const r = await cdp("Runtime.evaluate", {
          expression: "document.documentElement.outerHTML",
          returnByValue: true,
        });
        data = { html: r.result?.value ?? "" };
        break;
      }

      // ── Get visible text ──────────────────────────────────────────────────
      case "getText": {
        const r = await cdp("Runtime.evaluate", {
          expression: "document.body.innerText",
          returnByValue: true,
        });
        data = { text: r.result?.value ?? "" };
        break;
      }

      // ── Current URL ───────────────────────────────────────────────────────
      case "getUrl": {
        const r = await cdp("Runtime.evaluate", {
          expression: "window.location.href",
          returnByValue: true,
        });
        data = { url: r.result?.value ?? "" };
        break;
      }

      // ── Page title ────────────────────────────────────────────────────────
      case "getTitle": {
        const r = await cdp("Runtime.evaluate", {
          expression: "document.title",
          returnByValue: true,
        });
        data = { title: r.result?.value ?? "" };
        break;
      }

      // ── Reload page ────────────────────────────────────────────────────────
      case "refresh": {
        await cdp("Page.reload");
        await waitMs(1500);
        data = { refreshed: true };
        break;
      }

      // ── Screenshot (base64 JPEG) ──────────────────────────────────────────
      case "screenshot": {
        const r = await cdp("Page.captureScreenshot", {
          format: params.format ?? "jpeg",
          quality: params.quality ?? 80,
        });
        data = { dataUrl: "data:image/jpeg;base64," + r.data };
        break;
      }

      // ── Click by CSS selector ─────────────────────────────────────────────
      case "click": {
        const { selector } = params;
        if (!selector) throw new Error("selector is required");
        const r = await cdp("Runtime.evaluate", {
          expression: `(function(){
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { found: false };
            el.scrollIntoView({ block: "center", behavior: "instant" });
            const rect = el.getBoundingClientRect();
            return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`,
          returnByValue: true,
        });
        const { found, x, y } = r.result?.value ?? {};
        if (!found) throw new Error(`Element not found: ${selector}`);
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        await waitMs(300);
        data = { clicked: selector, x, y };
        break;
      }

      // ── Type text at focused element ──────────────────────────────────────
      case "type": {
        const { text, selector } = params;
        if (text === undefined) throw new Error("text is required");
        if (selector) {
          await cdp("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(selector)})?.focus()`,
            returnByValue: false,
          });
          await waitMs(100);
        }
        await cdp("Input.insertText", { text: String(text) });
        data = { typed: text };
        break;
      }

      // ── Scroll page ───────────────────────────────────────────────────────
      case "scroll": {
        const { x = 0, y = 0, selector } = params;
        if (selector) {
          await cdp("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ behavior:"smooth", block:"center" })`,
            returnByValue: false,
          });
        } else {
          await cdp("Runtime.evaluate", {
            expression: `window.scrollBy(${Number(x)}, ${Number(y)})`,
            returnByValue: false,
          });
        }
        await waitMs(300);
        data = { scrolledBy: { x, y }, scrolledTo: selector };
        break;
      }

      // ── Evaluate arbitrary JS ─────────────────────────────────────────────
      case "evaluate": {
        const { expression } = params;
        if (!expression) throw new Error("expression is required");
        const r = await cdp("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: params.awaitPromise ?? false,
        });
        data = { result: r.result?.value };
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ─── Persist / rehydrate state ────────────────────────────────────────────────

async function persistState() {
  try {
    if (attachedTabId) {
      await chrome.storage.local.set({ [ATTACHED_KEY]: attachedTabId });
    } else {
      await chrome.storage.local.remove(ATTACHED_KEY);
    }
  } catch {
    // storage may fail in some contexts
  }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.local.get(ATTACHED_KEY);
    const tabId = stored[ATTACHED_KEY];
    if (!tabId) return;

    // Verify tab masih ada
    try {
      await chrome.tabs.get(tabId);
    } catch {
      await chrome.storage.local.remove(ATTACHED_KEY);
      return;
    }

    // Verify debugger masih attached (simple probe)
    try {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true,
      });
      attachedTabId = tabId;
      console.log("[bg] Rehydrated: tab", tabId, "still attached");
    } catch {
      // Debugger tidak attached lagi; bersihkan saja (tidak re-attach — user harus manual)
      await chrome.storage.local.remove(ATTACHED_KEY);
    }
  } catch {
    // Ignore rehydration errors
  }
}

// ─── Attach / detach ──────────────────────────────────────────────────────────

async function attachTab(tabId, opts = {}) {
  if (attachedTabId && attachedTabId !== tabId) {
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch { /* already detached */ }
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  attachedTabId = tabId;
  await persistState();
  console.log("[bg] Attached to tab", tabId);

  // Announce ke relay (skip kalau diminta, mis. saat relay belum konek)
  if (!opts.skipAnnounce && ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "announce", tabId }));
    } catch { /* ignore */ }
  }

  // Announce ke CDP relay juga (supaya cdpTargets terisi)
  void reannounceAsCdpTarget();
  // Kalau CDP socket belum open, buka supaya begitu open kita kirim target (dari cdpWs.onopen)
  if (!isCdpOpen()) connectCdp();

  broadcastStatus();
}

async function detachTab() {
  if (!attachedTabId) return;
  try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch { /* already detached */ }
  const prev = attachedTabId;
  attachedTabId = null;
  await persistState();
  console.log("[bg] Detached from tab", prev);
  broadcastStatus();
}

async function toggleAttach(tabId) {
  if (attachedTabId === tabId) {
    await detachTab();
  } else {
    await attachTab(tabId);
  }
}

// ─── Re-attach after navigation ───────────────────────────────────────────────

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!tabId || tabId !== attachedTabId) return;

  console.log("[bg] Debugger detached:", reason, "— tab", tabId);

  // User/DevTools override: respect intent, clean up
  if (reason === "canceled_by_user" || reason === "replaced_with_devtools") {
    attachedTabId = null;
    void persistState();
    broadcastStatus();
    return;
  }

  // Navigation or other transient detach: attempt re-attach with backoff
  if (reattachPending.has(tabId)) return;
  reattachPending.add(tabId);

  attachedTabId = null;

  void (async () => {
    for (let i = 0; i < REATTACH_DELAYS.length; i++) {
      await waitMs(REATTACH_DELAYS[i]);

      if (!reattachPending.has(tabId)) return; // cancelled

      // Confirm tab still exists
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
          break; // cannot attach to chrome:// pages
        }
      } catch {
        break; // tab closed
      }

      try {
        await attachTab(tabId, { skipAnnounce: !(ws?.readyState === WebSocket.OPEN) });
        reattachPending.delete(tabId);
        console.log("[bg] Re-attached to tab", tabId, "after", REATTACH_DELAYS[i], "ms");
        return;
      } catch {
        // retry
      }
    }

    reattachPending.delete(tabId);
    await persistState();
    broadcastStatus();
    console.warn("[bg] Re-attach failed for tab", tabId);
  })();
});

// ─── Tab closed: clean up ─────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  reattachPending.delete(tabId);
  if (tabId !== attachedTabId) return;
  attachedTabId = null;
  void persistState();
  broadcastStatus();
});

// ─── Status broadcast to popup ────────────────────────────────────────────────

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "status",
    relayConnected: ws?.readyState === WebSocket.OPEN,
    attachedTabId,
  }).catch(() => {}); // popup may be closed — that's fine
}

// ─── Messages from popup ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getStatus") {
    sendResponse({
      relayConnected: ws?.readyState === WebSocket.OPEN,
      attachedTabId,
    });
    return true;
  }

  if (msg.type === "toggleAttach") {
    toggleAttach(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ─── Keepalive alarm (tiap 30 detik) ─────────────────────────────────────────

chrome.alarms.create("relay-keepalive", { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "relay-keepalive") return;
  await initPromise; // tunggu rehydrate selesai

  // Relay down dan tidak ada reconnect → trigger reconnect
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (!reconnectTimer) {
      console.log("[bg] Keepalive: relay down, triggering reconnect");
      scheduleReconnect();
    }
  }

  broadcastStatus();
});

// ─── Utility ─────────────────────────────────────────────────────────────────

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CDP Proxy Mode (/extension-cdp) ─────────────────────────────────────────

let cdpWs = null;
let cdpReconnectTimer = null;
let cdpReconnectAttempt = 0;

function cdpReconnectDelayMs(attempt) {
  return Math.min(3000 * 2 ** attempt, 48_000);
}

function isCdpOpen() {
  try { return !!(cdpWs && cdpWs.readyState === 1); } catch { return false; }
}

function connectCdp() {
  // Jangan baca cdpWs.readyState — di service worker bisa throw. Tutup saja yang lama lalu buat baru.
  if (cdpWs) {
    try { cdpWs.close(); } catch (_) {}
    cdpWs = null;
  }

  cdpWs = new WebSocket(RELAY_CDP_URL);

  cdpWs.onopen = () => {
    console.log("[bg-cdp] CDP relay connected");
    cdpReconnectAttempt = 0;
    if (cdpReconnectTimer) { clearTimeout(cdpReconnectTimer); cdpReconnectTimer = null; }
    // Re-announce attached tab as CDP target if any
    void reannounceAsCdpTarget();
  };

  cdpWs.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg?.method === "ping") {
      try { cdpWs.send(JSON.stringify({ method: "pong" })); } catch {}
      return;
    }
    if (msg?.method === "requestCdpAnnounce") {
      await reannounceAsCdpTarget();
      return;
    }
    if (typeof msg.id === "number" && msg.method === "forwardCDPCommand") {
      await handleCdpCommand(msg);
    }
  };

  cdpWs.onclose = (event) => {
    console.log("[bg-cdp] CDP relay disconnected");
    cdpWs = null;
    if (event?.code === 1006 || event?.code === 1001) {
      console.warn("[bg-cdp] Relay not running? Start with: npm run relay");
    }
    // Only reconnect if relay high-level WS is up.
    // If relay is fully down, ws.onopen will call connectCdp() once it's back.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      cdpReconnectAttempt = 0; // reset so next connection after relay-up is fast
      return;
    }
    const delay = cdpReconnectDelayMs(cdpReconnectAttempt++);
    cdpReconnectTimer = setTimeout(connectCdp, delay);
  };

  cdpWs.onerror = () => {
    // Connection refused etc.; onclose will run after and log hint
  };
}

/**
 * Re-announce attached tab to CDP relay as a Target.attachedToTarget event.
 * Uses chrome.tabs.get (Target.getTargetInfo may not be available when attached to tab).
 */
async function reannounceAsCdpTarget() {
  if (!attachedTabId) return;
  if (!isCdpOpen()) return;

  let tab;
  try {
    tab = await chrome.tabs.get(attachedTabId);
  } catch (err) {
    console.warn("[bg-cdp] reannounceAsCdpTarget: tab", attachedTabId, "not found —", err.message);
    // Tab no longer exists; clean up so status stays consistent
    attachedTabId = null;
    await persistState();
    broadcastStatus();
    return;
  }

  // Re-check cdpWs after the async tabs.get call
  if (!isCdpOpen()) return;

  const sessionId = `dom-tab-${attachedTabId}`;
  const targetInfo = {
    targetId: String(attachedTabId),
    type: "page",
    title: tab.title ?? "",
    url: tab.url ?? "",
    attached: true,
    browserContextId: "default",
  };
  try {
    cdpWs.send(JSON.stringify({
      method: "forwardCDPEvent",
      params: {
        method: "Target.attachedToTarget",
        params: { sessionId, targetInfo, waitingForDebugger: false },
      },
    }));
    console.log("[bg-cdp] Re-announced tab", attachedTabId, "as CDP target");
  } catch (err) {
    console.warn("[bg-cdp] reannounceAsCdpTarget send failed:", err.message);
  }
}

/**
 * Execute a CDP command forwarded from relay, reply back.
 */
async function handleCdpCommand(msg) {
  const method = String(msg?.params?.method || "").trim();
  const params = msg?.params?.params ?? {};
  const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : undefined;

  const tabId = attachedTabId;
  if (!tabId) {
    trySendCdp({ id: msg.id, error: "No tab attached" });
    return;
  }

  const debuggee = sessionId ? { tabId, sessionId } : { tabId };

  try {
    // Some methods need special handling
    if (method === "Runtime.enable") {
      try { await chrome.debugger.sendCommand({ tabId }, "Runtime.disable"); await waitMs(50); } catch {}
    }

    const result = await chrome.debugger.sendCommand(debuggee, method, params);
    trySendCdp({ id: msg.id, result: result ?? {} });
  } catch (err) {
    trySendCdp({ id: msg.id, error: err.message || String(err) });
  }
}

function trySendCdp(payload) {
  if (!isCdpOpen()) return;
  try { cdpWs.send(JSON.stringify(payload)); } catch {}
}

/**
 * Forward a CDP event from chrome.debugger to relay.
 */
function forwardCdpEvent(tabId, method, params, sessionId) {
  if (!isCdpOpen()) return;
  if (!attachedTabId || tabId !== attachedTabId) return;
  trySendCdp({
    method: "forwardCDPEvent",
    params: { method, params, ...(sessionId ? { sessionId } : {}) },
  });
}

// Forward all debugger events to CDP relay
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId || tabId !== attachedTabId) return;
  forwardCdpEvent(tabId, method, params, source.sessionId);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

const initPromise = rehydrateState().then(() => {
  connect();
  // connectCdp() is called from ws.onopen so we only open CDP when relay is reachable
});
