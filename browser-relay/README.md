# Dominions Browser Relay

Jembatan antara **agent AI Dominions / MCP** dan **tab Chrome aktif kamu**.

Agent bisa navigate, klik, ketik, screenshot, dan baca konten halaman — semua di tab yang kamu buka sendiri. Tidak perlu browser terpisah/headless.

## Cara Kerja

```
Agent / MCP tool
      │ HTTP POST /command
      ▼
relay server  (Node, ws://127.0.0.1:18792)
      │ WebSocket (perintah + announce)
      ▼
Chrome extension (MV3)
      │ chrome.debugger → Chrome DevTools Protocol
      ▼
Tab Chrome yang kamu attach
```

---

## Fitur (Opsi-B: resilience ala OpenClaw)

| Fitur | Deskripsi |
|-------|-----------|
| **Persist state** | Tab yang di-attach disimpan ke `chrome.storage.local`; selamat dari MV3 service worker restart |
| **Rehydrate on startup** | Saat extension start, state tab dipulihkan otomatis (tanpa klik Attach lagi) |
| **Re-attach after navigation** | Setelah navigasi (debugger detach), extension otomatis re-attach dengan backoff: 200ms, 500ms, 1s, 2s, 4s |
| **Reconnect backoff** | Relay putus → reconnect exponential backoff: 3s → 6s → 12s → … max 48s |
| **Re-announce on reconnect** | Setelah WS terhubung lagi, extension kirim `announce` ke relay supaya relay tahu tab mana yang aktif |
| **Keepalive alarm** | `chrome.alarms` tiap 30 detik cek relay health, trigger reconnect kalau perlu |
| **GET /json/list** | Endpoint info tab yang attached (kompatibel pola OpenClaw/CDP) |

---

## Setup (3 langkah)

### 1. Jalankan relay server

Relay **harus jalan** sebelum extension / CDP bisa connect. Jalankan di **terminal terpisah**:

```bash
npm run relay
# atau untuk auto-reload saat dev:
npm run relay:dev
```

**Satu terminal untuk relay + API:** (relay + server Dominions sekaligus)

```bash
npm run start:all
```

Relay jalan di `http://127.0.0.1:18792` (loopback only — tidak terekspos ke LAN).

---

### 2. Load extension ke Chrome

1. Buka Chrome → `chrome://extensions`
2. Aktifkan **Developer mode** (toggle kanan atas).
3. Klik **Load unpacked** → pilih folder:
   ```
   /path/to/dominions/browser-relay/extension
   ```
4. Pin extension ke toolbar Chrome.

> **Catatan:** Jika sudah pernah load sebelumnya, klik **Reload** di `chrome://extensions` setelah update kode extension.

---

### 3. Attach tab

1. Buka tab Chrome yang mau dikontrol agent.
2. Klik **ikon Dominions Relay** di toolbar.
3. Klik tombol **Attach This Tab**.
4. Popup tampilkan **Relay: Connected** + **Tab: Attached** → siap.

Tab akan **otomatis re-attach** setelah navigasi (tidak perlu klik Attach lagi). Relay akan **otomatis reconnect** kalau sempat putus.

---

## Gunakan dari MCP (Cursor)

Tools yang tersedia:

| Tool | Fungsi |
|------|--------|
| `browser_relay_status` | Cek relay + extension |
| `browser_relay_navigate` | Navigate ke URL |
| `browser_relay_snapshot` | Ambil HTML halaman |
| `browser_relay_text` | Ambil teks halaman |
| `browser_relay_click` | Klik elemen (CSS selector) |
| `browser_relay_type` | Ketik teks |
| `browser_relay_scroll` | Scroll halaman / elemen |
| `browser_relay_screenshot` | Screenshot (base64 JPEG) |
| `browser_relay_evaluate` | Jalankan JS di halaman |
| `browser_relay_get_url` | URL tab saat ini |
| `browser_relay_get_title` | Title tab saat ini |

**Satu perintah natural language:** gunakan **`browser_task`** — beri parameter `perintah` (kalimat), lalu LLM akan menggerakkan browser (navigate, click, type, scroll, refresh) sampai selesai atau max steps.

