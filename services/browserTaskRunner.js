/**
 * Browser Task Runner — menjalankan perintah natural language via relay + LLM.
 *
 * Alur: ambil daftar elemen interaktif dari halaman (selector asli) → LLM pilih dari daftar itu
 * → eksekusi aksi lewat browserRelay → ulangi. Dinamis: apa yang di-serve halaman, itu yang bisa diklik/isi.
 */

import * as browserRelay from "./browserRelayClient.js";
import * as llm from "../llm.js";
import { getConfig } from "../configManager.js";

const MAX_PAGE_TEXT = 10_000;
const MAX_ELEMENTS = 80;
const DEFAULT_MAX_STEPS = 15;

const SYSTEM_PROMPT = `You are a browser automation assistant. You will receive:
1) The user's task
2) Current page URL and title
3) Page text (excerpt)
4) A list of INTERACTIVE ELEMENTS with their exact "selector" and short "label"

CRITICAL: For "click" and "type" you MUST use ONLY a "selector" from that list. Do not invent selectors.
If you need to click an input/button, find the best-matching item in the list by label/placeholder/text and use its selector.
After clicking a search/destination input, use "type" in the NEXT step to enter the text (e.g. city name). Do not repeat the same click; vary actions (click once then type, or scroll, or pick date).
For hotel search: click destination input once, then immediately output type with the city name (e.g. Bandung), then set check-in date.

For DATE/TANGGAL: To set a date (e.g. 25 Maret 2026): First click the date input to open the calendar. Next step pick an element whose label is the day number (e.g. 25). If you need another month, click next/arrow element from the list first, then the day.

Output exactly ONE action as JSON (only this format):
- navigate     — { "action": "navigate", "params": { "url": "https://..." } }
- click        — { "action": "click", "params": { "selector": "selector from the list" } }
- type         — { "action": "type", "params": { "text": "string to type", "selector": "selector from the list" } }
- scroll       — { "action": "scroll", "params": { "y": 400 } or { "selector": "from list" } }
- refresh      — { "action": "refresh" }  (reload page; use before sale opens to get fresh DOM)
- wait_seconds — { "action": "wait_seconds", "params": { "seconds": 60 } }  (wait N seconds, then next step)
- done        — { "action": "done", "params": { "summary": "what was done" } }

For TICKET SALE / WAR at a specific time (e.g. 15:52 or 4.25): Use "Current time" from the message. You CAN use refresh and wait_seconds — they do NOT need a selector. Do wait_seconds (e.g. 60) then refresh every minute; in the last minute before the target time do refresh then immediately click the sale button (e.g. General Sale). Then click the section (e.g. blue) — pick the element whose label contains "General Sale", "BLUE", or the section name. Disabled buttons are still in the list; use the selector whose label matches.
In the selector value use single quotes for attribute values to keep JSON valid, e.g. [data-dominions-id='d5'] not [data-dominions-id="d5"].
Reply with ONLY the JSON object, no markdown. Use only selectors from the provided elements list for click/type.`;

/** Script run in page to collect interactive elements and return selectors + labels. */
const GET_ELEMENTS_SCRIPT = `
(function(){
  var out = [];
  var seen = {};
  function add(el, labelExtra) {
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    var label = labelExtra || (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('data-date') || el.value || el.textContent || '').trim().slice(0, 60);
    var selector = null;
    if (el.id && /^[a-zA-Z][\\w-]*$/.test(el.id)) selector = '#' + el.id;
    else if (el.getAttribute('data-testid')) selector = '[data-testid="' + el.getAttribute('data-testid').replace(/"/g, '\\\\"') + '"]';
    else if (el.getAttribute('data-date')) selector = '[data-date="' + String(el.getAttribute('data-date')).replace(/"/g, '\\\\"') + '"]';
    else if (el.name && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) selector = el.tagName.toLowerCase() + '[name="' + el.name.replace(/"/g, '\\\\"') + '"]';
    else if (el.placeholder) selector = el.tagName.toLowerCase() + '[placeholder="' + String(el.placeholder).replace(/"/g, '\\\\"').slice(0, 80) + '"]';
    else if (el.getAttribute('role') === 'gridcell' && el.getAttribute('data-dominions-id') === null) { el.setAttribute('data-dominions-id', 'cal' + out.length); selector = "[data-dominions-id='cal" + (out.length) + "']"; }
    if (!selector) {
      el.setAttribute('data-dominions-id', 'd' + out.length);
      selector = "[data-dominions-id='d" + out.length + "']";
    }
    var key = selector + '|' + label;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ selector: selector, tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(), name: el.name || '', placeholder: (el.placeholder || '').slice(0, 50), label: label });
  }
  var sel = document.querySelectorAll('input, select, textarea, button, a[href], [role="button"], [role="link"], [data-testid], [onclick], [tabindex="0"]');
  for (var i = 0; i < sel.length && out.length < 100; i++) add(sel[i]);
  var cal = document.querySelectorAll('[role="gridcell"], [role="option"], [data-date], [data-day], td[data-date], .calendar-day, .day, [class*="Day"], [class*="day"]');
  for (var j = 0; j < cal.length && out.length < 100; j++) {
    var c = cal[j];
    var t = (c.textContent || '').trim();
    if (t && /^\\d{1,2}$/.test(t)) add(c, t);
    else if (c.getAttribute('data-date')) add(c, c.getAttribute('data-date'));
    else if (c.getAttribute('data-day')) add(c, c.getAttribute('data-day'));
    else if (t.length <= 4) add(c, t);
  }
  return out;
})()
`;

