// Plak templates scanned from your .ai files by ExportTemplates.jsx (the same data Plak Master uses).
// Each .ai has several template groups named like T_H_Y_PC_L1_L2 (T = latin, TC = Chinese; H header,
// Y year, PC position, L1/L2/L3 event lines). Coordinates are pt around the ANCHOR_CIRCLE centre, y up.
// The rules below mirror the live .jsx: the row's filled fields pick the template, a long line
// shrinks to fit its box, and a cell's line count is kept exactly (no automatic wrapping).

import { hasCJK } from "./util.js";
import { useFont } from "./fonts.js";

export const PLAK_FIELDS = ["event_header", "position", "event_line_1", "event_line_2", "event_line_3", "year"];
export const FIELD_LABEL = {
  event_header: "Header", position: "Position", event_line_1: "Line 1", event_line_2: "Line 2", event_line_3: "Line 3",
  year: "Year", jenis_plak: "Plak code", category: "Category", qty: "Qty",
};
const TOKENS = [["H", "event_header"], ["Y", "year"], ["PC", "position"], ["L1", "event_line_1"], ["L2", "event_line_2"], ["L3", "event_line_3"]];
const TOKEN_FIELD = Object.fromEntries(TOKENS);
const MIN_SIZE = 5, MIN_SIZE_POSITION = 4, STEP = 0.5;
const norm = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();

export const plak = { info: { available: false, files: [], mapping: [], rank: { yellow: [], grey: [], brown: [] }, fonts: [] }, cache: {} };

export async function loadPlakInfo() {
  try {
    const r = await fetch("/api/plak");
    if (r.ok) plak.info = await r.json();
  } catch (e) {}
  return plak.info;
}

