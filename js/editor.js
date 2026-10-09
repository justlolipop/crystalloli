// The Canva-style canvas (Fabric.js 5). Document units are pt (1/72 inch) — the same units
// Illustrator and the scanned templates use — so zoom only changes what you see on screen.

import { $, debounce, round2 } from "./util.js";
import { useFont, findFont, describeFont, cssToPs, fallbackFor } from "./fonts.js";
import { fieldFromText, fillPlaceholders } from "./library.js";
import { fitSize } from "./measure.js";

export const PROPS = ["data", "selectable", "evented", "hasControls", "lockMovementX", "lockMovementY", "lockScalingX",
  "lockScalingY", "lockRotation", "editable", "hoverCursor", "outerStroke", "outerStrokeWidth"];
const SHAPES = ["rect", "circle", "ellipse", "line", "triangle", "polygon", "polyline", "path"];
export const isText = (o) => !!o && (o.type === "i-text" || o.type === "textbox" || o.type === "text");

// A second, wider outline painted behind a text's own outline and fill. Illustrator texts often
// have two: a thin one in the text's colour that makes a thin font look bold, and a wide white one.
if (!fabric.Text.prototype._outerStroke) {
  const baseRender = fabric.Text.prototype._renderText, baseCache = fabric.Text.prototype.shouldCache;
  Object.assign(fabric.Text.prototype, {
    _outerStroke: true,
    _renderText(ctx) {
      if (this.outerStroke && this.outerStrokeWidth > 0) {
        const s = this.stroke, w = this.strokeWidth, j = this.strokeLineJoin;
        Object.assign(this, { stroke: this.outerStroke, strokeWidth: this.outerStrokeWidth, strokeLineJoin: "round" });
        ctx.lineJoin = "round";
        this._renderTextStroke(ctx);
        Object.assign(this, { stroke: s, strokeWidth: w, strokeLineJoin: j });
      }
      baseRender.call(this, ctx);
    },
    // the cached picture of a text only leaves room for its own outline: draw these directly
    shouldCache() { return this.outerStroke ? (this.ownCaching = false) : baseCache.call(this); },
  });
}
export const isTemplateImage = (o) => !!o && !!o.data && (o.data.role === "bg" || o.data.role === "art");
const isShape = (o) => !!o && SHAPES.includes(o.type);

let cv;
const ed = { W: 600, H: 400, zoom: 1, autoFit: true, token: 0, quiet: 0, history: [], future: [], guides: [], clipboard: null, hooks: {} };

// ------------------------------------------------------------------ setup

export function initEditor(hooks) {
  ed.hooks = hooks || {};
  // Fabric 5.3 sets textBaseline "alphabetical" (not a real value) and Chrome warns on every draw
  fabric.Text.prototype._setTextStyles = function (ctx, charStyle, forMeasuring) {
    ctx.textBaseline = "alphabetic";
    if (this.path) ctx.textBaseline = { center: "middle", ascender: "top", descender: "bottom" }[this.pathAlign] || "alphabetic";
    ctx.font = this._getFontDeclaration(charStyle, forMeasuring);
  };
  Object.assign(fabric.Object.prototype, {
    transparentCorners: false, cornerColor: "#ffffff", cornerStrokeColor: "#0b6e72", borderColor: "#0b6e72",
    cornerSize: 10, cornerStyle: "circle", borderScaleFactor: 1.5, padding: 2,
  });
  cv = new fabric.Canvas("c", {
    preserveObjectStacking: true, backgroundColor: "", stopContextMenu: true,
    selectionColor: "rgba(11,110,114,0.08)", selectionBorderColor: "#0b6e72", selectionLineWidth: 1,
  });
  cv.on("selection:created", syncToolbar);
  cv.on("selection:updated", syncToolbar);
  cv.on("selection:cleared", syncToolbar);
  cv.on("object:modified", (e) => { normaliseTextScale(e.target); changed(); syncToolbar(); });
  cv.on("object:added", () => changed());
  cv.on("object:removed", () => changed());
  cv.on("text:changed", (e) => { ed.hooks.textChanged && ed.hooks.textChanged(e.target); changedSoon(); });
  cv.on("text:editing:exited", (e) => {
    const o = e.target;
    if (o && !String(o.text).trim() && !(o.data && o.data.field)) cv.remove(o);
    changed();
  });
  cv.on("object:moving", snap);
  cv.on("mouse:up", () => { if (ed.guides.length) { ed.guides = []; cv.requestRenderAll(); } });
  // picking a spot on the design (see pickPoint): reported in pt from its top-left
  cv.on("mouse:down", (e) => {
    if (!ed.pick) return;
    const p = cv.getPointer(e.e);
    ed.pick(p.x, p.y);
  });
  cv.on("after:render", drawGuides);
  wireToolbar();
  wireKeys();
  wireDrop();
  window.addEventListener("resize", debounce(() => { if (ed.autoFit) fitZoom(); }, 120));
  syncToolbar();
}

// ------------------------------------------------------------------ history

const snapshot = () => JSON.stringify(cv.toJSON(PROPS));

// What gets stored per row: everything except the template's own pictures (background / art),
// which are added fresh each time, so changing the background applies to every row.
function strip(json) {
  const o = typeof json === "string" ? JSON.parse(json) : json;
  o.objects = (o.objects || []).filter((x) => !(x.data && (x.data.role === "bg" || x.data.role === "art")));
  return JSON.stringify(o);
}
export const currentState = (json) => ({ w: ed.W, h: ed.H, json: strip(json || snapshot()) });

