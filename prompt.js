// Email -> AI prompt templates. Shared by the Outlook content script, the popup and the settings page.
// A template is plain text with placeholders like {{email content}}; presets work like the status lists.
const PROMPT_DEFAULT = `Tell me the best action points needed to be done based on the content of this email.
The possible action points are any combination of the below:

* Upload EML version of email
* Chatter the important context of the email in Salesforce
   * Mention the following depending on context (AM, OM and RFM)
* Reply to the email with some updates for whoever emailed us
* Add a note in Salesforce

Below are my notes on what to do based on the types of emails I've handled so far. Some action points are applicable to other email types too.

<notes>
{{notes}}
</notes>

Here is the email:

{{email content}}`;

const PROMPT_PLACEHOLDERS = {
  "email content": "everything below in one block: subject, from, received, category, body and links",
  "notes": "the text of your Notes box (one box shared by every prompt preset)",
  "subject": "subject line only",
  "from": "sender only",
  "received": "received date/time only",
  "category": "the Outlook category the button adds",
  "body": "message body only (no header lines)",
  "links": "links found in the body, one per line"
};

async function getPrompts() {
  const { emailPrompt } = await chrome.storage.local.get("emailPrompt");
  const src = emailPrompt || {};
  const presets = {};
  for (const [name, text] of Object.entries(src.presets || {})) if (typeof text === "string") presets[name] = text;
  if (!Object.keys(presets).length) presets["Default"] = PROMPT_DEFAULT;
  let active = src.active;
  if (!Object.prototype.hasOwnProperty.call(presets, active)) active = Object.keys(presets)[0];
  return { presets, active };
}
async function savePrompts(p) { await chrome.storage.local.set({ emailPrompt: p }); }

// One shared "Notes" text (your long context). Any prompt can pull it in with {{notes}}.
async function getNotes() { const { emailPromptNotes } = await chrome.storage.local.get("emailPromptNotes"); return typeof emailPromptNotes === "string" ? emailPromptNotes : ""; }
async function saveNotes(t) { await chrome.storage.local.set({ emailPromptNotes: t }); }

// r = a saved email record (subject, from, receivedAt, category, body, links[]); notes = text of the Notes box
function renderPrompt(template, r, notes) {
  const links = r.links && r.links.length ? r.links.map(l => `- ${l.text || "(no text)"}: ${l.href}`).join("\n") : "";
  const all = `Subject: ${r.subject}\nFrom: ${r.from}\nReceived: ${r.receivedAt}\nCategory: ${r.category}\n\n${r.body}` +
    (links ? "\n\nLinks:\n" + links : "");
  const vals = { "notes": String(notes || "").replace(/^(\s*\n)+/, "").replace(/\s+$/, ""), "email content": all, "email": all, "subject": r.subject || "", "from": r.from || "", "received": r.receivedAt || "",
    "category": r.category || "", "body": r.body || "", "links": links };
  let used = false;
  const out = String(template).replace(/\{\{\s*([a-z ]+?)\s*\}\}/gi, (m, k) => {
    k = k.toLowerCase().replace(/\s+/g, " ");
    if (!Object.prototype.hasOwnProperty.call(vals, k)) return m;
    if (k === "email content" || k === "email" || k === "body") used = true;
    return vals[k];
  });
  return used ? out : out.replace(/\s+$/, "") + "\n\n" + all;   // template forgot the email: add it at the end
}

// ---------- masking private data before the prompt is copied ----------
// Only the EMAIL is masked (subject, sender, body, links), never your prompt text or notes.
// Pattern based, so it is a safety net and not a guarantee: names and free-text addresses can slip through
// (add them to the "always mask" list in the settings page).
const MASK_DEFAULT = {
  enabled: true,
  rules: { email: true, phone: true, card: true, ssn: true, labeled: true, address: true, urlparams: true, digits: true },
  minDigits: 11,
  words: "",
  keep: "\\bWKO-?\\d+\n\\b(?:WO|work\\s*order|case)\\s*(?:number|no\\.?|#)?\\s*[:#]?\\s*\\d+"
};
const MASK_RULE_LABELS = {
  email: "Email addresses",
  phone: "Phone numbers (with separators, or +country code)",
  card: "Card numbers (13-19 digits that pass the card checksum)",
  ssn: "SSN-style numbers (123-45-6789)",
  labeled: "Numbers after a label: customer / account / member / client / policy (number, no, id, # or colon)",
  address: "Street addresses (123 Main St, Suite 4)",
  urlparams: "Link query strings (everything after the ? in a URL)",
  digits: "Long plain digit strings (set the minimum length below)"
};

