importScripts("settings.js", "runs.js", "bridge/broker.js");

// ===================== CONFIG =====================
const SF_SEARCH_PREFIX = "https://case-snow.lightning.force.com/one/one.app#";

// Status lists now come from the Settings page (presets). CFG is filled in at the start of each run.
let CFG = { sc: [], dt: [], sf: [], confirmFalse: true, sfAlways: true, sfAnyDone: true };

// Dollar Tree (OfficeTrax) vendor portal
const DT_HOME = "https://vendor.dollartree.officetrax.com/";

const MAX_ATTEMPTS = 4;      // most page checks per WO before giving up as UNSURE
const PAGE_GAP = 150;        // min ms between page loads started by this extension
// ==================================================

const scUrl = id => `https://www.servicechannel.com/sc/wo/workorders/list?id=${encodeURIComponent(id)}`;
function sfUrl(term) {
  const payload = JSON.stringify({
    componentDef: "forceSearch:searchPageDesktop",
    attributes: {
      term: String(term),
      scopeMap: { type: "TOP_RESULTS", namespace: "", label: "Top Results", labelPlural: "Top Results", resultsCmp: "forceSearch:predictedResults" },
      context: {
        FILTERS: {}, searchSource: "ASSISTANT_DIALOG", disableIntentQuery: false, disableSpellCorrection: false,
        debugInfo: { appName: "National_Operations", appType: "Standard", appNamespace: "c", location: "force:relatedListDesktop", sobjectType: "Work_Orders__r" }
      },
      groupId: "DEFAULT"
    },
    state: {}
  });
  return SF_SEARCH_PREFIX + btoa(unescape(encodeURIComponent(payload))).replace(/=/g, "%3D");
}

// =====================================================================
// Runs in the PAGE (MAIN world): pretend the helper tab is visible/focused so
// ServiceChannel and Salesforce keep rendering even in a background tab.
// (idea borrowed from the coworker's WO Scanner)
// =====================================================================
function visibilitySpoof() {
  try {
    if (window.__woSpoof) return;
    window.__woSpoof = true;
    const def = (o, k, v) => { try { Object.defineProperty(o, k, { configurable: true, get: () => v }); } catch (e) {} };
    def(document, "hidden", false); def(document, "webkitHidden", false);
    def(document, "visibilityState", "visible"); def(document, "webkitVisibilityState", "visible");
    try { document.hasFocus = () => true; } catch (e) {}
    const stop = e => { try { e.stopImmediatePropagation(); } catch (_) {} };
    window.addEventListener("visibilitychange", stop, true);
    document.addEventListener("visibilitychange", stop, true);
    let rid = 0; const timers = new Map();
    window.requestAnimationFrame = cb => { const i = ++rid; timers.set(i, setTimeout(() => { timers.delete(i); try { cb(performance.now()); } catch (e) {} }, 16)); return i; };
    window.cancelAnimationFrame = i => { const t = timers.get(i); if (t) { clearTimeout(t); timers.delete(i); } };
    // holding a Web Lock also exempts the page from Chrome's "intensive throttling" of long-hidden pages
    try { navigator.locks.request("woscan-keepalive", () => new Promise(() => {})); } catch (e) {}
  } catch (e) {}
}


// =====================================================================
// Runs in the PAGE (isolated world): defines window.__woSnap(elements) which returns a
// small, safe HTML copy of those elements (text + colors/fonts inlined, no scripts/images/links).
// Walks through shadow DOM too, so Salesforce Lightning fields are included.
// =====================================================================
function defineSnap() {
  if (window.__woSnap) return;
  const MAX_NODES = 220, MAX_TEXT = 2500;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|IFRAME|OBJECT|EMBED|IMG|SVG|CANVAS|VIDEO|AUDIO|TEMPLATE|HEAD|TITLE|PICTURE|SOURCE)$/i;
  const TAGS = new Set(["DIV", "SPAN", "B", "STRONG", "I", "EM", "P", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "UL", "OL", "LI", "LABEL", "SMALL", "H1", "H2", "H3", "H4", "H5", "H6", "BR"]);
  const NOSTYLE_DISPLAY = new Set(["TR", "TD", "TH", "TABLE", "THEAD", "TBODY", "LI", "BR"]);
  const INHERIT = ["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "text-align", "text-transform", "letter-spacing", "white-space", "text-decoration-line"];
  const BOX = ["background-color", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "display", "vertical-align", "flex-direction", "justify-content", "align-items", "gap"];

  function build(node, parentCS, st) {
    if (st.nodes >= MAX_NODES || st.text >= MAX_TEXT) return null;
    if (node.nodeType === 3) {
      const t = (node.nodeValue || "").replace(/\s+/g, " ");
      if (!t.trim()) return t ? document.createTextNode(" ") : null;
      st.text += t.length;
      return document.createTextNode(t);
    }
    if (node.nodeType !== 1) return null;
    const tag = node.tagName.toUpperCase();
    if (SKIP.test(tag)) return null;
    if (tag === "SLOT") {
      const wrap = document.createElement("span");
      let as = []; try { as = node.assignedNodes({ flatten: true }); } catch (e) {}
      for (const c of (as.length ? as : node.childNodes)) { const b = build(c, parentCS, st); if (b) wrap.appendChild(b); }
      return wrap;
    }
    let cs; try { cs = getComputedStyle(node); } catch (e) { return null; }
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    st.nodes++;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const sp = document.createElement("span");
      let v = node.value || "";
      if (tag === "SELECT" && node.selectedOptions && node.selectedOptions[0]) v = node.selectedOptions[0].text;
      sp.textContent = v; st.text += v.length;
      return sp;
    }
    const out = TAGS.has(tag) ? tag : (/^(block|flex|grid|table|list-item|flow-root)/.test(cs.display) ? "DIV" : "SPAN");
    const el = document.createElement(out);
    const css = [];
    for (const p of INHERIT) {
      const v = cs.getPropertyValue(p);
      if (v && (!parentCS || v !== parentCS.getPropertyValue(p))) css.push(p + ":" + v);
    }
    for (const p of BOX) {
      const v = cs.getPropertyValue(p);
      if (!v) continue;
      if (p === "background-color" && (v === "rgba(0, 0, 0, 0)" || v === "transparent")) continue;
      if (/^(border|padding|margin)/.test(p) && /^0(px)?( |$)/.test(v)) continue;
      if (p === "display" && ((out === "DIV" && v === "block") || (out === "SPAN" && v === "inline") || NOSTYLE_DISPLAY.has(out))) continue;
      if (p === "vertical-align" && v === "baseline") continue;
      if ((p === "flex-direction" || p === "justify-content" || p === "align-items" || p === "gap") && !/flex|grid/.test(cs.display)) continue;
      if (v === "normal" || v === "row") continue;
      css.push(p + ":" + v);
    }
    if (!parentCS) css.push("margin:0");
    if (css.length) el.setAttribute("style", css.join(";"));
    const kids = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
    for (const c of kids) { const b = build(c, cs, st); if (b) el.appendChild(b); }
    return el;
  }

  window.__woSnap = function (elements) {
    const st = { nodes: 0, text: 0 };
    const parts = [];
    for (const e of elements) { const n = build(e, null, st); if (n) parts.push(n); }
    if (!parts.length) return "";
    let root;
    if (/^(TR)$/i.test(elements[0].tagName)) {
      root = document.createElement("table");
      root.setAttribute("style", "border-collapse:collapse");
      const tb = document.createElement("tbody");
      parts.forEach(p => tb.appendChild(p));
      root.appendChild(tb);
    } else if (parts.length === 1) root = parts[0];
    else { root = document.createElement("div"); parts.forEach(p => root.appendChild(p)); }
    const html = root.outerHTML;
    return html.length > 60000 ? "" : html;
  };
}

