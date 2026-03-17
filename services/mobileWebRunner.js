/**
 * Mobile Web Runner — self-contained Android mobile web automation.
 *
 * How it works:
 *   1. Uses ADB to forward Chrome DevTools port from the Android device to localhost.
 *   2. If Chrome is not already open, launches it automatically via ADB intent.
 *   3. Connects Playwright via connectOverCDP to that forwarded port.
 *   4. Executes a DSL script (steps[]) against the Chrome page on the device.
 *   5. Returns a per-step result + optional screenshot path.
 *
 * Requirements (user side):
 *   - ADB in PATH (or ADB_PATH env var)
 *   - Android device connected via USB with USB debugging enabled, OR emulator running
 *   - Chrome installed on the device (standard on most Android)
 *   - Device unlocked (screen must be on for Chrome to render)
 */

import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import * as deviceBridge from "./deviceBridge.js";

const execAsync = promisify(exec);

const ADB = process.env.ADB_PATH || "adb";
const CDP_LOCAL_PORT = Number(process.env.MOBILE_CDP_PORT) || 9222;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_LOCAL_PORT}`;
const ADB_FORWARD_TIMEOUT_MS = 10_000;
const PLAYWRIGHT_CONNECT_TIMEOUT_MS = 15_000;
const STEP_TIMEOUT_MS = 15_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = path.join(__dirname, "..", "result");

// ─── ADB helpers ──────────────────────────────────────────────────────────────

/**
 * Forward Chrome DevTools port from device to localhost.
 * @param {string} deviceId
 */
async function forwardCdpPort(deviceId) {
  const cmd = `${ADB} -s ${deviceId} forward tcp:${CDP_LOCAL_PORT} localabstract:chrome_devtools_remote`;
  try {
    await execAsync(cmd, { timeout: ADB_FORWARD_TIMEOUT_MS });
  } catch (err) {
    throw new Error(
      `ADB port forward failed for device "${deviceId}". ` +
      `Make sure the device is connected, USB debugging is enabled, and Chrome is open. ` +
      `Error: ${err.message}`
    );
  }
}

/**
 * Remove the forwarded port after use.
 * @param {string} deviceId
 */
async function removeForward(deviceId) {
  const cmd = `${ADB} -s ${deviceId} forward --remove tcp:${CDP_LOCAL_PORT}`;
  await execAsync(cmd, { timeout: ADB_FORWARD_TIMEOUT_MS }).catch(() => {});
}

/**
 * Wake the device screen via ADB (in case it's off/locked).
 * @param {string} deviceId
 */
async function wakeDevice(deviceId) {
  await execAsync(`${ADB} -s ${deviceId} shell input keyevent KEYCODE_WAKEUP`, {
    timeout: 5_000,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
}

/**
 * Write the Chrome command-line flag file to enable remote debugging on the device.
 * This persists across Chrome restarts until the file is removed.
 * @param {string} deviceId
 */
async function enableChromeRemoteDebugging(deviceId) {
  const cmd = `${ADB} -s ${deviceId} shell "echo 'chrome --remote-debugging-port=${CDP_LOCAL_PORT}' > /data/local/tmp/chrome-command-line"`;
  await execAsync(cmd, { timeout: 5_000 }).catch(() => {
    // Non-fatal: some devices may not allow writing to /data/local/tmp without root.
    // Chrome may still work if it was already launched with debugging enabled.
  });
}

/**
 * Launch Chrome on the device via ADB intent, optionally navigating to a URL.
 * Enables remote debugging flag, force-stops Chrome, then relaunches it.
 * @param {string} deviceId
 * @param {string} [url]
 */
async function launchChrome(deviceId, url = "about:blank") {
  await enableChromeRemoteDebugging(deviceId);

  // Force-stop Chrome so it picks up the new command-line flags
  await execAsync(`${ADB} -s ${deviceId} shell am force-stop com.android.chrome`, {
    timeout: 5_000,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));

  const intent =
    `${ADB} -s ${deviceId} shell am start -n com.android.chrome/com.google.android.apps.chrome.Main` +
    ` -a android.intent.action.VIEW -d "${url}"`;
  await execAsync(intent, { timeout: 10_000 }).catch(() => {});
  // Give Chrome time to start and register its DevTools socket
  await new Promise((r) => setTimeout(r, 2_500));
}

/**
 * Check whether the CDP port is reachable (Chrome DevTools responding).
 * @returns {Promise<boolean>}
 */
async function isCdpReachable() {
  try {
    const res = await fetch(`${CDP_ENDPOINT}/json/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure Chrome is open on the device and CDP is reachable.
 * Auto-launches Chrome via ADB intent if not already running.
 * @param {string} deviceId
 * @param {string} [firstUrl] - optional URL to open in Chrome on launch
 */
