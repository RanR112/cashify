// Tahap 1: normalisasi (ARCHITECTURE.md Bagian 7). Teks untuk pencocokan dirapikan; teks asli
// dibawa apa adanya karena itu yang ditampilkan kembali ke pengguna.

import type { NormalizedText } from './types.js';

// Emoji (termasuk yang bermodifikasi/gabungan ZWJ dan bendera) dibuang. Digit dan simbol seperti
// "#" sengaja tidak termasuk: `\p{Emoji}` akan menelan angka, `Extended_Pictographic` tidak.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍️⃣]/gu;

export function normalize(raw: string): NormalizedText {
  const text = raw.replace(EMOJI, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return { original: raw, text };
}
