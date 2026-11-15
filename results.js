const $ = id => document.getElementById(id);
const PORTAL = { SC: "ServiceChannel", DT: "Dollar Tree" };
let index = [], runId = null, meta = null, rows = [];
let renderTimer = null;
let prefs = { simple: false, allSnips: false, details: false };
const openRows = new Set();   // rows whose snippets were opened with the per-row button
let anyDoneUi = null;
let view = "all";
function applyPrefs() {
  $("simple").checked = prefs.simple; $("snips").checked = prefs.allSnips; $("details").checked = prefs.details;
  $("snips").disabled = $("details").disabled = prefs.simple;
}
const savePrefs = () => chrome.storage.local.set({ viewPrefs: prefs });

const fmt = ts => new Date(ts).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtSec = ts => new Date(ts).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
const summaryText = s => s ? Object.entries(s).map(([k, v]) => `${k} ${v}`).join(", ") : "";
const fileStamp = ts => { const d = new Date(ts), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

// Page snippets come from other websites: rebuild them from a tiny whitelist of tags and style-only attributes.
const ALLOWED = new Set(["DIV", "SPAN", "B", "STRONG", "I", "EM", "P", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "UL", "OL", "LI", "LABEL", "SMALL", "H1", "H2", "H3", "H4", "H5", "H6", "BR"]);
function renderSnippet(html, container) {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const copy = src => {
      if (src.nodeType === 3) return document.createTextNode(src.nodeValue);
      if (src.nodeType !== 1 || !ALLOWED.has(src.tagName)) return null;
      const el = document.createElement(src.tagName);
      const st = src.getAttribute("style");
      if (st && !/url\s*\(|expression|@import|javascript:|behavior|<|>/i.test(st)) el.setAttribute("style", st);
      for (const c of src.childNodes) { const k = copy(c); if (k) el.appendChild(k); }
      return el;
    };
    const root = doc.body.firstElementChild;
    const n = root && copy(root);
    if (n) container.appendChild(n);
  } catch (e) {}
}

function runLabel(e) {
  const done = e.finished ? " \u00b7 " + (summaryText(e.summary) || "done") : " \u00b7 running";
  return `${fmt(e.startedAt)} \u00b7 ${PORTAL[e.source] || e.source} \u00b7 ${e.total} WOs${done}`;
}
function fillSelect() {
  const sel = $("runSel"); sel.innerHTML = "";
  for (const e of index) {
    const o = document.createElement("option"); o.value = e.id; o.textContent = runLabel(e);
    if (e.id === runId) o.selected = true; sel.appendChild(o);
  }
  $("del").disabled = !index.length;
}

async function loadRun(id) {
  runId = id; meta = null; rows = []; openRows.clear(); anyDoneUi = null;
  if (id) {
    const mk = `run:${id}`;
    const got = await chrome.storage.local.get(mk);
    meta = got[mk] || null;
    if (meta) {
      const keys = meta.ids.map((_, i) => `row:${id}:${i}`);
      const rr = await chrome.storage.local.get(keys);
      rows = meta.ids.map((wo, i) => Object.assign({ status: "queued" }, rr[`row:${id}:${i}`], { id: wo }));
    }
  }
  view = meta && meta.origin ? "diff" : "all";
  fillSelect();
  render();
}

// Keep the row you are looking at in the same place on screen when the table is rebuilt (toggles, live updates).
function refLine() {
  const tb = $("toolbar").getBoundingClientRect().bottom;
  const th = document.querySelector("#t thead");
  return tb + (th ? th.offsetHeight : 0);
}
function captureAnchor() {
  const ref = refLine();
  for (const tr of document.querySelectorAll("#t tbody tr[data-i]")) {
    const r = tr.getBoundingClientRect();
    if (r.bottom > ref + 1) return { i: tr.dataset.i, off: r.top - ref };
  }
  return null;
}
function restoreAnchor(a) {
  if (!a) return;
  const tr = document.querySelector(`#t tbody tr[data-i="${a.i}"]`);
  if (!tr) return;
  const d = tr.getBoundingClientRect().top - refLine() - a.off;
  if (Math.abs(d) >= 1) window.scrollBy(0, d);
}
function syncToolbarHeight() { document.documentElement.style.setProperty("--tbh", $("toolbar").offsetHeight + "px"); }
new ResizeObserver(syncToolbarHeight).observe($("toolbar"));


// ---------- "Changes vs file" report (only for runs started from an Excel file) ----------
const CHIP = { GREEN: "#92D050", RED: "#FF0000", ORANGE: "#FFC000", NONE: "#ffffff", OTHER: "#d9d9d9" };
const FILLNAME = { GREEN: "Green", RED: "Red", ORANGE: "Orange/yellow", NONE: "No fill", OTHER: "Other color" };
const foundColor = r => r.status !== "done" ? null : r.result === "TRUE" ? "GREEN" : (r.result === "FALSE" || r.result === "FALSEEEEEE") ? "RED" : null;
const whyText = r => [r.rc ? "(re-checking...)" : "", r.portal ? `${PORTAL[meta.source] || "Portal"}: ${r.portal}` : "", r.sf ? `Salesforce: ${r.sf}` : ""].filter(Boolean).join(" | ");

function diffData() {
  const byId = new Map(rows.map(r => [r.id, r]));
  const out = { changes: [], manual: [], match: 0, pending: 0, total: 0 };
  meta.origin.items.forEach((it, k) => {
    out.total++;
    const r = byId.get(it.id);
    if (!r || r.status !== "done") { out.pending++; return; }
    const found = foundColor(r), rec = { it, r, found, k };
    if (!found) out.manual.push(rec); else if (found === it.fill) out.match++; else out.changes.push(rec);
  });
  const pri = c => c.it.fill === "GREEN" && c.found === "RED" ? 0 : c.it.fill === "RED" && c.found === "GREEN" ? 1 : 2;
  out.changes.sort((a, b) => pri(a) - pri(b) || a.it.row - b.it.row);
  out.manual.sort((a, b) => a.it.row - b.it.row);
  out.g2r = out.changes.filter(c => pri(c) === 0).length;
  out.r2g = out.changes.filter(c => pri(c) === 1).length;
  return out;
}
const changeText = c => `${FILLNAME[c.it.fill] || c.it.fill} \u2192 ${FILLNAME[c.found] || c.found}`;
function reportRows(d) {
  const out = [];
  for (const c of d.changes) out.push(["Change", c.it.row, c.it.id, c.it.cust || "", FILLNAME[c.it.fill], FILLNAME[c.found], whyText(c.r)]);
  for (const c of d.manual) out.push(["Look manually", c.it.row, c.it.id, c.it.cust || "", FILLNAME[c.it.fill], "(" + (c.r.result || "") + ")", whyText(c.r) + (c.r.note ? " | " + c.r.note : "")]);
  return out;
}

function buildDiff(thead, tbody) {
  const o = meta.origin, d = diffData();
  const hasCust = o.items.some(i => i.cust);
  const heads = ["Row", "WO"].concat(hasCust ? ["Customer"] : [], ["In the file now", "Found", "Change", "Why"]);
  const head = document.createElement("tr");
  for (const h of heads) { const th = document.createElement("th"); th.textContent = h; head.appendChild(th); }
  thead.appendChild(head);

  $("status").textContent = (meta.rechecking ? `Re-checking ${meta.rechecking.done} / ${meta.rechecking.total} rows... ` : "") + (meta.finished ? "Finished. " : `Running: ${rows.filter(r => r.status === "done").length} / ${rows.length} done... `) + `Compared with "${o.file}" (loaded ${fmtSec(o.loadedAt)}).`;
  $("lists").textContent = `${d.changes.length} change${d.changes.length === 1 ? "" : "s"} (green\u2192red ${d.g2r}, red\u2192green ${d.r2g}, other ${d.changes.length - d.g2r - d.r2g})  \u00b7  ${d.manual.length} to look at manually  \u00b7  ${d.match} already match` + (d.pending ? `  \u00b7  ${d.pending} not checked yet` : "") + `.  Find rows by WO number: row numbers move if others sort or insert rows.`;

  const section = (title, list, mk) => {
    const tr = document.createElement("tr"); tr.className = "sec";
    const td = document.createElement("td"); td.colSpan = heads.length; td.textContent = `${title} (${list.length})`; tr.appendChild(td); tbody.appendChild(tr);
    for (const c of list) tbody.appendChild(mk(c));
  };
  const rowFor = (c, foundLabel, change, why) => {
    const tr = document.createElement("tr"); tr.dataset.i = c.k;
    const add = (txt, cls, bg, cl) => { const td = document.createElement("td"); if (cls) td.className = cls; if (bg) { td.style.background = bg; if (cl) td.style.color = cl; } td.textContent = txt; tr.appendChild(td); };
    add(c.it.row); add(c.it.id);
    if (hasCust) add(c.it.cust || "");
    add(FILLNAME[c.it.fill] || c.it.fill, "chip", CHIP[c.it.fill], c.it.fill === "RED" ? "#fff" : "");
    add(foundLabel, "chip", CHIP[c.found] || "", c.found === "RED" ? "#fff" : "");
    add(change, c.it.fill === "GREEN" && c.found === "RED" ? "hot" : "");
    add(why, "why");
    return tr;
  };
  if (d.changes.length) section("Changes to make in the file", d.changes, c => rowFor(c, FILLNAME[c.found], changeText(c), whyText(c.r)));
  if (d.manual.length) section("Look at these manually (check was inconclusive, no change suggested)", d.manual, c => rowFor(c, c.r.result || "?", "", whyText(c.r) + (c.r.note ? " | " + c.r.note : "")));
  if (!d.changes.length && !d.manual.length) {
    const tr = document.createElement("tr"), td = document.createElement("td"); td.colSpan = heads.length;
    td.textContent = d.pending && d.pending === d.total ? "Nothing checked yet." : "No differences found so far: every checked WO already has the matching color.";
    tr.appendChild(td); tbody.appendChild(tr);
  }
}
function applyViewUi() {
  const has = !!(meta && meta.origin), diff = has && view === "diff";
  $("viewWrap").hidden = !has; $("view").value = view;
  if (has) {
    if (anyDoneUi === null) $("anydone").checked = meta.sfAnyDone !== false;
    const d = diff ? diffData() : null;
    $("recheck").disabled = !meta.finished || !!meta.rechecking || !(d && d.changes.length + d.manual.length);
    $("recheck").textContent = meta.rechecking ? "Re-checking..." : "Re-check these rows";
  }
  $("diffBtns").hidden = !diff; $("allBtns").hidden = diff; $("toggles").hidden = diff;
}

// One table row of the "All results" view. Snippets are only built for rows that show them (all rows, or rows opened by their own button).
function buildRow(r, idx) {
  const showNote = !prefs.simple && prefs.details;
  const showSnip = !prefs.simple && (prefs.allSnips || openRows.has(idx));
  const tr = document.createElement("tr");
  tr.dataset.i = idx;
  tr.className = r.status !== "done" ? r.status : (r.result || "").startsWith("ERROR") ? "ERROR" : r.result;
  const cell = (text, c, snip) => {
    const td = document.createElement("td"); if (c) td.className = c;
    td.appendChild(document.createTextNode(text));
    if (snip && showSnip) { const box = document.createElement("div"); box.className = "snip"; renderSnippet(snip, box); if (box.firstChild) td.appendChild(box); }
    tr.appendChild(td); return td;
  };
  const idTd = cell(r.id);
  if (!prefs.simple && !prefs.allSnips && r.status === "done" && (r.portalSnap || r.sfSnap)) {
    const b = document.createElement("button"); b.className = "snipbtn";
    b.textContent = openRows.has(idx) ? "Hide snippets" : "Show snippets";
    b.onclick = () => { openRows.has(idx) ? openRows.delete(idx) : openRows.add(idx); tr.replaceWith(buildRow(rows[idx], idx)); };
    idTd.appendChild(document.createElement("br")); idTd.appendChild(b);
  }
  if (r.status === "queued") { cell("Queued", "res"); cell(""); cell(""); }
  else if (r.status === "checking") { cell("Checking", "res dots"); cell(""); cell(""); }
  else { cell(r.result, "res"); cell(r.portal || "", "", r.portalSnap); cell(r.sf || "", "", r.sfSnap); }
  if (showNote) cell(r.note || "", "note");
  return tr;
}

function render() {
  const t = $("t");
  const anchor = captureAnchor();
  if (!meta) {
    $("status").textContent = index.length ? "Pick a run above." : "No runs yet. Start one from the extension popup.";
    $("lists").textContent = ""; applyViewUi(); t.replaceChildren(); return;
  }
  const done = rows.filter(r => r.status === "done").length;
  const when = `Started ${fmtSec(meta.startedAt)}` + (meta.finishedAt ? `, finished ${fmtSec(meta.finishedAt)}` : "");
  $("status").textContent = (meta.rechecking ? `Re-checking ${meta.rechecking.done} / ${meta.rechecking.total} rows... ` : "") + (meta.finished ? `Finished: ${done} / ${rows.length} WOs checked. ` : `Running: ${done} / ${rows.length} done... `) + when;
  const L = meta.lists || {};
  $("lists").textContent = L.firstName ? `${PORTAL[meta.source]} list "${L.firstName}": ${(L.first || []).join("; ")}  |  Salesforce list "${L.sfName}": ${(L.sf || []).join("; ")}` : "";

  applyViewUi();
  if (meta.origin && view === "diff") {
    const th0 = document.createElement("thead"), tb0 = document.createElement("tbody");
    buildDiff(th0, tb0);
    t.replaceChildren(th0, tb0);
    syncToolbarHeight(); restoreAnchor(anchor); return;
  }
  const showNote = !prefs.simple && prefs.details;
  const thead = document.createElement("thead"), head = document.createElement("tr");
  for (const h of ["WO", "Result", PORTAL[meta.source] || "Portal", "Salesforce"].concat(showNote ? ["Details"] : [])) {
    const th = document.createElement("th"); th.textContent = h; head.appendChild(th);
  }
  thead.appendChild(head);
  const tbody = document.createElement("tbody");
  rows.forEach((r, idx) => tbody.appendChild(buildRow(r, idx)));
  t.replaceChildren(thead, tbody);   // swapped in one go, so the page never collapses and the scrollbar does not jump
  syncToolbarHeight();
  restoreAnchor(anchor);
}
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 120); }

