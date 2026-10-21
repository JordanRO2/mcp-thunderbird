"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadRefreshRuntime } = require("./helpers/refresh-runtime.cjs");
const { makeImapFolder } = require("./helpers/imap-folder.cjs");

const WAIT_MS = 1000;
const UPDATE_MS = 50;
const BUSY_UPDATE_MS = 300;
const BUSY_START_DELAY_MS = 10;
const STORE_MS = 40;
const FAILURE = 0x80004005;
const FLAGS = { Virtual: 0x20, ImapNoselect: 0x01000000 };
const FOLDER_URI = "imap://account/Inbox";

// Keep the original count fixture on the shared IMAP event-order model.
function loadRefresh({ type = "imap", offline = false, denied = false, delay = UPDATE_MS, exitCode = 0 } = {}) {
  let harness;
  const folder = {
    URI: FOLDER_URI, server: { type }, flags: 0, isServer: false,
    total: 10, unread: 2, arrivals: 2, countReads: 0,
    getTotalMessages() { this.countReads++; return this.total; },
    getNumUnread() { this.countReads++; return this.unread; },
    QueryInterface() { return this; },
    getNewMessages() { assert.fail("account-level Get Mail must not be used"); },
  };
  const { listeners, mailSession } = makeImapFolder({
    folder, clock: () => harness.clock, runtime: () => harness.runtime, delay, exitCode,
    onUpdateComplete(current, status) {
      if (status === 0) { current.total += current.arrivals; current.unread += current.arrivals; }
    },
  });
  harness = loadRefreshRuntime({
    blocks: ["REFRESH FOLDER TOOL"],
    expose: ["refreshFolder", "waitForFolderRefresh"],
    globals: {
      Services: { io: { offline } },
      Ci: { nsMsgFolderFlags: FLAGS, nsIFolderListener: { event: 0x80 }, nsIMsgImapMailFolder: "imap", nsIMsgMailNewsUrl: "mail-url" },
      MailServices: { mailSession },
      getAccessibleFolder: uri => denied ? { error: "Account not accessible" }
        : uri === folder.URI ? { folder } : { error: "Folder not found" },
    },
  });
  return { ...harness, folder, listeners, mailSession, refresh: timeout => harness.runtime.refreshFolder(folder.URI, timeout ?? WAIT_MS) };
}

