// Copilot pool client - use from any page or content script of THIS extension (popup, options, background, Outlook script...).
//
//   const r = await CopilotBridge.ask("Summarize: ...");                 // -> { text, markdown, ms, queuedMs, tabId }
//   await CopilotBridge.ask(prompt, { onChunk: t => ..., timeoutMs: 60000, priority: 5, retries: 1, signal });
//   const { json } = await CopilotBridge.askJSON('Reply ONLY with JSON like {"action":"..."}');
//
// Errors carry err.code: "disabled" (pool is off), "timeout", "failed", "empty".
// Needs "bridge/client.js" listed in the page / content_scripts before your own script.
(function (root) {
  function extractJSON(text) {
    const tryParse = s => { try { return JSON.parse(s); } catch { return undefined; } };
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fence) { const v = tryParse(fence[1].trim()); if (v !== undefined) return v; }
    const whole = tryParse(text.trim()); if (whole !== undefined) return whole;
    const open = text.search(/[\[{]/);
    if (open >= 0) {
      const close = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      if (close > open) { const v = tryParse(text.slice(open, close + 1)); if (v !== undefined) return v; }
    }
    throw new Error("No valid JSON found in the answer");
  }
  const connect = () => chrome.runtime.connect({ name: "cb-ask" });

  root.CopilotBridge = {
    ask(prompt, opts = {}) {
      return new Promise((resolve, reject) => {
        let port;
        try { port = connect(); } catch (e) { return reject(new Error("Copilot pool not reachable: " + e.message)); }
        const id = Math.random().toString(36).slice(2);
        let settled = false;
        const finish = (fn, v) => { if (settled) return; settled = true; try { port.disconnect(); } catch {} fn(v); };
        port.onMessage.addListener(m => {
          if (!m || m.id !== id) return;
          if (m.type === "chunk") { if (opts.onChunk) opts.onChunk(m.text); }
          else if (m.type === "done") finish(resolve, { text: m.text, markdown: m.markdown, ms: m.ms, queuedMs: m.queuedMs, tabId: m.tabId });
          else if (m.type === "error") { const e = new Error(m.error); e.code = m.code; finish(reject, e); }
        });
        port.onDisconnect.addListener(() => finish(reject, new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "Copilot pool disconnected")));
        if (opts.signal) opts.signal.addEventListener("abort", () => {
          try { port.postMessage({ type: "cancel", id }); } catch {}
          finish(reject, new DOMException("Aborted", "AbortError"));
        });
        port.postMessage({ type: "ask", id, prompt: String(prompt), opts: { stream: !!opts.onChunk, timeoutMs: opts.timeoutMs, priority: opts.priority, retries: opts.retries } });
      });
    },
    async askJSON(prompt, opts) {
      const r = await this.ask(prompt, opts);
      return { ...r, json: extractJSON(r.text) };
    }
  };
})(typeof self !== "undefined" ? self : window);