// =====================================================================
// PAGE PROBES (run inside the page through chrome.scripting.executeScript)
// Each one is fully self-contained.
// =====================================================================

// ServiceChannel: read the status from the WO's OWN row, never from the whole page.
async function scProbe(id, targets) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cls = /^\d+$/.test(id) ? "\\d" : "A-Za-z0-9";
  const idRe = new RegExp("(?<![" + cls + "])" + esc(id) + "(?![" + cls + "])", "i");
  const norm = t => String(t || "").toUpperCase().replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/");
  const hasTarget = t => { const u = norm(t); return targets.some(x => u.includes(x)); };
  const snip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n || 200);
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|OPTION|SELECT)$/;
  const SCOPE_MAX = 1500, SCOPE_DEPTH = 14;

  function* textNodes(node) {
    if (node.nodeType === 3) { yield node; return; }
    if (node.nodeType !== 1 || SKIP.test(node.tagName)) return;
    if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) yield* textNodes(c);
    for (const c of node.childNodes) yield* textNodes(c);
  }
  const parentOf = el => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const shapeRe = (() => {
    const s = String(id); if (s.length < 6) return null;
    const body = [...s].map(c => /\d/.test(c) ? "\\d" : /[A-Za-z]/.test(c) ? "[A-Za-z]" : esc(c)).join("");
    try { return new RegExp("(?<![A-Za-z0-9])" + body + "(?![A-Za-z0-9])", "g"); } catch (e) { return null; }
  })();
  const rowLike = el => /^(TR|LI|ARTICLE)$/.test(el.tagName) || (!!el.getAttribute && /^(row|listitem)$/i.test(el.getAttribute("role") || ""));

  function findScope() {
    const body = document.body; if (!body) return null;
    const idUp = String(id).toUpperCase();
    let fallback = null;
    for (const n of textNodes(body)) {
      const t = n.nodeValue;
      if (!t || !idRe.test(t)) continue;
      let a = n.parentElement, last = "", lastEl = null;
      for (let d = 0; a && d < SCOPE_DEPTH; d++, a = parentOf(a)) {
        const tx = a.innerText || "";
        if (tx.length > SCOPE_MAX) break;
        if (shapeRe) { const o = tx.match(shapeRe); if (o && o.some(x => x.toUpperCase() !== idUp)) break; }
        last = tx; lastEl = a;
        if (hasTarget(tx)) return { text: tx, hit: true, el: a };
        if (tx.length >= 30 && rowLike(a)) break;
      }
      if (last && (!fallback || last.length > fallback.text.length)) fallback = { text: last, hit: false, el: lastEl };
    }
    return fallback;
  }

  const snapOf = el => { try { return el && window.__woSnap ? window.__woSnap([el]) : ""; } catch (e) { return ""; } };
  const T = 30000, POLL = 400, STABLE = 4500;
  const start = Date.now();
  let lastLen = -1, stableSince = Date.now(), scope = null, scopeLen = -2, polls = 0, seen = false;
  while (Date.now() - start < T) {
    await sleep(POLL);
    if (document.readyState !== "complete") { stableSince = Date.now(); continue; }
    const raw = (document.body ? document.body.innerText : "") || "";
    if (!idRe.test(raw)) continue;
    seen = true;
    if (raw.length !== scopeLen || ++polls % 5 === 0) {
      scopeLen = raw.length;
      try { scope = findScope(); } catch (e) { scope = null; }
    }
    if (scope && scope.hit) {
      const u = norm(scope.text);
      return { state: "hit", status: targets.find(x => u.includes(x)), ev: snip(scope.text), snap: snapOf(scope.el) };
    }
    if (!scope) {
      const u = norm(raw), hit = targets.find(x => u.includes(x));
      if (hit) return { state: "hit", status: hit + " (page-wide)", ev: "" };
    }
    if (raw.length !== lastLen) { lastLen = raw.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= STABLE) {
      if (scope && scope.text.length < 60 && hasTarget(raw))
        return { state: "unsure", why: "status is on the page but not next to the WO id", ev: snip(scope.text) };
      return { state: "none", ev: snip(scope ? scope.text : ""), snap: scope ? snapOf(scope.el) : "" };
    }
  }
  return { state: "unsure", why: seen ? "timeout while the WO row was still changing" : "WO id never appeared on the page (not loaded / not logged in)" };
}

