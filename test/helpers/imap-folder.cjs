"use strict";

const IMAP_TYPE = "imap";

function makeMailSession() {
  const listeners = new Set();
  const mailSession = {
    AddFolderListener(listener) { listeners.add(listener); },
    RemoveFolderListener(listener) { listeners.delete(listener); },
    fire(folder, event = "FolderLoaded") {
      for (const listener of [...listeners]) listener.onFolderEvent(folder, event);
    },
  };
  return { mailSession, listeners };
}

// Attach only provider state/methods, preserving the supplied folder's identity,
// message getters, stats and hooks. clock/runtime accept values or deferred getters
// so the session can be installed in loadRefreshRuntime before it is available.
// onRefresh/onUpdate receive the folder at updateFolder/updateFolderWithListener
// entry, including busy/offline calls. onUpdateComplete also receives the exit
// status and URL and runs before FolderLoaded for successful and failed updates.
function makeImapFolder({
  folder = {}, clock, runtime, session = makeMailSession(), delay = 50, exitCode = 0,
  onRefresh, onUpdate, onUpdateComplete, synchronousLoads = 0,
} = {}) {
  const { mailSession, listeners } = session;
  const getClock = typeof clock === "function" ? clock : () => clock;
  const getRuntime = typeof runtime === "function" ? runtime : () => runtime;
  folder.server ??= { type: IMAP_TYPE };
  folder.QueryInterface ??= function () { return this; };
  Object.assign(folder, {
    updateCalls: 0, imapUpdateCalls: 0, urlRunning: false, updatingFolder: false,
    urlListener: null, updateUrl: null, synchronousLoads,
    finishUrl(url, status = exitCode) {
      this.urlRunning = false;
      this.updatingFolder = false;
      if (url.updatingFolder) {
        onUpdateComplete?.(this, status, url);
        // The base folder fires loaded for success AND failure, first.
        mailSession.fire(this);
      }
      const listener = this.urlListener;
      this.urlListener = null; // Whichever URL ends first consumes this slot.
      listener?.OnStopRunningUrl(url, status);
    },
    updateFolderWithListener(_window, listener) {
      this.imapUpdateCalls++;
      onUpdate?.(this);
      if (this.synchronousLoads > 0) {
        this.synchronousLoads--;
        mailSession.fire(this);
        return;
      }
      if (!this.urlRunning) {
        if (getRuntime().Services.io.offline) { mailSession.fire(this); return; }
        this.urlRunning = this.updatingFolder = true;
        this.urlListener = listener;
        const url = { updatingFolder: true, QueryInterface() { return this; } };
        this.updateUrl = url;
        if (delay !== null) getClock().schedule(delay, () => this.finishUrl(url));
      } else if (!this.updatingFolder) {
        // A body fetch is running: no update starts and no listener is saved.
        mailSession.fire(this);
      }
      // A running update will send FolderLoaded later; the new listener is lost.
    },
    updateFolder() {
      this.updateCalls++;
      onRefresh?.(this);
      if (this.server.type === IMAP_TYPE) this.updateFolderWithListener(null, null);
      else if (delay !== null) getClock().schedule(delay, () => mailSession.fire(this));
    },
  });
  return { folder, mailSession, listeners };
}

module.exports = { makeImapFolder, makeMailSession };