export function loadPlakFile(file) {
  if (!plak.cache[file]) {
    plak.cache[file] = fetch("/api/plak/template?file=" + encodeURIComponent(file))
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return plak.cache[file];
}

export function forgetPlakFiles() { plak.cache = {}; }

// ------------------------------------------------------------------ which template

export function templateNameFor(row) {
  let n = PLAK_FIELDS.some((f) => hasCJK(row[f])) ? "TC" : "T";
  for (const [tok, f] of TOKENS) if (String(row[f] || "").trim()) n += "_" + tok;
  return n;
}

export function parseTemplateName(name) {
  const m = /^(TC|T)((?:_(?:H|Y|PC|L1|L2|L3))*)$/.exec(name || "");
  if (!m) return null;
  const info = { cjk: m[1] === "TC", fields: {}, count: 0 };
  m[2].split("_").forEach((p) => {
    const f = TOKEN_FIELD[p];
    if (f && !info.fields[f]) { info.fields[f] = true; info.count++; }
  });
  return info;
}

export function describeTemplate(name) {
  const info = parseTemplateName(name);
  if (!info) return name;
  const parts = TOKENS.filter(([, f]) => info.fields[f]).map(([, f]) => FIELD_LABEL[f]);
  return parts.join(" · ") + (info.cjk ? " · 华文" : "");
}

// exact template if the .ai has it, otherwise the closest one that has every field the row needs
export function pickTemplate(tj, name) {
  if (!tj || !tj.templates) return null;
  if (tj.templates[name]) return { name, fallback: false };
  const need = parseTemplateName(name);
  if (!need) return null;
  let best = null, bestScore = null;
  for (const n of Object.keys(tj.templates)) {
    const c = parseTemplateName(n);
    if (!c || !Object.keys(need.fields).every((f) => c.fields[f])) continue;
    const score = (c.cjk === need.cjk ? 0 : 100) + (c.count - need.count);
    if (bestScore === null || score < bestScore) { best = { name: n, fallback: true }; bestScore = score; }
  }
  return best;
}

export function sortTemplateNames(names) {
  return [...names].sort((a, b) => {
    const A = parseTemplateName(a), B = parseTemplateName(b);
    if (!A || !B) return a.localeCompare(b);
    return (A.cjk - B.cjk) || (B.count - A.count) || a.localeCompare(b);
  });
}

export function rankColor(pos) {
  const r = String(pos || "").replace(/\s+/g, " ").trim().toUpperCase();
  let best = null, color = null;
  for (const c of ["grey", "brown", "yellow"]) {
    for (const kw of plak.info.rank[c] || []) {
      const k = kw.replace(/\s+/g, " ").trim().toUpperCase();
      if (k && r.includes(k) && (!best || k.length > best.length)) { best = k; color = c; }
    }
  }
  return color;
}

function positionFrame(tpl, row, posColor) {
  if (posColor !== "red") {
    const c = rankColor(row.position);
    const n = c ? "RANK_" + c.toUpperCase() : null;
    if (n && tpl.fields[n]) return n;
  }
  return tpl.fields.position ? "position" : null;
}

export function hasRankFrames(tj) {
  return Object.values(tj.templates || {}).some((t) => t.fields && (t.fields.RANK_YELLOW || t.fields.RANK_GREY || t.fields.RANK_BROWN));
}

// product code from the Excel (jenis plak) -> .ai file, same order of tries as Plak Master
export function resolveFile(code) {
  if (!code) return null;
  const { mapping, files } = plak.info;
  const m = mapping.find((x) => norm(x.code) === norm(code));
  if (m) return m.filename;
  const names = files.map((f) => f.file);
  const num = /E\s*CUT\s*(\d+)/i.exec(code);
  if (num) {
    const f = names.find((a) => { const k = /E\s*CUT\s*(\d+)/i.exec(a); return k && k[1] === num[1]; });
    if (f) return f;
  }
  return names.find((a) => norm(a).includes(norm(code))) || null;
}

export function codeForFile(file) {
  const m = plak.info.mapping.find((x) => x.filename === file);
  return m ? m.code : "";
}

// ------------------------------------------------------------------ text measuring

const mctx = document.createElement("canvas").getContext("2d");
const quoteFamily = (css) => (/[,"']/.test(css) ? css : `"${css}"`);

export function textWidth(line, css, size, tracking, hScale) {
  mctx.font = `${size}px ${quoteFamily(css)}`;
  const chars = [...line].length;
  return (mctx.measureText(line).width + (tracking || 0) / 1000 * size * Math.max(0, chars - 1)) * (hScale || 1);
}

// shrink 0.5pt at a time until every line fits the width (never wraps: line count stays the cell's)
export function fitSize(text, css, size, tracking, hScale, maxW, minSize = MIN_SIZE) {
  if (!(maxW > 0)) return size;
  const lines = String(text).split("\n");
  const widest = (s) => Math.max(...lines.map((l) => textWidth(l, css, s, tracking, hScale)));
  while (size > minSize && widest(size) > maxW + 0.5) size = Math.round((size - STEP) * 100) / 100;
  return size;
}

// ------------------------------------------------------------------ scene

function variantPng(bg, variant, row) {
  const v = bg.variants || {};
  if (!Object.keys(v).length) return bg.png;
  if (variant && variant !== "auto" && v[variant]) return v[variant];
  const c = rankColor(row.position);
  const key = c ? "BG_" + c.toUpperCase() : "BG_YELLOW";
  return v[key] || bg.png;
}

// -> { width, height, images: [...], texts: [...] } in pt, origin top-left, y down
export async function plakScene(tj, tplName, row, opts = {}) {
  const tpl = tj && tj.templates && tj.templates[tplName];
  if (!tpl) return null;
  const bgs = tj.backgrounds || {};
  const bgName = opts.bg && bgs[opts.bg] ? opts.bg : Object.keys(bgs)[0];
  const bg = bgName ? bgs[bgName] : null;

  const items = [];
  for (const f of PLAK_FIELDS) {
    const val = String(row[f] || "").replace(/\r\n?/g, "\n").trim();
    if (!val) continue;
    const frame = f === "position" ? positionFrame(tpl, row, opts.posColor) : tpl.fields[f] ? f : null;
    if (frame) items.push({ field: f, frame, fi: tpl.fields[frame], val });
  }

  const as = tpl.anchorSize || [200, 100];
  let L = -as[0] / 2, T = as[1] / 2, R = -L, B = -T;
  const grow = (b) => { L = Math.min(L, b[0]); T = Math.max(T, b[1]); R = Math.max(R, b[2]); B = Math.min(B, b[3]); };
  if (bg) grow(bg.box);
  if (tpl.art) grow(tpl.art.box);
  if (!bg) items.forEach((x) => grow(x.fi.box));
  const X = (x) => x - L, Y = (y) => T - y;

  const images = [];
  const addImg = (role, png, box) => images.push({
    role, src: "/plak/" + encodeURIComponent(png), left: X(box[0]), top: Y(box[1]), width: box[2] - box[0], height: box[1] - box[3],
  });
  if (bg && bg.png) addImg("bg", variantPng(bg, opts.variant, row), bg.box);
  if (tpl.art && tpl.art.png) addImg("art", tpl.art.png, tpl.art.box);

  const texts = [];
  for (const it of items) {
    const fi = it.fi;
    const css = await useFont(fi.font, fi.family, fi.style);
    const text = /ALLCAPS/.test(fi.caps || "") ? it.val.toUpperCase() : it.val;
    const boxL = X(fi.box[0]), boxT = Y(fi.box[1]), boxW = fi.box[2] - fi.box[0];
    const hs = (fi.hScale || 100) / 100, vs = (fi.vScale || 100) / 100;
    const base = fi.size || 10;
    const size = fitSize(text, css, base, fi.tracking, hs, boxW, it.field === "position" ? MIN_SIZE_POSITION : MIN_SIZE);
    const align = fi.justify === "left" || fi.justify === "right" ? fi.justify : "center";
    texts.push({
      field: it.field, frame: it.frame, text, ps: fi.font, css,
      left: align === "left" ? boxL : align === "right" ? boxL + boxW : boxL + boxW / 2, top: boxT,
      originX: align, textAlign: align, fontSize: size,
      fill: fi.color || "#000000", stroke: fi.stroke || null, strokeWidth: fi.stroke ? fi.strokeWeight || 0.2 : 0,
      charSpacing: fi.tracking || 0,
      // Fabric spaces lines by fontSize × lineHeight × 1.13; Illustrator leading is in pt
      lineHeight: fi.leading && base ? fi.leading / base / 1.13 : 1,
      scaleX: hs, scaleY: vs, maxW: boxW,
    });
  }
  return { width: R - L, height: T - B, background: "#ffffff", images, texts, bgName };
}
