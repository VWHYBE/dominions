# Dominions — TODOs & Masukan

Daftar todo dan saran pengembangan untuk project Dominions.

> **Catatan:** Daftar ini bisa dikerjakan bertahap; tidak perlu buru-buru. Istirahat dulu kalau capek — nanti lanjut lagi.

---

## TODOs

### Prioritas tinggi

- [ ] **Testing**
  - Unit test untuk `agentManager`, `minions/registry`, `extractHtmlFromResults` (server).
  - E2E atau integration test untuk `POST /api/run` dan MCP pipeline flow.
  - Optional: test browser-relay (mock Chrome API atau manual checklist).

- [ ] **Dokumentasi**
  - Update README utama: sebut MCP, browser relay, pipeline preview, `npm start` vs `npm start relay` vs `npm run start:all`.
  - Doc singkat cara pakai `run_pipeline_mcp` dari Cursor (config MCP, server harus jalan).
  - Tambah `.env.example` untuk `BROWSER_RELAY_URL`, `RELAY_PORT` jika belum jelas.

- [ ] **Result folder & preview**
  - Putuskan: folder `result/` hanya output pipeline (preview.html + landing-*.html) atau juga dipakai project lain (Vite/React di `result/`). Kalau campuran, pertimbangkan `result/preview/` vs `result/build/` atau pisah repo/subfolder.
  - Pastikan `GET /result/:name` dan static `/result` konsisten (mis. hanya serve `.html` atau whitelist ekstensi).

### Prioritas menengah

- [ ] **Agent UI/UX (providing UI + preview)**
  - ~~Tambah minion (atau pipeline khusus) yang fokus **memberi saran dan implementasi UI/UX**.~~ **Prep selesai:** minion **UI/UX** ditambah di `minions/config.json` (order 2, antara Coder dan Reviewer). Server prefer output `ui-ux` untuk preview di panel BROWSER.
  - Output: selain kode (HTML/CSS/JS atau komponen), **tampilkan juga komponennya lewat HTML** — mirip flow landing page sekarang: hasil Coder (snippet HTML/komponen) di-serve dan **langsung tampil di panel BROWSER** (iframe `/preview` atau `/result/...`).
  - Alur yang diinginkan: user minta UI/komponen → pipeline (atau agent UI/UX) produce kode + generate HTML yang bisa di-preview → otomatis tampil di sisi kanan (BROWSER panel) tanpa harus copy-paste ke file manual.
  - Bisa dipakai untuk: komponen isolasi (button, card, form), halaman penuh, atau wireframe → jadi “code + live preview” dalam satu run.

