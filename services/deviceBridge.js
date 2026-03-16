/**
 * Device Bridge — ADB (Android) integration for Dominions.
 * Exposes status() and screenshot() for the Pipeline preview panel.
 * Requires ADB in PATH (or set ADB_PATH). No iOS/simulator in scope.
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const ADB = process.env.ADB_PATH || "adb";
const DEVICES_TIMEOUT_MS = 10_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;

/**
 * List connected Android devices. Lines with "\tdevice" are valid.
 * @returns {Promise<{ id: string }[]>}
 */
async function listDevices() {
  try {
    const { stdout } = await execAsync(ADB + " devices", {
      timeout: DEVICES_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const lines = (stdout || "").split("\n");
    const devices = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("List")) continue;
      const tab = trimmed.indexOf("\t");
      if (tab === -1) continue;
      const id = trimmed.slice(0, tab).trim();
      const status = trimmed.slice(tab + 1).trim().toLowerCase();
      if (id && status === "device") devices.push({ id });
    }
    return devices;
  } catch (err) {
    return [];
  }
}

/**
 * Status for the preview panel: are any ADB devices available?
 * @returns {Promise<{ ok: boolean; available: boolean; devices: { id: string }[] }>}
 */
export async function status() {
  const devices = await listDevices();
  return {
    ok: true,
    available: devices.length > 0,
    devices,
  };
}

/**
 * Capture screenshot from first (or specified) device. Returns PNG buffer.
 * @param {string} [deviceId]
 * @returns {Promise<{ ok: boolean; buffer?: Buffer; error?: string }>}
 */
export async function screenshot(deviceId) {
  const devices = await listDevices();
  if (devices.length === 0) return { ok: false, error: "No devices" };
  const target =
    deviceId && devices.some((d) => d.id === deviceId) ? deviceId : devices[0].id;
  const cmd = target
    ? `${ADB} -s ${target} exec-out screencap -p`
    : `${ADB} exec-out screencap -p`;
  try {
    const { stdout } = await execAsync(cmd, {
      timeout: SCREENSHOT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      encoding: undefined,
    });
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "", "binary");
    if (buffer.length === 0) return { ok: false, error: "Empty screenshot" };
    return { ok: true, buffer };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
