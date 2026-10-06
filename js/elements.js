// Every element of a design on its own layer — the logo, each line of outlined text, the frame,
// the flowers… — so each one can be moved and the real artwork under it shows.
//
// pdf.js turns a page into a list of drawing instructions. Each instruction that paints something
// (a filled shape, a line, a gradient, a picture) gets the box it covers on the page. Then:
//   · things painted one after another that touch are one piece (the letters of a word, the parts
//     of a logo); a line of letters side by side is a line of outlined text
//   · a white outline painted under the letters joins its text; the words on a logo's ribbon join
//     the logo
//   · the thousands of specks of a traced picture (flowers, swirls) that touch become one piece of
//     artwork; the crystal's cut line stays on its own
// To draw one element, the page is drawn again with every instruction that paints something else
// switched off for that one drawing.

const O = pdfjsLib.OPS;
const PATH_PAINT = new Set([O.fill, O.eoFill, O.stroke, O.closeStroke, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
const STROKES = new Set([O.stroke, O.closeStroke]);
const PICTURES = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintSolidColorImageMask]);
const OTHER_PAINT = new Set([O.shadingFill, O.paintImageXObject, O.paintInlineImageXObject, O.paintInlineImageXObjectGroup,
  O.paintImageMaskXObject, O.paintImageMaskXObjectGroup, O.paintImageXObjectRepeat, O.paintImageMaskXObjectRepeat, O.paintSolidColorImageMask]);
const PATH_ARGS = { [O.moveTo]: 2, [O.lineTo]: 2, [O.curveTo]: 6, [O.curveTo2]: 4, [O.curveTo3]: 4, [O.closePath]: 0, [O.rectangle]: 4 };
const NONE = [];

export const KIND_NAME = { cut: "Cut line", line: "Line", text: "Outlined text", graphic: "Logo / picture", art: "Artwork", plate: "Background" };

// ------------------------------------------------------------------ pdf.js plumbing

// pdf.js paces a drawing with requestAnimationFrame, which stops while the tab is in the
// background and waits a screen frame between chunks; splitting a sheet draws it dozens of times,
// so meanwhile chunks follow each other straight away.
let fast = 0, realRaf = null;
const frames = new MessageChannel(), queued = [];
frames.port1.onmessage = () => queued.splice(0).forEach((f) => f(performance.now()));
export async function fastFrames(fn) {
  if (!fast++) {
    realRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (f) => { queued.push(f); frames.port2.postMessage(0); return 0; };
  }
  try {
    return await fn();
  } finally {
    if (!--fast) window.requestAnimationFrame = realRaf;
  }
}

// one drawing at a time on a page while its instruction list is being switched off and on
let queue = Promise.resolve();
export function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// The instruction list pdf.js keeps for drawing this page on screen (there after the page was
// drawn once). null if this pdf.js keeps it somewhere else — then designs just aren't split.
function drawingList(page) {
  const states = page._intentStates;
  if (!states || typeof states.values !== "function") return null;
  for (const s of states.values()) {
    const l = s && s.displayReadyCapability && s.operatorList;
    if (l && l.lastChunk && Array.isArray(l.fnArray) && Array.isArray(l.argsArray)) return l;
  }
  return null;
}

const plans = new WeakMap();
// -> { list, match, items } for a page that has been drawn once, or null
export function pagePlan(page) {
  const list = drawingList(page);
  if (!list) return null;
  let p = plans.get(page);
  if (p && p.list === list) return p;
  const F = list.fnArray, match = new Int32Array(F.length).fill(-1), open = [];
  for (let i = 0; i < F.length; i++) {
    if (F[i] === O.save) open.push(i);
    else if (F[i] === O.restore && open.length) match[open.pop()] = i;
  }
  p = { list, match, items: paintedThings(list, page.getViewport({ scale: 1 }).transform) };
  plans.set(page, p);
  return p;
}

