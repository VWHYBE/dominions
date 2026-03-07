/**
 * Page scraper — buka URL dengan Playwright, ambil konten halaman + deteksi tombol/CTA.
 * Dipakai untuk alur: URL → scrape → AI extract sections → pipeline.
 */

import { chromium } from "playwright";

const DEFAULT_TIMEOUT_MS = 25000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CTA_KEYWORDS = [
  "beli", "pesan", "pilih", "buy", "add", "checkout", "order", "lanjut",
  "daftar", "register", "submit", "bayar", "pay", "book", "pesan sekarang",
  "beli sekarang", "pilih paket", "continue", "next", "cek", "lihat",
  "pesan tiket", "pilih tiket", "general sale", "book now"
];

/**
 * Di dalam page: kumpulkan semua elemen yang mirip tombol/CTA (teks + selector).
 * @returns {Promise<Array<{ text: string; selector: string; tagName: string }>>}
 */
async function detectButtons(page) {
  return page.evaluate((ctaKeywords) => {
    const keywords = ctaKeywords;
    function isCtaLike(t) {
      if (!t || t.length > 80) return false;
      const lower = t.toLowerCase().replace(/\s+/g, " ").trim();
      return keywords.some((k) => lower.includes(k)) ||
        /^(beli|pesan|pilih|buy|add|checkout|lanjut|daftar|submit|bayar)$/i.test(lower);
    }
    const seen = new Set();
    const out = [];
    const selectors = [
      "button",
      "[role='button']",
      "input[type='submit']",
      "input[type='button']",
      "a[href]",
      "div[class*='btn']",
      "span[class*='btn']",
      "[class*='button']",
      "[class*='cta']",
      "[class*='order']",
      "[class*='pesan']",
      "[class*='pilih']",
      "[class*='beli']"
    ];
    const root = document.body;
    if (!root) return [];

    function getSelector(el) {
      if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return "#" + el.id;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      const aria = el.getAttribute("aria-label");
      if (aria) return `[aria-label="${String(aria).slice(0, 50).replace(/"/g, '\\"')}"]`;
      const tag = el.tagName.toLowerCase();
      const cls = (el.className && typeof el.className === "string")
        ? el.className.trim().split(/\s+/).filter(Boolean)[0]
        : null;
      if (cls && /^[a-zA-Z][\w-]*$/.test(cls)) return `${tag}.${cls}`;
      return "";
    }

    selectors.forEach((sel) => {
      try {
        root.querySelectorAll(sel).forEach((el) => {
          const text = (el.innerText || el.textContent || "").trim();
          if (!text || !isCtaLike(text)) return;
          const key = text.slice(0, 60);
          if (seen.has(key)) return;
          const selector = getSelector(el);
          seen.add(key);
          out.push({
            text: text.slice(0, 100),
            selector: selector || "(lihat di halaman)",
            tagName: el.tagName.toLowerCase()
          });
        });
      } catch (_) {}
    });
    return out;
  }, CTA_KEYWORDS);
}

const CTA_BUTTON_SELECTORS = "button, [role='button'], input[type='submit'], input[type='button'], a[href]";

/**
 * Cari tombol CTA yang ada di "card" yang sama dengan teks section (e.g. "VIP A").
 * Return selector untuk tombol itu agar bisa di-click dari Node.
 * @returns {Promise<string|null>}
 */
async function getSelectorForSectionButton(page, sectionLabel) {
  if (!sectionLabel || typeof sectionLabel !== "string") return null;
  const label = sectionLabel.trim().slice(0, 80);
  return page.evaluate(({ label, ctaSelectors, ctaKeywords }) => {
    const root = document.body;
    if (!root) return null;
    const keywords = ctaKeywords;
    function isCtaLike(t) {
      if (!t || t.length > 80) return false;
      const lower = t.toLowerCase().replace(/\s+/g, " ").trim();
      return keywords.some((k) => lower.includes(k));
    }
    function getSelector(el) {
      if (!el || !el.getAttribute) return null;
      if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return "#" + el.id;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      const aria = el.getAttribute("aria-label");
      if (aria) return `[aria-label="${String(aria).slice(0, 50).replace(/"/g, '\\"')}"]`;
      const tag = el.tagName.toLowerCase();
      const cls = (el.className && typeof el.className === "string")
        ? el.className.trim().split(/\s+/).filter(Boolean)[0]
        : null;
      if (cls && /^[a-zA-Z][\w-]*$/.test(cls)) return `${tag}.${cls}`;
      return null;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const candidates = [];
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim();
      if (text.length < 2 || text.length > 200) continue;
      if (!text.toUpperCase().includes(label.toUpperCase().slice(0, 20))) continue;
      let el = node.parentElement;
      for (let i = 0; el && i < 15; i++) {
        const cta = el.querySelector(ctaSelectors);
        if (cta) {
          const btnText = (cta.innerText || cta.textContent || "").trim();
          if (isCtaLike(btnText)) {
            const sel = getSelector(cta);
            if (sel) candidates.push(sel);
            break;
          }
        }
        el = el.parentElement;
      }
    }
    return candidates.length ? candidates[0] : null;
  }, {
    label,
    ctaSelectors: CTA_BUTTON_SELECTORS,
    ctaKeywords: CTA_KEYWORDS,
  });
}

