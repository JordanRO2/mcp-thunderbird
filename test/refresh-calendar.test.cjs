"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadRefreshRuntime } = require("./helpers/refresh-runtime.cjs");

const WAIT_MS = 1000;
const LONG_WAIT_MS = 5000;
const LOAD_DELAY_MS = 20;
const FAILURE_CODE = 0x80004005;
const PROVIDER_ERROR = "Calendar server unavailable";

// Reuse the contributed calendar fixture, recording native observer ownership
// so offline refusals, retirement, and completion can be checked separately.
function makeCalendar({ id = "calendar-a", name = id, type = "caldav", disabled = false, canRefresh = true, onRefresh } = {}) {
  const observers = new Set();
  const calendar = {
    id, name, type, canRefresh,
    refreshCalls: 0,
    addObserverCalls: 0,
    removeObserverCalls: 0,
    observers,
    getProperty(key) { return key === "disabled" ? disabled : null; },
    addObserver(observer) { this.addObserverCalls++; observers.add(observer); },
    removeObserver(observer) { this.removeObserverCalls++; observers.delete(observer); },
    notify(method, ...args) { for (const observer of [...observers]) observer[method](...args); },
    refresh() {
      this.refreshCalls++;
      return onRefresh?.(this);
    },
  };
  return calendar;
}

function loadRefresh(calendars, { offline = false, available = true } = {}) {
  const harness = loadRefreshRuntime({
    blocks: ["REFRESH CALENDAR TOOL", "ENABLED CALENDARS HELPER"],
    globals: {
      Services: { io: { offline } },
      cal: available ? { manager: { getCalendars: () => calendars } } : null,
    },
    expose: ["refreshCalendar"],
  });
  return { ...harness, refresh: harness.runtime.refreshCalendar };
}

