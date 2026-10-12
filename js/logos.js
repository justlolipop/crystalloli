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
  // short forms of words written either way: TMN = TAMAN, SRI = SERI …
  return s.replace(/\s+/g, " ").trim().split(" ").map((w) => WORDS[w] || w).join(" ");
}
const WORDS = { TMN: "TAMAN", SRI: "SERI", KG: "KAMPUNG", KPG: "KAMPUNG", BDR: "BANDAR", JLN: "JALAN", BKT: "BUKIT", SG: "SUNGAI", SGI: "SUNGAI", PDG: "PADANG", LDG: "LADANG", BT: "BATU" };

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

// the kept logo whose school's name is written in these words (a crystal's header: "SK TAMAN SERI
// PAGI ANUGERAH …"), or null: the longest name found, as whole words
// (all its words there in any order count too, for a name of 3 words or more)
export function logoInText(text, list) {
  const t = " " + schoolKey(text) + " ", have = new Set(t.trim().split(" "));
  let best = null;
  for (const x of Array.isArray(list) ? list : []) {
    const k = schoolKey(x.name), ws = k.split(" ");
    if (k.length < 5) continue;
    if (!t.includes(" " + k + " ") && !(ws.length >= 3 && ws.every((w) => have.has(w)))) continue;
    if (!best || k.length > best.k.length) best = { x, k };
  }
  return best ? best.x : null;
}

const pictures = new Map(); // kept logo file -> its data URL (a promise), read once
const keptPicture = (x) => {
  if (!pictures.has(x.file)) pictures.set(x.file, toDataUrl(fileUrl(x.file)));
  return pictures.get(x.file);
};

// For an order's crystals: row -> the logo (data URL) or null. The logo uploaded with the order,
// else the kept one for the order's school, else the kept one whose school is named in the
// crystal's own words (its header first).
// pick.which(row): which logo that is, to say so — { how: "order" | "school" | "words", name } or null
export function logoPicker({ logo, school }, list) {
  const own = toDataUrl(logo);
  const bySchool = logoFor(school, list);
  const inWords = (r) => logoInText(r.event_header || "", list) ||
    logoInText(Object.values(r).filter((v) => typeof v === "string").join(" \n "), list);
  const pick = async (row) => {
    const o = await own;
    if (o) return o;
    if (bySchool) return keptPicture(bySchool);
    const found = inWords(row || {});
    return found ? keptPicture(found) : null;
  };
  pick.which = (row) => (logo ? { how: "order", name: "uploaded with the order" } : bySchool ? { how: "school", name: bySchool.name }
    : (() => { const f = inWords(row || {}); return f ? { how: "words", name: f.name } : null; })());
  pick.count = Array.isArray(list) ? list.length : 0;
  return pick;
}