function changed() {
  if (ed.quiet) return;
  const s = snapshot();
  if (ed.history[ed.history.length - 1] === s) return;
  ed.history.push(s);
  if (ed.history.length > 80) ed.history.shift();
  ed.future = [];
  undoButtons();
  ed.hooks.changed && ed.hooks.changed(currentState(s));
}
const changedSoon = debounce(changed, 400);

function resetHistory(s) {
  ed.history = [s || snapshot()];
  ed.future = [];
  undoButtons();
}

function undoButtons() {
  $("undoBtn").disabled = ed.history.length < 2;
  $("redoBtn").disabled = !ed.future.length;
}

export async function undo() {
  if (ed.history.length < 2) return;
  ed.future.push(ed.history.pop());
  await restore(ed.history[ed.history.length - 1]);
}

export async function redo() {
  if (!ed.future.length) return;
  const s = ed.future.pop();
  ed.history.push(s);
  await restore(s);
}

async function restore(s) {
  ed.quiet++;
  try {
    await fontsInJson(s);
    await new Promise((r) => cv.loadFromJSON(s, r));
    patchFonts(cv);
    cv.renderAll();
  } finally {
    ed.quiet--;
  }
  undoButtons();
  syncToolbar();
  ed.hooks.restored && ed.hooks.restored();
  ed.hooks.changed && ed.hooks.changed(currentState(s));
}

// ------------------------------------------------------------------ building a design

function loadImage(src) {
  return new Promise((res) => fabric.Image.fromURL(src, (img, err) => res(!err && img && img.width ? img : null), { crossOrigin: "anonymous" }));
}

export function makeText(t) {
  return new fabric.IText(String(t.text ?? ""), {
    left: t.left, top: t.top, originX: t.originX || "left", originY: "top", textAlign: t.textAlign || "left",
    fontFamily: t.css || "Arial", fontSize: t.fontSize || 12, fontWeight: t.fontWeight || "normal", fontStyle: t.fontStyle || "normal",
    fill: t.fill || "#000000", stroke: t.stroke || null, strokeWidth: t.stroke ? t.strokeWidth || 0.2 : 0,
    paintFirst: t.paintFirst || "fill", strokeLineJoin: t.strokeLineJoin || "miter",
    outerStroke: t.outerStroke || null, outerStrokeWidth: t.outerStroke ? t.outerStrokeWidth || 0 : 0,
    charSpacing: t.charSpacing || 0, lineHeight: t.lineHeight || 1, scaleX: t.scaleX || 1, scaleY: t.scaleY || 1, angle: t.angle || 0, flipX: !!t.flipX,
    data: {
      role: "text", field: t.field || null, ps: t.ps || null, frame: t.frame || null, src: t.src ?? null, tplText: t.tplText || null,
      defLeft: t.left, defTop: t.top, vs: t.scaleY || 1, maxW: t.maxW || null,
    },
  });
}

// template pictures go at the very bottom, locked
async function insertImages(canvas, images, alive = () => true) {
  const loaded = await Promise.all((images || []).map((im) => loadImage(im.src)));
  if (!alive()) return false;
  loaded.forEach((img, i) => {
    if (!img) return;
    const im = images[i];
    img.set({
      left: im.left, top: im.top, originX: "left", originY: "top", scaleX: im.width / img.width, scaleY: im.height / img.height,
      selectable: false, evented: false, hoverCursor: "default", data: { role: im.role },
    });
    canvas.insertAt(img, canvas.getObjects().filter(isTemplateImage).length, false);
  });
  return true;
}

async function addSceneTo(canvas, scene, alive = () => true) {
  canvas.backgroundColor = scene.background || ""; // transparent like the artboard (DTF needs it)
  if (scene.type === "svg") return addSvg(canvas, scene, alive);
  if (!(await insertImages(canvas, scene.images, alive))) return false;
  for (const t of scene.texts || []) canvas.add(makeText(t));
  return alive();
}

// the same template picture drawn sharper (it keeps its size on the design) — not an edit
export async function sharpenBackground(src) {
  const o = cv.getObjects().find((x) => x.data && x.data.role === "bg");
  if (!o) return false;
  const w = o.getScaledWidth(), h = o.getScaledHeight();
  const img = await loadImage(src);
  if (!img || !cv.getObjects().includes(o)) return false;
  o.setElement(img.getElement());
  o.set({ scaleX: w / o.width, scaleY: h / o.height });
  cv.requestRenderAll();
  return true;
}

// background picked again (e.g. BACKGROUND_2 or another colour): swap the pictures, keep the edits
export async function setTemplateImages(images) {
  ed.quiet++;
  try {
    cv.getObjects().filter(isTemplateImage).forEach((o) => cv.remove(o));
    await insertImages(cv, images);
    cv.requestRenderAll();
  } finally {
    ed.quiet--;
  }
  changed();
}

async function addSvg(canvas, scene, alive) {
  const objects = await new Promise((res) => fabric.loadSVGFromString(scene.svg, (objs) => res(objs || [])));
  if (!alive()) return false;
  objects.forEach((o, i) => {
    if (!o) return;
    if (o.type === "text") { canvas.add(svgText(o, scene, i)); return; }
    o.data = { role: "svg", src: "svg" + i };
    canvas.add(o);
  });
  return true;
}