function tsv(all) {
  return rows.map(r => {
    const res = r.status === "done" ? r.result : "";
    return all ? [r.id, res, r.portal || "", r.sf || ""].join("\t") : `${r.id}\t${res}`;
  }).join("\n");
}
function flash(m) { $("ok").textContent = m; setTimeout(() => { $("ok").textContent = ""; }, 2000); }
$("copy").onclick = async () => { await navigator.clipboard.writeText(tsv(false)); flash("Copied!"); };
$("copyAll").onclick = async () => { await navigator.clipboard.writeText(tsv(true)); flash("Copied!"); };
$("csv").onclick = () => {
  if (!meta) return;
  const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  if (meta.origin && view === "diff") {
    const lines = [["Category", "Sheet row", "WO", "Customer", "In the file now", "Found", "Why"].map(q).join(",")];
    for (const r of reportRows(diffData())) lines.push(r.map(q).join(","));
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `wo-changes-${fileStamp(meta.startedAt)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return;
  }
  const lines = [["WO", "Result", PORTAL[meta.source] || "Portal", "Salesforce", "Details"].map(q).join(",")];
  for (const r of rows) lines.push([r.id, r.status === "done" ? r.result : "", r.portal || "", r.sf || "", r.note || ""].map(q).join(","));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `wo-results-${fileStamp(meta.startedAt)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("simple").onchange = () => { prefs.simple = $("simple").checked; applyPrefs(); savePrefs(); render(); };
$("snips").onchange = () => { prefs.allSnips = $("snips").checked; savePrefs(); render(); };
$("details").onchange = () => { prefs.details = $("details").checked; savePrefs(); render(); };


$("view").onchange = () => { view = $("view").value; render(); };
$("copyG").onclick = async () => { const l = diffData().changes.filter(c => c.found === "GREEN").map(c => c.it.id); await navigator.clipboard.writeText(l.join("\n")); flash(`Copied ${l.length} WO(s) to turn green`); };
$("copyR").onclick = async () => { const l = diffData().changes.filter(c => c.found === "RED").map(c => c.it.id); await navigator.clipboard.writeText(l.join("\n")); flash(`Copied ${l.length} WO(s) to turn red`); };
$("copyRep").onclick = async () => { await navigator.clipboard.writeText(reportRows(diffData()).map(r => r.join("\t")).join("\n")); flash("Copied!"); };
$("anydone").onchange = () => { anyDoneUi = $("anydone").checked; };
$("recheck").onclick = async () => {
  if (!meta || !meta.origin) return;
  const d = diffData();
  const ids = [...new Set(d.changes.concat(d.manual).map(c => c.it.id))];
  if (!ids.length) return;
  if (!confirm(`Re-check the ${ids.length} WO(s) listed on this page in ServiceChannel / Salesforce now?\nThe results of this run are updated in place.`)) return;
  const res = await chrome.runtime.sendMessage({ type: "recheck", runId, ids, sfAnyDone: $("anydone").checked });
  if (res && res.error) alert(res.error); else flash("Re-checking " + ids.length + " WO(s)...");
};
$("recmp").onclick = () => $("recmpFile").click();
$("recmpFile").onchange = async () => {
  const f = $("recmpFile").files[0]; $("recmpFile").value = "";
  if (!f || !meta || !meta.origin) return;
  flash("Reading " + f.name + " ...");
  try {
    const p = await readXlsx(f);
    const col = Object.keys(p.headers).find(c => p.headers[c] === meta.origin.colName);
    if (!col) { alert(`Column "${meta.origin.colName}" was not found in that file.`); return; }
    const want = new Set(meta.ids);
    const items = xlsxItems(p, col, 0, 0).items.filter(i => want.has(i.id));
    meta.origin = Object.assign({}, meta.origin, { file: f.name, loadedAt: Date.now(), colLetter: col, items });
    await chrome.storage.local.set({ [`run:${runId}`]: meta });
    render(); flash("Compared with " + f.name);
  } catch (e) { alert("Could not read that file: " + (e.message || e)); }
};

$("runSel").onchange = () => {
  const id = $("runSel").value;
  history.replaceState(null, "", "results.html?run=" + id);
  loadRun(id);
};
$("del").onclick = async () => {
  if (!runId) return;
  const e = index.find(x => x.id === runId);
  if (e && !e.finished && !confirm("This run is still going. Delete it anyway?")) return;
  if (!confirm("Delete this run and its results?")) return;
  await deleteRun(runId);
  index = await getIndex();
  const nextId = index[0] ? index[0].id : null;
  history.replaceState(null, "", nextId ? "results.html?run=" + nextId : "results.html");
  loadRun(nextId);
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.viewPrefs && changes.viewPrefs.newValue) { prefs = Object.assign(prefs, changes.viewPrefs.newValue); applyPrefs(); scheduleRender(); }
  if (changes.runIndex) { index = changes.runIndex.newValue || []; fillSelect(); }
  if (!runId) return;
  let touched = false;
  for (const [k, ch] of Object.entries(changes)) {
    if (k === `run:${runId}` && ch.newValue) { meta = ch.newValue; touched = true; }
    const m = /^row:(.+):(\d+)$/.exec(k);
    if (m && m[1] === runId && ch.newValue && rows[+m[2]]) { rows[+m[2]] = Object.assign({}, ch.newValue, { id: rows[+m[2]].id }); touched = true; }
  }
  if (touched || changes.runIndex) scheduleRender();
});

(async () => {
  const vp = await chrome.storage.local.get("viewPrefs");
  if (vp.viewPrefs) prefs = Object.assign(prefs, vp.viewPrefs);
  applyPrefs();
  index = await getIndex();
  const want = new URLSearchParams(location.search).get("run");
  const id = (want && index.find(e => e.id === want)) ? want : (index[0] ? index[0].id : null);
  await loadRun(id);
})();
