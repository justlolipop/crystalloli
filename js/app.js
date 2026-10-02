// Crystal Studio — ties the panels together:
//   Elements (top)    columns of the Excel file; one design per row
//   Canvas (middle)   the design for the current row, edited Canva-style
//   Templates (below) your crystal .ai files, and the designs inside each one

import { $, esc, debounce, toast, safeName, downloadBlob, downloadDataUrl } from "./util.js";
import { setFontList, fallbackFor, describeFont } from "./fonts.js";
import { readWorkbook, usableSheets, defaultSheet, readSheet } from "./excel.js";
import { libraryScene, importFile, hiResBackground } from "./library.js";
import * as editor from "./editor.js";
import { store } from "./store.js";

const PRINT_DPI = 300;
const SAMPLE_COLUMNS = [
  { key: "sekolah", label: "Sekolah" }, { key: "majlis", label: "Majlis" }, { key: "anugerah", label: "Anugerah" },
  { key: "nama", label: "Nama" }, { key: "tahun", label: "Tahun" },
];
const sampleRows = () => [
  { sekolah: "SK KAMPUNG JAWA", majlis: "MAJLIS ANUGERAH KECEMERLANGAN", anugerah: "GURU CEMERLANG", nama: "NORMA BINTI SHUKOR", tahun: "2026" },
  { sekolah: "SK KAMPUNG JAWA", majlis: "MAJLIS ANUGERAH KECEMERLANGAN", anugerah: "PENOLONG KANAN HEBAT", nama: "ABDUL MOEIS BIN ABDUL SHUKOR", tahun: "2026" },
];

const S = {
  columns: SAMPLE_COLUMNS, rows: sampleRows(), row: 0, sourceName: "", wb: null, sheet: "",
  source: null,   // file selected in the Templates panel (an imported .ai / .pdf / .svg name)
  key: null,      // template on the canvas: "lib|<id>"
  lastKey: null,  // the template last picked by hand; rows without their own choice use it
  rowTpl: {},     // row -> template key picked for that row
  edits: {},      // "row|key" -> { w, h, json } (only rows someone changed)
  library: [],
  design: { id: null, name: "Untitled design" },
  dirty: false,
};
const row = () => S.rows[S.row] || {};
const itemOf = (key) => (key ? S.library.find((x) => "lib|" + x.id === key) : null);
const columnsForUi = () => S.columns.map((c) => ({ key: c.key, label: c.label }));

// ------------------------------------------------------------------ templates for a row

function sources() {
  const groups = new Map();
  for (const it of S.library) {
    if (!groups.has(it.file)) groups.set(it.file, []);
    groups.get(it.file).push(it);
  }
  return [...groups].map(([file, items]) => ({ file, label: file.replace(/\.(ai|pdf|svg)$/i, ""), items: items.sort((a, b) => (a.order || 0) - (b.order || 0)) }));
}
const currentSource = () => sources().find((s) => s.file === S.source) || null;

function keyFor(r) {
  const valid = (k) => !!itemOf(k);
  if (valid(S.rowTpl[r])) return S.rowTpl[r];
  if (valid(S.lastKey)) return S.lastKey;
  const src = currentSource() || sources()[0];
  return src && src.items[0] ? "lib|" + src.items[0].id : null;
}

function sceneFor(key, r) {
  const it = itemOf(key);
  return it ? libraryScene(it, S.rows[r] || {}, S.columns) : Promise.resolve(null);
}

// ------------------------------------------------------------------ showing a row

let showToken = 0;
async function show(r, key) {
  const token = ++showToken;
  S.row = Math.max(0, Math.min(r, S.rows.length - 1));
  key = key || keyFor(S.row);
  S.key = key;
  const it = itemOf(key);
  if (it) S.source = it.file;
  renderRows();
  if (!it) {
    editor.showEmpty(S.library.length
      ? "Pick a design below to start."
      : "No crystal templates yet.<br>Press <b>Template folder</b> below to import from your DESIGN TEMPLATE folder, or <b>Import file</b>.");
    renderAll();
    return;
  }
  const scene = await sceneFor(key, S.row);
  if (token !== showToken || !scene) return;
  const saved = S.edits[S.row + "|" + key];
  const ok = saved ? await editor.loadState(saved, scene.images) : await editor.build(scene);
  if (!ok || token !== showToken) return;
  renderAll();
}

