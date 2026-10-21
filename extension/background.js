// `browser` is declared as a global in eslint.config.mjs for the
// extension/ file group. The per-file /* global browser */ comment
// would trigger no-redeclare.
async function init() {
  try {
    const result = await browser.mcpServer.start();
    if (result.success) {
      console.log("MCP server started on port", result.port);
    } else {
      console.error("Failed to start MCP server:", result.error);
    }
  } catch (e) {
    console.error("Error starting MCP server:", e);
  }
}

browser.runtime.onInstalled.addListener(init);
browser.runtime.onStartup.addListener(init);

// Also call init() directly — the event listeners above don't fire when
// a user disables and re-enables the extension.
init();

// Send Later discovery is advisory: a failure or timeout clears readiness.
// The Experiment also expires a successful snapshot after three minutes.
const SEND_LATER_ID = "sendlater3@kamens.us";
const SEND_LATER_REFRESH_INTERVAL_MS = 60 * 1000;
const SEND_LATER_REFRESH_TIMEOUT_MS = 10 * 1000;
let sendLaterRefreshGeneration = 0;

async function refreshSendLaterInfo() {
  const generation = ++sendLaterRefreshGeneration;
  const checkedAt = Date.now();
  let timeout;
  let info = null;
  try {
    const answers = await Promise.race([
      Promise.all([
        browser.runtime.sendMessage(SEND_LATER_ID, { action: "getUUID" }),
        browser.runtime.sendMessage(SEND_LATER_ID, { action: "getPreferences" }),
      ]),
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), SEND_LATER_REFRESH_TIMEOUT_MS); }),
    ]);
    // Check elapsed time as well: suspended/throttled timers may fire late.
    const elapsed = Date.now() - checkedAt;
    if (answers && elapsed >= 0 && elapsed < SEND_LATER_REFRESH_TIMEOUT_MS) {
      const [uuid, prefs] = answers;
      info = {
        uuid,
        checkedAt,
        sendDrafts: prefs?.sendDrafts,
        sendUnsentMsgs: prefs?.sendUnsentMsgs,
        checkTimePref: prefs?.checkTimePref,
      };
    }
  } catch {
    // Absent, disabled or unreadable: refuse scheduling without console noise.
  } finally {
    clearTimeout(timeout);
  }
  // An earlier request must never replace a newer success or clear its state.
  if (generation !== sendLaterRefreshGeneration) return;
  try {
    await browser.mcpServer.setSendLaterInfo(info);
  } catch (e) {
    console.error("Failed to record Send Later info:", e);
  }
}

refreshSendLaterInfo();
setInterval(refreshSendLaterInfo, SEND_LATER_REFRESH_INTERVAL_MS);
