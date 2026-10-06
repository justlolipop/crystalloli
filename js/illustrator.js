// "For Illustrator (vector)": a script for Adobe Illustrator. For each Excel row it opens the
// original .ai, copies that row's design (Design A, B, C …) out into its own document, puts the
// row's words into the design's own text frames, and saves it as a new .ai. The artwork, the
// pattern and the cut line are never redrawn, so they stay exactly as drawn (vector).
//
// job = { folder, outDir?, keepOpen?, rows: [{ row, file, page, region: [x, y, w, h], name, texts: [change] }] }
// (outDir: save there without asking; keepOpen: leave the new .ai files open in Illustrator)
// change = { orig: box, now: box } (a template text that changed), { orig, deleted: true }, or
//          { now } (a text added in the studio). box = { text, l, t, r, b, size, fill, align, ps }
//          in pt from the design's top-left.
//
// Illustrator runs ExtendScript (old JavaScript, ES3): no let / const / arrows / JSON in there.

const SCRIPT = String.raw`// Crystal Studio -> Illustrator
// In Illustrator: File > Scripts > Other Script... and pick this file.
// Each row's design is copied out of your original .ai with its words changed, and saved as its
// own .ai in a folder you choose. The artwork, pattern and cut line stay vector, as drawn.
#target illustrator

// true: the words are turned into shapes (Type > Create Outlines), so a PC without your fonts
// prints them exactly the same. false: the words stay editable.
var OUTLINE_TEXT = true;

var JOB = __JOB__;

(function () {
  var outDir = JOB.outDir ? new Folder(String(JOB.outDir).replace(/\\/g, "/")) : Folder.selectDialog("Crystal Studio: choose a folder for the finished .ai files");
  if (!outDir) return;
  if (!outDir.exists) outDir.create();
  var level = app.userInteractionLevel;
  app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
  var opened = {}, done = 0, notes = [];
  var base = String(JOB.folder || "").replace(/\\/g, "/");

  function norm(s) { return String(s || "").replace(/[\s \u0003]+/g, "").toUpperCase(); }
  function pad(n) { n = String(n); while (n.length < 3) n = "0" + n; return n; }
  function safe(s) { return String(s || "design").replace(/[\\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""); }

  function source(file) {
    if (opened[file]) return opened[file];
    var f = new File(base + "/" + file);
    if (!f.exists) {
      app.userInteractionLevel = level;
      f = File.openDialog("Crystal Studio: where is " + file + "?");
      app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
      if (!f) return null;
    }
    opened[file] = app.open(f);
    return opened[file];
  }

  // at least half of the item lies inside the design's box (Illustrator's y goes up)
  function inside(vb, L, T, R, B) {
    var w = Math.min(vb[2], R) - Math.max(vb[0], L), h = Math.min(vb[1], T) - Math.max(vb[3], B);
    if (w <= 0 || h <= 0) return false;
    var area = Math.max(0.01, (vb[2] - vb[0]) * (vb[1] - vb[3]));
    return w * h >= 0.5 * area;
  }

  function copyLayer(from, to, L, T, R, B) {
    from.locked = false;
    for (var k = 0; k < from.pageItems.length; k++) {
      var it = from.pageItems[k];
      if (it.hidden || !inside(it.visibleBounds, L, T, R, B)) continue;
      try { it.locked = false; } catch (e) {}
      it.duplicate(to, ElementPlacement.PLACEATEND);
    }
    for (var s = from.layers.length - 1; s >= 0; s--) {
      var sub = from.layers[s];
      if (!sub.visible) continue;
      var ns = to.layers.add();
      ns.name = sub.name;
      copyLayer(sub, ns, L, T, R, B);
    }
  }

  function color(hex) {
    var c = new RGBColor();
    c.red = parseInt(hex.substr(1, 2), 16); c.green = parseInt(hex.substr(3, 2), 16); c.blue = parseInt(hex.substr(5, 2), 16);
    return c;
  }

  // where a box's anchor is: x by its alignment, y at its top
  function ax(b) { return b.align === "center" ? (b.l + b.r) / 2 : b.align === "right" ? b.r : b.l; }
  function gx(g, align) { return align === "center" ? (g[0] + g[2]) / 2 : align === "right" ? g[2] : g[0]; }

  // the text frame(s) in the copy that show this studio text
  function framesFor(frames, o) {
    var near = [], i, f;
    for (i = 0; i < frames.length; i++) {
      f = frames[i];
      if (!f.used && f.x >= o.l - 8 && f.x <= o.r + 8 && f.y >= o.t - 8 && f.y <= o.b + 8) near.push(f);
    }
    var n = norm(o.text);
    for (i = 0; i < near.length; i++) if (near[i].n === n) return [near[i]];
    var parts = [];
    for (i = 0; i < near.length; i++) if (near[i].n && n.indexOf(near[i].n) >= 0) parts.push(near[i]);
    if (parts.length) {
      parts.sort(function (a, b) { return Math.abs(a.y - b.y) > 2 ? a.y - b.y : a.x - b.x; });
      return parts;
    }
    return near.length === 1 ? near : [];
  }

  function makeRow(r) {
    var src = source(r.file);
    if (!src) throw new Error("couldn't find " + r.file);
    var ab = src.artboards[(r.page || 1) - 1].artboardRect; // [left, top, right, bottom]
    var L = ab[0] + r.region[0], T = ab[1] - r.region[1], R = L + r.region[2], B = T - r.region[3];
    var doc = app.documents.add(src.documentColorSpace, r.region[2], r.region[3]);
    doc.artboards[0].artboardRect = [L, T, R, B];
    var first = doc.layers[0];
    for (var li = src.layers.length - 1; li >= 0; li--) {
      var sl = src.layers[li];
      if (!sl.visible) continue;
      var dl = doc.layers.add();
      dl.name = sl.name;
      copyLayer(sl, dl, L, T, R, B);
    }
    if (first.pageItems.length === 0 && first.layers.length === 0 && doc.layers.length > 1) first.remove();

    var frames = [], i;
    for (i = 0; i < doc.textFrames.length; i++) {
      var tf = doc.textFrames[i], g = tf.geometricBounds;
      frames.push({ tf: tf, n: norm(tf.contents), x: (g[0] + g[2]) / 2 - L, y: T - (g[1] + g[3]) / 2, used: false });
    }
    var missed = 0;
    for (i = 0; i < r.texts.length; i++) {
      var c = r.texts[i];
      if (!c.orig) { addText(doc, c.now, L, T); continue; }
      var grp = framesFor(frames, c.orig);
      if (!grp.length) { missed++; continue; }
      for (var k = 0; k < grp.length; k++) grp[k].used = true;
      if (c.deleted) { for (k = 0; k < grp.length; k++) grp[k].tf.remove(); continue; }
      var main = grp[0].tf, before = main.geometricBounds;
      for (k = 1; k < grp.length; k++) grp[k].tf.remove();
      main.contents = c.now.text.replace(/\r?\n/g, "\r"); // keeps the first letter's font, colour and style
      var ca = main.textRange.characterAttributes;
      if (c.orig.size > 0 && Math.abs(c.now.size / c.orig.size - 1) > 0.01) ca.size = ca.size * c.now.size / c.orig.size;
      if (c.now.fill && c.now.fill !== c.orig.fill) ca.fillColor = color(c.now.fill);
      // keep it where the studio put it: same anchor as before, moved as much as it was moved there
      var after = main.geometricBounds;
      var dx = (gx(before, c.orig.align) + ax(c.now) - ax(c.orig)) - gx(after, c.orig.align);
      var dy = (before[1] - (c.now.t - c.orig.t)) - after[1];
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) main.translate(dx, dy);
    }
    if (missed) notes.push("Row " + r.row + ": " + missed + " text(s) not found in " + r.file + " - check that file.");

    if (OUTLINE_TEXT) for (i = doc.textFrames.length - 1; i >= 0; i--) { try { doc.textFrames[i].createOutline(); } catch (e) {} }
    var out = new File(outDir.fsName + "/" + pad(r.row) + " - " + safe(r.name) + ".ai");
    doc.saveAs(out, new IllustratorSaveOptions());
    if (!JOB.keepOpen) doc.close(SaveOptions.DONOTSAVECHANGES);
  }

  function addText(doc, b, L, T) {
    var tf = doc.textFrames.add();
    tf.contents = b.text.replace(/\r?\n/g, "\r");
    var ca = tf.textRange.characterAttributes;
    try { if (b.ps) ca.textFont = app.textFonts.getByName(b.ps); } catch (e) {}
    ca.size = b.size;
    if (b.fill) ca.fillColor = color(b.fill);
    tf.textRange.paragraphAttributes.justification = b.align === "center" ? Justification.CENTER : b.align === "right" ? Justification.RIGHT : Justification.LEFT;
    tf.position = [L + b.l, T - b.t];
  }

  for (var n = 0; n < JOB.rows.length; n++) {
    try { makeRow(JOB.rows[n]); done++; } catch (e) { notes.push("Row " + JOB.rows[n].row + ": " + e.message); }
  }
  for (var f in opened) { try { opened[f].close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} }
  app.userInteractionLevel = level;
  alert("Crystal Studio: " + done + " .ai file(s) saved in\n" + outDir.fsName + (notes.length ? "\n\n" + notes.join("\n") : ""));
})();
`;

// ExtendScript files are read safest as plain ASCII: everything else is written as \uXXXX
const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export function illustratorScript(job) {
  return ascii(SCRIPT.replace("__JOB__", () => JSON.stringify(job)));
}
