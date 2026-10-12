// The fonts an imported design's words use, kept online for every computer: each font file is
// read from this PC (Chrome asks once to allow access to its fonts), put online (fonts/<PostScript
// name>.ttf / .otf) and added to the font list. A font this PC doesn't have still goes in the
// list by name: it then works on the computers that have it.

import { store } from "./store.js";
import { setFontList, setFontFiles, drawsLetters } from "./fonts.js";

// a font file that loads and really draws letters (fonts synced by Adobe and some others come out
// empty or locked: those are never put online)
async function usable(blob, ps) {
  const name = "chk_" + String(ps).replace(/[^A-Za-z0-9]/g, "_");
  try {
    const face = new FontFace(name, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    const ok = drawsLetters(name);
    document.fonts.delete(face);
    return ok;
  } catch (e) { return false; }
}

// "Teko-Bold" -> ["Teko", "Bold"]: a font not on this PC, named from its PostScript name
function guessName(ps) {
  const [fam, sty] = String(ps).split("-");
  return [fam.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/MT$|PS$/, "").trim(), (sty || "Regular").replace(/([a-z])([A-Z])/g, "$1 $2")];
}

// the fonts these designs use that aren't kept online yet
export async function fontsToShare(items) {
  if (!store.online) return [];
  const want = [...new Set((items || []).flatMap((it) => (it.texts || []).map((t) => t.ps)).filter(Boolean))];
  if (!want.length) return [];
  const [list, files] = await Promise.all([store.sharedFonts(), store.fontFiles()]);
  const listed = new Set((list || []).map((r) => r[0]));
  return want.filter((ps) => !files[ps] || !listed.has(ps));
}

// puts them online -> { shared: [ps], notHere: [ps] }; throws when Chrome won't give the fonts
// (it needs a click just before: then the caller offers a button)
export async function shareFonts(need) {
  if (!need.length) return { shared: [], notHere: [] };
  if (!window.queryLocalFonts) throw new Error("This browser can't read this computer's fonts: use Chrome or Edge.");
  const here = await window.queryLocalFonts({ postscriptNames: need });
  const files = await store.fontFiles();
  const rows = [], uploads = [], shared = [], notHere = [];
  for (const ps of need) {
    const fd = here.find((f) => f.postscriptName === ps);
    if (!fd) { notHere.push(ps); rows.push([ps, ...guessName(ps)]); continue; }
    rows.push([ps, fd.family, fd.style]);
    if (files[ps]) continue;
    const blob = await fd.blob();
    if (!(await usable(blob, ps))) { notHere.push(ps); continue; }
    const head = String.fromCharCode(...new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
    const ext = head === "OTTO" ? "otf" : "ttf";
    uploads.push({ file: `fonts/${ps}.${ext}`, blob, type: "font/" + ext });
    shared.push(ps);
  }
  await store.addFonts(rows, uploads);
  try { setFontFiles(await store.fontFiles()); setFontList(await store.fonts()); } catch (e) {}
  return { shared, notHere };
}