async function getMask() {
  const { emailPromptMask } = await chrome.storage.local.get("emailPromptMask");
  const s = emailPromptMask || {};
  const md = Number(s.minDigits);
  return {
    enabled: s.enabled !== false,
    rules: Object.assign({}, MASK_DEFAULT.rules, s.rules || {}),
    minDigits: md >= 6 && md <= 30 ? Math.floor(md) : MASK_DEFAULT.minDigits,
    words: typeof s.words === "string" ? s.words : MASK_DEFAULT.words,
    keep: typeof s.keep === "string" ? s.keep : MASK_DEFAULT.keep
  };
}
async function saveMask(m) { await chrome.storage.local.set({ emailPromptMask: m }); }

function luhnOk(d) {
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}

// tally = { n: 0 } is increased for every masked item
function maskText(text, cfg, tally) {
  let s = String(text == null ? "" : text);
  if (!s || !cfg || !cfg.enabled) return s;
  const R = cfg.rules || {}, t = tally || { n: 0 };
  const hit = label => { t.n++; return `[${label} masked]`; };

  // 1) protect what must never be masked (work order numbers etc.)
  const kept = [];
  for (const line of String(cfg.keep || "").split(/\r?\n/)) {
    const src = line.trim(); if (!src) continue;
    let re; try { re = new RegExp(src, "gi"); } catch { continue; }
    s = s.replace(re, m => { if (!m) return m; kept.push(m); return `\u0001${kept.length - 1}\u0002`; });
  }
  // 2) your own words / names
  for (const line of String(cfg.words || "").split(/\r?\n/)) {
    const raw = line.trim(); if (!raw) continue;
    const [w, lab] = raw.split(/\s*=>\s*/);
    if (!w) continue;
    s = s.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), () => lab ? (t.n++, lab) : hit("text"));
  }
  if (R.email) s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, () => hit("email"));
  if (R.urlparams) s = s.replace(/(https?:\/\/[^\s?#<>"')\]]+)\?[^\s<>"')\]]*/gi, (m, base) => { t.n++; return base + "?[params masked]"; });
  if (R.labeled) s = s.replace(/\b(customer|account|acct|member|client|policy)(\s*(?:(?:number|num|no|id)\b\.?\s*[:#-]?\s*|[:#]\s*))([A-Z0-9][A-Z0-9-]{2,})/gi,
    (m, lab, sep, val) => {
      if (!/\d/.test(val)) return m;
      t.n++; const l = lab.toLowerCase() === "acct" ? "account" : lab.toLowerCase();
      return `${lab}${sep}[${l} number masked]`;
    });
  if (R.card) s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, m => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhnOk(d) ? hit("card number") : m; });
  if (R.ssn) s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => hit("SSN"));
  if (R.phone) {
    s = s.replace(/(?<![\w+])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g, () => hit("phone"));   // +country code first
    s = s.replace(/(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g, () => hit("phone"));
  }
  if (R.address) s = s.replace(/\b\d{1,6}\s+(?:[A-Za-z0-9'.-]+\s+){0,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|highway|hwy|parkway|pkwy)\b(?:,?\s*(?:suite|ste|unit|apt|#)\s*[A-Z0-9-]+)?/gi, m => {
    // the words between the number and the street type must look like a name (capitalised or numeric), so "2 hours on the road" is left alone
    const mid = m.split(/\s+/).slice(1, -1).filter(w => !/^(suite|ste|unit|apt|#)/i.test(w) && !/[,]$/.test(w));
    return mid.every(w => /^[A-Z0-9]/.test(w)) ? hit("address") : m;
  });
  if (R.digits) s = s.replace(new RegExp(`(?<![\\w-])\\d{${Math.max(6, cfg.minDigits || 11)},}(?![\\w-])`, "g"), () => hit("number"));

  return s.replace(/\u0001(\d+)\u0002/g, (m, i) => kept[+i]);
}

function maskRecord(r, cfg) {
  if (!cfg || !cfg.enabled) return { rec: r, n: 0 };
  const t = { n: 0 }, m = x => maskText(x, cfg, t);
  return { rec: Object.assign({}, r, { subject: m(r.subject), from: m(r.from), body: m(r.body),
    links: (r.links || []).map(l => ({ text: m(l.text), href: m(l.href) })) }), n: t.n };
}

// renderPrompt + masking of the email part. Returns { text, masked } (masked = how many items were hidden).
function buildPrompt(template, r, notes, maskCfg) {
  const { rec, n } = maskRecord(r, maskCfg);
  return { text: renderPrompt(template, rec, notes), masked: n };
}
