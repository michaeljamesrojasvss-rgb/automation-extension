const $ = id => document.getElementById(id);
let S = null, parsed = null, fileName = "", current = { items: [], blank: 0 };

function fillPresets(selectId, previewId, group) {
  const sel = $(selectId); sel.innerHTML = "";
  for (const name of Object.keys(S[group].presets)) {
    const o = document.createElement("option"); o.value = name; o.textContent = name;
    if (name === S[group].active) o.selected = true; sel.appendChild(o);
  }
  const txt = S[group].presets[S[group].active].join("; ");
  $(previewId).textContent = txt.length > 140 ? txt.slice(0, 137) + "..." : txt;
}
function refreshPresets() { fillPresets("preset", "presetPreview", $("source").value); fillPresets("sfpreset", "sfpreview", "SF"); }

const COLORNAME = { GREEN: "green", RED: "red", ORANGE: "orange/yellow", NONE: "no fill", OTHER: "other color" };
function intVal(id) { const n = parseInt($(id).value, 10); return n > 0 ? n : 0; }

function preview() {
  if (!parsed) return;
  const col = $("col").value, from = intVal("from"), to = intVal("to");
  current = xlsxItems(parsed, col, from, to);
  const ids = new Set(current.items.map(i => i.id));
  const fills = {}; for (const i of current.items) fills[i.fill] = (fills[i.fill] || 0) + 1;
  const hidden = current.items.filter(i => i.hidden).length;
  const rowsTxt = current.items.length ? ` (sheet rows ${current.items[0].row} to ${current.items[current.items.length - 1].row})` : "";
  const parts = [`<b>${ids.size}</b> WO${ids.size === 1 ? "" : "s"} to check${rowsTxt}`];
  if (current.items.length !== ids.size) parts.push(`${current.items.length - ids.size} duplicate row(s) share a WO and will be checked once`);
  if (current.blank) parts.push(`${current.blank} row(s) without a WO id skipped`);
  if (hidden) parts.push(`${hidden} are hidden by a filter (still included)`);
  const fl = Object.entries(fills).map(([k, v]) => `${v} ${COLORNAME[k] || k}`).join(", ");
  $("preview").innerHTML = parts.join("<br>") + (fl ? `<br><span class="small">Current fills in the file: ${fl}</span>` : "");
  $("run").disabled = !ids.size;
}

async function init() {
  S = await getSettings();
  const d = await chrome.storage.local.get(["lastTabs", "lastSettle", "lastWin", "lastSource", "lastConfirm", "lastSfAll", "lastSfAny"]);
  if (d.lastTabs) $("tabs").value = d.lastTabs;
  if (d.lastSettle !== undefined) $("settle").value = d.lastSettle;
  if (d.lastWin) $("win").checked = true;
  if (d.lastConfirm === false) $("confirm").checked = false;
  if (d.lastSfAll === false) $("sfall").checked = false;
  if (d.lastSfAny === false) $("sfany").checked = false;
  if (d.lastSource) $("source").value = d.lastSource;
  refreshPresets();
}
$("source").onchange = refreshPresets;
$("preset").onchange = async () => { S[$("source").value].active = $("preset").value; await saveSettings(S); refreshPresets(); };
$("sfpreset").onchange = async () => { S.SF.active = $("sfpreset").value; await saveSettings(S); refreshPresets(); };
for (const id of ["col", "from", "to"]) $(id).oninput = preview;

$("file").onchange = async () => {
  const f = $("file").files[0]; if (!f) return;
  parsed = null; $("run").disabled = true; $("col").disabled = true; $("msg").textContent = "";
  $("preview").textContent = "Reading " + f.name + " ...";
  try {
    parsed = await readXlsx(f, b => { $("preview").textContent = `Reading ${f.name} ... ${Math.round(b / 1048576)} MB scanned`; });
    fileName = f.name;
    const cols = Object.keys(parsed.headers);
    if (!cols.length) throw new Error("no header row found");
    const sel = $("col"); sel.innerHTML = "";
    for (const c of cols) { const o = document.createElement("option"); o.value = c; o.textContent = `${parsed.headers[c]}  (column ${c})`; sel.appendChild(o); }
    const { lastCol } = await chrome.storage.local.get("lastCol");
    const guess = cols.find(c => parsed.headers[c] === lastCol) || cols.find(c => /^(wo|work\s*order)\s*(#|no\.?|number|id)?$/i.test(parsed.headers[c])) || cols[0];
    sel.value = guess; sel.disabled = false;
    preview();
  } catch (e) {
    $("preview").textContent = "Choose a file to see how many WOs it contains.";
    $("msg").textContent = "Could not read that file: " + (e.message || e);
  }
};

$("run").onclick = async () => {
  if (!parsed || !current.items.length) return;
  const ids = [...new Set(current.items.map(i => i.id))];
  const tabs = Math.max(1, Math.min(10, parseInt($("tabs").value) || 3));
  const settle = Math.max(0, parseFloat($("settle").value) || 1.5);
  const sfAnyDone = $("sfany").checked, sfAlways = $("sfall").checked, useWindows = $("win").checked, confirmFalse = $("confirm").checked, source = $("source").value;
  const col = $("col").value;
  await chrome.storage.local.set({ lastTabs: tabs, lastSettle: settle, lastWin: useWindows, lastSource: source, lastConfirm: confirmFalse, lastSfAll: sfAlways, lastSfAny: sfAnyDone, lastCol: parsed.headers[col] });
  const origin = { file: fileName, colName: parsed.headers[col], colLetter: col, loadedAt: Date.now(), items: current.items };
  $("run").disabled = true; $("msg").textContent = "Starting...";
  const res = await chrome.runtime.sendMessage({ type: "run", ids, tabs, settle, useWindows, source, confirmFalse, sfAlways, sfAnyDone, origin });
  if (res && res.error) { $("msg").textContent = res.error; $("run").disabled = false; return; }
  chrome.tabs.getCurrent(t => { if (t) chrome.tabs.remove(t.id); else window.close(); });
};
init();
