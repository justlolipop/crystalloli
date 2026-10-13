// Crystal templates imported from a file — no Illustrator needed.
//   .ai / .pdf  Each artboard is read. When an artboard holds several designs side by side
//               (Design A, B, C …), each one becomes its own template. Its artwork becomes the
//               design's locked picture, without the school logo and without its old words (live
//               text, or text converted to outlines). On it go the master template's 3 texts —
//               header, position and name — filled from the Excel row, in the master's fonts and
//               where the design's own words were (or where its saved default puts them).
//               The original file is kept so downloads can redraw the artwork at full print
//               resolution.
//   .svg        Everything stays editable: shapes, lines and text. Text typed as {{column}} in
//               Illustrator, or text that matches an Excel column name, fills in from the Excel row.

import { loose } from "./util.js";
import { useFont, findFont } from "./fonts.js";
import { fitSize, textWidth } from "./measure.js";
import { store, fileUrl } from "./store.js";
import { visibleTextItems, readableText, withoutLiveText } from "./pdf.js";
import { pagePlan, drawOnly, serial, findElements } from "./elements.js";

const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const BASELINE = 0.879; // Fabric draws the first baseline this many font-sizes below the text's top
const PREVIEW_PX = 2000; // longest side of the on-screen picture of an artboard
const CLEAR = "rgba(0,0,0,0)"; // transparent, like the artboard in Illustrator (needed for DTF prints)

// ------------------------------------------------------------------ field binding

export function fieldFromText(text, columns) {
  const m = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(text || "");
  const want = loose(m ? m[1] : text);
  if (!want || want.length > 40) return null;
  const c = columns.find((c) => loose(c.key) === want || loose(c.label) === want);
  return c ? c.key : m ? m[1].trim() : null;
}

export function fillPlaceholders(text, row, columns) {
  return String(text).replace(PLACEHOLDER, (all, name) => {
    const k = fieldFromText("{{" + name + "}}", columns) || name;
    return row[k] != null ? String(row[k]) : "";
  });
}

// ------------------------------------------------------------------ the name paragraph

// The name text (event_line_1) also carries the row's event_line_2 and event_line_3, as more lines
// in the same font, so a design needs no extra text for them.
const MORE_LINES = ["event_line_2", "event_line_3"];
const filled = (v) => v != null && String(v).trim() !== "";

// what a text linked to this column shows for this row
export function fieldValue(row, field) {
  if (!row || !field) return "";
  if (field !== "event_line_1") return filled(row[field]) ? String(row[field]) : "";
  return ["event_line_1", ...MORE_LINES].filter((f) => filled(row[f])).map((f) => String(row[f])).join("\n");
}

// a text linked to this column was typed in: put its words back in the row's cells
export function setFieldValue(row, field, text) {
  if (field !== "event_line_1") { row[field] = text; return; }
  const more = MORE_LINES.filter((f) => filled(row[f]));
  const lines = String(text).split("\n");
  const keep = Math.max(1, lines.length - more.length);
  row.event_line_1 = lines.slice(0, keep).join("\n");
  more.forEach((f, i) => { row[f] = lines[keep + i] || ""; });
}

// ------------------------------------------------------------------ the master template
// Every crystal design shows the same 3 texts: the event's header, the award (position) and the
// name (event_line_1, with event_line_2 / 3 as more lines). Their look (font, colour, outline) is
// the master's, shared by all designs; where they sit and how big comes from the design: from
// where its own .ai had its words (guessLayout), until a layout is saved for it in the editor.

export const MASTER_FIELDS = ["event_header", "position", "event_line_1"];
const LOOK = ["ps", "family", "bold", "italic", "fill", "stroke", "strokeWidth", "paintFirst", "strokeLineJoin",
  "outerStroke", "outerStrokeWidth", "charSpacing", "lineHeight", "scaleX"];
// The built-in master look: the fonts of the J&E crystal (header, award, name). "Save as default
// template" replaces any of them with what was set on the design.
const DEFAULT_MASTER = {
  event_header: { ps: "Teko-Bold", family: "Teko", fill: "#2c2e35", stroke: "#ffffff", strokeWidth: 4, paintFirst: "stroke",
    strokeLineJoin: "round", lineHeight: 0.84, scaleX: 0.95 },
  position: { ps: "Playball-Regular", family: "Playball", fill: "#2c2e35", stroke: "#2c2e35", strokeWidth: 0.5, paintFirst: "fill",
    strokeLineJoin: "round", outerStroke: "#ffffff", outerStrokeWidth: 4, lineHeight: 0.92, scaleX: 0.952 },
  event_line_1: { ps: "BritannicBold", family: "Britannic Bold", fill: "#2c2e35", stroke: "#ffffff", strokeWidth: 4, paintFirst: "stroke",
    strokeLineJoin: "round", lineHeight: 0.92, scaleX: 0.89 },
};
let master = {};
export function setMaster(m) { master = m && typeof m === "object" ? m : {}; }
export const getMaster = () => master;
export const lookOf = (t) => Object.fromEntries(LOOK.filter((k) => t[k] !== undefined && t[k] !== null).map((k) => [k, t[k]]));

// a design's own words (live text, and old words drawn as shapes) as boxes in pt, top to bottom
function wordBoxes(item) {
  const W = item.width;
  const boxes = (item.texts || []).filter((t) => !t.angle && String(t.text).trim()).map((t) => {
    const lines = String(t.text).split("\n");
    const size = t.fontSize, lh = size * (t.lineHeight || 1) * 1.13;
    const w = Math.min(t.maxW || W, Math.max(...lines.map((l) => l.length)) * size * 0.55 * (t.scaleX || 1));
    const l = t.originX === "center" ? t.left - w / 2 : t.originX === "right" ? t.left - w : t.left;
    return { l, r: l + w, t: t.top, b: t.top + lh * lines.length, size, text: t };
  });
  for (const o of item.outlined || []) boxes.push({ l: o.l, r: o.r, t: o.t, b: o.b, size: Math.min(o.b - o.t, item.height * 0.08), text: null,
    look: o.fill ? { fill: o.fill } : null });
  return boxes.sort((a, b) => a.t - b.t);
}

// the look of a design's own words, for the text put there: live text — its font, colour and
// outline as in the .ai (no outline when it had none); words drawn as shapes — their colour
function templateLook(b) {
  if (!b) return null;
  const look = b.text ? { stroke: null, strokeWidth: 0, outerStroke: null, outerStrokeWidth: 0, ...lookOf(b.text), family: b.text.ps ? "" : b.text.family || "" }
    : b.look ? { ...b.look } : null;
  // a white (or nearly) colour is the white outline behind the letters, read as theirs: words
  // that colour would vanish on the crystal, so they keep the usual dark colour
  if (look && !darkEnough(look.fill)) delete look.fill;
  // a light outline goes behind the letters (as in Illustrator, where it's under them): drawn on
  // top, a thick white outline covers the letters and the words vanish
  if (look && look.stroke && !darkEnough(look.stroke)) look.paintFirst = "stroke";
  return look;
}
function darkEnough(c) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c || "").trim());
  if (!m) return false;
  const [r, g, bl] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * bl < 200;
}
const FONT_KEYS = ["ps", "family", "bold", "italic"];
const fontOnly = (l) => Object.fromEntries(FONT_KEYS.filter((k) => l && l[k] !== undefined).map((k) => [k, l[k]]));