/**
 * Buka URL, tunggu halaman siap, kembalikan HTML, teks, judul, dan daftar tombol.
 * Jika options.clickSectionLabel / clickSectionId di-set: klik tombol yang terkait section itu (e.g. Pilih di card VIP A), lalu scan penuh halaman setelah klik.
 * Jika options.clickButtonIndex atau clickButtonText di-set, klik tombol tersebut lalu ambil isi halaman setelah klik (afterClick).
 * @param {string} url
 * @param {{ timeout?: number; clickButtonIndex?: number; clickButtonText?: string; clickSectionLabel?: string; clickSectionId?: string }} [options]
 * @returns {Promise<{ html: string; text: string; title: string; buttons: Array<{ text: string; selector: string; tagName: string }>; afterClick?: { url: string; title: string; text: string; buttons: Array<{ text: string; selector: string; tagName: string }>; clickedButton: string } }>}
 */
export async function scrapePage(url, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const AFTER_CLICK_TEXT_MAX = 35000;
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 720 },
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page.waitForTimeout(5000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch (_) {}
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);
    const title = await page.title();
    const html = await page.evaluate(() => document.body?.innerHTML ?? "");
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    let buttons = [];
    try {
      buttons = await detectButtons(page);
    } catch (e) {
      console.warn("[pageScraper] button detection failed:", e?.message);
    }

    let afterClick = undefined;
    let selectorToClick = null;
    let clickedButtonLabel = "";

    if (options.clickSectionLabel || options.clickSectionId) {
      const sectionLabel =
        options.clickSectionLabel ||
        (options.clickSectionId ? options.clickSectionId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "");
      const sel = await getSelectorForSectionButton(page, sectionLabel);
      if (sel) {
        selectorToClick = sel;
        clickedButtonLabel = `Pilih/Beli untuk section "${sectionLabel}"`;
      }
    }
    if (!selectorToClick && (options.clickSectionLabel || options.clickSectionId) && buttons[0]?.selector && buttons[0].selector !== "(lihat di halaman)") {
      selectorToClick = buttons[0].selector;
      clickedButtonLabel = buttons[0].text + " (fallback, section-specific button tidak ditemukan)";
    }
    if (!selectorToClick && (options.clickButtonIndex !== undefined || options.clickButtonText)) {
      const wantClickIndex =
        options.clickButtonIndex !== undefined
          ? options.clickButtonIndex
          : (options.clickButtonText && Array.isArray(buttons))
            ? buttons.findIndex((b) =>
                (b.text || "").toLowerCase().includes(String(options.clickButtonText).toLowerCase())
              )
            : -1;
      if (wantClickIndex >= 0 && buttons[wantClickIndex]?.selector && buttons[wantClickIndex].selector !== "(lihat di halaman)") {
        selectorToClick = buttons[wantClickIndex].selector;
        clickedButtonLabel = buttons[wantClickIndex].text;
      }
    }
    if (!selectorToClick && options.clickFirstButton === true && buttons[0]?.selector && buttons[0].selector !== "(lihat di halaman)") {
      selectorToClick = buttons[0].selector;
      clickedButtonLabel = buttons[0].text;
    }

    let clickedByText = false;
    if (!selectorToClick && (options.clickSectionLabel || options.clickSectionId)) {
      for (const pattern of [/pesan/i, /pilih/i, /beli/i, /general\s*sale/i]) {
        try {
          const loc = page.getByRole("button", { name: pattern }).or(page.locator("a").filter({ hasText: pattern })).first();
          await loc.click({ timeout: 4000 });
          clickedByText = true;
          clickedButtonLabel = "Pesan/Pilih/Beli (klik by role/text)";
          break;
        } catch (_) {}
      }
      if (!clickedByText) {
        try {
          await page.getByText(/pesan|pilih\s*(tiket)?|beli/i).first().click({ timeout: 4000 });
          clickedByText = true;
          clickedButtonLabel = "Pesan/Pilih/Beli (klik by text)";
        } catch (_) {}
      }
    }

    if (selectorToClick) {
      try {
        await page.locator(selectorToClick).first().click({ timeout: 8000 });
        clickedByText = false;
      } catch (e) {
        console.warn("[pageScraper] click failed:", e?.message);
      }
    }

    if (selectorToClick || clickedByText) {
      try {
        await page.waitForTimeout(4000);
        const afterUrl = page.url();
        const afterTitle = await page.title();
        const afterText = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, AFTER_CLICK_TEXT_MAX);
        let afterButtons = [];
        try {
          afterButtons = await detectButtons(page);
        } catch (_) {}
        afterClick = {
          url: afterUrl,
          title: afterTitle,
          text: afterText,
          buttons: afterButtons,
          clickedButton: clickedButtonLabel,
        };
      } catch (e) {
        console.warn("[pageScraper] afterClick capture failed:", e?.message);
      }
    }

    return { html, text, title, buttons, afterClick };
  } finally {
    await browser.close();
  }
}
