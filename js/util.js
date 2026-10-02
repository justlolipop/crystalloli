export const MM_PT = 72 / 25.4;
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const uid = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
export const hasCJK = (s) => /[㐀-鿿豈-﫿]/.test(s || "");
export const round2 = (n) => Math.round(n * 100) / 100;
// "Event Header" / "EVENT_HEADER" / "event-header" -> "eventheader" (for loose matching)
export const loose = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, "");

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function downloadDataUrl(url, name) {
  downloadBlob(await (await fetch(url)).blob(), name);
}

export function safeName(s) {
  return String(s || "design").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "design";
}

let toastTimer;
export function toast(msg, kind) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show " + (kind || "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "bad" ? 7000 : 2800);
}
