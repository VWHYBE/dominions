# Dominions — Multi-Minion AI

Multi-minion pipeline dengan **OpenRouter** atau **Ollama (local model)** dan minion dinamis. Tanpa MCP, tanpa Vector DB. Cocok untuk lingkungan ketat (laptop kantor).

## Arsitektur

```
Web UI → Express API → Agent Manager → [Minion 1, Minion 2, …] (LLM: OpenRouter atau Ollama) → memory.json
```

- **server.js** — API Express + serve frontend
- **agentManager.js** — Jalankan pipeline minion (urutan dari config)
- **llm.js** — Pilih backend: OpenRouter (cloud) atau Ollama (local)
- **openRouter.js** — Klien OpenRouter (chat completions)
- **ollama.js** — Klien Ollama (local model, e.g. http://localhost:11434)
- **minions/** — Modul minion: config + registry
  - **minions/config.json** — Definisi minion (id, name, systemPrompt, order)
  - **minions/registry.js** — Baca/tulis config
  - **minions/index.js** — Re-export API
- **memoryManager.js** — Memory per role (shared + per minion id)
- **frontend/** — Task input, Run, panel output dinamis, form tambah minion

## Setup

1. **Copy env dan pilih backend LLM**

   ```bash
   cp .env.example .env
   ```

   **Opsi A — OpenRouter (cloud)**  
   Edit `.env`, set API key dari [OpenRouter](https://openrouter.ai/):

   ```
   OPENROUTER_API_KEY=sk-or-v1-your-key-here
   # opsional: LLM_PROVIDER=openrouter
   ```

   **Opsi B — Ollama (model lokal)**  
   Pastikan [Ollama](https://ollama.com) jalan (e.g. `ollama serve`), lalu di `.env`:

   ```
   LLM_PROVIDER=ollama
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=llama3.2
   ```

   Jika keduanya di-set, `LLM_PROVIDER` menentukan mana yang dipakai. Tanpa `LLM_PROVIDER`: OpenRouter dipakai bila `OPENROUTER_API_KEY` ada, else Ollama bila `OLLAMA_BASE_URL` ada.

2. **Jalankan**

   ```bash
   npm install
   npx playwright install chromium   # sekali saja, untuk fitur run-with-url
   npm start
   ```

   Buka http://localhost:3000

## Minion dinamis

Minion didefinisikan di **minions/config.json** (atau lewat API):

- **id** — unik (mis. planner, coder, reviewer)
- **name** — nama tampilan
- **systemPrompt** — instruksi sistem untuk LLM
- **order** — urutan eksekusi (0, 1, 2, …)

Contoh isi `minions/config.json`:

```json
{
  "minions": [
    { "id": "planner", "name": "Planner", "systemPrompt": "You are a Planner. Break the task into numbered steps.", "order": 0 },
    { "id": "coder", "name": "Coder", "systemPrompt": "You are a Coder. Produce solution or code.", "order": 1 },
    { "id": "reviewer", "name": "Reviewer", "systemPrompt": "You are a Reviewer. Give verdict and suggestions.", "order": 2 }
  ]
}
```

Di **Web UI** kamu bisa:
- Lihat daftar minion
- **Tambah minion** (id, name, systemPrompt, order)
- **Hapus minion**
- **Run** — pipeline dijalankan sesuai urutan; output tiap minion tampil di panel

## API

- `POST /api/run` — body `{ "task": "..." }` → jalankan pipeline, response `{ results: { [minionId]: string } }`
- `POST /api/run-with-url` — body `{ "url": "https://...", "task": "..." }` → scrape halaman pakai Playwright, AI ekstrak sections, lalu jalankan pipeline. Cocok untuk alur: kasih URL tiket → dapat rekomendasi section → bayar di situs. Butuh `playwright` + `npx playwright install chromium`. **Opsional:** `clickFirstButton: true` atau `clickButtonIndex: 0` atau `clickButtonText: "Pilih"` — sistem akan klik tombol tersebut, ambil isi halaman setelah klik, dan laporkan ke pipeline (field `afterClick`).
- `GET /api/llm-provider` — response `{ provider: "openrouter"|"ollama"|null, configured: boolean }` (backend LLM yang aktif)
- `GET /api/memory` — query `?role=shared` (opsional) → isi memory
- `POST /api/memory/clear` — body `{ "role": "..." }` (opsional) → clear memory
- `GET /api/minions` → daftar minion
- `POST /api/minions` — body `{ id, name?, systemPrompt, order?, model? }` → tambah minion
- `PUT /api/minions/:id` — update minion
- `DELETE /api/minions/:id` — hapus minion

## Memory

File **memory.json**: key `shared` + satu key per minion id. Setiap entri: `role`, `timestamp`, `message`.

## Persyaratan

- Node.js >= 18
- OPENROUTER_API_KEY (wajib)