describe("refreshFolder IMAP completion", () => {
  it("waits for the update, confirms its successful URL, and reports net counts", async () => {
    const h = loadRefresh();
    const pending = h.refresh();
    assert.equal(h.listeners.size, 1);
    await h.clock.advance(UPDATE_MS);
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.status, "loaded");
    assert.equal(result.updateConfirmed, true);
    assert.equal(result.warning, undefined);
    assert.equal(result.totalBefore, 10);
    assert.equal(result.totalAfter, 12);
    assert.equal(result.unreadAfter, 4);
    assert.equal(result.netMessageDelta, 2);
    assert.equal(result.elapsedMs, UPDATE_MS);
    assert.equal(h.folder.imapUpdateCalls, 1);
    assert.equal(h.folder.updateCalls, 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.clock.activeTimers.length, 0);
  });

  it("lets a failing update exit code beat the preceding FolderLoaded", async () => {
    const h = loadRefresh({ exitCode: FAILURE });
    const pending = h.refresh();
    await h.clock.advance(UPDATE_MS);
    const result = await pending;
    assert.equal(result.status, "error");
    assert.equal(result.success, false);
    assert.equal(result.updateConfirmed, false);
    assert.match(result.error, /0x80004005/);
    assert.equal(result.netMessageDelta, 0);
    assert.equal(h.listeners.size, 0);
  });

  for (const exitCode of [0, FAILURE]) {
    it(`observes a pre-existing update without a URL callback (exit ${exitCode})`, async () => {
      const h = loadRefresh({ delay: BUSY_UPDATE_MS, exitCode });
      h.folder.updateFolder(); // The existing fire-and-forget folder-read path.
      await h.clock.advance(BUSY_START_DELAY_MS);
      const pending = h.refresh();
      assert.equal(h.folder.urlListener, null, "busy update must discard the new listener");
      await h.clock.advance(BUSY_UPDATE_MS - BUSY_START_DELAY_MS);
      const result = await pending;
      assert.equal(result.status, "loaded");
      assert.equal(result.updateConfirmed, false);
      assert.match(result.warning, /reported.*loaded.*could not be confirmed/);
      assert.equal(result.netMessageDelta, exitCode === 0 ? 2 : 0);
      assert.equal(result.elapsedMs, BUSY_UPDATE_MS - BUSY_START_DELAY_MS);
      assert.equal(h.listeners.size, 0);
    });
  }

  it("reports synchronous FolderLoaded during a body fetch as no update ran", async () => {
    const h = loadRefresh();
    h.folder.urlRunning = true;
    const pending = h.refresh();
    await h.clock.flush();
    const result = await pending;
    assert.equal(result.status, "loaded");
    assert.equal(result.updateConfirmed, false);
    assert.match(result.warning, /No update ran/);
    assert.equal(result.elapsedMs, 0);
    assert.equal(h.folder.updateUrl, null);
    assert.equal(h.listeners.size, 0);
  });

  for (const exitCode of [0, FAILURE]) {
    it(`ignores a non-update URL consuming the listener (exit ${exitCode})`, async () => {
      const h = loadRefresh({ delay: BUSY_UPDATE_MS });
      // A STORE queued ahead of SELECT can finish first. A STORE issued after
      // SELECT normally waits, so this deliberately models the earlier queue.
      const storeUrl = { updatingFolder: false, QueryInterface() { return this; } };
      h.clock.schedule(STORE_MS, () => h.folder.finishUrl(storeUrl, exitCode));
      let completed = false;
      const pending = h.refresh().then(result => { completed = true; return result; });
      await h.clock.advance(STORE_MS);
      assert.equal(completed, false);
      assert.equal(h.folder.urlListener, null);
      await h.clock.advance(BUSY_UPDATE_MS - STORE_MS);
      const result = await pending;
      assert.equal(result.status, "loaded");
      assert.equal(result.updateConfirmed, false);
      assert.equal(result.netMessageDelta, 2);
      assert.match(result.warning, /could not be confirmed/);
    });
  }

  it("ignores an unidentifiable URL instead of treating it as a successful update", async () => {
    const h = loadRefresh();
    let completed = false;
    const pending = h.refresh().then(result => { completed = true; return result; });
    h.folder.urlListener.OnStopRunningUrl(null, 0);
    await h.clock.flush();
    assert.equal(completed, false);
    await h.clock.advance(UPDATE_MS);
    assert.equal((await pending).updateConfirmed, true);
  });

  it("cleans up when starting an update throws", async () => {
    const h = loadRefresh();
    h.folder.updateFolderWithListener = () => { throw new Error("Cannot start update"); };
    const result = await h.refresh();
    assert.equal(result.status, "error");
    assert.match(result.error, /Cannot start update/);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.clock.activeTimers.length, 0);
  });
});