/**
 * Get list of interactive elements from the current page (run in browser).
 * @returns {Promise<Array<{ selector: string, tag: string, type: string, name: string, placeholder: string, label: string }>>}
 */
async function getInteractiveElements() {
  const res = await browserRelay.evaluate(GET_ELEMENTS_SCRIPT, false);
  if (!res.ok || !Array.isArray(res.data?.result)) return [];
  return res.data.result;
}

/**
 * Parse JSON from LLM response (may be wrapped in markdown or have trailing text).
 * Returns { action, params } or null.
 */
function parseActionJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let slice = s.slice(start, end + 1);

  // Fix selector: [attr="value"] or [attr=\"value\"] -> [attr='value']
  slice = slice.replace(/\[([\w-]+)=(\\?)"([^"]*)\2"\]/g, "[$1='$3']");
  slice = slice.replace(/\[data-dominions-id="d(\d+)"\]/g, "[data-dominions-id='d$1']");
  slice = slice.replace(/\[data-dominions-id="cal(\d+)"\]/g, "[data-dominions-id='cal$1']");
  slice = slice.replace(/\[data-testid=\\"([^"]+)\\"\]/g, "[data-testid='$1']");
  slice = slice.replace(/\[data-testid="([^"]+)"\]/g, "[data-testid='$1']");
  slice = slice.replace(/\[data-date="([^"]+)"\]/g, "[data-date='$1']");
  slice = slice.replace(/\[name="([^"]+)"\]/g, "[name='$1']");
  slice = slice.replace(/\[placeholder="([^"]*)"\]/g, "[placeholder='$1']");

  let obj;
  try {
    obj = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  // Format 1: { action: "click", params: { selector: "..." } }
  if (obj.action && typeof obj.action === "string") {
    return { action: obj.action, params: obj.params || {} };
  }

  // Format 2: { click: { selector: "..." } }, { navigate: { url: "..." } }, etc.
  const actionKeys = ["navigate", "click", "type", "scroll", "refresh", "wait_seconds", "done"];
  for (const key of actionKeys) {
    if (key in obj && obj[key] != null) {
      const params = typeof obj[key] === "object" && !Array.isArray(obj[key]) ? obj[key] : {};
      return { action: key, params };
    }
  }
  return null;
}

/**
 * Parse simulateTime "HH:mm" or "H.mm" into today's date at that time (WIB).
 * @param {string} [simulateTime]
 * @returns {Date}
 */
function getSimulatedNow(simulateTime) {
  if (!simulateTime || typeof simulateTime !== "string") return new Date();
  const s = simulateTime.trim().replace(".", ":");
  const parts = s.split(":");
  const hour = Math.min(23, Math.max(0, parseInt(parts[0], 10) || 0));
  const min = Math.min(59, Math.max(0, parseInt(parts[1], 10) || 0));
  const todayWIB = new Date().toLocaleString("en-CA", { timeZone: "Asia/Jakarta" }).slice(0, 10);
  return new Date(`${todayWIB}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00+07:00`);
}

/**
 * Execute one action via relay. Returns { ok, error? }.
 */
