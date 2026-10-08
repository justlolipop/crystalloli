// Crystals -> Illustrator, through Crystal Studio on this PC (Start Studio.bat). A page on the
// internet can't reach this PC by itself (Chrome blocks it), so it opens a small window served by
// the PC (illustrator.html) and hands it the files; that window asks the PC's server to open them
// in Illustrator and save each one as .ai. Used by the studio and by the order website's preview.

const BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : "http://localhost:5190";

// Call straight from the click (a window may only be opened then). -> { send(files), cancel() }
// send resolves to the server's answer ({ ok, folder } / { ok: false, error }), or null when Crystal
// Studio isn't running on this PC (the window then closes; download the files instead).
export function illustratorWindow() {
  let win = null;
  try { win = window.open(BASE + "/illustrator.html", "crystal-illustrator", "width=520,height=300"); } catch (e) {}
  const ready = new Promise((done) => {
    if (!win) return done(false);
    const t = setTimeout(() => { removeEventListener("message", on); done(false); }, 6000);
    function on(e) {
      if (e.source !== win || !e.data || e.data.type !== "crystal-illustrator-ready") return;
      clearTimeout(t);
      removeEventListener("message", on);
      done(true);
    }
    addEventListener("message", on);
  });
  return {
    async send(files) {
      if (!(await ready)) { try { win && win.close(); } catch (e) {} return null; }
      return new Promise((done) => {
        const t = setTimeout(() => { removeEventListener("message", on); done({ ok: false, error: "no answer from Crystal Studio on this PC" }); }, 120000);
        function on(e) {
          if (e.source !== win || !e.data || e.data.type !== "crystal-illustrator-done") return;
          clearTimeout(t);
          removeEventListener("message", on);
          done(e.data.result || { ok: false });
        }
        addEventListener("message", on);
        win.postMessage({ type: "crystal-illustrator-files", files }, BASE);
      });
    },
    cancel() { try { win && win.close(); } catch (e) {} },
  };
}
