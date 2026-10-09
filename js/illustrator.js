// "For Illustrator (vector)": a script for Adobe Illustrator. For each Excel row it opens the
// original .ai, copies that row's design (Design A, B, C …) out into its own document, puts the
// row's words into the design's own text frames, and saves it as a new .ai. The artwork, the
// pattern and the cut line are never redrawn, so they stay exactly as drawn (vector).
//
// job = { folder, outDir?, keepOpen?, rows: [{ row, file, path?, page, region: [x, y, w, h], name, texts: [change] }] }
// (path: the exact .ai the studio imported this design from; else file is looked for in folder)
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

var JOB = __JOB__;

// true: the words are turned into shapes (Type > Create Outlines), so a PC without your fonts
// prints them exactly the same. false: the words stay editable.
var OUTLINE_TEXT = JOB.outline !== false;

(function () {
  var outDir = JOB.outDir ? new Folder(String(JOB.outDir).replace(/\\/g, "/")) : Folder.selectDialog("Crystal Studio: choose a folder for the finished .ai files");
  if (!outDir) return;
  if (!outDir.exists) outDir.create();
  var level = app.userInteractionLevel, coords = app.coordinateSystem;
  app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
  app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM; // artboards and artwork in one system
  var opened = {}, done = 0, notes = [];
  var base = String(JOB.folder || "").replace(/\\/g, "/");

  function norm(s) { return String(s || "").replace(/[\s \u0003]+/g, "").toUpperCase(); }
  function pad(n) { n = String(n); while (n.length < 3) n = "0" + n; return n; }
  function safe(s) { return String(s || "design").replace(/[\\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, ""); }

  function source(r) {
    var file = r.file, key = r.path || file;
    if (opened[key]) return opened[key];
    var f = r.path ? new File(String(r.path).replace(/\\/g, "/")) : null;
    if (!f || !f.exists) f = new File(base + "/" + file);
    if (!f.exists) {
      app.userInteractionLevel = level;
      f = File.openDialog("Crystal Studio: where is " + file + "?");
      app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
      if (!f) return null;
    }
    opened[key] = app.open(f);
    return opened[key];
  }

  // at least half of the item lies inside the design's box (Illustrator's y goes up)
  function inside(vb, L, T, R, B) {
    var w = Math.min(vb[2], R) - Math.max(vb[0], L), h = Math.min(vb[1], T) - Math.max(vb[3], B);
    if (w <= 0 || h <= 0) return false;
    var area = Math.max(0.01, (vb[2] - vb[0]) * (vb[1] - vb[3]));
    return w * h >= 0.5 * area;
  }

  var moved = null; // an item copied into the new document: where it was, and its copy

  function copyLayer(from, to, L, T, R, B) {
    from.locked = false;
    for (var k = 0; k < from.pageItems.length; k++) {
      var it = from.pageItems[k];
      if (it.hidden || !inside(it.visibleBounds, L, T, R, B)) continue;
      try { it.locked = false; } catch (e) {}
      var copy = it.duplicate(to, ElementPlacement.PLACEATEND);
      if (!moved) moved = { was: it.visibleBounds, copy: copy };
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
    if (r.master) return makeMaster(r);
    app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;
    var src = source(r);
    if (!src) throw new Error("couldn't find " + r.file);
    var ab = src.artboards[(r.page || 1) - 1].artboardRect; // [left, top, right, bottom]
    var L = ab[0] + r.region[0], T = ab[1] - r.region[1], R = L + r.region[2], B = T - r.region[3];
    var doc = app.documents.add(src.documentColorSpace, r.region[2], r.region[3]);
    var first = doc.layers[0];
    moved = null;
    for (var li = src.layers.length - 1; li >= 0; li--) {
      var sl = src.layers[li];
      if (!sl.visible) continue;
      var dl = doc.layers.add();
      dl.name = sl.name;
      copyLayer(sl, dl, L, T, R, B);
    }
    if (first.pageItems.length === 0 && first.layers.length === 0 && doc.layers.length > 1) first.remove();
    // a new document measures from its own origin, so the copies may land somewhere else on its
    // canvas: put the artboard (and the box texts are looked for in) where the design landed
    if (moved) {
      var now = moved.copy.visibleBounds, dx = now[0] - moved.was[0], dy = now[1] - moved.was[1];
      L += dx; R += dx; T += dy; B += dy;
    }
    doc.artboards[0].artboardRect = [L, T, R, B];

    var i;
    var frames = [];
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

    finish(doc, r);
  }

  // master template (r.master): the original .ai is opened afresh and cut down to this design —
  // its artboard, and only what's on it (a group spread over several designs is looked into) —
  // then its logo and old words come out, the studio's texts (and pictures added there) go in,
  // editable, and it's saved as a new .ai. The original file isn't changed.
  function makeMaster(r) {
    var f = r.path ? new File(String(r.path).replace(/\\/g, "/")) : null;
    if (!f || !f.exists) throw new Error("the original .ai of " + r.file + " wasn't found");
    var doc = app.open(f), i;
    docCMYK = doc.documentColorSpace === DocumentColorSpace.CMYK;
    app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;
    var keep = Math.min((r.page || 1) - 1, doc.artboards.length - 1);
    var ab = doc.artboards[keep].artboardRect; // [left, top, right, bottom], y up
    // the design's artboard first, then the others go: removing artboards can move the document's
    // origin, so nothing is measured in document terms after that
    doc.artboards[keep].artboardRect = [ab[0] + r.region[0], ab[1] - r.region[1], ab[0] + r.region[0] + r.region[2], ab[1] - r.region[1] - r.region[3]];
    for (i = doc.artboards.length - 1; i >= 0; i--) if (i !== keep) { try { doc.artboards.remove(i); } catch (e) {} }
    // from here on, everything is measured from the design's own artboard: its top-left is 0, 0
    // (y up, so below it is negative)
    doc.artboards.setActiveArtboardIndex(0);
    app.coordinateSystem = CoordinateSystem.ARTBOARDCOORDINATESYSTEM;
    var L = 0, T = 0, R = r.region[2], B = -r.region[3];
    var box = [L, T, R, B];
    // each cleaning step on its own: one odd piece of artwork mustn't stop the words going in
    function step(what, fn) { try { fn(); } catch (e) { notes.push("Row " + r.row + ": " + what + " (" + e.message + ")"); } }
    step("couldn't remove all the other designs", function () { for (var k = 0; k < doc.layers.length; k++) cropIn(doc.layers[k], box); });
    // the design's old words (live text): the studio's texts replace them
    step("couldn't remove the old words", function () {
      for (var k = doc.textFrames.length - 1; k >= 0; k--) {
        try { if (!outside(doc.textFrames[k].visibleBounds, box)) doc.textFrames[k].remove(); } catch (e) {}
      }
    });
    var boxes = [];
    for (i = 0; i < (r.remove || []).length; i++) {
      var bx = r.remove[i];
      boxes.push([L + bx.l - 1, T - bx.t + 1, L + bx.r + 1, T - bx.b - 1]);
    }
    if (boxes.length) step("couldn't remove the logo", function () { for (var k = 0; k < doc.layers.length; k++) removeIn(doc.layers[k], boxes); });
    // the studio's words and pictures on a layer of their own, on top: the .ai's own layers may be
    // locked or hidden
    var layer = doc.layers.add();
    layer.name = "Crystal Studio";
    layer.visible = true;
    layer.locked = false;
    try { layer.zOrder(ZOrderMethod.BRINGTOFRONT); } catch (e) {}
    doc.activeLayer = layer;
    var added = 0;
    for (i = 0; i < (r.images || []).length; i++) { try { addImage(layer, r.images[i], L, T); } catch (e) { notes.push("Row " + r.row + ": a picture couldn't be placed (" + e.message + ")"); } }
    for (i = 0; i < r.texts.length; i++) {
      try { addStyled(layer, r.texts[i].now, L, T); added++; } catch (e) { notes.push("Row " + r.row + ": a text couldn't be added (" + e.message + ")"); }
    }
    notes.push("Row " + r.row + ": " + added + " of " + r.texts.length + " texts added" + (docCMYK ? " (CMYK file)" : " (RGB file)") + ".");
    try { // where the first one landed, from the artboard's top-left (for checking)
      var g0 = layer.pageItems[layer.pageItems.length - 1].geometricBounds;
      notes.push("First text at x " + Math.round(g0[0]) + "-" + Math.round(g0[2]) + ", y " + Math.round(-g0[1]) + "-" + Math.round(-g0[3]) + " of a " + Math.round(r.region[2]) + " x " + Math.round(r.region[3]) + " artboard.");
    } catch (e) {}
    finish(doc, r);
  }

  function outside(vb, b) { return vb[2] < b[0] || vb[0] > b[2] || vb[1] < b[3] || vb[3] > b[1]; }
  function partly(vb, b) { return vb[0] < b[0] || vb[2] > b[2] || vb[1] > b[1] || vb[3] < b[3]; }
  // everything off the design's box goes; a group partly on it is looked into
  function cropIn(container, b) {
    try { container.locked = false; } catch (e) {}
    var items = container.pageItems, k;
    for (k = items.length - 1; k >= 0; k--) {
      try {
        var it = items[k];
        if (it.parent !== container) continue; // only its own items; groups are looked into below
        var vb = it.visibleBounds;
        if (outside(vb, b)) { it.locked = false; it.remove(); continue; }
        if (it.typename === "GroupItem" && !it.clipped && partly(vb, b)) cropIn(it, b);
      } catch (e) {} // an item that can't be measured or removed stays
    }
    try { if (container.layers) for (k = 0; k < container.layers.length; k++) cropIn(container.layers[k], b); } catch (e) {}
  }

  function finish(doc, r) {
    if (OUTLINE_TEXT) for (var i = doc.textFrames.length - 1; i >= 0; i--) { try { doc.textFrames[i].createOutline(); } catch (e) {} }
    var out = new File(outDir.fsName + "/" + pad(r.row) + " - " + safe(r.name) + ".ai");
    doc.saveAs(out, new IllustratorSaveOptions());
    if (!JOB.keepOpen) doc.close(SaveOptions.DONOTSAVECHANGES);
  }

  // most of the item lies in one of the boxes (what the studio took out of the design: the logo,
  // old outlined words): it goes. A group partly in a box is looked into.
  function mostlyIn(vb, b) {
    var w = Math.min(vb[2], b[2]) - Math.max(vb[0], b[0]), h = Math.min(vb[1], b[1]) - Math.max(vb[3], b[3]);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / Math.max(0.01, (vb[2] - vb[0]) * (vb[1] - vb[3]));
  }
  function removeIn(container, boxes) {
    var items = container.pageItems, k, j;
    for (k = items.length - 1; k >= 0; k--) {
      try {
        var it = items[k];
        if (it.parent !== container) continue; // only its own items; groups are looked into below
        var vb = it.visibleBounds, best = 0;
        for (j = 0; j < boxes.length; j++) best = Math.max(best, mostlyIn(vb, boxes[j]));
        if (best >= 0.8) { it.locked = false; it.remove(); continue; }
        if (best > 0 && it.typename === "GroupItem" && !it.clipped) removeIn(it, boxes);
      } catch (e) {}
    }
    try { if (container.layers) for (k = 0; k < container.layers.length; k++) removeIn(container.layers[k], boxes); } catch (e) {}
  }

  // a colour in the document's own colour mode (a CMYK document, usual for print, may refuse RGB)
  var docCMYK = false;
  function rgb(hex, fallback) {
    if (!hex) return fallback || null;
    hex = String(hex).replace(/^#/, "");
    var R = parseInt(hex.substr(0, 2), 16), G = parseInt(hex.substr(2, 2), 16), Bl = parseInt(hex.substr(4, 2), 16);
    if (docCMYK) {
      var r1 = R / 255, g1 = G / 255, b1 = Bl / 255, k = 1 - Math.max(r1, g1, b1), c = new CMYKColor();
      c.black = k * 100;
      c.cyan = k >= 1 ? 0 : (1 - r1 - k) / (1 - k) * 100;
      c.magenta = k >= 1 ? 0 : (1 - g1 - k) / (1 - k) * 100;
      c.yellow = k >= 1 ? 0 : (1 - b1 - k) / (1 - k) * 100;
      return c;
    }
    var c2 = new RGBColor();
    c2.red = R; c2.green = G; c2.blue = Bl;
    return c2;
  }

  // one studio text as editable Illustrator text, in its own look. An outline drawn behind the
  // letters (as the studio does) needs a copy behind with that outline: they're grouped, named
  // after the words. Change the words in each frame of the group.
  var failed = {}; // a setting Illustrator refused, reported once
  function frame(layer, b, strokeHex, strokeW) {
    var tf = layer.textFrames.add();
    tf.contents = String(b.text).replace(/\r?\n/g, "\r");
    var ca = tf.textRange.characterAttributes;
    // each setting on its own: one Illustrator refuses mustn't lose the whole text
    function set(what, fn) { try { fn(); } catch (e) { if (!failed[what]) { failed[what] = 1; notes.push("Couldn't set the " + what + ": " + e.message); } } }
    set("font " + b.ps, function () { if (b.ps) ca.textFont = app.textFonts.getByName(b.ps); });
    set("size", function () { ca.size = b.size; });
    set("width", function () { ca.horizontalScale = (b.hScale || 1) * 100; });
    set("tracking", function () { ca.tracking = b.tracking || 0; });
    set("line spacing", function () { ca.autoLeading = false; ca.leading = b.size * (b.lineHeight || 1) * 1.13; });
    set("colour", function () { ca.fillColor = rgb(b.fill || "#000000"); });
    set("outline", function () { if (strokeHex && strokeW > 0) { ca.strokeColor = rgb(strokeHex); ca.strokeWeight = strokeW; } else ca.strokeColor = new NoColor(); });
    set("alignment", function () { tf.textRange.paragraphAttributes.justification = b.align === "center" ? Justification.CENTER : b.align === "right" ? Justification.RIGHT : Justification.LEFT; });
    return tf;
  }
  function addStyled(layer, b, L, T) {
    var parts = [];
    if (b.outer && b.outerWidth > 0) parts.push(frame(layer, b, b.outer, b.outerWidth));
    if (b.stroke && b.strokeBehind) { parts.push(frame(layer, b, b.stroke, b.strokeWidth)); parts.push(frame(layer, b, null, 0)); }
    else parts.push(frame(layer, b, b.stroke, b.strokeWidth));
    var it = parts[0];
    if (parts.length > 1) {
      it = layer.groupItems.add();
      // each one in front of the one before: the outlines behind, the letters' own colour on top
      // (PLACEATBEGINNING is the front of a group; PLACEATEND, its back)
      for (var k = 0; k < parts.length; k++) parts[k].move(it, ElementPlacement.PLACEATBEGINNING);
      it.name = String(b.text).replace(/\s+/g, " ").substr(0, 60);
    }
    if (b.flipX) it.resize(-100, 100);
    if (b.angle) it.rotate(-b.angle);
    place(it, b, L, T);
  }
  function place(it, b, L, T) {
    var g = it.geometricBounds; // its middle goes where the studio's box has its middle
    it.translate((L + (b.l + b.r) / 2) - (g[0] + g[2]) / 2, (T - (b.t + b.b) / 2) - (g[1] + g[3]) / 2);
  }
  function addImage(layer, im, L, T) {
    var p = layer.placedItems.add();
    p.file = new File(String(im.path).replace(/\\/g, "/"));
    p.width = im.w || im.r - im.l; // its own size; turned afterwards
    p.height = im.h || im.b - im.t;
    if (im.flipX) p.resize(-100, 100);
    if (im.angle) p.rotate(-im.angle);
    place(p, im, L, T);
    try { p.embed(); } catch (e) {}
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
  app.coordinateSystem = coords;
  var report = done + " .ai file(s) saved in " + outDir.fsName + (notes.length ? ". " + notes.join(" ") : "");
  // for the website: Crystal Studio's window reads this and shows it next to the button
  try { var log = new File(outDir.fsName + "/_result.txt"); log.encoding = "UTF-8"; log.open("w"); log.write(report); log.close(); } catch (e) {}
  if (!JOB.quiet) alert("Crystal Studio: " + done + " .ai file(s) saved in\n" + outDir.fsName + (notes.length ? "\n\n" + notes.join("\n") : ""));
})();
`;

// ExtendScript files are read safest as plain ASCII: everything else is written as \uXXXX
const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export function illustratorScript(job) {
  return ascii(SCRIPT.replace("__JOB__", () => JSON.stringify(job)));
}
