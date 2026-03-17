# Unsupervised Learning Agent — Feasibility & Rancangan

**Tujuan:** Agent yang bisa belajar tanpa supervisi (dari eksplorasi/trace), dengan memory stack (Qdrant + SQLite + opsional Discord). **Dokumen ini hanya rancangan; tidak ada eksekusi implementasi.**

---

## 1. Apa bisa diimplementasi?

**Ya, bisa.** Arsitektur di diagram Anda cocok dengan codebase Dominions dengan penambahan komponen berikut.

### Yang sudah ada di Dominions

| Komponen | Status | Keterangan |
|----------|--------|------------|
| Orchestrator / pipeline | ✅ | `agentManager.js` + pipeline events; pre-hook & inject system prompt per minion |
| Model AI (agnostic + tools) | ✅ | OpenRouter/LLM di `llm.js`; minions dapat konteks + skills; MCP tools di `mcp-server.js` |
| Executor browser | ✅ | `browserCdpRunner.js` (Playwright + CDP); executor mobile: `mobileWebRunner.js` |
| Memory (dasar) | ⚠️ Partial | `memoryManager.js`: `memory.json` (shared) + per-agent `agents/<id>.memory.md` (LTM). **Tanpa vector search, tanpa SQLite.** |

### Yang belum ada (gap)

| Komponen | Peran | Yang perlu ditambah |
|----------|--------|----------------------|
| **Memory stack (Qdrant)** | Vector search: query by embedding → inject "steps + uiHash + skor" ke prompt | Service embedding (e.g. Gemini embed / OpenAI) + Qdrant (local/docker atau cloud); simpan trace sebagai vector + metadata |
| **Memory stack (SQLite)** | Penyimpanan terstruktur: trace, site, taskType, selector, outcome, timestamp | DB schema + layer baca/tulis dari runner & orchestrator |
| **save_exploration** | Setelah Playwright/mobile runner selesai (sukses/gagal) → simpan trace ke Qdrant + SQLite | Hook di akhir `browserCdpRunner` / `mobileWebRunner` → panggil `saveExplorationTrace(...)` |
| **Retrieval ke orchestrator** | Pre-hook: user message → embed → Qdrant search → inject ke system prompt | Di pipeline start (atau di agent run): query memory by task/site → inject "steps + uiHash + skor" ke system prompt minion yang relevan |
| **invalidate_memory + reexplore queue** | Jika selector gagal: hapus trace terkait, jadwalkan ulang site+taskType | Flag outcome di trace; job/queue (in-memory atau Redis/SQLite) + scheduler reexplore |
| **Discord** | Opsional: notifikasi / log / umpan balik | Webhook atau bot; bisa fase kedua |

Kesimpulan: **implementasi feasible** dengan menambah layer Memory stack (Qdrant + SQLite), hook save_exploration di executor, dan retrieval + (opsional) reexplore queue di orchestrator.

---

## 2. Apa bisa dipakai di semua agent?

**Ya, bisa**, dalam dua tingkat pemakaian.

### Tingkat 1: Satu “Explorer” agent (unsupervised loop penuh)

- **Siapa:** Satu agent khusus (e.g. `explorer` / `browser_explorer`) yang:
  - Mendapat task (site + taskType atau natural language).
  - **Query memory** (Qdrant + SQLite): ambil trace mirip (embedding + filter site/taskType).
  - **Inject ke system prompt:** "steps + uiHash + skor" dari trace.
  - **Playwright execute steps** (dari memory atau dari LLM).
  - **Selector berhasil?**
    - **Ya** → `save_exploration` → simpan trace baru (Qdrant + SQLite [+ Discord]).
    - **Tidak** → `invalidate_memory` (hapus/update Qdrant + SQLite) → **reexplore queue** (site + taskType) → **Explorer agent ulang** (retry).

- **Di mana di codebase:** Bisa sebagai minion baru di `minions/config.json` + task runner khusus (e.g. perluas `browserCdpRunner.js` atau wrapper yang memanggil runner + memory hooks). Pipeline lain (Planner → Coder → Reviewer → Mobile Runner) tidak wajib ikut loop ini; hanya Explorer yang pakai full loop diagram Anda.

- **“Disemua agent” di sini:** Bisa satu agent dulu; nanti pola yang sama bisa dipakai untuk agent explorer lain (e.g. mobile_explorer).

### Tingkat 2: Semua minion pakai memory stack (retrieval + append)

- **Ide:** Setiap minion (planner, coder, reviewer, mobile_runner, dll.) bisa:
  - **Retrieval:** Sebelum panggil LLM, orchestrator/pre-hook: embed (task + minion id) → query Qdrant/SQLite → inject konteks relevan (bukan hanya LTM markdown saat ini).
  - **Append:** Setelah run, selain `appendAgentLongTermMemory` seperti sekarang, juga **tulis ke memory stack** (vektor + metadata ke Qdrant, ringkasan ke SQLite) agar run berikut bisa pakai.

- **Perubahan:** 
  - **Orchestrator (pre-hook):** Untuk setiap minion, tambah step: "query memory stack by (task, minion_id)" → inject hasil ke system prompt.
  - **Setelah run:** Panggil `saveExplorationTrace` atau padanannya (bukan hanya `appendAgentLongTermMemory`). Untuk minion non-browser, "trace" bisa berbentuk: task, output summary, minion_id, timestamp (tanpa selector/UI).

