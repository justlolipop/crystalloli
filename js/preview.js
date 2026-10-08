// Crystal preview: shown in a frame by another website (the order system's Production page).
// That page posts { type: "crystal-rows", rows: [{ event_header, position, event_line_1, …,
// jenis_plak }] }; each row is drawn on the Crystal Studio design its jenis_plak names, with the
// texts filled from the row, exactly as the editor would. Identical rows are drawn once, with a count,
// and each category (TOKOH, KEHADIRAN PENUH …) gets its own tab, like the sheets of the order's Excel.
// This page tells the website "crystal-studio-ready" when it can draw, and "crystal-studio-height"
// whenever its height changes, so the frame can grow to fit.

import { esc } from "./util.js";
import { setFontList } from "./fonts.js";
import { store } from "./store.js";
import { libraryScene, setMaster, autoCleanAll } from "./library.js";
import { renderOffscreen } from "./editor.js";
import { templateFor } from "./jenis.js";

const DPI = 150;      // sharp enough to zoom in on the words
const BASE_H = 380;   // the picture's height on the page before zooming (px)
const TEXT_FIELDS = ["event_header", "year", "position", "event_line_1", "event_line_2", "event_line_3"];

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
const rowKey = (jenis, row) => jenis + "\u0002" + TEXT_FIELDS.map((f) => row[f] || "").join("\u0001");
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
      <button type="button" class="gen" id="aGen"${ready ? "" : " disabled"} title="Draw every crystal full size (300 DPI) and download them all in one .zip">⬇ Generate all crystals</button>
      <span id="aGenMsg" class="muted"></span>
    </div>
    <div class="grid" id="aGrid" style="--th:${Math.round(THUMB_H * allZoom)}px">${cells.map((c, n) => `
    <button type="button" class="cell${c.it ? "" : " missing"}" data-n="${n}" title="${c.it ? "See it alone" : "No Crystal Studio design for this yet"}">
      <span class="thumb">${c.it && smalls.get(rowKey(c.g.jenis, c.t.row)) ? `<img alt="" src="${smalls.get(rowKey(c.g.jenis, c.t.row))}">` : c.it ? "…" : "Not imported yet"}</span>
      <span class="clabel"><b>${esc(short(c.g.jenis))}</b>${c.t ? ` ×${c.t.qty}` : ""}</span>
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
  document.getElementById("aGen").onclick = generateAll;
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
      const scene = await libraryScene(c.it, c.t.row, columns);
      smalls.set(key, (await renderOffscreen({ scene }, THUMB_DPI)).url);
    } catch (e) { smalls.set(key, null); }
    if (my !== job) return; // another tab was picked meanwhile
    const el = out.querySelector(`.cell[data-n="${n}"] .thumb`);
    if (el) el.innerHTML = smalls.get(key) ? `<img alt="" src="${smalls.get(key)}">` : "Couldn't draw this one";
  }
  sendHeight();
}

// every crystal of the order, full size, in one .zip: "SA4 - DESIGN B - TOKOH AKADEMIK PUTERI x1.png"
let generating = false;
async function generateAll() {
  if (generating) return;
  const btn = document.getElementById("aGen"), msg = document.getElementById("aGenMsg");
  const cells = allCells.filter((c) => c.it);
  if (!cells.length || !window.JSZip) { if (msg) msg.textContent = "Couldn't generate (zip tool not loaded)."; return; }
  generating = true;
  btn.disabled = true;
  const zip = new JSZip(), used = new Set();
  let n = 0, bad = 0;
  try {
    for (const c of cells) {
      if (msg) msg.textContent = `Drawing ${++n} of ${cells.length}…`;
      try {
        const scene = await libraryScene(c.it, c.t.row, columns);
        const { url } = await renderOffscreen({ scene }, 300);
        let name = [short(c.g.jenis), caption(c.t.row)].filter(Boolean).join(" - ").replace(/\//g, "-").replace(/[\\:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) + ` x${c.t.qty}`;
        for (let k = 2; used.has(name); k++) name = name.replace(/( \(\d+\))?$/, ` (${k})`);
        used.add(name);
        zip.file(name + ".png", url.split(",")[1], { base64: true });
      } catch (e) { bad++; }
    }
    if (msg) msg.textContent = "Packing…";
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "crystals.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    if (msg) msg.textContent = `Done: ${cells.length - bad} crystal${cells.length - bad === 1 ? "" : "s"} downloaded` + (bad ? ` (${bad} couldn't be drawn)` : "") + ".";
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
    window.open("/#order=" + encodeURIComponent(JSON.stringify({ name: g.jenis, rows: g.tiles.map((t) => t.row) })), "_blank");
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
  document.getElementById("vSub").textContent = `· crystal ${at + 1} of ${slides.length}` + (sl.it ? ` · ×${sl.t.qty}` : "");
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
      const scene = await libraryScene(sl.it, sl.t.row, columns);
      pics.set(key, (await renderOffscreen({ scene }, DPI)).url);
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

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || !e.data) return;
  if (e.data.type === "crystal-rows") show(Array.isArray(e.data.rows) ? e.data.rows : []);
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
  try { setMaster(await store.master()); } catch (e) {}
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
