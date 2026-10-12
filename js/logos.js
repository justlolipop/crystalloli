// School logos: kept online (store.logos(), the "School logos" window in the editor), each with
// its school's name. A crystal of an order gets its school's logo where the design's own logo was
// (see library.js logoPlace and editor.js addLogo): the logo the teacher uploaded with the order,
// else the one kept here whose name matches the order's school.

import { fileUrl } from "./store.js";

// a school's name to compare by: capitals, no punctuation, the usual long forms made short
// ("Sekolah Kebangsaan Taman Seri Pagi" and "SK TAMAN SERI PAGI" are the same school)
export function schoolKey(name) {
  let s = " " + String(name || "").toUpperCase().replace(/\(\s*([A-Z])\s*\)/g, "$1").replace(/[^A-Z0-9]+/g, " ") + " ";
  const short = [
    [/ SEKOLAH MENENGAH KEBANGSAAN /g, " SMK "], [/ SEKOLAH JENIS KEBANGSAAN CINA /g, " SJKC "],
    [/ SEKOLAH JENIS KEBANGSAAN TAMIL /g, " SJKT "], [/ SEKOLAH JENIS KEBANGSAAN /g, " SJK "],
    [/ SEKOLAH KEBANGSAAN /g, " SK "], [/ SEKOLAH RENDAH /g, " SR "], [/ SEKOLAH MENENGAH /g, " SM "],
    [/ SJK C /g, " SJKC "], [/ SJK T /g, " SJKT "],
  ];
  for (const [re, to] of short) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

// the kept logo for a school, or null: the same name, else nearly (most of the words the same)
export function logoFor(school, list) {
  const key = schoolKey(school);
  if (!key || !Array.isArray(list) || !list.length) return null;
  const exact = list.find((x) => schoolKey(x.name) === key);
  if (exact) return exact;
  const words = new Set(key.split(" "));
  let best = null;
  for (const x of list) {
    const other = new Set(schoolKey(x.name).split(" ").filter(Boolean));
    if (!other.size) continue;
    const same = [...other].filter((w) => words.has(w)).length;
    const score = same / Math.max(words.size, other.size);
    if (score >= 0.75 && (!best || score > best.score)) best = { x, score };
  }
  return best ? best.x : null;
}

// a picture (a web address or a data URL) as a data URL, so it can go into downloads and
// Illustrator; null when it can't be read
export async function toDataUrl(src) {
  if (typeof src !== "string" || !src) return null;
  if (/^data:image\//.test(src)) return src;
  if (!/^https?:\/\//.test(src)) return null;
  try {
    const r = await fetch(src);
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!/^image\//.test(blob.type) || blob.size > 8e6) return null;
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
  } catch (e) { return null; }
}

// the logo for an order's crystals (data URL) or null: the one uploaded with the order, else the
// kept one for its school
export async function orderLogo({ logo, school }, list) {
  const own = await toDataUrl(logo);
  if (own) return own;
  const kept = logoFor(school, list);
  return kept ? toDataUrl(fileUrl(kept.file)) : null;
}
