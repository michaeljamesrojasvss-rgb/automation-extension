(() => {
"use strict";
// Copilot pool - broker (runs inside the extension's background service worker).
// Keeps a pool of Copilot tabs + a job queue. Callers connect with a port named "cb-ask"; Copilot tabs use "cb-worker".
// Wrapped in an IIFE so nothing leaks into the rest of background.js.

const GROUP_TITLE = "WO Checker - Copilot";
const DEFAULTS = {
  cbEnabled: false,   // the pool is OFF until you turn it on in the popup
  cbPoolSize: 3,
  cbUrl: "https://copilot.cloud.microsoft/chat"
};

let S = { ...DEFAULTS };
const settingsReady = chrome.storage.local.get(DEFAULTS).then(d => { S = d; });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(ch)) S[k] = ch[k].newValue === undefined ? DEFAULTS[k] : ch[k].newValue;
  if (ch.cbPoolSize || ch.cbEnabled || ch.cbUrl) ensurePool();
});

let adopted = new Set();
const adoptedReady = (chrome.storage.session
  ? chrome.storage.session.get({ adopted: [] }).then(d => { adopted = new Set(d.adopted); })
  : Promise.resolve());
const saveAdopted = () => chrome.storage.session && chrome.storage.session.set({ adopted: [...adopted] });

const workers = new Map();   // tabId -> { port, state, jobId, done, fails, lastMs, since }
const queue = [];            // jobs waiting for a free tab
const jobs = new Map();      // jobId -> job (queued or running)
const recent = [];           // recent finished jobs (for the popup)
const logs = [];
let seq = 0;

function log(src, msg, data) {
  logs.push({ t: Date.now(), src, msg: String(msg), data: data === undefined ? "" : String(data).slice(0, 300) });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
}

// ---------------------------------------------------------------- pool tabs
async function poolGroupIds() {
  try { return (await chrome.tabGroups.query({ title: GROUP_TITLE })).map(g => g.id); } catch { return []; }
}
async function isPoolTab(tab) {
  await adoptedReady;
  if (!tab) return false;
  if (adopted.has(tab.id)) return true;
  if (tab.groupId >= 0) return (await poolGroupIds()).includes(tab.groupId);
  return false;
}
async function poolTabs() {
  const all = await chrome.tabs.query({});
  const out = [];
  for (const t of all) if (await isPoolTab(t)) out.push(t);
  return out;
}
// runs in the PAGE: keeps the pool tab rendering/running even while hidden (same idea the WO scanner uses)
function pageKeepAlive() {
  try {
    if (window.__cbKeep) return; window.__cbKeep = true;
    const def = (o, k, v) => { try { Object.defineProperty(o, k, { configurable: true, get: () => v }); } catch (e) {} };
    def(document, "hidden", false); def(document, "webkitHidden", false);
    def(document, "visibilityState", "visible"); def(document, "webkitVisibilityState", "visible");
    try { document.hasFocus = () => true; } catch (e) {}
    const stop = e => { try { e.stopImmediatePropagation(); } catch (_) {} };
    window.addEventListener("visibilitychange", stop, true); document.addEventListener("visibilitychange", stop, true);
    let rid = 0; const timers = new Map();
    window.requestAnimationFrame = cb => { const i = ++rid; timers.set(i, setTimeout(() => { timers.delete(i); try { cb(performance.now()); } catch (e) {} }, 16)); return i; };
    window.cancelAnimationFrame = i => { const t = timers.get(i); if (t) { clearTimeout(t); timers.delete(i); } };
    try { navigator.locks.request("cb-keepalive", () => new Promise(() => {})); } catch (e) {} // exempts the tab from intensive timer throttling
  } catch (e) {}
}
const activate = tab => {
  chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: pageKeepAlive }).catch(() => {});
  chrome.tabs.sendMessage(tab.id, { cb: "activate" }).catch(() => {});
};

let ensuring = null;
function ensurePool() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    try {
      await settingsReady;
      if (!S.cbEnabled) return;
      const size = Math.max(1, Math.min(10, Number(S.cbPoolSize) || 1));
      const tabs = await poolTabs();
      const need = size - tabs.length;
      if (need > 0) {
        let groups = [];
        try { groups = await chrome.tabGroups.query({ title: GROUP_TITLE }); } catch {}
        const existing = groups[0];
        const ids = [];
        for (let i = 0; i < need; i++) {
          const opts = { url: S.cbUrl, active: false };
          if (existing) opts.windowId = existing.windowId;
          const t = await chrome.tabs.create(opts);
          ids.push(t.id);
          chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
        }
        const gid = await chrome.tabs.group(existing ? { tabIds: ids, groupId: existing.id } : { tabIds: ids });
        await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: "purple", collapsed: true });
        log("bg", "opened pool tabs", ids.join(","));
      } else if (need < 0) {
        // too many: close idle, non-adopted ones first
        const extras = tabs.filter(t => !adopted.has(t.id))
          .sort((a, b) => (workers.has(a.id) ? 1 : 0) - (workers.has(b.id) ? 1 : 0));
        let n = -need;
        for (const t of extras) {
          if (n <= 0) break;
          const w = workers.get(t.id);
          if (w && w.state !== "ready") continue;
          await chrome.tabs.remove(t.id).catch(() => {});
          n--;
        }
      }
    } catch (e) { log("bg", "ensurePool failed", e && e.message); }
    finally { ensuring = null; }
  })();
  return ensuring;
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" || info.groupId !== undefined) isPoolTab(tab).then(ok => { if (ok) activate(tab); });
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (adopted.delete(tabId)) saveAdopted();
  setTimeout(ensurePool, 600);
});
chrome.alarms.create("cb-tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== "cb-tick") return;
  await ensurePool();
  for (const t of await poolTabs()) if (!workers.has(t.id)) activate(t);
});
chrome.runtime.onInstalled.addListener(() => ensurePool());
chrome.runtime.onStartup.addListener(() => ensurePool());
ensurePool();