function renderAll() {
  renderElements();
  renderWarn();
  renderSources();
  renderTemplates();
}

// ------------------------------------------------------------------ Elements panel

function renderElements() {
  const rw = row();
  $("chips").innerHTML = S.columns.filter((c) => c.key !== "qty").map((c) => {
    const v = String(rw[c.key] ?? "");
    const on = !!editor.findField(c.key);
    const cls = ["chip", on ? "on" : v ? "off" : "empty", selectedFields.includes(c.key) ? "sel" : ""].join(" ");
    return `<button class="${cls}" draggable="true" data-field="${esc(c.key)}" title="${on ? "On the design — click to select it" : "Drag onto a text to make it show this column, or click to add it as new text"}">` +
      `<span class="k">${esc(c.label)}</span><span class="v">${v ? esc(v.replace(/\n/g, " ⏎ ")) : "<i>empty</i>"}</span></button>`;
  }).join("") || `<p class="hint">This sheet has no columns.</p>`;
  $("meta").innerHTML = row().qty ? `Qty <b>${esc(row().qty)}</b>` : "";
    const texts = editor.objects().filter((o) => editor.isText(o));
  $("elList").innerHTML = texts.map((o, i) => {
    const f = o.data && o.data.field, col = f && S.columns.find((c) => c.key === f);
    const label = String(o.text || "").replace(/\n/g, " ⏎ ").slice(0, 60) || "(empty)";
    return `<div class="elrow${selectedObjs.includes(o) ? " sel" : ""}" data-i="${i}"><span class="t">${esc(label)}</span>` +
      `<small>${col ? "Excel: " + esc(col.label) : "fixed text"}</small><button class="x" aria-label="Delete">×</button></div>`;
  }).join("") || `<p class="hint">This design has no editable text yet. Use Add text.</p>`;
  $("elAddCol").innerHTML = `<option value="">＋ Add Excel column…</option>` +
    S.columns.filter((c) => c.key !== "qty" && !editor.findField(c.key)).map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join("");
}
const renderElementsSoon = debounce(renderElements, 150);

function rowLabel(rw, i) {
  const s = Object.values(rw).find((v) => String(v).trim()) || "(empty)";
  const name = rw.nama || rw.name || s;
  return `${i + 1}. ${String(name).replace(/\n/g, " ").slice(0, 48)}`;
}

function renderRows() {
  $("rowSel").innerHTML = S.rows.map((r, i) => `<option value="${i}">${esc(rowLabel(r, i))}${S.edits[i + "|" + keyFor(i)] ? " ✎" : ""}</option>`).join("");
  $("rowSel").value = String(S.row);
  $("rowCount").textContent = `${S.rows.length} row${S.rows.length === 1 ? "" : "s"}`;
  $("prevRow").disabled = S.row <= 0;
  $("nextRow").disabled = S.row >= S.rows.length - 1;
  $("resetRow").disabled = !S.edits[S.row + "|" + S.key];
}
const renderRowsSoon = debounce(renderRows, 200);

function renderWarn() {
  const msgs = [];
  const it = itemOf(S.key);
  if (it && it.source === "pdf" && !it.texts.length) {
    msgs.push("This design has no live text — its words are part of the picture (converted to outlines in Illustrator). Keep the text live in the .ai to make it editable, or add new text on top.");
  } else if (it && it.texts.length && !editor.objects().some((o) => o.data && o.data.field)) {
    msgs.push("Tip: drag a chip from Elements onto a text to fill it from the Excel — it stays linked for every row.");
  }
  const mf = [...new Set(editor.objects().filter((o) => editor.isText(o) && o.data && o.data.ps && fallbackFor(o.data.ps)).map((o) => describeFont(o.data.ps)))];
  if (mf.length) msgs.push(`Not installed on this PC (showing a stand-in): ${mf.slice(0, 4).join(", ")}${mf.length > 4 ? "…" : ""}`);
  $("warn").textContent = msgs.join("  ·  ");
}

let selectedFields = [], selectedObjs = [];
function onSelection(list) {
  selectedObjs = list;
  selectedFields = list.map((o) => o.data && o.data.field).filter(Boolean);
  renderElements();
}

