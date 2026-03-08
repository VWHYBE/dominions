/**
 * Dominions Browser Relay — Popup UI
 * Shows relay/tab status and handles Attach / Detach.
 */

const relayStatusEl = document.getElementById("relay-status");
const tabStatusEl   = document.getElementById("tab-status");
const tabInfoEl     = document.getElementById("tab-info");
const toggleBtn     = document.getElementById("toggle-btn");
const hintEl        = document.getElementById("hint-text");
const errorEl       = document.getElementById("error-msg");

let currentTabId = null;

function dot(color) {
  return `<span class="dot dot--${color}"></span>`;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

function applyStatus({ relayConnected, attachedTabId }, tab) {
  // Relay
  relayStatusEl.innerHTML = relayConnected
    ? `${dot("green")} Connected`
    : `${dot("red")} Disconnected`;

  // Tab
  const isAttached = attachedTabId && tab && attachedTabId === tab.id;
  if (isAttached) {
    tabStatusEl.innerHTML = `${dot("green")} Attached`;
    tabInfoEl.hidden = false;
    tabInfoEl.textContent = tab.url?.slice(0, 60) + (tab.url?.length > 60 ? "…" : "");
  } else if (attachedTabId && (!tab || attachedTabId !== tab.id)) {
    tabStatusEl.innerHTML = `${dot("amber")} Tab #${attachedTabId} (different tab)`;
    tabInfoEl.hidden = true;
  } else {
    tabStatusEl.innerHTML = `${dot("red")} None`;
    tabInfoEl.hidden = true;
  }

  // Button
  toggleBtn.disabled = !tab;
  if (isAttached) {
    toggleBtn.textContent = "Detach";
    toggleBtn.className = "btn btn--detach";
    hintEl.textContent = "Agent can now control this tab. Click Detach to release.";
  } else {
    toggleBtn.textContent = "Attach This Tab";
    toggleBtn.className = "btn btn--attach";
    hintEl.textContent = relayConnected
      ? "Open a tab to control, then click Attach."
      : "Relay server is not running. Start with: npm run relay";
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;

  chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
    if (chrome.runtime.lastError) {
      applyStatus({ relayConnected: false, attachedTabId: null }, tab);
      showError("Background service not available. Try reloading the extension.");
      return;
    }
    showError("");
    applyStatus(status, tab);
  });
}

toggleBtn.addEventListener("click", async () => {
  if (!currentTabId) return;
  toggleBtn.disabled = true;
  toggleBtn.textContent = "…";
  showError("");

  chrome.runtime.sendMessage({ type: "toggleAttach", tabId: currentTabId }, (res) => {
    if (chrome.runtime.lastError) {
      showError("Could not communicate with background service.");
      return;
    }
    if (!res?.ok) {
      showError(res?.error ?? "Unknown error");
    }
    refresh();
  });
});

// Listen for status pushes from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") refresh();
});

// Initial load
refresh();
