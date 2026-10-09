// Crystal Studio — ties the panels together:
//   Elements (top)    columns of the Excel file; one design per row
//   Canvas (middle)   the design for the current row, edited Canva-style
//   Templates (below) your crystal .ai files, and the designs inside each one

import { $, esc, debounce, toast, ask, askText, safeName, downloadBlob, downloadDataUrl } from "./util.js";
import { setFontList, setFontFiles, fallbackFor, describeFont } from "./fonts.js";
import { readWorkbook, usableSheets, defaultSheet, readSheet } from "./excel.js";
import { libraryScene, importFile, hiResBackground, fieldValue, setFieldValue, MASTER_FIELDS, setMaster, getMaster, pieceAt, redrawBackground, autoCleanAll } from "./library.js";
import { illustratorScript } from "./illustrator.js";
import * as editor from "./editor.js";
import { store } from "./store.js";
import { illustratorWindow, START_LINK } from "./to-illustrator.js";
import { vectorJob } from "./vector-job.js";
import { EDIT_PASSWORD_SHA256 } from "./config.js";
import { templateFor, sources as jenisSources, contentKey, orderDesignId } from "./jenis.js";

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
  order: null,    // opened from this order on the website (✎ Edit): its id
  origKeys: [],   // each row as it came from the website (jenis plak + words), for "this order only"
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
// (the matching itself is in jenis.js, shared with the preview page)

// undefined: the row names no crystal · null: it names one that isn't imported · else its key
function autoKey(r) {
  const it = templateFor(S.library, (S.rows[r] || {}).jenis_plak);
  return it === undefined ? undefined : it ? "lib|" + it.id : null;
}
const jenisLabel = (r) => String((S.rows[r] || {}).jenis_plak || "").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ templates for a row

const sources = () => jenisSources(S.library);

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
  const nextRow = canon(Math.max(0, Math.min(r, S.rows.length - 1)));
  // a design opened by hand (Templates panel) stays until another row is picked
  if (key) S.manual = key && key !== keyFor(nextRow) ? key : null;
  else if (nextRow !== S.row) S.manual = null;
  S.row = nextRow;
  key = key || S.manual || keyFor(S.row);
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
  $("prevRow").disabled = $("stagePrev").disabled = cur <= 0;
  $("nextRow").disabled = $("stageNext").disabled = cur >= n - 1;
  $("resetRow").disabled = !S.edits[S.row + "|" + S.key];
}
const renderTableSoon = debounce(renderTable, 200);

$("stagePrev").onclick = () => $("prevRow").click();
$("stageNext").onclick = () => $("nextRow").click();

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
  const text = fieldValue(row(), field).trim() || (col ? col.label : field);
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

// every imported file; click one to see its designs, click a design to open it (password first)
let openFile = null;
function renderSources() {
  const all = sources();
  if (openFile && !all.some((s) => s.file === openFile)) openFile = null;
  $("sources").innerHTML = all.map((s) => `<span class="src${s.file === openFile ? " on" : ""}" data-file="${esc(s.file)}" title="See this file's designs, to change one">` +
    `${esc(s.label)} <span class="tag">${s.items.length}</span>` +
    `<button class="x" data-delfile="${esc(s.file)}" aria-label="Delete ${esc(s.label)}" title="Remove this file's designs from the studio">×</button></span>`).join("")
    || `<p class="hint">No templates yet. Press <b>Import file</b> to add a crystal .ai.</p>`;
  const src = all.find((s) => s.file === openFile);
  $("srcDesigns").innerHTML = src ? src.items.map((it) =>
    `<button type="button" data-open="${esc(it.id)}"${"lib|" + it.id === S.key ? ' aria-pressed="true"' : ""}>${esc(it.name.replace(/^.*—\s*/, "") || it.name)}</button>`).join("") : "";
  $("srcDesigns").hidden = !src;
}

