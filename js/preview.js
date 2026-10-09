// Crystal preview: shown in a frame by another website (the order system's Production page).
// That page posts { type: "crystal-rows", rows: [{ event_header, position, event_line_1, …,
// jenis_plak }] }; each row is drawn on the Crystal Studio design its jenis_plak names, with the
// texts filled from the row, exactly as the editor would. Identical rows are drawn once, with a count,
// and each category (TOKOH, KEHADIRAN PENUH …) gets its own tab, like the sheets of the order's Excel.
// This page tells the website "crystal-studio-ready" when it can draw, and "crystal-studio-height"
// whenever its height changes, so the frame can grow to fit.

import { esc } from "./util.js";
import { setFontList, setFontFiles } from "./fonts.js";
import { store, onLibraryChanged } from "./store.js";
import { libraryScene, setMaster, autoCleanAll, hiResBackground } from "./library.js";
import { renderOffscreen, svgOffscreen } from "./editor.js";
import { templateFor, contentKey, orderDesignId, TEXT_FIELDS } from "./jenis.js";
import { illustratorWindow, START_LINK } from "./to-illustrator.js";
import { vectorJob } from "./vector-job.js";

const DPI = 150;      // sharp enough to zoom in on the words
const BASE_H = 380;   // the picture's height on the page before zooming (px)

const out = document.getElementById("out");
const tabs = document.getElementById("tabs");
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.dataset.theme = "dark";

const tell = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, "*"); };
// the frame grows with this page: told on every size change, after every drawing, and now and then
// (some browsers pause size watching in a frame that is still 0 high)
let lastHeight = -1;
const sendHeight = () => {
  const h = Math.ceil(document.body.getBoundingClientRect().height) + 8;
  if (h !== lastHeight) { lastHeight = h; tell({ type: "crystal-studio-height", height: h }); }
};
new ResizeObserver(sendHeight).observe(document.body);
setInterval(sendHeight, 1000);

let library = [];
let job = 0;


// rows with the same jenis plak, and the same words, are one tile
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const jenis = String(row.jenis_plak || "").replace(/\s+/g, " ").trim();
    if (!/\bCRYSTAL\b/i.test(jenis)) continue;
    if (!groups.has(jenis)) groups.set(jenis, new Map());
    const key = TEXT_FIELDS.map((f) => String(row[f] || "")).join("\u0001");
    const g = groups.get(jenis);
    if (g.has(key)) g.get(key).qty++; else g.set(key, { row, qty: 1 });
  }
  return [...groups].map(([jenis, m]) => ({ jenis, tiles: [...m.values()] }));
}

const caption = (row) => String(row.event_line_1 || row.position || row.event_header || "").replace(/\n/g, " · ");

let allRows = [], tab = null;

// one tab per crystal design (jenis plak) in the order; a design not imported into Crystal Studio
// yet is marked
const ALL = "\u0000all"; // the ALL tab: every crystal of the order at once

function show(rows) {
  allRows = rows || [];
  const groups = groupRows(allRows);
  if (tab !== ALL && !groups.some((g) => g.jenis === tab)) tab = groups.length ? ALL : null;
  const total = groups.reduce((n, g) => n + g.tiles.reduce((m, t) => m + t.qty, 0), 0);
  tabs.innerHTML = (groups.length ? `<button type="button" class="tab${tab === ALL ? " on" : ""}" data-jenis="${ALL}"
    title="Every crystal in this order">ALL<span>${total}</span></button>` : "") + groups.map((g) => {
    const count = g.tiles.reduce((n, t) => n + t.qty, 0), missing = !templateFor(library, g.jenis);
    return `<button type="button" class="tab${g.jenis === tab ? " on" : ""}${missing ? " missing" : ""}" data-jenis="${esc(g.jenis)}"
      title="${missing ? "No Crystal Studio design for this yet" : esc(g.jenis)}">${esc(g.jenis.replace(/^\s*CRYSTAL\s*\/\s*/i, ""))}<span>${count}</span></button>`;
  }).join("");
  tabs.hidden = !groups.length;
  if (tab === ALL) showAll(groups);
  else showTab(groups.find((g) => g.jenis === tab));
}