function svgText(o, scene, i) {
  const raw = o.text || "";
  const fam = String(o.fontFamily || "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  const f = scene.fontMap && scene.fontMap[fam];
  const hasPh = /\{\{[^{}]+\}\}/.test(raw);
  const field = fieldFromText(raw, scene.columns);
  let text = raw;
  if (hasPh) text = fillPlaceholders(raw, scene.row, scene.columns);
  else if (field && String(scene.row[field] ?? "").trim()) text = String(scene.row[field]);
  return new fabric.IText(text, {
    left: o.left, top: o.top, originX: o.originX, originY: o.originY, angle: o.angle, scaleX: o.scaleX, scaleY: o.scaleY,
    skewX: o.skewX, skewY: o.skewY, flipX: o.flipX, flipY: o.flipY, fontSize: o.fontSize, fontFamily: f ? f.css : o.fontFamily,
    fontWeight: o.fontWeight, fontStyle: o.fontStyle, fill: o.fill, stroke: o.stroke, strokeWidth: o.strokeWidth,
    charSpacing: o.charSpacing, textAlign: o.textAlign, opacity: o.opacity,
    data: { role: "text", field: field || null, ps: f ? f.ps : null, tplText: hasPh ? raw : null, src: "svg" + i, defLeft: o.left, defTop: o.top, vs: o.scaleY || 1 },
  });
}

async function fontsInJson(json) {
  const o = typeof json === "string" ? JSON.parse(json) : json;
  const list = new Set();
  (o.objects || []).forEach((x) => x.data && x.data.ps && list.add(x.data.ps));
  await Promise.all([...list].map((p) => useFont(p)));
}

function patchFonts(canvas) {
  canvas.getObjects().forEach((o) => {
    if (isText(o) && o.data && o.data.ps) {
      const fb = fallbackFor(o.data.ps);
      if (fb && o.fontFamily !== fb) o.set("fontFamily", fb);
    }
  });
}

function setDoc(w, h) {
  ed.W = w;
  ed.H = h;
  if (ed.autoFit) fitZoom();
  else applyZoom(ed.zoom);
}

export async function build(scene) {
  const token = ++ed.token;
  ed.quiet++;
  try {
    cv.discardActiveObject();
    cv.clear();
    $("stageWrap").classList.remove("is-empty");
    setDoc(scene.width, scene.height);
    const ok = await addSceneTo(cv, scene, () => token === ed.token);
    if (!ok || token !== ed.token) return false;
    cv.renderAll();
  } finally {
    ed.quiet--;
  }
  linkTextBackgrounds(cv);
  resetHistory();
  syncToolbar();
  return true;
}

export async function loadState(state, images) {
  const token = ++ed.token;
  ed.quiet++;
  try {
    await fontsInJson(state.json);
    if (token !== ed.token) return false;
    cv.discardActiveObject();
    $("stageWrap").classList.remove("is-empty");
    setDoc(state.w, state.h);
    await new Promise((r) => cv.loadFromJSON(state.json, r));
    if (token !== ed.token) return false;
    patchFonts(cv);
    if (!(await insertImages(cv, images, () => token === ed.token))) return false;
    cv.renderAll();
  } finally {
    ed.quiet--;
  }
  resetHistory();
  syncToolbar();
  return true;
}

export function showEmpty(html) {
  ++ed.token;
  ed.quiet++;
  cv.discardActiveObject();
  cv.clear();
  ed.quiet--;
  resetHistory();
  $("stageEmpty").innerHTML = html;
  $("stageWrap").classList.add("is-empty");
  syncToolbar();
}

// Same design, laid out in an off-screen canvas: for thumbnails, PDFs of every row, and
// copying one row's layout onto the others.
async function offscreen(entry) {
  const w = entry.state ? entry.state.w : entry.scene.width, h = entry.state ? entry.state.h : entry.scene.height;
  const sc = new fabric.StaticCanvas(document.createElement("canvas"), { width: w, height: h, renderOnAddRemove: false, enableRetinaScaling: false });
  if (entry.state) {
    await fontsInJson(entry.state.json);
    await new Promise((r) => sc.loadFromJSON(entry.state.json, r));
    patchFonts(sc);
    await insertImages(sc, entry.images);
  } else {
    await addSceneTo(sc, entry.scene);
  }
  return { sc, w, h };
}

// every text of a row's design as plain data (box in pt from the design's top-left), for
// putting the same words into the original .ai in Illustrator
export async function textsOf(entry) {
  const { sc } = await offscreen(entry);
  const out = sc.getObjects().filter(isText).filter((o) => o.visible !== false).map((o) => {
    const b = o.getBoundingRect(true, true), d = o.data || {};
    return {
      src: d.src ?? null, text: String(o.text ?? ""), l: b.left, t: b.top, r: b.left + b.width, b: b.top + b.height,
      size: (o.fontSize || 12) * (o.scaleY || 1), fill: typeof o.fill === "string" ? o.fill : null, align: o.textAlign || "left", ps: d.ps || null,
      // the rest of its look, for an editable copy in Illustrator
      family: String(o.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim(), hScale: (o.scaleX || 1) / (o.scaleY || 1),
      lineHeight: o.lineHeight || 1, tracking: o.charSpacing || 0, angle: o.angle || 0, flipX: !!o.flipX,
      stroke: typeof o.stroke === "string" && o.strokeWidth > 0 ? o.stroke : null, strokeWidth: (o.strokeWidth || 0) * (o.scaleY || 1), strokeBehind: o.paintFirst === "stroke",
      outer: o.outerStroke && o.outerStrokeWidth > 0 ? o.outerStroke : null, outerWidth: (o.outerStrokeWidth || 0) * (o.scaleY || 1),
    };
  });
  sc.dispose();
  return out;
}

// the pictures added in the studio (+ Image) on a row's design: where they are (pt, from the
// design's top-left) and the picture itself (data URL), for Illustrator to place
export async function imagesOf(entry) {
  const { sc } = await offscreen(entry);
  const out = sc.getObjects().filter((o) => o.type === "image" && o.data && o.data.role === "image" && o.visible !== false).map((o) => {
    const b = o.getBoundingRect(true, true);
    let src = "";
    try { src = o.getSrc(); } catch (e) {}
    return { src: /^data:image\//.test(src) ? src : "", l: b.left, t: b.top, r: b.left + b.width, b: b.top + b.height,
      w: o.getScaledWidth(), h: o.getScaledHeight(), angle: o.angle || 0, flipX: !!o.flipX };
  }).filter((x) => x.src);
  sc.dispose();
  return out;
}

// this design, straight from the canvas (no selection boxes or guides)
export function exportImage(dpi = 300, format = "png") {
  cv.discardActiveObject();
  ed.guides = [];
  cv.renderAll();
  const url = cv.toDataURL({ format, quality: 0.92, multiplier: dpi / 72 / ed.zoom });
  syncToolbar();
  return url;
}

export async function renderOffscreen(entry, dpi = 300, format = "png") {
  const { sc, w, h } = await offscreen(entry);
  if (format === "jpeg") sc.backgroundColor = "#ffffff"; // JPEG has no transparency
  sc.renderAll();
  const url = sc.toDataURL({ format: format === "jpeg" ? "jpeg" : "png", quality: 0.92, multiplier: dpi / 72 });
  sc.dispose();
  return { url, w, h };
}

const identity = (o) => {
  const d = o.data || {};
  if (d.src != null) return "s:" + d.src;
  if (d.field && d.defLeft != null) return "f:" + d.field;
  return null;
};
const COPY = ["left", "top", "angle", "scaleX", "scaleY", "skewX", "skewY", "flipX", "flipY", "fill", "stroke", "strokeWidth", "paintFirst",
  "outerStroke", "outerStrokeWidth", "opacity",
  "charSpacing", "lineHeight", "fontWeight", "fontStyle", "underline", "textAlign", "visible",
  "lockMovementX", "lockMovementY", "lockScalingX", "lockScalingY", "lockRotation", "hasControls", "editable"];

// Build another row's design from its scene, then give it this canvas's positions / fonts / extras
export async function layoutLike(scene) {
  const { sc } = await offscreen({ scene });
  const mine = new Map();
  const extras = [];
  for (const o of cv.getObjects()) {
    if (isTemplateImage(o)) continue;
    const id = identity(o);
    if (id) mine.set(id, o);
    else extras.push(o);
  }
  const theirs = new Set();
  for (const o of sc.getObjects()) {
    const id = identity(o);
    if (!id) continue;
    theirs.add(id);
    const s = mine.get(id);
    if (!s) { // template text/shape deleted from this design -> delete it there too (linked text may just be empty here)
      if (id.startsWith("s:") && !(o.data && o.data.field)) sc.remove(o);
      continue;
    }
    const p = {};
    COPY.forEach((k) => { if (s[k] !== undefined) p[k] = s[k]; });
    // template text: copy how far it was moved, not where it ended up (another row can use a
    // different box, e.g. the silver RANK_GREY frame instead of the gold one)
    const sd = s.data || {}, od = o.data || {};
    if (sd.defLeft != null && od.defLeft != null) {
      p.left = od.defLeft + (s.left - sd.defLeft);
      p.top = od.defTop + (s.top - sd.defTop);
    }
    if (isText(s)) {
      p.fontFamily = s.fontFamily;
      if (s.data && s.data.userSize) p.fontSize = s.fontSize;
    }
    o.set(p);
    o.data = { ...o.data, ps: s.data && s.data.ps, userFont: s.data && s.data.userFont, userSize: s.data && s.data.userSize, locked: s.data && s.data.locked };
  }
  for (const e of extras) {
    const c = await new Promise((r) => e.clone(r, PROPS));
    sc.add(c);
  }
  const json = strip(sc.toJSON(PROPS));
  sc.dispose();
  return { w: scene.width, h: scene.height, json };
}

// While fn is set, a click on the design calls fn(x, y) instead of selecting anything; null stops.
export function pickPoint(fn) {
  ed.pick = fn || null;
  cv.discardActiveObject();
  cv.selection = !fn;
  cv.defaultCursor = fn ? "crosshair" : "default";
  cv.forEachObject((o) => { if (!isTemplateImage(o)) o.evented = !fn; });
  cv.requestRenderAll();
}

// ------------------------------------------------------------------ zoom

export function fitZoom() {
  const wrap = $("stageWrap");
  const z = Math.min((wrap.clientWidth - 48) / ed.W, (wrap.clientHeight - 48) / ed.H);
  ed.autoFit = true;
  applyZoom(Math.max(0.05, Math.min(z, 12)));
}

function applyZoom(z) {
  ed.zoom = z;
  cv.setZoom(z);
  cv.setDimensions({ width: Math.max(1, Math.round(ed.W * z)), height: Math.max(1, Math.round(ed.H * z)) });
  $("zoomFit").textContent = Math.round(z * 100 * 72 / 96) + "%";
  cv.calcOffset();
}

function zoomBy(f) {
  ed.autoFit = false;
  applyZoom(Math.max(0.05, Math.min(ed.zoom * f, 40)));
}

// ------------------------------------------------------------------ snapping guides

// Only left-right: a text dragged near the middle (or under another text) lines up with it. No
// up-down snapping: texts sit just above or below the crystal's middle and were pulled onto it.
// Hold Alt while dragging to place it freely.
function snap(e) {
  const o = e.target;
  ed.guides = [];
  if (!o || (e.e && e.e.altKey)) return;
  const th = 6 / ed.zoom;
  const c = o.getCenterPoint();
  const xs = [ed.W / 2];
  for (const p of cv.getObjects()) {
    if (p === o || isTemplateImage(p) || (o.type === "activeSelection" && o.contains(p))) continue;
    xs.push(p.getCenterPoint().x);
  }
  let bx = null;
  for (const v of xs) if (Math.abs(v - c.x) < th && (bx === null || Math.abs(v - c.x) < Math.abs(bx - c.x))) bx = v;
  if (bx === null) return;
  ed.guides.push({ x: bx });
  o.setPositionByOrigin(new fabric.Point(bx, c.y), "center", "center");
}

function drawGuides() {
  if (!ed.guides.length) return;
  const ctx = cv.getContext();
  const v = cv.viewportTransform;
  ctx.save();
  ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
  ctx.strokeStyle = "#e0338a";
  ctx.lineWidth = 1 / ed.zoom;
  ctx.setLineDash([4 / ed.zoom, 3 / ed.zoom]);
  for (const g of ed.guides) {
    ctx.beginPath();
    if (g.x != null) { ctx.moveTo(g.x, 0); ctx.lineTo(g.x, ed.H); }
    else { ctx.moveTo(0, g.y); ctx.lineTo(ed.W, g.y); }
    ctx.stroke();
  }
  ctx.restore();
}

// Corner-dragging a text makes the font bigger (like Canva) instead of stretching it,
// keeping the template's own vertical scale.
function normaliseTextScale(o) {
  if (!isText(o)) return;
  const vs = (o.data && o.data.vs) || 1;
  if (Math.abs(o.scaleY - vs) < 1e-3) return;
  const f = o.scaleY / vs;
  o.set({ fontSize: round2(o.fontSize * f), scaleX: o.scaleX / f, scaleY: o.scaleY / f });
  o.data = { ...o.data, userSize: true };
  o.setCoords();
}

// ------------------------------------------------------------------ adding things

export async function addText(text, opts = {}) {
  const css = opts.ps ? await useFont(opts.ps) : opts.css || "Arial";
  const size = opts.fontSize || Math.max(6, Math.round(Math.min(ed.W, ed.H) * 0.08));
  const t = makeText({
    text, css, ps: opts.ps || null, fontSize: size, left: opts.left ?? ed.W / 2, top: opts.top ?? ed.H / 2 - size / 2,
    originX: "center", textAlign: "center", fill: opts.fill || "#1c2b33", field: opts.field || null,
  });
  t.data.defLeft = null; // added by hand: not one of the template's own positions
  t.data.defTop = null;
  cv.add(t);
  cv.setActiveObject(t);
  cv.requestRenderAll();
  return t;
}

function addShape(kind) {
  const s = Math.min(ed.W, ed.H);
  const at = { left: ed.W / 2, top: ed.H / 2, originX: "center", originY: "center", data: { role: "shape" } };
  let o;
  if (kind === "circle") o = new fabric.Circle({ ...at, radius: s * 0.15, fill: "#e8b45a" });
  else if (kind === "line") o = new fabric.Line([ed.W * 0.3, ed.H / 2, ed.W * 0.7, ed.H / 2], { ...at, stroke: "#1c2b33", strokeWidth: Math.max(0.5, s * 0.01) });
  else o = new fabric.Rect({ ...at, width: s * 0.4, height: s * 0.25, fill: "#0b6e72" });
  cv.add(o);
  cv.setActiveObject(o);
  cv.requestRenderAll();
}

async function addImageFile(file) {
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await loadImage(url);
  if (!img) return;
  const k = Math.min((ed.W * 0.5) / img.width, (ed.H * 0.5) / img.height);
  img.set({ left: ed.W / 2, top: ed.H / 2, originX: "center", originY: "center", scaleX: k, scaleY: k, data: { role: "image" } });
  cv.add(img);
  cv.setActiveObject(img);
  cv.requestRenderAll();
}

export const objects = () => cv.getObjects();
export const findField = (field) => cv.getObjects().find((o) => isText(o) && o.data && o.data.field === field);
export function select(o) { cv.setActiveObject(o); cv.requestRenderAll(); syncToolbar(); }
export const docSize = () => ({ w: ed.W, h: ed.H });

// ------------------------------------------------------------------ export

// replace: { pictureUrl: betterPictureUrl } — e.g. the full-resolution artwork instead of the preview
export async function exportSvg(replace = {}) {
  cv.discardActiveObject();
  cv.renderAll();
  return finishSvg(cv.toSVG({ viewBox: { x: 0, y: 0, width: ed.W, height: ed.H }, width: ed.W, height: ed.H }), replace);
}

// one row's design (as renderOffscreen takes it) as an Illustrator-ready .svg: editable text in the
// real fonts, the pictures inside the file
export async function svgOffscreen(entry) {
  const { sc, w, h } = await offscreen(entry);
  sc.renderAll();
  const svg = sc.toSVG({ viewBox: { x: 0, y: 0, width: w, height: h }, width: w, height: h });
  sc.dispose();
  return finishSvg(svg, {});
}

async function finishSvg(svg, replace) {
  // ask Illustrator for the real font (PostScript name), not this page's internal name
  const map = cssToPs();
  for (const css of Object.keys(map).sort((a, b) => b.length - a.length)) {
    svg = svg.replace(new RegExp(css + "(?![A-Za-z0-9_])", "g"), map[css]);
  }
  // put the pictures inside the file so it opens anywhere
  const srcs = [...new Set([...svg.matchAll(/xlink:href="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("data:")))];
  for (const s of srcs) {
    try {
      const plain = s.replace(/&amp;/g, "&");
      const better = Object.keys(replace).find((k) => plain.split("?")[0].endsWith(k));
      const blob = await (await fetch(better ? replace[better] : plain)).blob();
      const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
      svg = svg.split(`xlink:href="${s}"`).join(`xlink:href="${data}"`);
    } catch (e) {}
  }
  return svg;
}

// ------------------------------------------------------------------ toolbar

const sel = () => {
  const a = cv.getActiveObject();
  return !a ? [] : a.type === "activeSelection" ? a.getObjects() : [a];
};
const press = (el, on) => (typeof el === "string" ? $(el) : el).setAttribute("aria-pressed", on ? "true" : "false");
const hex = (c) => {
  try { return typeof c === "string" && c ? "#" + new fabric.Color(c).toHex().toLowerCase() : "#000000"; } catch (e) { return "#000000"; }
};
const familyName = (ff) => String(ff || "").split(",")[0].replace(/['"]/g, "").trim();

function refreshSelection() {
  const a = cv.getActiveObject();
  if (a && a.type === "activeSelection") {
    const list = a.getObjects();
    cv.discardActiveObject();
    cv.setActiveObject(new fabric.ActiveSelection(list, { canvas: cv }));
  } else if (a) a.setCoords();
  cv.requestRenderAll();
}

// live = while dragging a colour/slider (no undo step); commit = one undo step
function live(fn) { sel().forEach(fn); refreshSelection(); }
function commit(fn) { if (fn) sel().forEach(fn); refreshSelection(); changed(); syncToolbar(); }

function wireToolbar() {
  $("addText").onclick = () => addText("Your text");
  document.querySelectorAll("[data-shape]").forEach((b) => (b.onclick = () => { addShape(b.dataset.shape); closeMenus(); }));
  $("addImage").onchange = async (e) => { const f = e.target.files[0]; if (f) await addImageFile(f); e.target.value = ""; };

  $("fFont").onchange = async () => {
    const v = $("fFont").value;
    const ps = findFont(v);
    const css = ps ? await useFont(ps) : v.trim() || "Arial";
    commit((o) => { if (isText(o)) { o.set("fontFamily", css); o.data = { ...o.data, ps: ps || null, userFont: true }; } });
  };
  $("fSize").onchange = () => {
    const v = +$("fSize").value;
    if (v > 0) commit((o) => { if (isText(o)) { o.set("fontSize", v); o.data = { ...o.data, userSize: true }; } });
  };
  $("fColor").oninput = () => live((o) => isText(o) && o.set("fill", $("fColor").value));
  $("fColor").onchange = () => commit();
  $("fBold").onclick = () => { const on = $("fBold").getAttribute("aria-pressed") !== "true"; commit((o) => isText(o) && o.set("fontWeight", on ? "bold" : "normal")); };
  $("fItalic").onclick = () => { const on = $("fItalic").getAttribute("aria-pressed") !== "true"; commit((o) => isText(o) && o.set("fontStyle", on ? "italic" : "normal")); };
  $("fUnder").onclick = () => { const on = $("fUnder").getAttribute("aria-pressed") !== "true"; commit((o) => isText(o) && o.set("underline", on)); };
  document.querySelectorAll("[data-align]").forEach((b) => (b.onclick = () => commit((o) => isText(o) && o.set("textAlign", b.dataset.align))));
  $("fSpacing").onchange = () => commit((o) => isText(o) && o.set("charSpacing", +$("fSpacing").value || 0));
  $("fLeading").onchange = () => {
    const v = +$("fLeading").value;
    if (v > 0) commit((o) => isText(o) && o.set("lineHeight", v / (o.fontSize * 1.13)));
  };
  const setStroke = (o, color, w) => o.set(w > 0 ? { stroke: color, strokeWidth: w } : { stroke: null, strokeWidth: 0 });
  $("fStroke").oninput = () => live((o) => isText(o) && setStroke(o, $("fStroke").value, +$("fStrokeW").value || 0.3));
  $("fStroke").onchange = () => { if (!(+$("fStrokeW").value > 0)) $("fStrokeW").value = 0.3; commit(); };
  $("fStrokeW").onchange = () => commit((o) => isText(o) && setStroke(o, $("fStroke").value, +$("fStrokeW").value || 0));
  $("fField").onchange = () => {
    const f = $("fField").value || null;
    commit((o) => isText(o) && link(o, f));
  };

  $("sFill").oninput = () => live((o) => isShape(o) && o.type !== "line" && o.set("fill", $("sFill").value));
  $("sFill").onchange = () => commit();
  $("sStroke").oninput = () => live((o) => isShape(o) && o.set({ stroke: $("sStroke").value, strokeWidth: o.strokeWidth || 1 }));
  $("sStroke").onchange = () => commit();
  $("sStrokeW").onchange = () => commit((o) => isShape(o) && o.set({ stroke: $("sStroke").value, strokeWidth: +$("sStrokeW").value || 0 }));

  $("oOpacity").oninput = () => live((o) => o.set("opacity", +$("oOpacity").value));
  $("oOpacity").onchange = () => commit();
  $("oFwd").onclick = () => { const a = cv.getActiveObject(); if (a) { cv.bringForward(a); commit(); } };
  $("oBack").onclick = () => {
    const a = cv.getActiveObject();
    if (!a) return;
    const floor = cv.getObjects().filter(isTemplateImage).length; // never behind the template artwork
    if (a.type === "activeSelection" || cv.getObjects().indexOf(a) > floor) { cv.sendBackwards(a); commit(); }
  };
  $("oDup").onclick = duplicate;
  $("oLock").onclick = () => {
    const list = sel();
    const on = !list.every((o) => o.data && o.data.locked);
    list.forEach((o) => {
      o.set({ lockMovementX: on, lockMovementY: on, lockScalingX: on, lockScalingY: on, lockRotation: on, hasControls: !on, editable: !on });
      o.data = { ...(o.data || {}), locked: on };
    });
    commit();
  };
  $("oDel").onclick = removeSelected;

  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("zoomIn").onclick = () => zoomBy(1.25);
  $("zoomOut").onclick = () => zoomBy(1 / 1.25);
  $("zoomFit").onclick = fitZoom;
  $("stageWrap").addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  document.querySelectorAll(".menu > button").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const m = b.parentElement, open = !m.classList.contains("open");
    closeMenus();
    m.classList.toggle("open", open);
    b.setAttribute("aria-expanded", open ? "true" : "false");
  }));
  document.addEventListener("click", closeMenus);
}

export function closeMenus() {
  document.querySelectorAll(".menu.open").forEach((m) => { m.classList.remove("open"); m.querySelector(":scope > button").setAttribute("aria-expanded", "false"); });
}

function fillFieldSelect(current) {
  const cols = ed.hooks.columns ? ed.hooks.columns() : [];
  const opts = [`<option value="">— not linked —</option>`]
    .concat(cols.map((c) => `<option value="${c.key}">${c.label.replace(/</g, "&lt;")}</option>`));
  if (current && !cols.some((c) => c.key === current)) opts.push(`<option value="${current}">${current}</option>`);
  $("fField").innerHTML = opts.join("");
  $("fField").value = current || "";
}

function syncToolbar() {
  const list = sel();
  const texts = list.filter(isText), shapes = list.filter(isShape);
  $("tgText").hidden = !texts.length;
  $("tgShape").hidden = !shapes.length;
  $("tgObj").hidden = !list.length;
  $("ctxHint").hidden = !!list.length;
  if (texts.length) {
    const t = texts[0];
    $("fFont").value = t.data && t.data.ps ? describeFont(t.data.ps) : familyName(t.fontFamily);
    $("fSize").value = round2(t.fontSize);
    $("fColor").value = hex(t.fill);
    press("fBold", t.fontWeight === "bold" || +t.fontWeight >= 600);
    press("fItalic", t.fontStyle === "italic");
    press("fUnder", !!t.underline);
    document.querySelectorAll("[data-align]").forEach((b) => press(b, b.dataset.align === t.textAlign));
    $("fSpacing").value = Math.round(t.charSpacing || 0);
    $("fLeading").value = round2(t.fontSize * t.lineHeight * 1.13);
    $("fStroke").value = hex(t.stroke || "#000000");
    $("fStrokeW").value = t.stroke ? round2(t.strokeWidth) : 0;
    fillFieldSelect(t.data && t.data.field);
  }
  if (shapes.length) {
    const s = shapes[0];
    $("sFill").value = hex(s.fill);
    $("sStroke").value = hex(s.stroke || "#000000");
    $("sStrokeW").value = s.stroke ? round2(s.strokeWidth) : 0;
  }
  if (list.length) {
    $("oOpacity").value = list[0].opacity ?? 1;
    press("oLock", list.every((o) => o.data && o.data.locked));
  }
  ed.hooks.selection && ed.hooks.selection(list);
}

// this text now shows an Excel column (on every row)
function link(o, field) {
  o.data = { ...o.data, field: field || null, tplText: null };
  const v = field && ed.hooks.valueOf ? ed.hooks.valueOf(field) : "";
  if (v) {
    o.set("text", v);
    if (o.data.maxW) o.set("fontSize", fitSize(v, o.fontFamily, o.fontSize, o.charSpacing, o.scaleX, o.data.maxW));
  }
  ed.hooks.bound && ed.hooks.bound(o, field || null);
}

function unbind(o) {
  o.data = { ...(o.data || {}), field: null, src: null, tplText: null, defLeft: null, defTop: null, role: o.data && isTemplateImage(o) ? "image" : (o.data && o.data.role) || "shape" };
  o.set({ selectable: true, evented: true, hoverCursor: null });
}

function pasteClone(c) {
  cv.discardActiveObject();
  c.set({ left: c.left + 8, top: c.top + 8, evented: true });
  ed.quiet++;
  if (c.type === "activeSelection") {
    c.canvas = cv;
    c.forEachObject((o) => { unbind(o); cv.add(o); });
    c.setCoords();
  } else {
    unbind(c);
    cv.add(c);
  }
  ed.quiet--;
  cv.setActiveObject(c);
  cv.requestRenderAll();
  changed();
}

function duplicate() {
  const a = cv.getActiveObject();
  if (a) a.clone(pasteClone, PROPS);
}

function removeSelected() {
  const list = sel().filter((o) => !(o.data && o.data.locked));
  if (!list.length) return;
  cv.discardActiveObject();
  ed.quiet++;
  list.forEach((o) => cv.remove(o));
  ed.quiet--;
  cv.requestRenderAll();
  changed();
}

function wireKeys() {
  const nudge = debounce(() => changed(), 350);
  document.addEventListener("keydown", (e) => {
    const t = e.target || {};
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable;
    const a = cv.getActiveObject();
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || "").toLowerCase();
    if (mod && k === "s") { e.preventDefault(); ed.hooks.save && ed.hooks.save(); return; }
    if ((a && a.isEditing) || typing || document.querySelector("dialog[open]")) return;
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod && k === "v" && ed.clipboard) { e.preventDefault(); ed.clipboard.clone(pasteClone, PROPS); return; }
    if (!a) return;
    if (mod && k === "c") { a.clone((c) => (ed.clipboard = c), PROPS); return; }
    if (mod && k === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); return; }
    if (e.key === "Escape") { cv.discardActiveObject(); cv.requestRenderAll(); return; }
    const step = e.shiftKey ? 10 : 1;
    const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
    if (d && !(a.data && a.data.locked)) {
      e.preventDefault();
      a.set({ left: a.left + d[0], top: a.top + d[1] });
      a.setCoords();
      cv.requestRenderAll();
      nudge();
    }
  });
}

function wireDrop() {
  const wrap = $("stageWrap");
  wrap.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("text/x-field")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  });
  wrap.addEventListener("drop", (e) => {
    const f = e.dataTransfer.getData("text/x-field");
    if (!f) return;
    e.preventDefault();
    // dropped on a text: that text now shows this column. Anywhere else: a new text.
    const hit = cv.findTarget(e, false);
    if (hit && isText(hit) && !(hit.data && hit.data.locked)) {
      link(hit, f);
      cv.setActiveObject(hit);
      commit();
      return;
    }
    const p = cv.getPointer(e);
    ed.hooks.dropField && ed.hooks.dropField(f, { x: Math.max(0, Math.min(ed.W, p.x)), y: Math.max(0, Math.min(ed.H, p.y)) });
  });
}

