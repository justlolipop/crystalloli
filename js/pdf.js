// Reading the live text of an .ai / .pdf page the way Illustrator shows it.
// Used by library.js. No page drawing in here, so it also runs outside the browser (for testing).
//
// Two things Illustrator files do that pdf.js's text list doesn't deal with:
//  · Hidden layers. A layer switched off (eye icon) is still saved in the file. pdf.js doesn't draw
//    it, but its text list still includes every word on it, so old versions of a design kept on a
//    hidden layer showed up as extra editable text.
//  · Alternate letters. A script font's swash/alternate letter (e.g. "n.alt" at the end of
//    "Perasmian") often has no "this is the letter n" entry, so pdf.js reads it as an invisible
//    control character, which the browser then draws as a box or an Apple logo.

const lib = () => globalThis.pdfjsLib;

// tc = page.getTextContent({ includeMarkedContent: true })
// -> only the text items on layers that are switched on (same order as tc.items)
export async function visibleTextItems(doc, page, tc) {
  const items = tc.items;
  const plain = () => items.filter((it) => typeof it.str === "string");
  const isOc = (it) => it.type === "beginMarkedContentProps" && it.tag === "OC";
  if (!items.some(isOc)) return plain();
  let occ, ops;
  try {
    occ = await doc.getOptionalContentConfig();
    ops = await page.getOperatorList();
  } catch (e) {
    return plain();
  }
  // the text list says "a layer starts here" but not which one; the drawing list says which,
  // in the same order
  const O = lib().OPS, groups = [];
  ops.fnArray.forEach((f, i) => {
    if (f === O.beginMarkedContentProps && ops.argsArray[i] && ops.argsArray[i][0] === "OC") groups.push(ops.argsArray[i][1]);
  });
  if (groups.length !== items.filter(isOc).length) return plain(); // can't line them up: keep everything
  const shown = (g) => { try { return occ.isVisible(g) !== false; } catch (e) { return true; } };
  const out = [], stack = [];
  let k = 0;
  for (const it of items) {
    if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
      stack.push(isOc(it) ? shown(groups[k++]) : true);
    } else if (it.type === "endMarkedContent") {
      stack.pop();
    } else if (typeof it.str === "string" && !stack.includes(false)) {
      out.push(it);
    }
  }
  return out;
}

// ------------------------------------------------------------------ letters without a Unicode entry

const NAMES = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  quoteright: "’", quoteleft: "‘", quotedblleft: "“", quotedblright: "”", parenleft: "(", parenright: ")", asterisk: "*",
  plus: "+", comma: ",", hyphen: "-", endash: "–", emdash: "—", period: ".", slash: "/", colon: ":", semicolon: ";",
  less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", bracketright: "]", underscore: "_",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl",
};

// glyph name -> text: "n.alt" -> "n", "f_f_i" -> "ffi", "uni00E9" -> "é", "A.swash" -> "A"
export function glyphText(name) {
  if (!name) return "";
  const base = String(name).split(".")[0];
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(base) || /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (uni) return String.fromCodePoint(parseInt(uni[1], 16));
  if (base.includes("_")) return base.split("_").map(glyphText).join("");
  if (/^[A-Za-z]$/.test(base)) return base;
  return NAMES[base] || "";
}

const ODD = /[\u0000-\u0009\u000B-\u001F-�]/;

// font = page.commonObjs.get(item.fontName) (needs fontExtraProperties: true when opening the file)
export function readableText(str, font) {
  if (!ODD.test(str)) return str;
  return [...str].map((c) => {
    if (!ODD.test(c)) return c;
    const code = c.codePointAt(0);
    // pdf.js passes the font's own character number when it can't tell which letter it is
    if (font && code < 0x20) {
      const name = (font.differences && font.differences[code]) || (font.defaultEncoding && font.defaultEncoding[code]);
      return glyphText(name);
    }
    return "";
  }).join("");
}

// ------------------------------------------------------------------ drawing the artwork without its text

// While fn() draws the page, no live text is painted, however pdf.js draws it. Text in a normal
// font is drawn with fillText (switched off by the canvas the caller passes in), but gradient-
// filled text, and fonts the browser can't load, are drawn letter by letter as shapes. Those
// letter shapes come from each font's getPathGenerator, which is made to draw nothing here.
// Without this, gold / gradient titles and some script fonts stayed in the background picture
// as a ghost behind the editable copy, or weren't offered as editable text at all.
export async function withoutLiveText(page, fn) {
  const O = lib().OPS, names = new Set();
  try {
    const ops = await page.getOperatorList();
    ops.fnArray.forEach((f, i) => { if (f === O.setFont && ops.argsArray[i]) names.add(ops.argsArray[i][0]); });
  } catch (e) {}
  const font = (n) => Promise.race([
    new Promise((res) => { try { page.commonObjs.get(n, res); } catch (e) { res(null); } }),
    new Promise((res) => setTimeout(() => res(null), 3000)),
  ]);
  const fonts = (await Promise.all([...names].map(font))).filter((f) => f && typeof f.getPathGenerator === "function");
  const blank = () => {};
  const saved = fonts.map((f) => [f, Object.prototype.hasOwnProperty.call(f, "getPathGenerator") ? f.getPathGenerator : undefined]);
  fonts.forEach((f) => { f.getPathGenerator = () => blank; });
  try {
    return await fn();
  } finally {
    for (const [f, own] of saved) { if (own === undefined) delete f.getPathGenerator; else f.getPathGenerator = own; }
  }
}