// opening a design the Excel row didn't pick, to change it: asks the password once (this tab)
let unlocked = false;
try { unlocked = sessionStorage.getItem("crystal-unlocked") === "1"; } catch (e) {}
async function unlock() {
  if (unlocked || !EDIT_PASSWORD_SHA256) return setAdmin(true), true;
  const pw = await askText("Admin password (to change the designs for everyone):", { password: true, okLabel: "Unlock" });
  if (pw == null) return false;
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== EDIT_PASSWORD_SHA256) { toast("Wrong password.", "bad"); return false; }
  unlocked = true;
  try { sessionStorage.setItem("crystal-unlocked", "1"); } catch (e) {}
  setAdmin(true);
  return true;
}

// Admin (🔒 Admin, the password, once per tab): sees what changes the designs for everyone —
// Save as default template, Remove from background / Put back, the Crystal templates panel
// (import, open any design, delete), New / Open / Save, Import Excel, the Excel column chips.
// Everyone else only changes the crystals of the order they came from (Save for this order only).
function setAdmin(on) {
  document.body.classList.toggle("admin", on);
  $("adminBtn").textContent = on ? "🔓 Admin (lock)" : "🔒 Admin";
}
setAdmin(unlocked);
$("adminBtn").onclick = async () => {
  if (unlocked) {
    unlocked = false;
    try { sessionStorage.removeItem("crystal-unlocked"); } catch (e) {}
    setAdmin(false);
    return toast("Locked: only Save for this order only is shown now.");
  }
  if (await unlock()) toast("Admin: Save as default template, Remove from background and the templates panel are shown.");
};
async function openTemplate(id) {
  const key = "lib|" + id;
  if (key === S.key) return;
  if (key !== keyFor(S.row) && !(await unlock())) return;
  await show(S.row, key);
}

// which crystal this row uses — read-only, it comes from the Excel's jenis_plak
function renderTemplates() {
  const it = itemOf(S.key);
  $("tplNow").innerHTML = it && S.manual
    ? `Changing <b>${esc(it.name)}</b> <span class="hint">(opened by hand, filled with this row's words)</span> <button type="button" id="backToRow">Back to this row's crystal</button>`
    : it
    ? `This crystal uses <b>${esc(it.name)}</b> <span class="hint">(from jenis_plak)</span>`
    : `<span class="hint">The crystal for each row is picked from its <b>jenis_plak</b> in the Excel.</span>`;
}

$("tplNow").addEventListener("click", (e) => {
  if (e.target.closest("#backToRow")) { S.manual = null; show(S.row); }
});
$("sources").addEventListener("click", (e) => {
  const b = e.target.closest("[data-delfile]");
  if (b) return deleteFile(b.dataset.delfile);
  const f = e.target.closest("[data-file]");
  if (f) { openFile = openFile === f.dataset.file ? null : f.dataset.file; renderSources(); }
});
$("srcDesigns").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b) openTemplate(b.dataset.open);
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