async function addField(field, at) {
  const col = S.columns.find((c) => c.key === field);
  const text = String(row()[field] || "").trim() || (col ? col.label : field);
  // look like the rest of the design: same font and colour as its first text
  const ref = editor.objects().find((o) => editor.isText(o));
  await editor.addText(text, {
    field, ps: ref && ref.data ? ref.data.ps : null, css: ref ? ref.fontFamily : "Arial", fill: ref ? ref.fill : undefined,
    fontSize: ref ? ref.fontSize : undefined, left: at ? at.x : undefined, top: at ? at.y : undefined,
  });
}

$("chips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c || !S.key) return;
  const o = editor.findField(c.dataset.field);
  if (o) editor.select(o);
  else addField(c.dataset.field);
});
$("chips").addEventListener("dragstart", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  e.dataTransfer.setData("text/x-field", c.dataset.field);
  e.dataTransfer.effectAllowed = "copy";
});
$("elAddText").onclick = async () => {
  if (!S.key) return;
  const ref = editor.objects().find((o) => editor.isText(o));
  await editor.addText("New text", { ps: ref && ref.data ? ref.data.ps : null, css: ref ? ref.fontFamily : "Arial", fill: ref ? ref.fill : undefined, fontSize: ref ? ref.fontSize : undefined });
};
$("elAddCol").onchange = () => { const f = $("elAddCol").value; if (f && S.key) addField(f); $("elAddCol").value = ""; };
$("elList").addEventListener("click", (e) => {
  const r = e.target.closest(".elrow");
  const o = r && editor.objects().filter((x) => editor.isText(x))[+r.dataset.i];
  if (!o) return;
  editor.select(o);
  if (e.target.closest(".x")) $("oDel").click();   // uses the toolbar's own Delete button
});

// ------------------------------------------------------------------ Templates panel

function renderSources() {
  $("sources").innerHTML = sources().map((s) => `<button class="src" role="tab" aria-selected="${s.file === S.source}" data-src="${esc(s.file)}" title="${esc(s.file)}">` +
    `${esc(s.label)} <span class="tag">${s.items.length}</span></button>`).join("")
    || `<p class="hint">No templates yet. Press <b>Template folder</b> to import from your DESIGN TEMPLATE folder.</p>`;
}

let tplToken = 0;
const thumbCache = new Map();
async function renderTemplates() {
  const token = ++tplToken;
  const src = currentSource();
  if (!src) { $("tpls").innerHTML = ""; $("tplSel").innerHTML = ""; $("tplCount").textContent = ""; return; }
  const short = (n) => n.replace(src.label + " — ", "");
  const idx = Math.max(0, src.items.findIndex((x) => "lib|" + x.id === S.key));
  const it = src.items[idx], key = "lib|" + it.id;
  $("tplSel").innerHTML = src.items.map((x, i) => `<option value="lib|${esc(x.id)}">${i + 1}. ${esc(short(x.name))}</option>`).join("");
  $("tplSel").value = key;
  $("tplCount").textContent = `${idx + 1} of ${src.items.length}`;
  $("tplPrev").disabled = idx <= 0;
  $("tplNext").disabled = idx >= src.items.length - 1;
  const sub = it.source === "svg" ? "SVG · every element editable" : it.texts.length ? `${it.texts.length} editable text${it.texts.length === 1 ? "" : "s"}` : "picture only (no live text)";
  $("tpls").innerHTML = `<div class="tcard-wrap"><button class="tcard" aria-pressed="${key === S.key}" data-key="${esc(key)}">
    <span class="thumb"><img alt="" data-thumb="${esc(key)}"></span><span class="tname">${esc(short(it.name))}</span><span class="tsub">${esc(sub)}</span>
    </button><button class="tdel" data-del="${esc(it.id)}" aria-label="Delete ${esc(it.name)}" title="Delete this template">×</button></div>`;
  const sig = key + "|" + JSON.stringify(row());
  let url = thumbCache.get(sig);
  if (!url) {
    try {
      const sc = await sceneFor(key, S.row);
      if (!sc) return;
      url = (await editor.renderOffscreen({ scene: sc }, (72 * 320) / Math.max(sc.width, sc.height * 1.4))).url;
      thumbCache.set(sig, url);
    } catch (e) { return; }
  }
  if (token !== tplToken) return;
  const img = $("tpls").querySelector("img[data-thumb]");
  if (img) img.src = url;
}