// ALL: every crystal of the order on one board, design after design, to look over at once; − / ＋
// make them all bigger or smaller, click one to see it alone. "Generate all crystals" draws every
// one full size and downloads them together in one .zip.
const smalls = new Map(); // slide key -> small picture
const THUMB_H = 170, THUMB_DPI = 100; // drawn sharp enough for the biggest zoom
let allZoom = 1, allCells = [];
const rowKey = (jenis, row) => contentKey({ ...row, jenis_plak: jenis });

// this order's own designs (changed in Crystal Studio and saved "for this order only"):
// content key -> the edited design. Shown instead of the default for those crystals.
let order = null, custom = {};
async function loadCustom() {
  custom = {};
  if (!order) return;
  try { const d = await store.loadDesign(orderDesignId(order)); custom = (d && d.data && d.data.custom) || {}; } catch (e) { /* none yet */ }
}
// one crystal's picture: this order's own design if it has one, else the default.
// svg: an Illustrator file instead (editable words, the artwork at print quality)
async function picture(it, jenis, row, dpi, svg = false) {
  const scene = await libraryScene(it, row, columns);
  if (svg) {
    const hi = await hiResBackground(it, 300).catch(() => null);
    if (hi) scene.images = scene.images.map((im) => (im.role === "bg" ? { ...im, src: hi } : im));
  }
  const own = custom[rowKey(jenis, row)];
  const entry = own ? { state: own, images: scene.images } : { scene };
  return svg ? svgOffscreen(entry) : (await renderOffscreen(entry, dpi)).url;
}
const short = (jenis) => jenis.replace(/^\s*CRYSTAL\s*\/\s*/i, "");

async function showAll(groups) {
  const my = ++job;
  slides = [];
  columns = [...new Set(allRows.flatMap((r) => Object.keys(r)))].map((k) => ({ key: k, label: k }));
  const cells = allCells = groups.flatMap((g) => {
    const it = templateFor(library, g.jenis);
    return it ? g.tiles.map((t, i) => ({ g, it, t, i })) : [{ g, it: null, t: null, i: 0 }];
  });
  const ready = cells.filter((c) => c.it).length;
  out.innerHTML = `
    <div class="abar">
      <span class="muted">${ready} crystal${ready === 1 ? "" : "s"} · click one to see it alone</span>
      <span class="zoom"><button type="button" id="aOut" aria-label="Smaller">−</button><span id="aZoom">${Math.round(allZoom * 100)}%</span><button type="button" id="aIn" aria-label="Bigger">＋</button></span>
      <button type="button" class="gen" id="aGen"${ready ? "" : " disabled"} title="Every crystal in one PDF, a page each at its real size (300 DPI), to check, send or print">⬇ All crystals (PDF)</button>
      <button type="button" class="gen" id="aAi"${ready ? "" : " disabled"} title="Every crystal opened in Adobe Illustrator and saved as .ai (words editable, artwork at print quality)">Open in Illustrator (.ai)</button>

      <span id="aGenMsg" class="muted"></span>
    </div>
    <div class="grid" id="aGrid" style="--th:${Math.round(THUMB_H * allZoom)}px">${cells.map((c, n) => `
    <button type="button" class="cell${c.it ? "" : " missing"}" data-n="${n}" title="${c.it ? "See it alone" : "No Crystal Studio design for this yet"}">
      <span class="thumb">${c.it && smalls.get(rowKey(c.g.jenis, c.t.row)) ? `<img alt="" src="${smalls.get(rowKey(c.g.jenis, c.t.row))}">` : c.it ? "…" : "Not imported yet"}</span>
      <span class="clabel"><b>${esc(short(c.g.jenis))}</b>${c.t ? ` ×${c.t.qty}` : ""}${c.t && custom[rowKey(c.g.jenis, c.t.row)] ? ' <span class="own" title="Changed for this order only">✎ this order</span>' : ""}</span>
      <span class="clabel">${c.t ? esc(caption(c.t.row)) : ""}</span>
    </button>`).join("")}</div>`;
  const setAllZoom = (step) => {
    allZoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(allZoom) + step))];
    document.getElementById("aGrid").style.setProperty("--th", Math.round(THUMB_H * allZoom) + "px");
    document.getElementById("aZoom").textContent = Math.round(allZoom * 100) + "%";
    sendHeight();
  };
  document.getElementById("aIn").onclick = () => setAllZoom(1);
  document.getElementById("aOut").onclick = () => setAllZoom(-1);
  document.getElementById("aGen").onclick = () => generateAll(false);
  // one button: Open in Illustrator; when Crystal Studio isn't running here it becomes ▶ Start
  document.getElementById("aAi").onclick = () => generateAll(true);
  out.onclick = (e) => {
    const b = e.target.closest(".cell");
    if (!b) return;
    const c = cells[+b.dataset.n];
    tab = c.g.jenis;
    at = c.i;
    zoom = 1;
    show(allRows);
  };
  sendHeight();
  for (const [n, c] of cells.entries()) {
    if (!c.it) continue;
    const key = rowKey(c.g.jenis, c.t.row);
    if (smalls.has(key)) continue;
    try {
      smalls.set(key, await picture(c.it, c.g.jenis, c.t.row, THUMB_DPI));
    } catch (e) { smalls.set(key, null); }
    if (my !== job) return; // another tab was picked meanwhile
    const el = out.querySelector(`.cell[data-n="${n}"] .thumb`);
    if (el) el.innerHTML = smalls.get(key) ? `<img alt="" src="${smalls.get(key)}">` : "Couldn't draw this one";
  }
  sendHeight();
}