async function executeAction(action, params) {
  switch (action) {
    case "navigate": {
      const r = await browserRelay.navigate(params?.url);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "click": {
      const r = await browserRelay.click(params?.selector);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "type": {
      const r = await browserRelay.type(params?.text, params?.selector);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "scroll": {
      const r = await browserRelay.scroll(params?.x, params?.y, params?.selector);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "refresh": {
      const r = await browserRelay.refresh();
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "wait_seconds": {
      const sec = Math.min(120, Math.max(0, Number(params?.seconds) || 0));
      await new Promise((r) => setTimeout(r, sec * 1000));
      return { ok: true };
    }
    case "done":
      return { ok: true, done: true };
    default:
      return { ok: false, error: "Unknown action: " + action };
  }
}

/**
 * Run a natural-language browser task.
 * @param {string} perintah — User task (e.g. "Buka tiket.com, cari kereta 5 Maret 2026")
 * @param {{ maxSteps?: number, simulateTime?: string }} [options]
 *   simulateTime: "HH:mm" or "H.mm" (e.g. "15:51") to simulate current time for ticket war.
 * @returns {Promise<{ ok: boolean; summary?: string; steps?: Array<{ step: number; action: string; params?: object; result?: string }>; error?: string }>}
 */
export async function runTask(perintah, options = {}) {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const simulateTime = options.simulateTime;
  const steps = [];

  const statusRes = await browserRelay.status();
  if (!statusRes.extensionConnected) {
    return { ok: false, error: "Browser relay extension not connected. Attach a tab first." };
  }

  if (!llm.isConfigured()) {
    return { ok: false, error: "LLM not configured (OpenRouter or Ollama). Set API keys in .env." };
  }

  const config = await getConfig();
  const maxTokens = config?.maxTokens ?? 4096;

  let didTypeCityOverride = false;

  for (let step = 1; step <= maxSteps; step++) {
    let url = "";
    let title = "";
    let pageText = "";
    let elementsList = [];

    const urlRes = await browserRelay.getUrl();
    if (urlRes.ok && urlRes.data?.url) url = urlRes.data.url;
    const titleRes = await browserRelay.getTitle();
    if (titleRes.ok && titleRes.data?.title) title = titleRes.data.title;
    const textRes = await browserRelay.getText();
    if (textRes.ok && textRes.data?.text) {
      pageText = String(textRes.data.text).slice(0, MAX_PAGE_TEXT);
      if (textRes.data.text.length > MAX_PAGE_TEXT) pageText += "\n[... truncated]";
    }

    try {
      elementsList = await getInteractiveElements();
    } catch (_) {
      elementsList = [];
    }

    const elementsBlob =
      elementsList.length > 0
        ? "Interactive elements (use ONLY these selectors for click/type):\n" +
          elementsList
            .map((e, i) => `  ${i + 1}. selector="${e.selector}" tag=${e.tag} type=${e.type} placeholder="${(e.placeholder || "").slice(0, 40)}" label="${(e.label || "").slice(0, 50)}"`)
            .join("\n") +
          "\n"
        : "No interactive elements list (page may be loading or not a form). You may use navigate or done.\n";

    const now = getSimulatedNow(simulateTime);
    const timeIso = now.toISOString();
    const timeId = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour12: false });

    // Detect repeat-click loop: if last 2+ steps were same click on input, force next action = type(city)
    const lastSteps = steps.slice(-3);
    const sameClickRepeated =
      lastSteps.length >= 2 &&
      lastSteps.every((s) => s.action === "click" && s.params?.selector) &&
      new Set(lastSteps.map((s) => s.params?.selector)).size === 1;
    const repeatedSelector = lastSteps[0]?.params?.selector;
    const isInputSelector =
      repeatedSelector &&
      (String(repeatedSelector).includes("destination") ||
        String(repeatedSelector).includes("input") ||
        String(repeatedSelector).includes("search"));
    const cityMatch = perintah.match(/\b(?:di|ke|dari)\s+([A-Za-z\s]+?)(?:\s+tanggal|\s+dengan|,|$)/) ||
      perintah.match(/\b(Bandung|Jakarta|Surabaya|Yogyakarta|Bali|Semarang|Medan|Makassar)\b/i);
    const cityName = cityMatch ? cityMatch[1].trim() : null;

    const loopHint = sameClickRepeated
      ? "\n\nIMPORTANT: You have clicked the same element repeatedly. You MUST NOT click it again. Use \"type\" with the destination/city name (e.g. Bandung) and a selector from the list, or use \"scroll\" or \"done\". Reply with exactly one JSON action.\n"
      : "";

    const userContent =
      `User task: ${perintah}\n\n` +
      `Current time (server): ${timeIso} (WIB: ${timeId})\n\n` +
      `Current page URL: ${url || "(unknown)"}\n` +
      `Page title: ${title || "(unknown)"}\n\n` +
      `Page text (excerpt):\n${pageText || "(empty)"}\n\n` +
      elementsBlob +
      ( (!url || url === "about:blank" || url === "(unknown)")
        ? "The browser tab is empty. You MUST reply with exactly one JSON object: {\"action\":\"navigate\",\"params\":{\"url\":\"https://www.tiket.com\"}} or the URL from the user task. No other text.\n"
        : "Output exactly one JSON action. For click/type use ONLY a selector from the list above.\n" ) +
      loopHint;

    let actionObj;
    let llmResponse = "";

    if (sameClickRepeated && isInputSelector && cityName && repeatedSelector && !didTypeCityOverride) {
      // Force type(city) once to break the loop — skip LLM for this step
      didTypeCityOverride = true;
      actionObj = { action: "type", params: { text: cityName, selector: repeatedSelector } };
    } else {
      llmResponse = await llm.complete(userContent, SYSTEM_PROMPT, { maxTokens });
      if ((llmResponse == null || llmResponse.trim() === "") && step === 1) {
        await new Promise((r) => setTimeout(r, 800));
        llmResponse = await llm.complete(userContent, SYSTEM_PROMPT, { maxTokens });
      }
      actionObj = parseActionJson(llmResponse);

      // Fallback override if LLM still returns click on same input
      if (actionObj?.action === "click" && sameClickRepeated && repeatedSelector && cityName) {
        if (String(actionObj.params?.selector || "").includes("destination") || String(actionObj.params?.selector || "").includes("input")) {
          actionObj = { action: "type", params: { text: cityName, selector: actionObj.params.selector } };
        }
      }
    }

    if (!actionObj || !actionObj.action) {
      steps.push({ step, action: "unknown", result: "LLM did not return valid JSON" });
      return {
        ok: false,
        error: "LLM did not return a valid action. Last response: " + (llmResponse || "").slice(0, 200),
        steps,
      };
    }

    const { action, params = {} } = actionObj;

    if (action === "done") {
      steps.push({ step, action: "done", params: { summary: params.summary } });
      return { ok: true, summary: params.summary || "Task completed.", steps };
    }

    let exec = await executeAction(action, params);
    const isElementNotFound =
      !exec.ok && (action === "click" || action === "type") &&
      (exec.error || "").toLowerCase().includes("element not found");

    if (!exec.ok && isElementNotFound) {
      await new Promise((r) => setTimeout(r, 600));
      let retryUrl = "", retryTitle = "", retryPageText = "", retryElements = [];
      const urlRes2 = await browserRelay.getUrl();
      if (urlRes2.ok && urlRes2.data?.url) retryUrl = urlRes2.data.url;
      const titleRes2 = await browserRelay.getTitle();
      if (titleRes2.ok && titleRes2.data?.title) retryTitle = titleRes2.data.title;
      const textRes2 = await browserRelay.getText();
      if (textRes2.ok && textRes2.data?.text) retryPageText = String(textRes2.data.text).slice(0, MAX_PAGE_TEXT);
      try {
        retryElements = await getInteractiveElements();
      } catch (_) {}
      const retryBlob =
        retryElements.length > 0
          ? "Interactive elements (use ONLY these selectors for click/type):\n" +
            retryElements
              .map((e, i) => `  ${i + 1}. selector="${e.selector}" tag=${e.tag} type=${e.type} placeholder="${(e.placeholder || "").slice(0, 40)}" label="${(e.label || "").slice(0, 50)}"`)
              .join("\n") + "\n"
          : "No interactive elements list.\n";
      const retryUserContent =
        `User task: ${perintah}\n\n` +
        `Previous action failed: element not found. Page may have updated. Use the CURRENT list below.\n\n` +
        `Current page URL: ${retryUrl || "(unknown)"}\nPage title: ${retryTitle || "(unknown)"}\n\n` +
        `Page text (excerpt):\n${retryPageText || "(empty)"}\n\n` +
        retryBlob +
        "Output exactly one JSON action. For click/type use ONLY a selector from the list above.\n";
      const retryLlm = await llm.complete(retryUserContent, SYSTEM_PROMPT, { maxTokens });
      const retryAction = parseActionJson(retryLlm);
      if (retryAction?.action && retryAction.action !== "unknown") {
        exec = await executeAction(retryAction.action, retryAction.params || {});
        steps.push({
          step,
          action: retryAction.action,
          params: retryAction.params,
          result: exec.ok ? "ok (retry)" : exec.error,
        });
      } else {
        steps.push({ step, action, params, result: exec.error });
      }
    } else {
      steps.push({
        step,
        action,
        params,
        result: exec.ok ? "ok" : exec.error,
      });
    }

    if (!exec.ok) {
      return {
        ok: false,
        error: `Step ${step} failed (${action}): ${exec.error}`,
        steps,
      };
    }

    // Delay so page/overlay (e.g. date picker) can render before next element collection
    const delayMs = action === "click" || action === "type" ? 1400 : 800;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return {
    ok: false,
    error: `Stopped after ${maxSteps} steps (max reached). Task may be incomplete.`,
    steps,
  };
}
