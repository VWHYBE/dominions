/**
 * Section extractor — pakai LLM untuk ekstrak daftar section/paket tiket dari HTML/teks halaman.
 * Output format sesuai yang dipakai section_chooser minion.
 */

import * as llm from "../llm.js";

const EXTRACT_SYSTEM = `Kamu ekstraktor data. Dari konten halaman web (HTML atau teks) yang diberikan, ambil daftar paket/section tiket (atau produk yang bisa dipilih).

Kembalikan HANYA satu JSON object valid, tanpa markdown dan tanpa teks lain, dengan format:
{
  "url": "<url halaman>",
  "pageTitle": "<judul halaman>",
  "sections": [
    {
      "id": "string unik singkat (mis. vip-1, a, regular)",
      "label": "nama paket/section + harga jika ada",
      "available": true atau false,
      "price": "teks harga jika ada (opsional)",
      "clickSelector": "selector CSS atau deskripsi tombol/link jika bisa diidentifikasi (opsional)"
    }
  ]
}

Aturan:
- Hanya section/paket yang punya opsi beli atau pilih.
- available = true jika tampak masih bisa dipesan/dibeli, false jika sold out atau tidak aktif.
- id harus unik dan singkat (huruf/angka).
- Jika tidak ada satupun section yang bisa diambil, kembalikan sections: [].
- Jangan tambah field lain. Jangan komentar. Hanya JSON saja.`;

/**
 * Ekstrak sections dari konten halaman via LLM.
 * @param {{ html?: string; text: string; title: string }} pageContent — dari pageScraper
 * @param {string} url
 * @returns {Promise<{ url: string; pageTitle: string; sections: Array<{ id: string; label: string; available: boolean; price?: string; clickSelector?: string }> }>}
 */
export async function extractSections(pageContent, url) {
  const text = (pageContent.text || "").slice(0, 30000);
  const userContent = `URL: ${url}\nTitle: ${pageContent.title || ""}\n\nKonten halaman (teks):\n${text}`;
  const out = await llm.complete(userContent, EXTRACT_SYSTEM, { maxTokens: 2048 });
  if (!out || !out.trim()) {
    return { url, pageTitle: pageContent.title || "", sections: [] };
  }
  const cleaned = out.replace(/```json?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const sections = Array.isArray(parsed.sections)
      ? parsed.sections.filter((s) => s && typeof s.id === "string" && typeof s.label === "string")
      : [];
    return {
      url: parsed.url ?? url,
      pageTitle: parsed.pageTitle ?? pageContent.title ?? "",
      sections,
    };
  } catch {
    return { url, pageTitle: pageContent.title || "", sections: [] };
  }
}