// where the 3 texts go on this design, guessed from its own words: the top one is the header, the
// bottom one the name, the biggest one between them the position. -> { field: { cx, top, size, maxW, flipX, look } }
export function guessLayout(item) {
  const W = item.width, H = item.height, bs = wordBoxes(item);
  let pick;
  if (bs.length >= 3) pick = [bs[0], bs.slice(1, -1).reduce((a, b) => (b.size > a.size ? b : a)), bs[bs.length - 1]];
  else if (bs.length === 2) pick = [bs[0], null, bs[1]];
  else pick = [bs[0] || null, null, null];
  const mirrored = (item.texts || []).some((t) => t.flipX);
  const fallback = [[0.3, 0.05], [0.5, 0.07], [0.72, 0.05]]; // top, size (share of the height)
  const out = {};
  MASTER_FIELDS.forEach((f, i) => {
    const b = pick[i];
    const cx = b ? (b.l + b.r) / 2 : W / 2;
    out[f] = {
      cx, top: b ? b.t : H * fallback[i][0], size: b ? b.size : H * fallback[i][1],
      // the crystal's shape is narrower than its box, and the words shouldn't touch its edge or the
      // artwork at the sides: keep to the middle 60%
      maxW: Math.min(W * 0.6, 0.8 * 2 * Math.min(cx, W - cx)), flipX: mirrored, look: templateLook(b),
    };
  });
  return out;
}

// how much bigger than its saved size a short text may get: not at all
const GROW = 1; // never bigger than saved (asked for: no auto zoom); long words still shrink

// the 3 master texts for one Excel row on this design. Each shrinks to fit: as wide as the design
// allows, and no taller than the room down to the next text (the last one: to near the bottom).
async function masterTexts(item, row) {
  const guess = guessLayout(item), saved = item.layout || {};
  const tops = MASTER_FIELDS.map((f) => (saved[f] ? saved[f].top : guess[f].top));
  const texts = [];
  for (const [i, f] of MASTER_FIELDS.entries()) {
    let text = fieldValue(row, f);
    if (!text.trim()) continue;
    const g = guess[f], s = saved[f];
    // its look: the master template's (Save as default template), as before
    const look = { family: "Arial", fill: "#000000", ...DEFAULT_MASTER[f], ...(master[f] || {}) };
    // never words that can't be seen on the crystal: a dark colour, a light outline behind them,
    // a width and line height that draw something
    if (!darkEnough(look.fill)) look.fill = DEFAULT_MASTER[f].fill;
    if (look.stroke && !darkEnough(look.stroke)) look.paintFirst = "stroke";
    if (!(look.scaleX > 0.2)) look.scaleX = DEFAULT_MASTER[f].scaleX;
    if (!(look.lineHeight > 0.3)) look.lineHeight = DEFAULT_MASTER[f].lineHeight;
    if (look.opacity !== undefined && !(look.opacity > 0.2)) delete look.opacity;
    const css = look.ps ? await useFont(look.ps, look.family, look.style) : `"${look.family}", sans-serif`;
    const base = s ? s.fontSize : g.size, maxW = s ? s.maxW : g.maxW;
    const below = tops.filter((t, j) => j !== i && t > tops[i] + 1);
    const room = (below.length ? Math.min(...below) : item.height * 0.92) - tops[i] - item.height * 0.01;
    const lh = (look.lineHeight || 1) * 1.13;
    // as big as fits: few words grow (up to GROW times the saved size) to fill the width, many
    // words shrink to fit it; never taller than the room down to the next text
    const grow = base * GROW;
    // saved with its width (Save as default template): it grows only as far as the saved text
    // was wide, so the crystal it was saved on comes back exactly as saved, and shorter words
    // fill that same width; longer ones shrink to fit the width it may take
    // (measured here from the saved words themselves when kept, the same way as below: the editor
    // measures a little differently, which would let it grow a bit after every save)
    const savedWidth = s && typeof s.text === "string" && s.text.trim()
      ? Math.max(...s.text.split("\n").map((l) => textWidth(l, css, base, look.charSpacing || 0, look.scaleX || 1))) : 0;
    const sw = savedWidth > 0 ? savedWidth : s && s.w > 0 ? s.w : 0;
    const sizeOf = (t) => {
      const lines = t.split("\n").length;
      // more lines than saved (a long text on two lines, the name with event_line_2): each as big as
      // the room down to the next text allows, never bigger than saved
      const tall = Math.min(grow, room > 0 ? room / (lines * lh) : grow);
      const fit = (from, w) => fitSize(t, css, from, look.charSpacing || 0, look.scaleX || 1, w, 4);
      let size;
      if (!sw) size = fit(grow, maxW);
      else {
        const atBase = fit(base, maxW);
        size = atBase < base ? atBase : Math.max(base, fit(grow, Math.min(maxW, sw + 0.5)));
      }
      // never smaller than saved for lack of room: the saved place was chosen by hand
      return Math.max(4, Math.min(size, sw && lines <= (s.lines || 1) ? Math.max(tall, base) : tall));
    };
    let size = sizeOf(text);
    // one long line that would shrink: on two lines instead when that keeps it clearly bigger —
    // split between words near the middle (a name: before BIN / BINTI / A/L / A/P when it has one)
    if (!text.includes("\n") && /\s/.test(text.trim()) && size < base * 0.9) {
      const words = text.trim().split(/\s+/), half = text.trim().length / 2;
      const join = (k) => words.slice(0, k).join(" ") + "\n" + words.slice(k).join(" ");
      let best = null;
      const at = f === "event_line_1" ? words.findIndex((w, k) => k > 0 && /^(BIN|BINTI|BT|A\/L|A\/P|ANAK)$/i.test(w)) : -1;
      if (at > 0) best = { t: join(at) };
      else for (let k = 1; k < words.length; k++) {
        const d = Math.abs(words.slice(0, k).join(" ").length - half);
        if (!best || d < best.d) best = { d, t: join(k) };
      }
      const size2 = best ? sizeOf(best.t) : 0;
      if (size2 > size * 1.1) { text = best.t; size = size2; }
    }
    let top = s ? s.top : g.top;
    // the name's extra lines (event_line_2 / 3) grow it up and down alike, so it stays in its place
    const extra = f === "event_line_1" ? text.split("\n").length - String(row.event_line_1 || "").split("\n").length : 0;
    if (extra > 0) top -= (extra * size * (look.lineHeight || 1) * 1.13) / 2;
    const real = css.startsWith("ps_");
    texts.push({
      ...look, text, css, field: f, src: "m:" + f, tplText: null, top, fontSize: size, maxW,
      left: s ? s.left : g.cx, originX: s ? s.originX : "center", textAlign: s ? s.textAlign : "center",
      angle: s ? s.angle || 0 : 0, flipX: s ? !!s.flipX : g.flipX, scaleY: 1,
      fontWeight: !real && look.bold ? "bold" : "normal", fontStyle: !real && look.italic ? "italic" : "normal",
    });
  }
  return texts;
}

// ------------------------------------------------------------------ scene for one Excel row