- [ ] **Error handling & feedback**
  - Frontend: tampilkan pesan error dari API (run failed, relay not connected) di UI, bukan cuma di console/ticker.
  - MCP: pesan error sudah lebih jelas (Indonesia); pastikan Cursor menampilkan isi error dengan baik.
  - Relay: user-friendly message saat attach gagal (mis. tab chrome://) atau relay putus.

- [ ] **Pipeline & BROWSER panel**
  - Opsi “Buka hasil di tab baru” selain tampil di iframe (copy URL `/result/...` atau `/preview`).
  - Optional: dropdown/picker “Tampilkan file hasil” (preview vs landing-bahaya-narkoba.html) kalau ada banyak file di `result/`.

- [ ] **Browser relay**
  - White flash saat attach: sudah dikurangi dengan delay `Page.enable`; pantau apakah perlu delay lain atau dokumentasi saja.
  - Deprecation warning di `start-with-relay.js` (shell: true): ganti ke `shell: false` + array args jika aman.

### Prioritas rendah

- [ ] **Kode & maintainability**
  - TypeScript atau JSDoc types untuk `server.js`, `mcp-server.js`, `agentManager.js` agar refactor lebih aman.
  - Shared constants (e.g. route paths `/api/...`, `/preview`, `/result`) di satu tempat jika makin banyak endpoint.

- [ ] **Keamanan**
  - Rate limit atau batas ukuran body untuk `/api/run`, `/api/pipeline/mcp/*` jika dipakai di lingkungan terbuka.
  - Validasi ketat untuk `run_pipeline_mcp` (task length, sanitasi sebelum disimpan ke result).

- [ ] **CI / DX**
  - Script `npm run check` (lint + test) untuk CI.
  - Optional: pre-commit hook (lint / format) agar style konsisten.

---

## Masukan untuk project

### Arsitektur & fitur

1. **Pemisahan “result”**
   - Sekarang: `result/` dipakai untuk (1) output pipeline (preview.html, landing-*.html) dan (2) project Vite/React (package.json, vite.config, dll). Agar tidak bingung, bisa dipisah: mis. `output/` atau `dist/preview/` untuk file hasil pipeline, dan `result/` hanya untuk project lain; atau dokumentasikan dengan jelas di README bahwa `result/` punya dua “zona”.

2. **MCP sebagai first-class flow**
   - `run_pipeline_mcp` sudah kuat (Planner → Coder → Reviewer + report_mcp_result + finish). Bisa ditambah contoh “playbook” di doc: task seperti apa yang cocok (landing page, report, refactor), dan best practice urutan panggil tool (run → report per minion → finish).

3. **Agent UI/UX + preview komponen**
   - Ide: agent yang khusus **providing UI/UX** — output bukan cuma kode, tapi **komponen bisa langsung ditampilkan lewat HTML** di panel BROWSER (seperti landing page bahaya narkoba). Satu run = dapat kode + preview live. Cocok untuk komponen (button, card, form), halaman, atau wireframe. Sudah masuk TODOs di atas.

4. **Relay & extension**
   - Relay sudah solid (reconnect, re-attach, CDP + high-level). Yang bisa ditambah: daftar “supported actions” di popup atau README (navigate, click, type, screenshot, evaluate, dll) plus contoh `browser_task` / `browser_task_cdp` agar user cepat coba.

### UX & UI

5. **Feedback jelas**
   - Saat pipeline jalan (terutama MCP), status “RUNNING” / “DONE” sudah ada; tambah indikator loading atau disable tombol yang relevan agar user tidak double-submit.
   - Error dari server (run failed, relay unreachable) sebaiknya muncul di panel atau toast, tidak hanya di ticker/console.

6. **Panel BROWSER**
   - Sekarang iframe load `/preview` atau URL lain. Kalau iframe error (404, CORS, dll), tampilkan pesan “Gagal memuat preview” dan link “Buka di tab baru” supaya user bisa debug.

7. **Layout pipeline**
   - Rasio 35% (kiri) / 65% (kanan) dan full height sudah oke; kalau nanti ada banyak lane, pertimbangkan collapse/expand per lane atau scroll yang jelas.

### Keamanan & operasional

8. **Env & secrets**
   - Pastikan `.env` tidak ikut commit; `.env.example` tanpa nilai rahasia sudah benar. Bisa tambah satu baris di README: “Jangan commit .env”.

9. **Port & URL**
   - Port 3000 (server) dan 18792 (relay) didokumentasikan; kalau dipakai di lingkungan lain (docker, cloud), env `PORT` dan `RELAY_PORT` / `BROWSER_RELAY_URL` harus jelas di doc.

### Performa & skalabilitas

10. **Pipeline panjang**
   - Untuk banyak minion atau task berat, pertimbangkan batas timeout atau “cancel run” dari UI agar satu run tidak menggantung lama.

11. **Memory & last-results**
    - `memory.json` dan `last-results.json` bisa membesar; optional: rotasi atau batas ukuran, atau pembersihan dari UI (sudah ada clear memory).

---

## Ringkasan prioritas

| Area        | Fokus singkat                                      |
|------------|-----------------------------------------------------|
| Agent UI/UX| Minion/pipeline UI/UX + code + preview HTML di panel BROWSER |
| Testing    | Unit + integration untuk pipeline & MCP             |
| Docs       | README + MCP + relay + result folder               |
| Result     | Pisah atau dokumentasi jelas isi `result/`         |
| Error UX   | Tampilkan error API/relay di UI                     |
| Types/Lint | JSDoc/TS + script check untuk konsistensi          |

File ini bisa dipakai sebagai backlog; setiap item bisa dipindah ke issue tracker (GitHub Issues, dll) kalau dipakai.
