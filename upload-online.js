// Copies what Crystal Studio kept on this PC into the online database (js/config.js), once:
//
//   node upload-online.js
//
// It uploads: the imported designs (library\, with their pictures and .ai copies), the master
// template (master.json), saved designs (designs\), this PC's font list, and any font files you
// put in a "webfonts" folder next to this file (name each one by its PostScript name, e.g.
// BritannicBold.ttf, Teko-Bold.ttf, Playball-Regular.ttf) so computers without them still show
// the right fonts. Running it again just updates what's online. Nothing on this PC is changed.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SUPABASE_URL, SUPABASE_KEY } from "./js/config.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KEY = String(SUPABASE_KEY || "").trim(), BASE = String(SUPABASE_URL || "").replace(/\/+$/, "");
const MAX_FILE = 50e6;
if (!KEY || !BASE) { console.log("Put the Supabase URL and publishable key in js/config.js first."); process.exit(1); }
if (/^sb_secret_/.test(KEY)) { console.log("js/config.js has a SECRET key. Use the publishable one."); process.exit(1); }
const auth = KEY.startsWith("sb_") ? { apikey: KEY } : { apikey: KEY, Authorization: "Bearer " + KEY };

async function call(p, method, body, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...auth, ...headers }, body });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
}
const upsert = (table, row) => call(`/rest/v1/${table}`, "POST", JSON.stringify(row),
  { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" });
async function putFile(rel, file, type) {
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_FILE) throw new Error(`too big to keep online (${Math.round(buf.length / 1e6)} MB, limit 50 MB)`);
  await call(`/storage/v1/object/crystal/${rel}`, "POST", buf, { "Content-Type": type, "x-upsert": "true" });
}
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch (e) { return fallback; } };
const now = () => new Date().toISOString();
let ok = 0, bad = 0;
const fail = (what, e) => { bad++; console.log("  ✗ " + what + ": " + e.message); };

// imported designs
const LIB = path.join(DIR, "library");
const items = fs.existsSync(LIB) ? fs.readdirSync(LIB).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(LIB, f), null)).filter(Boolean) : [];
console.log(`Designs: ${items.length}`);
const originals = new Map(); // a .ai copy is shared by the designs of one file: uploaded once
for (const it of items) {
  try {
    if (it.background && fs.existsSync(path.join(DIR, it.background))) {
      await putFile(it.background, path.join(DIR, it.background), it.background.endsWith(".png") ? "image/png" : "image/jpeg");
    }
    if (it.original) {
      if (!originals.has(it.original)) {
        const f = path.join(DIR, it.original);
        originals.set(it.original, fs.existsSync(f) ? putFile(it.original, f, "application/pdf").then(() => true, (e) => {
          console.log(`  ! ${it.file}: its .ai copy wasn't uploaded (${e.message}); the design works, without full-quality downloads`);
          return false;
        }) : Promise.resolve(false));
      }
      if (!(await originals.get(it.original))) it.original = null;
    }
    await upsert("crystal_library", { id: it.id, item: it, updated_at: now() });
    ok++;
    console.log("  ✓ " + it.name);
  } catch (e) { fail(it.name || it.id, e); }
}

// the master template
const master = readJson(path.join(DIR, "master.json"), null);
if (master) {
  try { await upsert("crystal_settings", { key: "master", value: master, updated_at: now() }); ok++; console.log("Master template ✓"); } catch (e) { fail("master template", e); }
}

// this PC's font names (for the font box on computers without the list)
const cfg = readJson(path.join(DIR, "studio.config.json"), {});
const fontsFile = path.resolve(DIR, cfg.fontsFile || path.join("..", "webapp", "templates", "_fonts.json"));
const fonts = readJson(fontsFile, null);
if (Array.isArray(fonts) && fonts.length) {
  try { await upsert("crystal_settings", { key: "fonts", value: fonts, updated_at: now() }); ok++; console.log(`Font list (${fonts.length}) ✓`); } catch (e) { fail("font list", e); }
}

// font files
const WF = path.join(DIR, "webfonts");
if (fs.existsSync(WF)) {
  const TYPES = { ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2" };
  for (const f of fs.readdirSync(WF).filter((f) => TYPES[path.extname(f).toLowerCase()])) {
    try { await putFile("fonts/" + f, path.join(WF, f), TYPES[path.extname(f).toLowerCase()]); ok++; console.log("Font " + f + " ✓"); } catch (e) { fail("font " + f, e); }
  }
}

// saved designs
const DD = path.join(DIR, "designs");
if (fs.existsSync(DD)) {
  for (const f of fs.readdirSync(DD).filter((f) => f.endsWith(".meta.json"))) {
    const meta = readJson(path.join(DD, f), null), design = meta && readJson(path.join(DD, meta.id + ".json"), null);
    if (!design) continue;
    try { await upsert("crystal_designs", { id: meta.id, meta, design, updated_at: new Date(meta.updated || Date.now()).toISOString() }); ok++; console.log("Saved design " + meta.name + " ✓"); } catch (e) { fail("saved design " + meta.name, e); }
  }
}

console.log(`\nDone: ${ok} uploaded${bad ? `, ${bad} failed (see ✗ above)` : ""}.`);
