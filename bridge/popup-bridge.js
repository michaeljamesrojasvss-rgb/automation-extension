// Popup UI for the Copilot pool (the "Copilot pool" tab). Self-contained.
(() => {
  const $ = id => document.getElementById(id);
  const send = m => chrome.runtime.sendMessage(m);
  const URL_OK = /copilot\.cloud\.microsoft|m365\.cloud\.microsoft/;

  async function load() {
    const S = await chrome.storage.local.get({ cbEnabled: false, cbPoolSize: 3, cbUrl: "https://copilot.cloud.microsoft/chat" });
    $("cbOn").checked = S.cbEnabled; $("cbSize").value = S.cbPoolSize; $("cbUrl").value = S.cbUrl;
  }
  $("cbOn").onchange = () => chrome.storage.local.set({ cbEnabled: $("cbOn").checked });
  $("cbSize").onchange = () => chrome.storage.local.set({ cbPoolSize: Math.max(1, Math.min(10, +$("cbSize").value || 1)) });
  $("cbUrl").onchange = () => chrome.storage.local.set({ cbUrl: $("cbUrl").value.trim() });
  $("cbOpen").onclick = () => send({ cb: "openPool" });
  $("cbClose").onclick = () => send({ cb: "closePool" });
  $("cbAdopt").onclick = async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t || !URL_OK.test(t.url || "")) { $("cbMsg").textContent = "Open a Copilot tab first, then click this."; return; }
    await send({ cb: "adopt", tabId: t.id });
    $("cbMsg").textContent = "This tab is now a worker (it gets reset to new chats).";
  };
  $("cbLogs").onclick = async () => {
    const r = await send({ cb: "logs" });
    const txt = (r.logs || []).map(l => `${new Date(l.t).toISOString().slice(11, 23)} [${l.src}] ${l.msg} ${l.data}`).join("\n");
    await navigator.clipboard.writeText(txt || "(no log lines)"); $("cbMsg").textContent = "Debug log copied.";
  };
  $("cbAsk").onclick = async () => {
    const t0 = performance.now(); $("cbAnswer").textContent = ""; $("cbTiming").textContent = "waiting...";
    try {
      const r = await CopilotBridge.ask($("cbPrompt").value, { onChunk: t => { $("cbAnswer").textContent = t; } });
      $("cbAnswer").textContent = r.markdown || r.text;
      $("cbTiming").textContent = `${Math.round(performance.now() - t0)} ms total (queued ${r.queuedMs} ms, tab ${r.tabId})`;
    } catch (e) { $("cbAnswer").textContent = "Error: " + e.message; $("cbTiming").textContent = ""; }
  };

  async function refresh() {
    if ($("pane-cb").hidden) return;
    let s; try { s = await send({ cb: "status" }); } catch { return; }
    if (!s || s.error) return;
    const ready = s.workers.filter(w => w.state === "ready").length;
    $("cbSummary").textContent = s.settings.cbEnabled
      ? `${ready}/${s.workers.length} tabs ready, ${s.running} running, ${s.queued} queued`
      : "Pool is off";
    $("cbWorkers").innerHTML = "<tr><th>Tab</th><th>State</th><th>Done</th><th>Failed</th><th>Last</th></tr>" +
      (s.workers.map(w => `<tr><td>${w.tabId}</td><td class="cb-${w.state}">${w.state}</td><td>${w.done}</td><td>${w.fails}</td><td>${w.lastMs ? w.lastMs + " ms" : ""}</td></tr>`).join("") ||
        "<tr><td colspan=5 class='small'>No Copilot tabs registered yet (they show up a few seconds after opening).</td></tr>");
    $("cbStats").textContent = s.avgMs ? `Average answer time: ${s.avgMs} ms (last ${s.recent.length} jobs)` : "";
  }
  load(); refresh(); setInterval(refresh, 800);
})();