// Salesforce search results: read the Status column of the Cases section.
async function sfProbe(id, doneList, settleMs, anyDone) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cls = /^\d+$/.test(id) ? "\\d" : "A-Za-z0-9";
  const mCore = /^(?:WKO-?)?0*(\d+)$/i.exec(String(id).trim());
  const idRe = mCore ? new RegExp("(?<!\\d)0*" + mCore[1] + "(?!\\d)") : new RegExp("(?<![A-Za-z0-9])" + esc(id) + "(?![A-Za-z0-9])");
  const snip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n || 200);
  const toks = text => String(text || "").split(/[\t\n]+/).map(x => x.trim()).filter(Boolean);
  const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
  const CASE_NO_RE = /^\d{6,}$/;
  const HEADER_RE = /^(case number|subject|status|date\/time opened|case owner alias|owner|priority|account|contact|type|origin|created date|date opened|closed|description)$/i;
  const SECTION_END = /^(Work Orders|Don.t see your result\??|Accounts|Contacts|People|Files|Chatter|Events|Tasks|Reports|Dashboards|Site - Service Partners|Show More)$/i;
  const isDone = st => doneList.some(d => d.toLowerCase() === String(st).trim().toLowerCase());
  const isVisible = el => !!(el && (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)));
  const parentOf = el => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;

  function deepAll(root, sel, out) {
    out = out || []; let all = [];
    try { root.querySelectorAll(sel).forEach(e => out.push(e)); all = root.querySelectorAll("*"); } catch (e) {}
    for (const e of all) if (e.shadowRoot) deepAll(e.shadowRoot, sel, out);
    return out;
  }
  const SPIN = ".slds-spinner_container, lightning-spinner, .slds-spinner, [role=progressbar]";
  const spinner = deep => { try { return (deep ? deepAll(document, SPIN) : [...document.querySelectorAll(SPIN)]).some(isVisible); } catch (e) { return false; } };
  const cellsOf = tr => [...tr.children].filter(c => /^(TH|TD)$/.test(c.tagName) || /^(gridcell|columnheader|rowheader|cell)$/i.test(c.getAttribute("role") || ""));
  const cellText = c => (c.innerText || c.textContent || "").replace(/\s+/g, " ").trim();

  function caseUrlOf(num) {
    try {
      const a = deepAll(document, "a").find(x => cellText(x) === num);
      const hr = a && a.getAttribute("href");
      if (hr && /\/Case\//i.test(hr)) return new URL(hr, document.location.href).href;
    } catch (e) {}
    return "";
  }
  function rowStatus(r) {
    const k = r.findIndex((x, i) => i >= 2 && DATE_RE.test(x));
    if (k > 1) return r[k - 1];
    return r.slice(1).find(isDone) || "";
  }
  function readCasesTable() {
    for (const tbl of deepAll(document, "table, [role=grid], [role=table], [role=treegrid]")) {
      const rows = [...new Set(deepAll(tbl, "tr, [role=row]"))];
      let hi = -1, sIdx = -1;
      for (let r = 0; r < rows.length && hi < 0; r++) {
        const labels = cellsOf(rows[r]).map(cellText);
        const cn = labels.findIndex(l => /^case number\b/i.test(l)), st = labels.findIndex(l => /^status\b/i.test(l));
        if (cn >= 0 && st >= 0) { hi = r; sIdx = st; }
      }
      if (hi < 0) continue;
      const out = [];
      for (const tr of rows.slice(hi + 1)) {
        const cells = cellsOf(tr);
        if (cells.length <= sIdx || cells.some(c => /^columnheader$/i.test(c.getAttribute("role") || ""))) continue;
        const num = cellText(cells[0]);
        if (CASE_NO_RE.test(num)) out.push({ num, status: cellText(cells[sIdx]), el: tr });
      }
      return { rows: out, ev: snip(tbl.innerText || tbl.textContent, 300), via: "table", hdr: rows[hi] };
    }
    return null;
  }
  function readCasesLinks() {
    const out = [], seen = new Set();
    for (const a of deepAll(document, "a[href*='/Case/'], a[href*='/lightning/r/Case']")) {
      const num = cellText(a);
      if (!CASE_NO_RE.test(num) || seen.has(num)) continue;
      seen.add(num);
      let el = a, best = null, bestEl = null;
      for (let d = 0; el && d < 10; d++, el = parentOf(el)) {
        const t = toks(el.innerText || "");
        if (el.innerText && el.innerText.length > 1500) break;
        if (t.some(x => CASE_NO_RE.test(x) && x !== num)) break;
        const at = t.indexOf(num);
        if (at >= 0) { best = t.slice(at); bestEl = el; }
        if (best && best.some(x => DATE_RE.test(x))) break;
      }
      if (best) out.push({ num, status: rowStatus(best), el: bestEl });
    }
    return out.length ? { rows: out, ev: snip(out.map(r => r.num + " = " + r.status).join(" | "), 300), via: "links" } : null;
  }
  function readCasesText(text) {
    const t = toks(text);
    const i = t.findIndex(x => /^case number$/i.test(x));
    if (i < 0) return null;
    let j = i; while (j < t.length && HEADER_RE.test(t[j])) j++;
    let e = j; while (e < t.length && !SECTION_END.test(t[e])) e++;
    const rows = []; let cur = null;
    for (const x of t.slice(j, e)) { if (CASE_NO_RE.test(x)) { cur = [x]; rows.push(cur); } else if (cur) cur.push(x); }
    return rows.length ? { rows: rows.map(r => ({ num: r[0], status: rowStatus(r) })), ev: snip(t.slice(i, e).join(" | "), 300), via: "text" } : null;
  }
  function readCasesAny(text) {
    let best = null;
    for (const fn of [() => readCasesTable(), () => readCasesLinks(), () => readCasesText(text)]) {
      let r = null; try { r = fn(); } catch (e) {}
      if (!r || !r.rows.length) continue;
      if (r.rows.every(x => x.status)) return r;
      if (!best) best = r;
    }
    return best;
  }
  const expectedCases = text => { const m = /(?:^|[\t\n])Cases[\t\n]+(\d+)(\+?)\s+Results?\b/i.exec(text); return m ? { n: parseInt(m[1], 10), more: !!m[2] } : null; };
  const sidebarCases = text => { const m = /(?:^|[\t\n])Cases[\t\n]+(\d+)(?=[\t\n]|$)/.exec(text); return m ? parseInt(m[1], 10) : null; };

  // Fallback snippet: the smallest block of the search page that shows the Cases section / "We searched for" text.
  function snapResults(text) {
    try {
      if (!window.__woSnap) return "";
      let best = null, bestLen = 1e9, seen = 0;
      for (const el of deepAll(document, "div, section, article, main, [role=main], [role=region]")) {
        if (++seen > 1500) break;
        let tx = ""; try { tx = el.innerText || ""; } catch (e) {}
        if (tx.length < 20 || tx.length > 2500 || tx.length >= bestLen) continue;
        if (/\bCases\b/.test(tx) && (idRe.test(tx) || /We searched for/i.test(tx))) { best = el; bestLen = tx.length; }
      }
      if (!best) {
        for (const el of deepAll(document, "div, section, article, main")) {
          let tx = ""; try { tx = el.innerText || ""; } catch (e) {}
          if (tx.length >= 20 && tx.length <= 2500 && /We searched for/i.test(tx) && tx.length < bestLen) { best = el; bestLen = tx.length; }
        }
      }
      return best ? window.__woSnap([best]) : "";
    } catch (e) { return ""; }
  }

  const snapCases = c => {
    try {
      if (!c || !window.__woSnap) return "";
      const els = [];
      if (c.hdr) els.push(c.hdr);
      for (const r of c.rows.slice(0, 4)) if (r.el) els.push(r.el);
      return els.length ? window.__woSnap(els) : "";
    } catch (e) { return ""; }
  };
  const T = 60000, POLL = 250, SETTLE = settleMs, NOMARK = Math.max(10000, settleMs * 4);
  const start = Date.now();
  let lastSig = "", stableSince = Date.now(), cases = null, casesLen = -2, polls = 0, deepBusy = false, sample = "";
  while (Date.now() - start < T) {
    await sleep(POLL);
    if (document.readyState !== "complete") { stableSince = Date.now(); continue; }
    const text = (document.body ? document.body.innerText : "") || "";
    if (!idRe.test(text)) { sample = snip(text); stableSince = Date.now(); continue; }
    const term = /We searched for\s*["\u201c\u201d']?([^"\u201c\u201d\n]+)/i.exec(text);
    if (term && !idRe.test(term[1])) { stableSince = Date.now(); continue; }   // a stale search, not this WO
    if (text.length !== casesLen || ++polls % 5 === 0) {
      casesLen = text.length;
      cases = readCasesAny(text);
      deepBusy = spinner(true);
    }
    const busy = deepBusy || spinner(false);
    const exp = expectedCases(text);
    let status = "", curDone = false, uncertain = false, num = "";
    if (cases && cases.rows.length) {
      const rows = cases.rows;
      const complete = rows.every(r => r.status) && (!exp || exp.more || exp.n === rows.length);
      if (complete) {
        if (anyDone) {
          // several cases for one WO: the extras are usually cancelled duplicates, so ONE case in a done status is enough
          curDone = rows.some(r => isDone(r.status));
        } else {
          const allDone = rows.every(r => isDone(r.status));
          curDone = allDone && !(exp && exp.more);
          uncertain = allDone && !!(exp && exp.more);
        }
        num = rows.map(r => r.num).join(",");
        status = rows.length === 1 ? `${rows[0].status} [case ${rows[0].num}]`
          : rows.map(r => `${r.num}: ${r.status}`).join(" | ") + " (multiple cases)";
        if (exp && exp.more) status += " (more cases not shown)";
      }
    }
    const marker = /Don.t see your result/i.test(text) || sidebarCases(text) !== null;
    const sig = text.length + "|" + status + "|" + busy;
    if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); }
    const quiet = Date.now() - stableSince;
    const casesPending = !status && ((sidebarCases(text) || 0) > 0 || !!(exp && exp.n > 0));
    const lateOk = Date.now() - start >= NOMARK;
    if (busy || quiet < SETTLE || !(marker || lateOk) || (casesPending && !lateOk)) continue;

    // page is loaded and quiet: decide
    const single = cases && cases.rows.length === 1 ? cases.rows[0] : null;
    const caseUrl = single ? caseUrlOf(single.num) : "";
    if (curDone) return { state: "done", status, ev: cases.ev, caseNo: num, caseUrl, single: !!single, resultsStatus: single ? single.status : "", snap: snapCases(cases) || snapResults(text) };
    if (status) return { state: "notdone", status, ev: cases.ev, uncertain, caseNo: num, caseUrl, snap: snapCases(cases) || snapResults(text) };
    const at = Math.max(0, text.search(idRe) - 60);
    if ((exp && exp.n === 0 && !exp.more) || sidebarCases(text) === 0)
      return { state: "nocase", ev: snip(text.slice(at, at + 400), 400), snap: snapResults(text) };
    return { state: "unsure", why: cases && cases.rows.length ? `Cases row found via ${cases.via} but its status could not be read` : "page loaded, but no Cases table found", ev: snip(text.slice(at, at + 700), 700), snap: snapResults(text) };
  }
  return { state: "unsure", why: "timeout waiting for the Salesforce results", ev: sample, snap: snapResults(sample) };
}

