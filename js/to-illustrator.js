// Crystals -> Illustrator, through Crystal Studio on this PC. A page on the internet can't reach
// this PC by itself (Chrome blocks it), so it opens a small window served by the PC
// (illustrator.html) and hands it the files; that window asks the PC's server to open them in
// Illustrator and save each one as .ai. Used by the studio and by the order website's preview.
//
// Crystal Studio not running? On a PC where "Install Crystal Studio link.bat" was run once, the
// link crystalstudio://open starts it (Chrome asks first); the window then tries again until it's up.

const BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : "http://localhost:5190";
export const START_LINK = "crystalstudio://open";

// Ask Windows to start Crystal Studio (crystalstudio://open, set up by Install Crystal Studio
// link.bat; Chrome asks first). From a hidden frame, so this page itself doesn't navigate.
// Call from a click, before opening any window.
export function startStudioLink() {
  const f = document.createElement("iframe");
  f.style.display = "none";
  f.src = START_LINK;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 10000);
}

// Call straight from a click (a window may only be opened then).
// -> { send(files): answer or null (not running), startThenSend(files): the same after the start
//      link was clicked, waiting up to 40 s for Crystal Studio to come up, cancel() }
export function illustratorWindow() {
  let win = null;
  // a new window each time (a left-over one from an earlier click may be stuck on an error page)
  try { win = window.open(BASE + "/illustrator.html", "crystal-illustrator-" + Date.now(), "width=520,height=300"); } catch (e) {}
  const waitFor = (type, ms) => new Promise((done) => {
    if (!win || win.closed) return done(null);
    const t = setTimeout(() => { removeEventListener("message", on); done(null); }, ms);
    function on(e) {
      if (e.source !== win || !e.data || e.data.type !== type) return;
      clearTimeout(t);
      removeEventListener("message", on);
      done(e.data);
    }
    addEventListener("message", on);
  });
  const first = waitFor("crystal-illustrator-ready", 6000);
  async function deliver(files) {
    const done = waitFor("crystal-illustrator-done", 120000);
    win.postMessage({ type: "crystal-illustrator-files", files }, BASE);
    const m = await done;
    const r = (m && m.result) || { ok: false, error: "no answer from Crystal Studio on this PC" };
    if (!r.ok) setTimeout(() => { try { win.close(); } catch (e) {} }, 300); // this page says why
    return r;
  }
  return {
    async send(files) {
      if (!(await first)) return null;
      return deliver(files);
    },
    async startThenSend(files) {
      const until = Date.now() + 40000;
      while (Date.now() < until && win && !win.closed) {
        try { win.location.href = BASE + "/illustrator.html?try=" + Date.now(); } catch (e) { return null; }
        if (await waitFor("crystal-illustrator-ready", 3000)) return deliver(files);
      }
      return null;
    },
    cancel() { try { win && win.close(); } catch (e) {} },
  };
}
