// Copilot pool - runs inside a pool Copilot tab. Dormant unless the broker says this tab is a pool tab.
// Per job: (reset chat if needed) -> paste prompt -> send -> wait for answer -> report -> reset to a fresh chat.
// Everything waits on DOM mutations (not timers) because hidden tabs get their timers throttled to ~1/second.
(() => {
  if (window.__cbWorker) return;
  window.__cbWorker = true;

  let port = null, active = false, state = "init", current = null, copilotUrl = "/chat", hb = null;

  const norm = s => (s || "").replace(/\s+/g, " ").trim();
  const log = (m, d) => {
    console.debug("[WO Checker / Copilot pool]", m, d === undefined ? "" : d);
    try { port && port.postMessage({ t: "log", m, d: d === undefined ? undefined : String(d).slice(0, 300) }); } catch {}
  };
  const send = m => { try { port && port.postMessage(m); } catch {} };
  const setState = s => { state = s; send({ t: "state", state: s }); };

  // Resolves as soon as pred() is truthy; re-checks on every DOM mutation (works in hidden tabs).
  function waitUntil(pred, timeout = 5000) {
    return new Promise(resolve => {
      let done = false, queued = false, tm = 0, iv = 0, mo = null;
      const fin = v => { if (done) return; done = true; mo.disconnect(); clearTimeout(tm); clearInterval(iv); resolve(v); };
      const check = () => { queued = false; if (done) return; let v = null; try { v = pred(); } catch {} if (v) fin(v); };
      mo = new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(check); } });
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      tm = setTimeout(() => fin(null), timeout);
      iv = setInterval(check, 300);
      check();
    });
  }

  // ---------- selectors (from the real Copilot page) ----------
  const getEditor = () =>
    document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
    document.querySelector('span[role="textbox"][contenteditable="true"]');
  const editorText = () => { const e = getEditor(); return e ? norm(e.innerText) : ""; };
  const questionCount = () => document.querySelectorAll('[data-testid="chatQuestion"]').length;
  const isClean = () => !!getEditor() && questionCount() === 0 && editorText() === "";

  function findSendButton() {
    const root = document.querySelector(".fai-BebopLiteChatInput") || document;
    return [...root.querySelectorAll("button")].find(b => {
      const l = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("data-testid") || "") + " " + (b.title || "");
      return /send|submit/i.test(l) && !/dictat|stop/i.test(l);
    }) || null;
  }
  function pressEnter(el) {
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // ---------- reset to a fresh chat ----------
  async function resetChat() {
    if (isClean()) return true;
    const link = document.querySelector('a[aria-label="New chat"]') ||
      [...document.querySelectorAll("a")].find(a => /new chat/i.test(a.getAttribute("aria-label") || ""));
    if (link) link.click();
    if (await waitUntil(isClean, link ? 4000 : 200)) return true;
    log("New chat didn't clear the page - reloading", link ? "link clicked" : "no link");
    location.href = copilotUrl || "/chat";
    return false; // the page reloads and this script starts over
  }
  async function resetAndReady() {
    setState("resetting");
    if (await resetChat()) setState("ready");
  }

  // ---------- put the prompt in the box ----------
  const hasPrompt = text => {
    const have = editorText().length, want = norm(text).length;
    if (have >= Math.min(want, Math.max(1, want * 0.9))) return true;
    const att = document.querySelector(".fai-BebopLiteChatInput__attachments");
    return !!(att && att.children.length); // very long pastes can turn into an attachment chip
  };
  async function insertText(editor, text) {
    editor.focus();
    const sel = getSelection(); sel.removeAllRanges();
    const r = document.createRange(); r.selectNodeContents(editor); sel.addRange(r);
    const dt = new DataTransfer(); dt.setData("text/plain", text);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    if (await waitUntil(() => hasPrompt(text), 800)) return "paste";
    log("paste didn't take - using insertText");
    editor.focus(); document.execCommand("selectAll"); document.execCommand("insertText", false, text);
    if (await waitUntil(() => hasPrompt(text), 800)) return "insertText";
    throw new Error("Couldn't type the prompt into Copilot");
  }
  async function submit(editor, before) {
    const sent = () => questionCount() > before || editorText() === "";
    const btn = findSendButton();
    if (btn && !btn.disabled) btn.click(); else pressEnter(editor);
    if (await waitUntil(sent, 1500)) return;
    log("first send attempt didn't register", btn ? "button" : "enter");
    const b2 = findSendButton();
    if (btn) pressEnter(editor); else if (b2) b2.click(); else pressEnter(editor);
    if (!(await waitUntil(sent, 3000))) throw new Error("Couldn't send the message");
  }

  // ---------- read the answer ----------
  function answerState() {
    const msgs = document.querySelectorAll('[data-testid="copilot-message-div"]');
    const last = msgs[msgs.length - 1];
    if (!last) return null;
    const art = last.querySelector(".fai-CopilotMessage");
    return {
      last,
      busy: art ? art.getAttribute("aria-busy") === "true" : true,
      hasCopy: !!last.querySelector('[data-testid="CopyButtonTestId"]')
    };
  }
  const answerNodes = last => [...last.querySelectorAll('[data-testid="markdown-reply"]')];
  const answerText = last => answerNodes(last).map(n => n.innerText.trim()).filter(Boolean).join("\n\n");

  function toMd(root) {
    const walk = n => {
      if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, " ");
      if (n.nodeType !== 1) return "";
      const tag = n.tagName.toLowerCase();
      const kids = () => [...n.childNodes].map(walk).join("");
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "\n\n" + "#".repeat(+tag[1]) + " " + kids().trim() + "\n\n";
        case "p": return "\n\n" + kids().trim() + "\n\n";
        case "br": return "\n";
        case "strong": case "b": return "**" + kids().trim() + "**";
        case "em": case "i": return "*" + kids().trim() + "*";
        case "code": return n.parentElement && n.parentElement.tagName === "PRE" ? n.textContent : "`" + n.textContent + "`";
        case "pre": {
          const c = n.querySelector("code"), m = c && (c.className || "").match(/language-([\w-]+)/);
          return "\n\n```" + (m ? m[1] : "") + "\n" + n.textContent.replace(/\n$/, "") + "\n```\n\n";
        }
        case "a": { const t = kids().trim(), h = n.getAttribute("href"); return h && /^https?:/i.test(h) ? `[${t}](${h})` : t; }
        case "ul": case "ol": {
          let i = 0;
          const items = [...n.children].filter(c => c.tagName === "LI").map(li => {
            i++; const body = walk(li).trim().replace(/\n/g, "\n  ");
            return (tag === "ol" ? i + ". " : "- ") + body;
          });
          return "\n\n" + items.join("\n") + "\n\n";
        }
        case "table": {
          const rows = [...n.querySelectorAll("tr")].map(tr => [...tr.children].map(c => c.textContent.trim().replace(/\s+/g, " ").replace(/\|/g, "\\|")));
          if (!rows.length) return "";
          const head = rows[0];
          return "\n\n" + ["| " + head.join(" | ") + " |", "| " + head.map(() => "---").join(" | ") + " |", ...rows.slice(1).map(r => "| " + r.join(" | ") + " |")].join("\n") + "\n\n";
        }
        case "blockquote": return "\n\n" + kids().trim().split("\n").map(l => "> " + l).join("\n") + "\n\n";
        case "hr": return "\n\n---\n\n";
        case "style": case "script": case "button": case "svg": return "";
        default: return kids();
      }
    };
    return walk(root).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function waitForAnswer(job, before) {
    let lastSent = "", lastAt = 0;
    const check = () => {
      if (job.aborted) return "ABORT";
      const a = answerState();
      if (!a) return null;
      if (job.stream && a.busy) {
        const now = performance.now();
        if (now - lastAt > 80) {
          const t = answerText(a.last);
          if (t && t !== lastSent) { lastSent = t; lastAt = now; send({ t: "chunk", jobId: job.id, text: t }); }
        }
      }
      return !a.busy && a.hasCopy && answerText(a.last) ? a : null; // done = Copilot cleared its "busy" flag and the toolbar showed up
    };
    const a = await waitUntil(check, 10 * 60 * 1000);
    if (job.aborted || a === "ABORT") throw new Error("aborted");
    if (!a) throw new Error("No answer from Copilot");
    const nodes = answerNodes(a.last);
    return { text: answerText(a.last), markdown: nodes.map(toMd).filter(Boolean).join("\n\n") };
  }

  // ---------- one job ----------
  async function runJob(m) {
    const job = { id: m.jobId, stream: !!m.stream, aborted: false };
    current = job;
    setState("busy");
    const t0 = performance.now();
    try {
      if (!isClean()) { if (!(await resetChat())) return; }
      const editor = await waitUntil(getEditor, 8000);
      if (!editor) throw new Error("Copilot's input box wasn't found (signed out?)");
      const before = questionCount();
      const how = await insertText(editor, m.prompt);
      await submit(editor, before);
      const res = await waitForAnswer(job, before);
      send({ t: "result", jobId: job.id, ok: true, text: res.text, markdown: res.markdown });
      log("job done", `${Math.round(performance.now() - t0)}ms via ${how}, ${res.text.length} chars`);
    } catch (e) {
      if (!job.aborted) send({ t: "result", jobId: job.id, ok: false, error: e && e.message || String(e) });
      log("job failed", e && e.message);
    } finally {
      current = null;
      await resetAndReady();
    }
  }

  // ---------- connection to the broker ----------
  function onMsg(m) {
    if (!m) return;
    if (m.t === "job") { if (current) send({ t: "result", jobId: m.jobId, ok: false, error: "tab busy" }); else runJob(m); }
    else if (m.t === "abort") { if (current && current.id === m.jobId) current.aborted = true; }
  }
  async function connect() {
    if (port) return;
    try { port = chrome.runtime.connect({ name: "cb-worker" }); } catch { return; }
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(() => { port = null; if (active) setTimeout(connect, 400); });
    if (!hb) hb = setInterval(() => send({ t: "ping" }), 20000);
    if (current) setState("busy");
    else if (await waitUntil(getEditor, 30000)) await resetAndReady();
    else log("no input box after 30s (signed out or a different page?)", location.href);
  }
  function activate() { if (active) return; active = true; connect(); }

  try {
    chrome.runtime.onMessage.addListener(m => { if (m && m.cb === "activate") activate(); });
    chrome.runtime.sendMessage({ cb: "whoami" }).then(r => { if (r && r.pool) { copilotUrl = r.url || copilotUrl; activate(); } }).catch(() => {});
  } catch {}
})();