// Salesforce case record page: confirm the case really shows this WO and read its own Status.
async function caseProbe(id, num) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cls = /^\d+$/.test(id) ? "\\d" : "A-Za-z0-9";
  const mCore = /^(?:WKO-?)?0*(\d+)$/i.exec(String(id).trim());
  const idRe = mCore ? new RegExp("(?<!\\d)0*" + mCore[1] + "(?!\\d)") : new RegExp("(?<![A-Za-z0-9])" + esc(id) + "(?![A-Za-z0-9])");
  const numRe = new RegExp("(?<![\\d])" + esc(num) + "(?![\\d])");
  const snip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n || 200);
  const toks = text => String(text || "").split(/[\t\n]+/).map(x => x.trim()).filter(Boolean);
  const isVisible = el => !!(el && (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)));
  const SPIN = ".slds-spinner_container, lightning-spinner, .slds-spinner, [role=progressbar]";
  const spinner = () => { try { return [...document.querySelectorAll(SPIN)].some(isVisible); } catch (e) { return false; } };
  const firstStatusValue = text => {
    const t = toks(text);
    for (let i = 0; i < t.length - 1; i++) {
      if (!/^status$/i.test(t[i])) continue;
      const v = t[i + 1];
      if (v.length <= 80 && !/^(status|subject|priority|owner|type|origin|account|contact|case number|description|date\/time|help|sort|edit)/i.test(v)) return v;
    }
    return "";
  };
  const parentOf = el => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const ownText = el => { let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return t.replace(/\s+/g, " ").trim(); };
  const snapStatus = cs => {
    try {
      if (!window.__woSnap) return "";
      const cands = [], labels = [];
      (function walk(root) {
        if (root.host) { for (const n of root.childNodes) if (n.nodeType === 3) { const v = n.nodeValue.replace(/\s+/g, " ").trim(); if (v === cs) cands.push(root.host); else if (/^status$/i.test(v)) labels.push(root.host); } }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) walk(el.shadowRoot);
          const o = ownText(el);
          if (o === cs) cands.push(el); else if (/^status$/i.test(o)) labels.push(el);
        }
      })(document);
      for (const c of cands) {          // prefer the value sitting next to a "Status" label
        let a = c;
        for (let d = 0; a && d < 8; d++, a = parentOf(a)) {
          const t = (a.innerText || "").replace(/\s+/g, " ").trim();
          if (t.length > 160) break;
          if (/^status\b/i.test(t)) return window.__woSnap([a]);
        }
      }
      for (const l of labels) {         // or a "Status" label whose field also shows the value
        let a = l;
        for (let d = 0; a && d < 8; d++, a = parentOf(a)) {
          const t = (a.innerText || "").replace(/\s+/g, " ").trim();
          if (t.length > 160) break;
          if (t.toLowerCase().includes(cs.toLowerCase())) return window.__woSnap([a]);
        }
      }
      return cands[0] ? window.__woSnap([cands[0]]) : "";
    } catch (e) { return ""; }
  };
  const T = 45000, SETTLE = 900;
  const start = Date.now();
  let last = "", qSince = Date.now();
  while (Date.now() - start < T) {
    await sleep(200);
    if (document.readyState !== "complete") { qSince = Date.now(); continue; }
    const tx = (document.body ? document.body.innerText : "") || "";
    if (!numRe.test(tx)) { qSince = Date.now(); continue; }
    const busy = spinner(), cs = firstStatusValue(tx), hasWO = idRe.test(tx);
    const sig = tx.length + "|" + cs + "|" + hasWO + "|" + busy;
    if (sig !== last) { last = sig; qSince = Date.now(); }
    if (busy || Date.now() - qSince < SETTLE || !cs) continue;
    if (hasWO) {
      const at = Math.max(0, tx.search(idRe) - 120);
      return { caseStatus: cs, hasWO: true, ev: snip(tx.slice(at, at + 300), 300), snap: snapStatus(cs) };
    }
    if (Date.now() - start >= T * 0.6) return { caseStatus: cs, hasWO: false, ev: snip(tx, 300), snap: snapStatus(cs) };
  }
  return { err: "timeout opening the case page" };
}


