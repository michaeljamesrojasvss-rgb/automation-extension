const $ = id => document.getElementById(id);
let S = null, group = "SC", work = [], dirty = false;

function flash(msg) { $("flash").textContent = msg; setTimeout(() => { if ($("flash").textContent === msg) $("flash").textContent = ""; }, 2500); }
function setDirty(v) { dirty = v; $("dirty").textContent = v ? "Unsaved changes" : ""; }

function loadActive() { work = S[group].presets[S[group].active].slice(); setDirty(false); }

function render() {
  const g = S[group];
  $("tabs").innerHTML = "";
  for (const k of Object.keys(GROUP_INFO)) {
    const b = document.createElement("button");
    b.textContent = GROUP_INFO[k].title; b.className = k === group ? "on" : "";
    b.onclick = () => { group = k; loadActive(); render(); };
    $("tabs").appendChild(b);
  }
  $("help").textContent = GROUP_INFO[group].help;
  $("preset").innerHTML = "";
  for (const name of Object.keys(g.presets)) {
    const o = document.createElement("option"); o.value = name; o.textContent = name; if (name === g.active) o.selected = true;
    $("preset").appendChild(o);
  }
  $("list").innerHTML = "";
  work.forEach((item, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span"); span.textContent = item;
    const x = document.createElement("button"); x.textContent = "\u00d7"; x.title = "Remove";
    x.onclick = () => { work.splice(i, 1); setDirty(true); render(); };
    li.append(span, x); $("list").appendChild(li);
  });
  if (!work.length) { const li = document.createElement("li"); li.textContent = "(empty - add at least one status)"; $("list").appendChild(li); }
}

function addItem() {
  const v = $("newItem").value.trim();
  if (!v) return;
  const key = normStatus(v);
  if (!work.some(x => normStatus(x) === key)) { work.push(v); setDirty(true); }
  $("newItem").value = ""; render(); $("newItem").focus();
}
$("add").onclick = addItem;
$("newItem").addEventListener("keydown", e => { if (e.key === "Enter") addItem(); });

$("preset").onchange = async () => {
  if (dirty && !confirm("Discard unsaved changes to this list?")) { render(); return; }
  S[group].active = $("preset").value; await saveSettings(S); loadActive(); render();
};
$("save").onclick = async () => {
  if (!work.length) { alert("The list is empty. Add at least one status first."); return; }
  S[group].presets[S[group].active] = work.slice(); await saveSettings(S); setDirty(false); render(); flash("Saved");
};
$("saveNew").onclick = async () => {
  if (!work.length) { alert("The list is empty. Add at least one status first."); return; }
  const name = (prompt("Name for the new preset:") || "").trim();
  if (!name) return;
  if (S[group].presets[name] && !confirm(`A preset named "${name}" already exists. Overwrite it?`)) return;
  S[group].presets[name] = work.slice(); S[group].active = name; await saveSettings(S); setDirty(false); render(); flash("Saved as " + name);
};
$("del").onclick = async () => {
  const names = Object.keys(S[group].presets);
  if (names.length <= 1) { alert("You need at least one preset."); return; }
  if (!confirm(`Delete preset "${S[group].active}"?`)) return;
  delete S[group].presets[S[group].active]; S[group].active = Object.keys(S[group].presets)[0];
  await saveSettings(S); loadActive(); render(); flash("Deleted");
};
$("reset").onclick = async () => {
  if (!confirm('Put back the built-in list as the "Default" preset?')) return;
  S[group].presets["Default"] = BUILTIN[group].slice(); S[group].active = "Default";
  await saveSettings(S); loadActive(); render(); flash("Default restored");
};

getSettings().then(s => { S = s; loadActive(); render(); });