export async function libraryScene(item, row, columns) {
  // SVG Data handling (Inkscape converted artwork)

  if (item.source === "svg") {
    const fontMap = {};
    for (const raw of new Set([...item.svg.matchAll(/font-family\s*[:=]\s*["']?([^;"'>]+)/g)].map((m) => m[1]))) {
      const name = raw.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
      const ps = findFont(name);
      if (ps) fontMap[name] = { ps, css: await useFont(ps) };
    }
    return { type: "svg", svg: item.svg, width: item.width, height: item.height, background: "", row, columns, fontMap };
  }

  // .ai / .pdf designs: their artwork (without its logo and old words) + the master template's 3 texts
  const images = item.background
    ? [{ role: "bg", src: fileUrl(item.background) + "?v=" + (item.updated || 0), left: 0, top: 0, width: item.width, height: item.height }] : [];
  return { width: item.width, height: item.height, background: "", images, texts: await masterTexts(item, row) };
}

// ------------------------------------------------------------------ import

export async function importFile(file, progress) {
  if (/\.svg$/i.test(file.name)) return [await importSvg(file)];
  if (/\.(ai|pdf)$/i.test(file.name)) return importPdf(file, progress);
  throw new Error("Use a .ai, .pdf or .svg file.");
}



async function importSvg(file) {
  const svg = await file.text();
  const d = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (!d || d.nodeName.toLowerCase() !== "svg") throw new Error("That isn't a valid SVG.");
  const vb = (d.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const w = parseFloat(d.getAttribute("width")) || vb[2], h = parseFloat(d.getAttribute("height")) || vb[3];
  if (!(w > 0 && h > 0)) throw new Error("The SVG has no size (width/height or viewBox).");
  return { name: file.name.replace(/\.svg$/i, ""), file: file.name, page: 1, source: "svg", width: w, height: h, svg };
}

const noop = () => {};
function withoutText(ctx) {
  ctx.fillText = noop;
  ctx.strokeText = noop;
  return ctx;
}

class CanvasFactory {
  constructor() { this.hideText = false; }
  create(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    return { canvas, context: this.hideText ? withoutText(ctx) : ctx };
  }
  reset(cc, w, h) { cc.canvas.width = w; cc.canvas.height = h; }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}

// A design's school logo and its old words drawn as shapes (outlined text), as drawing steps to
// leave out of its background: the master template puts its own 3 texts on the bare artwork.
// The logo is the biggest piece in the top middle (drawn as shapes or pasted as a picture); flowers
// and corners sit at the sides, the background behind it is far bigger. Small pieces right under
// it (the school's name) go with it.
// r: the design's box on the page (pt) -> { hide: [step], outlined: [{ l, t, r, b }] (pt, design) }
function logoAndWords(plan, r) {
  const els = findElements(plan.items, { x: r.x, y: r.y, w: r.w, h: r.h });
  const cx = (e) => (e.x0 + e.x1) / 2 - r.x, cy = (e) => (e.y0 + e.y1) / 2 - r.y;
  const w = (e) => e.x1 - e.x0, h = (e) => e.y1 - e.y0;
  const pieces = els.filter((e) => e.kind === "graphic" || e.kind === "art" || e.kind === "text");
  const logo = pieces.filter((e) => e.kind !== "text" && w(e) >= r.w * 0.08 && w(e) <= r.w * 0.6 && h(e) <= r.h * 0.4 &&
    Math.abs(cx(e) - r.w / 2) < r.w * 0.15 && cy(e) < r.h * 0.45)
    .sort((a, b) => w(b) * h(b) - w(a) * h(a))[0];
  // a logo pasted as one picture can touch the artwork around it (a swoosh behind it) and be counted
  // as part of that: look for the picture itself too
  const pic = plan.items.filter((it) => !it.path && !it.stroke && it.x1 - it.x0 >= r.w * 0.08 && it.x1 - it.x0 <= r.w * 0.6 &&
    it.y1 - it.y0 <= r.h * 0.4 && Math.abs(cx(it) - r.w / 2) < r.w * 0.15 && cy(it) < r.h * 0.45 &&
    it.x0 >= r.x - 1 && it.x1 <= r.x + r.w + 1 && it.y0 >= r.y - 1 && it.y1 <= r.y + r.h + 1)
    .sort((a, b) => w(b) * h(b) - w(a) * h(a))[0];
  const drop = new Set(logo ? [logo] : []);
  const extraOps = pic && !(logo && logo.ops.includes(pic.op)) ? [pic.op] : [];
  for (const L of [logo, pic].filter(Boolean)) {
    // the school's name under the logo: small, within the logo's width, just below it
    for (const e of pieces) {
      if (e === L || w(e) * h(e) > w(L) * h(L)) continue;
      const below = e.y0 - L.y1;
      if (e.x0 >= L.x0 - r.w * 0.1 && e.x1 <= L.x1 + r.w * 0.1 && below >= -h(L) * 0.1 && below <= h(L) * 0.35 && h(e) <= h(L) * 0.4) drop.add(e);
    }
  }
  // old words drawn as shapes; small "text" pieces are usually bits of a picture, not words
  const words = els.filter((e) => e.kind === "text" && !drop.has(e) && w(e) >= r.w * 0.2);
  // a word's colour: the fill that covers most of its letters (white only when it's all white —
  // white copies behind the letters are their outline)
  const byOp = new Map(plan.items.map((it) => [it.op, it]));
  const colourOf = (e) => {
    const area = new Map();
    for (const op of e.ops) {
      const it = byOp.get(op);
      if (!it || !it.path || it.stroke || !/^#[0-9a-f]{6}$/i.test(it.color || "")) continue;
      area.set(it.color, (area.get(it.color) || 0) + (it.x1 - it.x0) * (it.y1 - it.y0));
    }
    const all = [...area].sort((a, b) => b[1] - a[1]);
    const ink = all.find(([c]) => !/^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(c));
    return (ink || all[0] || [null])[0];
  };
  for (const e of words) drop.add(e);
  // where the logo was (pt, design): the school's own logo goes there (see logoPlace)
  const marks = [logo, pic].filter(Boolean);
  const logoBox = marks.length ? {
    l: Math.min(...marks.map((e) => e.x0)) - r.x, t: Math.min(...marks.map((e) => e.y0)) - r.y,
    r: Math.max(...marks.map((e) => e.x1)) - r.x, b: Math.max(...marks.map((e) => e.y1)) - r.y,
  } : null;
  return {
    hide: [...[...drop].flatMap((e) => e.ops), ...extraOps],
    outlined: words.map((e) => ({ l: e.x0 - r.x, t: e.y0 - r.y, r: e.x1 - r.x, b: e.y1 - r.y, fill: colourOf(e) })),
    logoBox,
  };
}

// where a school's logo goes on this design (pt, from its top-left): where its own logo was; a
// design whose logo wasn't found gets it in the top middle; null: none on this design
// (flip: the design is mirrored — printed from the back — so the logo is mirrored too)
export function logoPlace(item) {
  if (!item || item.source === "svg") return null; // an .svg design keeps its own logo
  const b = item.logoBox, flip = isMirrored(item);
  if (b && b.r > b.l && b.b > b.t) return { l: b.l, t: b.t, r: b.r, b: b.b, flip };
  const W = (item && item.width) || 300, H = (item && item.height) || 400, s = Math.min(W * 0.24, H * 0.18);
  return { l: W / 2 - s / 2, t: H * 0.07, r: W / 2 + s / 2, b: H * 0.07 + s, flip };
}

// a design printed from the back of the crystal: drawn mirrored (its words read backwards)
export function isMirrored(item) {
  if (!item) return false;
  return (item.texts || []).some((t) => t.flipX) || Object.values(item.layout || {}).some((l) => l && l.flipX);
}

// The artwork without its live text. Text with an outline or shadow made in Illustrator usually
// has a copy of its letters drawn as shapes right behind it; hiding only the live letters left that
// copy as a white "ghost" of the words. So shapes that sit inside a live text's box are left out too.
// hide: more drawing steps to leave out (a design's logo and old outlined words, see logoAndWords).
// Returns { without: runs another drawing of this page with those shapes left out as well,
//           ghosts: the shapes left out (their box in pt, colour, line width) }
async function drawBare(page, textItems, c, vp, hide = []) {
  const draw = () => {
    c.ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
    return withoutLiveText(page, () => page.render({ canvasContext: withoutText(c.ctx), viewport: vp, background: CLEAR }).promise);
  };
  await draw();
  const asIs = { without: (fn) => fn(), ghosts: [] };
  const plan = pagePlan(page); // knows what each drawing step paints once the page was drawn
  if (!plan) return asIs;
  const boxes = textBoxes(page, textItems);
  // mostly inside: a script letter's swash may reach a little outside the box
  const inText = (it) => {
    const a = (it.x1 - it.x0) * (it.y1 - it.y0);
    return boxes.some((b) => {
      const w = Math.min(it.x1, b[2]) - Math.max(it.x0, b[0]), h = Math.min(it.y1, b[3]) - Math.max(it.y0, b[1]);
      return w > 0 && h > 0 && w * h >= 0.6 * a;
    });
  };
  const ghosts = plan.items.filter(inText);
  if (!ghosts.length && !hide.length) return asIs;
  const hidden = new Set(hide);
  const keep = plan.items.filter((it) => !inText(it) && !hidden.has(it.op)).map((it) => it.op);
  const without = (fn) => serial(() => drawOnly(plan, keep, fn));
  await without(draw);
  return { without, ghosts };
}

// The outlines Illustrator drew around a text (as shapes behind it), so the editable text keeps
// them. Often two: a thin one in the text's own colour (it makes a thin font look bold) and a wide
// one in another colour around that. b: a text block in pt -> outline properties, or {}
function outlineOf(b, ghosts) {
  // most of the outline shape lies on this text (a neighbour's swash may reach into its box)
  const mine = (g) => {
    const w = Math.min(g.x1, b.r) - Math.max(g.x0, b.l), h = Math.min(g.y1, b.bottom) - Math.max(g.y0, b.top);
    return w > 0 && h > 0 && w * h >= 0.5 * (g.x1 - g.x0) * (g.y1 - g.y0);
  };
  const lines = ghosts.filter((g) => g.stroke && g.lw > 0.2 && mine(g));
  if (!lines.length) return {};
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) || 0);
  const like = (a, c) => rgb(a).reduce((s, v, i) => s + Math.abs(v - rgb(c)[i]), 0) < 40;
  const width = (list) => Math.round(Math.max(...list.map((g) => g.lw)) * 100) / 100;
  const own = lines.filter((g) => like(g.color, b.fill)), other = lines.filter((g) => !like(g.color, b.fill));
  const out = {};
  if (other.length) {
    const count = {};
    for (const g of other) count[g.color] = (count[g.color] || 0) + 1;
    const color = Object.keys(count).sort((p, q) => count[q] - count[p])[0];
    const w = width(other.filter((g) => g.color === color));
    if (own.length) Object.assign(out, { outerStroke: color, outerStrokeWidth: w });
    else Object.assign(out, { stroke: color, strokeWidth: w, paintFirst: "stroke" });
  }
  if (own.length) Object.assign(out, { stroke: b.fill, strokeWidth: width(own) });
  return { ...out, strokeLineJoin: "round" };
}

// each live text's box in pt from the page's top-left, with room for an outline around it
function textBoxes(page, items) {
  const m = page.getViewport({ scale: 1 }).transform, boxes = [];
  for (const it of items) {
    if (!it.str || !it.str.trim() || !it.transform) continue;
    const t = pdfjsLib.Util.transform(m, it.transform);
    const fh = Math.hypot(t[2], t[3]);
    if (!(fh > 0.5)) continue;
    // corners of the run: along the baseline (its width) and up the letters (t[2], t[3] = one font height)
    const len = Math.hypot(t[0], t[1]) || 1, ax = (t[0] / len) * (it.width || 0), ay = (t[1] / len) * (it.width || 0);
    const px = [], py = [];
    for (const along of [0, 1]) for (const up of [-0.3, 1]) {
      px.push(t[4] + ax * along + t[2] * up);
      py.push(t[5] + ay * along + t[3] * up);
    }
    const pad = fh * 0.35 + 1;
    boxes.push([Math.min(...px) - pad, Math.min(...py) - pad, Math.max(...px) + pad, Math.max(...py) + pad]);
  }
  return boxes;
}

function makeCanvas(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d") };
}

function crop(src, r, S) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(r.w * S));
  c.height = Math.max(1, Math.round(r.h * S));
  c.getContext("2d").drawImage(src, r.x * S, r.y * S, r.w * S, r.h * S, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

async function importPdf(file, progress) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("It wasn't saved with “Create PDF Compatible File”. Tick that in Illustrator's save options and try again.");
  }
  const factory = new CanvasFactory();
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true, canvasFactory: factory }).promise;
  } catch (e) {
    throw new Error("Couldn't open it (" + e.message + ").");
  }
  progress && progress(`Keeping a copy of ${file.name} for full-quality downloads…`);
  // too big to keep online: the design still imports (its logo is taken out now), but full-quality
  // downloads use the screen picture and "Remove from background" can't be used on it later
  let original = null, keepWarning = "";
  try { ({ path: original } = await store.saveOriginal(file.name, bytes)); } catch (e) {
    if (!store.online) throw e;
    progress && progress(`Couldn't keep a copy of ${file.name}: ${e.message}`);
    keepWarning = `${file.name}: ${e.message} It's imported, but full-quality downloads and Remove from background won't work for it.`;
  }
  const base = file.name.replace(/\.(ai|pdf)$/i, "");
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    progress && progress(`Reading ${file.name}${doc.numPages > 1 ? ` — artboard ${n} of${doc.numPages}` : ""}…`);
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const pageW = vp1.width, pageH = vp1.height;
    const S = Math.max(1, Math.min(3, PREVIEW_PX / Math.max(pageW, pageH)));
    const vp = page.getViewport({ scale: S });
    const W = Math.round(vp.width), H = Math.round(vp.height);
    // text on hidden layers is left out (Illustrator doesn't show it either)
    const tc = { items: await visibleTextItems(doc, page, await page.getTextContent({ includeMarkedContent: true })) };
    const hasText = tc.items.some((it) => it.str && it.str.trim());
    const bare = makeCanvas(W, H);
    factory.hideText = true;
    const { without: withoutGhosts, ghosts } = await drawBare(page, tc.items, bare, vp);
    factory.hideText = false;
    const bareData = bare.ctx.getImageData(0, 0, W, H).data;
    let blocks = [];
    if (hasText) {
      const full = makeCanvas(W, H);
      // the outline copies are left out here too, so only the live letters differ from the bare picture
      await withoutGhosts(() => page.render({ canvasContext: full.ctx, viewport: vp, background: CLEAR }).promise);
      blocks = readTexts(tc, vp, S, page, full.ctx.getImageData(0, 0, W, H).data, bareData, W, H);
      full.canvas.width = full.canvas.height = 0;
      for (const b of blocks) Object.assign(b, outlineOf(b, ghosts));
    }

    const regions = findDesigns(bareData, W, H, S, pageW, pageH);
    const parts = regions.length ? regions : [{ x: 0, y: 0, w: pageW, h: pageH }];
    // master template: each design keeps only its artwork; its logo and old outlined words go
    const plan = pagePlan(page);
    const cleared = parts.map((r) => (plan ? logoAndWords(plan, r) : { hide: [], outlined: [] }));
    const hideAll = cleared.flatMap((c) => c.hide);
    if (hideAll.length) await drawBare(page, tc.items, bare, vp, hideAll);
    const inside = (b, r) => b.cx >= r.x && b.cx <= r.x + r.w && b.cy >= r.y && b.cy <= r.y + r.h;
    const outside = regions.length ? blocks.filter((b) => !regions.some((r) => inside(b, r))) : [];
    const usedLabels = new Set();
    parts.forEach((r, i) => {
      let label = null;
      if (regions.length) {
        let best = null;
        for (const b of outside) {
          if (b.lines > 1 || b.text.length > 28 || usedLabels.has(b) || b.cx < r.x || b.cx > r.x + r.w) continue;
          const below = b.top - (r.y + r.h), above = r.y - b.bottom;
          const d = below >= -2 ? below : above >= -2 ? above : null;
          if (d === null || d > Math.max(r.h * 0.3, 20)) continue;
          if (!best || d < best.d) best = { b, d };
        }
        if (best) { label = best.b.text; usedLabels.add(best.b); }
      }
      out.push({
        name: regions.length ? `${base} — ${label || "Design " + (i + 1)}` : doc.numPages > 1 ? `${base} — artboard ${n}` : base,
        file: file.name, page: n, order: out.length, source: "pdf", width: r.w, height: r.h, region: [r.x, r.y, r.w, r.h], original,
        background: regions.length ? crop(bare.canvas, r, S) : bare.canvas.toDataURL("image/png"),
        texts: blocks.filter((b) => !regions.length || inside(b, r)).map((b) => finishText(b, r)),
        hide: cleared[i].hide, outlined: cleared[i].outlined, logoBox: cleared[i].logoBox || null, cleaned: CLEAN_VERSION,
      });
    });
    bare.canvas.width = bare.canvas.height = 0;
  }
  if (keepWarning) out.warning = keepWarning;
  return out;
}

