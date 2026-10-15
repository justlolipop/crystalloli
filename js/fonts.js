// Fonts come from this PC — the same ones Illustrator uses. Each PostScript name gets its own
// @font-face pointing at local("<PostScript name>"), so "Myriad Pro Bold Condensed" really is that
// face and not the browser's guess at "Myriad Pro" + bold.

const faces = {}; // ps -> { css, ok, fallback, promise }
let rows = [], byPs = {}, byLabel = {};

// font files kept online (PostScript name -> address), used when this computer doesn't have the font
let files = {};
// the free crystal fonts (SIL Open Font License, see fonts/OFL-*.txt) come with the studio, so
// every computer shows them even without them installed or shared (fonts/install/ has them to
// install for Illustrator); Britannic Bold isn't free to hand out: it comes from the PC, or from
// "Share fonts"
const BUILT_IN = Object.fromEntries(["Teko-Bold", "Playball-Regular", "KaushanScript-Regular", "GreatVibes-Regular",
  "Montserrat-Bold", "Poppins-BoldItalic", "Oswald-Bold", "BarlowCondensed-Bold"]
  .map((ps) => [ps, new URL(`../fonts/${ps}.woff2`, import.meta.url).href]));
export function setFontFiles(map) { files = map && typeof map === "object" ? map : {}; }

export const fontLabel = (r) => `${r[1]} ${r[2]}`.trim();
const cssName = (ps) => "ps_" + String(ps).replace(/[^A-Za-z0-9]/g, "_");

// The only fonts offered for the crystal's words: the J&E crystal's three (header, award, name), and
// free ones like those on the crystal designs (brush and fine script titles, wide, italic and tall
// narrow capitals)
export const CRYSTAL_FONTS = [["Teko-Bold", "Teko", "Bold"], ["Playball-Regular", "Playball", "Regular"], ["BritannicBold", "Britannic Bold", "Regular"],
  ["KaushanScript-Regular", "Kaushan Script", "Regular"], ["GreatVibes-Regular", "Great Vibes", "Regular"],
  ["Montserrat-Bold", "Montserrat", "Bold"], ["Poppins-BoldItalic", "Poppins", "Bold Italic"],
  ["Oswald-Bold", "Oswald", "Bold"], ["BarlowCondensed-Bold", "Barlow Condensed", "Bold"]];

// rows: [[postscriptName, family, style], ...] (the font list kept online / on this PC). Only the
// three crystal fonts are offered in the font box, whatever else is in the list.
export function setFontList(list) {
  rows = [];
  byPs = {};
  byLabel = {};
  for (const r of list || []) {
    if (!r || !r[0] || byPs[r[0]]) continue;
    byPs[r[0]] = r; // other fonts still known by name (a design's own words), not offered
  }
  for (const base of CRYSTAL_FONTS) {
    const r = byPs[base[0]] || base;
    rows.push(r);
    byPs[r[0]] = r;
    byLabel[fontLabel(r).toLowerCase()] = r;
  }
  const sel = document.getElementById("fFont");
  if (sel && sel.tagName === "SELECT") {
    sel.innerHTML = rows.map((r) => `<option value="${fontLabel(r).replace(/"/g, "&quot;")}">${fontLabel(r).replace(/</g, "&lt;")}</option>`).join("");
  }
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
    const locals = [ps, `${fam} ${sty}`.trim(), fam].filter(Boolean).map((n) => `local("${n.replace(/["\\]/g, "")}")`);
    const online = [files[ps], BUILT_IN[ps]].filter(Boolean).map((u) => `url("${u.replace(/["\\]/g, "")}")`);
    const entry = { css: cssName(ps), ok: null, fallback: fam ? `"${fam.replace(/"/g, "")}", sans-serif` : "Arial" };
    entry.promise = (async () => {
      // this PC's font first, else the one kept online; a font that loads but draws no letters (a
      // broken or locked file) is not used
      for (const srcs of [locals.concat(online), locals]) {
        if (!srcs.length) continue;
        try {
          const face = new FontFace(entry.css, srcs.join(", "));
          await face.load();
          document.fonts.add(face);
          if (drawsLetters(entry.css)) { entry.ok = true; break; }
          document.fonts.delete(face);
        } catch (e) { /* try the next */ }
        if (srcs === locals) break;
      }
      if (!entry.ok) entry.ok = false;
      return entry.ok ? entry.css : entry.fallback;
    })();
    faces[ps] = entry;
  }
  return faces[ps].promise;
}

// does this font really draw letters? (some font files load fine but are empty or locked)
export function drawsLetters(css) {
  try {
    const c = document.createElement("canvas");
    c.width = 120; c.height = 60;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.font = `40px "${css}", serif`;
    if (!(x.measureText("HAMBURG").width > 10)) return false;
    x.fillText("HAM", 4, 46);
    const d = x.getImageData(0, 0, 120, 60).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  } catch (e) { return true; }
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