/**
 * Automatically groups text layers that overlap (like drop shadows or outline duplicates)
 * so they move, scale, and rotate together on the canvas.
 */
export function groupOverlappingTexts(canvas) {
  if (!canvas) return;
  
  const objects = canvas.getObjects();
  const textObjects = objects.filter(
    (obj) => obj.type === 'text' || obj.type === 'i-text' || obj.type === 'textbox'
  );

  const processed = new Set();

  for (let i = 0; i < textObjects.length; i++) {
    for (let j = i + 1; j < textObjects.length; j++) {
      const objA = textObjects[i];
      const objB = textObjects[j];

      if (processed.has(objA) || processed.has(objB)) continue;

      // Distance check: see if the two text layers are stacked on top of each other
      const deltaX = Math.abs(objA.left - objB.left);
      const deltaY = Math.abs(objA.top - objB.top);

      // If they are within 15px of each other, group them together
      if (deltaX < 15 && deltaY < 15) {
        // Remove individual unlinked canvas objects
        canvas.remove(objA);
        canvas.remove(objB);

        // Group background shadow + front text together
        const comboGroup = new fabric.Group([objB, objA], {
          left: objA.left,
          top: objA.top,
          originX: 'center',
          originY: 'center',
          subTargetCheck: true // Allows double-clicking inner text to edit
        });

        canvas.add(comboGroup);
        processed.add(objA);
        processed.add(objB);
      }
    }
  }

  canvas.renderAll();
}

