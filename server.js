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

import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });

const PORT = +process.env.STUDIO_PORT || 5190;
const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, "studio.config.json");
const DESIGNS_DIR = path.join(APP_DIR, "designs");
const LIBRARY_DIR = path.join(APP_DIR, "library");
for (const d of [DESIGNS_DIR, LIBRARY_DIR]) fs.mkdirSync(d, { recursive: true });

const ID_RE = /^[a-z0-9][a-z0-9-]{3,40}$/;
const TEMPLATE_EXT = /\.(ai|pdf|svg)$/i;
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".ai": "application/pdf", ".ico": "image/x-icon",
};

const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

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
  const old = readJson(file, {});
  const pick = (k, fallback) => (body[k] !== undefined ? body[k] : old[k] !== undefined ? old[k] : fallback);
  const item = {
    id,
    name: String(pick("name", "Imported")).slice(0, 160),
    file: String(pick("file", "")).slice(0, 260),
    page: +pick("page", 1) || 1,
    order: +pick("order", 0) || 0,
    source: pick("source", "pdf") === "svg" ? "svg" : "pdf",
    width: +pick("width", 600) || 600,
    height: +pick("height", 400) || 400,
    region: Array.isArray(pick("region", null)) ? pick("region", null).map(Number) : null,
    original: /^library\/orig-[a-z0-9-]+\.pdf$/.test(pick("original", "")) ? pick("original", "") : null,
    texts: Array.isArray(pick("texts", [])) ? pick("texts", []) : [],
    svg: typeof pick("svg", null) === "string" ? pick("svg", null) : undefined,
    background: old.background,
    created: old.created || +body.created || Date.now(),
    updated: Date.now(),
  };
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
  writeJson(path.join(DESIGNS_DIR, id + ".meta.json"),
    { id, name, created: old.created || now, updated: now, rows: Array.isArray(data.rows) ? data.rows.length : 0, thumb });
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

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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

// Handler function for native HTTP requests
async function handleNativeRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, { error: "Bad path" }); }
  const m = req.method;
  try {
    if (p === "/api/fonts" && m === "GET") return send(res, 200, readJson(config().fontsFile, []));

    if (p === "/api/folder") {
      if (m === "GET") return send(res, 200, folderList());
      if (m === "POST") {
        const b = await readBody(req);
        saveConfig({ templateFolder: String(b.folder || "").trim() });
        return send(res, 200, folderList());
      }
    }
    if (p === "/api/folder/file" && m === "GET") return sendFolderFile(res, url.searchParams.get("name") || "");

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
    if (p === "/app.css" || p.startsWith("/js/")) return sendFile(res, APP_DIR, p.slice(1));
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
}

// ---------------------------------------------------------------- express routes

// Route handler for converting vector AI/PDF to SVG using Inkscape
app.post('/api/convert-ai', upload.single('aiFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  const inputPath = req.file.path;
  const outputPath = `${inputPath}.svg`;
 // Updated line (using full path to Inkscape):
  const inkscapeExe = `"C:\\Program Files\\WindowsApps\\25415Inkscape.Inkscape_1.4.40.0_x64__9waqn51p1ttv2\\VFS\\ProgramFilesX64\\Inkscape\\bin\\inkscape.exe"`;
  const command = `${inkscapeExe} "${inputPath}" --export-filename="${outputPath}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      return res.status(500).json({ success: false, error: 'Inkscape conversion failed.' });
    }

    fs.readFile(outputPath, 'utf8', (err, svgData) => {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

      if (err) {
        return res.status(500).json({ success: false, error: 'Failed to read converted SVG.' });
      }

      res.json({ success: true, svg: svgData });
    });
  });
});

// Fallback all other routes to native static/API logic
app.use((req, res) => {
  handleNativeRequest(req, res);
});

// Create and start server using express app handler
const server = http.createServer(app);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Crystal Studio running: http://localhost:${PORT}`);
  const f = folderList();
  console.log(f.folder ? `Template folder: ${f.folder} (${f.files.length} files)` : "Template folder: not set yet (set it in the page)");
});