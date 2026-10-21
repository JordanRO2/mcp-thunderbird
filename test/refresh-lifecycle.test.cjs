"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadRefreshRuntime } = require("./helpers/refresh-runtime.cjs");

const KEY = "shared-provider";
const SHORT_WAIT_MS = 1000;
const LONG_WAIT_MS = 5000;
const PROVIDER_ERROR = "Provider unavailable";

describe("bounded refresh production lifecycle", () => {
  it("clamps public waits while preserving the default and integer conversion", () => {
    const { runtime } = loadRefreshRuntime();
    for (const value of [undefined, null, false, "", "invalid", 0, -1, NaN, Infinity]) {
      assert.equal(runtime.clampRefreshTimeout(value), runtime.REFRESH_DEFAULT_TIMEOUT_MS);
    }
    assert.equal(runtime.clampRefreshTimeout(1), runtime.REFRESH_MIN_TIMEOUT_MS);
    assert.equal(runtime.clampRefreshTimeout(runtime.REFRESH_MAX_TIMEOUT_MS + 1), runtime.REFRESH_MAX_TIMEOUT_MS);
    assert.equal(runtime.clampRefreshTimeout("5000.75"), LONG_WAIT_MS);
  });

  it("accepts an internal wait budget below the public tool minimum", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    const budget = 200;
    let controls;
    const pending = runtime.waitForRefresh(inFlight, KEY, budget, current => { controls = current; });
    await clock.advance(budget);
    assert.equal((await pending).status, "timeout");
    assert.equal(clock.now, budget);
    controls.settle({ status: "loaded" });
    await clock.flush();
    assert.equal(clock.activeTimers.length, 0);
  });

  it("preserves synchronous outcomes and cleans resources registered before or after settlement", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    const cleaned = [];
    const result = await runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, ({ settle, addCleanup }) => {
      addCleanup(() => cleaned.push("before"));
      settle({ status: "loaded", warning: "No update ran", updateConfirmed: false });
      addCleanup(() => cleaned.push("after"));
    });
    assert.equal(result.status, "loaded");
    assert.equal(result.warning, "No update ran");
    assert.equal(result.updateConfirmed, false);
    assert.equal(result.joinedInFlight, false);
    assert.deepEqual(cleaned, ["before", "after"]);
    assert.equal(inFlight.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  for (const asynchronous of [false, true]) {
    it(`reports a ${asynchronous ? "rejected" : "throwing"} starter and cleans its resources`, async () => {
      const { runtime, clock } = loadRefreshRuntime();
      const inFlight = new Map();
      let cleanups = 0;
      const result = await runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, ({ addCleanup }) => {
        addCleanup(() => cleanups++);
        if (asynchronous) return Promise.reject(new Error(PROVIDER_ERROR));
        throw new Error(PROVIDER_ERROR);
      });
      assert.equal(result.status, "error");
      assert.equal(result.error, PROVIDER_ERROR);
      assert.equal(result.joinedInFlight, false);
      assert.equal(cleanups, 1);
      assert.equal(inFlight.size, 0);
      assert.equal(clock.activeTimers.length, 0);
    });
  }

  it("does not treat a fulfilled starter Promise as completion", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    const pending = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => {
      controls = current;
      return Promise.resolve();
    });
    await clock.advance(SHORT_WAIT_MS);
    assert.equal((await pending).status, "timeout");
    assert.equal(inFlight.size, 1);
    controls.settle({ status: "loaded" });
    await clock.flush();
    assert.equal(inFlight.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("keeps each caller's deadline independent while sharing a fresh operation", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    let starts = 0;
    let cleanups = 0;
    const start = current => {
      starts++;
      controls = current;
      current.addCleanup(() => cleanups++);
    };
    const first = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, start);
    await clock.advance(SHORT_WAIT_MS / 2);
    const second = runtime.waitForRefresh(inFlight, KEY, LONG_WAIT_MS, start);
    await clock.advance(SHORT_WAIT_MS / 2);
    const firstResult = await first;
    assert.equal(firstResult.status, "timeout");
    assert.equal(firstResult.joinedInFlight, false);
    assert.equal(inFlight.size, 1);
    assert.equal(cleanups, 0);
    assert.equal(clock.activeTimers.length, 2, "second caller deadline and operation abandonment remain");
    await clock.advance(SHORT_WAIT_MS);
    controls.settle({ status: "loaded", updateConfirmed: true });
    const secondResult = await second;
    assert.equal(secondResult.status, "loaded");
    assert.equal(secondResult.updateConfirmed, true);
    assert.equal(secondResult.joinedInFlight, true);
    assert.equal(starts, 1);
    assert.equal(cleanups, 1);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("uses the latest provider error on caller timeout without ending the operation", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    let cleanups = 0;
    const pending = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => {
      controls = current;
      current.addCleanup(() => cleanups++);
      current.reportError("Initial error");
      current.reportError(PROVIDER_ERROR);
    });
    await clock.advance(SHORT_WAIT_MS);
    const result = await pending;
    assert.equal(result.status, "error");
    assert.equal(result.error, PROVIDER_ERROR);
    assert.equal(inFlight.size, 1);
    assert.equal(cleanups, 0);
    controls.settle({ status: "loaded" });
    await clock.flush();
    assert.equal(cleanups, 1);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("measures a joining caller's timeout from that caller's arrival", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    const first = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => { controls = current; });
    await clock.advance(SHORT_WAIT_MS);
    assert.equal((await first).status, "timeout");
    const second = runtime.waitForRefresh(inFlight, KEY, LONG_WAIT_MS, () => assert.fail("must join"));
    await clock.advance(LONG_WAIT_MS);
    const result = await second;
    assert.equal(result.status, "timeout");
    assert.equal(result.joinedInFlight, true);
    assert.equal(clock.now, SHORT_WAIT_MS + LONG_WAIT_MS);
    controls.settle({ status: "loaded" });
    await clock.flush();
    assert.equal(clock.activeTimers.length, 0);
  });

  it("reports a provider error as a warning when completion arrives", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    const pending = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => {
      controls = current;
      current.reportError(PROVIDER_ERROR);
    });
    await clock.advance(SHORT_WAIT_MS / 2);
    controls.settle({ status: "loaded" });
    const result = await pending;
    assert.equal(result.status, "loaded");
    assert.equal(result.warning, PROVIDER_ERROR);
    assert.equal(result.error, undefined);
    assert.equal(inFlight.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("a later caller can complete an operation after an earlier caller timed out", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    const first = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => { controls = current; });
    await clock.advance(SHORT_WAIT_MS);
    assert.equal((await first).status, "timeout");
    const second = runtime.waitForRefresh(inFlight, KEY, LONG_WAIT_MS, () => assert.fail("must join"));
    controls.settle({ status: "loaded" });
    const result = await second;
    assert.equal(result.status, "loaded");
    assert.equal(result.joinedInFlight, true);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("joining never renews operation age and retired callbacks cannot affect its replacement", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    const operations = [];
    const cleaned = [];
    const start = controls => {
      const index = operations.length;
      operations.push(controls);
      controls.addCleanup(() => cleaned.push(index));
    };
    const initial = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, start);
    await clock.advance(SHORT_WAIT_MS);
    assert.equal((await initial).status, "timeout");
    await clock.advance(runtime.REFRESH_MAX_TIMEOUT_MS - SHORT_WAIT_MS - 1);
    const joined = runtime.waitForRefresh(inFlight, KEY, LONG_WAIT_MS, start);
    const oldEntry = inFlight.get(KEY);
    await clock.advance(1);
    const replacement = runtime.waitForRefresh(inFlight, KEY, LONG_WAIT_MS, start);
    const newEntry = inFlight.get(KEY);
    assert.notEqual(oldEntry, newEntry);
    const retiredResult = await joined;
    assert.equal(retiredResult.status, "timeout");
    assert.equal(retiredResult.joinedInFlight, true);
    assert.equal(operations.length, 2);
    assert.deepEqual(cleaned, [0]);
    operations[0].reportError("Late old error");
    operations[0].settle({ status: "error", error: "Late old settlement" });
    await clock.flush();
    assert.equal(inFlight.get(KEY), newEntry, "old cleanup must not delete the replacement");
    operations[1].settle({ status: "loaded" });
    const result = await replacement;
    assert.equal(result.status, "loaded");
    assert.equal(result.warning, undefined);
    assert.equal(result.joinedInFlight, false);
    assert.deepEqual(cleaned, [0, 1]);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("retires an old entry with its recorded error and ignores a late Promise rejection", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let rejectOld;
    const first = runtime.waitForRefresh(inFlight, KEY, runtime.REFRESH_MAX_TIMEOUT_MS, ({ reportError }) => {
      reportError(PROVIDER_ERROR);
      return new Promise((_resolve, reject) => { rejectOld = reject; });
    });
    clock.elapse(runtime.REFRESH_MAX_TIMEOUT_MS + 1);
    let newControls;
    const second = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, controls => { newControls = controls; });
    const newEntry = inFlight.get(KEY);
    const result = await first;
    assert.equal(result.status, "error");
    assert.equal(result.error, PROVIDER_ERROR);
    rejectOld(new Error("Late rejection"));
    await clock.flush();
    assert.equal(inFlight.get(KEY), newEntry);
    newControls.settle({ status: "loaded" });
    assert.equal((await second).status, "loaded");
    assert.equal(clock.activeTimers.length, 0);
  });

  it("abandons a silent operation at the cleanup cap after callers have timed out", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    let cleanups = 0;
    const pending = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => {
      controls = current;
      current.addCleanup(() => cleanups++);
    });
    await clock.advance(SHORT_WAIT_MS);
    assert.equal((await pending).status, "timeout");
    await clock.advance(runtime.REFRESH_ABANDON_MS - SHORT_WAIT_MS - 1);
    assert.equal(inFlight.size, 1);
    assert.equal(cleanups, 0);
    await clock.advance(1);
    assert.equal(inFlight.size, 0);
    assert.equal(cleanups, 1);
    assert.equal(clock.activeTimers.length, 0);
    controls.settle({ status: "loaded" });
    assert.equal(cleanups, 1);
  });

  it("counts synchronous startup time against each caller's wait budget", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    const spentStarting = SHORT_WAIT_MS - 200;
    const pending = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => {
      controls = current;
      clock.elapse(spentStarting);
    });
    assert.equal(clock.now, spentStarting);
    await clock.advance(SHORT_WAIT_MS - spentStarting);
    assert.equal((await pending).status, "timeout");
    assert.equal(clock.now, SHORT_WAIT_MS);
    controls.settle({ status: "loaded" });
    await clock.flush();
    assert.equal(clock.activeTimers.length, 0);
  });

  it("returns promptly once synchronous startup has already exhausted the wait", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let controls;
    const pending = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, current => {
      controls = current;
      clock.elapse(SHORT_WAIT_MS + 1);
    });
    await clock.advance(0);
    assert.equal((await pending).status, "timeout");
    assert.equal(clock.now, SHORT_WAIT_MS + 1);
    controls.settle({ status: "loaded" });
    await clock.flush();
    assert.equal(clock.activeTimers.length, 0);
  });

  it("isolates operations by key and ignores duplicate terminal notifications", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let firstControls;
    let secondControls;
    let firstCleanups = 0;
    const first = runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, controls => {
      firstControls = controls;
      controls.addCleanup(() => firstCleanups++);
    });
    const secondKey = "another-provider";
    const second = runtime.waitForRefresh(inFlight, secondKey, SHORT_WAIT_MS, controls => { secondControls = controls; });
    firstControls.settle({ status: "error", error: PROVIDER_ERROR });
    firstControls.settle({ status: "loaded" });
    firstControls.reportError("Late error");
    assert.equal((await first).error, PROVIDER_ERROR);
    assert.equal(firstCleanups, 1);
    assert.equal(inFlight.size, 1);
    assert.ok(inFlight.has(secondKey));
    secondControls.settle({ status: "loaded" });
    assert.equal((await second).status, "loaded");
    assert.equal(inFlight.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("continues cleanup when one provider cleanup throws", async () => {
    const { runtime, clock } = loadRefreshRuntime();
    const inFlight = new Map();
    let remainingCleanup = 0;
    const result = await runtime.waitForRefresh(inFlight, KEY, SHORT_WAIT_MS, ({ addCleanup, settle }) => {
      addCleanup(() => { throw new Error("Listener already detached"); });
      addCleanup(() => remainingCleanup++);
      settle({ status: "loaded" });
    });
    assert.equal(result.status, "loaded");
    assert.equal(remainingCleanup, 1);
    assert.equal(inFlight.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });
});
