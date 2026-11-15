# Copilot pool (bridge/) - a local "AI API" built from your own Copilot tabs

Modular on purpose: nothing in here knows about emails, work orders or prompts.
Callers send text, they get text back.

Files
- `broker.js`        background side: pool of tabs, job queue, retries (loaded by background.js via importScripts)
- `worker.js`        runs inside each pool Copilot tab: paste prompt -> send -> wait for answer -> report -> new chat
- `client.js`        `CopilotBridge.ask()` for any page or content script of this extension
- `popup-bridge.js`  the "Copilot pool" tab in the popup (on/off, tab count, status, test box)

Turn it on: popup -> **Copilot pool** -> tick "Turn the Copilot pool on". It opens N Copilot tabs in a collapsed tab group
called "WO Checker - Copilot" and keeps each on an empty chat so the next request starts instantly.
Only tabs in that group (or ones you add with "Use this tab as a worker") are touched.

## Using it from other features
Add `bridge/client.js` before your script (in popup.html, or in the content_scripts `js` list), then:

```js
const r = await CopilotBridge.ask("Summarize: ...");     // { text, markdown, ms, queuedMs, tabId }
await CopilotBridge.ask(prompt, { onChunk: t => {}, timeoutMs: 60000, priority: 5, retries: 1, signal });
const { json } = await CopilotBridge.askJSON('Reply ONLY with JSON like {"action":"..."}');
```
Errors carry `err.code`: `disabled` (pool off), `timeout`, `failed`, `empty`.
Content scripts (e.g. the Outlook one) can call it directly - same extension.

## Debugging
Popup -> Copilot pool -> **Copy debug log**. Selectors for the Copilot page are at the top of `worker.js`.
