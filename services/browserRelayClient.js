/**
 * Dominions Browser Relay Client
 *
 * Sends commands to the relay server (browser-relay/server.js) which forwards
 * them to the Chrome extension attached to the user's active tab.
 *
 * The relay server must be running: npm run relay
 *
 * ENV:
 *   BROWSER_RELAY_URL  (default: http://127.0.0.1:18792)
 */

const RELAY_URL         = (process.env.BROWSER_RELAY_URL || "http://127.0.0.1:18792").replace(/\/$/, "");
const DEFAULT_TIMEOUT   = 30_000;
const CONN_REFUSED_HINT = " (Is the relay running? Start it with: npm run relay)";

// ─── Core ─────────────────────────────────────────────────────────────────────

async function sendCommand(action, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(`${RELAY_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params }),
      signal: controller.signal,
    });
    return res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: `Relay command '${action}' timed out after ${DEFAULT_TIMEOUT}ms` };
    }
    const hint = err.message?.includes("ECONNREFUSED") ? CONN_REFUSED_HINT : "";
    return { ok: false, error: (err.message || String(err)) + hint };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

/** Check if relay server is up and extension is connected. */
export async function status() {
  try {
    const res = await fetch(`${RELAY_URL}/status`);
    return res.json();
  } catch (err) {
    const hint = err.message?.includes("ECONNREFUSED") ? CONN_REFUSED_HINT : "";
    return { ok: false, extensionConnected: false, error: (err.message || String(err)) + hint };
  }
}

// ─── Navigation ──────────────────────────────────────────────────────────────

/** Navigate the attached tab to a URL. */
export const navigate = (url) => sendCommand("navigate", { url });

/** Get current URL of attached tab. */
export const getUrl = () => sendCommand("getUrl");

/** Reload the attached tab (refresh page). */
export const refresh = () => sendCommand("refresh");

/** Get page title of attached tab. */
export const getTitle = () => sendCommand("getTitle");

// ─── Content ─────────────────────────────────────────────────────────────────

/** Get full HTML of the page. */
export const getContent = () => sendCommand("getContent");

/** Get visible text of the page. */
export const getText = () => sendCommand("getText");

// ─── Interaction ─────────────────────────────────────────────────────────────

/**
 * Click an element by CSS selector.
 * @param {string} selector CSS selector
 */
export const click = (selector) => sendCommand("click", { selector });

/**
 * Type text at the currently focused element (optionally focus first).
 * @param {string} text        Text to type
 * @param {string} [selector]  Optional CSS selector to focus before typing
 */
export const type = (text, selector) => sendCommand("type", { text, selector });

/**
 * Scroll the page or scroll an element into view.
 * @param {number} [x=0]       Horizontal pixels to scroll
 * @param {number} [y=0]       Vertical pixels to scroll
 * @param {string} [selector]  Scroll element into view instead of scrollBy
 */
export const scroll = (x = 0, y = 0, selector) => sendCommand("scroll", { x, y, selector });

// ─── Capture ─────────────────────────────────────────────────────────────────

/**
 * Take a screenshot. Returns { ok, data: { dataUrl } } — dataUrl is base64 JPEG.
 * @param {"jpeg"|"png"} [format="jpeg"]
 * @param {number}       [quality=80]
 */
export const screenshot = (format = "jpeg", quality = 80) =>
  sendCommand("screenshot", { format, quality });

// ─── Advanced ─────────────────────────────────────────────────────────────────

/**
 * Evaluate arbitrary JavaScript in the page context.
 * @param {string}  expression         JS to evaluate
 * @param {boolean} [awaitPromise=false] Await a returned Promise
 */
export const evaluate = (expression, awaitPromise = false) =>
  sendCommand("evaluate", { expression, awaitPromise });

// ─── Default export (all helpers) ────────────────────────────────────────────

export default {
  status,
  navigate,
  getUrl,
  getTitle,
  getContent,
  getText,
  click,
  type,
  scroll,
  screenshot,
  evaluate,
  refresh,
};
