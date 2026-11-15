// Minimal streaming .xlsx reader (cell values + cell fill colors). Shared by start.js and results.js.
// Reads the first sheet, including rows hidden by a filter. Stops early once it runs into a long stretch of empty rows
// (Google Sheets / Excel exports often carry a million blank formatted rows).
const XLSX_MAX_EMPTY_ROWS = 3000;
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const unesc = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");

async function zipEntries(file) {
  const size = file.size, tailLen = Math.min(size, 65557);
  const tail = new Uint8Array(await file.slice(size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("this is not a valid .xlsx file");
  const count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const out = {}; let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10), csize = u32(cd, p + 20), nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32), lho = u32(cd, p + 42);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nlen));
    out[name] = { method, csize, lho };
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
async function entryStream(file, ent) {
  if (!ent) throw new Error("the file is missing a required part");
  const lh = new Uint8Array(await file.slice(ent.lho, ent.lho + 30).arrayBuffer());
  const start = ent.lho + 30 + u16(lh, 26) + u16(lh, 28);
  let st = file.slice(start, start + ent.csize).stream();
  if (ent.method === 8) st = st.pipeThrough(new DecompressionStream("deflate-raw"));
  else if (ent.method !== 0) throw new Error("unsupported zip compression");
  return st.pipeThrough(new TextDecoderStream());
}
async function entryText(file, ent) {
  const r = (await entryStream(file, ent)).getReader(); let s = "";
  for (;;) { const { value, done } = await r.read(); if (done) break; s += value; }
  return s;
}
function parseShared(xml) {
  const out = [], re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g; let m;
  while ((m = re.exec(xml))) {
    let t = ""; const tr = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let k;
    while ((k = tr.exec(m[1] || ""))) t += k[1];
    out.push(unesc(t));
  }
  return out;
}
// style index -> fill rgb (6 hex), "THEME"/"OTHER", or null for no fill
function parseStyles(xml) {
  const fillsXml = (/<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml) || [])[1] || "";
  const fills = []; let m;
  const fr = /<fill\b[^>]*>([\s\S]*?)<\/fill>/g;
  while ((m = fr.exec(fillsXml))) {
    if (!/patternType="solid"/.test(m[1])) { fills.push(null); continue; }
    const rgb = /<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(m[1]);
    fills.push(rgb ? rgb[1].slice(-6).toUpperCase() : (/<fgColor\b/.test(m[1]) ? "THEME" : "OTHER"));
  }
  const xfXml = (/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml) || [])[1] || "";
  const xfs = [], xr = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
  while ((m = xr.exec(xfXml))) { const f = /\bfillId="(\d+)"/.exec(m[1]); xfs.push(f ? (fills[+f[1]] || null) : null); }
  return xfs;
}
function fillClass(rgb) {
  if (!rgb) return "NONE";
  if (rgb === "THEME" || rgb === "OTHER") return "OTHER";
  const r = parseInt(rgb.slice(0, 2), 16), g = parseInt(rgb.slice(2, 4), 16), b = parseInt(rgb.slice(4, 6), 16);
  if (r > 235 && g > 235 && b > 235) return "NONE";
  if (g > r + 25 && g > b + 25) return "GREEN";
  if (r > 150 && r > g + 40 && Math.abs(g - b) <= 40) return "RED";
  if (r > 200 && g >= 110 && b < 100) return "ORANGE";
  return "OTHER";
}
function normId(v) {
  let s = String(v == null ? "" : v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  else if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) { const n = Number(s); if (Number.isFinite(n)) s = String(BigInt(Math.round(n))); }
  return s.replace(/^["'`(\[{<]+|["'`)\]}>.:]+$/g, "");
}

async function readXlsx(file, onProgress) {
  const ents = await zipEntries(file);
  const wb = await entryText(file, ents["xl/workbook.xml"]);
  const rels = await entryText(file, ents["xl/_rels/workbook.xml.rels"]);
  const sh = /<sheet\b[^>]*?\br:id="([^"]+)"/.exec(wb);
  if (!sh) throw new Error("no sheet found in the file");
  let target = null;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0]), t = /\bTarget="([^"]+)"/.exec(m[0]);
    if (id && t && id[1] === sh[1]) target = t[1];
  }
  if (!target) throw new Error("could not locate the first sheet");
  const path = target.startsWith("/") ? target.slice(1) : "xl/" + target;
  const shared = ents["xl/sharedStrings.xml"] ? parseShared(await entryText(file, ents["xl/sharedStrings.xml"])) : [];
  const xfs = ents["xl/styles.xml"] ? parseStyles(await entryText(file, ents["xl/styles.xml"])) : [];

  const rows = []; let emptyRun = 0, stop = false, bytes = 0;
  function parseRow(tag, inner) {
    const r = +((/\br="(\d+)"/.exec(tag) || [])[1] || 0);
    const hidden = /\bhidden="(1|true)"/.test(tag);
    const cells = {}; let any = false;
    for (const m of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = m[1], body = m[2];
      const ref = /\br="([A-Z]+)\d+"/.exec(at);
      if (!ref || body == null) continue;
      const t = (/\bt="([^"]+)"/.exec(at) || [])[1], s = (/\bs="(\d+)"/.exec(at) || [])[1];
      let v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      if (t === "inlineStr") v = unesc([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(""));
      else if (t === "s") v = shared[+v];
      else if (v != null) v = unesc(v);
      if (v == null || String(v).trim() === "") continue;
      cells[ref[1]] = { v: String(v), f: fillClass(xfs[+s || 0]) };
      any = true;
    }
    if (any) { rows.push({ row: r, hidden, cells }); emptyRun = 0; }
    else if (++emptyRun > XLSX_MAX_EMPTY_ROWS && rows.length) stop = true;
  }

  const reader = (await entryStream(file, ents[path])).getReader();
  let buf = "";
  while (!stop) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value; bytes += value.length;
    if (onProgress) onProgress(bytes);
    let pos = 0;
    for (;;) {
      const a = buf.indexOf("<row", pos);
      if (a < 0) break;
      if (!/[\s>\/]/.test(buf[a + 4] || " ")) { pos = a + 4; continue; }   // e.g. <rowBreaks>
      const gt = buf.indexOf(">", a);
      if (gt < 0) break;
      let end, inner;
      if (buf[gt - 1] === "/") { end = gt + 1; inner = ""; }
      else { const c = buf.indexOf("</row>", gt); if (c < 0) break; end = c + 6; inner = buf.slice(gt + 1, c); }
      parseRow(buf.slice(a, gt + 1), inner);
      pos = end;
      if (stop) break;
    }
    const a2 = buf.indexOf("<row", pos);
    buf = a2 >= 0 ? buf.slice(a2) : buf.slice(Math.max(pos, buf.length - 6));
  }
  try { await reader.cancel(); } catch (e) {}

  const headerRow = rows.length ? rows[0].row : 1;
  const headers = {};
  if (rows.length) for (const [c, x] of Object.entries(rows[0].cells)) headers[c] = x.v.trim();
  return { rows, headers, headerRow };
}

// Items for a run: one per sheet row that has a WO id in column `col`, limited to sheet rows from..to (0/blank = no limit).
function xlsxItems(parsed, col, from, to) {
  const custCol = Object.keys(parsed.headers).find(c => /customer/i.test(parsed.headers[c]));
  const items = []; let blank = 0;
  for (const r of parsed.rows) {
    if (r.row <= parsed.headerRow) continue;
    if (from && r.row < from) continue;
    if (to && r.row > to) continue;
    const c = r.cells[col], id = c ? normId(c.v) : "";
    if (!id) { blank++; continue; }
    items.push({ id, row: r.row, fill: c.f, hidden: r.hidden, cust: custCol && r.cells[custCol] ? r.cells[custCol].v : "" });
  }
  return { items, blank };
}
if (typeof module !== "undefined") module.exports = { readXlsx, xlsxItems, normId, fillClass };