async function ensureChromeOpen(deviceId, firstUrl) {
  await wakeDevice(deviceId);
  await forwardCdpPort(deviceId);

  if (await isCdpReachable()) return; // Chrome already open

  // Chrome not open — launch it
  await launchChrome(deviceId, firstUrl || "about:blank");

  // Re-forward after launch (socket may have changed)
  await removeForward(deviceId);
  await forwardCdpPort(deviceId);

  // Wait up to 8s for CDP to become reachable
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await isCdpReachable()) return;
    await new Promise((r) => setTimeout(r, 600));
  }

  throw new Error(
    `Chrome launched on device "${deviceId}" but CDP at ${CDP_ENDPOINT} is still not reachable. ` +
    `Make sure the device is unlocked and Chrome has remote debugging enabled.`
  );
}

// ─── DSL step executor ────────────────────────────────────────────────────────

/**
 * Resolve a locator from a DSL step.
 * Priority: selector > text > label > placeholder
 * @param {import("playwright").Page} page
 * @param {object} step
 * @returns {import("playwright").Locator}
 */
function resolveLocator(page, step) {
  if (step.selector) return page.locator(step.selector).first();
  if (step.text) return page.getByText(step.text, { exact: false }).first();
  if (step.label) return page.getByLabel(step.label, { exact: false }).first();
  if (step.placeholder) return page.getByPlaceholder(step.placeholder, { exact: false }).first();
  throw new Error(`Step "${step.action}" requires selector, text, label, or placeholder`);
}

/**
 * Execute a single DSL step against a Playwright page.
 * @param {import("playwright").Page} page
 * @param {object} step
 * @param {string} screenshotDir
 * @param {string} deviceId
 * @returns {Promise<{ status: "pass"|"fail"; error?: string; screenshotPath?: string }>}
 */
