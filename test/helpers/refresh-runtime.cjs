"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TIMER_CONTRACT = "@mozilla.org/timer;1";
const SHARED_BLOCK = "BOUNDED REFRESH HELPERS";
const SHARED_EXPORTS = [
  "waitForRefresh", "clampRefreshTimeout", "REFRESH_DEFAULT_TIMEOUT_MS",
  "REFRESH_MIN_TIMEOUT_MS", "REFRESH_MAX_TIMEOUT_MS", "REFRESH_ABANDON_MS",
];

// The calendar/folder loaders supply the production-marker pattern; the search
// scan tests supply a controllable Date and nsITimer. Refresh tests additionally
// need independent deadlines and a separate main-thread queue for URL ordering.
function loadRefreshRuntime({ blocks = [], globals = {}, expose = [] } = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");
  const timers = [];
  const mainThread = [];
  let now = 0;

  class RefreshDate extends Date {
    static now() { return now; }
  }

  function makeTimer() {
    const timer = {
      active: false,
      canceled: false,
      initWithCallback(callback, delay) {
        assert.ok(Number.isFinite(delay) && delay >= 0, "timer delay must be finite and nonnegative");
        this.callback = callback;
        this.delay = delay;
        this.due = now + delay;
        this.active = true;
        this.canceled = false;
      },
      cancel() { this.active = false; this.canceled = true; },
      fire() {
        if (!this.active) return;
        this.active = false;
        if (typeof this.callback === "function") this.callback(this);
        else this.callback.notify(this);
      },
    };
    timers.push(timer);
    return timer;
  }

  const clock = {
    get now() { return now; },
    get activeTimers() { return timers.filter(timer => timer.active); },
    mainThread,
    elapse(milliseconds) {
      assert.ok(Number.isFinite(milliseconds) && milliseconds >= 0, "clock must move forwards");
      now += milliseconds;
    },
    schedule(delay, callback) {
      const timer = makeTimer();
      timer.initWithCallback(callback, delay);
      return timer;
    },
    async flush() {
      // A host event-loop turn drains Promise reactions from both VM and host
      // realms without introducing wall-clock waits into deadline assertions.
      await new Promise(setImmediate);
      while (mainThread.length) {
        const callback = mainThread.shift();
        if (typeof callback === "function") callback();
        else callback.run();
        await new Promise(setImmediate);
      }
    },
    async advance(milliseconds) {
      assert.ok(Number.isFinite(milliseconds) && milliseconds >= 0, "clock must move forwards");
      const target = now + milliseconds;
      await this.flush();
      for (;;) {
        const next = this.activeTimers.filter(timer => timer.due <= target)
          .sort((left, right) => left.due - right.due)[0];
        if (!next) break;
        now = Math.max(now, next.due);
        next.fire();
        await this.flush();
      }
      now = Math.max(now, target);
      await this.flush();
    },
  };

  const runtime = vm.createContext({
    Date: RefreshDate,
    ChromeUtils: { generateQI: () => function () { return this; } },
    Components: { isSuccessCode: code => code === 0 },
    ...globals,
    Cc: { [TIMER_CONTRACT]: { createInstance: makeTimer }, ...globals.Cc },
    Ci: { nsITimer: { TYPE_ONE_SHOT: 0 }, ...globals.Ci },
    Services: {
      ...globals.Services,
      io: { offline: false, ...globals.Services?.io },
      tm: { dispatchToMainThread: callback => mainThread.push(callback), ...globals.Services?.tm },
    },
  });
  const snippets = [SHARED_BLOCK, ...blocks].map(name => {
    const startMarker = `// BEGIN ${name}`;
    const endMarker = `// END ${name}`;
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `api.js marker missing: ${startMarker}`);
    assert.ok(end > start, `api.js marker missing: ${endMarker}`);
    return source.slice(start, end);
  });
  vm.runInContext([
    ...snippets,
    `Object.assign(this, { ${[...SHARED_EXPORTS, ...expose].join(", ")} });`,
  ].join("\n"), runtime, { filename: "api.js refresh snippets" });
  return { runtime, clock, timers };
}

module.exports = { loadRefreshRuntime };