async function chooseTemplate(key) {
  S.rowTpl[S.row] = key;
  S.lastKey = key;
  markDirty();
  await show(S.row, key);
}
$("sources").addEventListener("click", (e) => {
  const b = e.target.closest("[data-src]");
  const src = b && sources().find((s) => s.file === b.dataset.src);
  if (src && src.items[0]) chooseTemplate("lib|" + src.items[0].id);
});
const stepTpl = (d) => {
  const src = currentSource();
  const i = src ? src.items.findIndex((x) => "lib|" + x.id === S.key) : -1;
  if (src && src.items[i + d]) chooseTemplate("lib|" + src.items[i + d].id);
};
$("tplSel").onchange = () => chooseTemplate($("tplSel").value);
$("tplPrev").onclick = () => stepTpl(-1);
$("tplNext").onclick = () => stepTpl(1);

$("tpls").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) return deleteTemplate(del.dataset.del);
  const card = e.target.closest("[data-key]");
  if (!card) return;
  S.rowTpl[S.row] = card.dataset.key;
  S.lastKey = card.dataset.key;
  markDirty();
  await show(S.row, card.dataset.key);
});

async function deleteTemplate(id) {
  const it = S.library.find((x) => x.id === id);
  if (!it || !confirm(`Delete the template “${it.name}”? (Your .ai file isn't touched.)`)) return;
  try { await store.deleteLibrary(id); } catch (err) { return toast(err.message, "bad"); }
  S.library = S.library.filter((x) => x.id !== id);
  const key = "lib|" + id;
  for (const r of Object.keys(S.rowTpl)) if (S.rowTpl[r] === key) delete S.rowTpl[r];
  for (const k of Object.keys(S.edits)) if (k.endsWith("|" + key)) delete S.edits[k];
  if (S.lastKey === key) S.lastKey = null;
  if (!currentSource()) S.source = sources()[0] ? sources()[0].file : null;
  await show(S.row, S.key === key ? null : S.key);
}

// a pdf text linked to a column by hand: remember it in the template, for every row
const saveLibrarySoon = debounce((it) => store.saveLibrary({ id: it.id, texts: it.texts }).catch((e) => toast(e.message, "bad")), 500);
function onBound(o, field) {
  const it = itemOf(S.key);
  if (!it || it.source !== "pdf" || !o.data || typeof o.data.src !== "number" || !it.texts[o.data.src]) return;
  it.texts[o.data.src].field = field;
  thumbCache.clear();
  saveLibrarySoon(it);
}

async function importFiles(files) {
  const bad = [];
  let first = null;
  for (const f of files) {
    try {
      const tpls = await importFile(f, (m) => toast(m));
      for (const t of tpls) {
        const saved = await store.saveLibrary(t);
        S.library.push(saved);
        if (!first) first = saved;
      }
      toast(`${f.name}: ${tpls.length} design${tpls.length === 1 ? "" : "s"} found.`);
    } catch (err) {
      bad.push(`${f.name}: ${err.message}`);
    }
  }
  if (first) {
    const key = "lib|" + first.id;
    S.rowTpl[S.row] = key;
    S.lastKey = key;
    S.source = first.file;
    markDirty();
    await show(S.row, key);
  }
  if (bad.length) toast(bad.join("  ·  "), "bad");
  return !bad.length;
}

$("importFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) await importFiles(files);
});

// ------------------------------------------------------------------ template folder (\\TEQGO\...\DESIGN TEMPLATE)

let folderFiles = [];
function renderFolderList() {
  const q = $("folderSearch").value.trim().toLowerCase();
  const imported = new Set(S.library.map((x) => x.file));
  const list = folderFiles.filter((f) => !q || f.name.toLowerCase().includes(q));
  $("folderList").innerHTML = list.map((f) => `<div class="frow">
      <span class="fname">${esc(f.name)}</span><span class="hint">${(f.size / 1048576).toFixed(1)} MB</span>
      ${imported.has(f.name) ? '<span class="tag ok">imported</span>' : ""}
      <button data-import="${esc(f.name)}">${imported.has(f.name) ? "Import again" : "Import"}</button>
    </div>`).join("") || `<p class="hint">${folderFiles.length ? "Nothing matches." : "No .ai / .pdf / .svg files here."}</p>`;
}

async function openFolder() {
  $("folderDlg").showModal();
  $("folderList").innerHTML = '<p class="hint">Loading…</p>';
  try {
    const r = await store.folder();
    $("folderPath").value = r.folder || "";
    folderFiles = r.files || [];
    if (r.error) $("folderList").innerHTML = `<p class="bad">${esc(r.error)}</p>`;
    else if (!r.folder) $("folderList").innerHTML = '<p class="hint">Paste the path of your template folder above, then press Use folder.</p>';
    else renderFolderList();
  } catch (err) {
    $("folderList").innerHTML = `<p class="bad">${esc(err.message)}</p>`;
  }
}