async function executeStep(page, step, screenshotDir, deviceId) {
  const { action } = step;

  try {
    switch (action) {
      case "open_url": {
        if (!step.url) throw new Error("open_url requires url");
        await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
        // Give the physical screen time to render the navigated page
        await page.waitForTimeout(1_500);
        break;
      }

      case "tap": {
        const loc = resolveLocator(page, step);
        await loc.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        await loc.click({ timeout: STEP_TIMEOUT_MS });
        await page.waitForTimeout(500);
        break;
      }

      case "type": {
        const loc = resolveLocator(page, step);
        await loc.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        await loc.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(300);
        await loc.fill(String(step.text ?? ""), { timeout: STEP_TIMEOUT_MS });
        await page.waitForTimeout(400);
        break;
      }

      case "wait_for": {
        if (step.text) {
          await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        } else if (step.selector) {
          await page.locator(step.selector).first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        } else {
          await page.waitForTimeout((step.seconds ?? 2) * 1000);
        }
        break;
      }

      case "assert_exists": {
        const loc = step.text
          ? page.getByText(step.text, { exact: false }).first()
          : page.locator(step.selector).first();
        await loc.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        const visible = await loc.isVisible();
        if (!visible) throw new Error(`Element not visible: ${step.text || step.selector}`);
        break;
      }

      case "scroll": {
        if (step.selector) {
          await page.locator(step.selector).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        } else {
          await page.evaluate((y) => window.scrollBy(0, y), step.y ?? 400);
        }
        break;
      }

      case "screenshot": {
        await fs.mkdir(screenshotDir, { recursive: true });
        const ts = Date.now();
        const screenshotPath = path.join(screenshotDir, `mobile-screenshot-${ts}.png`);
        // Use ADB screencap — works regardless of whether Chrome is foregrounded
        const adbResult = await deviceBridge.screenshot(deviceId);
        if (adbResult.ok && adbResult.buffer && adbResult.buffer.length > 0) {
          await fs.writeFile(screenshotPath, adbResult.buffer);
          return { status: "pass", screenshotPath };
        }
        // Fallback: Playwright screenshot (requires Chrome in foreground)
        try {
          const vp = page.viewportSize();
          if (!vp || vp.width === 0 || vp.height === 0) {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.waitForTimeout(300);
          }
          await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 10_000 });
          return { status: "pass", screenshotPath };
        } catch (e) {
          return { status: "fail", error: `Screenshot failed: ${e.message}` };
        }
      }

      case "press": {
        const loc = resolveLocator(page, step);
        await loc.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        await loc.press(step.key ?? "Enter", { timeout: 5_000 });
        await page.waitForTimeout(400);
        break;
      }

      default:
        throw new Error(`Unknown DSL action: "${action}"`);
    }

    return { status: "pass" };
  } catch (err) {
    return { status: "fail", error: err.message ?? String(err) };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List connected Android devices (delegates to deviceBridge).
 * @returns {Promise<{ ok: boolean; available: boolean; devices: { id: string }[] }>}
 */
export async function listDevices() {
  return deviceBridge.status();
}

/**
 * Execute a DSL script on a specific Android device via ADB + Playwright CDP.
 *
 * @param {string} deviceId - ADB device serial (from listDevices)
 * @param {{ version: string; steps: object[] }} script
 * @returns {Promise<{
 *   ok: boolean;
 *   steps: { index: number; action: string; status: "pass"|"fail"; error?: string; screenshotPath?: string }[];
 *   screenshotPath?: string;
 *   error?: string;
 * }>}
 */
export async function executeDsl(deviceId, script) {
  if (!deviceId || typeof deviceId !== "string") {
    return { ok: false, steps: [], error: "deviceId (non-empty string) is required" };
  }
  if (!script || !Array.isArray(script.steps) || script.steps.length === 0) {
    return { ok: false, steps: [], error: "script.steps (non-empty array) is required" };
  }

  // Determine first URL from steps so Chrome can open directly to the target page
  const firstOpenUrl = script.steps.find((s) => s.action === "open_url")?.url;

  try {
    await ensureChromeOpen(deviceId, firstOpenUrl);
  } catch (err) {
    return { ok: false, steps: [], error: err.message };
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT, {
      timeout: PLAYWRIGHT_CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    await removeForward(deviceId);
    return {
      ok: false,
      steps: [],
      error:
        `Cannot connect to Chrome on device "${deviceId}" via CDP at ${CDP_ENDPOINT}. ` +
        `Error: ${err.message}`,
    };
  }

  let page = null;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const ctx of browser.contexts()) {
        const pages = ctx.pages();
        if (pages.length > 0) { page = pages[0]; break; }
      }
      if (page) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!page) {
      throw new Error(
        `No page found in Chrome on device "${deviceId}". Open a tab in Chrome and try again.`
      );
    }
    // Bring the page to foreground so ADB screencap captures the correct content
    await page.bringToFront().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    await browser.close().catch(() => {});
    await removeForward(deviceId);
    return { ok: false, steps: [], error: err.message };
  }

  const stepResults = [];
  let lastScreenshotPath;
  let allPassed = true;

  try {
    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i];
      const result = await executeStep(page, step, RESULT_DIR, deviceId);

      stepResults.push({
        index: i,
        action: step.action,
        ...result,
      });

      if (result.screenshotPath) lastScreenshotPath = result.screenshotPath;

      if (result.status === "fail") {
        allPassed = false;
        // Continue executing remaining steps to report full picture
      }
    }

    // Auto-screenshot at the end using ADB screencap (works even when Chrome is backgrounded)
    if (!lastScreenshotPath) {
      await fs.mkdir(RESULT_DIR, { recursive: true });
      const ts = Date.now();
      const autoPath = path.join(RESULT_DIR, `mobile-screenshot-${ts}.png`);
      const adbResult = await deviceBridge.screenshot(deviceId);
      if (adbResult.ok && adbResult.buffer && adbResult.buffer.length > 0) {
        await fs.writeFile(autoPath, adbResult.buffer);
        lastScreenshotPath = autoPath;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await removeForward(deviceId);
  }

  return {
    ok: allPassed,
    steps: stepResults,
    ...(lastScreenshotPath ? { screenshotPath: lastScreenshotPath } : {}),
  };
}

/**
 * Capture a screenshot from a specific Android device.
 * Uses ADB screencap (same as deviceBridge) and saves to result/.
 *
 * @param {string} deviceId
 * @returns {Promise<{ ok: boolean; screenshotPath?: string; error?: string }>}
 */
export async function captureScreenshot(deviceId) {
  if (!deviceId || typeof deviceId !== "string") {
    return { ok: false, error: "deviceId (non-empty string) is required" };
  }
  const result = await deviceBridge.screenshot(deviceId);
  if (!result.ok) return { ok: false, error: result.error };

  try {
    await fs.mkdir(RESULT_DIR, { recursive: true });
    const ts = Date.now();
    const screenshotPath = path.join(RESULT_DIR, `mobile-screenshot-${ts}.png`);
    await fs.writeFile(screenshotPath, result.buffer);
    return { ok: true, screenshotPath };
  } catch (err) {
    return { ok: false, error: err.message ?? String(err) };
  }
}
