// Where designs and imported templates are kept (see js/config.js):
// online — Supabase tables crystal_library / crystal_designs / crystal_settings and the "crystal"
//          storage bucket (pictures, the imported .ai copies, font files), shared by everyone;
// or this PC — the local server writes designs\ and library\ next to server.js.
// The rest of the app only ever calls store.*, so it works the same either way.
// The template folder and opening Illustrator always need the local server (they use this PC).

import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { mergeItem, designMeta, ID_RE, newId } from "./libitem.js";

const KEY = String(SUPABASE_KEY || "").trim();
if (/^sb_secret_/.test(KEY) || /service_role/.test(atobSafe(KEY.split(".")[1] || ""))) {
  throw new Error("js/config.js has a SECRET Supabase key. Put the publishable (anon) key there instead, and change the secret one in Supabase.");
}
function atobSafe(s) { try { return atob(s.replace(/-/g, "+").replace(/_/g, "/")); } catch (e) { return ""; } }
const BASE = String(SUPABASE_URL || "").replace(/\/+$/, "");
export const ONLINE = !!(KEY && BASE);
const BUCKET = "crystal";
const MAX_FILE = 50e6; // Supabase's free plan takes files up to 50 MB

async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error("Can't reach the local server. Is “Start Studio.bat” still running?");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ------------------------------------------------------------------ online (Supabase)

// a publishable key (sb_publishable_…) is only an apikey; an older anon key is also the Bearer token
const auth = () => (KEY.startsWith("sb_") ? { apikey: KEY } : { apikey: KEY, Authorization: "Bearer " + KEY });

async function sb(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { ...auth(), ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Can't reach the online database. Check the internet connection.");
  }
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) {
    const msg = (j && (j.message || j.error || j.msg)) || r.statusText;
    if (/relation .* does not exist|Could not find the table/i.test(msg)) {
      throw new Error("The online database isn't set up yet: run supabase/crystal_studio.sql in Supabase's SQL Editor.");
    }
    throw new Error("Online database: " + msg);
  }
  return j;
}
const table = (name, query = "") => `/rest/v1/${name}${query ? "?" + query : ""}`;
const upsert = (name, row) => sb(table(name), { method: "POST", body: row, headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });

// files in the bucket keep the same paths as on this PC (library/xxx.png, library/orig-xxx.pdf)
async function putFile(path, data, type) {
  const size = data.size != null ? data.size : data.byteLength;
  if (size > MAX_FILE) throw new Error(`Too big to keep online (${Math.round(size / 1e6)} MB; the limit is ${MAX_FILE / 1e6} MB).`);
  await sb(`/storage/v1/object/${BUCKET}/${path}`, { method: "POST", body: data, raw: true, headers: { "Content-Type": type, "x-upsert": "true", "Cache-Control": "no-cache" } });
}
const removeFiles = (paths) => paths.length ? sb(`/storage/v1/object/${BUCKET}`, { method: "DELETE", body: { prefixes: paths } }).catch(() => {}) : null;
const dataUrlBlob = async (url) => (await fetch(url)).blob();

async function getItem(id) {
  const r = await sb(table("crystal_library", `id=eq.${encodeURIComponent(id)}&select=item`));
  return r && r[0] ? r[0].item : null;
}

const online = {
  async listLibrary() {
    const r = await sb(table("crystal_library", "select=item"));
    return (r || []).map((x) => x.item).filter(Boolean)
      .sort((a, b) => (a.created || 0) - (b.created || 0) || (a.order || 0) - (b.order || 0));
  },
  async saveLibrary(body) {
    const id = body.id && ID_RE.test(body.id) ? body.id : newId();
    const item = mergeItem((await getItem(id)) || {}, body, id);
    const m = /^data:image\/(png|jpeg);base64,/.exec(body.background || "");
    if (m) {
      const name = "library/" + id + (m[1] === "png" ? ".png" : ".jpg");
      await putFile(name, await dataUrlBlob(body.background), "image/" + m[1]);
      item.background = name;
    }
    if (item.svg === undefined) delete item.svg;
    await upsert("crystal_library", { id, item, updated_at: new Date().toISOString() });
    return item;
  },
  async deleteLibrary(id) {
    if (!ID_RE.test(id)) return { ok: true };
    const item = (await getItem(id)) || {};
    await sb(table("crystal_library", `id=eq.${encodeURIComponent(id)}`), { method: "DELETE" });
    const files = [`library/${id}.png`, `library/${id}.jpg`];
    if (item.original && !(await online.listLibrary()).some((x) => x.original === item.original)) files.push(item.original);
    await removeFiles(files);
    return { ok: true };
  },
  async saveOriginal(name, bytes) {
    const path = "library/orig-" + newId() + ".pdf";
    await putFile(path, new Blob([bytes], { type: "application/pdf" }), "application/pdf");
    return { path };
  },
  async listDesigns() {
    const r = await sb(table("crystal_designs", "select=meta&order=updated_at.desc"));
    return (r || []).map((x) => x.meta);
  },
  async loadDesign(id) {
    const r = await sb(table("crystal_designs", `id=eq.${encodeURIComponent(id)}&select=design`));
    if (!r || !r[0]) throw new Error("Design not found");
    return r[0].design;
  },
  async saveDesign(body) {
    const id = body.id && ID_RE.test(body.id) ? body.id : newId();
    const old = await sb(table("crystal_designs", `id=eq.${encodeURIComponent(id)}&select=meta`));
    const was = (old && old[0] && old[0].meta) || {};
    const now = Date.now(), name = String(body.name || "Untitled design").slice(0, 160), data = body.data || {};
    const created = was.created || now;
    const thumb = /^data:image\/(png|jpeg);base64,/.test(body.thumb || "") && body.thumb.length < 400000 ? body.thumb : was.thumb || "";
    await upsert("crystal_designs", { id, design: { id, name, created, updated: now, data },
      meta: designMeta(id, name, created, now, data, thumb), updated_at: new Date(now).toISOString() });
    return { id, updated: now };
  },
  async deleteDesign(id) {
    await sb(table("crystal_designs", `id=eq.${encodeURIComponent(id)}`), { method: "DELETE" });
    return { ok: true };
  },
  async setting(key, fallback) {
    const r = await sb(table("crystal_settings", `key=eq.${encodeURIComponent(key)}&select=value`));
    return r && r[0] ? r[0].value : fallback;
  },
  async saveSetting(key, value) {
    await upsert("crystal_settings", { key, value, updated_at: new Date().toISOString() });
    return value;
  },
  // font files kept online (fonts/<PostScript name>.ttf / .otf / .woff2), for computers that don't have them
  async fontFiles() {
    const r = await sb(`/storage/v1/object/list/${BUCKET}`, { method: "POST", body: { prefix: "fonts/", limit: 1000 } }).catch(() => []);
    const out = {};
    for (const f of r || []) {
      const m = /^(.+)\.(ttf|otf|woff2?)$/i.exec(f.name || "");
      if (m) out[m[1]] = fileUrl("fonts/" + f.name);
    }
    return out;
  },
};