// Dollar Tree step 1 (runs on the portal home page): paste the WKO number in the search box, wait for the result, click it.
async function dtSearchProbe(digits) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const re = new RegExp("WKO-?0*" + digits + "(?!\\d)", "i");
  const findInput = () => document.querySelector('input[placeholder*="Search by name or number" i]')
    || [...document.querySelectorAll("input")].find(i => /search/i.test(i.placeholder || ""));
  let input = null; const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (document.readyState === "complete") { input = findInput(); if (input) break; }
    await sleep(300);
  }
  if (!input) return { state: "unsure", why: "search box not found (not logged in, or the page changed)" };

  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  setter.call(input, digits);
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "0" }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "0" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const findResult = () => {   // smallest element (outside the input) whose text is this WKO number
    let best = null;
    for (const el of document.querySelectorAll("a, li, div, span, p, td")) {
      if (el === input || el.contains(input)) continue;
      const tx = el.innerText || "";
      if (!tx || tx.length > 200 || !re.test(tx)) continue;
      if (!best || tx.length < best.innerText.length) best = el;
    }
    return best;
  };

  const start = Date.now();
  while (Date.now() - start < 25000) {
    await sleep(300);
    const el = findResult();
    if (el) {
      await sleep(400);   // let the dropdown finish drawing
      const a = el.closest("a") || el.querySelector("a");
      const href = a && a.getAttribute("href");
      if (href && /\/WorkOrder\/Details\//i.test(href)) return { state: "found", href: new URL(href, location.href).href };
      const target = el.closest("a, [role=option], li, tr, [onclick]") || el;
      target.click();
      return { state: "clicked" };
    }
    const text = document.body ? document.body.innerText : "";
    const m = /(\d+)\s+results?\s+found/i.exec(text);
    if ((m && parseInt(m[1], 10) === 0) || /no results? found/i.test(text)) {
      await sleep(800);
      if (!findResult()) return { state: "none" };
    }
  }
  return { state: "unsure", why: "no search result appeared for the WKO number" };
}

// Dollar Tree step 2 (runs on the WO details page): look for the "Pending Close Out" status badge.
async function dtDetailProbe(digits, targets) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const snapAround = el => {
    try {
      if (!el || !window.__woSnap) return "";
      let n = el;
      while (n.parentElement && n.parentElement !== document.body && (n.parentElement.innerText || "").length < 200) n = n.parentElement;
      return window.__woSnap([n]);
    } catch (e) { return ""; }
  };
  const re = new RegExp("WKO-?0*" + digits + "(?!\\d)", "i");
  const norm = t => String(t || "").toUpperCase().replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/");
  const start = Date.now();
  let lastLen = -1, stableSince = Date.now();
  while (Date.now() - start < 30000) {
    await sleep(400);
    if (!/\/WorkOrder\/Details\//i.test(location.href) || document.readyState !== "complete") { stableSince = Date.now(); continue; }
    const text = (document.body ? document.body.innerText : "") || "";
    if (!re.test(text)) { stableSince = Date.now(); continue; }
    const u = norm(text);
    for (const t of targets) {
      const i = u.indexOf(t);
      if (i >= 0) {
        let badge = null, badgeEl = null;   // smallest element whose text is the status badge, e.g. "Job Complete - Pending Close Out #"
        for (const el of document.querySelectorAll("span, label, div, a, strong, b, td")) {
          const x = (el.innerText || "").replace(/\s+/g, " ").trim();
          if (!x || x.length > 80 || !norm(x).includes(t)) continue;
          if (!badge || x.length < badge.length) { badge = x; badgeEl = el; }
        }
        return { state: "hit", status: badge || t, ev: u.slice(Math.max(0, i - 40), i + 60), snap: snapAround(badgeEl) };
      }
    }
    if (text.length !== lastLen) { lastLen = text.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 3500) {
      const dis = (text.match(/#DIS-\d+[^\n]*\n?[^\n]*/g) || []).map(x => x.replace(/\s+/g, " ")).join(" || ");
      let disEl = null, hdrEl = null;
      for (const el of document.querySelectorAll("span, div, a, h1, h2, h3, strong, b")) {
        const x = (el.innerText || "").trim();
        if (!x || x.length > 80) continue;
        if (/#DIS-\d+/i.test(x) && (!disEl || x.length < disEl.innerText.length)) disEl = el;
        if (re.test(x) && (!hdrEl || x.length < hdrEl.innerText.length)) hdrEl = el;
      }
      return { state: "none", ev: "dispatch(es): " + dis.slice(0, 250), snap: snapAround(disEl || hdrEl) };
    }
  }
  return { state: "unsure", why: "WO details page never finished loading" };
}

// =====================================================================
// Tab helpers
// =====================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const workerTabs = new Set();
const injectSpoof = tabId => chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", injectImmediately: true, func: visibilitySpoof }).catch(() => {});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (workerTabs.has(tabId) && (info.status === "loading" || info.status === "complete")) injectSpoof(tabId);
});

function waitComplete(tabId, timeout = 30000) {
  return new Promise(resolve => {
    const t = setTimeout(done, timeout);
    function onUpd(id, info) { if (id === tabId && info.status === "complete") done(); }
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(onUpd); resolve(); }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

let nextSlot = 0;
async function throttle() {
  const now = Date.now(), at = Math.max(nextSlot, now);
  nextSlot = at + PAGE_GAP;
  if (at > now) await sleep(at - now);
  await sleep(Math.random() * 400);
}

async function runOn(tabId, func, args) {
  await injectSpoof(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, func: defineSnap }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId }, func, args });
      return res[0]?.result;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1500);
    }
  }
}

