/**
 * Browser CDP Task Runner — browser_task_cdp
 *
 * Menggunakan Playwright connectOverCDP ke relay /cdp endpoint.
 * Keunggulan vs high-level runner:
 *   - Playwright auto-wait (navigation, element visibility, selectors)
 *   - Robust selector strategies (CSS, aria, text, etc.)
 *   - Screenshot lebih andal
 *   - LLM masih yang memutuskan aksi (natural language → JSON action)
 *
 * Alur:
 *   1. Playwright.connectOverCDP("http://127.0.0.1:PORT") → page
 *   2. Loop: screenshot + elements → LLM → action → execute via Playwright
 *   3. Sampai "done" atau maxSteps
 */

import { chromium } from "playwright";
import * as llm from "../llm.js";
import { getConfig } from "../configManager.js";

const DEFAULT_MAX_STEPS = 20;
const RELAY_PORT = Number(process.env.RELAY_PORT) || 18792;
const RELAY_HOST = process.env.RELAY_HOST || "127.0.0.1";
const CDP_ENDPOINT = `http://${RELAY_HOST}:${RELAY_PORT}`;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a browser automation assistant using Playwright.
You receive:
1) The user's task
2) Current page URL and title
3) Visible text excerpt (≤8000 chars)
4) INTERACTIVE ELEMENTS list — each has an "id" (sequential number) and a "label" / "selector"

For "click" and "type": use the "selector" from the element list only.
After clicking a text/search input, ALWAYS follow with "type" in the next step to enter the value.
For hotel/train search: click destination input ONCE, then immediately type the city or station name.
For DATE pickers: click the date field first, then click the calendar day or type the date.

Respond with ONLY one JSON action:
- navigate     : { "action": "navigate", "params": { "url": "https://..." } }
- click        : { "action": "click",    "params": { "selector": "<from list>" } }
- type         : { "action": "type",     "params": { "selector": "<from list>", "text": "..." } }
- press        : { "action": "press",    "params": { "selector": "<from list>", "key": "Enter" } }
- scroll       : { "action": "scroll",   "params": { "y": 400 } }
- wait_seconds : { "action": "wait_seconds", "params": { "seconds": 5 } }
- screenshot   : { "action": "screenshot" }
- done         : { "action": "done",     "params": { "summary": "..." } }

