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
    .woc-bar{position:absolute;right:10px;bottom:5px;z-index:5;display:flex;gap:4px;align-items:center}
    .woc-btn{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font:600 11px system-ui,Segoe UI,sans-serif;line-height:16px;padding:1px 8px;border-radius:10px;border:1px solid #2b88d8;
      background:#0f548c;color:#fff;cursor:pointer;opacity:.8}
    .woc-btn:hover{opacity:1;background:#115ea3}
    .woc-btn.woc-off{background:#555;border-color:#777}
    .woc-read{flex:none}
    .woc-read.woc-idle{background:#e8710a;border-color:#ffa24d;color:#fff}
    .woc-read.woc-idle:hover{background:#ff8a24}
    .woc-read.woc-working{background:#f2c811;border-color:#fff09a;color:#222;cursor:progress}
    .woc-read.woc-done{background:#107c10;border-color:#5fd35f;color:#fff}
    .woc-read.woc-fail{background:#c50f1f;border-color:#ff7b86;color:#fff}
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
  const states = new Map();          // convId -> "working" | "done" | "fail" (this page session)
  let captured = new Set();          // convIds whose content is already saved
  const getState = id => states.get(id) || (captured.has(id) ? "done" : "idle");
  function setState(id, st) { states.set(id, st); refreshButtons(); }
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setTitle = (el, t) => { if (el.title !== t) el.title = t; };

  const label = () => "\u{1F3F7} " + (cfg.active || "pick category");
  const guard = b => {
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"])
      b.addEventListener(t, e => e.stopPropagation(), true);
  };
  function makeCatButton(row) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "woc-btn woc-cat";
    guard(b);
    b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const r = b.closest(ROW_SEL) || row;
      enqueue(() => applyCategory(r.getAttribute("data-convid")));
    }, true);
    return b;
  }
  function makeReadButton(row) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "woc-btn woc-read woc-idle";
    guard(b);
    b.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const r = b.closest(ROW_SEL) || row;
      const id = r.getAttribute("data-convid");
      const st = getState(id);
      if (st === "working") return;
      if (st === "done" && !e.shiftKey) { copyCaptured(id); return; }   // green: copy the AI prompt built from what was captured
      setState(id, "working");
      enqueue(() => readEmail(id));
    }, true);
    return b;
  }
  const READ_TEXT = { idle: "\u{1F4E5} Read", working: "\u23F3 Reading...", done: "\u{1F4CB} Prompt", fail: "\u26A0 Retry" };
  const READ_TITLE = {
    idle: "Read this email's content (orange = not read yet)",
    working: "Getting the content of this email...",
    done: "Content saved. Click = copy the AI prompt (edit it in the extension settings), Shift+click = read again",
    fail: "Couldn't read it - click to try again"
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
    for (const row of document.querySelectorAll(ROW_SEL)) {
      let bar = row.querySelector(":scope > .woc-bar");
      if (!cfg.enabled) { if (bar) bar.remove(); continue; }
      if (!bar) {
        if (getComputedStyle(row).position === "static") row.style.position = "relative";
        bar = document.createElement("div"); bar.className = "woc-bar";
        bar.appendChild(makeCatButton(row)); row.appendChild(bar);
      }
      const cb = bar.querySelector(".woc-cat");
      setText(cb, label());
      cb.classList.toggle("woc-off", !cfg.active);
      setTitle(cb, cfg.active ? `Add category "${cfg.active}" to this email` : "Pick a category in the extension popup first");

      const wantRead = cfg.readBtn !== false && rowHasTag(row, cfg.active);
      let rb = bar.querySelector(".woc-read");
      if (wantRead && !rb) { rb = makeReadButton(row); bar.appendChild(rb); }
      if (!wantRead && rb) { rb.remove(); rb = null; }
      if (rb) {
        const st = getState(row.getAttribute("data-convid"));
        const cls = "woc-btn woc-read woc-" + st;
        if (rb.className !== cls) rb.className = cls;
        setText(rb, READ_TEXT[st]); setTitle(rb, READ_TITLE[st]);
      }
    }
  }
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; refreshButtons(); }); };
  // ignore changes we make ourselves inside our own buttons/toast, otherwise this would loop forever
  new MutationObserver(muts => {
    if (muts.every(m => m.target.nodeType === 1 && m.target.closest && m.target.closest(".woc-bar,#woc-toast"))) return;
    schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });

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
      setState(id, "done");
      toast(`Read ${rec.body.length} characters` + (restored ? " (set back to unread)" : ""));
      console.debug("[WO Checker / Outlook] read email", { via: rec.via, chars: rec.body.length, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      console.warn("[WO Checker / Outlook] read failed", e);
      setState(id, "fail");
      toast(e.message || String(e), true);
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
  chrome.storage.local.get(["outlookCat", "outlookEmails"]).then(d => {
    captured = new Set(Object.keys(d.outlookEmails || {}));
    applyCfg(d.outlookCat);
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.outlookEmails) { captured = new Set(Object.keys(ch.outlookEmails.newValue || {})); states.clear(); refreshButtons(); }
    if (ch.outlookCat) applyCfg(ch.outlookCat.newValue);
  });
  schedule();
})();