function findDesigns(data, W, H, S, pageW, pageH) {
  const g = Math.max(2, Math.ceil(Math.max(W, H) / 500));
  const gw = Math.ceil(W / g), gh = Math.ceil(H / g);
  const ink = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = ((y / g) | 0) * gw, base = y * W * 4;
    for (let x = 0; x < W; x++) if (data[base + x * 4 + 3] > 24) ink[row + ((x / g) | 0)] = 1;
  }
  const found = designsIn(ink, g, gw, gh, S, pageW, pageH);
  if (found.length) return found;
  // Designs drawn inside one thin frame (a box around them all, a line between them) touch each
  // other, so they're one shape. Use the boxes between the frame's lines instead.
  return frameCells(data, W, H, S, pageW, pageH);
}

// The cells of a frame drawn as long dark lines across the artboard: each cell (pt, in reading
// order, lines included) with artwork in it, or [] when the lines don't make two or more cells
function frameCells(data, W, H, S, pageW, pageH) {
  const dark = (i) => data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 240;
  const lines = (n, len, at) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      let c = 0;
      for (let j = 0; j < len; j++) if (dark(at(k, j))) c++;
      if (c < len * 0.5) continue;
      const last = out[out.length - 1];
      if (last && k - last[1] <= 1) last[1] = k; else out.push([k, k]);
    }
    return out.filter(([a, b]) => b - a <= 6 * S); // lines, not filled areas
  };
  const xs = lines(W, H, (x, y) => (y * W + x) * 4), ys = lines(H, W, (y, x) => (y * W + x) * 4);
  const cells = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const x = xs[i][0] / S, y = ys[j][0] / S, w = (xs[i + 1][1] + 1) / S - x, h = (ys[j + 1][1] + 1) / S - y;
      if (w >= pageW * 0.15 && h >= pageH * 0.15) cells.push({ x, y, w, h });
    }
  }
  return cells.length >= 2 ? cells : [];
}

