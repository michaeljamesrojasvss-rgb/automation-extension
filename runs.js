// Run history storage, shared by the background worker and the results page.
//   runIndex        -> [{id, startedAt, source, total, finished, summary}, ...] newest first
//   run:<id>        -> run details (ids, lists used, ...)
//   row:<id>:<n>    -> result of WO number n in that run (including captured page snippets)
const MAX_RUNS = 100;   // oldest runs are deleted automatically beyond this

async function getIndex() {
  const { runIndex } = await chrome.storage.local.get("runIndex");
  return Array.isArray(runIndex) ? runIndex : [];
}
function runKeys(entry) {
  const keys = [`run:${entry.id}`];
  for (let i = 0; i < (entry.total || 0); i++) keys.push(`row:${entry.id}:${i}`);
  return keys;
}
async function deleteRun(id) {
  const idx = await getIndex();
  const entry = idx.find(x => x.id === id);
  if (entry) await chrome.storage.local.remove(runKeys(entry));
  await chrome.storage.local.set({ runIndex: idx.filter(x => x.id !== id) });
}