- **“Disemua agent”:** Ya — semua minion yang ikut pipeline bisa pakai memory stack yang sama; retrieval/per-minion bisa di-filter by `minion_id` atau `role`.

### Ringkas

- **Explorer agent (unsupervised penuh):** Satu (atau beberapa) agent dengan loop execute → save / invalidate → reexplore; bisa diimplementasi pertama.
- **Semua agent:** Bisa pakai memory stack yang sama (Qdrant + SQLite) untuk retrieval + append; implementasi bertahap (pilot di 1–2 minion dulu, lalu generalisasi).

---

## 3. Alur yang bisa dipetakan ke codebase

### Diagram 1 (User request → Orchestrator → Model AI → Playwright; Memory stack)

- **User request** → pipeline task (sudah ada).
- **Orchestrator** = pipeline start + pre-hook per minion (bisa diperluas di `agentManager.js` atau middleware pipeline).
- **Query memory** = panggil service "memory stack" (Qdrant + SQLite) di pre-hook; inject hasil ke system prompt.
- **Model AI** = LLM per minion (sudah); "MCP tools" = tools yang bisa baca/tulis memory (e.g. `get_memory` / `clear_memory` diperluas atau tambah `search_memory`, `save_trace`).
- **Playwright** = `browserCdpRunner.js` (dan/atau mobile runner).
- **save_exploration** = dipanggil di akhir runner (sukses/gagal) → tulis ke Qdrant + SQLite.

### Diagram 2 (User message → embed → Qdrant → inject / prompt exploration → model)

- **Gemini embed (cache check)** = service embedding (Gemini/OpenAI) + cache optional (in-memory atau SQLite).
- **Qdrant search (cosine)** = layer memory stack.
- **Memory found?** → inject "steps + uiHash + skor" ke system prompt; **tidak** → fallback exact match / quota habis → **prompt exploration** (instruksi explore dulu) → **kirim ke model**. Bisa jadi bagian pre-hook sebelum panggil LLM untuk Explorer (atau minion lain).

### Diagram 3 (Playwright execute → selector berhasil? → save trace / invalidate → reexplore queue → Explorer ulang)

- **Playwright execute steps dari memory** = runner baca "steps" dari hasil retrieval, eksekusi lewat Playwright (browserCdpRunner sudah punya loop step-by-step).
- **Selector berhasil?** = cek outcome step (selector found, action success); bisa di dalam runner atau di layer pemanggil.
- **Task sukses → save_exploration** = simpan trace (Qdrant + SQLite [+ Discord]).
- **Gagal → invalidate_memory** = hapus/update record Qdrant + SQLite untuk site+taskType/selector tersebut.
- **Reexplore queue** = struktur data (queue) site + taskType; **Explorer agent ulang** = panggil lagi runner dengan task yang sama atau task “reexplore” (bisa in-memory queue + setTimeout/worker, atau Redis/Bull nanti).

Semua alur di atas **bisa** diimplementasi tanpa mengubah struktur pipeline yang ada; yang ditambah adalah **layer memory stack** dan **hook** di orchestrator dan di runner.

---

## 4. Rekomendasi implementasi (tanpa eksekusi sekarang)

1. **Fase 0 (sekarang):** Tidak eksekusi; hanya dokumen ini + diskusi.
2. **Fase 1 — Memory stack:**
   - Tambah Qdrant (local/docker) + schema collection (embedding + metadata: site, taskType, steps, uiHash, skor, timestamp, minion_id).
   - Tambah SQLite (file di project) + tabel trace (id, site, task_type, steps_json, outcome, selector_snapshot, created_at).
   - Service embedding (satu API: teks → vector); cache opsional.
3. **Fase 2 — Explorer agent:**
   - Satu minion `explorer` (atau `browser_explorer`) yang di-trigger oleh task khusus (e.g. "explore site X" / "reexplore").
   - Pre-hook: user message → embed → Qdrant search → inject ke prompt → panggil `browserCdpRunner` (atau wrapper) dengan konteks dari memory.
   - Di akhir runner: `save_exploration` (sukses) atau `invalidate_memory` + push ke reexplore queue (gagal); trigger Explorer ulang dari queue.
4. **Fase 3 — Semua agent pakai memory stack:**
   - Pre-hook untuk setiap minion: query memory by (task, minion_id) → inject ke system prompt.
   - Setelah run: tulis ringkasan/trace ke Qdrant + SQLite (bukan hanya LTM markdown).
5. **Opsional:** Discord webhook untuk notifikasi trace sukses/gagal; reexplore queue pakai Redis/Bull jika perlu skala besar.

---

## 5. Kesimpulan

- **Apa bisa kita implementasi?** **Ya.** Dengan menambah memory stack (Qdrant + SQLite), hook save_exploration di executor, retrieval di orchestrator, dan (untuk unsupervised penuh) loop invalidate + reexplore queue.
- **Apa bisa kita implement di semua agent?** **Ya.** Bisa dimulai dengan satu Explorer agent (unsupervised penuh), lalu memory stack yang sama dipakai untuk semua minion (retrieval + append) agar semua agent bisa belajar dari trace/run sebelumnya.
- **Tanpa eksekusi:** Dokumen ini hanya rancangan; implementasi bisa mengikuti fase di atas setelah disetujui.
