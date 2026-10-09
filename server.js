// Crystal Studio — local server. Plain Node, no npm install needed.
//
//   node server.js        then open http://localhost:5190
//
// It serves the editor page and gives it:
//   /api/folder    the .ai / .pdf / .svg files in your template folder (set it in the page, or in
//                  studio.config.json) so a template can be imported with one click
//   /api/library   templates imported into the studio (library\): each design's preview picture,
//                  its editable texts, and the original file (for full-resolution downloads)
//   /api/designs   saved designs (designs\). Later this can move to an online database;
//                  only js/store.js and this file need to change for that.
//   /api/fonts     the fonts installed on this PC (list written by Illustrator, if available)
//
// It only listens on this PC (127.0.0.1), so nobody else on the network can reach it.

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { illustratorScript } from './js/illustrator.js';
import { mergeItem, designMeta, ID_RE, newId } from './js/libitem.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const PORT = +process.env.STUDIO_PORT || 5190;
const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, "studio.config.json");
const DESIGNS_DIR = path.join(APP_DIR, "designs");
const LIBRARY_DIR = path.join(APP_DIR, "library");
const MASTER_FILE = path.join(APP_DIR, "master.json");
const OUTPUT_DIR = path.join(APP_DIR, "output"); // .ai files made in Illustrator, one folder per run
for (const d of [DESIGNS_DIR, LIBRARY_DIR]) fs.mkdirSync(d, { recursive: true });

const TEMPLATE_EXT = /\.(ai|pdf|svg)$/i;
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".ai": "application/pdf", ".ico": "image/x-icon", ".bat": "application/octet-stream",
};


function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^/, "")); } catch (e) { return fallback; }
}
function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj)); }

// ---------------------------------------------------------------- settings

function config() {
  const c = readJson(CONFIG_FILE, {});
  return {
    templateFolder: c.templateFolder || "",
    fontsFile: path.resolve(APP_DIR, c.fontsFile || path.join("..", "webapp", "templates", "_fonts.json")),
  };
}

