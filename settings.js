// Shared by the popup, the settings page and the background worker.
const BUILTIN = {
  SC: ["COMPLETED/CANCELLED", "COMPLETED/CONFIRMED", "COMPLETED/NO CHARGE", "COMPLETED/PENDING CONFIRMATION", "COMPLETED/STORE NEEDS TO ORDER PARTS"],
  DT: ["Pending Close Out"],
  SF: ["Location Confirmed Service Complete"]
};
const GROUP_INFO = {
  SC: { title: "ServiceChannel", help: "A WO counts when its row on ServiceChannel shows any status in this list. Matching ignores upper/lower case and spaces around the slash, and matches part of the text (\"COMPLETED/CONFIRMED\" matches that exact badge)." },
  DT: { title: "Dollar Tree", help: "A WO counts when its details page on the Dollar Tree portal shows any status in this list. Matching ignores upper/lower case and matches part of the text (\"Pending Close Out\" matches \"Job Complete - Pending Close Out #\")." },
  SF: { title: "Salesforce (done statuses)", help: "After ServiceChannel / Dollar Tree matches, the Salesforce case Status must equal one of these (exact, ignoring upper/lower case) for the WO to come back TRUE. Add e.g. \"Cancelled\" if that should count too." }
};

// Same normalization the page probes use (statuses are compared upper-case, single-spaced, no spaces around "/").
function normStatus(s) {
  return String(s || "").toUpperCase().replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/").trim();
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const out = {};
  for (const g of Object.keys(BUILTIN)) {
    const src = (settings && settings[g]) || {};
    const presets = {};
    for (const [name, list] of Object.entries(src.presets || {})) if (Array.isArray(list)) presets[name] = list.map(String);
    if (!Object.keys(presets).length) presets["Default"] = BUILTIN[g].slice();
    let active = src.active;
    if (!Object.prototype.hasOwnProperty.call(presets, active)) active = Object.keys(presets)[0];
    out[g] = { presets, active };
  }
  return out;
}
async function saveSettings(s) { await chrome.storage.local.set({ settings: s }); }
