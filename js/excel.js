// Excel / CSV -> { columns: [{key, label}], rows: [{key: value}] }
// Known headers become the same field names the plak templates use (event_header, position, ...),
// so a sheet made for Plak Master / the master order form drops straight in.

const ALIASES = {
  event_header: ["event header", "header", "tajuk", "majlis", "nama majlis", "event", "acara"],
  position: ["position", "kedudukan", "anugerah", "award", "tempat", "rank", "pc"],
  event_line_1: ["event line 1", "event line1", "line 1", "line1", "baris 1", "l1"],
  event_line_2: ["event line 2", "event line2", "line 2", "line2", "baris 2", "l2"],
  event_line_3: ["event line 3", "event line3", "line 3", "line3", "baris 3", "l3"],
  year: ["year"],
  jenis_plak: ["jenis plak", "code", "kod", "kod plak", "product code", "plak"],
  category: ["category", "kategori"],
  qty: ["qty", "quantity", "kuantiti", "pcs"],
};

const slug = (label) => String(label).trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "") || "col";

export function fieldForHeader(label) {
  const k = slug(label);
  const spaced = k.replace(/_/g, " ");
  for (const [f, list] of Object.entries(ALIASES)) if (f === k || list.includes(spaced)) return f;
  return k;
}

export async function readWorkbook(file) {
  if (/\.(csv|txt)$/i.test(file.name)) {
    const text = (await file.text()).replace(/^﻿/, "");
    return XLSX.read(text, { type: "string", raw: false });
  }
  return XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
}

function aoaOf(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws || !ws["!ref"]) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false, blankrows: false });
}

export function usableSheets(wb) {
  return wb.SheetNames.filter((n) => aoaOf(wb, n).length > 1);
}

// The master order workbook keeps its CSV rows on a sheet called EXPORT — prefer that.
export function defaultSheet(wb) {
  const ok = usableSheets(wb);
  return ok.find((n) => n.trim().toUpperCase() === "EXPORT") || ok[0] || wb.SheetNames[0];
}

export function readSheet(wb, name) {
  const aoa = aoaOf(wb, name);
  // header = first row with at least 2 filled cells (forms often have a title above the table)
  let h = aoa.findIndex((r) => r.filter((c) => String(c).trim()).length >= 2);
  if (h < 0) h = 0;
  const columns = [];
  const used = {};
  (aoa[h] || []).forEach((label, index) => {
    label = String(label).trim();
    if (!label) return;
    let key = fieldForHeader(label);
    if (used[key]) key = key + "_" + ++used[key];
    else used[key] = 1;
    columns.push({ key, label, index });
  });
  const rows = [];
  for (let r = h + 1; r < aoa.length; r++) {
    const src = aoa[r];
    const row = {};
    let any = false;
    for (const c of columns) {
      const v = String(src[c.index] ?? "").replace(/\r\n?/g, "\n").trim();
      row[c.key] = v;
      if (v) any = true;
    }
    if (any) rows.push(row);
  }
  return { columns: columns.map(({ key, label }) => ({ key, label })), rows };
}