// ---------------------------------------------------------------- jobs
function enqueue(port, msg) {
  const o = msg.opts || {};
  const job = {
    jobId: ++seq, port, reqId: msg.id,
    prompt: String(msg.prompt == null ? "" : msg.prompt),
    stream: !!o.stream,
    timeoutMs: Math.max(5000, Math.min(600000, Number(o.timeoutMs) || 120000)),
    priority: Number(o.priority) || 0,
    retries: o.retries == null ? 1 : Math.max(0, Number(o.retries) | 0),
    tries: 0, tried: new Set(), enqueuedAt: Date.now(), startedAt: 0, tabId: null, timer: null
  };
  if (!S.cbEnabled) return reply(job, { type: "error", code: "disabled", error: "The Copilot pool is turned off. Turn it on in the extension popup (Copilot pool tab)." });
  if (!job.prompt.trim()) return reply(job, { type: "error", code: "empty", error: "Empty prompt" });
  jobs.set(job.jobId, job);
  queue.push(job);
  log("bg", "queued", `#${job.jobId} ${job.prompt.length} chars`);
  ensurePool();
  dispatch();
}

function reply(job, m) { try { job.port.postMessage({ id: job.reqId, ...m }); } catch {} }

function dispatch() {
  if (!queue.length) return;
  queue.sort((a, b) => b.priority - a.priority || a.jobId - b.jobId);
  const ready = [...workers.entries()].filter(([, w]) => w.state === "ready").sort((a, b) => a[1].since - b[1].since);
  for (const [tabId, w] of ready) {
    if (!queue.length) break;
    const idx = queue.findIndex(j => !j.tried.has(tabId));
    if (idx < 0) continue;
    assign(queue.splice(idx, 1)[0], tabId, w);
  }
}

function assign(job, tabId, w) {
  w.state = "busy"; w.jobId = job.jobId; w.since = Date.now();
  job.tabId = tabId; job.tries++; job.tried.add(tabId); job.startedAt = Date.now();
  job.timer = setTimeout(() => onTimeout(job), job.timeoutMs);
  try { w.port.postMessage({ t: "job", jobId: job.jobId, prompt: job.prompt, stream: job.stream }); }
  catch { failOrRetry(job, "Couldn't reach the Copilot tab"); }
  log("bg", "assigned", `#${job.jobId} -> tab ${tabId}`);
}

function release(job) {
  clearTimeout(job.timer); job.timer = null;
  jobs.delete(job.jobId);
}

function finishOk(job, m) {
  const ms = Date.now() - job.startedAt, queuedMs = job.startedAt - job.enqueuedAt;
  release(job);
  recent.unshift({ at: Date.now(), ms, queuedMs, chars: (m.text || "").length, ok: true });
  if (recent.length > 30) recent.pop();
  reply(job, { type: "done", text: m.text, markdown: m.markdown, ms, queuedMs, tabId: job.tabId });
}
function finishErr(job, code, error) {
  release(job);
  recent.unshift({ at: Date.now(), ms: job.startedAt ? Date.now() - job.startedAt : 0, queuedMs: 0, chars: 0, ok: false, error });
  if (recent.length > 30) recent.pop();
  reply(job, { type: "error", code, error });
}
function failOrRetry(job, error) {
  clearTimeout(job.timer); job.timer = null;
  if (job.tries <= job.retries) {
    if ([...workers.keys()].every(id => job.tried.has(id))) job.tried.clear();
    job.tabId = null;
    queue.push(job);
    log("bg", "retrying", `#${job.jobId}: ${error}`);
    ensurePool(); dispatch();
  } else finishErr(job, "failed", error);
}
function onTimeout(job) {
  if (!jobs.has(job.jobId)) return;
  const w = workers.get(job.tabId);
  if (w) { try { w.port.postMessage({ t: "abort", jobId: job.jobId }); } catch {} }
  log("bg", "timeout", `#${job.jobId}`);
  finishErr(job, "timeout", "Copilot took too long to answer");
}
function cancelByPort(port) {
  for (const job of [...jobs.values()]) {
    if (job.port !== port) continue;
    const qi = queue.indexOf(job);
    if (qi >= 0) queue.splice(qi, 1);
    else { const w = workers.get(job.tabId); if (w) { try { w.port.postMessage({ t: "abort", jobId: job.jobId }); } catch {} } }
    release(job);
  }
}