// A new design whose 3 texts aren't linked yet: link them like the master order Excel, top to
// bottom — the event's header, the award (position), the name (event_line_1) -> designs linked
const MASTER = ["event_header", "position", "event_line_1"];
function autoLink(tpls) {
  let n = 0;
  for (const t of tpls) {
    const texts = t.texts || [];
    if (texts.length !== MASTER.length || texts.some((x) => x.field || x.angle)) continue;
    [...texts].sort((a, b) => a.top - b.top).forEach((x, i) => { x.field = MASTER[i]; });
    n++;
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
      // a saved default template (where the 3 master texts sit) stays with the same design
      for (const t of tpls) {
        const prev = old.find((o) => (o.order || 0) === (t.order || 0) && o.layout);
        if (prev) t.layout = prev.layout;
      }
      const linked = autoLink(tpls);
      if (tpls.warning) bad.push(tpls.warning);
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
        (old.length ? ` — replaced the old copy${kept ? `, kept ${kept} column link${kept === 1 ? "" : "s"}` : ""}.` : ".") +
        (linked ? ` Header, position and name fill from the Excel by themselves.` : ""));
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

// Save as default template: where this design's header, position and name sit (and how big)
// becomes its layout for every row and for the order website's preview; their font, colour and
// outline become the master look of every design. Rows changed by hand on this design start over.
$("saveDefault").onclick = async () => {
  const it = itemOf(S.key);
  if (!it || it.source !== "pdf") return toast("Pick a crystal design (.ai) first.", "bad");
  const texts = editor.objects().filter((o) => editor.isText(o) && o.data && MASTER_FIELDS.includes(o.data.field));
  if (!texts.length) return toast("This crystal has no header, position or name text to save.", "bad");
  if (!await ask(`Save this crystal's header, position and name as the default for “${it.name}”?\nTheir font, colour and outline become the master for every design.`)) return;
  const layout = { ...(it.layout || {}) }, look = { ...getMaster() };
  for (const o of texts) {
    const f = o.data.field, sy = o.scaleY || 1, size = Math.round(o.fontSize * sy * 100) / 100;
    let top = o.top, lines = String(o.text || "").split("\n").length;
    // the name was moved up for this row's extra lines (event_line_2 / 3): save it without them
    if (f === "event_line_1") {
      const extra = fieldValue(row(), f).split("\n").length - String(row().event_line_1 || "").split("\n").length;
      if (extra > 0) { top += (extra * size * (o.lineHeight || 1) * 1.13) / 2; lines -= extra; }
    }
    // as wide as it is now at least (made bigger by dragging its corner, it must stay that big),
    // and as many lines: other rows' words only shrink when they're longer or have more lines
    const wide = (o.getScaledWidth ? o.getScaledWidth() : o.width * (o.scaleX || 1)) * 1.03 + (o.strokeWidth || 0) + 1;
    layout[f] = { left: o.left, top, originX: o.originX, textAlign: o.textAlign, fontSize: size,
      maxW: Math.min(it.width, Math.max(o.data.maxW || 0, wide)), lines: Math.max(1, lines), angle: o.angle || 0, flipX: !!o.flipX };
    const family = String(o.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim();
    look[f] = { ps: o.data.ps || null, family: o.data.ps ? "" : family, bold: o.fontWeight === "bold", italic: o.fontStyle === "italic",
      fill: o.fill, stroke: o.stroke || null, strokeWidth: o.strokeWidth || 0, paintFirst: o.paintFirst || "fill",
      strokeLineJoin: o.strokeLineJoin || "miter", outerStroke: o.outerStroke || null, outerStrokeWidth: o.outerStrokeWidth || 0,
      charSpacing: o.charSpacing || 0, lineHeight: o.lineHeight || 1, scaleX: Math.round(((o.scaleX || 1) / sy) * 1000) / 1000 };
  }
  try {
    Object.assign(it, await store.saveLibrary({ id: it.id, layout }));
    setMaster(await store.saveMaster(look));
  } catch (e) { return toast(e.message, "bad"); }
  for (const k of Object.keys(S.edits)) if (k.endsWith("|" + S.key)) delete S.edits[k];
  markDirty();
  await show(S.row);
  toast(`Saved as the default for ${it.name}. The order website's preview updates by itself.`);
};

// Remove from background: while on, a click on the design takes the piece of artwork there (the
// school logo, its name, a leftover word) out of this design's background for good — on every row,
// in downloads and on the order website. "Put back" brings everything back.
let erasing = false;
function setErasing(on) {
  erasing = on;
  $("eraseBtn").setAttribute("aria-pressed", on ? "true" : "false");
  $("eraseBtn").textContent = on ? "Done removing" : "Remove from background";
  editor.pickPoint(on ? eraseAt : null);
  if (on) toast("Click the logo (or anything else on the background) to remove it. Click Done removing when finished.");
}
async function saveBackground(it, hide, note) {
  try {
    const background = await redrawBackground(it, hide);
    Object.assign(it, await store.saveLibrary({ id: it.id, hide, background }));
  } catch (e) { return toast(e.message, "bad"); }
  await show(S.row);
  if (erasing) editor.pickPoint(eraseAt);
  toast(note);
}
async function eraseAt(x, y) {
  const it = itemOf(S.key);
  if (!it || !it.original) return toast("Only designs imported from an .ai can have things removed.", "bad");
  const ops = await pieceAt(it, x, y).catch(() => null);
  if (!ops) return toast("Nothing to remove there (the plain background and the cut line stay).");
  await saveBackground(it, [...new Set([...(it.hide || []), ...ops])], "Removed. Click something else, or Done removing.");
}
$("eraseBtn").onclick = () => {
  const it = itemOf(S.key);
  if (!erasing && (!it || !it.original)) return toast("Pick a crystal design (.ai) first.", "bad");
  setErasing(!erasing);
};
$("restoreBg").onclick = async () => {
  const it = itemOf(S.key);
  if (!it || !it.original) return toast("Pick a crystal design (.ai) first.", "bad");
  if (!(it.hide || []).length) return toast("Nothing has been taken out of this design.");
  if (!await ask(`Put back everything taken out of “${it.name}” (the logo too)?`)) return;
  await saveBackground(it, [], "Everything is back. Use Remove from background to take things out again.");
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
    if (editor.isText(o) && d.field && !d.tplText) for (const r of groupRows(S.row)) setFieldValue(S.rows[r], d.field, o.text);
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
    for (const r of groupRows(S.row)) setFieldValue(S.rows[r], d.field, o.text);
    renderElementsSoon();
  },
  selection: onSelection,
  columns: columnsForUi,
  valueOf: (f) => fieldValue(row(), f),
  bound: onBound,
  dropField: (f, p) => { if (S.key) addField(f, p); },
  save: () => (unlocked ? saveDesign() : S.order ? $("saveOrder").click() : null),
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

// What the Illustrator script needs for each row: which design of which .ai, and the texts that
// differ from the template (changed words, size, colour or place; deleted; added).
async function illustratorJob(all) {
  const rows = [];
  const near = (a, b) => Math.abs(a - b) < 0.5;
  for (const r of all ? S.rows.map((_, i) => i) : [S.row]) {
    const key = r === S.row ? S.key : keyFor(r), it = itemOf(key);
    if (!it || it.source !== "pdf") continue;
    const st = r === S.row && key === S.key ? editor.currentState() : S.edits[r + "|" + key];
    const now = await editor.textsOf(st ? { state: st, images: [] } : { scene: { ...(await sceneFor(key, r)), images: [] } });
    const orig = await editor.textsOf({ scene: { ...(await libraryScene(it, {}, S.columns)), images: [] } });
    const texts = [];
    for (const n of now) {
      const o = n.src == null ? null : orig.find((x) => x.src === n.src);
      if (!o) { texts.push({ now: n }); continue; }
      const same = o.text === n.text && near(o.l, n.l) && near(o.t, n.t) && near(o.size, n.size) && o.fill === n.fill;
      if (!same) texts.push({ orig: o, now: n });
    }
    for (const o of orig) if (!now.some((n) => n.src === o.src)) texts.push({ orig: o, deleted: true });
    rows.push({ row: r + 1, file: it.file, original: it.original || null, page: it.page || 1,
      region: it.region || [0, 0, it.width, it.height], name: it.name, texts });
  }
  let folder = "";
  try { folder = (await store.folder()).folder || ""; } catch (e) {}
  return { folder, rows };
}

// Illustrator's report when it's done (passed on by Crystal Studio's window)
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "crystal-illustrator-report") toast("Illustrator: " + String(e.data.text || "").slice(0, 600));
});