// While fn() draws the page, everything except the instructions `ops` paints nothing.
export async function drawOnly(plan, ops, fn) {
  const { list, match } = plan;
  const F = list.fnArray, A = list.argsArray, N = F.length;
  const keep = new Uint8Array(N);
  for (const i of ops) keep[i] = 1;
  const before = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) before[i + 1] = before[i] + keep[i];
  const changed = [], oldF = [], oldA = [];
  const set = (i, f, a) => { changed.push(i); oldF.push(F[i]); oldA.push(A[i]); F[i] = f; A[i] = a; };
  for (let i = 0; i < N; i++) {
    const f = F[i];
    if (f === O.save && match[i] > i && before[match[i] + 1] === before[i]) {
      // a whole q…Q block that paints nothing we want (its "load this font/picture" steps stay)
      for (let k = i; k <= match[i]; k++) if (F[k] !== O.dependency) set(k, O.dependency, NONE);
      i = match[i];
    } else if (keep[i]) {
      continue;
    } else if (PATH_PAINT.has(f)) {
      if (F[i - 1] === O.constructPath) { set(i - 1, O.dependency, NONE); set(i, O.dependency, NONE); }
      else set(i, O.endPath, null); // still uses up the shape (and a clip waiting on it)
    } else if (OTHER_PAINT.has(f)) {
      set(i, O.dependency, NONE);
    }
  }
  try {
    return await fn();
  } finally {
    for (let k = changed.length - 1; k >= 0; k--) { F[changed[k]] = oldF[k]; A[changed[k]] = oldA[k]; }
  }
}

// ------------------------------------------------------------------ what gets painted, and where

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const hex = (c) => "#" + [c[0], c[1], c[2]].map((v) => (v | 0).toString(16).padStart(2, "0")).join("");
const meet = (a, b) => (!a ? b : !b ? a : [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);

function boxOf(pts, m) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    const X = m[0] * pts[k] + m[2] * pts[k + 1] + m[4], Y = m[1] * pts[k] + m[3] * pts[k + 1] + m[5];
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
  }
  return [x0, y0, x1, y1];
}

function pathBox(args, m) {
  const pts = [], p = args[1];
  let j = 0;
  for (const op of args[0]) {
    if (op === O.rectangle) pts.push(p[j], p[j + 1], p[j] + p[j + 2], p[j + 1], p[j], p[j + 1] + p[j + 3], p[j] + p[j + 2], p[j + 1] + p[j + 3]);
    else for (let k = 0; k < PATH_ARGS[op]; k++) pts.push(p[j + k]);
    j += PATH_ARGS[op] || 0;
  }
  return boxOf(pts, m);
}

// Each instruction that paints: its box in pt from the page's top-left, colour, kind and blend mode.
function paintedThings(list, start) {
  const F = list.fnArray, A = list.argsArray;
  let st = { m: start, fill: "#000000", stroke: "#000000", clip: null, lw: 1, bm: "source-over", gbm: null };
  const stack = [], items = [];
  let path = null;
  for (let i = 0; i < F.length; i++) {
    const f = F[i], a = A[i];
    if (f === O.save) stack.push({ ...st });
    else if (f === O.restore) st = stack.pop() || st;
    else if (f === O.transform) st.m = mul(st.m, a);
    else if (f === O.paintFormXObjectBegin) {
      stack.push({ ...st });
      if (a[0]) st.m = mul(st.m, a[0]);
      if (a[1]) { const b = a[1]; st.clip = meet(st.clip, boxOf([b[0], b[1], b[2], b[1], b[0], b[3], b[2], b[3]], st.m)); }
    } else if (f === O.paintFormXObjectEnd) st = stack.pop() || st;
    else if (f === O.beginGroup) { stack.push({ ...st }); if (!st.gbm && st.bm !== "source-over") st.gbm = st.bm; }
    else if (f === O.endGroup) st = stack.pop() || st;
    else if (f === O.setFillRGBColor) st.fill = hex(a);
    else if (f === O.setStrokeRGBColor) st.stroke = hex(a);
    else if (f === O.setLineWidth) st.lw = a[0];
    else if (f === O.setGState) { for (const [k, v] of a[0]) { if (k === "BM") st.bm = v; else if (k === "LW") st.lw = v; } }
    else if (f === O.constructPath) path = pathBox(a, st.m);
    else if (f === O.clip || f === O.eoClip) st.clip = meet(st.clip, path);
    else if (PATH_PAINT.has(f) || OTHER_PAINT.has(f)) {
      let b;
      if (f === O.shadingFill) b = st.clip;
      else if (PICTURES.has(f)) b = boxOf([0, 0, 1, 0, 0, 1, 1, 1], st.m);
      else if (OTHER_PAINT.has(f)) b = st.clip;
      else {
        b = path;
        if (b && f !== O.fill && f !== O.eoFill) { const s = Math.hypot(st.m[0], st.m[1]) * (st.lw || 1) / 2 + 0.5; b = [b[0] - s, b[1] - s, b[2] + s, b[3] + s]; }
      }
      b = meet(b, st.clip);
      path = null;
      if (!b || !(b[2] > b[0]) || !(b[3] > b[1])) continue;
      items.push({
        op: i, x0: b[0], y0: b[1], x1: b[2], y1: b[3], stroke: STROKES.has(f), path: PATH_PAINT.has(f),
        color: STROKES.has(f) ? st.stroke : PATH_PAINT.has(f) ? st.fill : "", bm: st.gbm || st.bm,
        lw: STROKES.has(f) ? Math.hypot(st.m[0], st.m[1]) * (st.lw || 1) : 0,
      });
    }
  }
  return items;
}