// ---------------------------------------------------------------- worker ports (Copilot tabs)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === "cb-worker") onWorkerPort(port);
  else if (port.name === "cb-ask") onCallerPort(port);
});

async function onWorkerPort(port) {
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (tabId == null) return port.disconnect();
  const w = { port, state: "init", jobId: null, done: 0, fails: 0, lastMs: 0, since: Date.now() };
  const old = workers.get(tabId);
  if (old && old.port !== port) { try { old.port.disconnect(); } catch {} }
  workers.set(tabId, w);
  port.onMessage.addListener(m => onWorkerMsg(tabId, w, m));
  port.onDisconnect.addListener(() => {
    if (workers.get(tabId) === w) workers.delete(tabId);
    const job = w.jobId && jobs.get(w.jobId);
    if (job && job.tabId === tabId) failOrRetry(job, "The Copilot tab went away");
  });
}

function onWorkerMsg(tabId, w, m) {
  switch (m.t) {
    case "ping": break;
    case "log": log("tab" + tabId, m.m, m.d); break;
    case "state":
      if (w.state === "busy" && m.state === "ready" && w.jobId && jobs.has(w.jobId)) break; // job still running here
      w.state = m.state; w.since = Date.now();
      if (m.state === "ready") { w.jobId = null; dispatch(); }
      break;
    case "chunk": {
      const job = jobs.get(m.jobId);
      if (job && job.stream) reply(job, { type: "chunk", text: m.text });
      break;
    }
    case "result": {
      const job = jobs.get(m.jobId);
      if (!job) break;
      w.lastMs = Date.now() - job.startedAt;
      w.jobId = null; // this tab is finished with the job either way
      if (m.ok) { w.done++; finishOk(job, m); }
      else { w.fails++; failOrRetry(job, m.error || "Copilot tab error"); }
      break;
    }
  }
}

// ---------------------------------------------------------------- caller ports (this extension's own pages / content scripts)
function onCallerPort(port) {
  port.onMessage.addListener(msg => {
    if (!msg) return;
    if (msg.type === "ask") enqueue(port, msg);
    else if (msg.type === "cancel") {
      for (const job of [...jobs.values()]) if (job.port === port && job.reqId === msg.id) {
        const qi = queue.indexOf(job);
        if (qi >= 0) queue.splice(qi, 1);
        else { const w = workers.get(job.tabId); if (w) { try { w.port.postMessage({ t: "abort", jobId: job.jobId }); } catch {} } }
        release(job);
      }
    } else if (msg.type === "status") { try { port.postMessage({ id: msg.id, type: "status", ...snapshot() }); } catch {} }
  });
  port.onDisconnect.addListener(() => cancelByPort(port));
}

function snapshot() {
  const ws = [...workers.entries()].map(([tabId, w]) => ({ tabId, state: w.state, done: w.done, fails: w.fails, lastMs: w.lastMs }));
  const ok = recent.filter(r => r.ok);
  return {
    settings: S, workers: ws,
    queued: queue.length, running: [...jobs.values()].filter(j => j.tabId != null && !queue.includes(j)).length,
    avgMs: ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length) : 0,
    recent: recent.slice(0, 8)
  };
}

// ---------------------------------------------------------------- commands from the popup / Copilot tabs
// All bridge messages carry a "cb" field so they never collide with the rest of the extension's messages.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.cb !== "string") return;
  (async () => {
    await settingsReady;
    if (msg.cb === "whoami") {
      const ok = sender.tab ? await isPoolTab(sender.tab) : false;
      return { pool: ok && !!S.cbEnabled, url: S.cbUrl };
    }
    if (sender.id !== chrome.runtime.id || sender.tab) return { error: "not allowed" };
    switch (msg.cb) {
      case "status": return snapshot();
      case "adopt": await adoptedReady; adopted.add(msg.tabId); saveAdopted();
        chrome.tabs.get(msg.tabId).then(activate).catch(() => {}); return { ok: true };
      case "release": adopted.delete(msg.tabId); saveAdopted(); return { ok: true };
      case "openPool": await ensurePool(); return { ok: true };
      case "closePool": {
        const tabs = await poolTabs();
        await chrome.tabs.remove(tabs.filter(t => !adopted.has(t.id)).map(t => t.id)).catch(() => {});
        return { ok: true };
      }
      case "logs": return { logs: logs.slice(-300) };
    }
    return { error: "unknown command" };
  })().then(sendResponse, e => sendResponse({ error: String(e && e.message || e) }));
  return true;
});
})();