// every crystal of the order, full size, one file each: "SA4 - DESIGN B - TOKOH AKADEMIK PUTERI x1.png"
let generating = false;
function saveFile(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Open in Illustrator: one click does it all. Crystal Studio not known to be running here (this
// tab): the click first asks Windows to start it (crystalstudio://open, set up once by ⚙ Set up this
// computer; Chrome asks the first time, "Always allow" stops that), then the window to it waits
// until it's up and hands it the crystals.
const opened = (r, n) => r.ok ? `Opening ${n} crystal${n === 1 ? "" : "s"} in Illustrator; each is saved as .ai in ${r.folder}.` : `Couldn't open Illustrator: ${r.error || "no answer"}`;
const isUp = () => { try { return sessionStorage.getItem("crystal-up") === "1"; } catch (e) { return false; } };
const setUp = (v) => { try { v ? sessionStorage.setItem("crystal-up", "1") : sessionStorage.removeItem("crystal-up"); } catch (e) {} };

// ai: open in Illustrator, through Crystal Studio on this PC (see to-illustrator.js), each saved as
// .ai. Else: all crystals in one PDF.
async function generateAll(ai) {
  if (generating) return;
  const btn = document.getElementById(ai ? "aAi" : "aGen"), msg = document.getElementById("aGenMsg");
  const cells = allCells.filter((c) => c.it);
  if (!cells.length) return;
  generating = true;
  btn.disabled = true;
  const say = (t) => { if (msg) msg.textContent = t; };
  // now, while it's a click: start Crystal Studio (unless it's known to run), and the window to it
  if (ai && !isUp()) { try { location.href = START_LINK; } catch (e) {} }
  const bridge = ai ? illustratorWindow() : null;
  try {
    const files = [], used = new Set();
    let n = 0, bad = 0;
    for (const c of cells) {
      say(`Drawing ${++n} of ${cells.length}…`);
      try {
        // Illustrator: made from the original .ai (vectorJob below); the picture only for a design
        // without one
        const data = ai ? null : await picture(c.it, c.g.jenis, c.t.row, 300, false);
        let name = [short(c.g.jenis), caption(c.t.row)].filter(Boolean).join(" - ").replace(/\//g, "-").replace(/[\\:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) + ` x${c.t.qty}`;
        for (let k = 2; used.has(name); k++) name = name.replace(/( \(\d+\))?$/, ` (${k})`);
        used.add(name);
        files.push({ name, data, w: c.it.width, h: c.it.height, c });
      } catch (e) { bad++; }
    }
    const badNote = bad ? ` (${bad} couldn't be drawn)` : "";
    if (ai) {
      say("Preparing the Illustrator files…");
      const list = [];
      for (const f of files) {
        const scene = await libraryScene(f.c.it, f.c.t.row, columns), own = custom[rowKey(f.c.g.jenis, f.c.t.row)];
        list.push({ item: f.c.it, entry: own ? { state: own, images: scene.images } : { scene }, name: f.name });
      }
      const { job, without } = await vectorJob(list);
      const svgs = [];
      for (const i of without) svgs.push({ name: files[i].name, svg: await picture(files[i].c.it, files[i].c.g.jenis, files[i].c.t.row, 300, true) });
      say(isUp() ? "Opening in Illustrator…" : "Starting Crystal Studio on this computer… (if Chrome asks “Open …?”, choose Open and tick Always allow)");
      const r = await bridge.sendWhenUp({ job, files: svgs });
      setUp(!!r && !r.old);
      if (r && r.old) return say(r.error);
      if (r) return say(opened(r, files.length) + badNote);
      bridge.cancel();
      // only now: the computer isn't set up for it
      if (msg) msg.innerHTML = `Crystal Studio didn't start on this computer. Set it up once: <a class="gen-small" href="Crystal%20Studio%20Setup.bat" download="Crystal Studio Setup.bat">⚙ Set up this computer</a> (download, double-click it), then Open in Illustrator again.`;
      return;
    }
    // all in one PDF: a page per crystal, at its real size (pt), the picture at 300 DPI
    if (!window.jspdf) return say("Couldn't make the PDF (PDF tool not loaded).");
    say("Making the PDF…");
    let pdf = null;
    for (const f of files) {
      const o = f.w > f.h ? "landscape" : "portrait";
      if (!pdf) pdf = new window.jspdf.jsPDF({ unit: "pt", format: [f.w, f.h], orientation: o, compress: true });
      else pdf.addPage([f.w, f.h], o);
      pdf.addImage(f.data, "PNG", 0, 0, f.w, f.h, undefined, "FAST");
    }
    const title = String(order || "crystals").replace(/[\\/:*?"<>|]+/g, " ").trim();
    saveFile(pdf.output("blob"), `${title} - crystals.pdf`);
    say(`Done: ${files.length} crystal${files.length === 1 ? "" : "s"} in one PDF${badNote}.`);
  } finally {
    generating = false;
    if (btn.isConnected) btn.disabled = false;
  }
}

tabs.onclick = (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  tab = b.dataset.jenis;
  at = 0;
  zoom = 1;
  show(allRows);
};

// One crystal at a time, like the editor: ‹ › go through this design's crystals (each different set
// of words), then on to the next design. Click the picture, or + / −, to zoom.
let slides = [], at = 0, zoom = 1, columns = [];
const pics = new Map(); // slide key -> picture (data URL), drawn once
const ZOOMS = [1, 1.5, 2, 3];

function showTab(g) {
  ++job;
  columns = [...new Set(allRows.flatMap((r) => Object.keys(r)))].map((k) => ({ key: k, label: k }));
  const it = g && templateFor(library, g.jenis);
  slides = !g ? [] : it ? g.tiles.map((t) => ({ g, it, t })) : [{ g, it: null, t: null }];
  at = Math.min(at, Math.max(0, slides.length - 1));
  if (!slides.length) {
    out.innerHTML = `<p class="msg">This order has no crystal.</p>`;
    return;
  }
  out.innerHTML = `
    <div class="vhead"><b id="vJenis"></b> <span id="vSub" class="muted"></span> <a href="#" class="edit" id="vEdit"
      title="Open this design in Crystal Studio with these rows, to change it and save it as the default">✎ Edit in Crystal Studio</a></div>
    <div class="vrow">
      <button type="button" class="nav" id="vPrev" aria-label="Previous crystal">‹</button>
      <div class="stage" id="vStage"></div>
      <button type="button" class="nav" id="vNext" aria-label="Next crystal">›</button>
    </div>
    <div class="vfoot">
      <span id="vCap" class="cap"></span>
      <span class="zoom"><button type="button" id="vOut" aria-label="Zoom out">−</button><span id="vZoom">100%</span><button type="button" id="vIn" aria-label="Zoom in">＋</button></span>
      <label id="vFlipWrap"><input type="checkbox" id="flip"> Flip to read</label>
    </div>`;
  // ‹ › go through this design's crystals, then on to the next design's (the tabs, in order)
  const go = (d) => {
    zoom = 1;
    if (at + d >= 0 && at + d < slides.length) { at += d; draw(); return; }
    const ds = groupRows(allRows), i = ds.findIndex((x) => x.jenis === tab);
    if (ds.length < 2) { at = (at + d + slides.length) % slides.length; draw(); return; }
    const next = ds[(i + d + ds.length) % ds.length];
    tab = next.jenis;
    at = d > 0 ? 0 : next.tiles.length - 1; // showTab keeps it in range
    show(allRows);
  };
  document.getElementById("vPrev").onclick = () => go(-1);
  document.getElementById("vNext").onclick = () => go(1);
  document.getElementById("vIn").onclick = () => setZoom(1);
  document.getElementById("vOut").onclick = () => setZoom(-1);
  document.getElementById("flip").onchange = () => draw();
  out.onclick = null;
  document.getElementById("vStage").onclick = (e) => { if (e.target.tagName === "IMG") setZoom(zoom >= ZOOMS[ZOOMS.length - 1] ? -9 : 1); };
  // ✎ Edit: Crystal Studio opens in a new tab with this design's rows, carried in the link itself
  // (after the #, so they never leave this computer)
  document.getElementById("vEdit").onclick = (e) => {
    e.preventDefault();
    const g = slides[at].g;
    window.open("./#order=" + encodeURIComponent(JSON.stringify({ name: g.jenis, order, rows: g.tiles.map((t) => t.row) })), "_blank");
  };
  draw();
}

function setZoom(step) {
  const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + step));
  zoom = ZOOMS[i];
  draw();
}

document.addEventListener("keydown", (e) => {
  if (!slides.length || e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") document.getElementById("vPrev")?.click();
  if (e.key === "ArrowRight") document.getElementById("vNext")?.click();
});

async function draw() {
  const my = ++job, sl = slides[at];
  if (!sl) return;
  const one = slides.length < 2 && groupRows(allRows).length < 2;
  document.getElementById("vPrev").disabled = one;
  document.getElementById("vNext").disabled = one;
  document.getElementById("vJenis").textContent = sl.g.jenis;
  document.getElementById("vSub").textContent = `· crystal ${at + 1} of ${slides.length}` + (sl.it ? ` · ×${sl.t.qty}` : "") +
    (sl.t && custom[rowKey(sl.g.jenis, sl.t.row)] ? " · ✎ changed for this order" : "");
  document.getElementById("vEdit").hidden = !sl.it;
  document.getElementById("vCap").textContent = sl.t ? [sl.t.row.category, caption(sl.t.row)].filter(Boolean).join(" · ") : "";
  document.getElementById("vZoom").textContent = Math.round(zoom * 100) + "%";
  const stage = document.getElementById("vStage");
  const flipped = !!sl.it && (sl.it.texts || []).some((t) => t.flipX);
  document.getElementById("vFlipWrap").hidden = !flipped;
  if (!sl.it) {
    stage.innerHTML = `<p class="msg warn">No Crystal Studio design for this yet — import its .ai in Crystal Studio.</p>`;
    sendHeight();
    return;
  }
  const key = rowKey(sl.g.jenis, sl.t.row);
  if (!pics.has(key)) {
    stage.innerHTML = `<p class="msg">Drawing…</p>`;
    try {
      pics.set(key, await picture(sl.it, sl.g.jenis, sl.t.row, DPI));
    } catch (e) {
      if (my === job) stage.innerHTML = `<p class="msg warn">Couldn't draw this one.</p>`;
      return;
    }
    if (my !== job) return; // moved on meanwhile
  }
  const flip = flipped && document.getElementById("flip").checked;
  stage.innerHTML = `<img alt="" src="${pics.get(key)}" style="height:${Math.round(BASE_H * zoom)}px${flip ? ";transform:scaleX(-1)" : ""}">`;
  stage.classList.toggle("zoomed", zoom > 1);
  sendHeight();
}

// a design or the master template changed (saved in Crystal Studio, in another tab): read them
// again and draw again. Also when this page is looked at again, in case that tab was elsewhere.
let reloadTimer = null, reloading = false;
async function reloadLibrary() {
  if (reloading) return;
  reloading = true;
  try {
    const was = JSON.stringify(custom);
    const [lib, m] = await Promise.all([store.listLibrary(), store.master(), loadCustom()]);
    const same = JSON.stringify(lib) === JSON.stringify(library) && JSON.stringify(m) === JSON.stringify(lastMaster) && JSON.stringify(custom) === was;
    if (!same) {
      library = lib;
      lastMaster = m;
      setMaster(m);
      pics.clear();
      smalls.clear();
      if (allRows.length) show(allRows);
    }
  } catch (e) { /* keep showing what's there */ }
  reloading = false;
}
const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reloadLibrary, 400); };
onLibraryChanged(reloadSoon);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reloadSoon(); });
window.addEventListener("focus", reloadSoon);
let lastMaster = {};

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || !e.data) return;
  if (e.data.type === "crystal-rows") {
    const rows = Array.isArray(e.data.rows) ? e.data.rows : [];
    const o = typeof e.data.order === "string" || typeof e.data.order === "number" ? String(e.data.order) : null;
    if (o !== order) {
      order = o;
      pics.clear();
      smalls.clear();
      loadCustom().then(() => show(rows));
    } else show(rows);
  }
  // the website picked a Jenis Plak (a row of its price table clicked): show that design's tab
  if (e.data.type === "crystal-select" && typeof e.data.jenis === "string") {
    const want = e.data.jenis.replace(/\s+/g, " ").trim().toUpperCase();
    const g = groupRows(allRows).find((x) => x.jenis.toUpperCase() === want);
    if (!g) return;
    tab = g.jenis;
    at = 0;
    zoom = 1;
    show(allRows);
  }
});

(async () => {
  try { setFontList(await store.fonts()); } catch (e) {}
  try { setFontFiles(await store.fontFiles()); } catch (e) {}
  try { lastMaster = await store.master(); setMaster(lastMaster); } catch (e) {}
  try {
    library = await store.listLibrary();
    // designs imported before the logo clean-up: cleaned once now (and saved)
    if (library.some((it) => it.source === "pdf" && it.original && !it.cleaned)) {
      out.innerHTML = `<p class="msg">Taking the school logos out of older designs (only this once)…</p>`;
      await autoCleanAll(library, store.saveLibrary);
    }
  } catch (e) {
    out.innerHTML = `<p class="msg">Couldn't read the Crystal Studio designs (${esc(e.message)}).</p>`;
  }
  tell({ type: "crystal-studio-ready" });
})();