describe("refreshFolder lifecycle and access", () => {
  it("keeps listening after a caller timeout and lets a fresh caller join", async () => {
    const h = loadRefresh({ delay: null });
    const first = h.refresh();
    await h.clock.advance(WAIT_MS);
    const timeout = await first;
    assert.equal(timeout.status, "timeout");
    assert.equal(timeout.success, false);
    assert.equal(timeout.updateConfirmed, false);
    assert.match(timeout.error, /not confirmed/);
    assert.equal(h.listeners.size, 1);
    const second = h.refresh();
    h.folder.finishUrl(h.folder.updateUrl, 0);
    await h.clock.flush();
    const result = await second;
    assert.equal(result.status, "loaded");
    assert.equal(result.joinedInFlight, true);
    assert.equal(h.folder.imapUpdateCalls, 1);
    assert.equal(h.listeners.size, 0);
  });

  it("retries a stale folder wait and retires its observer without renewing age", async () => {
    const h = loadRefresh({ delay: null });
    const first = h.refresh();
    await h.clock.advance(WAIT_MS);
    await first;
    await h.clock.advance(h.runtime.REFRESH_MAX_TIMEOUT_MS - WAIT_MS);
    const second = h.refresh();
    assert.equal(h.folder.imapUpdateCalls, 2);
    assert.equal(h.listeners.size, 1, "the old observer was retired");
    h.mailSession.fire(h.folder);
    await h.clock.flush();
    const result = await second;
    assert.equal(result.joinedInFlight, undefined);
    assert.equal(result.status, "loaded");
    assert.equal(h.listeners.size, 0);
  });

  it("provides a 5-second structured adapter without reading message counts", async () => {
    const h = loadRefresh({ delay: null });
    const searchWaitMs = 5000;
    const pending = h.runtime.waitForFolderRefresh(h.folder, searchWaitMs);
    await h.clock.advance(searchWaitMs);
    const result = await pending;
    assert.equal(result.status, "timeout");
    assert.equal(result.joinedInFlight, false);
    assert.equal(result.folderPath, undefined);
    assert.equal(h.folder.countReads, 0);
    h.folder.finishUrl(h.folder.updateUrl, 0);
    await h.clock.flush();
  });

  it("refuses offline calls without starting or joining a provider", async () => {
    const h = loadRefresh({ offline: true });
    for (const call of [() => h.refresh(), () => h.runtime.waitForFolderRefresh(h.folder, WAIT_MS)]) {
      const result = await call();
      assert.equal(result.status, "error");
      assert.match(result.error, /offline/);
    }
    assert.equal(h.folder.imapUpdateCalls, 0);
    assert.equal(h.folder.countReads, 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.clock.activeTimers.length, 0);
  });

  it("does not join an existing refresh after Thunderbird goes offline", async () => {
    const h = loadRefresh({ delay: null });
    const first = h.refresh();
    await h.clock.advance(WAIT_MS);
    await first;
    h.runtime.Services.io.offline = true;
    const result = await h.refresh();
    assert.equal(result.status, "error");
    assert.match(result.error, /offline/);
    assert.equal(result.joinedInFlight, undefined);
    assert.equal(h.folder.imapUpdateCalls, 1);
    await h.clock.advance(h.runtime.REFRESH_ABANDON_MS);
    assert.equal(h.listeners.size, 0);
  });

  it("rejects inaccessible and unknown folders before provider or count access", async () => {
    const denied = loadRefresh({ denied: true });
    assert.match((await denied.refresh()).error, /not accessible/);
    assert.equal(denied.folder.countReads, 0);
    assert.equal(denied.folder.imapUpdateCalls, 0);
    const unknown = loadRefresh();
    assert.match((await unknown.runtime.refreshFolder("missing")).error, /not found/);
  });

  for (const type of ["imap", "owl", "none", "pop3"]) {
    it(`refuses a ${type} account root without walking descendants`, async () => {
      const h = loadRefresh({ type });
      h.folder.isServer = true;
      Object.defineProperty(h.folder, "descendants", { get() { return assert.fail("must not fan out"); } });
      assert.match((await h.refresh()).error, /Account roots/);
      assert.equal(h.folder.updateCalls + h.folder.imapUpdateCalls, 0);
      assert.equal(h.folder.countReads, 0);
    });
  }

  it("refuses saved searches and no-select folders, including local saved searches", async () => {
    for (const [type, flag, message] of [["imap", FLAGS.ImapNoselect, /no-select/], ["owl", FLAGS.Virtual, /virtual/], ["none", FLAGS.Virtual, /virtual/]]) {
      const h = loadRefresh({ type });
      h.folder.flags = flag;
      assert.match((await h.refresh()).error, message);
      assert.equal(h.folder.updateCalls + h.folder.imapUpdateCalls, 0);
    }
  });

  it("skips unsupported individual local, POP, RSS and news folders", async () => {
    for (const type of ["none", "pop3", "rss", "nntp"]) {
      const h = loadRefresh({ type });
      const result = await h.refresh();
      assert.equal(result.success, true);
      assert.match(result.skipped, /not supported/);
      assert.equal(h.folder.updateCalls, 0);
    }
  });
});

describe("refreshFolder generic providers", () => {
  for (const type of ["owl", "ews", "graph"]) {
    it(`waits for ${type} loaded without claiming a confirmed successful update`, async () => {
      const h = loadRefresh({ type });
      const pending = h.refresh();
      h.mailSession.fire({ URI: "other" });
      h.mailSession.fire(h.folder, "CompactCompleted");
      await h.clock.advance(UPDATE_MS);
      const result = await pending;
      assert.equal(result.status, "loaded");
      assert.equal(result.updateConfirmed, false);
      assert.match(result.warning, /could not be confirmed/);
      assert.equal(result.elapsedMs, UPDATE_MS);
      assert.equal(h.folder.updateCalls, 1);
      assert.equal(h.listeners.size, 0);
    });
  }

  it("accepts synchronous generic-provider loading without the IMAP no-update claim", async () => {
    const h = loadRefresh({ type: "owl" });
    h.folder.updateFolder = () => h.mailSession.fire(h.folder);
    const pending = h.refresh();
    await h.clock.flush();
    const result = await pending;
    assert.equal(result.status, "loaded");
    assert.doesNotMatch(result.warning, /No update ran/);
    assert.equal(h.listeners.size, 0);
  });
});