**`browser_task_cdp`** — sama seperti `browser_task` tapi lewat **full CDP proxy** (Playwright). Lebih robust untuk form kompleks, date picker, multi-step. Butuh extension **di-reload** sekali agar konek ke `/extension-cdp`; lalu cek `curl http://127.0.0.1:18792/status` → `cdpExtensionConnected: true`.

**Parameter `browser_task` / `browser_task_cdp`:**
- `perintah` (wajib): task dalam bahasa natural
- `maxSteps` (opsional, default 15, max 30): batas langkah otomatis
- `simulateTime` (opsional, mis. `"15:51"`): simulasi waktu untuk war tiket

---

## Gunakan dari HTTP API

```bash
# Status
curl http://localhost:3000/api/browser/status

# Info tab attached
curl http://127.0.0.1:18792/json/list

# Navigate
curl -X POST http://localhost:3000/api/browser/action \
  -H "Content-Type: application/json" \
  -d '{"action":"navigate","params":{"url":"https://example.com"}}'

# Klik
curl -X POST http://localhost:3000/api/browser/action \
  -H "Content-Type: application/json" \
  -d '{"action":"click","params":{"selector":"button.submit"}}'
```

---

## Aksi yang didukung

| action | params wajib | params opsional |
|--------|-------------|-----------------|
| `navigate` | `url` | — |
| `getContent` | — | — |
| `getText` | — | — |
| `getUrl` | — | — |
| `getTitle` | — | — |
| `refresh` | — | — |
| `screenshot` | — | `format` (jpeg/png), `quality` (1-100) |
| `click` | `selector` | — |
| `type` | `text` | `selector` (fokus dulu) |
| `scroll` | — | `x`, `y`, `selector` |
| `evaluate` | `expression` | `awaitPromise` |

---

## Konfigurasi (.env)

```env
# Port relay server (default: 18792)
RELAY_PORT=18792

# URL relay yang dipakai Dominions (default: http://127.0.0.1:18792)
BROWSER_RELAY_URL=http://127.0.0.1:18792
```

---

## Keamanan

> **Penting** — extension pakai `chrome.debugger` yang memberi akses penuh ke tab.

- Relay hanya bind ke **127.0.0.1** — tidak pernah expose ke LAN.
- **Jangan attach tab sensitif** (internet banking, akun penting) kecuali kamu percaya sepenuhnya pada agent yang berjalan.
- Gunakan **profil Chrome terpisah** untuk relay agar session personal tidak terlibat.
- Jangan expose port relay (`18792`) ke network publik atau firewall.

---

## Troubleshooting

| Gejala | Solusi |
|--------|--------|
| Popup badge `!` | Relay belum jalan. Jalankan `npm run relay`. |
| `Extension not connected` | Buka popup → klik **Attach This Tab**. |
| Badge jadi "off" setelah navigasi | Tunggu 1–5 detik; extension akan re-attach otomatis. |
| Tab tidak re-attach setelah reload | Klik **Attach This Tab** lagi; atau periksa apakah relay masih jalan. |
| `Element not found` | Periksa CSS selector. Gunakan DevTools untuk verifikasi. |
| `Command timed out` | Halaman lambat atau elemen tidak merespons; coba lagi. |
| **`browser_task_cdp`: Invalid URL: undefined** | Restart relay (`npm run relay`) dan **reload extension** di `chrome://extensions`. Pastikan `GET /status` → `cdpExtensionConnected: true`. |
| **WebSocket connection to ws://127.0.0.1:18792/ failed: net::ERR_CONNECTION_REFUSED** | Relay tidak jalan. Di folder project jalankan `npm run relay` (biarkan jalan), atau `npm run start:all` untuk relay + server sekaligus. Lalu reload extension / attach tab lagi. |
| Port `18792` sudah dipakai | Set `RELAY_PORT=18793` di `.env`. |
| Relay reconnect lambat | Normal; backoff max 48s. Untuk dev, restart `npm run relay`. |
