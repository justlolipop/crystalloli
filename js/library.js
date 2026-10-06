// Crystal templates imported from a file — no Illustrator needed.
//   .ai / .pdf  Each artboard is read. When an artboard holds several designs side by side
//               (Design A, B, C …), each one becomes its own template. The artwork becomes the
//               design's locked picture and every piece of live text becomes its own editable text,
//               in the same font, size, colour and place. (Text converted to outlines in Illustrator
//               stays part of the picture.) The original file is kept so downloads can redraw the
//               artwork at full print resolution.
//   .svg        Everything stays editable: shapes, lines and text.
// Text typed as {{column}} in Illustrator, or text that matches an Excel column name, fills in from
// the Excel row; any other text can be linked to a column by hand, and stays linked.

import { loose } from "./util.js";
import { useFont, findFont } from "./fonts.js";
import { fitSize } from "./measure.js";
import { store } from "./store.js";
import { visibleTextItems, readableText, withoutLiveText } from "./pdf.js";
import { pagePlan, drawOnly, serial } from "./elements.js";

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

  const texts = [];
  for (const [i, t] of (item.texts || []).entries()) {
    const css = t.ps ? await useFont(t.ps, t.family, t.style) : t.family ? `"${t.family}", sans-serif` : "Arial";
    const hasPh = /\{\{[^{}]+\}\}/.test(t.text);
    const field = t.field || fieldFromText(t.text, columns);
    let text = t.text;
    if (hasPh) text = fillPlaceholders(t.text, row, columns);
    else if (field && row[field] != null && String(row[field]).trim()) text = String(row[field]);
    if (!String(text).trim()) continue;
    const size = text === t.text ? t.fontSize : fitSize(text, css, t.fontSize, t.charSpacing, t.scaleX, t.maxW, 4);
    const real = css.startsWith("ps_");
    texts.push({
      ...t, text, css, field, fontSize: size, src: i, tplText: hasPh ? t.text : null,
      fontWeight: !real && t.bold ? "bold" : "normal", fontStyle: !real && t.italic ? "italic" : "normal",
    });
  }
  const images = item.background
    ? [{ role: "bg", src: "/" + item.background, left: 0, top: 0, width: item.width, height: item.height }] : [];
  return { width: item.width, height: item.height, background: "", images, texts };
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

// The artwork without its live text. Text with an outline or shadow made in Illustrator usually
// has a copy of its letters drawn as shapes right behind it; hiding only the live letters left that
// copy as a white "ghost" of the words. So shapes that sit inside a live text's box are left out too.
// Returns { without: runs another drawing of this page with those shapes left out as well,
//           ghosts: the shapes left out (their box in pt, colour, line width) }
async function drawBare(page, textItems, c, vp) {
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
  if (!ghosts.length) return asIs;
  const keep = plan.items.filter((it) => !inText(it)).map((it) => it.op);
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
  const { path: original } = await store.saveOriginal(file.name, bytes);
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
      });
    });
    bare.canvas.width = bare.canvas.height = 0;
  }
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
    runs.push({
      str, x: t[4], y: t[5], w: it.width * S, fh, font: it.fontName, ps, bold, italic,
      hs: Math.hypot(t[0], t[1]) / fh, angle: Math.atan2(t[1], t[0]) * 180 / Math.PI,
    });
  }

  // Join the pieces of one line. Illustrator often writes a line as many small pieces (kerned
  // letters, a letter in a substitute font), so pieces on the same baseline and of about the same
  // size are joined even when their font differs, and they're joined left to right.
  const sorted = runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const rotated = Math.abs(r.angle) > 0.5;
    const ln = rotated ? null : lines.find((l) => !l.rotated && Math.abs(l.fh - r.fh) < Math.max(0.6, r.fh * 0.15) &&
      Math.abs(l.y - r.y) < r.fh * 0.35 && r.x - l.end < r.fh * 1.2 && r.x + r.w > l.start - r.fh * 0.6);
    if (ln) {
      ln.parts.push(r);
      ln.start = Math.min(ln.start, r.x);
      ln.end = Math.max(ln.end, r.x + r.w);
    } else lines.push({ ...r, rotated, parts: [r], start: r.x, end: r.x + r.w });
  }
  for (const l of lines) {
    const parts = l.parts.sort((a, b) => a.x - b.x);
    let str = "", end = null;
    for (const p of parts) {
      const gap = end === null ? 0 : p.x - end;
      if (end !== null && gap > p.fh * 0.12 && !/\s$/.test(str) && !/^\s/.test(p.str)) str += " ";
      str += p.str;
      end = Math.max(end ?? -Infinity, p.x + p.w);
    }
    const x0 = Math.min(...parts.map((p) => p.x));
    l.x = x0;
    l.w = end - x0;
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
      if (b.rotated || b.font !== ln.font || Math.abs(b.fh - ln.fh) > 0.6 || b.color !== ln.color) return false;
      if (dy < ln.fh * 0.8 || dy > ln.fh * 1.9) return false;
      if (b.lines.length > 1 && Math.abs(dy - b.gap) > ln.fh * 0.25) return false;
      const tol = ln.fh * 0.6;
      return Math.abs(last.x + last.w / 2 - cx) < tol || Math.abs(last.x - ln.x) < tol || Math.abs(last.x + last.w - (ln.x + ln.w)) < tol;
    });
    if (b) { b.gap = ln.y - b.lines[b.lines.length - 1].y; b.lines.push(ln); }
    else blocks.push({ font: ln.font, fh: ln.fh, color: ln.color, rotated: ln.rotated, lines: [ln], gap: 0 });
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
      scaleX: Math.round(first.hs * 1000) / 1000 || 1, rotated: b.rotated, angle: b.rotated ? first.angle : 0,
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
    originX: align, textAlign: align, angle: b.angle, fontSize: b.fontSize, fill: b.fill, charSpacing: 0,
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
    originals.set(rel, pdfjsLib.getDocument({ url: "/" + rel, canvasFactory: factory, disableRange: true, disableStream: true }).promise);
  }
  return originals.get(rel);
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
        await drawBare(page, items, c, vp);
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