$("folderBtn").onclick = openFolder;
$("folderClose").onclick = () => $("folderDlg").close();
$("folderSearch").oninput = renderFolderList;
$("folderSet").onclick = async () => {
  try {
    const r = await store.setFolder($("folderPath").value);
    folderFiles = r.files || [];
    if (r.error) $("folderList").innerHTML = `<p class="bad">${esc(r.error)}</p>`;
    else renderFolderList();
  } catch (err) {
    toast(err.message, "bad");
  }
};
$("folderList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-import]");
  if (!b) return;
  b.disabled = true;
  b.textContent = "Importing…";
  try {
    const file = await store.folderFile(b.dataset.import);
    const ok = await importFiles([file]);
    if (ok) $("folderDlg").close();
  } catch (err) {
    toast(err.message, "bad");
  }
  renderFolderList();
});

// ------------------------------------------------------------------ rows

$("rowSel").onchange = () => show(+$("rowSel").value);
$("prevRow").onclick = () => show(S.row - 1);
$("nextRow").onclick = () => show(S.row + 1);
$("resetRow").onclick = async () => {
  if (!S.edits[S.row + "|" + S.key]) return;
  if (!confirm("Throw away your changes on this row and go back to the template's design?")) return;
  delete S.edits[S.row + "|" + S.key];
  markDirty();
  await show(S.row, S.key);
};

$("applyAll").onclick = async () => {
  if (!S.key) return;
  const others = [];
  for (let r = 0; r < S.rows.length; r++) if (r !== S.row && keyFor(r) === S.key) others.push(r);
  if (!others.length) return toast("No other row uses this design.");
  if (!confirm(`Copy this row's positions, fonts and extra elements to ${others.length} other row${others.length === 1 ? "" : "s"}? (Each row keeps its own text.)`)) return;
  for (const r of others) {
    const sc = await sceneFor(S.key, r);
    if (sc) S.edits[r + "|" + S.key] = await editor.layoutLike(sc);
  }
  markDirty();
  renderRows();
  toast(`Applied to ${others.length} row${others.length === 1 ? "" : "s"}.`);
};

// ------------------------------------------------------------------ Excel

$("excelFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (Object.keys(S.edits).length && !confirm("Load a new Excel file? Changes made on the current rows will be cleared.")) return;
  try {
    S.wb = await readWorkbook(f);
  } catch (err) {
    return toast("Couldn't read that file. Use .xlsx / .xls / .csv with a header row.", "bad");
  }
  S.sourceName = f.name;
  const sheets = usableSheets(S.wb);
  $("sheetSel").innerHTML = sheets.map((n) => `<option>${esc(n)}</option>`).join("");
  $("sheetSel").hidden = sheets.length < 2;
  await loadSheet(defaultSheet(S.wb));
});

$("sheetSel").onchange = () => loadSheet($("sheetSel").value);

async function loadSheet(name) {
  const { columns, rows } = readSheet(S.wb, name);
  if (!rows.length) return toast(`Sheet “${name}” has no rows under its header.`, "bad");
  S.sheet = name;
  $("sheetSel").value = name;
  S.columns = columns;
  S.rows = rows;
  S.rowTpl = {};
  S.edits = {};
  thumbCache.clear();
  $("srcHint").textContent = `${S.sourceName} · ${name} · ${rows.length} row${rows.length === 1 ? "" : "s"}`;
  markDirty();
  await show(0);
}

// ------------------------------------------------------------------ editor hooks

function resyncRow() {
  for (const o of editor.objects()) {
    const d = o.data || {};
    if (editor.isText(o) && d.field && !d.tplText) S.rows[S.row][d.field] = o.text;
  }
  renderElements();
}

editor.initEditor({
  changed: (state) => {
    if (!S.key) return;
    S.edits[S.row + "|" + S.key] = state;
    markDirty();
    renderRowsSoon();
    renderElementsSoon();
  },
  restored: resyncRow,
  textChanged: (o) => {
    const d = o.data || {};
    if (!d.field || d.tplText) return;
    S.rows[S.row][d.field] = o.text;
    renderElementsSoon();
  },
  selection: onSelection,
  columns: columnsForUi,
  valueOf: (f) => String(row()[f] || ""),
  bound: onBound,
  dropField: (f, p) => { if (S.key) addField(f, p); },
  save: () => saveDesign(),
});