describe("refreshCalendar production tool", () => {
  it("calls the calendar's own refresh and waits for onLoad", async () => {
    const calendar = makeCalendar({ type: "owl" });
    const { refresh, clock } = loadRefresh([calendar]);
    const pending = refresh(calendar.id, WAIT_MS);
    assert.equal(calendar.refreshCalls, 1);
    assert.equal(calendar.observers.size, 1);
    await clock.advance(LOAD_DELAY_MS);
    calendar.notify("onLoad", calendar);
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.status, "loaded");
    assert.equal(result.type, calendar.type);
    assert.equal(result.calendarId, calendar.id);
    assert.equal(result.elapsedMs, LOAD_DELAY_MS);
    assert.equal(calendar.observers.size, 0);
    assert.equal(calendar.removeObserverCalls, 1);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("observes legitimate synchronous completion inside a cached provider's refresh", async () => {
    const calendar = makeCalendar({ onRefresh: current => current.notify("onLoad", current) });
    const { refresh, clock } = loadRefresh([calendar]);
    const result = await refresh(calendar.id, WAIT_MS);
    assert.equal(result.success, true);
    assert.equal(result.status, "loaded");
    assert.equal(result.warning, undefined);
    assert.equal(calendar.observers.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("ignores load and error notifications for another calendar", async () => {
    const other = makeCalendar({ id: "calendar-b" });
    const calendar = makeCalendar({ onRefresh: current => {
      current.notify("onLoad", other);
      current.notify("onError", other, FAILURE_CODE, PROVIDER_ERROR);
    } });
    const { refresh, clock } = loadRefresh([calendar, other]);
    const pending = refresh(calendar.id, WAIT_MS);
    await clock.advance(WAIT_MS);
    const result = await pending;
    assert.equal(result.status, "timeout");
    assert.equal(result.success, false);
    assert.match(result.error, /completion.*not confirmed/i);
    assert.equal(result.warning, undefined);
    assert.equal(other.refreshCalls, 0);
  });

  it("keeps the latest provider error as a warning when completion follows", async () => {
    const calendar = makeCalendar({ onRefresh: current => {
      current.notify("onError", current, FAILURE_CODE, "Initial error");
      current.notify("onError", current, FAILURE_CODE, PROVIDER_ERROR);
    } });
    const { refresh, clock } = loadRefresh([calendar]);
    const pending = refresh(calendar.id, WAIT_MS);
    await clock.advance(LOAD_DELAY_MS);
    calendar.notify("onLoad", calendar);
    const result = await pending;
    assert.equal(result.status, "loaded");
    assert.equal(result.success, true);
    assert.equal(result.warning, PROVIDER_ERROR);
    assert.equal(result.error, undefined);
    assert.equal(calendar.observers.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("reports the provider error when no completion arrives before the caller deadline", async () => {
    const calendar = makeCalendar({ onRefresh: current => current.notify("onError", current, FAILURE_CODE, PROVIDER_ERROR) });
    const { refresh, clock } = loadRefresh([calendar]);
    const pending = refresh(calendar.id, WAIT_MS);
    await clock.advance(WAIT_MS);
    const result = await pending;
    assert.equal(result.status, "error");
    assert.equal(result.success, false);
    assert.equal(result.error, PROVIDER_ERROR);
    assert.equal(result.elapsedMs, WAIT_MS);
    assert.equal(calendar.observers.size, 1, "a caller timeout must preserve the active observer");
  });

  it("includes the native error code when a provider reports no message", async () => {
    const calendar = makeCalendar({ onRefresh: current => current.notify("onError", current, FAILURE_CODE, "") });
    const { refresh, clock } = loadRefresh([calendar]);
    const pending = refresh(calendar.id, WAIT_MS);
    await clock.advance(WAIT_MS);
    const result = await pending;
    assert.equal(result.status, "error");
    assert.match(result.error, /0x80004005/);
  });

  for (const rejects of [false, true]) {
    it(`cleans the observer when refresh ${rejects ? "rejects" : "throws"}`, async () => {
      const calendar = makeCalendar({ onRefresh: () => {
        if (rejects) return Promise.reject(new Error(PROVIDER_ERROR));
        throw new Error(PROVIDER_ERROR);
      } });
      const { refresh, clock } = loadRefresh([calendar]);
      const result = await refresh(calendar.id, WAIT_MS);
      assert.equal(result.status, "error");
      assert.equal(result.success, false);
      assert.equal(result.error, PROVIDER_ERROR);
      assert.equal(calendar.observers.size, 0);
      assert.equal(calendar.removeObserverCalls, 1);
      assert.equal(clock.activeTimers.length, 0);
    });
  }

  it("reports silent providers as unconfirmed and lets a fresh repeat join the existing refresh", async () => {
    const calendar = makeCalendar();
    const { refresh, clock } = loadRefresh([calendar]);
    const first = refresh(calendar.id, WAIT_MS);
    await clock.advance(WAIT_MS);
    const timedOut = await first;
    assert.equal(timedOut.status, "timeout");
    assert.equal(timedOut.success, false);
    assert.match(timedOut.error, /completion.*not confirmed/i);
    const second = refresh(calendar.id, LONG_WAIT_MS);
    await clock.advance(LOAD_DELAY_MS);
    calendar.notify("onLoad", calendar);
    const result = await second;
    assert.equal(result.status, "loaded");
    assert.equal(result.joinedInFlight, true);
    assert.equal(calendar.refreshCalls, 1);
    assert.equal(calendar.addObserverCalls, 1);
    assert.equal(calendar.removeObserverCalls, 1);
  });

  for (const all of [false, true]) {
    it(`refuses offline ${all ? "all-calendar" : "single-calendar"} refresh before adding an observer or calling a provider`, async () => {
      const calendar = makeCalendar();
      const { refresh, clock } = loadRefresh([calendar], { offline: true });
      const pending = refresh(all ? undefined : calendar.id, WAIT_MS);
      await clock.flush();
      assert.equal(calendar.refreshCalls, 0);
      assert.equal(calendar.addObserverCalls, 0);
      assert.equal(calendar.observers.size, 0);
      const result = await pending;
      assert.match(result.error, /offline/i);
      assert.equal(result.status, "error");
      assert.equal(result.success, false);
      assert.equal(clock.activeTimers.length, 0);
    });
  }

  it("refuses offline callers before joining an existing refresh, including all mode", async () => {
    const calendar = makeCalendar();
    const { refresh, runtime, clock } = loadRefresh([calendar]);
    const online = refresh(calendar.id, LONG_WAIT_MS);
    const originalTimers = clock.activeTimers.length;
    runtime.Services.io.offline = true;
    const single = refresh(calendar.id, WAIT_MS);
    const all = refresh(undefined, WAIT_MS);
    await clock.flush();
    assert.equal(clock.activeTimers.length, originalTimers, "offline calls must not start caller wait timers");
    for (const result of [await single, await all]) {
      assert.match(result.error, /offline/i);
      assert.equal(result.status, "error");
      assert.equal(result.success, false);
    }
    assert.equal(calendar.refreshCalls, 1);
    assert.equal(calendar.addObserverCalls, 1);
    calendar.notify("onLoad", calendar);
    assert.equal((await online).status, "loaded");
    assert.equal(calendar.observers.size, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("restarts stale work without renewing age on joins and ignores retired observers and rejections", async () => {
    const rejections = [];
    const calendar = makeCalendar({ onRefresh: () => new Promise((_resolve, reject) => rejections.push(reject)) });
    const { refresh, runtime, clock } = loadRefresh([calendar]);
    const first = refresh(calendar.id, WAIT_MS);
    const oldObserver = [...calendar.observers][0];
    await clock.advance(WAIT_MS);
    assert.equal((await first).status, "timeout");
    await clock.advance(runtime.REFRESH_MAX_TIMEOUT_MS - WAIT_MS - 1);
    const joined = refresh(calendar.id, LONG_WAIT_MS);
    await clock.advance(1);
    const replacement = refresh(calendar.id, LONG_WAIT_MS);
    const retired = await joined;
    assert.equal(retired.status, "timeout");
    assert.equal(retired.joinedInFlight, true);
    assert.equal(calendar.refreshCalls, 2);
    assert.equal(calendar.addObserverCalls, 2);
    assert.equal(calendar.removeObserverCalls, 1);
    assert.equal(calendar.observers.size, 1);
    assert.equal(calendar.observers.has(oldObserver), false);
    oldObserver.onLoad(calendar);
    oldObserver.onError(calendar, FAILURE_CODE, "Late observer error");
    rejections[0](new Error("Late refresh rejection"));
    await clock.flush();
    assert.equal(calendar.observers.size, 1, "old callbacks must not remove the replacement observer");
    calendar.notify("onLoad", calendar);
    const result = await replacement;
    assert.equal(result.status, "loaded");
    assert.equal(result.success, true);
    assert.equal(result.warning, undefined);
    assert.notEqual(result.joinedInFlight, true);
    assert.equal(calendar.removeObserverCalls, 2);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("removes a silent provider's observer at the abandonment cap", async () => {
    const calendar = makeCalendar();
    const { refresh, runtime, clock } = loadRefresh([calendar]);
    const pending = refresh(calendar.id, WAIT_MS);
    await clock.advance(WAIT_MS);
    assert.equal((await pending).status, "timeout");
    assert.equal(calendar.observers.size, 1);
    await clock.advance(runtime.REFRESH_ABANDON_MS - WAIT_MS);
    assert.equal(calendar.observers.size, 0);
    assert.equal(calendar.removeObserverCalls, 1);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("skips nonrefreshable calendars and rejects disabled or unknown calendars", async () => {
    const local = makeCalendar({ id: "home", type: "storage", canRefresh: false });
    const disabled = makeCalendar({ id: "disabled", disabled: true });
    const { refresh, clock } = loadRefresh([local, disabled]);
    const skipped = await refresh(local.id, WAIT_MS);
    assert.equal(skipped.success, true);
    assert.ok(skipped.skipped);
    assert.match((await refresh(disabled.id, WAIT_MS)).error, /disabled/i);
    assert.match((await refresh("unknown", WAIT_MS)).error, /not found/i);
    for (const calendar of [local, disabled]) {
      assert.equal(calendar.refreshCalls, 0);
      assert.equal(calendar.addObserverCalls, 0);
    }
    assert.equal(clock.activeTimers.length, 0);
  });

  it("without calendarId refreshes every enabled refreshable calendar", async () => {
    const owl = makeCalendar({ id: "owl", type: "owl", onRefresh: current => current.notify("onLoad", current) });
    const google = makeCalendar({ id: "google", type: "gdata", onRefresh: current => current.notify("onLoad", current) });
    const local = makeCalendar({ id: "home", type: "storage", canRefresh: false });
    const disabled = makeCalendar({ id: "disabled", disabled: true });
    const { refresh, clock } = loadRefresh([owl, google, local, disabled]);
    const result = await refresh(undefined, WAIT_MS);
    assert.equal(result.success, true);
    assert.equal(result.scope, "all");
    assert.deepEqual(Array.from(result.results, item => item.calendarId).sort(), [google.id, owl.id]);
    for (const calendar of [owl, google]) {
      assert.equal(calendar.refreshCalls, 1);
      assert.equal(calendar.observers.size, 0);
    }
    for (const calendar of [local, disabled]) {
      assert.equal(calendar.refreshCalls, 0);
      assert.equal(calendar.addObserverCalls, 0);
    }
    assert.equal(clock.activeTimers.length, 0);
  });

  it("returns mixed healthy, errored, and silent results after one concurrent wait", async () => {
    const healthy = makeCalendar({ id: "healthy", onRefresh: current => current.notify("onLoad", current) });
    const errored = makeCalendar({ id: "errored", onRefresh: current => current.notify("onError", current, FAILURE_CODE, PROVIDER_ERROR) });
    const silent = makeCalendar({ id: "silent" });
    const { refresh, clock } = loadRefresh([healthy, errored, silent]);
    const pending = refresh(undefined, WAIT_MS);
    for (const calendar of [healthy, errored, silent]) assert.equal(calendar.refreshCalls, 1);
    await clock.advance(WAIT_MS);
    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.scope, "all");
    assert.equal(clock.now, WAIT_MS);
    const results = new Map(Array.from(result.results, item => [item.calendarId, item]));
    assert.equal(results.get(healthy.id).status, "loaded");
    assert.equal(results.get(healthy.id).success, true);
    assert.equal(results.get(errored.id).status, "error");
    assert.equal(results.get(errored.id).error, PROVIDER_ERROR);
    assert.equal(results.get(silent.id).status, "timeout");
    assert.match(results.get(silent.id).error, /completion.*not confirmed/i);
    assert.equal(results.get(errored.id).elapsedMs, WAIT_MS);
    assert.equal(results.get(silent.id).elapsedMs, WAIT_MS);
  });

  it("preserves the enabled-calendar helper's all-disabled error", async () => {
    const calendar = makeCalendar({ disabled: true });
    const { refresh, clock } = loadRefresh([calendar]);
    assert.match((await refresh(undefined, WAIT_MS)).error, /all calendars are disabled/i);
    assert.equal(calendar.refreshCalls, 0);
    assert.equal(calendar.addObserverCalls, 0);
    assert.equal(clock.activeTimers.length, 0);
  });

  it("reports when there are no refreshable calendars or calendar support is unavailable", async () => {
    const local = makeCalendar({ type: "storage", canRefresh: false });
    for (const calendars of [[], [local]]) {
      const { refresh, clock } = loadRefresh(calendars);
      assert.match((await refresh(undefined, WAIT_MS)).error, /no enabled calendars.*refresh/i);
      assert.equal(clock.activeTimers.length, 0);
    }
    const { refresh } = loadRefresh([], { available: false });
    assert.match((await refresh(undefined, WAIT_MS)).error, /calendar not available/i);
    assert.equal(local.refreshCalls, 0);
  });
});
