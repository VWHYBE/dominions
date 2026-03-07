/**
 * Executor — jalankan aksi dari HANDOFF (mis. action: "click" + selector).
 * Buka URL dengan Playwright, klik elemen sesuai selector, kembalikan isi halaman setelah klik.
 */

import { chromium } from "playwright";

const DEFAULT_TIMEOUT_MS = 25000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const AFTER_CLICK_TEXT_MAX = 35000;

/**
 * Ambil pesan HANDOFF yang ditujukan ke executor dengan action click.
 * @param {{ messages: Array<{ to?: string; action?: string; selector?: string; chosen?: string }> }} handoff
 * @returns {{ to: string; action: string; selector: string; chosen?: string } | null}
 */
export function getExecutorClickAction(handoff) {
  const list = handoff?.messages;
  if (!Array.isArray(list)) return null;
  const msg = list.find(
    (m) => m && (m.to === "executor" || m.to === "scraper_agent") && m.action === "click" && typeof m.selector === "string" && m.selector.trim()
  );
  if (!msg) return null;
  return {
    to: msg.to,
    action: msg.action,
    selector: String(msg.selector).trim(),
    chosen: msg.chosen,
  };
}

/**
 * Klik satu elemen di halaman. Selector bisa CSS (#id, .class, [attr=...]), compound (selector1, selector2), atau Playwright "text=..."
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {Promise<{ clicked: boolean; clickedButton?: string }>}
 */
async function clickSelector(page, selector) {
  const raw = String(selector).trim();
  const candidates = raw.includes(", ") ? raw.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean) : [raw];
  for (const sel of candidates) {
    let locator = null;
    if (sel.startsWith("text=")) {
      const text = sel.slice(5).trim().replace(/^["']|["']$/g, "");
      locator = page.getByText(text, { exact: false }).first();
    } else if (sel.startsWith("role=")) {
      const match = sel.match(/role=(\w+)(?:\s*,\s*name=([^,\s]+))?/);
      const role = match?.[1] || "button";
      const name = match?.[2]?.replace(/^["']|["']$/g, "");
      locator = name ? page.getByRole(role, { name }) : page.getByRole(role).first();
    } else {
      locator = page.locator(sel).first();
    }
    try {
      await locator.waitFor({ state: "visible", timeout: 6000 });
      const clickedButton = await locator.evaluate((el) => (el && (el.innerText || el.textContent || "").trim()) || "");
      await locator.click({ timeout: 8000 });
      return { clicked: true, clickedButton: clickedButton.slice(0, 200) };
    } catch (_) {
      continue;
    }
  }
  return { clicked: false };
}

/**
 * Eksekusi aksi click dari HANDOFF: buka URL, klik selector, kembalikan isi halaman setelah klik.
 * @param {string} url
 * @param {{ selector: string; chosen?: string }} action — dari getExecutorClickAction()
 * @returns {Promise<{ executed: boolean; selector: string; chosen?: string; error?: string; afterClick?: { url: string; title: string; text: string; buttons: Array<{ text: string; selector: string; tagName: string }>; clickedButton: string } }>}
 */
export async function executeClick(url, action) {
  if (!action || !action.selector) {
    return { executed: false, selector: action?.selector || "", error: "No selector" };
  }
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 720 },
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForTimeout(4000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch (_) {}

    const { clicked, clickedButton: clickedLabel } = await clickSelector(page, action.selector);
    if (!clicked) {
      return { executed: false, selector: action.selector, chosen: action.chosen, error: "Element not found or not clickable" };
    }

    await page.waitForTimeout(3000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch (_) {}

    const afterUrl = page.url();
    const afterTitle = await page.title();
    let afterText = "";
    try {
      afterText = await page.evaluate(() => document.body?.innerText ?? "");
    } catch (_) {}
    afterText = (afterText || "").slice(0, AFTER_CLICK_TEXT_MAX);

    let buttons = [];
    try {
      buttons = await page.evaluate((keywords) => {
        const k = keywords;
        function isCta(t) {
          if (!t || t.length > 80) return false;
          const l = t.toLowerCase();
          return k.some((x) => l.includes(x));
        }
        const out = [];
        const sel = "button, [role='button'], a[href], [class*='btn']";
        document.body?.querySelectorAll(sel).forEach((el) => {
          const t = (el.innerText || el.textContent || "").trim();
          if (t && isCta(t)) out.push({ text: t.slice(0, 100), selector: el.id ? "#" + el.id : "", tagName: el.tagName.toLowerCase() });
        });
        return out.slice(0, 30);
      }, ["pesan", "pilih", "beli", "lanjut", "checkout", "bayar", "submit", "next", "continue"]);
    } catch (_) {}

    await browser.close();

    return {
      executed: true,
      selector: action.selector,
      chosen: action.chosen,
      afterClick: {
        url: afterUrl,
        title: afterTitle,
        text: afterText,
        buttons: Array.isArray(buttons) ? buttons : [],
        clickedButton: clickedLabel || "clicked",
      },
    };
  } catch (err) {
    try { await browser.close(); } catch (_) {}
    return {
      executed: false,
      selector: action.selector,
      chosen: action.chosen,
      error: err?.message || String(err),
    };
  }
}

/**
 * Baca handoff, ambil aksi click ke executor, lalu jalankan.
 * @param {string} url
 * @param {{ messages: Array }} handoff — result.handoff dari pipeline
 * @returns {Promise<{ executed: boolean; selector?: string; error?: string; afterClick?: object }>}
 */
export async function executeHandoff(url, handoff) {
  const action = getExecutorClickAction(handoff);
  if (!action) return { executed: false, error: "No executor click action in handoff" };
  return executeClick(url, action);
}