// separate designs on an artboard: boxes (pt) in reading order, or [] when there aren't two or more
function designsIn(ink, g, gw, gh, S, pageW, pageH) {
  const rad = Math.max(1, Math.round((4 * S) / g));
  const grown = new Uint8Array(gw * gh), tmp = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    let last = -1e9;
    for (let x = 0; x < gw; x++) if (ink[y * gw + x]) last = x; else if (x - last <= rad) tmp[y * gw + x] = 1;
    last = 1e9;
    for (let x = gw - 1; x >= 0; x--) { if (ink[y * gw + x]) { last = x; tmp[y * gw + x] = 1; } else if (last - x <= rad) tmp[y * gw + x] = 1; }
  }
  for (let x = 0; x < gw; x++) {
    let last = -1e9;
    for (let y = 0; y < gh; y++) if (tmp[y * gw + x]) { last = y; grown[y * gw + x] = 1; } else if (y - last <= rad) grown[y * gw + x] = 1;
    last = 1e9;
    for (let y = gh - 1; y >= 0; y--) if (tmp[y * gw + x]) last = y; else if (last - y <= rad) grown[y * gw + x] = 1;
  }
  const seen = new Uint8Array(gw * gh);
  const boxes = [];
  for (let i = 0; i < gw * gh; i++) {
    if (!grown[i] || seen[i]) continue;
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const x = j % gw, y = (j / gw) | 0;
      if (ink[j]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x > 0 && grown[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < gw - 1 && grown[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && grown[j - gw] && !seen[j - gw]) { seen[j - gw] = 1; stack.push(j - gw); }
      if (y < gh - 1 && grown[j + gw] && !seen[j + gw]) { seen[j + gw] = 1; stack.push(j + gw); }
    }
    if (x1 >= 0) boxes.push({ x: (x0 * g) / S, y: (y0 * g) / S, w: ((x1 - x0 + 1) * g) / S, h: ((y1 - y0 + 1) * g) / S });
  }
  const area = pageW * pageH;
  const big = boxes.filter((b) => b.w * b.h >= area * 0.012 && b.w >= pageW * 0.05 && b.h >= pageH * 0.05);
  if (big.length < 2) return [];
  const union = (a, b) => {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    a.w = Math.max(a.x + a.w, b.x + b.w) - x; a.h = Math.max(a.y + a.h, b.y + b.h) - y; a.x = x; a.y = y;
  };
  for (const s of boxes) {
    if (big.includes(s)) continue;
    let best = null, bestGap = Infinity;
    for (const b of big) {
      const ox = Math.min(s.x + s.w, b.x + b.w) - Math.max(s.x, b.x);
      if (ox < Math.min(s.w, b.w) * 0.5) continue;
      const gap = Math.max(0, s.y - (b.y + b.h), b.y - (s.y + s.h));
      if (gap < b.h * 0.2 && gap < bestGap) { bestGap = gap; best = b; }
    }
    if (best) union(best, s);
  }
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < big.length && !merged; i++) {
      for (let j = i + 1; j < big.length; j++) {
        const a = big[i], b = big[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { union(a, b); big.splice(j, 1); merged = true; break; }
      }
    }
  }
  if (big.length < 2 || big.some((b) => b.w * b.h > area * 0.8)) return [];
  const PAD = 3;
  for (const b of big) {
    const x = Math.max(0, b.x - PAD), y = Math.max(0, b.y - PAD);
    b.w = Math.min(pageW, b.x + b.w + PAD) - x; b.h = Math.min(pageH, b.y + b.h + PAD) - y; b.x = x; b.y = y;
  }
  big.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const b of big) {
    const r = rows.find((r) => b.y + b.h / 2 > r.top && b.y + b.h / 2 < r.bottom);
    if (r) { r.items.push(b); r.bottom = Math.max(r.bottom, b.y + b.h); } else rows.push({ top: b.y, bottom: b.y + b.h, items: [b] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

function toHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function colourIn(fullData, bareData, W, H, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  const buckets = new Map();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (fullData[i + 3] < 160) continue;
      const d = Math.abs(fullData[i] - bareData[i]) + Math.abs(fullData[i + 1] - bareData[i + 1]) +
        Math.abs(fullData[i + 2] - bareData[i + 2]) + Math.abs(fullData[i + 3] - bareData[i + 3]);
      if (d < 60) continue;
      const key = ((fullData[i] >> 4) << 8) | ((fullData[i + 1] >> 4) << 4) | (fullData[i + 2] >> 4);
      const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++; b.r += fullData[i]; b.g += fullData[i + 1]; b.b += fullData[i + 2];
      buckets.set(key, b);
    }
  }
  let best = null, changed = 0;
  for (const b of buckets.values()) { changed += b.n; if (!best || b.n > best.n) best = b; }
  return {
    color: best ? toHex(best.r / best.n, best.g / best.n, best.b / best.n) : "#000000",
    // how much of the box the text really paints. ~0 = the text isn't visible on the artboard
    // (a hidden layer, an old version kept under the artwork, clipped away, or a 0% opacity copy)
    ink: changed / Math.max(1, (x1 - x0) * (y1 - y0)),
  };
}

function readTexts(tc, vp, S, page, fullData, bareData, W, H) {
  const runs = [];
  const seen = new Set();
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(t[2], t[3]);
    if (!(fh > 0.5)) continue;
    let ps = "", bold = false, italic = false, f = null;
    try {
      f = page.commonObjs.get(it.fontName);
      ps = String(f.name || "").replace(/^[A-Z]{6}\+/, "");
      bold = !!(f.bold || f.black);
      italic = !!f.italic;
    } catch (e) {}
    // a script font's alternate letters ("n.alt") come through as control characters: use the letter
    const str = readableText(it.str, f);
    if (!str.trim()) continue;
    const key = `${str}|${Math.round(t[4])}|${Math.round(t[5])}|${Math.round(fh)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // mirrored text (flipped left-right, as on a design printed on the back of a crystal): its
    // letters run right to left from where it starts. Read it as plain text flipped, not as text
    // turned upside down
    const w = it.width * S, mirror = t[0] * t[3] - t[1] * t[2] > 0 && Math.abs(t[1]) < 0.01 * fh;
    runs.push({
      str, x: mirror ? t[4] - w : t[4], y: t[5], w, fh, font: it.fontName, ps, bold, italic, mirror,
      hs: Math.hypot(t[0], t[1]) / fh, angle: mirror ? 0 : Math.atan2(t[1], t[0]) * 180 / Math.PI,
    });
  }

  // Join the pieces of one line. Illustrator often writes a line as many small pieces (kerned
  // letters, a letter in a substitute font), so pieces on the same baseline and of about the same
  // size are joined even when their font differs, and they're joined left to right.
  const sorted = runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const rotated = Math.abs(r.angle) > 0.5;
    const ln = rotated ? null : lines.find((l) => !l.rotated && l.mirror === r.mirror && Math.abs(l.fh - r.fh) < Math.max(0.6, r.fh * 0.15) &&
      Math.abs(l.y - r.y) < r.fh * 0.35 && r.x - l.end < r.fh * 1.2 && r.x + r.w > l.start - r.fh * 0.6);
    if (ln) {
      ln.parts.push(r);
      ln.start = Math.min(ln.start, r.x);
      ln.end = Math.max(ln.end, r.x + r.w);
    } else lines.push({ ...r, rotated, parts: [r], start: r.x, end: r.x + r.w });
  }
  for (const l of lines) {
    // in reading order: left to right, or right to left for mirrored text
    const parts = l.parts.sort((a, b) => (l.mirror ? b.x + b.w - (a.x + a.w) : a.x - b.x));
    let str = "", edge = null;
    for (const p of parts) {
      const gap = edge === null ? 0 : l.mirror ? edge - (p.x + p.w) : p.x - edge;
      if (edge !== null && gap > p.fh * 0.12 && !/\s$/.test(str) && !/^\s/.test(p.str)) str += " ";
      str += p.str;
      edge = l.mirror ? Math.min(edge ?? Infinity, p.x) : Math.max(edge ?? -Infinity, p.x + p.w);
    }
    const x0 = Math.min(...parts.map((p) => p.x));
    l.x = x0;
    l.w = Math.max(...parts.map((p) => p.x + p.w)) - x0;
    l.str = str.replace(/\s+/g, " ").trim();
    // the font the most letters use
    const count = {};
    for (const p of parts) count[p.font] = (count[p.font] || 0) + p.str.length;
    const main = parts.find((p) => p.font === Object.keys(count).sort((a, b) => count[b] - count[a])[0]);
    Object.assign(l, { font: main.font, ps: main.ps, bold: main.bold, italic: main.italic });
    if (l.rotated) { l.color = "#000000"; l.ink = 1; continue; }
    const c = colourIn(fullData, bareData, W, H, l.x, l.y - l.fh * 0.85, l.x + l.w, l.y + l.fh * 0.25);
    l.color = c.color;
    l.ink = c.ink;
  }

  const blocks = [];
  // text that paints nothing on the artboard isn't part of the design: leave it out, or it shows
  // up as an extra editable copy on top of the real artwork
  for (const ln of lines.filter((l) => l.str && l.ink >= 0.01)) {
    const cx = ln.x + ln.w / 2;
    const b = ln.rotated ? null : blocks.find((b) => {
      const last = b.lines[b.lines.length - 1];
      const dy = ln.y - last.y;
      if (b.rotated || b.mirror !== ln.mirror || b.font !== ln.font || Math.abs(b.fh - ln.fh) > 0.6 || b.color !== ln.color) return false;
      if (dy < ln.fh * 0.8 || dy > ln.fh * 1.9) return false;
      if (b.lines.length > 1 && Math.abs(dy - b.gap) > ln.fh * 0.25) return false;
      const tol = ln.fh * 0.6;
      return Math.abs(last.x + last.w / 2 - cx) < tol || Math.abs(last.x - ln.x) < tol || Math.abs(last.x + last.w - (ln.x + ln.w)) < tol;
    });
    if (b) { b.gap = ln.y - b.lines[b.lines.length - 1].y; b.lines.push(ln); }
    else blocks.push({ font: ln.font, fh: ln.fh, color: ln.color, rotated: ln.rotated, mirror: ln.mirror, lines: [ln], gap: 0 });
  }

  return blocks.map((b) => {
    const first = b.lines[0], last = b.lines[b.lines.length - 1];
    const lefts = b.lines.map((l) => l.x / S), rights = b.lines.map((l) => (l.x + l.w) / S);
    const centres = lefts.map((l, i) => (l + rights[i]) / 2);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    let align = "left";
    if (b.lines.length > 1) {
      const s = { left: spread(lefts), center: spread(centres), right: spread(rights) };
      align = Object.keys(s).sort((p, q) => s[p] - s[q])[0];
    }
    const size = b.fh / S;
    const out = {
      text: b.lines.map((l) => l.str).join("\n"), lines: b.lines.length, align, ps: first.ps, bold: first.bold, italic: first.italic,
      l: Math.min(...lefts), r: Math.max(...rights), top: (first.y - BASELINE * b.fh) / S, bottom: (last.y + 0.25 * b.fh) / S,
      cxLines: centres.reduce((a, c) => a + c, 0) / centres.length, widest: Math.max(...rights.map((r, i) => r - lefts[i])),
      fontSize: Math.round(size * 100) / 100, fill: b.color, lineHeight: b.lines.length > 1 ? b.gap / (b.fh * 1.13) : 1,
      scaleX: Math.round(first.hs * 1000) / 1000 || 1, rotated: b.rotated, angle: b.rotated ? first.angle : 0, mirror: b.mirror,
    };
    out.cx = (out.l + out.r) / 2;
    out.cy = (out.top + out.bottom) / 2;
    if (b.rotated) {
      const a = first.angle * Math.PI / 180;
      out.rotLeft = first.x / S + Math.sin(a) * BASELINE * size;
      out.rotTop = first.y / S - Math.cos(a) * BASELINE * size;
      out.cx = first.x / S;
      out.cy = first.y / S;
    }
    return out;
  });
}

function finishText(b, r) {
  let align = b.align;
  if (b.lines === 1) align = Math.abs(b.cx - (r.x + r.w / 2)) < r.w * 0.06 ? "center" : "left";
  if (b.rotated) align = "left";
  const ax = align === "left" ? b.l : align === "right" ? b.r : b.cxLines;
  const room = align === "center" ? 2 * Math.min(ax - r.x, r.x + r.w - ax) : align === "left" ? r.x + r.w - ax : ax - r.x;
  return {
    text: b.text, ps: b.ps, family: "", bold: b.bold, italic: b.italic,
    left: (b.rotated ? b.rotLeft : ax) - r.x, top: (b.rotated ? b.rotTop : b.top) - r.y,
    // flipped text keeps its place on the artboard; its lines line up on the other side of the
    // (unflipped) text, so left and right swap
    originX: align, textAlign: b.mirror ? { left: "right", right: "left" }[align] || align : align, flipX: !!b.mirror, angle: b.angle, fontSize: b.fontSize, fill: b.fill, charSpacing: 0,
    lineHeight: b.lineHeight, scaleX: b.scaleX, scaleY: 1, maxW: Math.max(room * 0.96, b.widest), field: null,
    ...(b.stroke ? { stroke: b.stroke, strokeWidth: b.strokeWidth, paintFirst: b.paintFirst || "fill", strokeLineJoin: b.strokeLineJoin } : {}),
    ...(b.outerStroke ? { outerStroke: b.outerStroke, outerStrokeWidth: b.outerStrokeWidth } : {}),
  };
}

// ------------------------------------------------------------------ full-resolution artwork for downloads

const originals = new Map();
const hiCache = new Map();
function openOriginal(rel) {
  if (!originals.has(rel)) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    const factory = new CanvasFactory();
    factory.hideText = true;
    originals.set(rel, pdfjsLib.getDocument({ url: fileUrl(rel), canvasFactory: factory, disableRange: true, disableStream: true }).promise);
  }
  return originals.get(rel);
}

// ------------------------------------------------------------------ removing things from a background

// the original .ai page of a design, drawn once (so its drawing steps are known)
async function designPage(item) {
  const doc = await openOriginal(item.original);
  const page = await doc.getPage(item.page || 1);
  if (!pagePlan(page)) {
    const c = makeCanvas(8, 8);
    await page.render({ canvasContext: c.ctx, viewport: page.getViewport({ scale: 8 / Math.max(...page.view) }) }).promise;
  }
  return { doc, page };
}

// the piece of a design's artwork at (x, y) (pt, from the design's top-left): the smallest one there
// that isn't the whole background or the cut line -> its drawing steps, or null
export async function pieceAt(item, x, y) {
  if (!item || !item.original) return null;
  const { page } = await designPage(item);
  const plan = pagePlan(page);
  if (!plan) return null;
  const [rx, ry, rw, rh] = item.region || [0, 0, item.width, item.height];
  const px = rx + x, py = ry + y;
  const hidden = new Set(item.hide || []);
  const area = (e) => (e.x1 - e.x0) * (e.y1 - e.y0), A = rw * rh;
  const at = (e) => px >= e.x0 && px <= e.x1 && py >= e.y0 && py <= e.y1;
  // a piece the size of a logo, not the artwork spread over the whole design (traced flowers and
  // corners are often one piece covering it all)
  const hits = findElements(plan.items, { x: rx, y: ry, w: rw, h: rh })
    .filter((e) => e.kind !== "plate" && e.kind !== "cut" && at(e) && area(e) <= A * 0.3)
    .filter((e) => e.ops.some((o) => !hidden.has(o)))
    .sort((a, b) => area(a) - area(b));
  if (hits[0]) return hits[0].ops;
  // otherwise just the one shape or picture under the click
  const one = plan.items.filter((it) => at(it) && !hidden.has(it.op) && area(it) <= A * 0.1).sort((a, b) => area(a) - area(b))[0];
  return one ? [one.op] : null;
}

// Everything drawn mostly inside a box dragged on the design (pt, from its top-left): a whole logo
// in one go (its ring, letters and picture are many pieces). Not the artwork spread over the whole
// design, nor the cut line. -> drawing steps, or null
export async function piecesIn(item, box) {
  if (!item || !item.original) return null;
  const { page } = await designPage(item);
  const plan = pagePlan(page);
  if (!plan) return null;
  const [rx, ry, rw, rh] = item.region || [0, 0, item.width, item.height];
  const b = { x0: rx + box.l, y0: ry + box.t, x1: rx + box.r, y1: ry + box.b }, A = rw * rh;
  const hidden = new Set(item.hide || []);
  const area = (e) => Math.max(0.01, (e.x1 - e.x0) * (e.y1 - e.y0));
  const inBox = (e) => {
    const w = Math.min(e.x1, b.x1) - Math.max(e.x0, b.x0), h = Math.min(e.y1, b.y1) - Math.max(e.y0, b.y0);
    return w > 0 && h > 0 && (w * h) / area(e) >= 0.6;
  };
  const ops = new Set();
  for (const e of findElements(plan.items, { x: rx, y: ry, w: rw, h: rh })) {
    if (e.kind === "plate" || e.kind === "cut" || area(e) > A * 0.3 || !inBox(e)) continue;
    for (const o of e.ops) if (!hidden.has(o)) ops.add(o);
  }
  for (const it of plan.items) if (!hidden.has(it.op) && area(it) <= A * 0.3 && inBox(it)) ops.add(it.op);
  return ops.size ? [...ops] : null;
}

// Designs imported before the logo was taken out automatically (or before it found logos pasted as
// a picture) still have it: they get the same clean-up once, without importing them again. What was
// removed by hand stays removed; "Put back" afterwards isn't undone (cleaned marks it as done).
// -> the changes to save ({ id, cleaned, hide, outlined, background? }), or null when already done
// 2: also where the logo was (logoBox) · 3: the colour of its old words drawn as shapes
export const CLEAN_VERSION = 3;
export async function autoClean(item) {
  if (!item || item.source !== "pdf" || !item.original || (item.cleaned || 0) >= CLEAN_VERSION) return null;
  const { page } = await designPage(item);
  const plan = pagePlan(page);
  const [x, y, w, h] = item.region || [0, 0, item.width, item.height];
  const found = plan ? logoAndWords(plan, { x, y, w, h }) : { hide: [], outlined: [] };
  // cleaned before: only where its logo was is new (what's left out stays as it is — a logo put
  // back by hand stays back)
  if (item.cleaned) return { id: item.id, cleaned: CLEAN_VERSION, logoBox: item.logoBox || found.logoBox || null,
    outlined: found.outlined.length ? found.outlined : item.outlined || [] };
  const had = item.hide || [], hide = [...new Set([...had, ...found.hide])];
  const out = { id: item.id, cleaned: CLEAN_VERSION, hide, outlined: found.outlined.length ? found.outlined : item.outlined || [], logoBox: found.logoBox || null };
  if (hide.length !== had.length) out.background = await redrawBackground(item, hide);
  return out;
}
// every design in the library that needs it, saved -> how many were cleaned
export async function autoCleanAll(library, save) {
  let n = 0;
  for (const [i, it] of library.entries()) {
    try {
      const u = await autoClean(it);
      if (u) { library[i] = Object.assign(it, await save(u)); n++; }
    } catch (e) { /* this one stays as it is; tried again next time */ }
  }
  return n;
}

// What was taken out of a design's background (its logo, old outlined words, what was removed by
// hand), as boxes in pt from the design's top-left: Illustrator takes the same out of the original
// .ai (see illustrator.js). A piece whose drawing steps are all left out is one box.
export async function removedBoxes(item) {
  if (!item || !item.original || !(item.hide || []).length) return [];
  const { page } = await designPage(item);
  const plan = pagePlan(page);
  if (!plan) return [];
  const [rx, ry, rw, rh] = item.region || [0, 0, item.width, item.height];
  const hidden = new Set(item.hide), covered = new Set(), out = [];
  for (const e of findElements(plan.items, { x: rx, y: ry, w: rw, h: rh })) {
    if (e.ops.length && e.ops.every((o) => hidden.has(o))) { out.push(e); for (const o of e.ops) covered.add(o); }
  }
  for (const it of plan.items) if (hidden.has(it.op) && !covered.has(it.op)) out.push(it);
  return out.map((e) => ({ l: e.x0 - rx, t: e.y0 - ry, r: e.x1 - rx, b: e.y1 - ry }));
}

// a design's background drawn again, at screen size, leaving out the steps in hide -> png data URL
export async function redrawBackground(item, hide) {
  const { doc, page } = await designPage(item);
  const vp1 = page.getViewport({ scale: 1 });
  const S = Math.max(1, Math.min(3, PREVIEW_PX / Math.max(vp1.width, vp1.height)));
  const [x, y, w, h] = item.region || [0, 0, item.width, item.height];
  const vp = page.getViewport({ scale: S, offsetX: -x * S, offsetY: -y * S });
  const c = makeCanvas(Math.max(1, Math.round(w * S)), Math.max(1, Math.round(h * S)));
  const items = await visibleTextItems(doc, page, await page.getTextContent({ includeMarkedContent: true }));
  await drawBare(page, items, c, vp, hide);
  const url = c.canvas.toDataURL("image/png");
  c.canvas.width = c.canvas.height = 0;
  for (const k of [...hiCache.keys()]) if (k.startsWith(item.id + "|")) hiCache.delete(k);
  return url;
}

export function hiResBackground(item, dpi) {
  if (!item || !item.original || item.source !== "pdf") return Promise.resolve(null);
  const key = item.id + "|" + dpi;
  if (!hiCache.has(key)) {
    hiCache.set(key, (async () => {
      try {
        const doc = await openOriginal(item.original);
        const page = await doc.getPage(item.page || 1);
        const [x, y, w, h] = item.region || [0, 0, item.width, item.height];
        const k = Math.min(dpi / 72, Math.sqrt(80e6 / (w * h)));
        const vp = page.getViewport({ scale: k, offsetX: -x * k, offsetY: -y * k });
        const c = makeCanvas(Math.round(w * k), Math.round(h * k));
        const items = await visibleTextItems(doc, page, await page.getTextContent({ includeMarkedContent: true }));
        await drawBare(page, items, c, vp, item.hide || []);
        const url = c.canvas.toDataURL("image/png");
        c.canvas.width = c.canvas.height = 0;
        return url;
      } catch (e) {
        hiCache.delete(key);
        return null;
      }
    })());
  }
  return hiCache.get(key);
}
// ------------------------------------------------------------------ school logos from an .ai

// An .ai (saved PDF-compatible) with many school logos, each with its school's name written near
// it (under it, else above): every logo cut out as a picture, named from those words when they're
// live text. -> [{ data: png data URL, name }] in reading order. Pieces of one logo a little apart
// (a crest and its ring) stay one logo; a white box behind them all is ignored.
export async function extractLogos(file, progress) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("It wasn't saved with “Create PDF Compatible File”. Tick that in Illustrator's save options and try again.");
  }
  const doc = await pdfjsLib.getDocument({ data: bytes, fontExtraProperties: true, canvasFactory: new CanvasFactory() }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    progress && progress(`Finding the logos${doc.numPages > 1 ? ` — artboard ${n} of ${doc.numPages}` : ""}…`);
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const S = Math.max(1, Math.min(4, 3200 / Math.max(vp1.width, vp1.height)));
    const vp = page.getViewport({ scale: S });
    const W = Math.round(vp.width), H = Math.round(vp.height);
    const items = await visibleTextItems(doc, page, await page.getTextContent({ includeMarkedContent: true }));
    // the logos are found without the live words (so a name under a logo isn't part of it), and
    // cut out of the page as drawn (words inside a logo stay in it)
    const full = makeCanvas(W, H), bare = makeCanvas(W, H);
    await page.render({ canvasContext: full.ctx, viewport: vp, background: CLEAR }).promise;
    await drawBare(page, items, bare, vp, []);
    const boxes = logoBlobs(bare.ctx.getImageData(0, 0, W, H).data, W, H);
    bare.canvas.width = bare.canvas.height = 0;
    // the live words, as boxes in px on this page
    const words = items.filter((it) => it.str && it.str.trim()).map((it) => {
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const h = Math.abs(it.transform[3] || it.height || 8) * S, w = (it.width || 0) * S;
      return { str: it.str.trim(), l: x, r: x + w, t: y - h, b: y, cx: x + w / 2, cy: y - h / 2 };
    });
    // each word to the logo it's the name of: just under it (else just above), across its width
    const named = boxes.map(() => []);
    for (const wd of words) {
      let best = null;
      boxes.forEach((b, i) => {
        const bw = b.r - b.l, bh = b.b - b.t;
        if (wd.cx < b.l - bw * 0.4 || wd.cx > b.r + bw * 0.4) return;
        if (wd.cy > b.t && wd.cy < b.b && wd.cx > b.l && wd.cx < b.r) return; // inside the logo
        const d = wd.t >= b.b - bh * 0.05 ? wd.t - b.b : wd.b <= b.t + bh * 0.05 ? (b.t - wd.b) * 1.5 : null;
        if (d === null || d > Math.max(bh * 0.9, 40 * S)) return;
        if (!best || d < best.d) best = { i, d };
      });
      if (best) named[best.i].push(wd);
    }
    boxes.forEach((b, i) => {
      const pad = Math.round(Math.max(b.r - b.l, b.b - b.t) * 0.03);
      const x = Math.max(0, b.l - pad), y = Math.max(0, b.t - pad), w = Math.min(W, b.r + pad) - x, h = Math.min(H, b.b + pad) - y;
      const k = Math.min(1, 800 / Math.max(w, h));
      const c = makeCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      c.ctx.drawImage(full.canvas, x, y, w, h, 0, 0, c.canvas.width, c.canvas.height);
      // the words in reading order: line by line (close tops), left to right
      const ws = named[i].sort((a, b2) => (Math.abs(a.t - b2.t) < (a.b - a.t) * 0.5 ? a.l - b2.l : a.t - b2.t));
      const name = ws.map((wd) => wd.str).join(" ").replace(/\s+/g, " ").trim();
      out.push({ data: c.canvas.toDataURL("image/png"), name, size: w * h, page: n, y: b.t, x: b.l });
      c.canvas.width = c.canvas.height = 0;
    });
    full.canvas.width = full.canvas.height = 0;
  }
  return out.map(({ data, name, size }) => ({ data, name, size }));
}

// the separate pictures drawn on a page (px): ink (not white, not see-through) joined up when a
// few px apart; boxes that overlap become one; specks and a box over nearly the whole page go
function logoBlobs(data, W, H) {
  const g = Math.max(2, Math.ceil(Math.max(W, H) / 700));
  const gw = Math.ceil(W / g), gh = Math.ceil(H / g);
  const ink = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const row = ((y / g) | 0) * gw, base = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = base + x * 4;
      if (data[i + 3] > 24 && !(data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240)) ink[row + ((x / g) | 0)] = 1;
    }
  }
  // grown by 2 cells, so pieces a little apart are one
  const grown = new Uint8Array(gw * gh), R = 2;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!ink[y * gw + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) grown[yy * gw + xx] = 1;
    }
  }
  const seen = new Uint8Array(gw * gh);
  let boxes = [];
  for (let i = 0; i < gw * gh; i++) {
    if (!grown[i] || seen[i]) continue;
    const st = [i];
    seen[i] = 1;
    let l = gw, t = gh, r = -1, b = -1;
    while (st.length) {
      const j = st.pop(), x = j % gw, y = (j / gw) | 0;
      if (ink[j]) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
      for (const k of [j - 1, j + 1, j - gw, j + gw]) {
        if (k < 0 || k >= gw * gh || seen[k] || !grown[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === gw - 1)) continue;
        seen[k] = 1;
        st.push(k);
      }
    }
    if (r >= 0) boxes.push({ l: l * g, t: t * g, r: Math.min(W, (r + 1) * g), b: Math.min(H, (b + 1) * g) });
  }
  // a piece inside / over another one (a crest inside its ring, a badge behind it): one logo
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length && !merged; j++) {
      const a = boxes[i], c = boxes[j];
      if (a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b) {
        boxes[i] = { l: Math.min(a.l, c.l), t: Math.min(a.t, c.t), r: Math.max(a.r, c.r), b: Math.max(a.b, c.b) };
        boxes.splice(j, 1);
        merged = true;
      }
    }
  }
  const min = Math.max(W, H) * 0.02;
  // (a long thin one is words drawn as shapes — a school's name — not a logo)
  boxes = boxes.filter((b) => b.r - b.l >= min && b.b - b.t >= min && (b.r - b.l) * (b.b - b.t) < W * H * 0.7 &&
    (b.r - b.l) / (b.b - b.t) < 3.5 && (b.b - b.t) / (b.r - b.l) < 3.5);
  // reading order: by rows (tops within half a logo), then left to right
  const avg = boxes.reduce((s, b) => s + (b.b - b.t), 0) / (boxes.length || 1);
  return boxes.sort((a, b) => (Math.abs(a.t - b.t) < avg * 0.5 ? a.l - b.l : a.t - b.t));
}
