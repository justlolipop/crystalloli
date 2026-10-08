// Where designs and imported templates are kept.
// Now: this PC — the local server writes designs\ and library\ next to server.js.
// Later: point these same functions at an online database (e.g. Supabase); the rest of the app
// only ever calls store.*, so nothing else has to change.

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

export const store = {
  listDesigns: () => api("GET", "/api/designs"),
  loadDesign: (id) => api("GET", "/api/designs/" + encodeURIComponent(id)),
  saveDesign: (d) => api("POST", "/api/designs", d),
  deleteDesign: (id) => api("DELETE", "/api/designs/" + encodeURIComponent(id)),
  listLibrary: () => api("GET", "/api/library"),
  saveLibrary: (t) => api("POST", "/api/library", t),
  deleteLibrary: (id) => api("DELETE", "/api/library/" + encodeURIComponent(id)),
  // the imported .ai itself (as PDF), for redrawing the artwork at print resolution
  async saveOriginal(name, bytes) {
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
  fonts: () => api("GET", "/api/fonts"),
  // the master template: the look of the header, position and name texts on every design
  master: () => api("GET", "/api/master"),
  saveMaster: (m) => api("POST", "/api/master", m),
  // true when this page comes from server.js (not Live Server / a double-clicked index.html)
  async ping() {
    try {
      const r = await fetch("/api/folder");
      return r.ok && Array.isArray((await r.json()).files);
    } catch (e) {
      return false;
    }
  },
  folder: () => api("GET", "/api/folder"),
  setFolder: (folder) => api("POST", "/api/folder", { folder }),
  async folderFile(name) {
    const r = await fetch("/api/folder/file?name=" + encodeURIComponent(name));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't read " + name);
    return new File([await r.blob()], name);
  },
};
