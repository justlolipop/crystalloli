// Fonts come from this PC — the same ones Illustrator uses. Each PostScript name gets its own
// @font-face pointing at local("<PostScript name>"), so "Myriad Pro Bold Condensed" really is that
// face and not the browser's guess at "Myriad Pro" + bold.

const faces = {}; // ps -> { css, ok, fallback, promise }
let rows = [], byPs = {}, byLabel = {};

// font files kept online (PostScript name -> address), used when this computer doesn't have the font
let files = {};
export function setFontFiles(map) { files = map && typeof map === "object" ? map : {}; }

export const fontLabel = (r) => `${r[1]} ${r[2]}`.trim();
const cssName = (ps) => "ps_" + String(ps).replace(/[^A-Za-z0-9]/g, "_");

// rows: [[postscriptName, family, style], ...] (webapp/templates/_fonts.json, written by the scan)
export function setFontList(list) {
  rows = [];
  byPs = {};
  byLabel = {};
  for (const r of list || []) {
    if (!r || !r[0] || byPs[r[0]]) continue;
    rows.push(r);
    byPs[r[0]] = r;
    byLabel[fontLabel(r).toLowerCase()] = r;
  }
  const dl = document.getElementById("fontList");
  if (dl) dl.innerHTML = rows.map((r) => `<option value="${fontLabel(r).replace(/"/g, "&quot;")}"></option>`).join("");
}

// What someone typed in the font box -> PostScript name (or null)
export function findFont(text) {
  const t = String(text || "").trim().replace(/^['"]|['"]$/g, "");
  if (!t) return null;
  if (byPs[t]) return t;
  const r = byLabel[t.toLowerCase()];
  return r ? r[0] : null;
}

export function describeFont(ps) {
  const r = byPs[ps];
  return r ? fontLabel(r) : ps;
}

// Registers + loads the face. Resolves to the CSS family to draw with (a fallback if the font
// isn't installed on this PC).
export function useFont(ps, family, style) {
  if (!ps) return Promise.resolve(family ? `"${family}", sans-serif` : "Arial");
  if (!faces[ps]) {
    const r = byPs[ps];
    const fam = family || (r && r[1]) || "";
    const sty = style || (r && r[2]) || "";
    const srcs = [ps, `${fam} ${sty}`.trim(), fam].filter(Boolean)
      .map((n) => `local("${n.replace(/["\\]/g, "")}")`).concat(files[ps] ? [`url("${files[ps].replace(/["\\]/g, "")}")`] : []).join(", ");
    const entry = { css: cssName(ps), ok: null, fallback: fam ? `"${fam.replace(/"/g, "")}", sans-serif` : "Arial" };
    entry.promise = (async () => {
      try {
        const face = new FontFace(entry.css, srcs);
        document.fonts.add(face);
        await face.load();
        entry.ok = true;
      } catch (e) {
        entry.ok = false;
      }
      return entry.ok ? entry.css : entry.fallback;
    })();
    faces[ps] = entry;
  }
  return faces[ps].promise;
}

export function missingFonts() {
  return Object.entries(faces).filter(([, f]) => f.ok === false).map(([ps]) => describeFont(ps));
}

// css family -> PostScript name, so an exported SVG asks Illustrator for the real font
export function cssToPs() {
  const m = {};
  for (const [ps, f] of Object.entries(faces)) m[f.css] = ps;
  return m;
}

export function fallbackFor(ps) {
  const f = faces[ps];
  return f && f.ok === false ? f.fallback : null;
}
