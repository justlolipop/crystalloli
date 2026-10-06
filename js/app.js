// Crystal Studio — ties the panels together:
//   Elements (top)    columns of the Excel file; one design per row
//   Canvas (middle)   the design for the current row, edited Canva-style
//   Templates (below) your crystal .ai files, and the designs inside each one

import { $, esc, debounce, toast, ask, safeName, downloadBlob, downloadDataUrl } from "./util.js";
import { setFontList, fallbackFor, describeFont } from "./fonts.js";
import { readWorkbook, usableSheets, defaultSheet, readSheet } from "./excel.js";
import { libraryScene, importFile, hiResBackground } from "./library.js";
import * as editor from "./editor.js";
import { store } from "./store.js";

const PRINT_DPI = 300;
// same columns as the master order Excel (event_header, year, position, event_line_1, …)
const SAMPLE_COLUMNS = [
  { key: "event_header", label: "event_header" }, { key: "year", label: "year" }, { key: "position", label: "position" },
  { key: "event_line_1", label: "event_line_1" }, { key: "event_line_2", label: "event_line_2" },
  { key: "jenis_plak", label: "jenis_plak" }, { key: "category", label: "category" },
];
const sampleRows = () => [
  { event_header: "SK TAMAN SERI PAGI\nANUGERAH SERI PAGI (ASPA) 2026", year: "", position: "PENGAWAS\nPUSAT SUMBER\nSEKOLAH",
    event_line_1: "AHMAD FIRASH IMAN", event_line_2: "", jenis_plak: "CRYSTAL / AK7 / DESIGN C", category: "TOKOH" },
  { event_header: "SK TAMAN SERI PAGI\nANUGERAH SERI PAGI (ASPA) 2026", year: "", position: "MURID\nCEMERLANG",
    event_line_1: "NUR AISYAH BINTI AHMAD", event_line_2: "", jenis_plak: "CRYSTAL / SA4 / DESIGN A", category: "MURID" },
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

// ------------------------------------------------------------------ the Excel table
// Only columns A–F are shown; the rest (category, line_order, …) are still read and kept.
// Every Excel row is shown and edited on its own; its crystal comes from its jenis_plak, so rows
// with the same jenis_plak use the same template.

const SHOWN_COLUMNS = 6;
const shownCols = () => S.columns.slice(0, SHOWN_COLUMNS);
S.groups = [];   // [{ rows: [row indexes] }] in Excel order
S.groupOf = [];  // row index -> group index

function buildGroups() {
  S.groups = S.rows.map((rw, i) => ({ i, rows: [i] }));
  S.groupOf = S.rows.map((rw, i) => i);
}
// the row that stands for its whole group (its first row)
const canon = (r) => { const g = S.groups[S.groupOf[r]]; return g ? g.rows[0] : r; };
const groupRows = (r) => { const g = S.groups[S.groupOf[r]]; return g ? g.rows : [r]; };

// ------------------------------------------------------------------ crystal from column F
// "CRYSTAL / 80-B / DESIGN 2" -> the imported file with 80-B in its name, its 2nd design (B)

function parseJenis(v) {
  let s = String(v || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!s) return null;
  const dm = /\bDESIGN\s*([A-Z]|\d{1,2})\b/.exec(s);
  s = s.replace(/\bDESIGN\s*([A-Z]|\d{1,2})\b/, " ").replace(/\b(DTF\s+)?CRYSTAL\b/g, " ").replace(/[\/|]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? { code: s, design: dm ? dm[1] : "" } : null;
}

function findSource(code) {
  // "R-7", "R7" and "R 7" all match a file called "CRYSTAL R-7"; "011A" also matches "0011A"
  let pat = code.replace(/[^A-Z0-9]+/g, "").split("").join("[^A-Z0-9]*");
  if (!pat) return null;
  if (/^\d/.test(pat)) pat = "0*" + pat;
  const re = new RegExp("(^|[^A-Z0-9])" + pat + "(?![A-Z0-9])");
  return sources().filter((s) => re.test(s.file.toUpperCase().replace(/\.(AI|PDF|SVG)$/, "")))
    .sort((a, b) => a.file.length - b.file.length)[0] || null;
}

function pickDesign(items, d) {
  if (!items.length) return null;
  if (!d) return items[0];
  const n = /^\d+$/.test(d) ? +d : d.charCodeAt(0) - 64;
  const letter = String.fromCharCode(64 + n);
  const re = new RegExp("—\\s*(DESIGN\\s*)?(" + letter + "|" + n + ")\\s*$", "i");
  return items.find((x) => re.test(x.name)) || items[n - 1] || null;
}

// undefined: the row names no crystal · null: it names one that isn't imported · else its key
function autoKey(r) {
  const j = parseJenis((S.rows[r] || {}).jenis_plak);
  if (!j) return undefined;
  const src = findSource(j.code);
  const it = src && pickDesign(src.items, j.design);
  return it ? "lib|" + it.id : null;
}
const jenisLabel = (r) => String((S.rows[r] || {}).jenis_plak || "").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ templates for a row

function sources() {
  const groups = new Map();
  for (const it of S.library) {
    if (!groups.has(it.file)) groups.set(it.file, []);
    groups.get(it.file).push(it);
  }
  return [...groups].map(([file, items]) => ({ file, label: file.replace(/\.(ai|pdf|svg)$/i, ""), items: items.sort((a, b) => (a.order || 0) - (b.order || 0)) }));
}

function keyFor(r) {
  r = canon(r);
  return autoKey(r) || null;  // the crystal comes only from column F (jenis_plak)
}

function sceneFor(key, r) {
  const it = itemOf(key);
  return it ? libraryScene(it, S.rows[r] || {}, S.columns) : Promise.resolve(null);
}

// ------------------------------------------------------------------ showing a row

let showToken = 0;
async function show(r, key) {
  const token = ++showToken;
  S.row = canon(Math.max(0, Math.min(r, S.rows.length - 1)));
  key = key || keyFor(S.row);
  S.key = key;
  const it = itemOf(key);
  if (it) S.source = it.file;
  renderTable();
  if (!it) {
    const want = jenisLabel(S.row);
    editor.showEmpty(!want
      ? "This row has no <b>jenis_plak</b>, so no crystal is picked.<br>Fill column F in the Excel, e.g. <b>CRYSTAL / AK7 / DESIGN C</b>."
      : autoKey(S.row) === null
        ? `This row needs <b>${esc(want)}</b>, which isn't imported yet.<br>Press <b>Template folder</b> below to import it.`
        : `Couldn't read <b>${esc(want)}</b>. Write it like <b>CRYSTAL / AK7 / DESIGN C</b>.`);
    renderAll();
    return;
  }
  const scene = await sceneFor(key, S.row);
  if (token !== showToken || !scene) return;
  const saved = S.edits[S.row + "|" + key];
  const ok = saved ? await editor.loadState(saved, scene.images) : await editor.build(scene);
  if (!ok || token !== showToken) return;
  // the picture shown first is a quick preview; swap in the print-quality one (also used for downloads)
  hiResBackground(it, PRINT_DPI).then((url) => { if (url && token === showToken) editor.sharpenBackground(url); });
  
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

function renderTable() {
  const cols = shownCols();
  const cur = S.groupOf[S.row];
  const cell = (v) => {
    const s = String(v ?? "").replace(/\s*\n\s*/g, " ").trim();
    return `<td title="${esc(String(v ?? ""))}">${esc(s)}</td>`;
  };
  const head = `<tr><th class="n">#</th>${cols.map((c, i) => `<th><span class="colid">${String.fromCharCode(65 + i)}</span>${esc(c.label)}</th>`).join("")}<th class="st"></th></tr>`;
  const body = S.groups.map((g, gi) => {
    const r = g.rows[0], key = keyFor(r);
    const st = !key ? ["⚠", "No crystal template for this row yet"] : S.edits[r + "|" + key] ? ["✎", "Edited"] : ["", ""];
    return `<tr data-g="${gi}" class="${gi === cur ? "sel" : ""}" aria-selected="${gi === cur}">` +
      `<td class="n">${r + 1}</td>${cols.map((c) => cell(S.rows[r][c.key])).join("")}` +
      `<td class="st" title="${st[1]}">${st[0]}</td></tr>`;
  }).join("");
  $("xlTable").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  const sel = $("xlTable").querySelector("tr.sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
  const n = S.groups.length;
  $("rowCount").textContent = `Row ${cur + 1} of ${n}`;
  $("prevRow").disabled = cur <= 0;
  $("nextRow").disabled = cur >= n - 1;
  $("resetRow").disabled = !S.edits[S.row + "|" + S.key];
}
const renderTableSoon = debounce(renderTable, 200);

$("xlTable").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-g]");
  const g = tr && S.groups[+tr.dataset.g];
  if (g && g.rows[0] !== S.row) show(g.rows[0]);
});

function renderWarn() {
  const msgs = [];
  const it = itemOf(S.key);
  if (it && it.source === "pdf" && !it.texts.length) {
    msgs.push("This design has no live text — its words are part of the picture (converted to outlines in Illustrator). Keep the text live in the .ai to make it editable, or add new text on top.");
  } else if (it && it.texts.length && !editor.objects().some((o) => o.data && o.data.field)) {
    msgs.push("Tip: drag an Excel column (left of the design) onto a text to fill it from the Excel — it stays linked for every row.");
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
  $("sources").innerHTML = sources().map((s) => `<span class="src" title="${esc(s.file)}">` +
    `${esc(s.label)} <span class="tag">${s.items.length}</span>` +
    `<button class="x" data-delfile="${esc(s.file)}" aria-label="Delete ${esc(s.label)}" title="Remove this file's designs from the studio">×</button></span>`).join("")
    || `<p class="hint">No templates yet. Press <b>Template folder</b> to import from your DESIGN TEMPLATE folder.</p>`;
}

// which crystal this row uses — read-only, it comes from the Excel's jenis_plak
function renderTemplates() {
  const it = itemOf(S.key);
  $("tplNow").innerHTML = it
    ? `This crystal uses <b>${esc(it.name)}</b> <span class="hint">(from jenis_plak)</span>`
    : `<span class="hint">The crystal for each row is picked from its <b>jenis_plak</b> in the Excel.</span>`;
}

$("sources").addEventListener("click", (e) => {
  const b = e.target.closest("[data-delfile]");
  if (b) deleteFile(b.dataset.delfile);
});

async function deleteFile(file) {
  const items = S.library.filter((x) => x.file === file);
  if (!items.length || !await ask(`Remove “${file}” (${items.length} design${items.length === 1 ? "" : "s"}) from the studio? Your .ai file isn't touched.`)) return;
  for (const it of items) {
    try { await store.deleteLibrary(it.id); } catch (err) { return toast(err.message, "bad"); }
    S.library = S.library.filter((x) => x.id !== it.id);
    for (const k of Object.keys(S.edits)) if (k.endsWith("|lib|" + it.id)) delete S.edits[k];
  }
  await show(S.row);
}

// a pdf text linked to a column by hand: remember it in the template, for every row
const saveLibrarySoon = debounce((it) => store.saveLibrary({ id: it.id, texts: it.texts }).catch((e) => toast(e.message, "bad")), 500);
function onBound(o, field) {
  const it = itemOf(S.key);
  if (!it || it.source !== "pdf" || !o.data || typeof o.data.src !== "number" || !it.texts[o.data.src]) return;
  it.texts[o.data.src].field = field;
  saveLibrarySoon(it);
}

// Copy the Excel column links from a file's old designs onto the same texts in its new import
// (same design in the file, same words — or the same place when the words changed). -> links kept
function keepLinks(tpls, old) {
  let n = 0;
  for (const t of tpls) {
    const prev = old.filter((o) => (o.order || 0) === (t.order || 0) && o.texts);
    const linked = prev.flatMap((o) => o.texts.filter((x) => x.field));
    for (const x of t.texts || []) {
      if (x.field) continue;
      const same = linked.find((o) => o.text.trim() === String(x.text).trim()) ||
        linked.find((o) => Math.abs(o.left - x.left) < 4 && Math.abs(o.top - x.top) < 4);
      if (same) { x.field = same.field; n++; }
    }
  }
  return n;
}

async function importFiles(files) {
  const bad = [];
  let first = null;
  for (const f of files) {
    try {
      const tpls = await importFile(f, (m) => toast(m));
      // importing a file again replaces its old designs, keeping the texts' Excel column links
      const old = S.library.filter((x) => x.file === f.name);
      const kept = keepLinks(tpls, old);
      for (const t of tpls) {
        const saved = await store.saveLibrary(t);
        S.library.push(saved);
        if (!first) first = saved;
      }
      for (const it of old) {
        await store.deleteLibrary(it.id).catch(() => {});
        S.library = S.library.filter((x) => x.id !== it.id);
        for (const k of Object.keys(S.edits)) if (k.endsWith("|lib|" + it.id)) delete S.edits[k];
      }
      toast(`${f.name}: ${tpls.length} design${tpls.length === 1 ? "" : "s"} found` +
        (old.length ? ` — replaced the old copy${kept ? `, kept ${kept} column link${kept === 1 ? "" : "s"}` : ""}.` : "."));
    } catch (err) {
      bad.push(`${f.name}: ${err.message}`);
    }
  }
  if (first) {
    await show(S.row);  // column F picks the crystal: the new file may be the one this row needed
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

// arrows: the next / previous different crystal (rows that are the same are skipped)
const stepGroup = (d) => { const g = S.groups[S.groupOf[S.row] + d]; if (g) show(g.rows[0]); };
$("prevRow").onclick = () => stepGroup(-1);
$("nextRow").onclick = () => stepGroup(1);
$("resetRow").onclick = async () => {
  if (!S.edits[S.row + "|" + S.key]) return;
  if (!await ask("Throw away your changes on this row and go back to the template's design?")) return;
  delete S.edits[S.row + "|" + S.key];
  markDirty();
  await show(S.row, S.key);
};

$("applyAll").onclick = async () => {
  if (!S.key) return;
  const others = [];
  for (const g of S.groups) if (g.rows[0] !== S.row && keyFor(g.rows[0]) === S.key) others.push(g.rows[0]);
  if (!others.length) return toast("No other crystal uses this design.");
  if (!await ask(`Copy this crystal's positions, fonts and extra elements to ${others.length} other crystal${others.length === 1 ? "" : "s"} with the same design? (Each keeps its own text.)`)) return;
  for (const r of others) {
    const sc = await sceneFor(S.key, r);
    if (sc) S.edits[r + "|" + S.key] = await editor.layoutLike(sc);
  }
  markDirty();
  renderTable();
  toast(`Applied to ${others.length} crystal${others.length === 1 ? "" : "s"}.`);
};

// ------------------------------------------------------------------ Excel

$("excelFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (Object.keys(S.edits).length && !await ask("Load a new Excel file? Changes made on the current rows will be cleared.")) return;
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
  buildGroups();
  S.rowTpl = {};
  S.edits = {};
  $("srcHint").textContent = `${S.sourceName} · ${name} · ${rows.length} row${rows.length === 1 ? "" : "s"}`;
  markDirty();
  await show(0);
  $("colsBox").open = true;
  toast(`Loaded ${rows.length} row${rows.length === 1 ? "" : "s"} and ${columns.length} column${columns.length === 1 ? "" : "s"} from ${S.sourceName}.`);
}

// ------------------------------------------------------------------ editor hooks

function resyncRow() {
  for (const o of editor.objects()) {
    const d = o.data || {};
    if (editor.isText(o) && d.field && !d.tplText) for (const r of groupRows(S.row)) S.rows[r][d.field] = o.text;
  }
  renderElements();
}

editor.initEditor({
  changed: (state) => {
    if (!S.key) return;
    S.edits[S.row + "|" + S.key] = state;
    markDirty();
    renderTableSoon();
    renderElementsSoon();
  },
  restored: resyncRow,
  textChanged: (o) => {
    const d = o.data || {};
    if (!d.field || d.tplText) return;
    for (const r of groupRows(S.row)) S.rows[r][d.field] = o.text;
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
    const c = canon(r);
    const key = c === S.row ? S.key : keyFor(c);
    if (!key) continue;
    toast(all ? `Making PDF… ${n + 1} of ${rows.length}` : "Making PDF…");
    const out = await renderPrint(key, c, all ? "jpeg" : "png");
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
  buildGroups();
  $("designName").value = d.name;
  $("sheetSel").hidden = true;
  $("srcHint").textContent = S.sourceName ? `${S.sourceName}${S.sheet ? " · " + S.sheet : ""} · ${S.rows.length} rows` : `${S.rows.length} rows`;
  $("saveState").textContent = "Opened";
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
    if (S.dirty && !await ask("Open another design? Unsaved changes here will be lost.")) return;
    return openDesign(o.dataset.open);
  }
  const del = e.target.closest("[data-deldesign]");
  if (del && await ask("Delete this saved design? This can't be undone.")) {
    try { await store.deleteDesign(del.dataset.deldesign); } catch (err) { return toast(err.message, "bad"); }
    if (S.design.id === del.dataset.deldesign) S.design.id = null;
    openDialog();
  }
});

$("saveBtn").onclick = saveDesign;
$("openBtn").onclick = openDialog;
$("openClose").onclick = () => $("openDlg").close();
$("newBtn").onclick = async () => {
  if (S.dirty && !await ask("Start a new design? Unsaved changes will be lost.")) return;
  Object.assign(S, { columns: SAMPLE_COLUMNS, rows: sampleRows(), row: 0, rowTpl: {}, edits: {}, lastKey: null, sourceName: "", sheet: "", wb: null, design: { id: null, name: "Untitled design" }, dirty: false });
  buildGroups();
  $("designName").value = S.design.name;
  $("sheetSel").hidden = true;
  $("srcHint").textContent = "Sample data (2 rows)";
  $("saveState").textContent = "";
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
  buildGroups();
  await show(0);
})();