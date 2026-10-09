// Crystals -> Illustrator, through Crystal Studio on this PC. A page on the internet can't reach
// this PC by itself (Chrome blocks it), so it opens a small window served by the PC
// (illustrator.html) and hands it the files; that window asks the PC's server to open them in
// Illustrator and save each one as .ai. Used by the studio and by the order website's preview.
//
// Crystal Studio not running? On a PC where "Install Crystal Studio link.bat" was run once, the
// link crystalstudio://open starts it (Chrome asks first) — clicked as a real link, as Chrome only
// lets a link start a program from a click on it.

const BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : "http://localhost:5190";
export const START_LINK = "crystalstudio://open";

// Call straight from a click (a window may only be opened then).
// -> { send(files): the server's answer, or null when Crystal Studio isn't running here; cancel() }
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
  // what: { job, files } — crystals made from their original .ai (see vector-job.js) and/or .svg
  // files ({ name, svg }); or just an array of .svg files
  async function deliver(what) {
    const done = waitFor("crystal-illustrator-done", 300000);
    const msg = Array.isArray(what) ? { files: what } : { job: what.job || null, files: what.files || [] };
    win.postMessage({ type: "crystal-illustrator-files", ...msg }, BASE);
    const m = await done;
    const r = (m && m.result) || { ok: false, error: "no answer from Crystal Studio on this PC" };
    if (!r.ok) setTimeout(() => { try { win.close(); } catch (e) {} }, 300); // this page says why
    return r;
  }
  return {
    // like send, but Crystal Studio may still be starting (the click asked Windows to start it):
    // the window tries again every few seconds until it's up
    async sendWhenUp(what, ms = 45000) {
      let ready = await first;
      const until = Date.now() + ms;
      while (!ready && win && !win.closed && Date.now() < until) {
        try { win.location.href = BASE + "/illustrator.html?try=" + Date.now(); } catch (e) { break; }
        ready = await waitFor("crystal-illustrator-ready", 3000);
      }
      return ready ? this.deliverTo(ready, what) : null;
    },
    async send(what) {
      return this.deliverTo(await first, what);
    },
    async deliverTo(ready, what) {
      if (!ready) return null;
      // an older Crystal Studio on this PC (before it made crystals from their original .ai)
      if (!Array.isArray(what) && what.job && what.job.rows && what.job.rows.length && !(ready.v >= 2)) {
        try { win.close(); } catch (e) {}
        return { ok: false, old: true, error: "Crystal Studio on this computer is an old version: close its black window, then click Open in Illustrator again (it updates itself when it starts)." };
      }
      const r = await deliver(what);
      if (r) r.build = ready.build || "old"; // which Crystal Studio answered
      return r;
    },
    cancel() { try { win && win.close(); } catch (e) {} },
  };
}

// Kept for pages still holding an older copy of preview.js / app.js (the browser updates these
// files one by one): without it, such a page stops with "doesn't provide an export".
export function startStudioLink() {}
