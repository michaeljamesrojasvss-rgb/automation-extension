// "Email AI prompt" view of the settings page (templates are managed in prompt.js).
(() => {
  const $ = id => document.getElementById(id);
  let P = null, dirtyP = false, dirtyN = false, dirtyM = false, M = null;

  function showView(v) {
    $("viewStatus").hidden = v !== "status"; $("viewPrompt").hidden = v !== "prompt";
    $("topStatus").classList.toggle("on", v === "status"); $("topPrompt").classList.toggle("on", v === "prompt");
    history.replaceState(null, "", v === "prompt" ? "#prompt" : location.pathname);
  }
  $("topStatus").onclick = () => showView("status");
  $("topPrompt").onclick = () => showView("prompt");

  function flash(msg) { $("pflash").textContent = msg; setTimeout(() => { if ($("pflash").textContent === msg) $("pflash").textContent = ""; }, 2500); }
  function setDirty(v) { dirtyP = v; $("pdirty").textContent = v ? "Unsaved changes" : ""; }
  function load() { $("ptext").value = P.presets[P.active]; setDirty(false); }
  function renderSelect() {
    const sel = $("ppreset"); sel.innerHTML = "";
    for (const name of Object.keys(P.presets)) {
      const o = document.createElement("option"); o.value = name; o.textContent = name; if (name === P.active) o.selected = true; sel.appendChild(o);
    }
  }

  for (const [name, help] of Object.entries(PROMPT_PLACEHOLDERS)) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = `{{${name}}}`; b.title = help;
    b.onclick = () => {
      const t = $("ptext"), a = t.selectionStart, z = t.selectionEnd, ins = b.textContent;
      t.value = t.value.slice(0, a) + ins + t.value.slice(z);
      t.focus(); t.selectionStart = t.selectionEnd = a + ins.length; setDirty(true);
    };
    $("pchips").appendChild(b);
  }
  $("ptext").addEventListener("input", () => setDirty(true));

  function setDirtyN(v) { dirtyN = v; $("ndirty").textContent = v ? "Unsaved changes" : ""; }
  $("ntext").addEventListener("input", () => setDirtyN(true));
  $("nsave").onclick = async () => {
    await saveNotes($("ntext").value); setDirtyN(false);
    $("nflash").textContent = "Saved"; setTimeout(() => { $("nflash").textContent = ""; }, 2500);
  };

  $("ppreset").onchange = async () => {
    if (dirtyP && !confirm("Discard unsaved changes to this prompt?")) { renderSelect(); return; }
    P.active = $("ppreset").value; await savePrompts(P); load(); renderSelect();
  };
  $("psave").onclick = async () => {
    if (!$("ptext").value.trim()) { alert("The prompt is empty."); return; }
    P.presets[P.active] = $("ptext").value; await savePrompts(P); setDirty(false); flash("Saved");
  };
  $("psaveNew").onclick = async () => {
    if (!$("ptext").value.trim()) { alert("The prompt is empty."); return; }
    const name = (prompt("Name for the new prompt preset:") || "").trim();
    if (!name) return;
    if (P.presets[name] && !confirm(`A preset named "${name}" already exists. Overwrite it?`)) return;
    P.presets[name] = $("ptext").value; P.active = name; await savePrompts(P); setDirty(false); renderSelect(); flash("Saved as " + name);
  };
  $("pdel").onclick = async () => {
    if (Object.keys(P.presets).length <= 1) { alert("You need at least one preset."); return; }
    if (!confirm(`Delete preset "${P.active}"?`)) return;
    delete P.presets[P.active]; P.active = Object.keys(P.presets)[0]; await savePrompts(P); load(); renderSelect(); flash("Deleted");
  };
  $("preset0").onclick = async () => {
    if (!confirm('Put back the built-in prompt as the "Default" preset? Your notes in it will be lost.')) return;
    P.presets["Default"] = PROMPT_DEFAULT; P.active = "Default"; await savePrompts(P); load(); renderSelect(); flash("Default restored");
  };
  window.addEventListener("beforeunload", e => { if (dirtyP || dirtyN || dirtyM) { e.preventDefault(); e.returnValue = ""; } });

  // ----- masking -----
  const SAMPLE = "Hi team, please call me at (555) 123-4567 or +63 917 123 4567, or write to john.doe@acme.com.\nCustomer number: 4412907. Ship to 1200 W. Oak Blvd, Suite 4. Card 4111 1111 1111 1111.\nWO 123456789 and WKO-5551234 are complete. Waiting 2 hours on the road. https://portal.example.com/case?token=abc123&u=77";
  function setDirtyM(v) { dirtyM = v; $("mdirty").textContent = v ? "Unsaved changes" : ""; }
  function renderMask() {
    $("menabled").checked = M.enabled; $("mmin").value = M.minDigits; $("mwords").value = M.words; $("mkeep").value = M.keep;
    const box = $("mrules"); box.innerHTML = "";
    for (const [k, label] of Object.entries(MASK_RULE_LABELS)) {
      const l = document.createElement("label"), c = document.createElement("input");
      c.type = "checkbox"; c.checked = !!M.rules[k]; c.dataset.rule = k; c.onchange = () => setDirtyM(true);
      l.append(c, " " + label); box.appendChild(l);
    }
    setDirtyM(false);
  }
  const formMask = () => ({
    enabled: $("menabled").checked,
    rules: Object.fromEntries([...document.querySelectorAll("#mrules input")].map(c => [c.dataset.rule, c.checked])),
    minDigits: Number($("mmin").value) || MASK_DEFAULT.minDigits, words: $("mwords").value, keep: $("mkeep").value
  });
  for (const id of ["menabled", "mmin", "mwords", "mkeep"]) $(id).addEventListener("input", () => setDirtyM(true));
  $("msave").onclick = async () => {
    M = Object.assign(await getMask(), formMask()); await saveMask(M); renderMask();
    $("mflash").textContent = "Saved"; setTimeout(() => { $("mflash").textContent = ""; }, 2500);
  };
  $("mreset").onclick = async () => {
    if (!confirm("Restore the built-in masking settings? Your word list will be cleared.")) return;
    M = JSON.parse(JSON.stringify(MASK_DEFAULT)); await saveMask(M); renderMask();
  };
  $("mrun").onclick = () => {
    const cfg = Object.assign(formMask(), { enabled: true }), t = { n: 0 };
    $("mout").textContent = maskText($("mtest").value, cfg, t);
    $("mcount").textContent = `${t.n} item(s) masked` + ($("menabled").checked ? "" : " (note: masking is switched off for real copies)");
  };
  $("mtest").value = SAMPLE;
  getMask().then(m => { M = m; renderMask(); });

  getNotes().then(t => { $("ntext").value = t; });
  getPrompts().then(p => { P = p; renderSelect(); load(); if (location.hash === "#prompt") showView("prompt"); });
})();
