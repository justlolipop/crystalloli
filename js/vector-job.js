// The crystals as an Illustrator job (illustrator.js, "master" rows): each one made from its
// original .ai in Illustrator, so the artwork stays vector and editable, with what the studio took
// out of it (logo, old words) removed and the studio's texts (and pictures added there) put in as
// editable text in their own look. A design without its original .ai (too big to keep online)
// can't be made this way: it's returned in "without".

import { textsOf, imagesOf } from "./editor.js";
import { removedBoxes } from "./library.js";
import { fileUrl } from "./store.js";

const hex = (c) => {
  if (!c || typeof c !== "string") return null;
  try { return "#" + new fabric.Color(c).toHex().toLowerCase(); } catch (e) { return null; }
};

// The printer's platform (pt): 84 x 24 in. Crystals from the bottom right, leftwards, then the next
// row up; margins and gaps as on the hand-made PRINT AREA (PLATFORM).ai (12 to a row, 2 rows; the left margin a little under the 740 measured, so 12 fit).
export const PLATFORM = { w: 6048, h: 1728, left: 700, right: 276, top: 72, bottom: 184, gapX: 90, gapY: 92 };

const clean = (s, n) => String(s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// list: [{ item, entry (as renderOffscreen takes it), name, qty? }] -> { job: { outline: false, rows }, without: [indexes] }
export async function vectorJob(list, label) {
  const rows = [], without = [];
  for (const [i, x] of list.entries()) {
    const it = x.item;
    if (!it || it.source !== "pdf" || !it.original) { without.push(i); continue; }
    const bare = x.entry.state ? { state: x.entry.state, images: [], logo: x.entry.logo } : { scene: { ...x.entry.scene, images: [] }, logo: x.entry.logo };
    const texts = (await textsOf(bare)).filter((t) => String(t.text).trim()).map((t) => ({
      now: { ...t, fill: hex(t.fill), stroke: hex(t.stroke), outer: hex(t.outer) },
    }));
    rows.push({
      row: rows.length + 1, file: it.file, original: it.original, originalUrl: fileUrl(it.original),
      page: it.page || 1, region: it.region || [0, 0, it.width, it.height], name: x.name,
      // what was taken out of the design — never an area over a big part of it (Illustrator would
      // take the whole background with it)
      master: true, remove: (await removedBoxes(it).catch(() => [])).filter((b) => (b.r - b.l) * (b.b - b.t) <= it.width * it.height * 0.35),
      texts, images: await imagesOf(bare),
      // how many of this crystal: as many copies of it on the print platform
      qty: Math.max(1, Math.min(500, Math.round(+x.qty) || 1)),
      // its design (jenis plak): each design gets its own platform file
      // the first line of its header (the school), for the file names
      header: clean(String(x.header || "").split("\n")[0], 60),
      design: String(x.design || it.name || "").replace(/^\s*(DTF\s+)?CRYSTAL\s*\/\s*/i, "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60),
    });
  }
  // more than one crystal: all on the print platform, as laid out by hand (PRINT AREA (PLATFORM).ai)
  const pieces = rows.reduce((n, r) => n + r.qty, 0);
  // the folder's name: the header most crystals have (the school), and the order
  const count = {};
  for (const r of rows) if (r.header) count[r.header] = (count[r.header] || 0) + r.qty;
  const school = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || "";
  const order = clean(label, 30);
  const tag = clean(school && order ? `${school} (${order})` : school || order, 80);
  return { job: { outline: false, rows, ...(pieces > 1 ? { platform: PLATFORM } : {}), ...(tag ? { label: tag } : {}) }, without };
}