Use single quotes inside attribute selectors for JSON safety: [data-testid='foo'] not [data-testid="foo"].
Reply with ONLY the JSON — no markdown, no explanation.`;

// ─── Element collection script ────────────────────────────────────────────────

const GET_ELEMENTS_SCRIPT = `(function(){
  var out = [];
  var seen = {};
  var idx = 0;
  function stable(el) {
    if (el.id && /^[a-zA-Z][\\w:-]*$/.test(el.id)) return '#' + el.id;
    var dt = el.getAttribute('data-testid'); if (dt) return "[data-testid='" + dt.replace(/'/g,"\\\\'") + "']";
    var dd = el.getAttribute('data-date'); if (dd) return "[data-date='" + dd.replace(/'/g,"\\\\'") + "']";
    var ph = el.placeholder; if (ph) return el.tagName.toLowerCase()+"[placeholder='" + ph.replace(/'/g,"\\\\'").slice(0,80) + "']";
    var nm = el.name; if (nm && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return el.tagName.toLowerCase()+"[name='" + nm.replace(/'/g,"\\\\'") + "']";
    return null;
  }
  function add(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var sel = stable(el);
    if (!sel) { el.setAttribute('data-cdp-id','c'+idx); sel="[data-cdp-id='c"+idx+"']"; }
    var label = (el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')||el.getAttribute('data-date')||el.value||el.textContent||'').trim().slice(0,60);
    var key = sel+'|'+label;
    if (seen[key]) return;
    seen[key]=true; idx++;
    out.push({selector:sel,tag:el.tagName.toLowerCase(),label});
  }
  var qs = document.querySelectorAll('input,select,textarea,button,a[href],[role="button"],[role="link"],[data-testid],[onclick],[tabindex="0"]');
  for(var i=0;i<qs.length&&out.length<100;i++) add(qs[i]);
  var cal = document.querySelectorAll('[role="gridcell"],[role="option"],[data-date],[data-day],td[data-date],.calendar-day,.day,[class*="Day"],[class*="day"]');
  for(var j=0;j<cal.length&&out.length<100;j++){
    var c=cal[j], t=(c.textContent||'').trim();
    if(t&&/^\\d{1,2}$/.test(t)) add(c);
    else if(c.getAttribute('data-date')) add(c);
  }
  return out;
})()`;

// ─── Parse LLM JSON action ────────────────────────────────────────────────────

function parseAction(text) {
  if (!text) return null;
  const patterns = [/```(?:json)?\s*([\s\S]*?)```/, /({[\s\S]*})/];
  let slice = text.trim();
  for (const p of patterns) {
    const m = slice.match(p);
    if (m) { slice = m[1].trim(); break; }
  }
  // Fix selector attribute quotes: [attr="val"] or [attr=\"val\"] → [attr='val']
  slice = slice.replace(/\[(\w[\w-]*)=(?:\\?)"([^"\\]*)(?:\\?)"]/g, "[$1='$2']");
  slice = slice.replace(/\[(\w[\w-]*)=\\\"([^"]*)\\\"]/, "[$1='$2']");
  try {
    const obj = JSON.parse(slice);
    if (obj && typeof obj.action === "string") return obj;
  } catch {}
  return null;
}

// ─── Execute action via Playwright page ──────────────────────────────────────

async function execAction(page, actionObj) {
  const { action, params = {} } = actionObj;
  switch (action) {
    case "navigate":
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { ok: true };

    case "click": {
      const loc = page.locator(params.selector).first();
      await loc.waitFor({ state: "attached", timeout: 8_000 });
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await loc.click({ timeout: 8_000 });
      await page.waitForTimeout(600);
      return { ok: true };
    }

    case "type": {
      const loc = page.locator(params.selector).first();
      await loc.waitFor({ state: "attached", timeout: 8_000 });
      await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await loc.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
      await loc.fill(String(params.text ?? ""), { timeout: 8_000 });
      await page.waitForTimeout(500);
      return { ok: true };
    }

    case "press": {
      const loc = page.locator(params.selector).first();
      await loc.waitFor({ state: "attached", timeout: 8_000 });
      await loc.press(params.key ?? "Enter", { timeout: 5_000 });
      await page.waitForTimeout(400);
      return { ok: true };
    }

    case "scroll":
      if (params.selector) {
        await page.locator(params.selector).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      } else {
        await page.evaluate((y) => window.scrollBy(0, y), params.y ?? 400);
      }
      return { ok: true };

    case "wait_seconds":
      await page.waitForTimeout((params.seconds ?? 5) * 1000);
      return { ok: true };

    case "screenshot":
      return { ok: true, note: "screenshot implicit in next step" };

    case "done":
      return { ok: true, done: true, summary: params.summary ?? "Task completed" };

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// ─── Run task ─────────────────────────────────────────────────────────────────

/**
 * @param {string} perintah  - natural language task
 * @param {object} [options]
 * @param {number} [options.maxSteps]
 * @param {string} [options.simulateTime]  - "HH:mm" or "H.mm" to simulate current WIB time
 * @returns {Promise<{ steps: object[], finalSummary: string }>}
 */
export async function runCdpTask(perintah, options = {}) {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const config = await getConfig();
  const maxTokens = config?.llmMaxTokens ?? 4096;

  // Connect Playwright to CDP relay (relay + extension may need a few seconds to announce target)
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 20_000 });
  } catch (err) {
    throw new Error(
      `Cannot connect to CDP relay at ${CDP_ENDPOINT}. ` +
      `Make sure the relay is running (npm run relay) and the extension is attached. ` +
      `Error: ${err.message}`
    );
  }

  // Get existing page from attached tab — poll with retries because the extension
  // announces its target asynchronously AFTER the CDP client connects (race condition).
  let page = null;
  try {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const contexts = browser.contexts();
      for (const ctx of contexts) {
        const pages = ctx.pages();
        if (pages.length > 0) { page = pages[0]; break; }
      }
      if (page) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!page) {
      await browser.close().catch(() => {});
      throw new Error(
        "No page in CDP. Attach the extension to a tab (click Attach This Tab), then try again. " +
        "Do not open a new tab from here — use the already attached tab."
      );
    }
  } catch (err) {
    await browser.close().catch(() => {});
    throw err.message?.includes("No page") ? err : new Error("Failed to get page from CDP context: " + err.message);
  }

  const steps = [];
  let didTypeCityOverride = false;

  try {
  // Simulated time helper
  function getNow() {
    if (!options.simulateTime) return new Date();
    const s = String(options.simulateTime);
    const [hStr, mStr] = s.includes(".") ? s.split(".") : s.split(":");
    const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    now.setHours(h, m, 0, 0);
    return now;
  }

  for (let step = 0; step < maxSteps; step++) {
    // Collect page state
    let url = "about:blank", title = "", pageText = "", elements = [];
    try {
      url = page.url();
      title = await page.title().catch(() => "");
      pageText = await page.evaluate(() =>
        (document.body?.innerText ?? document.documentElement?.textContent ?? "").slice(0, 8000)
      ).catch(() => "");
      elements = await page.evaluate(GET_ELEMENTS_SCRIPT).catch(() => []);
    } catch (err) {
      console.warn("[cdp-runner] Failed to collect page state:", err.message);
    }

    const now = getNow();
    const timeStr = now.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const elemList = elements.slice(0, 80).map((e, i) => `${i + 1}. [${e.selector}] ${e.label}`).join("\n");

    const userContent = [
      `Task: ${perintah}`,
      `Current time (WIB): ${timeStr}${options.simulateTime ? " (simulated)" : ""}`,
      `URL: ${url}`,
      `Title: ${title}`,
      `Page text:\n${pageText.slice(0, 4000)}`,
      `Interactive elements:\n${elemList || "(none)"}`,
      `Step ${step + 1} of ${maxSteps}. What is the next action?`,
    ].join("\n\n");

    // Loop detection: if same click repeated ≥ 2 times on an input selector → force type
    const lastSteps = steps.slice(-2);
    const sameClickRepeated =
      lastSteps.length >= 2 &&
      lastSteps.every((s) => s.action === "click" && s.params?.selector) &&
      new Set(lastSteps.map((s) => s.params?.selector)).size === 1;
    const repeatedSelector = lastSteps[0]?.params?.selector;
    const isInputSelector = repeatedSelector &&
      (String(repeatedSelector).includes("destination") ||
       String(repeatedSelector).includes("input") ||
       String(repeatedSelector).includes("search"));

    const cityMatch =
      perintah.match(/\b(?:di|ke|dari)\s+([A-Za-z\s]+?)(?:\s+tanggal|\s+dengan|,|$)/i) ||
      perintah.match(/\b(Bandung|Jakarta|Surabaya|Yogyakarta|Bali|Semarang|Medan|Makassar|Lombok|Batam)\b/i);
    const cityName = cityMatch ? cityMatch[1].trim() : null;

    let actionObj;

    if (sameClickRepeated && isInputSelector && cityName && !didTypeCityOverride) {
      didTypeCityOverride = true;
      actionObj = { action: "type", params: { text: cityName, selector: repeatedSelector } };
      console.log(`[cdp-runner] Loop override: force type("${cityName}") on ${repeatedSelector}`);
    } else {
      // LLM decides
      let llmResponse = "";
      try {
        llmResponse = await llm.complete(userContent, SYSTEM_PROMPT, { maxTokens });
      } catch (err) {
        console.warn("[cdp-runner] LLM error:", err.message);
      }

      actionObj = parseAction(llmResponse);

      if (!actionObj) {
        console.warn("[cdp-runner] Could not parse LLM response:", llmResponse?.slice(0, 200));
        steps.push({ step: step + 1, error: "LLM did not return a valid action", raw: llmResponse });
        break;
      }

      // Soft override: LLM still returns click on same input → force type
      if (actionObj.action === "click" && sameClickRepeated && isInputSelector && cityName && !didTypeCityOverride) {
        const sel = String(actionObj.params?.selector || "");
        if (sel.includes("destination") || sel.includes("input") || sel.includes("search")) {
          didTypeCityOverride = true;
          actionObj = { action: "type", params: { text: cityName, selector: actionObj.params.selector } };
        }
      }
    }

    steps.push({ step: step + 1, action: actionObj.action, params: actionObj.params });
    console.log(`[cdp-runner] Step ${step + 1}: ${actionObj.action}`, JSON.stringify(actionObj.params ?? {}));

    // Execute
    let result;
    try {
      result = await execAction(page, actionObj);
    } catch (err) {
      console.warn("[cdp-runner] Action error:", err.message);
      steps[steps.length - 1].error = err.message;
      // If element not found, continue (Playwright error is more descriptive)
      if (err.message.includes("strict mode violation") || err.message.includes("not found")) {
        continue;
      }
      break;
    }

    if (result.done) {
      steps[steps.length - 1].summary = result.summary;
      return { steps, finalSummary: result.summary };
    }
    if (result.error) {
      steps[steps.length - 1].error = result.error;
    }
  }

  const finalSummary = steps.length >= maxSteps
    ? `Stopped after ${maxSteps} steps (max reached). Task may be incomplete.`
    : `Stopped after ${steps.length} steps.`;

  return { steps, finalSummary };
  } finally {
    await browser.close().catch(() => {});
  }
}
