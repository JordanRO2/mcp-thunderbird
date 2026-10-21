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
// Send Later (sendlater3@kamens.us) sends a draft only when its
// X-Send-Later-Uuid header matches its own instance UUID. Ask it for that
// UUID, and for the preferences that decide whether it sends at all, through
// its external messaging API so saveDraft can schedule drafts. A failed
// request clears the info, so scheduling is refused within a minute of Send
// Later being disabled or removed.
const SEND_LATER_ID = "sendlater3@kamens.us";

async function refreshSendLaterInfo() {
  let info = {};
  try {
    const uuid = await browser.runtime.sendMessage(SEND_LATER_ID, { action: "getUUID" });
    const version = await browser.runtime.sendMessage(SEND_LATER_ID, { action: "getVersion" });
    const prefs = await browser.runtime.sendMessage(SEND_LATER_ID, { action: "getPreferences" });
    if (typeof uuid === "string" && uuid) {
      info = {
        uuid,
        version: typeof version === "string" ? version : "",
        // Send Later only scans Drafts when sendDrafts is on and its check
        // interval (minutes) is above zero.
        sendDrafts: prefs ? prefs.sendDrafts : undefined,
        checkTimePref: prefs ? prefs.checkTimePref : undefined,
      };
    }
  } catch {
    // Not installed, disabled, or not started yet: scheduling stays unavailable.
  }
  try {
    await browser.mcpServer.setSendLaterInfo(info);
  } catch (e) {
    console.error("Failed to record Send Later info:", e);
  }
}

refreshSendLaterInfo();
setInterval(refreshSendLaterInfo, 60 * 1000);
