"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setImmediate: settle } = require("node:timers/promises");
const { SEND_LATER_READY: READY, makeSendLaterClock } = require("./helpers/send-later.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/background.js"), "utf8");
const apiSource = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = apiSource.indexOf("// BEGIN SEND LATER INFO API");
const end = apiSource.indexOf("// END SEND LATER INFO API", start);
assert.ok(start >= 0 && end > start, "Missing production Send Later normalizer marker");
const NORMALIZER = `({ ${apiSource.slice(start, end)} })`;
const REFRESH_MS = 60000;
const TIMEOUT_MS = 10000;
const ADDON_ID = "sendlater3@kamens.us";

// Searched test/helpers and timer tests for a reusable deferred promise; only
// private callbacks exist. Keep this fixture compatible with CI's Node 18 job.
function deferred() {
  const result = {};
  result.promise = new Promise((resolve, reject) => {
    result.resolve = resolve;
    result.reject = reject;
  });
  return result;
}

// Searched background tests and timer harnesses: server-lifecycle mocks XPCOM
// timers; privacy-options mocks browser methods. Combine those boundary patterns
// to execute the whole background script and the real Experiment normalizer.
function loadBackground() {
  const clock = makeSendLaterClock();
  const timers = new Set();
  const intervals = [];
  const requests = [];
  const recorded = [];
  const errors = [];
  const context = vm.createContext({
    Date: clock.Date,
    console: { log() {}, error: (...args) => errors.push(args) },
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    setInterval: (callback, delay) => intervals.push({ callback, delay }),
  });
  const experiment = vm.runInContext(NORMALIZER, context);
  const h = {
    context, clock, timers, intervals, requests, recorded, errors,
    answer: action => Promise.resolve(action === "getUUID" ? READY.uuid : READY),
  };
  context.browser = {
    runtime: {
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      sendMessage(id, { action }) {
        requests.push({ id, action });
        return h.answer(action);
      },
    },
    mcpServer: {
      start: async () => ({ success: true }),
      async setSendLaterInfo(info) {
        recorded.push(info);
        return experiment.setSendLaterInfo(info);
      },
    },
  };
  vm.runInContext(source, context);
  return h;
}

describe("Send Later background discovery", () => {
  it("refreshes at startup and every minute, without requesting version", async () => {
    const h = loadBackground();
    await settle();
    assert.deepEqual(h.requests, [{ id: ADDON_ID, action: "getUUID" }, { id: ADDON_ID, action: "getPreferences" }]);
    assert.equal(h.context.__tbMcpSendLaterInfo.uuid, READY.uuid);
    assert.equal(h.context.__tbMcpSendLaterInfo.sendUnsentMsgs, true);
    assert.equal(h.context.__tbMcpSendLaterInfo.checkedAt, h.clock.now);
    assert.equal(h.intervals.length, 1);
    assert.equal(h.intervals[0].delay, REFRESH_MS);
    assert.equal(h.timers.size, 0);
    h.clock.now += REFRESH_MS;
    await h.intervals[0].callback();
    assert.equal(h.context.__tbMcpSendLaterInfo.checkedAt, h.clock.now);
    assert.equal(h.requests.length, 4);
  });

  it("clears previous readiness quietly when the add-on is absent or disabled", async () => {
    const h = loadBackground();
    await settle();
    h.answer = () => Promise.reject(new Error("No receiving extension"));
    await h.context.refreshSendLaterInfo();
    assert.equal(h.context.__tbMcpSendLaterInfo, null);
    assert.equal(h.timers.size, 0);
    assert.equal(h.errors.length, 0);
  });

  it("passes unreadable preferences and malformed identifiers to the real normalizer", async () => {
    const h = loadBackground();
    await settle();
    h.answer = action => Promise.resolve(action === "getUUID" ? READY.uuid : { ...READY, sendUnsentMsgs: "true" });
    await h.context.refreshSendLaterInfo();
    assert.equal(h.context.__tbMcpSendLaterInfo.sendUnsentMsgs, null);
    h.answer = action => Promise.resolve(action === "getUUID" ? "invalid\n" : READY);
    await h.context.refreshSendLaterInfo();
    assert.equal(h.context.__tbMcpSendLaterInfo, null);
  });

  for (const action of ["getUUID", "getPreferences"]) {
    it(`clears readiness after ten seconds waiting for ${action}, ignoring its late answer`, async () => {
      const h = loadBackground();
      await settle();
      const delayed = deferred();
      h.answer = request => request === action ? delayed.promise : Promise.resolve(request === "getUUID" ? READY.uuid : READY);
      const pending = h.context.refreshSendLaterInfo();
      const [timer] = h.timers;
      assert.equal(timer.delay, TIMEOUT_MS);
      h.clock.now += TIMEOUT_MS;
      timer.callback();
      await pending;
      assert.equal(h.context.__tbMcpSendLaterInfo, null);
      const count = h.recorded.length;
      delayed.resolve(action === "getUUID" ? READY.uuid : READY);
      await settle();
      assert.equal(h.recorded.length, count);
      assert.equal(h.context.__tbMcpSendLaterInfo, null);
      assert.equal(h.timers.size, 0);
    });
  }

  for (const outcome of ["success", "failure", "timeout"]) {
    it(`ignores a superseded refresh's ${outcome}`, async () => {
      const h = loadBackground();
      await settle();
      const old = deferred();
      h.answer = action => action === "getUUID" ? old.promise : Promise.resolve(READY);
      const pending = h.context.refreshSendLaterInfo();
      const [oldTimer] = h.timers;
      h.answer = action => Promise.resolve(action === "getUUID" ? "new-instance" : READY);
      await h.context.refreshSendLaterInfo();
      const count = h.recorded.length;
      if (outcome === "success") old.resolve("old-instance");
      else if (outcome === "failure") old.reject(new Error("Old failure"));
      else {
        h.clock.now += TIMEOUT_MS;
        oldTimer.callback();
      }
      await pending;
      assert.equal(h.context.__tbMcpSendLaterInfo.uuid, "new-instance");
      assert.equal(h.recorded.length, count);
      assert.equal(h.timers.size, 0);
    });
  }

  it("ignores old success after a newer refresh has cleared readiness", async () => {
    const h = loadBackground();
    await settle();
    const old = deferred();
    h.answer = action => action === "getUUID" ? old.promise : Promise.resolve(READY);
    const pending = h.context.refreshSendLaterInfo();
    h.answer = () => Promise.reject(new Error("Disabled"));
    await h.context.refreshSendLaterInfo();
    old.resolve(READY.uuid);
    await pending;
    assert.equal(h.context.__tbMcpSendLaterInfo, null);
  });

  for (const elapsed of [-1, TIMEOUT_MS - 1, TIMEOUT_MS, TIMEOUT_MS + 1]) {
    it(`checks elapsed time even if the timeout callback has not run: ${elapsed}ms`, async () => {
      const h = loadBackground();
      await settle();
      const delayed = deferred();
      h.answer = action => action === "getUUID" ? delayed.promise : Promise.resolve(READY);
      const checkedAt = h.clock.now;
      const pending = h.context.refreshSendLaterInfo();
      h.clock.now += elapsed;
      delayed.resolve(READY.uuid);
      await pending;
      if (elapsed >= 0 && elapsed < TIMEOUT_MS) {
        assert.equal(h.context.__tbMcpSendLaterInfo.checkedAt, checkedAt);
      } else {
        assert.equal(h.context.__tbMcpSendLaterInfo, null);
      }
      assert.equal(h.timers.size, 0);
    });
  }
});