// ------------------------------------------------------------------ download

// the design's pictures, with the artwork redrawn at print resolution from the original .ai
async function printImages(key, r) {
  const sc = await sceneFor(key, r);
  if (!sc) return null;
  const images = (sc.images || []).slice();
  const hi = await hiResBackground(itemOf(key), PRINT_DPI);
  if (hi && images[0]) images[0] = { ...images[0], src: hi };
  return { sc, images, hi };
}

async function renderPrint(key, r, format) {
  const p = await printImages(key, r);
  if (!p) return null;
  const st = r === S.row && key === S.key ? editor.currentState() : S.edits[r + "|" + key];
  const entry = st ? { state: st, images: p.images } : { scene: { ...p.sc, images: p.images } };
  return editor.renderOffscreen(entry, PRINT_DPI, format);
}

async function exportPdf(all) {
  const { jsPDF } = window.jspdf;
  let pdf = null;
  const add = (url, w, h, fmt) => {
    const o = w > h ? "landscape" : "portrait";
    if (!pdf) pdf = new jsPDF({ unit: "pt", format: [w, h], orientation: o, compress: true });
    else pdf.addPage([w, h], o);
    pdf.addImage(url, fmt, 0, 0, w, h);
  };
  const rows = all ? S.rows.map((_, i) => i) : [S.row];
  let n = 0;
  for (const r of rows) {
    const key = r === S.row ? S.key : keyFor(r);
    if (!key) continue;
    toast(all ? `Making PDF… ${n + 1} of ${rows.length}` : "Making PDF…");
    const out = await renderPrint(key, r, all ? "jpeg" : "png");
    if (!out) continue;
    add(out.url, out.w, out.h, all ? "JPEG" : "PNG");
    n++;
  }
  if (!pdf) return toast("Nothing to download yet — pick a design first.", "bad");
  pdf.save(safeName(S.design.name) + (all ? " - all rows" : "") + ".pdf");
  toast("PDF ready.");
}

async function doExport(kind) {
  editor.closeMenus();
  if (!S.key) return toast("Nothing to download yet — pick a design first.", "bad");
  try {
    if (kind === "pdf" || kind === "pdf-all") return await exportPdf(kind === "pdf-all");
    const name = safeName(S.design.name) + (S.rows.length > 1 ? ` - row ${S.row + 1}` : "");
    if (kind === "png") {
      toast("Making a 300 dpi PNG…");
      const out = await renderPrint(S.key, S.row, "png");
      await downloadDataUrl(out.url, name + ".png");
      toast("PNG ready (transparent background).");
    }
    if (kind === "svg") {
      toast("Making the Illustrator file…");
      const p = await printImages(S.key, S.row);
      const it = itemOf(S.key);
      const svg = await editor.exportSvg(p && p.hi && it && it.background ? { [it.background]: p.hi } : {});
      downloadBlob(new Blob([svg], { type: "image/svg+xml" }), name + ".svg");
      toast("Open the .svg in Illustrator (File › Open) — the text stays editable.");
    }
  } catch (err) {
    toast("Download failed: " + err.message, "bad");
  }
}
document.querySelectorAll("[data-export]").forEach((b) => (b.onclick = () => doExport(b.dataset.export)));

// ------------------------------------------------------------------ save / open / new

function markDirty() {
  S.dirty = true;
  $("saveState").textContent = "Not saved";
}

