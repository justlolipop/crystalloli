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

// The same logo more than once (in a big .ai, imported twice, or under two names): kept once, the
// biggest copy (the sharpest), with a name if any copy had one. Logos compare by a small fingerprint
// of the picture (16 x 16 grey, each pixel brighter than the next or not) and by their shape; under
// different names only when nearly the same picture pixel for pixel (crests can look alike that small).
// Shapes that aren't logos (crop marks, thin lines and frames: almost no ink in their box) are left out.
// list: [{ data | src, name, ...anything }] -> the same, without the doubles; how many went; how many weren't logos
export async function withoutDoubles(list) {
  // one picture at a time: hundreds decoded at once would run out of memory
  const prints = [];
  for (const x of list) prints.push(await fingerprint(x.data || x.src).catch(() => null));
  const keep = [];
  let junk = 0;
  list.forEach((x, i) => {
    const p = prints[i];
    if (p && p.ink < 0.1) { junk++; x.junk = true; return; }
    const sameName = (k) => !nameKey(x.name) || !nameKey(k.x.name) || nameKey(x.name) === nameKey(k.x.name);
    const twin = p && keep.find((k) => k.p && Math.abs(k.p.ratio - p.ratio) < 0.12 &&
      (sameName(k) ? distance(k.p.bits, p.bits) <= 40
        // the quick look first: thousands of logos compared in pairs, the full colour check only for look-alikes
        : Math.abs(k.p.ratio - p.ratio) < 0.05 && distance(k.p.bits, p.bits) <= 60 && greyDiff(k.p.grey, p.grey) < 7));
    if (!twin) { keep.push({ x, p }); return; }
    const big = (p.area || 0) > (twin.p.area || 0) ? { x, p } : twin, small = big === twin ? { x, p } : twin;
    small.x.gone = true;
    twin.x = { ...big.x, name: (big.x.name || "").trim() || small.x.name || "" };
    twin.p = big.p;
  });
  return { list: keep.map((k) => k.x), dropped: list.length - keep.length - junk, junk, gone: list.filter((x) => x.gone || x.junk) };
}
// a name to compare logos by: the school's, without "LOGO", "COPY", "FINAL" …
const nameKey = (name) => schoolKey(name).split(" ").filter((w) => w && !/^(LOGO|LOGOS|COPY|FINAL|NEW|PNG|JPG|AI)$/.test(w)).join(" ");
async function fingerprint(src) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const x = c.getContext("2d", { willReadFrequently: true });
  const shade = (w, h) => { x.fillStyle = "#ffffff"; x.fillRect(0, 0, 64, 64); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
  const lum = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  // brighter than the next pixel by a clear step (tiny differences are only how it was shrunk)
  let d = shade(17, 16);
  const bits = [];
  for (let y = 0; y < 16; y++) for (let k = 0; k < 16; k++) bits.push(lum(d, (y * 17 + k) * 4) > lum(d, (y * 17 + k + 1) * 4) + 10 ? 1 : 0);
  d = shade(32, 32);
  const grey = []; // colour, in fact: red, green and blue of each pixel (two crests alike in grey may not be)
  for (let i = 0; i < 32 * 32; i++) grey.push(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  // how much of its box has ink: a logo is mostly filled, a crop mark or a thin frame isn't
  d = shade(64, 64);
  let n = 0, l = 64, t = 64, r = -1, b = -1;
  for (let y = 0; y < 64; y++) for (let k = 0; k < 64; k++) {
    const v = lum(d, (y * 64 + k) * 4);
    if (v > 235) continue;
    n += (255 - v) / 255; // half-covered edge pixels count half
    if (k < l) l = k; if (k > r) r = k; if (y < t) t = y; if (y > b) b = y;
  }
  const box = r < 0 ? 1 : (r - l + 1) * (b - t + 1);
  c.width = c.height = 0;
  return { bits, grey, ink: r < 0 ? 0 : n / box, ratio: (img.naturalWidth || 1) / (img.naturalHeight || 1), area: (img.naturalWidth || 0) * (img.naturalHeight || 0) };
}
const distance = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
const greyDiff = (a, b) => a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0) / a.length;