async function probe(tabId, url, func, args) {
  await throttle();
  const loaded = waitComplete(tabId);
  await chrome.tabs.update(tabId, { url });
  await loaded;
  const host = new URL(url).host;
  for (let i = 0; i < 20; i++) {            // up to ~10s for the tab to really be on the target page
    const t = await chrome.tabs.get(tabId);
    const cur = t.url || t.pendingUrl || "";
    if (cur.includes(host) && t.status === "complete") break;
    await sleep(500);
  }
  return runOn(tabId, func, args);
}

async function waitForUrl(tabId, re, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(tabId);
    if (re.test(t.url || "") && t.status === "complete") return true;
    await sleep(400);
  }
  return false;
}

// Dollar Tree: search on the home page, open the WO, look for "Pending Close Out".
async function dtStage(tabId, id) {
  const m = /^(?:WKO-?)?0*(\d+)$/i.exec(String(id).trim());
  if (!m) return { state: "unsure", why: `can't read a WKO number from "${id}"` };
  const digits = m[1];
  const s = await probe(tabId, DT_HOME, dtSearchProbe, [digits]);
  if (!s) return { state: "unsure", why: "no answer from the search page" };
  if (s.state === "none") return { state: "none", ev: "Dollar Tree search found no such WO" };
  if (s.state === "unsure") return s;
  if (s.state === "found") return probe(tabId, s.href, dtDetailProbe, [digits, CFG.dt]);
  // "clicked": the result link was clicked on the page, wait for the details page
  const ok = await waitForUrl(tabId, /\/WorkOrder\/Details\//i, 25000);
  if (!ok) return { state: "unsure", why: "clicked the search result but the WO page never opened" };
  return runOn(tabId, dtDetailProbe, [digits, CFG.dt]);
}

// =====================================================================
// One full check of one WO. Returns { vote, note }
// vote: "TRUE" | "FALSE" | "FALSEEEEEE" | "UNSURE"(inconclusive, retry)
// =====================================================================
// Salesforce stage for one WO: search page, then (when exactly one case is done) the case page.
// Returns { vote, note, sf, sfSnap } where vote is what Salesforce alone says.
async function sfStage(tabId, id, settleMs) {
  const sf = await probe(tabId, sfUrl(id), sfProbe, [id, CFG.sf, settleMs, !!CFG.sfAnyDone]);
  if (!sf) return { vote: "UNSURE", note: "SF: no answer from the page", sf: "(no answer)", sfSnap: "" };
  const snap0 = sf.snap || "";
  if (sf.state === "unsure") return { vote: "UNSURE", note: `SF: ${sf.why} | ${sf.ev || ""}`, sf: "(unsure)", sfSnap: snap0 };
  if (sf.state === "nocase") return { vote: "FALSEEEEEE", note: "SF: no case in search results", sf: "No case found", sfSnap: snap0 };
  if (sf.state === "notdone") return { vote: sf.uncertain ? "UNSURE" : "FALSEEEEEE", note: `SF: ${sf.status}`, sf: sf.status, sfSnap: snap0 };

  // sf.state === "done": if exactly one case, open it and confirm with the WO number (like the coworker's scanner)
  if (sf.single && sf.caseUrl) {
    const cp = await probe(tabId, sf.caseUrl, caseProbe, [id, sf.caseNo]);
    if (!cp || cp.err) return { vote: "UNSURE", note: `SF case ${sf.caseNo}: ${cp ? cp.err : "no answer"}`, sf: sf.status, sfSnap: snap0 };
    const shown = `${cp.caseStatus} [case ${sf.caseNo}]`;
    const sfSnap = cp.snap || snap0;
    if (!cp.hasWO) return { vote: "UNSURE", note: `case ${sf.caseNo} page does not show WO ${id} (it says ${cp.caseStatus})`, sf: shown, sfSnap };
    if (cp.caseStatus.trim().toLowerCase() !== sf.resultsStatus.trim().toLowerCase())
      return { vote: "UNSURE", note: `results said "${sf.resultsStatus}" but case page says "${cp.caseStatus}"`, sf: shown, sfSnap };
    const ok = CFG.sf.some(d => d.toLowerCase() === cp.caseStatus.trim().toLowerCase());
    return ok ? { vote: "TRUE", note: `SF: ${shown} verified on case page`, sf: shown, sfSnap }
              : { vote: "FALSEEEEEE", note: `SF case page says: ${cp.caseStatus}`, sf: shown, sfSnap };
  }
  return { vote: "TRUE", note: `SF: ${sf.status}`, sf: sf.status, sfSnap: snap0 };
}

async function checkOnce(tabId, id, settleMs, source) {
  const label = source === "DT" ? "DT" : "SC";
  const sc = source === "DT" ? await dtStage(tabId, id)
                             : await probe(tabId, scUrl(id), scProbe, [id, CFG.sc]);
  if (!sc) return { vote: "UNSURE", note: label + ": no answer from the page", portal: "(no answer)", sf: "" };
  if (sc.state === "unsure") return { vote: "UNSURE", note: label + ": " + sc.why, portal: "(unsure)", sf: "" };
  const portalSnap = sc.snap || "";

  if (sc.state === "none") {
    const base0 = { vote: "FALSE", portal: "No target status", portalSnap };
    const noteBase = label + ": no target status" + (sc.ev ? " | " + sc.ev : "");
    if (!CFG.sfAlways) return { ...base0, note: noteBase, sf: "Not checked" };
    // still look at Salesforce so the Salesforce column and snippet are filled in (the vote stays FALSE)
    const sfr = await sfStage(tabId, id, settleMs);
    return { ...base0, note: `${noteBase} | ${sfr.note}`, sf: sfr.sf, sfSnap: sfr.sfSnap };
  }

  const scNote = label + ": " + sc.status;
  const sfr = await sfStage(tabId, id, settleMs);
  return { portal: sc.status, portalSnap, vote: sfr.vote, note: `${scNote} | ${sfr.note}`, sf: sfr.sf, sfSnap: sfr.sfSnap };
}

// TRUE is accepted on one (verified) check. FALSE / FALSEEEEEE need two identical checks in a row (unless turned off).
async function processId(tabId, id, settleMs, source) {
  let prev = null, last = null;
  const pack = (result, note) => ({
    result, note,
    portal: last.portal || "", sf: last.sf || "",
    portalSnap: last.portalSnap || "", sfSnap: last.sfSnap || ""
  });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try { last = await checkOnce(tabId, id, settleMs, source); }
    catch (e) { last = { vote: "UNSURE", note: "error: " + (e.message || e), portal: "(error)", sf: "" }; }
    if (last.vote === "TRUE") return pack("TRUE", last.note);
    if (last.vote === "FALSE" || last.vote === "FALSEEEEEE") {
      if (!CFG.confirmFalse) return pack(last.vote, last.note);
      if (prev === last.vote) return pack(last.vote, last.note + " (confirmed twice)");
      prev = last.vote;
    } else {
      prev = null;
    }
    await sleep(1000);
  }
  return pack("UNSURE", `no agreement after ${MAX_ATTEMPTS} checks. Last: ${last ? last.note : ""}`);
}

