// Which imported design a row uses, from its jenis_plak (Excel column F):
// "CRYSTAL / 80-B / DESIGN 2" -> the imported file with 80-B in its name, its 2nd design (B).
// Shared by the editor (app.js) and the preview page other websites show (preview.js).

function parseJenis(v) {
  let s = String(v || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!s) return null;
  const dm = /\bDESIGN\s*([A-Z]|\d{1,2})\b/.exec(s);
  s = s.replace(/\bDESIGN\s*([A-Z]|\d{1,2})\b/, " ").replace(/\b(DTF\s+)?CRYSTAL\b/g, " ").replace(/[\/|]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? { code: s, design: dm ? dm[1] : "" } : null;
}

// the imported files, each with its designs in order
export function sources(library) {
  const groups = new Map();
  for (const it of library) {
    if (!groups.has(it.file)) groups.set(it.file, []);
    groups.get(it.file).push(it);
  }
  return [...groups].map(([file, items]) => ({ file, label: file.replace(/\.(ai|pdf|svg)$/i, ""), items: items.sort((a, b) => (a.order || 0) - (b.order || 0)) }));
}

function findSource(library, code) {
  // "R-7", "R7" and "R 7" all match a file called "CRYSTAL R-7"; "011A" also matches "0011A"
  let pat = code.replace(/[^A-Z0-9]+/g, "").split("").join("[^A-Z0-9]*");
  if (!pat) return null;
  if (/^\d/.test(pat)) pat = "0*" + pat;
  const re = new RegExp("(^|[^A-Z0-9])" + pat + "(?![A-Z0-9])");
  return sources(library).filter((s) => re.test(s.file.toUpperCase().replace(/\.(AI|PDF|SVG)$/, "")))
    .sort((a, b) => a.file.length - b.file.length)[0] || null;
}

function pickDesign(items, d) {
  if (!items.length) return null;
  if (!d) return items[0];
  const n = /^\d+$/.test(d) ? +d : d.charCodeAt(0) - 64;
  const letter = String.fromCharCode(64 + n);
  const re = new RegExp("—\\s*(DESIGN\\s*)?(" + letter + "|" + n + ")\\s*$", "i");
  return items.find((x) => re.test(x.name)) || items[n - 1] || null;
}

// undefined: no jenis_plak · null: names a crystal that isn't imported · else the design
export function templateFor(library, jenisPlak) {
  const j = parseJenis(jenisPlak);
  if (!j) return undefined;
  const src = findSource(library, j.code);
  return (src && pickDesign(src.items, j.design)) || null;
}
