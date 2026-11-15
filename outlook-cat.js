// Outlook shared-inbox "category button" mode.
// Adds a small button on every email row. Clicking it opens Outlook's own right-click menu
// (hidden), searches the category by name, ticks it (adds, never removes), then closes the menu.
(() => {
  if (window.__wocLoaded) return;
  window.__wocLoaded = true;

  const ROW_SEL = 'div[role="option"][data-convid]';
  let cfg = { enabled: true, readBtn: true, active: "", list: [] };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(fn, timeout = 2000, step = 15) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }
  const fire = (el, type, init = {}) => {
    const C = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
    return el.dispatchEvent(new C(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }));
  };
  const key = (el, type, k, code, kc) =>
    el.dispatchEvent(new KeyboardEvent(type, { key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true }));

  // ---------- styles ----------
  const st = document.createElement("style");
  st.textContent = `
    .woc-bar{position:absolute;right:10px;bottom:5px;z-index:5;display:flex;gap:4px;align-items:center;transform:translateY(45%)}
    .woc-btn{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font:600 11px system-ui,Segoe UI,sans-serif;line-height:16px;padding:1px 8px;border-radius:10px;border:1px solid #2b88d8;
      background:#0f548c;color:#fff;cursor:pointer;opacity:.8}
    .woc-btn:hover{opacity:1;background:#115ea3}
    .woc-btn.woc-off{background:#555;border-color:#777}
    .woc-read{flex:none}
    .woc-read.woc-idle{background:#e8710a;border-color:#ffa24d;color:#fff}
    .woc-read.woc-idle:hover{background:#ff8a24}
    .woc-read.woc-ask{background:#6b4fbb;border-color:#a590e6;color:#fff}
    .woc-read.woc-ask:hover{background:#7e63cf}
    .woc-read.woc-working{background:#f2c811;border-color:#fff09a;color:#222;cursor:progress}
    .woc-read.woc-done{background:#107c10;border-color:#5fd35f;color:#fff}
    .woc-read.woc-fail{background:#c50f1f;border-color:#ff7b86;color:#fff}
    .woc-ai{flex:none;padding:1px 7px;max-width:none;font-weight:700}
    .woc-ai.woc-has{background:#107c10;border-color:#5fd35f}
    .woc-ai.woc-err{background:#c50f1f;border-color:#ff7b86}
    .woc-ai.woc-open{box-shadow:0 0 0 2px #fff,0 0 0 4px #0f548c}
    #woc-panel{position:fixed;top:72px;right:16px;width:500px;height:440px;min-width:300px;min-height:160px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);
      z-index:2147483646;display:none;flex-direction:column;resize:both;overflow:hidden;background:#fff;color:#222;border:1px solid #b9c3cf;border-radius:10px;
      box-shadow:0 10px 32px rgba(0,0,0,.4);font:13px/1.5 system-ui,Segoe UI,sans-serif}
    #woc-panel.open{display:flex}
    #woc-ph{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#0f548c;color:#fff;cursor:move;user-select:none}
    #woc-ph .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
    #woc-ph button{font:12px system-ui,Segoe UI,sans-serif;padding:2px 8px;border:1px solid #7fb6e6;border-radius:6px;background:#115ea3;color:#fff;cursor:pointer}
    #woc-ph button:hover:not(:disabled){background:#1a73c4}
    #woc-ph button:disabled{opacity:.45;cursor:default}
    #woc-pb{flex:1;overflow:auto;padding:10px 16px;user-select:text}
    #woc-pf{padding:4px 12px;font-size:11px;color:#666;border-top:1px solid #e3e3e3}
    #woc-pb h1,#woc-pb h2,#woc-pb h3,#woc-pb h4{margin:12px 0 6px;line-height:1.25}
    #woc-pb h1{font-size:18px}#woc-pb h2{font-size:16px}#woc-pb h3{font-size:14.5px}#woc-pb h4{font-size:13.5px}
    #woc-pb p{margin:6px 0}#woc-pb ul,#woc-pb ol{margin:6px 0;padding-left:22px}#woc-pb li{margin:2px 0}
    #woc-pb code{background:#eef1f4;border-radius:4px;padding:0 4px;font:12px Consolas,monospace}
    #woc-pb pre{background:#f4f6f8;border:1px solid #e0e4e8;border-radius:6px;padding:8px;overflow:auto;white-space:pre-wrap}
    #woc-pb pre code{background:none;padding:0}
    #woc-pb blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid #b9c3cf;color:#444}
    #woc-pb table{border-collapse:collapse;margin:8px 0}#woc-pb th,#woc-pb td{border:1px solid #cfd6dd;padding:3px 8px;text-align:left}#woc-pb th{background:#f1f4f7}
    #woc-pb a{color:#0f6cbd}
    #woc-pb .woc-error{color:#b00020;font-weight:600}#woc-pb .woc-note{color:#666}
    #woc-pb .woc-stream{white-space:pre-wrap;font:13px/1.5 system-ui,Segoe UI,sans-serif;background:none;border:0;padding:0;margin:0;color:#555}
    html.woc-busy .fui-MenuPopover{opacity:0!important;pointer-events:none!important}
    #woc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:8px 16px;border-radius:8px;
      font:13px system-ui,Segoe UI,sans-serif;color:#fff;background:#107c10;box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:none}
    #woc-toast.woc-err{background:#c50f1f}
  `;
  document.documentElement.appendChild(st);

  let toastTimer = null;
  function toast(msg, err) {
    let t = document.getElementById("woc-toast");
    if (!t) { t = document.createElement("div"); t.id = "woc-toast"; document.documentElement.appendChild(t); }
    t.textContent = msg; t.className = err ? "woc-err" : "";
    t.style.display = "block";
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = "none"; }, err ? 3500 : 1800);
  }

  // ---------- buttons ----------
  const norm = x => (x || "").replace(/\s+/g, " ").trim();
  const states = new Map();          // convId -> "reading" | "asking" | "fail" (this page session only)
  const failInfo = new Map();        // convId -> { message, code } of the last failure
  const partial = new Map();         // convId -> answer text so far while Copilot is still writing
  let captured = new Set();          // convIds whose email content is saved
  let answers = {};                  // convId -> { markdown, text, askedAt, ms, preset, masked, subject }
  let openId = null;                 // convId whose AI panel is open
  const getState = id => states.get(id) || (answers[id] ? "done" : captured.has(id) ? "ask" : "idle");
  function setState(id, st) {
    if (st === "done" || st === "idle") states.delete(id); else states.set(id, st);
    refreshButtons(); renderPanel();
  }
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setTitle = (el, t) => { if (el.title !== t) el.title = t; };

  // Inbox = the only folder where we tag. The folder is read from the title above the message list ("Inbox", "Sent Items",
  // "Response sent in WO"...). The address bar is only a fallback, because it still says "inbox" inside folders created under the Inbox.
  const NON_INBOX = new Set(["sentitems", "drafts", "deleteditems", "junkemail", "archive", "outbox", "notes", "conversationhistory",
    "scheduled", "folder", "search", "rss", "clutter"]);
  function folderTitle() {
    const h = document.querySelector('[data-app-section="MessageList"] [role="heading"][aria-level="2"]') ||
      document.querySelector('[role="complementary"][aria-label="Message list"] [role="heading"]');
    return h ? norm(h.getAttribute("aria-label") || h.textContent).toLowerCase() : "";
  }
  function isInbox() {
    const title = folderTitle();
    if (title) return title === "inbox";
    const segs = location.pathname.split("/").filter(Boolean).map(s => { try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); } });
    const i = segs.indexOf("mail");
    const rest = (i >= 0 ? segs.slice(i + 1) : segs).filter(s => !/^\d+$/.test(s) && !s.includes("@"));   // drop account number / shared mailbox address
    if (!rest.length || rest[0] === "inbox") return true;
    return !NON_INBOX.has(rest[0]);
  }

  const label = () => "\u{1F3F7} " + (cfg.active || "pick category");
  const guard = b => {
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"])
      b.addEventListener(t, e => e.stopPropagation(), true);
  };
  const idOf = (b, row) => (b.closest(ROW_SEL) || row).getAttribute("data-convid");
  function makeCatButton(row) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "woc-btn woc-cat";
    guard(b);
    b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const id = idOf(b, row);
      enqueue(() => applyCategory(id));
    }, true);
    return b;
  }
  function makeReadButton(row) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "woc-btn woc-read woc-idle";
    guard(b);
    b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const id = idOf(b, row), st = getState(id);
      if (st === "reading" || st === "asking") return;
      if (st === "done" && !e.shiftKey) { copyCaptured(id); return; }       // green: copy the AI prompt (Shift+click = read + ask again)
      pipeline(id, e.shiftKey || !captured.has(id));
    }, true);
    return b;
  }
  function makeToggle(row) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "woc-btn woc-ai";
    guard(b);
    b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const id = idOf(b, row);
      openId = openId === id ? null : id;
      renderPanel(); refreshButtons();
    }, true);
    return b;
  }
  const READ_TEXT = { idle: "\u{1F4E5} Read", reading: "\u23F3 Reading...", asking: "\u{1F916} Asking...", ask: "\u{1F916} Ask AI", done: "\u{1F4CB} Prompt", fail: "\u26A0 Retry" };
  const READ_CLS = { idle: "woc-idle", reading: "woc-working", asking: "woc-working", ask: "woc-ask", done: "woc-done", fail: "woc-fail" };
  const READ_TITLE = {
    idle: "Read this email and ask Copilot for the action points",
    reading: "Getting the content of this email...",
    asking: "Waiting for Copilot's answer...",
    ask: "Email already read - click to ask Copilot (Shift+click = read it again first)",
    done: "AI answer ready (use the arrow). Click = copy the AI prompt, Shift+click = read and ask again",
    fail: "Something failed - click to try again (the arrow shows what happened)"
  };
  function rowHasTag(row, name) {
    const want = (name || "").trim().toLowerCase();
    if (!want) return false;
    for (const t of row.querySelectorAll(".fui-Tag")) {
      const txt = (t.textContent || "").trim().toLowerCase();
      const ti = (t.getAttribute("title") || "").toLowerCase();
      if (txt === want || ti.endsWith("category " + want)) return true;
    }
    return false;
  }
  function refreshButtons() {
    const inbox = isInbox();
    for (const row of document.querySelectorAll(ROW_SEL)) {
      let bar = row.querySelector(":scope > .woc-bar");
      if (!cfg.enabled) { if (bar) bar.remove(); continue; }
      const id = row.getAttribute("data-convid");
      const tagged = rowHasTag(row, cfg.active);
      // Inbox: tag button until the email has the tag, Read button once it has it.
      // Any other folder: no tagging, Read button on every email.
      const wantCat = inbox && !tagged;
      const wantRead = cfg.readBtn !== false && (!inbox || tagged);
      if (!wantCat && !wantRead) { if (bar) bar.remove(); continue; }
      if (getComputedStyle(row).position === "static") row.style.position = "relative";
      if (!bar) { bar = document.createElement("div"); bar.className = "woc-bar"; row.appendChild(bar); }

      let cb = bar.querySelector(".woc-cat");
      if (wantCat) {
        if (!cb) { cb = makeCatButton(row); bar.prepend(cb); }
        setText(cb, label());
        cb.classList.toggle("woc-off", !cfg.active);
        setTitle(cb, cfg.active ? `Add category "${cfg.active}" to this email` : "Pick a category in the extension popup first");
      } else if (cb) cb.remove();

      let rb = bar.querySelector(".woc-read");
      if (wantRead) {
        if (!rb) { rb = makeReadButton(row); bar.insertBefore(rb, bar.querySelector(".woc-ai")); }
        const st = getState(id), cls = "woc-btn woc-read " + READ_CLS[st];
        if (rb.className !== cls) rb.className = cls;
        setText(rb, READ_TEXT[st]); setTitle(rb, READ_TITLE[st]);
      } else if (rb) rb.remove();

      let tb = bar.querySelector(".woc-ai");
      if (wantRead && (answers[id] || failInfo.has(id))) {
        if (!tb) { tb = makeToggle(row); bar.appendChild(tb); }
        const open = openId === id, cls = "woc-btn woc-ai " + (failInfo.has(id) && !answers[id] ? "woc-err" : "woc-has") + (open ? " woc-open" : "");
        if (tb.className !== cls) tb.className = cls;
        setText(tb, open ? "<" : ">");
        setTitle(tb, open ? "Hide the AI suggestion" : failInfo.has(id) && !answers[id] ? "Show what went wrong" : "Show the AI suggestion");
      } else if (tb) tb.remove();
    }
  }
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refreshButtons(); }); };
  // ignore changes we make ourselves inside our own buttons/panel/toast, otherwise this would loop forever
  const OURS = ".woc-bar,#woc-toast,#woc-panel";
  const onMut = muts => { if (muts.every(m => m.target.nodeType === 1 && m.target.closest && m.target.closest(OURS))) return; schedule(); };
  new MutationObserver(onMut).observe(document.documentElement, { childList: true, subtree: true });
  // Outlook recycles/fills rows by changing attributes (new mail arriving often does this), which childList alone never sees
  new MutationObserver(onMut).observe(document.documentElement, { attributes: true, attributeFilter: ["data-convid"], subtree: true });
  setInterval(() => { if (!document.hidden) refreshButtons(); }, 1500);   // safety net: also follows folder changes

  // ---------- AI suggestion panel ----------
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let panel = null;
  function ensurePanel() {
    if (panel) return panel;
    panel = h("div"); panel.id = "woc-panel";
    const head = h("div"); head.id = "woc-ph";
    head.append(h("span", "t", "AI suggestion"));
    const mk = (id, txt, title) => { const b = h("button", null, txt); b.type = "button"; b.id = id; b.title = title; head.append(b); return b; };
    mk("woc-pcopy", "Copy answer", "Copy the answer (keeps the formatting when pasted into Salesforce or an email)").onclick = copyAnswer;
    mk("woc-pprompt", "Copy prompt", "Copy the prompt that was sent (masked), to paste into another AI").onclick = () => openId && copyCaptured(openId);
    mk("woc-pask", "Ask again", "Ask Copilot again with the saved email").onclick = () => { if (openId && !["reading", "asking"].includes(getState(openId))) pipeline(openId, false); };
    mk("woc-pclose", "\u2715", "Close").onclick = () => { openId = null; renderPanel(); refreshButtons(); };
    const body = h("div", "woc-md"); body.id = "woc-pb";
    const foot = h("div"); foot.id = "woc-pf";
    panel.append(head, body, foot);
    document.documentElement.appendChild(panel);
    // drag by the header
    head.addEventListener("mousedown", e => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => { panel.style.left = Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)) + "px"; panel.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + "px"; panel.style.right = "auto"; };
      const up = () => { removeEventListener("mousemove", move, true); removeEventListener("mouseup", up, true); };
      addEventListener("mousemove", move, true); addEventListener("mouseup", up, true); e.preventDefault();
    });
    return panel;
  }
  function renderPanel() {
    if (!openId) { if (panel) panel.classList.remove("open"); return; }
    const p = ensurePanel(), id = openId;
    const a = answers[id], f = failInfo.get(id), st = getState(id), busy = st === "reading" || st === "asking";
    const row = findRow(id), subj = (a && a.subject) || (row ? rowInfo(row).subject : "");
    p.querySelector(".t").textContent = "AI suggestion" + (subj ? " - " + subj : "");
    p.querySelector("#woc-pcopy").disabled = !a;
    p.querySelector("#woc-pprompt").disabled = !captured.has(id);
    p.querySelector("#woc-pask").disabled = busy || !captured.has(id);
    const body = p.querySelector("#woc-pb"), foot = p.querySelector("#woc-pf");
    body.replaceChildren();
    if (busy) {
      const t = partial.get(id);
      if (t) body.append(h("pre", "woc-stream", t)); else body.append(h("p", "woc-note", st === "reading" ? "Reading the email..." : "Waiting for Copilot..."));
    } else if (f && !a) {
      body.append(h("p", "woc-error", f.message));
    } else if (a) {
      if (f) body.append(h("p", "woc-error", "The last attempt failed: " + f.message + " (showing the previous answer)"));
      body.append(mdToDom(a.markdown || a.text || ""));
    }
    foot.textContent = a && !busy ? `Answered ${new Date(a.askedAt).toLocaleString()} \u00b7 ${(a.ms / 1000).toFixed(1)}s \u00b7 prompt "${a.preset}" \u00b7 ${a.masked == null ? "?" : a.masked} item(s) masked` : "";
    p.classList.add("open");
  }
  async function copyAnswer() {
    const a = openId && answers[openId]; if (!a) return;
    const md = a.markdown || a.text || "";
    try {
      const tmp = h("div"); tmp.append(mdToDom(md));
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([tmp.innerHTML], { type: "text/html" }), "text/plain": new Blob([a.text || md], { type: "text/plain" }) })]);
    } catch {
      try { await navigator.clipboard.writeText(a.text || md); } catch { toast("Couldn't copy the answer", true); return; }
    }
    toast("Answer copied");
  }

  // ---------- read -> ask Copilot -> save the answer ----------
  async function loadRecord(id) { const d = await chrome.storage.local.get("outlookEmails"); return (d.outlookEmails || {})[id] || null; }
  async function saveAnswer(id, a) {
    answers[id] = a;
    const d = await chrome.storage.local.get("outlookAnswers"), all = d.outlookAnswers || {};
    all[id] = a;
    const ids = Object.keys(all);
    if (ids.length > 300) {
      ids.sort((x, y) => (all[x].askedAt || "").localeCompare(all[y].askedAt || ""));
      for (const k of ids.slice(0, ids.length - 300)) delete all[k];
    }
    await chrome.storage.local.set({ outlookAnswers: all });
  }
  const BLOCKED = /couldn.?t be fully completed due to your organi[sz]ation|blocked by your organi[sz]ation|organi[sz]ation.?s? polic/i;
  async function askAI(id, rec) {
    if (typeof CopilotBridge === "undefined") throw new Error("The Copilot bridge isn't loaded - reload the extension and this tab");
    const P = await getPrompts(), M = await getMask();
    const out = buildPrompt(P.presets[P.active], rec, await getNotes(), M);
    let r;
    try {
      r = await CopilotBridge.ask(out.text, { timeoutMs: 240000, retries: 1, onChunk: t => { partial.set(id, t); if (openId === id) renderPanel(); } });
    } catch (e) {
      partial.delete(id);
      if (e.code === "disabled") e.message = "The Copilot pool is off - turn it on in the extension popup (Copilot pool tab). You can still use Copy prompt.";
      else if (e.code === "timeout") e.message = "Copilot took too long to answer - try again.";
      throw e;
    }
    partial.delete(id);
    const markdown = (r.markdown || "").trim(), text = (r.text || "").trim();
    if (!markdown && !text) { const e = new Error("Copilot sent back an empty answer - try again"); e.code = "empty"; throw e; }
    if ((text || markdown).length < 500 && BLOCKED.test(text || markdown)) {
      const e = new Error("Copilot refused because of an organization policy (data protection). Something in the email still trips it: tighten the masking rules in the extension settings, or use Copy prompt with another AI.");
      e.code = "blocked"; throw e;
    }
    failInfo.delete(id);
    await saveAnswer(id, { markdown: markdown || text, text: text || markdown, askedAt: new Date().toISOString(), ms: r.ms || 0, preset: P.active, masked: M.enabled ? out.masked : null, subject: rec.subject || "" });
  }
  async function pipeline(id, reread) {
    failInfo.delete(id); partial.delete(id);
    try {
      let rec = null;
      if (!reread && captured.has(id)) rec = await loadRecord(id);
      if (!rec) {
        setState(id, "reading");
        rec = await new Promise((res, rej) => enqueue(() => readEmail(id).then(res, rej)));   // Outlook clicks run one at a time...
      }
      setState(id, "asking");
      await askAI(id, rec);                                                                     // ...Copilot answers run in parallel in the pool
      states.delete(id);
      toast("AI suggestion ready - open it with the arrow");
    } catch (e) {
      console.warn("[WO Checker / Outlook] failed", e);
      failInfo.set(id, { message: e.message || String(e), code: e.code || "" });
      toast(e.message || String(e), true);
      states.set(id, "fail");
    }
    refreshButtons(); renderPanel();
  }

  // ---------- run clicks one at a time ----------
  let chain = Promise.resolve(), pending = 0;
  const enqueue = fn => { pending++; chain = chain.then(fn).catch(() => {}).then(() => { pending--; }); };

  // ---------- Outlook menu helpers ----------
  const findSearch = () => document.querySelector('input[aria-label="Search for a category"]');
  const findItem = name => {
    const want = name.trim().toLowerCase();
    for (const el of document.querySelectorAll('[role="menuitemcheckbox"][name="categorize"]'))
      if ((el.getAttribute("title") || el.textContent || "").trim().toLowerCase() === want) return el;
    return null;
  };
  function setNative(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const noMenus = () => !document.querySelector(".fui-MenuPopover");
  async function closeMenus() {
    for (let i = 0; i < 3; i++) {
      if (noMenus()) return;
      const t = document.activeElement || document.body;
      key(t, "keydown", "Escape", "Escape", 27); key(t, "keyup", "Escape", "Escape", 27);
      if (await waitFor(noMenus, 350, 15)) return;
    }
    if (!noMenus()) {
      // click "outside" on the root element so Outlook closes any menu that is still open
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) fire(document.documentElement, type);
      await waitFor(noMenus, 300, 15);
    }
  }

  const findCategorize = () =>
    document.querySelector('[role="menuitem"][aria-label="Categorize"]') ||
    [...document.querySelectorAll('.fui-MenuPopover [role="menuitem"]')].find(el => /^categorize$/i.test((el.textContent || "").trim()));
  const findRow = id => document.querySelector(`${ROW_SEL}[data-convid="${CSS.escape(id)}"]`);

  // Outlook re-renders the list after every change, so the row is looked up again by its id and the
  // right-click is retried (a plain contextmenu first, then a fuller mouse sequence like a real right-click).
  async function openContextMenu(convId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await waitFor(() => findRow(convId), 2000);
      if (!row) throw new Error("That email moved - click the button again");
      const target = attempt === 2 ? row : (row.querySelector("span[title]") || row);
      const r = target.getBoundingClientRect();
      const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
      const init = { clientX: x, clientY: y, screenX: x, screenY: y, button: 2, buttons: 2 };
      if (attempt > 0) {
        for (const t of ["pointerdown", "mousedown"]) fire(target, t, init);
        await sleep(60);
        for (const t of ["pointerup", "mouseup"]) fire(target, t, { ...init, buttons: 0 });
      }
      fire(target, "contextmenu", init);
      const item = await waitFor(findCategorize, attempt === 0 ? 1500 : 2200);
      if (item) return item;
      await closeMenus();
      await sleep(300);
    }
    throw new Error("Outlook's right-click menu didn't open");
  }

  async function applyCategory(convId) {
    const name = (cfg.active || "").trim();
    if (!name) { toast("Pick a category in the extension popup first", true); return; }
    if (!convId) { toast("Couldn't identify that email", true); return; }
    document.documentElement.classList.add("woc-busy");
    const t0 = performance.now(), lap = {}; let last = t0;
    const mark = k => { const n = performance.now(); lap[k] = Math.round(n - last); last = n; };
    try {
      await closeMenus(); mark("cleanup");
      const catItem = await openContextMenu(convId); mark("rightClick");
      for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"]) fire(catItem, type);
      catItem.click();

      let input = await waitFor(findSearch, 900);
      if (!input) {
        key(catItem, "keydown", "ArrowRight", "ArrowRight", 39);
        input = await waitFor(findSearch, 2000);
      }
      if (!input) throw new Error("Couldn't open Outlook's Categorize list");
      mark("submenu");
      input.focus();
      setNative(input, name); // search by name so rarely-used categories are found too

      const item = await waitFor(() => findItem(name), 2500);
      if (!item) throw new Error(`Category "${name}" not found - check the spelling`);
      mark("search");
      if (item.getAttribute("aria-checked") === "true") {
        toast(`Already has: ${name}`);
      } else {
        item.click();
        toast(`Added: ${name}`); // instant feedback, then verify quietly
        const ok = await waitFor(() => { const it = findItem(name); return it && it.getAttribute("aria-checked") === "true"; }, 700);
        if (!ok) toast(`Clicked "${name}" - double-check the email`, true);
        mark("tick");
      }
    } catch (e) {
      console.warn("[WO Checker / Outlook]", e);
      toast(e.message || String(e), true);
    } finally {
      await closeMenus(); mark("close");
      if (pending > 1) await sleep(200); // only pause when more emails are queued behind this one
      document.documentElement.classList.remove("woc-busy");
      console.debug("[WO Checker / Outlook] ms per step:", lap, "total", Math.round(performance.now() - t0));
    }
  }

  // ---------- read the email content ----------
  function rowInfo(row) {
    const spans = [...row.querySelectorAll("span[title]")];
    const dateEl = spans.find(x => /\d{1,2}:\d{2}/.test(x.getAttribute("title") || ""));
    const senderEl = spans.find(x => x !== dateEl);
    const subjEl = row.querySelector(".TtcXM");
    const prevEl = row.querySelector(".ASFJj");
    return {
      convId: row.getAttribute("data-convid"),
      subject: norm(subjEl ? subjEl.textContent : ""),
      from: senderEl ? norm(senderEl.getAttribute("title")) : "",
      receivedAt: dateEl ? norm(dateEl.getAttribute("title")) : "",
      preview: norm(prevEl ? prevEl.textContent : ""),
      tags: [...row.querySelectorAll(".fui-Tag")].map(t => norm(t.textContent)).filter(Boolean),
      wasUnread: !!row.querySelector('button[title="Mark as read"]')
    };
  }
  const inList = el => !!(el.closest('[role="listbox"]') || el.closest(ROW_SEL));
  const hasList = el => !!el.querySelector('[role="listbox"]');

  // Finds the reading pane that is currently showing this email (checks subject, and the received time when strict).
  function locateMessage(info, strict) {
    if (!info.subject) return null;
    const ok = el => {
      const t = norm(el.innerText);
      return t.includes(info.subject) && (!strict || !info.receivedAt || t.includes(info.receivedAt));
    };
    const bodies = [...document.querySelectorAll('[id^="UniqueMessageBody"], [aria-label="Message body"], div[role="document"]')].filter(b => !inList(b));
    for (const body of bodies) {
      let c = body;
      for (let i = 0; i < 14 && c && c !== document.body && !hasList(c); i++, c = c.parentElement)
        if (ok(c)) return { body, container: c, via: "body" };
    }
    // fallback: smallest region on the page (outside the message list) that shows this subject
    let best = null, bestLen = Infinity;
    for (const c of document.querySelectorAll('[role="main"], [role="region"], [role="document"], [role="article"]')) {
      if (inList(c) || hasList(c) || !ok(c)) continue;
      const len = (c.innerText || "").length;
      if (len < bestLen) { best = c; bestLen = len; }
    }
    return best ? { body: best, container: best, via: "fallback" } : null;
  }

  function selectRow(row) {
    const target = row.querySelector("span[title]") || row;
    const r = target.getBoundingClientRect();
    const init = { clientX: r.left + 10, clientY: r.top + r.height / 2, button: 0, buttons: 1 };
    for (const t of ["pointerdown", "mousedown"]) fire(target, t, init);
    for (const t of ["pointerup", "mouseup", "click"]) fire(target, t, { ...init, buttons: 0 });
  }

  function extract(info, loc) {
    const bodyText = (loc.body.innerText || "").trim();
    const full = (loc.container.innerText || "").trim();
    let header = "";
    if (loc.via === "body") {
      const probe = bodyText.slice(0, 40), i = probe ? full.indexOf(probe) : -1;
      if (i > 0) header = full.slice(0, i).trim();
    }
    const links = [];
    for (const a of loc.body.querySelectorAll("a[href]")) {
      if (!/^https?:/i.test(a.href)) continue;
      links.push({ text: norm(a.innerText), href: a.href });
      if (links.length >= 50) break;
    }
    return { ...info, category: cfg.active, header, body: loc.via === "body" ? bodyText : full, links, via: loc.via, capturedAt: new Date().toISOString() };
  }

  async function saveRecord(rec) {
    const d = await chrome.storage.local.get("outlookEmails");
    const all = d.outlookEmails || {};
    all[rec.convId] = rec;
    const ids = Object.keys(all);
    if (ids.length > 300) {
      ids.sort((a, b) => (all[a].capturedAt || "").localeCompare(all[b].capturedAt || ""));
      for (const k of ids.slice(0, ids.length - 300)) delete all[k];
    }
    await chrome.storage.local.set({ outlookEmails: all });
  }

  async function readEmail(id) {
    const t0 = performance.now();
    try {
      const row = await waitFor(() => findRow(id), 2000);
      if (!row) throw new Error("That email moved - click again");
      const info = rowInfo(row);
      if (row.getAttribute("aria-selected") !== "true") selectRow(row);

      let loc = null, lastLen = -1, stable = 0;
      const start = Date.now();
      while (Date.now() - start < 9000) {
        loc = locateMessage(info, Date.now() - start < 3500);
        if (loc) {
          const len = (loc.container.innerText || "").length;
          stable = len === lastLen ? stable + 1 : 0; lastLen = len;
          if (stable >= 2) break;
        } else stable = 0;
        if (Date.now() - start > 700 && !loc && findRow(id) && findRow(id).getAttribute("aria-selected") !== "true" && Date.now() - start < 900)
          selectRow(findRow(id)); // one more nudge if the first click didn't select it
        await sleep(120);
      }
      if (!loc || stable < 2) throw new Error("Couldn't find this email in the reading pane");

      const rec = extract(info, loc);
      if (!rec.body) throw new Error("The email body looked empty");

      // keep the shared inbox honest: if it was unread before and Outlook marked it read, put it back to unread
      let restored = false;
      if (info.wasUnread) {
        const rw = await waitFor(() => { const r = findRow(id); return r && r.querySelector('button[title="Mark as unread"]') ? r : null; }, 1500);
        if (rw) { rw.querySelector('button[title="Mark as unread"]').click(); restored = true; }
      }
      rec.restoredUnread = restored;
      await saveRecord(rec);
      captured.add(id);
      console.debug("[WO Checker / Outlook] read email", { via: rec.via, chars: rec.body.length, restoredUnread: restored, ms: Math.round(performance.now() - t0) });
      return rec;
    } catch (e) {
      console.warn("[WO Checker / Outlook] read failed", e);
      throw e;
    }
  }

  async function copyCaptured(id) {
    try {
      const d = await chrome.storage.local.get("outlookEmails");
      const r = (d.outlookEmails || {})[id];
      if (!r) { captured.delete(id); setState(id, "idle"); toast("Nothing saved for this email - click Read again", true); return; }
      const P = await getPrompts();
      const M = await getMask();
      const out = buildPrompt(P.presets[P.active], r, await getNotes(), M);
      const text = out.text;
      try { await navigator.clipboard.writeText(text); }
      catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
      toast(`Copied prompt "${P.active}" (${text.length} characters, ` + (M.enabled ? `${out.masked} item(s) masked)` : "masking is OFF)"));
    } catch (e) { toast("Couldn't copy: " + (e.message || e), true); }
  }

  // ---------- settings from the popup ----------
  function applyCfg(v) {
    cfg = Object.assign({ enabled: true, readBtn: true, active: "", list: [] }, v || {});
    refreshButtons();
  }
  chrome.storage.local.get(["outlookCat", "outlookEmails", "outlookAnswers"]).then(d => {
    captured = new Set(Object.keys(d.outlookEmails || {}));
    answers = d.outlookAnswers || {};
    applyCfg(d.outlookCat);
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.outlookEmails) { captured = new Set(Object.keys(ch.outlookEmails.newValue || {})); refreshButtons(); }
    if (ch.outlookAnswers) { answers = ch.outlookAnswers.newValue || {}; refreshButtons(); renderPanel(); }
    if (ch.outlookCat) applyCfg(ch.outlookCat.newValue);
  });
  schedule();
})();
