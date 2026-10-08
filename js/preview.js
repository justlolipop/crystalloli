// Crystal preview: shown in a frame by another website (the order system's Production page).
// That page posts { type: "crystal-rows", rows: [{ event_header, position, event_line_1, …,
// jenis_plak }] }; each row is drawn on the Crystal Studio design its jenis_plak names, with the
// texts filled from the row, exactly as the editor would. Identical rows are drawn once, with a count.
// This page tells the website "crystal-studio-ready" when it can draw, and "crystal-studio-height"
// whenever its height changes, so the frame can grow to fit.

import { esc } from "./util.js";
import { setFontList } from "./fonts.js";
import { store } from "./store.js";
import { libraryScene } from "./library.js";
import { renderOffscreen } from "./editor.js";
import { templateFor } from "./jenis.js";

const DPI = 72;       // small pictures: enough to read the words, quick to draw
const MAX_TILES = 40; // per jenis plak; more distinct rows than this are counted, not drawn
const TEXT_FIELDS = ["event_header", "year", "position", "event_line_1", "event_line_2", "event_line_3"];

const out = document.getElementById("out");
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.dataset.theme = "dark";

const tell = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, "*"); };
new ResizeObserver(() => tell({ type: "crystal-studio-height", height: document.documentElement.scrollHeight }))
  .observe(document.body);

let library = [];
let job = 0;

document.getElementById("flip").onchange = (e) => {
  for (const t of document.querySelectorAll(".tile.mirrored")) t.classList.toggle("flip", e.target.checked);
};

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

async function show(rows) {
  const my = ++job;
  const groups = groupRows(rows || []);
  if (!groups.length) {
    out.innerHTML = `<p class="msg">This order has no crystal.</p>`;
    return;
  }
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((k) => ({ key: k, label: k }));
  out.innerHTML = groups.map((g, gi) => {
    const it = templateFor(library, g.jenis);
    const count = g.tiles.reduce((n, t) => n + t.qty, 0);
    const sub = it
      ? `${esc(it.name)} · ${count} keping, ${g.tiles.length} different`
      : `<span>No Crystal Studio design for this yet — import its .ai in Crystal Studio.</span>`;
    const tiles = it ? g.tiles.slice(0, MAX_TILES).map((t, ti) =>
      `<div class="tile" id="t${gi}-${ti}"><div class="pic">…</div><div class="cap"><span class="qty">×${t.qty}</span>${esc(caption(t.row))}</div></div>`).join("") : "";
    const more = it && g.tiles.length > MAX_TILES ? `<p class="msg">…and ${g.tiles.length - MAX_TILES} more.</p>` : "";
    return `<div class="group"><h3>${esc(g.jenis)}</h3><div class="sub${it ? "" : " warn"}">${sub}</div><div class="tiles">${tiles}</div>${more}</div>`;
  }).join("");

  let mirrored = false;
  for (const [gi, g] of groups.entries()) {
    const it = templateFor(library, g.jenis);
    if (!it) continue;
    const flipped = (it.texts || []).some((t) => t.flipX);
    mirrored = mirrored || flipped;
    for (const [ti, t] of g.tiles.slice(0, MAX_TILES).entries()) {
      if (my !== job) return; // a newer order arrived
      const el = document.getElementById(`t${gi}-${ti}`);
      try {
        const scene = await libraryScene(it, t.row, columns);
        const { url } = await renderOffscreen({ scene }, DPI);
        el.querySelector(".pic").innerHTML = `<img alt="" src="${url}">`;
        if (flipped) el.classList.add("mirrored");
      } catch (e) {
        el.querySelector(".pic").textContent = "Couldn't draw this one";
      }
    }
  }
  document.getElementById("bar").hidden = !mirrored;
}

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || !e.data || e.data.type !== "crystal-rows") return;
  show(Array.isArray(e.data.rows) ? e.data.rows : []);
});

(async () => {
  try { setFontList(await store.fonts()); } catch (e) {}
  try { library = await store.listLibrary(); } catch (e) {
    out.innerHTML = `<p class="msg">Couldn't read the Crystal Studio designs (${esc(e.message)}).</p>`;
  }
  tell({ type: "crystal-studio-ready" });
})();
