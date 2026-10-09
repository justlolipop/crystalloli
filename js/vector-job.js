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

// list: [{ item, entry (as renderOffscreen takes it), name }] -> { job: { outline: false, rows }, without: [indexes] }
export async function vectorJob(list) {
  const rows = [], without = [];
  for (const [i, x] of list.entries()) {
    const it = x.item;
    if (!it || it.source !== "pdf" || !it.original) { without.push(i); continue; }
    const bare = x.entry.state ? { state: x.entry.state, images: [] } : { scene: { ...x.entry.scene, images: [] } };
    const texts = (await textsOf(bare)).filter((t) => String(t.text).trim()).map((t) => ({
      now: { ...t, fill: hex(t.fill), stroke: hex(t.stroke), outer: hex(t.outer) },
    }));
    rows.push({
      row: rows.length + 1, file: it.file, original: it.original, originalUrl: fileUrl(it.original),
      page: it.page || 1, region: it.region || [0, 0, it.width, it.height], name: x.name,
      master: true, remove: await removedBoxes(it).catch(() => []), texts, images: await imagesOf(bare),
    });
  }
  return { job: { outline: false, rows }, without };
}
