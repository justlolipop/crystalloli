// One imported design as it's kept (library\ on this PC, or the online database): what a save
// sends is merged over what was there. Shared by server.js and js/store.js so both keep the same.

export const ID_RE = /^[a-z0-9][a-z0-9-]{3,40}$/;
export const ORIGINAL_RE = /^library\/orig-[a-z0-9-]+\.pdf$/;
export const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

// old: the design as kept (or {}), body: what was sent -> the design to keep (background: kept as
// it was; the caller stores a new picture itself)
export function mergeItem(old, body, id, now = Date.now()) {
  const pick = (k, fallback) => (body[k] !== undefined ? body[k] : old[k] !== undefined ? old[k] : fallback);
  return {
    id,
    name: String(pick("name", "Imported")).slice(0, 160),
    file: String(pick("file", "")).slice(0, 260),
    page: +pick("page", 1) || 1,
    order: +pick("order", 0) || 0,
    source: pick("source", "pdf") === "svg" ? "svg" : "pdf",
    width: +pick("width", 600) || 600,
    height: +pick("height", 400) || 400,
    region: Array.isArray(pick("region", null)) ? pick("region", null).map(Number) : null,
    original: ORIGINAL_RE.test(pick("original", "") || "") ? pick("original", "") : null,
    texts: Array.isArray(pick("texts", [])) ? pick("texts", []) : [],
    // master template: the artwork steps left out of the background (the logo, old outlined
    // words), those words' boxes, and where this design's 3 master texts go once saved
    hide: Array.isArray(pick("hide", [])) ? pick("hide", []).map(Number).filter(Number.isInteger) : [],
    outlined: Array.isArray(pick("outlined", [])) ? pick("outlined", []) : [],
    cleaned: +pick("cleaned", 0) || 0, // autoClean (js/library.js) has been run on it
    layout: pick("layout", null) && typeof pick("layout", null) === "object" ? pick("layout", null) : null,
    svg: typeof pick("svg", null) === "string" ? pick("svg", null) : undefined,
    background: old.background,
    created: old.created || +body.created || now,
    updated: now,
  };
}

// a saved design's summary, for the Open list
export function designMeta(id, name, created, now, data, thumb) {
  return { id, name, created, updated: now, rows: Array.isArray(data.rows) ? data.rows.length : 0, thumb,
    source: String(data.sourceName || "").slice(0, 200), changed: data.edits && typeof data.edits === "object" ? Object.keys(data.edits).length : 0 };
}
