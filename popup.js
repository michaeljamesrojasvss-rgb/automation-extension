const $ = id => document.getElementById(id);
let S = null;

function fillPresets(selectId, previewId, group) {
  const sel = $(selectId); sel.innerHTML = "";
  for (const name of Object.keys(S[group].presets)) {
    const o = document.createElement("option"); o.value = name; o.textContent = name;
    if (name === S[group].active) o.selected = true; sel.appendChild(o);
  }
  const list = S[group].presets[S[group].active];
  const txt = list.join("; ");
  $(previewId).textContent = txt.length > 110 ? txt.slice(0, 107) + "..." : txt;
}
function refresh() { fillPresets("preset", "preview", $("source").value); fillPresets("sfpreset", "sfpreview", "SF"); }

async function init() {
  S = await getSettings();
  const d = await chrome.storage.local.get(["lastIds", "lastTabs", "lastSettle", "lastWin", "lastSource", "lastConfirm", "lastSfAll", "lastSfAny"]);
  if (d.lastIds) $("ids").value = d.lastIds;
  if (d.lastTabs) $("tabs").value = d.lastTabs;
  if (d.lastSettle !== undefined) $("settle").value = d.lastSettle;
  if (d.lastWin) $("win").checked = true;
  if (d.lastConfirm === false) $("confirm").checked = false;
  if (d.lastSfAll === false) $("sfall").checked = false;
  if (d.lastSfAny === false) $("sfany").checked = false;
  if (d.lastSource) $("source").value = d.lastSource;
  refresh();
}
$("source").onchange = refresh;
$("preset").onchange = async () => { S[$("source").value].active = $("preset").value; await saveSettings(S); refresh(); };
$("sfpreset").onchange = async () => { S.SF.active = $("sfpreset").value; await saveSettings(S); refresh(); };
$("edit").onclick = () => chrome.runtime.openOptionsPage();
$("xl").onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL("start.html") }); window.close(); };

$("run").onclick = async () => {
  const ids = [...new Set($("ids").value.split(/[\s,;]+/).map(x => x.trim().replace(/^["'`(\[{<]+|["'`)\]}>.:]+$/g, "")).filter(Boolean))];
  const tabs = Math.max(1, Math.min(10, parseInt($("tabs").value) || 3));
  const settle = Math.max(0, parseFloat($("settle").value) || 1.5);
  const sfAnyDone = $("sfany").checked, sfAlways = $("sfall").checked, useWindows = $("win").checked, confirmFalse = $("confirm").checked, source = $("source").value;
  if (!ids.length) { $("msg").textContent = "Enter at least one WO ID."; return; }
  await chrome.storage.local.set({ lastIds: $("ids").value, lastTabs: tabs, lastSettle: settle, lastWin: useWindows, lastSource: source, lastConfirm: confirmFalse, lastSfAll: sfAlways, lastSfAny: sfAnyDone });
  const res = await chrome.runtime.sendMessage({ type: "run", ids, tabs, settle, useWindows, source, confirmFalse, sfAlways, sfAnyDone });
  if (res && res.error) { $("msg").textContent = res.error; return; }
  window.close();
};
init();

// ---------------- Outlook categories mode ----------------
let OL = { enabled: true, readBtn: true, active: "", list: [] };
async function olLoad() {
  const d = await chrome.storage.local.get(["outlookCat", "popupMode"]);
  OL = Object.assign({ enabled: true, readBtn: true, active: "", list: [] }, d.outlookCat || {});
  if (!Array.isArray(OL.list)) OL.list = [];
  olRender(); promptRender();
  setMode(["WO", "OL", "CB"].includes(d.popupMode) ? d.popupMode : "WO", false);
}
async function promptRender() {
  const P = await getPrompts(), sel = $("olPrompt"); sel.innerHTML = "";
  for (const name of Object.keys(P.presets)) { const o = document.createElement("option"); o.value = name; o.textContent = name; if (name === P.active) o.selected = true; sel.appendChild(o); }
  $("olMask").checked = (await getMask()).enabled;
}
$("olMask").onchange = async () => { const M = await getMask(); M.enabled = $("olMask").checked; await saveMask(M); };
$("olPrompt").onchange = async () => { const P = await getPrompts(); P.active = $("olPrompt").value; await savePrompts(P); };
$("olPromptEdit").onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL("options.html#prompt") }); window.close(); };
const olSave = () => chrome.storage.local.set({ outlookCat: OL });
function olRender() {
  $("olOn").checked = !!OL.enabled;
  $("olReadOn").checked = OL.readBtn !== false;
  olCount();
  const sel = $("olActive"); sel.innerHTML = "";
  if (!OL.list.length) {
    const o = document.createElement("option"); o.textContent = "(add a category below)"; o.value = ""; sel.appendChild(o);
  }
  for (const n of OL.list) { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); }
  if (OL.list.includes(OL.active)) sel.value = OL.active; else { OL.active = OL.list[0] || ""; }
}
function setMode(m, save = true) {
  $("pane-wo").hidden = m !== "WO"; $("pane-ol").hidden = m !== "OL"; $("pane-cb").hidden = m !== "CB";
  $("modeWo").classList.toggle("on", m === "WO"); $("modeOl").classList.toggle("on", m === "OL"); $("modeCb").classList.toggle("on", m === "CB");
  if (save) chrome.storage.local.set({ popupMode: m });
}
$("modeWo").onclick = () => setMode("WO");
$("modeOl").onclick = () => setMode("OL");
$("modeCb").onclick = () => setMode("CB");
$("olOn").onchange = async () => { OL.enabled = $("olOn").checked; await olSave(); };
$("olActive").onchange = async () => { OL.active = $("olActive").value; await olSave(); };
async function olAdd() {
  const name = $("olNew").value.trim();
  if (!name) return;
  const existing = OL.list.find(x => x.toLowerCase() === name.toLowerCase());
  if (!existing) OL.list.push(name);
  OL.active = existing || name;
  $("olNew").value = "";
  await olSave(); olRender();
}
$("olAdd").onclick = olAdd;
$("olNew").onkeydown = e => { if (e.key === "Enter") olAdd(); };
$("olDel").onclick = async () => {
  const cur = $("olActive").value; if (!cur) return;
  OL.list = OL.list.filter(x => x !== cur); OL.active = OL.list[0] || "";
  await olSave(); olRender();
};
$("olReadOn").onchange = async () => { OL.readBtn = $("olReadOn").checked; await olSave(); };
async function olCount() {
  const d = await chrome.storage.local.get("outlookEmails");
  const n = Object.keys(d.outlookEmails || {}).length;
  $("olCount").textContent = n ? `${n} email(s) saved` : "No emails saved yet";
}
$("olCopyAll").onclick = async () => {
  const d = await chrome.storage.local.get("outlookEmails");
  const all = Object.values(d.outlookEmails || {});
  if (!all.length) { $("olMsg").textContent = "Nothing saved yet."; return; }
  await navigator.clipboard.writeText(JSON.stringify(all, null, 2));
  $("olMsg").textContent = `Copied ${all.length} email(s) as JSON.`;
};
$("olClear").onclick = async () => {
  if (!confirm("Delete all saved email contents?")) return;
  await chrome.storage.local.remove("outlookEmails"); olCount(); $("olMsg").textContent = "Cleared.";
};
olLoad();
