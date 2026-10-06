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

// A yes/no question in the page's own box. The browser's confirm() is blocked in some places
// (VS Code's built-in browser answers "Cancel" without showing it), which made buttons do nothing.
export function ask(msg, okLabel = "OK") {
  return new Promise((done) => {
    const d = document.createElement("dialog");
    d.innerHTML = `<p style="margin:0;max-width:420px;line-height:1.5"></p><div class="dlg-actions"><button data-a="0">Cancel</button><button class="primary" data-a="1"></button></div>`;
    d.querySelector("p").textContent = msg;
    d.querySelector("[data-a='1']").textContent = okLabel;
    let answer = false;
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (b) { answer = b.dataset.a === "1"; d.close(); }
    });
    d.addEventListener("close", () => { d.remove(); done(answer); });
    document.body.appendChild(d);
    d.showModal();
    d.querySelector("[data-a='1']").focus();
  });
}

let toastTimer;
export function toast(msg, kind) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show " + (kind || "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "bad" ? 7000 : 2800);
}