/**
 * 建立主文字与背景/阴影文字的动态绑定关系（不改变坐标和层级，拖动时自动跟随）
 */
/**
 * Links duplicate text layers (drop shadows/outlines) by matching exact string content
 * and tracks movement using Fabric.js matrix updates without modifying object origins.
 */
export function linkTextBackgrounds(canvas) {
  if (!canvas) return;

  const objects = canvas.getObjects();
  const texts = objects.filter(
    (o) => o.type === 'text' || o.type === 'i-text' || o.type === 'textbox'
  );

  // only a template's own shadow copies: texts filled from the Excel can show the same words
  // (two texts linked to one column) and must still move on their own
  const own = (t) => !(t.data && t.data.field) && typeof (t.data && t.data.src) === "string" && t.data.src.startsWith("svg");
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const t1 = texts[i];
      const t2 = texts[j];
      if (!own(t1) || !own(t2)) continue;

      // Match layers ONLY if they contain identical text content
      const str1 = (t1.text || '').trim();
      const str2 = (t2.text || '').trim();

      if (str1 && str1 === str2) {
        // Calculate center-point distance to avoid originX/originY misalignment issues
        const c1 = t1.getCenterPoint();
        const c2 = t2.getCenterPoint();
        const dist = Math.hypot(c1.x - c2.x, c1.y - c2.y);

        // Only pair them if their centers are within 30px (valid shadow/background duplicate)
        if (dist < 30) {
          // Top layer is usually later in the SVG DOM array or has higher z-index
          const main = j > i ? t2 : t1;
          const shadow = j > i ? t1 : t2;

          if (!main._followers) main._followers = [];

          main._followers.push({
            child: shadow,
            offsetX: shadow.left - main.left,
            offsetY: shadow.top - main.top
          });
        }
      }
    }
  }

  // Bind smooth follower logic on drag (once per canvas, and without removing the snap guides)
  if (canvas._followersWired) return;
  canvas._followersWired = true;
  canvas.on('object:moving', (e) => {
    const target = e.target;
    if (target && target._followers) {
      target._followers.forEach((f) => {
        f.child.set({
          left: target.left + f.offsetX,
          top: target.top + f.offsetY
        });
        f.child.setCoords();
      });
      canvas.requestRenderAll();
    }
  });
}