// a kept file's address (a design's picture, an imported .ai copy)
export function fileUrl(rel) {
  if (!rel || /^(https?:|data:|blob:)/.test(rel)) return rel;
  return ONLINE ? `${BASE}/storage/v1/object/public/${BUCKET}/${rel}` : "/" + rel;
}

// ------------------------------------------------------------------ "something changed"

// Crystal Studio and the order website's preview (same site, other tab / frame) hear each other:
// a design or the master template saved here makes the preview draw again by itself.
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("crystal-studio") : null;
const announce = (r) => { try { channel && channel.postMessage({ type: "library-changed" }); } catch (e) {} return r; };
export function onLibraryChanged(fn) {
  if (channel) channel.addEventListener("message", (e) => { if (e.data && e.data.type === "library-changed") fn(); });
}

// ------------------------------------------------------------------ the store

let localUp = null; // is the local server (server.js) running? asked once
const local = () => (localUp ??= fetch("/api/folder").then((r) => r.ok).catch(() => false));

export const store = {
  online: ONLINE,
  listDesigns: () => (ONLINE ? online.listDesigns() : api("GET", "/api/designs")),
  loadDesign: (id) => (ONLINE ? online.loadDesign(id) : api("GET", "/api/designs/" + encodeURIComponent(id))),
  saveDesign: (d) => (ONLINE ? online.saveDesign(d) : api("POST", "/api/designs", d)),
  deleteDesign: (id) => (ONLINE ? online.deleteDesign(id) : api("DELETE", "/api/designs/" + encodeURIComponent(id))),
  listLibrary: () => (ONLINE ? online.listLibrary() : api("GET", "/api/library")),
  saveLibrary: (t) => (ONLINE ? online.saveLibrary(t) : api("POST", "/api/library", t)).then(announce),
  deleteLibrary: (id) => (ONLINE ? online.deleteLibrary(id) : api("DELETE", "/api/library/" + encodeURIComponent(id))).then(announce),
  // the imported .ai itself (as PDF), for redrawing the artwork at print resolution
  async saveOriginal(name, bytes) {
    if (ONLINE) return online.saveOriginal(name, bytes);
    let r;
    try {
      r = await fetch("/api/library/original", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: bytes });
    } catch (e) {
      throw new Error("Can't reach the local server. Is “Start Studio.bat” still running?");
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  },
  // the fonts' names (for the font box): this PC's list when the local server runs, else the one
  // kept online (uploaded from a PC that has it)
  async fonts() {
    if (await local()) return api("GET", "/api/fonts");
    return ONLINE ? online.setting("fonts", []) : [];
  },
  fontFiles: () => (ONLINE ? online.fontFiles() : Promise.resolve({})),
  // the master template: the look of the header, position and name texts on every design
  master: () => (ONLINE ? online.setting("master", {}) : api("GET", "/api/master")),
  saveMaster: (m) => (ONLINE ? online.saveSetting("master", m && typeof m === "object" && !Array.isArray(m) ? m : {}) : api("POST", "/api/master", m)).then(announce),
  // true when the studio can work: online, or this page comes from server.js
  async ping() { return ONLINE || local(); },
  // this PC's server (template folder, Illustrator) is there
  hasLocal: () => local(),
  folder: () => api("GET", "/api/folder"),
  setFolder: (folder) => api("POST", "/api/folder", { folder }),
  async folderFile(name) {
    const r = await fetch("/api/folder/file?name=" + encodeURIComponent(name));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't read " + name);
    return new File([await r.blob()], name);
  },
};