// =====================================================================
// Queue (each worker tab pulls the next WO the moment it is free)
// Every run is saved under its own id/timestamp (see runs.js); the results page updates live from storage.
// =====================================================================
let running = false;

async function run(ids, nTabs, useWindows, settleMs, source, origin) {
  running = true;
  const runId = "r" + Date.now();
  const rows = ids.map(id => ({ id, status: "queued" }));
  const meta = {
    id: runId, startedAt: Date.now(), source, ids, finished: false,
    lists: { firstName: CFG.firstName, first: CFG.firstRaw, sfName: CFG.sfName, sf: CFG.sfRaw },
    confirmFalse: CFG.confirmFalse, origin: origin || null,
    sfAnyDone: CFG.sfAnyDone,
    opts: { tabs: nTabs, useWindows, settleMs, sfAlways: CFG.sfAlways }
  };
  try {
    const idx = await getIndex();
    idx.unshift({ id: runId, startedAt: meta.startedAt, source, total: ids.length, finished: false, summary: null });
    const dropped = idx.splice(MAX_RUNS);                       // runs beyond the limit
    await chrome.storage.local.set({ [`run:${runId}`]: meta, runIndex: idx });
    for (const d of dropped) await chrome.storage.local.remove(runKeys(d)).catch(() => {});

    const putRow = (i) => chrome.storage.local.set({ [`row:${runId}:${i}`]: rows[i] });
    let next = 0, done = 0, wi = 0;
    chrome.action.setBadgeText({ text: `0/${ids.length}` });
    await chrome.tabs.create({ url: chrome.runtime.getURL("results.html?run=" + runId), active: true });   // results page opens right away

    const worker = async () => {
      let tabId, winId = null;
      if (useWindows) {
        const win = await chrome.windows.create({
          url: "about:blank", focused: false, state: "normal",
          width: 700, height: 500, left: 40 + wi * 30, top: 40 + wi * 30
        });
        winId = win.id; tabId = win.tabs[0].id; wi++;
      } else {
        const tab = await chrome.tabs.create({ url: "about:blank", active: false });   // same window, background tab
        tabId = tab.id;
      }
      workerTabs.add(tabId);
      try {
        while (next < ids.length) {
          const i = next++;
          rows[i] = { id: ids[i], status: "checking" };
          await putRow(i);
          let r;
          try { r = await processId(tabId, ids[i], settleMs, source); }
          catch (e) { r = { result: "ERROR: " + (e.message || e), note: "" }; }
          rows[i] = {
            id: ids[i], status: "done", result: r.result, portal: r.portal || "", sf: r.sf || "",
            note: r.note || "", portalSnap: r.portalSnap || "", sfSnap: r.sfSnap || ""
          };
          done++;
          chrome.action.setBadgeText({ text: `${done}/${ids.length}` });
          await putRow(i);
        }
      } finally {
        workerTabs.delete(tabId);
        if (winId !== null) chrome.windows.remove(winId).catch(() => {});
        else chrome.tabs.remove(tabId).catch(() => {});
      }
    };

    await Promise.all(Array.from({ length: Math.min(nTabs, ids.length) }, worker));
  } finally {
    try {
      const summary = {};
      for (const r of rows) if (r.status === "done") { const k = (r.result || "").startsWith("ERROR") ? "ERROR" : r.result; summary[k] = (summary[k] || 0) + 1; }
      try { const k = `run:${runId}`; const cur = (await chrome.storage.local.get(k))[k]; if (cur && cur.origin) meta.origin = cur.origin; } catch (e) {}   // keep a re-compare made while running
      meta.finished = true; meta.finishedAt = Date.now();
      const idx2 = await getIndex();
      const e = idx2.find(x => x.id === runId);
      if (e) { e.finished = true; e.summary = summary; }
      await chrome.storage.local.set({ [`run:${runId}`]: meta, runIndex: idx2 });
    } catch (e) {}
    chrome.action.setBadgeText({ text: "" });
    running = false;
  }
}