// As you see it, opened in Illustrator and saved as .ai: the rows as Illustrator-ready .svg (words
// editable, artwork at print quality) go to Crystal Studio's program on this PC, which opens them
// in Illustrator. Works from the online studio too, as long as Start Studio.bat runs on this PC.
async function openInIllustrator(all) {
  // now, while it's a click: start Crystal Studio on this PC (unless it's known to run), and the window to it
  let up = false; // worked on this computer before
  try { up = localStorage.getItem("crystal-ever") === "1"; } catch (e) {}
  try { location.href = START_LINK; } catch (e) {} // does nothing if it's already running
  const bridge = illustratorWindow();
  const files = [], used = new Set();
  const rows = all ? [...new Set(S.rows.map((_, i) => canon(i)))] : [S.row];
  for (const [n, r] of rows.entries()) {
    const key = r === S.row ? S.key : keyFor(r);
    if (!itemOf(key)) continue;
    toast(`Making ${n + 1} of ${rows.length}…`);
    const sc = await sceneFor(key, r);
    if (!sc) continue;
    const st = r === S.row && key === S.key ? editor.currentState() : S.edits[r + "|" + key];
    const rw = S.rows[r] || {};
    let name = safeName([String(rw.jenis_plak || "").replace(/^\s*CRYSTAL\s*\/\s*/i, ""), rw.event_line_1 || rw.position || `row ${r + 1}`].filter(Boolean).join(" - ").replace(/\//g, "-"));
    for (let k = 2; used.has(name); k++) name = name.replace(/( \(\d+\))?$/, ` (${k})`);
    used.add(name);
    files.push({ name, key, r, item: itemOf(key), entry: st ? { state: st, images: sc.images } : { scene: sc } });
  }
  if (!files.length) { bridge.cancel(); return toast("These rows have no crystal design to open.", "bad"); }
  // made from the original .ai in Illustrator (artwork and words editable); a design without one
  // goes as .svg (the artwork as a picture)
  toast("Preparing the Illustrator files…");
  const { job, without } = await vectorJob(files.map((f) => ({ item: f.item, entry: f.entry, name: f.name })));
  const svgs = [];
  for (const i of without) {
    const f = files[i], p = await printImages(f.key, f.r);
    if (p) svgs.push({ name: f.name, svg: await editor.svgOffscreen(f.entry.state ? { state: f.entry.state, images: p.images } : { scene: { ...p.sc, images: p.images } }) });
  }
  toast(up ? "Opening in Illustrator…" : "Starting Crystal Studio on this computer… (if Chrome asks “Open …?”, choose Open and tick Always allow)");
  const r = await bridge.sendWhenUp({ job, files: svgs });
  try { if (r && !r.old) localStorage.setItem("crystal-ever", "1"); } catch (e) {}
  if (r) return toast(r.old ? r.error : r.ok ? `Illustrator is making ${files.length}… (saved as .ai in ${r.folder}) [Crystal Studio ${r.build}]` : `Couldn't open Illustrator: ${r.error || "no answer"}`, r.ok ? "" : "bad");
  bridge.cancel();
  toast(up ? "Crystal Studio didn't start. Try again." : "Crystal Studio didn't start on this computer. Download › Set up this computer for Illustrator (once), then try again.", "bad");
}

async function doExport(kind) {
  editor.closeMenus();
  if (!S.key && kind !== "setup") return toast("Nothing to download yet — pick a design first.", "bad");
  if (document.body.classList.contains("teacher") && !["png", "pdf", "pdf-all"].includes(kind)) return;
  try {
    if (kind === "pdf" || kind === "pdf-all") return await exportPdf(kind === "pdf-all");
    if (kind === "open-ai" || kind === "open-ai-all") return await openInIllustrator(kind === "open-ai-all");
    if (kind === "setup") {
      const a = document.createElement("a");
      a.href = "Crystal%20Studio%20Setup.bat";
      a.download = "Crystal Studio Setup.bat";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return toast("Double-click the downloaded file once (Windows may warn: More info › Run anyway). Then Open in Illustrator works on this computer.");
    }
    const name = safeName(S.design.name) + (S.rows.length > 1 ? ` - row ${S.row + 1}` : "");
    if (kind === "ai" || kind === "ai-all") {
      toast("Making the Illustrator script…");
      const job = await illustratorJob(kind === "ai-all");
      if (!job.rows.length) return toast("These rows' designs aren't from an .ai / .pdf file, so there's nothing to open in Illustrator.", "bad");
      // server.js opens Illustrator and runs it; the .ai files are saved in the studio's output folder
      const r = await fetch("/api/illustrator", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(job) })
        .then((x) => x.json()).catch(() => ({}));
      if (r.ok) {
        toast(`Opening Illustrator… ${job.rows.length <= 5 ? "The .ai file" + (job.rows.length > 1 ? "s" : "") + " will open there" : "The .ai files are being made"} (saved in ${r.folder}).`);
        return;
      }
      const file = safeName(S.design.name) + (kind === "ai-all" ? " - every row" : ` - row ${S.row + 1}`) + ".jsx";
      downloadBlob(new Blob([illustratorScript(job)], { type: "text/plain" }), file);
      toast("In Illustrator: File › Scripts › Other Script… and pick the .jsx — it makes one vector .ai per row.");
      return;
    }
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
  // not named yet: call it after the Excel it came from
  if (S.design.name === "Untitled design" && S.sourceName) {
    S.design.name = S.sourceName.replace(/\.(xlsx|xlsm|xls|csv|txt)$/i, "");
    $("designName").value = S.design.name;
  }
  const data = { v: 2, columns: S.columns, rows: S.rows, row: S.row, rowTpl: S.rowTpl, edits: S.edits, lastKey: S.lastKey, source: S.source, sourceName: S.sourceName, sheet: S.sheet };
  let thumb = "";
  if (S.key) { try { thumb = editor.exportImage((72 * 240) / Math.max(1, editor.docSize().w), "png"); } catch (e) {} } // png: the artboard is see-through
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
  toast(`Opened “${d.name}”: ${S.rows.length} row${S.rows.length === 1 ? "" : "s"}${S.sourceName ? " from " + S.sourceName : ""}.`);
  await show(S.row);
}

async function openDialog() {
  $("openList").innerHTML = '<p class="hint">Loading…</p>';
  $("openDlg").showModal();
  let list = [];
  try { list = await store.listDesigns(); } catch (err) { $("openList").innerHTML = `<p class="bad">${esc(err.message)}</p>`; return; }
  list = list.filter((d) => !String(d.id).startsWith("order-")); // an order's own designs: opened from the website instead
  $("openList").innerHTML = list.map((d) => `<div class="drow">
      <button class="dopen" data-open="${esc(d.id)}">${d.thumb ? `<img alt="" src="${d.thumb}">` : '<span class="nothumb"></span>'}
        <span><b>${esc(d.name)}</b><small>${d.source ? "Excel: " + esc(d.source) + " · " : ""}${d.rows} row${d.rows === 1 ? "" : "s"}${d.changed ? ` · ${d.changed} changed by hand` : ""}</small>` +
        `<small>Saved ${new Date(d.updated).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</small></span></button>
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
// opened from an order on the website: the crystals changed here can be kept for that order only
// (the website's preview then shows them; every other order keeps the default template). They're
// kept by what each crystal says (jenis plak + words) as it came from the website.
async function orderCustom() {
  try { const d = await store.loadDesign(orderDesignId(S.order)); return (d && d.data && d.data.custom) || {}; } catch (e) { return {}; }
}
$("saveOrder").onclick = async () => {
  if (!S.order) return;
  const custom = await orderCustom();
  for (const k of S.origKeys) delete custom[k]; // these crystals: as they are here now
  let n = 0;
  for (const [k, st] of Object.entries(S.edits)) {
    const i = k.indexOf("|"), r = +k.slice(0, i), key = k.slice(i + 1);
    if (S.origKeys[r] == null || key !== keyFor(r)) continue; // only the design the row's jenis plak picks
    custom[S.origKeys[r]] = st;
    n++;
  }
  $("saveOrder").disabled = true;
  try {
    await store.saveDesign({ id: orderDesignId(S.order), name: `Order ${S.order} — its own crystals`, data: { order: S.order, custom } });
    S.dirty = false;
    toast(n ? `Saved ${n} crystal${n === 1 ? "" : "s"} for order ${S.order} only. Back to the website…`
      : `Order ${S.order} uses the default template again. Back to the website…`);
    // back to the order on the website (this tab was opened by its ✎ Edit; its preview already shows it)
    setTimeout(() => {
      window.close();
      setTimeout(() => toast("Saved. Switch back to the order website's tab: its Crystal Preview already shows it."), 400);
    }, 1200);
  } catch (e) { toast("Couldn't save: " + e.message, "bad"); }
  $("saveOrder").disabled = false;
};

$("backToOrder").onclick = async () => {
  if (S.dirty && !await ask("Changes made only on these rows (not saved as the default template) will be lost. Go back?")) return;
  S.dirty = false;
  window.close(); // works for the tab the website opened
  setTimeout(() => toast("Switch back to the order website's tab: its Crystal Preview already shows what you saved."), 300);
};
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
  try { setFontFiles(await store.fontFiles()); } catch (e) {}
  // the template folder is on this PC: only there when the studio runs from server.js
  if (!(await store.hasLocal())) $("folderBtn").hidden = true;
  try { setMaster(await store.master()); } catch (e) {}
  try { S.library = await store.listLibrary(); } catch (e) { S.library = []; toast(e.message, "bad"); }
  // designs imported before the logo clean-up: cleaned once now (and saved)
  if (S.library.some((it) => it.source === "pdf" && it.original && !it.cleaned)) {
    toast("Taking the school logos out of older designs (only this once)…");
    const n = await autoCleanAll(S.library, store.saveLibrary);
    if (n) toast(`Cleaned ${n} older design${n === 1 ? "" : "s"}. Use Remove from background for anything left.`);
  }
  S.source = sources()[0] ? sources()[0].file : null;
  // opened from the order website's crystal preview (✎ Edit): start with that order's rows
  let opened = null;
  if (location.hash.startsWith("#order=")) {
    try { opened = JSON.parse(decodeURIComponent(location.hash.slice(7))); } catch (e) {}
    // opened from the order website (✎ Edit, a new tab): a way back to it
    $("backToOrder").hidden = false;
    history.replaceState(null, "", location.pathname);
  }
  if (opened && Array.isArray(opened.rows) && opened.rows.length) {
    const keys = [...new Set(opened.rows.flatMap((r) => Object.keys(r)))];
    S.columns = keys.map((k) => ({ key: k, label: k }));
    S.rows = opened.rows.map((r) => Object.fromEntries(keys.map((k) => [k, String(r[k] ?? "")])));
    S.sourceName = opened.name || "Order";
    S.order = opened.order != null && opened.order !== "" ? String(opened.order) : null;
    // a teacher (from their order page): changes this order's crystals only — no Illustrator, no Admin
    if (opened.role === "teacher") { document.body.classList.add("teacher"); unlocked = false; setAdmin(false); }
    S.origKeys = S.rows.map(contentKey);
    $("srcHint").textContent = `${S.sourceName} · ${S.rows.length} row${S.rows.length === 1 ? "" : "s"} from the order website`;
  }
  buildGroups();
  if (S.order) {
    $("saveOrder").hidden = false;
    $("srcHint").textContent += ` · order ${S.order}`;
    // what was already changed for this order comes back, to change further
    const custom = await orderCustom();
    S.rows.forEach((r, i) => { const k = keyFor(i), st = custom[S.origKeys[i]]; if (k && st) S.edits[i + "|" + k] = st; });
  }
  await show(0);
})();