// ------------------------------------------------------------------ which things make one element

const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const gap = (a, b) => Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);
const cover = (a, b) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};
const grow = (e, b) => { e.x0 = Math.min(e.x0, b.x0); e.y0 = Math.min(e.y0, b.y0); e.x1 = Math.max(e.x1, b.x1); e.y1 = Math.max(e.y1, b.y1); };
const sameLine = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) >= 0.6 * Math.min(a.y1 - a.y0, b.y1 - b.y0);

function unionFind(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (p[i] !== i) i = p[i] = p[p[i]]; return i; };
  return { find, join: (i, j) => { p[find(i)] = find(j); } };
}

// Elements of the design inside region R ({ x, y, w, h } in pt, page top-left), bottom to top:
// [{ kind, x0, y0, x1, y1, ops, blend }]
export function findElements(all, R) {
  const A = R.w * R.h;
  const its = [];
  for (const it of all) {
    const x0 = Math.max(it.x0, R.x), y0 = Math.max(it.y0, R.y), x1 = Math.min(it.x1, R.x + R.w), y1 = Math.min(it.y1, R.y + R.h);
    if (x1 - x0 > 0.05 && y1 - y0 > 0.05) its.push({ ...it, x0, y0, x1, y1 });
  }
  const isOutline = (it) => it.stroke && (it.x1 - it.x0 > R.w * 0.85 || it.y1 - it.y0 > R.h * 0.85);

  // 1) runs: painted one after another and touching (a big shape never joins the small thing before it)
  const runs = [];
  let cur = null, prev = null;
  for (const it of its) {
    const out = isOutline(it);
    const h = Math.max(it.y1 - it.y0, prev ? prev.y1 - prev.y0 : 0);
    const swallows = cur && area(it) > 4 * area(cur) && area(it) > A * 0.01;
    const join = cur && !swallows && out === (cur.cls === "outline") && (out
      ? gap(it, cur) <= 3
      : gap(it, prev) <= Math.max(0.75, 0.6 * h) || (area(cur) < A * 0.15 && cover(it, cur) > 0.5 * area(it)));
    if (!join) { cur = { cls: out ? "outline" : null, x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1, items: [] }; runs.push(cur); }
    grow(cur, it);
    cur.items.push(it);
    prev = it;
  }

  // 2) a line of text: several shapes side by side, left to right, about the same height
  for (const r of runs) {
    if (r.cls) continue;
    const n = r.items.length, w = r.x1 - r.x0, h = r.y1 - r.y0;
    const med = r.items.map((it) => it.y1 - it.y0).sort((a, b) => a - b)[n >> 1];
    let fwd = 0;
    for (let k = 1; k < n; k++) if (r.items[k].x0 >= r.items[k - 1].x0 - 0.3 * med) fwd++;
    const text = n >= 3 && r.items.every((it) => it.path) && w >= 1.8 * h && med >= 0.3 * h && fwd >= 0.7 * (n - 1) && area(r) < A * 0.25;
    r.cls = text ? "text" : "art";
    r.small = !text && area(r) < A * 0.004;
  }

  // 3) runs that belong together
  const U = unionFind(runs.length);
  for (let i = 0; i < runs.length; i++) {
    const a = runs[i];
    if (a.cls === "outline") continue;
    for (let j = i + 1; j < Math.min(runs.length, i + 9); j++) {
      const b = runs[j];
      if (b.cls === "outline") continue;
      const c = cover(a, b), small = Math.min(area(a), area(b));
      if (a.cls === "text" && b.cls === "text") {
        // an outline painted under the letters, or the next word on the same line
        if (c >= 0.5 * small || (j === i + 1 && sameLine(a, b) && gap(a, b) <= Math.min(a.y1 - a.y0, b.y1 - b.y0))) U.join(i, j);
      } else if (a.cls === "art" && b.cls === "art") {
        // the parts of one logo
        if (j <= i + 6 && area(a) < A * 0.25 && area(b) < A * 0.25 && (c >= 0.5 * small || (j === i + 1 && !a.small && !b.small && c >= 0.3 * small))) U.join(i, j);
      } else if (a.cls === "art" && b.cls === "text") {
        // the words on a logo's ribbon
        if (j <= i + 6 && !a.small && area(a) < A * 0.15 && c >= 0.9 * area(b)) U.join(i, j);
      }
    }
  }
  const byRoot = new Map();
  runs.forEach((r, i) => {
    const k = U.find(i);
    if (!byRoot.has(k)) byRoot.set(k, { cls: r.cls, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, items: [], lo: i, hi: i });
    const o = byRoot.get(k);
    grow(o, r);
    o.items.push(...r.items);
    o.hi = i;
    if (r.cls === "art") o.cls = "art";
  });
  const objs = [...byRoot.values()];

  // what each one is. Something painted in the middle of a traced picture's specks is more of it.
  const specks = [0];
  runs.forEach((r, i) => specks.push(specks[i] + (r.small ? 1 : 0)));
  const speckly = (s, e) => { s = Math.max(0, s); e = Math.min(runs.length, e); return e - s >= 5 && (specks[e] - specks[s]) / (e - s) >= 0.6; };
  for (const o of objs) {
    if (o.cls === "outline") continue;
    const w = o.x1 - o.x0, h = o.y1 - o.y0, a = area(o);
    const inPicture = a < A * 0.03 && speckly(o.lo - 10, o.lo) && speckly(o.hi + 1, o.hi + 11);
    if (o.cls === "text") { if (inPicture || a < A * 0.0006) o.cls = "art"; continue; }
    if (!inPicture && o.items.length >= 15 && a >= A * 0.003 && a < A * 0.12 && Math.max(w / h, h / w) <= 3) o.cls = "graphic";
    else if (a > A * 0.5) o.cls = "plate";
  }

  // 4) loose artwork that touches is one piece of artwork
  const V = unionFind(objs.length), grid = new Map(), CELL = 8, REACH = 1.5;
  objs.forEach((o, i) => {
    if (o.cls !== "art") return;
    for (let gx = Math.floor((o.x0 - REACH) / CELL); gx <= Math.floor((o.x1 + REACH) / CELL); gx++) {
      for (let gy = Math.floor((o.y0 - REACH) / CELL); gy <= Math.floor((o.y1 + REACH) / CELL); gy++) {
        const k = gx * 65536 + gy, list = grid.get(k);
        if (!list) { grid.set(k, [i]); continue; }
        for (const j of list) if (V.find(i) !== V.find(j) && gap(o, objs[j]) <= REACH) V.join(i, j);
        list.push(i);
      }
    }
  });
  const groups = new Map();
  objs.forEach((o, i) => {
    const k = V.find(i);
    if (!groups.has(k)) groups.set(k, { cls: o.cls, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, items: [] });
    const g = groups.get(k);
    grow(g, o);
    g.items.push(...o.items);
  });
  let els = [...groups.values()];

  // crumbs (a lone speck) join the nearest artwork
  const big = els.filter((e) => e.cls === "art" && area(e) >= A * 0.004);
  els = els.filter((e) => {
    if (e.cls !== "art" || area(e) >= A * 0.004) return true;
    let best = null, bd = 12;
    for (const b of big) { const d = gap(e, b); if (d <= bd) { bd = d; best = b; } }
    if (!best) return true;
    grow(best, e);
    best.items.push(...e.items);
    return false;
  });

  return els.map((e) => {
    const ops = e.items.map((it) => it.op).sort((a, b) => a - b);
    const blends = new Set(e.items.map((it) => it.bm));
    const wide = e.x1 - e.x0 >= R.w * 0.9 || e.y1 - e.y0 >= R.h * 0.9;
    return {
      kind: e.cls === "outline" ? (wide ? "cut" : "line") : e.cls, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, ops,
      blend: blends.size === 1 && !blends.has("source-over") ? [...blends][0] : null,
    };
  }).sort((a, b) => a.ops[0] - b.ops[0]);
}