function saveConfig(patch) {
  const c = { ...readJson(CONFIG_FILE, {}), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  return config();
}

// ---------------------------------------------------------------- template folder

function folderList() {
  const { templateFolder } = config();
  if (!templateFolder) return { folder: "", files: [] };
  try {
    const files = fs.readdirSync(templateFolder, { withFileTypes: true })
      .filter((d) => d.isFile() && TEMPLATE_EXT.test(d.name) && !d.name.startsWith("~"))
      .map((d) => {
        const st = fs.statSync(path.join(templateFolder, d.name));
        return { name: d.name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { folder: templateFolder, files };
  } catch (e) {
    return { folder: templateFolder, files: [], error: "Can't open that folder: " + e.message };
  }
}

function sendFolderFile(res, name) {
  const { templateFolder } = config();
  if (!templateFolder || !name || name !== path.basename(name) || !TEMPLATE_EXT.test(name)) return send(res, 400, { error: "Bad file name" });
  return sendFile(res, templateFolder, name);
}

// ---------------------------------------------------------------- library (imported templates)

function libraryList() {
  return fs.readdirSync(LIBRARY_DIR).filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(LIBRARY_DIR, f), null)).filter(Boolean)
    .sort((a, b) => (a.created || 0) - (b.created || 0) || (a.order || 0) - (b.order || 0));
}

function librarySave(body) {
  const id = body.id && ID_RE.test(body.id) ? body.id : newId();
  const file = path.join(LIBRARY_DIR, id + ".json");
  const item = mergeItem(readJson(file, {}), body, id);
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body.background || "");
  if (m) {
    const name = id + (m[1] === "png" ? ".png" : ".jpg");
    fs.writeFileSync(path.join(LIBRARY_DIR, name), Buffer.from(m[2], "base64"));
    item.background = "library/" + name;
  }
  writeJson(file, item);
  return item;
}

function libraryDelete(id) {
  const item = readJson(path.join(LIBRARY_DIR, id + ".json"), {});
  for (const ext of [".json", ".png", ".jpg"]) {
    const f = path.join(LIBRARY_DIR, id + ext);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  if (item.original && !libraryList().some((x) => x.original === item.original)) {
    const f = path.join(APP_DIR, item.original);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

async function saveOriginal(req) {
  const buf = await readRaw(req, 400e6);
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") throw new Error("This .ai wasn't saved with “Create PDF Compatible File”.");
  const rel = "library/orig-" + newId() + ".pdf";
  fs.writeFileSync(path.join(APP_DIR, rel), buf);
  return { path: rel };
}

// ---------------------------------------------------------------- designs

function designList() {
  return fs.readdirSync(DESIGNS_DIR).filter((f) => f.endsWith(".meta.json"))
    .map((f) => readJson(path.join(DESIGNS_DIR, f), null)).filter(Boolean)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

function designSave(body) {
  const id = body.id && ID_RE.test(body.id) ? body.id : newId();
  const old = readJson(path.join(DESIGNS_DIR, id + ".meta.json"), {});
  const now = Date.now();
  const name = String(body.name || "Untitled design").slice(0, 160);
  const data = body.data || {};
  writeJson(path.join(DESIGNS_DIR, id + ".json"), { id, name, created: old.created || now, updated: now, data });
  const thumb = /^data:image\/(png|jpeg);base64,/.test(body.thumb || "") && body.thumb.length < 400000 ? body.thumb : old.thumb || "";
  writeJson(path.join(DESIGNS_DIR, id + ".meta.json"), designMeta(id, name, old.created || now, now, data, thumb));
  return { id, updated: now };
}

function designDelete(id) {
  for (const ext of [".json", ".meta.json"]) {
    const f = path.join(DESIGNS_DIR, id + ext);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ---------------------------------------------------------------- http

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`That's too big (over ${Math.round(limit / 1e6)} MB).`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req) {
  const buf = await readRaw(req, 120e6);
  return buf.length ? JSON.parse(buf.toString("utf8")) : {};
}

function send(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(obj));
}

function sendFile(res, baseDir, rel) {
  const full = path.resolve(baseDir, rel);
  if (!full.startsWith(path.resolve(baseDir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, { error: "Not found" });
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------- Illustrator

// Illustrator on this PC: "illustratorPath" in studio.config.json, or the newest one installed
function illustratorExe() {
  const set = readJson(CONFIG_FILE, {}).illustratorPath;
  if (set && fs.existsSync(set)) return set;
  const year = (d) => +((/\d{4}/.exec(d) || [0])[0]);
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(root, "Adobe")).filter((d) => /^Adobe Illustrator/i.test(d)); } catch (e) {}
    for (const d of dirs.sort((a, b) => year(b) - year(a))) {
      const exe = path.join(root, "Adobe", d, "Support Files", "Contents", "Windows", "Illustrator.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// Opens Illustrator with the studio's script, which makes one .ai per row from the original
// templates. The page only sends the rows' words and places; the script itself is this
// program's own, and the templates come from the template folder set here.
// the online database's copy of an imported .ai (js/store.js fileUrl), for a design the studio
// imported on another computer
const ONLINE_ORIGINAL = /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/crystal\/library\/orig-[a-z0-9-]+\.pdf$/;

async function runInIllustrator(body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, error: "Nothing to make." };
  if (rows.some((r) => !r || typeof r.file !== "string" || !TEMPLATE_EXT.test(r.file) || /[\\/]/.test(r.file))) {
    return { ok: false, error: "Bad template name." };
  }
  const d = new Date(), two = (n) => String(n).padStart(2, "0"); // this PC's own clock
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  const outDir = path.join(OUTPUT_DIR, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  // open the exact .ai each design was imported from (the studio keeps a copy of it, here or in the
  // online database), not a file of the same name in the template folder, which may be another version
  const copies = new Map();
  for (const r of rows) {
    const rel = typeof r.original === "string" && /^library\/orig-[a-z0-9-]+\.pdf$/.test(r.original) ? r.original : null;
    const local = rel ? path.join(APP_DIR, rel) : null;
    const url = typeof r.originalUrl === "string" && ONLINE_ORIGINAL.test(r.originalUrl) ? r.originalUrl : null;
    delete r.path;
    const key = rel || url;
    if (!key) continue;
    if (!copies.has(key)) {
      const dir = path.join(outDir, "_templates");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, path.basename(key, ".pdf").replace(/^orig-/, "") + " - " + r.file.replace(/\.(pdf|svg)$/i, ".ai"));
      try {
        if (local && fs.existsSync(local)) fs.copyFileSync(local, dest);
        else if (url) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(res.status + " " + res.statusText);
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        } else throw new Error("not found");
        copies.set(key, dest);
      } catch (e) { copies.set(key, null); }
    }
    if (copies.get(key)) r.path = copies.get(key);
    // pictures added in the studio: saved next to the files, for Illustrator to place
    if (Array.isArray(r.images)) {
      r.images = r.images.map((im, i) => {
        const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/.exec((im && im.src) || "");
        if (!m) return null;
        const dir = path.join(outDir, "_images");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${two(r.row)}-${i + 1}.${m[1] === "jpeg" ? "jpg" : m[1]}`);
        fs.writeFileSync(file, Buffer.from(m[2], "base64"));
        return { path: file, l: +im.l, t: +im.t, r: +im.r, b: +im.b, w: +im.w || +im.r - +im.l, h: +im.h || +im.b - +im.t, angle: +im.angle || 0, flipX: !!im.flipX };
      }).filter(Boolean);
    }
  }
  const job = { folder: config().templateFolder, outDir, keepOpen: rows.length <= 5, outline: body.outline !== false && !rows.some((r) => r.master), rows };
  const jsx = path.join(outDir, "_make.jsx");
  fs.writeFileSync(jsx, illustratorScript(job));
  const exe = illustratorExe();
  if (!exe) return { ok: false, error: "Illustrator wasn't found on this PC.", folder: outDir };
  try { spawn(exe, [jsx], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch (e) { return { ok: false, error: "Couldn't start Illustrator: " + e.message, folder: outDir }; }
  try { spawn(process.platform === "win32" ? "explorer" : "open", [outDir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch (e) {}
  return { ok: true, folder: outDir };
}

// The online Crystal Studio (and the order website's preview, which is part of it) may ask this PC to
// open its crystals in Illustrator. Only these pages: this PC's own studio, and the online one
// ("studioOrigins" in studio.config.json to add another, e.g. a custom domain).
const ONLINE_STUDIO = ["https://justlolipop.github.io"];
// what the website may ask this PC for: 2 = crystals made from their original .ai (POST /api/illustrator
// with master rows). Older copies only knew .svg files; the website says so then.
const BRIDGE_VERSION = 2;
const BUILD = "2026-10-09e"; // shown on the website, to tell which Crystal Studio answered
function allowedOrigin(o) {
  if (!o) return true; // not from a web page
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o)) return true;
  const extra = readJson(CONFIG_FILE, {}).studioOrigins;
  return [...ONLINE_STUDIO, ...(Array.isArray(extra) ? extra : [])].includes(o);
}
function corsHeaders(req) {
  const o = req.headers.origin;
  return o && allowedOrigin(o) ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", Vary: "Origin" } : {};
}

// The crystals as Illustrator-ready .svg (made by the page, words still editable) -> saved in
// output\<date time>\, then Illustrator opens each one and saves it as .ai next to it. The first
// few stay open; the folder opens too.
function openSvgsInIllustrator(body) {
  const files = (Array.isArray(body.files) ? body.files : []).filter((f) => f && typeof f.name === "string" && typeof f.svg === "string" && /^\s*(<\?xml|<svg)/.test(f.svg));
  if (!files.length) return { ok: false, error: "Nothing to open." };
  const d = new Date(), two = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  const outDir = path.join(OUTPUT_DIR, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const used = new Set(), paths = [];
  for (const f of files) {
    let name = f.name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "crystal";
    for (let k = 2; used.has(name.toLowerCase()); k++) name = name.replace(/( \(\d+\))?$/, ` (${k})`);
    used.add(name.toLowerCase());
    const p = path.join(outDir, name + ".svg");
    fs.writeFileSync(p, f.svg);
    paths.push(p);
  }
  const keepOpen = 5;
  const jsx = `#target illustrator
app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
var files = ${JSON.stringify(paths.map((p) => p.replace(/\\/g, "/")))};
for (var i = 0; i < files.length; i++) {
  try {
    var doc = app.open(new File(files[i]));
    doc.saveAs(new File(files[i].replace(/\\.svg$/i, ".ai")), new IllustratorSaveOptions());
    if (i >= ${keepOpen}) doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (e) {}
}
app.userInteractionLevel = UserInteractionLevel.DISPLAYALERTS;
`;
  const script = path.join(outDir, "_open.jsx");
  fs.writeFileSync(script, jsx);
  const exe = illustratorExe();
  // (a program that can't be started reports it later, as an "error": caught, or it would stop Crystal Studio)
  try { spawn(process.platform === "win32" ? "explorer" : "open", [outDir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch (e) {}
  if (!exe) return { ok: false, error: "Illustrator wasn't found on this PC. The .svg files are in " + outDir, folder: outDir };
  try { spawn(exe, [script], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch (e) { return { ok: false, error: "Couldn't start Illustrator: " + e.message, folder: outDir }; }
  return { ok: true, folder: outDir, count: paths.length };
}

// Handler function for native HTTP requests
async function handleNativeRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, { error: "Bad path" }); }
  const m = req.method;
  try {
    if (p === "/api/fonts" && m === "GET") return send(res, 200, readJson(config().fontsFile, []));

    // what Illustrator reported when it finished (the script writes it): for Crystal Studio's window
    if (p === "/api/illustrator/result" && m === "GET") {
      const dir = url.searchParams.get("folder") || "";
      const full = path.resolve(dir);
      if (!full.startsWith(path.resolve(OUTPUT_DIR) + path.sep)) return send(res, 400, { error: "Bad folder" });
      const f = path.join(full, "_result.txt");
      return send(res, 200, fs.existsSync(f) ? { done: true, text: fs.readFileSync(f, "utf8") } : { done: false });
    }
    if (p === "/api/illustrator/svgs") {
      if (!allowedOrigin(req.headers.origin)) return send(res, 403, { error: "Not allowed" });
      if (m === "OPTIONS") { res.writeHead(204, corsHeaders(req)); return res.end(); }
      // "is Crystal Studio running on this PC?" — and which pages may send it crystals
      if (m === "GET") {
        const extra = readJson(CONFIG_FILE, {}).studioOrigins;
        return send(res, 200, { ok: true, v: BRIDGE_VERSION, build: BUILD, origins: [...ONLINE_STUDIO, ...(Array.isArray(extra) ? extra : [])] }, corsHeaders(req));
      }
      if (m === "POST") return send(res, 200, openSvgsInIllustrator(await readBody(req)), corsHeaders(req));
    }

    if (p === "/api/illustrator" && m === "POST") {
      // only this studio's own page may start Illustrator (not another website open in the browser)
      const o = req.headers.origin;
      if (o && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o)) return send(res, 403, { error: "Not allowed" });
      return send(res, 200, await runInIllustrator(await readBody(req)));
    }

    if (p === "/api/folder") {
      if (m === "GET") return send(res, 200, folderList());
      if (m === "POST") {
        const b = await readBody(req);
        saveConfig({ templateFolder: String(b.folder || "").trim() });
        return send(res, 200, folderList());
      }
    }
    if (p === "/api/folder/file" && m === "GET") return sendFolderFile(res, url.searchParams.get("name") || "");

    // the master template's look of the 3 texts (header, position, name), shared by every design
    if (p === "/api/master") {
      if (m === "GET") return send(res, 200, readJson(MASTER_FILE, {}));
      if (m === "POST") {
        const b = await readBody(req);
        writeJson(MASTER_FILE, b && typeof b === "object" && !Array.isArray(b) ? b : {});
        return send(res, 200, readJson(MASTER_FILE, {}));
      }
    }
    if (p === "/api/library") {
      if (m === "GET") return send(res, 200, libraryList());
      if (m === "POST") return send(res, 200, librarySave(await readBody(req)));
    }
    if (p === "/api/library/original" && m === "POST") return send(res, 200, await saveOriginal(req));
    let r = /^\/api\/library\/([a-z0-9-]+)$/.exec(p);
    if (r && ID_RE.test(r[1]) && m === "DELETE") { libraryDelete(r[1]); return send(res, 200, { ok: true }); }

    if (p === "/api/designs") {
      if (m === "GET") return send(res, 200, designList());
      if (m === "POST") return send(res, 200, designSave(await readBody(req)));
    }
    r = /^\/api\/designs\/([a-z0-9-]+)$/.exec(p);
    if (r && ID_RE.test(r[1])) {
      if (m === "GET") {
        const d = readJson(path.join(DESIGNS_DIR, r[1] + ".json"), null);
        return d ? send(res, 200, d) : send(res, 404, { error: "Design not found" });
      }
      if (m === "DELETE") { designDelete(r[1]); return send(res, 200, { ok: true }); }
    }

    if (m !== "GET") return send(res, 405, { error: "Method not allowed" });
    if (p.startsWith("/library/")) return sendFile(res, LIBRARY_DIR, p.slice(9));
    if (p === "/" || p === "/index.html") return sendFile(res, APP_DIR, "index.html");
    // the designs only, for another website to show (see js/preview.js)
    if (p === "/preview.html") return sendFile(res, APP_DIR, "preview.html");
    // the small window that takes crystals from the online studio / order website to Illustrator
    if (p === "/illustrator.html") return sendFile(res, APP_DIR, "illustrator.html");
    if (p === "/Crystal Studio Setup.bat") return sendFile(res, APP_DIR, "Crystal Studio Setup.bat");
    if (p === "/app.css" || p.startsWith("/js/")) return sendFile(res, APP_DIR, p.slice(1));
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
}

// ---------------------------------------------------------------- start

const server = http.createServer(handleNativeRequest);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Crystal Studio running: http://localhost:${PORT}`);
  const f = folderList();
  console.log(f.folder ? `Template folder: ${f.folder} (${f.files.length} files)` : "Template folder: not set yet (set it in the page)");
});