async function saveDesign() {
  const data = { v: 2, columns: S.columns, rows: S.rows, row: S.row, rowTpl: S.rowTpl, edits: S.edits, lastKey: S.lastKey, source: S.source, sourceName: S.sourceName, sheet: S.sheet };
  let thumb = "";
  if (S.key) { try { thumb = editor.exportImage((72 * 360) / Math.max(1, editor.docSize().w), "jpeg"); } catch (e) {} }
  $("saveBtn").disabled = true;
  try {
    const r = await store.saveDesign({ id: S.design.id, name: S.design.name, data, thumb });
    S.design.id = r.id;
    S.dirty = false;
    $("saveState").textContent = "Saved " + new Date(r.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    toast("Couldn't save: " + err.message, "bad");
  } finally {
    $("saveBtn").disabled = false;
  }
}

async function openDesign(id) {
  let d;
  try { d = await store.loadDesign(id); } catch (err) { return toast(err.message, "bad"); }
  const x = d.data || {};
  Object.assign(S, {
    columns: x.columns || SAMPLE_COLUMNS, rows: x.rows && x.rows.length ? x.rows : sampleRows(), row: x.row || 0,
    rowTpl: x.rowTpl || {}, edits: x.edits || {}, lastKey: x.lastKey || null, source: x.source || S.source,
    sourceName: x.sourceName || "", sheet: x.sheet || "", wb: null, design: { id: d.id, name: d.name }, dirty: false,
  });
  $("designName").value = d.name;
  $("sheetSel").hidden = true;
  $("srcHint").textContent = S.sourceName ? `${S.sourceName}${S.sheet ? " · " + S.sheet : ""} · ${S.rows.length} rows` : `${S.rows.length} rows`;
  $("saveState").textContent = "Opened";
  thumbCache.clear();
  $("openDlg").close();
  await show(S.row);
}

async function openDialog() {
  $("openList").innerHTML = '<p class="hint">Loading…</p>';
  $("openDlg").showModal();
  let list = [];
  try { list = await store.listDesigns(); } catch (err) { $("openList").innerHTML = `<p class="bad">${esc(err.message)}</p>`; return; }
  $("openList").innerHTML = list.map((d) => `<div class="drow">
      <button class="dopen" data-open="${esc(d.id)}">${d.thumb ? `<img alt="" src="${d.thumb}">` : '<span class="nothumb"></span>'}
        <span><b>${esc(d.name)}</b><small>${new Date(d.updated).toLocaleString()} · ${d.rows} row${d.rows === 1 ? "" : "s"}</small></span></button>
      <button class="ib danger" data-deldesign="${esc(d.id)}" aria-label="Delete ${esc(d.name)}" title="Delete">×</button>
    </div>`).join("") || '<p class="hint">Nothing saved yet. Press Save (Ctrl+S) to keep a design here.</p>';
}

$("openList").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-open]");
  if (o) {
    if (S.dirty && !confirm("Open another design? Unsaved changes here will be lost.")) return;
    return openDesign(o.dataset.open);
  }
  const del = e.target.closest("[data-deldesign]");
  if (del && confirm("Delete this saved design? This can't be undone.")) {
    try { await store.deleteDesign(del.dataset.deldesign); } catch (err) { return toast(err.message, "bad"); }
    if (S.design.id === del.dataset.deldesign) S.design.id = null;
    openDialog();
  }
});

$("saveBtn").onclick = saveDesign;
$("openBtn").onclick = openDialog;
$("openClose").onclick = () => $("openDlg").close();
$("newBtn").onclick = async () => {
  if (S.dirty && !confirm("Start a new design? Unsaved changes will be lost.")) return;
  Object.assign(S, { columns: SAMPLE_COLUMNS, rows: sampleRows(), row: 0, rowTpl: {}, edits: {}, lastKey: null, sourceName: "", sheet: "", wb: null, design: { id: null, name: "Untitled design" }, dirty: false });
  $("designName").value = S.design.name;
  $("sheetSel").hidden = true;
  $("srcHint").textContent = "Sample data (2 rows)";
  $("saveState").textContent = "";
  thumbCache.clear();
  await show(0);
};
$("designName").addEventListener("change", () => { S.design.name = $("designName").value.trim() || "Untitled design"; markDirty(); });
window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

// ------------------------------------------------------------------ start

(async function start() {
  if (!(await store.ping())) {
    editor.showEmpty("This page has to be opened through the studio's own program, or it can't import or save.<br><br>" +
      "1. Stop Live Server (click <b>Port: 5500</b> at the bottom of VS Code)<br>" +
      "2. Press <b>F5</b> in VS Code, or double-click <b>Start Studio.bat</b><br>" +
      '3. Open <a href="http://localhost:5190">http://localhost:5190</a>');
    toast("Not connected to Crystal Studio's program (server.js) — see the message on the page.", "bad");
    return;
  }
  try { setFontList(await store.fonts()); } catch (e) {}
  try { S.library = await store.listLibrary(); } catch (e) { S.library = []; toast(e.message, "bad"); }
  S.source = sources()[0] ? sources()[0].file : null;
  await show(0);
})();