// Re-check some WOs of an existing run in place (used by the "Re-check these rows" button of the diff page).
async function recheck(runId, wantIds, o) {
  const mk = `run:${runId}`;
  let chain = Promise.resolve();
  try {
    const meta = (await chrome.storage.local.get(mk))[mk];
    const idxs = [...new Set(wantIds)].map(w => meta.ids.indexOf(w)).filter(i => i >= 0);
    const setProg = async (done) => {
      const cur = (await chrome.storage.local.get(mk))[mk] || meta;
      cur.rechecking = done === null ? null : { done, total: idxs.length };
      await chrome.storage.local.set({ [mk]: cur });
    };
    const prog = n => { chain = chain.then(() => setProg(n)).catch(() => {}); return chain; };
    await prog(0);
    const keys = idxs.map(i => `row:${runId}:${i}`);
    const old = await chrome.storage.local.get(keys);
    const mark = {};
    for (const i of idxs) mark[`row:${runId}:${i}`] = Object.assign({ status: "queued" }, old[`row:${runId}:${i}`], { rc: true });
    await chrome.storage.local.set(mark);   // old results stay visible, flagged as "re-checking"
    chrome.action.setBadgeText({ text: `0/${idxs.length}` });

    let next = 0, done = 0, wi = 0;
    const worker = async () => {
      let tabId, winId = null;
      if (o.useWindows) {
        const win = await chrome.windows.create({ url: "about:blank", focused: false, state: "normal", width: 700, height: 500, left: 40 + wi * 30, top: 40 + wi * 30 });
        winId = win.id; tabId = win.tabs[0].id; wi++;
      } else {
        const tab = await chrome.tabs.create({ url: "about:blank", active: false });
        tabId = tab.id;
      }
      workerTabs.add(tabId);
      try {
        while (next < idxs.length) {
          const i = idxs[next++];
          let r;
          try { r = await processId(tabId, meta.ids[i], o.settleMs, meta.source); }
          catch (e) { r = { result: "ERROR: " + (e.message || e), note: "" }; }
          await chrome.storage.local.set({ [`row:${runId}:${i}`]: {
            id: meta.ids[i], status: "done", result: r.result, portal: r.portal || "", sf: r.sf || "",
            note: r.note || "", portalSnap: r.portalSnap || "", sfSnap: r.sfSnap || ""
          } });
          done++;
          chrome.action.setBadgeText({ text: `${done}/${idxs.length}` });
          prog(done);
        }
      } finally {
        workerTabs.delete(tabId);
        if (winId !== null) chrome.windows.remove(winId).catch(() => {});
        else chrome.tabs.remove(tabId).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.tabs, idxs.length) }, worker));
    await chain;

    // refresh the summary shown in the run list
    const allKeys = meta.ids.map((_, i) => `row:${runId}:${i}`);
    const all = await chrome.storage.local.get(allKeys);
    const summary = {};
    for (const k of allKeys) { const r = all[k]; if (r && r.status === "done") { const kk = (r.result || "").startsWith("ERROR") ? "ERROR" : r.result; summary[kk] = (summary[kk] || 0) + 1; } }
    const idx2 = await getIndex();
    const e = idx2.find(x => x.id === runId);
    if (e) { e.summary = summary; await chrome.storage.local.set({ runIndex: idx2 }); }
  } catch (e) {
  } finally {
    try { await chain; const cur = (await chrome.storage.local.get(mk))[mk]; if (cur) { cur.rechecking = null; cur.lastRecheckAt = Date.now(); await chrome.storage.local.set({ [mk]: cur }); } } catch (e) {}
    chrome.action.setBadgeText({ text: "" });
    running = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "recheck") {
    if (running) { sendResponse({ error: "A run is already in progress." }); return; }
    running = true;
    (async () => {
      let o;
      try {
        const mk = `run:${msg.runId}`;
        const meta = (await chrome.storage.local.get(mk))[mk];
        if (!meta) throw new Error("run not found");
        const S = await getSettings();
        const source = meta.source === "DT" ? "DT" : "SC";
        const L = meta.lists || {};
        const grp = source === "DT" ? S.DT : S.SC;
        const firstRaw = (L.first && L.first.length) ? L.first : grp.presets[grp.active];
        const sfRaw = (L.sf && L.sf.length) ? L.sf : S.SF.presets[S.SF.active];
        const firstList = firstRaw.map(normStatus).filter(Boolean);
        const sfList = sfRaw.map(x => String(x).trim()).filter(Boolean);
        const last = await chrome.storage.local.get(["lastTabs", "lastSettle", "lastWin"]);
        const op = meta.opts || {};
        const anyDone = msg.sfAnyDone !== false;
        CFG = {
          sc: source === "SC" ? firstList : [], dt: source === "DT" ? firstList : [], sf: sfList,
          confirmFalse: meta.confirmFalse !== false, sfAlways: op.sfAlways !== false, sfAnyDone: anyDone,
          firstName: L.firstName, firstRaw, sfName: L.sfName, sfRaw
        };
        o = {
          tabs: Math.max(1, Math.min(10, op.tabs || last.lastTabs || 3)),
          useWindows: op.useWindows !== undefined ? !!op.useWindows : !!last.lastWin,
          settleMs: op.settleMs !== undefined ? op.settleMs : Math.max(0, Number(last.lastSettle) || 1.5) * 1000
        };
        meta.sfAnyDone = anyDone;
        await chrome.storage.local.set({ [mk]: meta });
        sendResponse({ ok: true });
      } catch (e) { running = false; sendResponse({ error: "Could not start the re-check: " + (e.message || e) }); return; }
      recheck(msg.runId, msg.ids || [], o);
    })();
    return true;
  }
  if (msg.type !== "run") return;
  if (running) { sendResponse({ error: "A run is already in progress." }); return; }
  running = true;
  (async () => {
    try {
      const S = await getSettings();
      const source = msg.source === "DT" ? "DT" : "SC";
      const first = (source === "DT" ? S.DT : S.SC);
      const firstRaw = first.presets[first.active];
      const sfRaw = S.SF.presets[S.SF.active];
      const firstList = firstRaw.map(normStatus).filter(Boolean);
      const sfList = sfRaw.map(x => String(x).trim()).filter(Boolean);
      if (!firstList.length) { running = false; sendResponse({ error: "The status list is empty. Open the settings and add a status." }); return; }
      if (!sfList.length) { running = false; sendResponse({ error: "The Salesforce done list is empty. Open the settings and add a status." }); return; }
      CFG = {
        sc: source === "SC" ? firstList : [], dt: source === "DT" ? firstList : [], sf: sfList,
        confirmFalse: msg.confirmFalse !== false, sfAlways: msg.sfAlways !== false, sfAnyDone: msg.sfAnyDone !== false,
        firstName: first.active, firstRaw: firstRaw.slice(), sfName: S.SF.active, sfRaw: sfRaw.slice()
      };
      sendResponse({ ok: true });
      run(msg.ids, msg.tabs, !!msg.useWindows, Math.max(0, Number(msg.settle) || 1.5) * 1000, source, msg.origin || null);
    } catch (e) { running = false; sendResponse({ error: "Could not start: " + (e.message || e) }); }
  })();
  return true;
});
