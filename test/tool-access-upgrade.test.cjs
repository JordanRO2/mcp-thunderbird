"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadPrivacyRuntime } = require("./helpers/privacy-access.cjs");

const reference = loadPrivacyRuntime();
const { prefNames } = reference;
const currentState = JSON.parse(reference.values.get(prefNames.PREF_TOOL_ACCESS_STATE));
const introduced = Object.keys(reference.policy.introducedIn);
const required = ["getAccountAccess", "listAccounts", "listFolders"];

// Searched setToolAccess tests: no shared save helper. Exercise the real
// snapshot API, rather than mirroring preference or access calculations.
async function saveSelection(runtime, disabled, limit = 10) {
  const { revision } = await runtime.options.getToolAccessConfig();
  return runtime.options.setToolAccess(disabled, limit, revision);
}

// Existing dependency tests transform the production registry; do the same
// for a future catalog entry and execute the actual buildTools() in the VM.
function addedTool(name, release) {
  return {
    policyTransform: source => source.replace("const introducedIn = Object.freeze({",
      `const introducedIn = Object.freeze({ ${name}: ${JSON.stringify(release)},`),
    schemaTransform: source => source.replace("return definitions;",
      `definitions.push({ name: ${JSON.stringify(name)}, group: "system", crud: "read",
        description: "Future fixture", inputSchema: { type: "object", properties: {} } }); return definitions;`),
  };
}

describe("production tool introduction registry", () => {
  it("covers every production tool and keeps the permanent legacy inventory separate", () => {
    const names = reference.buildTools().map(tool => tool.name);
    assert.equal(reference.policy.legacyTools.length, 40);
    assert.equal(new Set(reference.policy.legacyTools).size, 40);
    for (const name of names) {
      assert.ok(reference.policy.legacyTools.includes(name) || Object.hasOwn(reference.policy.introducedIn, name), name);
    }
    for (const [name, release] of Object.entries(reference.policy.introducedIn)) {
      assert.ok(!reference.policy.legacyTools.includes(name), name);
      assert.ok(names.includes(name), name);
      assert.ok(reference.policy.compareReleases(release, "0.9.3") > 0);
      assert.ok(!required.includes(name));
    }
    assert.doesNotThrow(() => reference.policy.considerTools([], null, names));
  });

  it("refuses an unregistered future tool instead of silently calling it legacy", async () => {
    const runtime = loadPrivacyRuntime({ legacy: true, schemaTransform: addedTool("futureTool", "0.11.0").schemaTransform });
    assert.throws(() => runtime.policy.considerTools([], null, runtime.tools.map(tool => tool.name)), /Missing introduction release/);
    assert.equal((await runtime.options.getToolAccessConfig()).mode, "error");
    assert.deepEqual((await runtime.http("tools/list")).result.tools.map(tool => tool.name).sort(), required);
    assert.equal(runtime.writes.length, 0);
  });

  it("compares complete releases numerically", () => {
    for (const [lower, higher] of [["0.9.10", "0.10.0"], ["0.10.2", "0.10.10"], ["0.99.0", "1.0.0"]]) {
      assert.equal(reference.policy.compareReleases(lower, higher), -1);
      assert.equal(reference.policy.compareReleases(higher, lower), 1);
      assert.equal(reference.policy.compareReleases(higher, higher), 0);
    }
  });
});

describe("production Tool Access upgrade migration", () => {
  it("adds own denials before committing history, and enforces them on the first list and call", async () => {
    const runtime = loadPrivacyRuntime({ legacy: true, initial: { PREF_DISABLED_TOOLS: '["sendMail","retiredTool"]' } });
    const disabled = JSON.parse(runtime.values.get(prefNames.PREF_DISABLED_TOOLS));
    assert.deepEqual(disabled, ["sendMail", "retiredTool", ...runtime.tools.map(tool => tool.name).filter(name => introduced.includes(name))]);
    assert.deepEqual(runtime.writes.map(write => write.name), [prefNames.PREF_DISABLED_TOOLS, prefNames.PREF_TOOL_ACCESS_STATE]);
    const state = JSON.parse(runtime.values.get(prefNames.PREF_TOOL_ACCESS_STATE));
    assert.equal(state.customized, true);
    assert.equal(state.consideredRelease, "0.10.0");
    const listed = (await runtime.http("tools/list")).result.tools;
    const options = await runtime.options.getToolAccessConfig();
    for (const name of introduced) {
      assert.ok(!listed.some(tool => tool.name === name));
      assert.equal(options.tools.find(tool => tool.name === name).configuredEnabled, false);
      const call = await runtime.http("tools/call", { name, arguments: {} });
      assert.match(call.error.message, /Tool is disabled/);
    }
    assert.equal(runtime.calls.length, 0, "denials run before validation or handlers");
    assert.ok(required.every(name => listed.some(tool => tool.name === name)));
    assert.ok(listed.every(tool => Object.keys(tool).sort().join(",") === "description,inputSchema,name"));
  });

  for (const raw of [undefined, "", "[]"]) {
    it(`records fresh/untouched ${String(raw)} without changing its access preference`, async () => {
      const runtime = loadPrivacyRuntime({ legacy: true, initial: raw === undefined ? {} : { PREF_DISABLED_TOOLS: raw } });
      assert.equal((await runtime.options.getToolAccessConfig()).mode, "all");
      assert.equal((await runtime.http("tools/list")).result.tools.length, runtime.tools.length);
      assert.equal(runtime.values.get(prefNames.PREF_DISABLED_TOOLS), raw);
      assert.deepEqual(runtime.writes.map(write => write.name), [prefNames.PREF_TOOL_ACCESS_STATE]);
      assert.equal(JSON.parse(runtime.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).customized, false);
    });
  }

  it("treats a legacy cleared preference as untouched; no lost history can be inferred", async () => {
    const values = new Map([[prefNames.PREF_DISABLED_TOOLS, '["sendMail"]']]);
    values.delete(prefNames.PREF_DISABLED_TOOLS); // 0.9.x's enable-all behavior.
    const runtime = loadPrivacyRuntime({ legacy: true, values });
    assert.equal((await runtime.options.getToolAccessConfig()).mode, "all");
    assert.equal(JSON.parse(values.get(prefNames.PREF_TOOL_ACCESS_STATE)).customized, false);
  });

  it("never applies upgrade defaults retroactively, and remembers customization after enable-all", async () => {
    const runtime = loadPrivacyRuntime({ legacy: true });
    assert.equal((await saveSelection(runtime, ["sendMail"])).success, true);
    assert.deepEqual(JSON.parse(runtime.values.get(prefNames.PREF_DISABLED_TOOLS)), ["sendMail"]);
    assert.equal((await saveSelection(runtime, [])).success, true);
    assert.equal(runtime.values.has(prefNames.PREF_DISABLED_TOOLS), false);
    const next = loadPrivacyRuntime({ legacy: true, values: runtime.values, ...addedTool("futureTool", "0.11.0") });
    assert.deepEqual(JSON.parse(next.values.get(prefNames.PREF_DISABLED_TOOLS)), ["futureTool"]);
    assert.equal(JSON.parse(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).consideredRelease, "0.11.0");
    assert.equal(next.isToolEnabled("dryRunCompose"), true);
  });

  it("keeps untouched users unrestricted through later releases", () => {
    const first = loadPrivacyRuntime({ legacy: true });
    const next = loadPrivacyRuntime({ legacy: true, values: first.values, ...addedTool("futureTool", "0.11.0") });
    assert.equal(next.isToolEnabled("futureTool"), true);
    assert.equal(next.values.has(prefNames.PREF_DISABLED_TOOLS), false);
    assert.equal(JSON.parse(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).customized, false);
  });

  for (const release of ["0.10.0", "0.12.0"]) {
    it(`detects an unseen tool in ${release}, including same-release and skipped-release upgrades`, () => {
      const first = loadPrivacyRuntime({ legacy: true, initial: { PREF_DISABLED_TOOLS: '["getMessage"]' } });
      const before = JSON.parse(first.values.get(prefNames.PREF_DISABLED_TOOLS));
      const next = loadPrivacyRuntime({ legacy: true, values: first.values, ...addedTool("futureTool", release) });
      assert.deepEqual(JSON.parse(next.values.get(prefNames.PREF_DISABLED_TOOLS)), [...before, "futureTool"]);
      assert.equal(JSON.parse(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).consideredRelease, release);
    });
  }

  it("does not consider registered tools that are absent from the shipped catalog", () => {
    const future = addedTool("futureTool", "0.11.0");
    const first = loadPrivacyRuntime({ legacy: true, initial: { PREF_DISABLED_TOOLS: '["getMessage"]' }, policyTransform: future.policyTransform });
    const state = JSON.parse(first.values.get(prefNames.PREF_TOOL_ACCESS_STATE));
    assert.equal(state.consideredRelease, "0.10.0");
    assert.ok(!state.consideredTools.includes("futureTool"));
    const next = loadPrivacyRuntime({ legacy: true, values: first.values, ...future });
    assert.equal(next.isToolEnabled("futureTool"), false);
  });

  it("preserves explicit enables and makes no migration writes across VM restarts", async () => {
    let runtime = loadPrivacyRuntime({ legacy: true, initial: { PREF_DISABLED_TOOLS: '["getMessage"]' } });
    const disabled = JSON.parse(runtime.values.get(prefNames.PREF_DISABLED_TOOLS)).filter(name => name !== "dryRunCompose");
    assert.equal((await saveSelection(runtime, disabled)).success, true);
    for (let restart = 0; restart < 3; restart++) {
      runtime = loadPrivacyRuntime({ legacy: true, values: runtime.values });
      assert.equal(runtime.isToolEnabled("dryRunCompose"), true);
      const call = await runtime.http("tools/call", { name: "dryRunCompose", arguments: { to: "x", subject: "s", body: "b" } });
      assert.equal(JSON.parse(call.result.content[0].text).handled, "dryRunCompose");
      assert.equal(runtime.writes.length, 0);
    }
  });

  for (const enabled of [false, true]) {
    it(`preserves future history and choices through a migration-aware downgrade, enabled=${enabled}`, async () => {
      const future = addedTool("futureTool", "0.11.0");
      const first = loadPrivacyRuntime({ legacy: true, initial: { PREF_DISABLED_TOOLS: '["getMessage"]' }, ...future });
      if (enabled) assert.equal((await saveSelection(first, [])).success, true);
      const older = loadPrivacyRuntime({ legacy: true, values: first.values });
      assert.equal(older.writes.length, 0);
      assert.equal((await saveSelection(older, [])).success, true);
      const again = loadPrivacyRuntime({ legacy: true, values: older.values, ...future });
      assert.equal(again.isToolEnabled("futureTool"), enabled);
      assert.equal(JSON.parse(again.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).consideredRelease, "0.11.0");
      assert.equal(again.writes.length, 0);
    });
  }
});

describe("Tool Access migration with managed preferences", () => {
  for (const exposeLocks of [true, false]) {
    it(`blocks only unseen tools while the effective deny-list cannot change, lock API=${exposeLocks}`, async () => {
      const defaults = new Map([[prefNames.PREF_DISABLED_TOOLS, '["getMessage","sendMail","retiredTool"]']]);
      const locked = new Set([prefNames.PREF_DISABLED_TOOLS]);
      let runtime = loadPrivacyRuntime({ legacy: true, defaults, locked, exposeLocks });
      for (let restart = 0; restart < 2; restart++) {
        // Exercise the first HTTP list/call before Options has read anything.
        const listed = (await runtime.http("tools/list")).result.tools.map(tool => tool.name);
        const config = await runtime.options.getToolAccessConfig();
        assert.equal(config.mode, "restricted");
        assert.equal(config.error, undefined);
        for (const tool of runtime.tools) {
          const enabled = !["getMessage", "sendMail", ...introduced].includes(tool.name);
          assert.equal(listed.includes(tool.name), enabled, tool.name);
          assert.equal(config.tools.find(option => option.name === tool.name).enabled, enabled, tool.name);
        }
        for (const name of introduced) {
          assert.match((await runtime.http("tools/call", { name, arguments: {} })).error.message, /Tool is disabled/);
        }
        assert.match(config.note, /managed by policy.*new tools stay disabled/i);
        assert.equal(runtime.calls.length, 0);
        const call = await runtime.http("tools/call", { name: "getMessages", arguments: {
          messages: [{ messageId: "fixture", folderPath: "imap://fixture/Inbox" }],
        } });
        assert.equal(JSON.parse(call.result.content[0].text).handled, "getMessages");
        assert.equal(runtime.values.has(prefNames.PREF_TOOL_ACCESS_STATE), false);
        assert.ok(runtime.writes.every(write => write.name === prefNames.PREF_DISABLED_TOOLS));
        if (exposeLocks) assert.equal(runtime.writes.length, 0);
        else assert.ok(JSON.parse(runtime.values.get(prefNames.PREF_DISABLED_TOOLS)).includes("refreshFolder"));
        assert.equal(runtime.Services.prefs.getStringPref(prefNames.PREF_DISABLED_TOOLS), defaults.get(prefNames.PREF_DISABLED_TOOLS));
        // An explicit enable cannot bypass the blocked migration through Options.
        assert.match((await runtime.options.setToolAccess([], 10, config.revision)).error, /managed by policy/i);
        assert.equal(runtime.values.has(prefNames.PREF_TOOL_ACCESS_STATE), false);
        runtime = loadPrivacyRuntime({ legacy: true, values: runtime.values, defaults, locked, exposeLocks });
      }
      locked.delete(prefNames.PREF_DISABLED_TOOLS);
      const unlocked = await runtime.options.getToolAccessConfig();
      assert.equal(unlocked.note, undefined);
      const tracking = JSON.parse(runtime.values.get(prefNames.PREF_TOOL_ACCESS_STATE));
      assert.equal(tracking.customized, true);
      assert.equal(tracking.consideredRelease, "0.10.0");
      for (const name of introduced) {
        assert.ok(tracking.consideredTools.includes(name));
        assert.ok(JSON.parse(runtime.values.get(prefNames.PREF_DISABLED_TOOLS)).includes(name));
      }
      assert.equal((await saveSelection(runtime, unlocked.disabledTools.filter(name => name !== "refreshFolder"))).success, true);
      const reloaded = loadPrivacyRuntime({ legacy: true, values: runtime.values, defaults, locked, exposeLocks });
      assert.equal(reloaded.isToolEnabled("refreshFolder"), true);
      assert.equal(reloaded.writes.length, 0);
    });

    it(`keeps untouched profiles with a locked empty list enabled, lock API=${exposeLocks}`, async () => {
      const runtime = loadPrivacyRuntime({ legacy: true, exposeLocks,
        defaults: new Map([[prefNames.PREF_DISABLED_TOOLS, "[]"]]),
        locked: new Set([prefNames.PREF_DISABLED_TOOLS]),
      });
      const config = await runtime.options.getToolAccessConfig();
      assert.equal(config.mode, "all");
      assert.ok(config.tools.every(tool => tool.enabled));
      assert.equal((await runtime.http("tools/list")).result.tools.length, runtime.tools.length);
      assert.equal(runtime.values.has(prefNames.PREF_DISABLED_TOOLS), false);
      assert.deepEqual(runtime.writes.map(write => write.name), [prefNames.PREF_TOOL_ACCESS_STATE]);
      assert.equal(JSON.parse(runtime.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).customized, false);
      assert.doesNotMatch(config.note || "", /new tools stay disabled/i);
    });

    it(`cannot advance corrupt tracking through an ineffective repair save, lock API=${exposeLocks}`, async () => {
      const runtime = loadPrivacyRuntime({ legacy: true, exposeLocks,
        initial: { PREF_TOOL_ACCESS_STATE: "{" },
        defaults: new Map([[prefNames.PREF_DISABLED_TOOLS, '["getMessage"]']]),
        locked: new Set([prefNames.PREF_DISABLED_TOOLS]),
      });
      const disabled = runtime.tools.map(tool => tool.name).filter(name => ![...required, "getMessages"].includes(name));
      assert.ok((await saveSelection(runtime, disabled)).error);
      assert.equal(runtime.values.get(prefNames.PREF_TOOL_ACCESS_STATE), "{");
      assert.ok(runtime.writes.every(write => write.name !== prefNames.PREF_TOOL_ACCESS_STATE));
      const config = await runtime.options.getToolAccessConfig();
      assert.equal(config.mode, "error");
      assert.ok(config.tools.every(tool => tool.enabled === tool.undisableable));
      for (const name of introduced) assert.equal(runtime.isToolEnabled(name), false, name);
    });
  }

  it("does not assume a write took effect just because prefIsLocked returned false", async () => {
    const runtime = loadPrivacyRuntime({ legacy: true, initialize: false,
      defaults: new Map([[prefNames.PREF_DISABLED_TOOLS, '["getMessage"]']]),
      locked: new Set([prefNames.PREF_DISABLED_TOOLS]),
    });
    runtime.Services.prefs.prefIsLocked = () => false;
    const config = await runtime.options.getToolAccessConfig();
    assert.match(config.note, /managed by policy/i);
    assert.equal(runtime.isToolEnabled("refreshFolder"), false);
    assert.equal(runtime.isToolEnabled("getMessages"), true);
    assert.equal(runtime.values.has(prefNames.PREF_TOOL_ACCESS_STATE), false);
  });

  it("keeps already-considered tools enabled while a later release waits for an unlock", async () => {
    const first = loadPrivacyRuntime({ legacy: true, initial: { PREF_DISABLED_TOOLS: '["getMessage"]' } });
    assert.equal((await saveSelection(first, ["getMessage"])).success, true);
    const previous = first.values.get(prefNames.PREF_TOOL_ACCESS_STATE);
    const next = loadPrivacyRuntime({ legacy: true, values: first.values,
      defaults: new Map([[prefNames.PREF_DISABLED_TOOLS, '["getMessage"]']]),
      locked: new Set([prefNames.PREF_DISABLED_TOOLS]), ...addedTool("futureTool", "0.11.0"),
    });
    assert.equal(next.isToolEnabled("futureTool"), false);
    for (const name of introduced) assert.equal(next.isToolEnabled(name), true, name);
    assert.equal(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE), previous);
    next.locked.clear();
    assert.equal(next.isToolEnabled("futureTool"), false);
    assert.equal(JSON.parse(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).consideredRelease, "0.11.0");
  });

  it("invalidates Options revisions when only the lock status changes", async () => {
    const runtime = loadPrivacyRuntime({ initial: { PREF_DISABLED_TOOLS: '["getMessage"]' },
      defaults: new Map([[prefNames.PREF_DISABLED_TOOLS, '["getMessage"]']]),
    });
    const unlocked = await runtime.options.getToolAccessConfig();
    runtime.locked.add(prefNames.PREF_DISABLED_TOOLS);
    assert.match((await runtime.options.setToolAccess([], 10, unlocked.revision)).error, /Reload/);
    const locked = await runtime.options.getToolAccessConfig();
    assert.match((await runtime.options.setToolAccess([], 10, locked.revision)).error, /managed by policy/i);
    runtime.locked.clear();
    assert.match((await runtime.options.setToolAccess([], 10, locked.revision)).error, /Reload/);
    assert.equal(runtime.writes.length, 0);
  });

  it("can consider new tools when all their denials are already effective in a locked list", async () => {
    const denied = ["getMessage", "getMessage", ...introduced];
    const runtime = loadPrivacyRuntime({ legacy: true,
      defaults: new Map([[prefNames.PREF_DISABLED_TOOLS, JSON.stringify(denied)]]),
      locked: new Set([prefNames.PREF_DISABLED_TOOLS]),
    });
    const config = await runtime.options.getToolAccessConfig();
    assert.doesNotMatch(config.note, /new tools stay disabled/i);
    assert.ok(introduced.every(name => config.disabledTools.includes(name)));
    assert.deepEqual(runtime.writes.map(write => write.name), [prefNames.PREF_TOOL_ACCESS_STATE]);
    assert.ok(introduced.every(name => JSON.parse(runtime.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).consideredTools.includes(name)));
  });

  it("uses the latest effective legacy denials when read-back differs from the original list", async () => {
    const defaults = new Map([[prefNames.PREF_DISABLED_TOOLS, '["getMessage"]']]);
    const runtime = loadPrivacyRuntime({ legacy: true, defaults, exposeLocks: false,
      locked: new Set([prefNames.PREF_DISABLED_TOOLS]),
      beforeWrite() { defaults.set(prefNames.PREF_DISABLED_TOOLS, '["deleteMessages"]'); },
    });
    const config = await runtime.options.getToolAccessConfig();
    assert.equal(config.tools.find(tool => tool.name === "getMessage").enabled, true);
    assert.equal(config.tools.find(tool => tool.name === "deleteMessages").enabled, false);
    for (const name of introduced) assert.equal(runtime.isToolEnabled(name), false, name);
    assert.equal(runtime.values.has(prefNames.PREF_TOOL_ACCESS_STATE), false);
  });

  it("keeps corrupt read-back fully fail-closed instead of treating it as managed access", async () => {
    const runtime = loadPrivacyRuntime({ legacy: true, initialize: false,
      initial: { PREF_DISABLED_TOOLS: '["getMessage"]' },
      beforeWrite() { runtime.readErrors.add(prefNames.PREF_DISABLED_TOOLS); },
    });
    const config = await runtime.options.getToolAccessConfig();
    assert.equal(config.mode, "error");
    assert.equal(config.note, undefined);
    assert.ok(config.tools.every(tool => tool.enabled === tool.undisableable));
    assert.equal(runtime.values.has(prefNames.PREF_TOOL_ACCESS_STATE), false);
  });
});

describe("Tool Access corruption, failures and revisions", () => {
  const invalidStates = [
    "", "{", "null", "[]", "true", 1, true,
    JSON.stringify({ ...currentState, version: 2 }),
    JSON.stringify({ ...currentState, customized: "true" }),
    JSON.stringify({ ...currentState, extra: true }),
    JSON.stringify({ ...currentState, consideredTools: undefined }),
    ...[null, "0.10", "v0.10.0", "0.10.0-rc1", "00.10.0", "0.9.3", "0.9007199254740992.0"]
      .map(consideredRelease => JSON.stringify({ ...currentState, consideredRelease })),
    ...[[], ["sendMail"], [...currentState.consideredTools, 1], [...currentState.consideredTools, "__all__"],
      [...currentState.consideredTools, "sendMail"]].map(consideredTools => JSON.stringify({ ...currentState, consideredTools })),
  ];
  for (const [index, raw] of invalidStates.entries()) {
    it(`leaves invalid tracking state ${index} untouched and blocks optional tools`, async () => {
      const runtime = loadPrivacyRuntime({ legacy: true, initial: {
        PREF_DISABLED_TOOLS: '["getMessage"]', PREF_TOOL_ACCESS_STATE: raw,
      } });
      const config = await runtime.options.getToolAccessConfig();
      assert.equal(config.mode, "error");
      assert.ok(config.tools.every(tool => tool.enabled === tool.undisableable));
      assert.deepEqual((await runtime.http("tools/list")).result.tools.map(tool => tool.name).sort(), required);
      assert.match((await runtime.http("tools/call", { name: "dryRunCompose", arguments: {} })).error.message, /Tool is disabled/);
      assert.equal(runtime.writes.length, 0);
      assert.equal(runtime.values.get(prefNames.PREF_TOOL_ACCESS_STATE), raw);
    });
  }

  for (const name of ["PREF_DISABLED_TOOLS", "PREF_TOOL_ACCESS_STATE"]) {
    it(`does not migrate or repair unreadable ${name}`, async () => {
      const runtime = loadPrivacyRuntime({ legacy: true, unreadable: [name] });
      assert.equal((await runtime.options.getToolAccessConfig()).mode, "error");
      assert.equal(runtime.isToolEnabled("getMessage"), false);
      assert.equal(runtime.isToolEnabled("listAccounts"), true);
      assert.equal(runtime.writes.length, 0);
    });
  }

  for (const name of ["PREF_DISABLED_TOOLS", "PREF_TOOL_ACCESS_STATE"]) {
    it(`fails closed on a migration write failure at ${name} and safely retries after restart`, async () => {
      const writeErrors = new Set([prefNames[name]]);
      const first = loadPrivacyRuntime({ legacy: true, writeErrors, initial: { PREF_DISABLED_TOOLS: '["getMessage"]' } });
      assert.equal((await first.options.getToolAccessConfig()).mode, "error");
      assert.equal(first.isToolEnabled("sendMail"), false);
      assert.equal(first.values.has(prefNames.PREF_TOOL_ACCESS_STATE), false);
      const next = loadPrivacyRuntime({ legacy: true, values: first.values });
      for (const tool of introduced) assert.equal(next.isToolEnabled(tool), false);
      assert.equal(JSON.parse(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).customized, true);
      assert.equal(next.values.get(prefNames.PREF_DISABLED_TOOLS).includes("getMessage"), true);
    });
  }

  for (const failAt of [1, 2, 3]) {
    it(`an interrupted explicit enable-all repair stays blocked at write ${failAt}, including after restart`, async () => {
      let writes = 0;
      const first = loadPrivacyRuntime({ legacy: true, initial: { PREF_TOOL_ACCESS_STATE: "{" }, beforeWrite() {
        if (++writes === failAt) throw new Error("Interrupted repair");
      } });
      assert.ok((await saveSelection(first, [])).error);
      const next = loadPrivacyRuntime({ legacy: true, values: first.values });
      assert.equal((await next.options.getToolAccessConfig()).mode, "error");
      assert.equal(next.isToolEnabled("getMessage"), false);
      assert.equal((await saveSelection(next, [])).success, true);
      assert.equal(next.isToolEnabled("getMessage"), true);
      assert.equal(JSON.parse(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).customized, true);
    });
  }

  it("retains first-time customization after a save's tracking write fails", async () => {
    const first = loadPrivacyRuntime({ legacy: true });
    first.writeErrors.add(prefNames.PREF_TOOL_ACCESS_STATE);
    assert.ok((await saveSelection(first, ["getMessage"])).error);
    assert.equal(first.isToolEnabled("sendMail"), false);
    const next = loadPrivacyRuntime({ legacy: true, values: first.values });
    assert.equal(JSON.parse(next.values.get(prefNames.PREF_TOOL_ACCESS_STATE)).customized, true);
    assert.equal((await saveSelection(next, [])).success, true);
    const future = loadPrivacyRuntime({ legacy: true, values: next.values, ...addedTool("futureTool", "0.11.0") });
    assert.equal(future.isToolEnabled("futureTool"), false);
  });

  for (const failAt of [2, 3]) {
    it(`retains absent-catalog denials when repair fails at write ${failAt}`, async () => {
      let writes = 0;
      const first = loadPrivacyRuntime({ legacy: true, initial: {
        PREF_DISABLED_TOOLS: '["futureTool"]', PREF_TOOL_ACCESS_STATE: "{",
      }, beforeWrite() {
        if (++writes === failAt) throw new Error("Interrupted repair");
      } });
      assert.ok((await saveSelection(first, [])).error);
      assert.deepEqual(JSON.parse(first.values.get(prefNames.PREF_DISABLED_TOOLS)), ["__all__", "futureTool"]);
      const next = loadPrivacyRuntime({ legacy: true, values: first.values });
      assert.equal((await saveSelection(next, [])).success, true);
      assert.deepEqual(JSON.parse(next.values.get(prefNames.PREF_DISABLED_TOOLS)), ["futureTool"]);
      const future = loadPrivacyRuntime({ legacy: true, values: next.values, ...addedTool("futureTool", "0.11.0") });
      assert.equal(future.isToolEnabled("futureTool"), false);
    });
  }

  it("requires an access edit to repair corruption, not an unchanged or limit-only save", async () => {
    const runtime = loadPrivacyRuntime({ legacy: true, initial: { PREF_TOOL_ACCESS_STATE: "{" } });
    const config = await runtime.options.getToolAccessConfig();
    const disabled = config.tools.filter(tool => !tool.undisableable).map(tool => tool.name);
    assert.ok((await runtime.options.setToolAccess(disabled, 7, config.revision)).error);
    assert.equal(runtime.writes.length, 0);
  });

  for (const key of ["PREF_DISABLED_TOOLS", "PREF_TOOL_ACCESS_STATE"]) {
    for (const pair of [["{", "["], [true, false], [1, 2]]) {
      it(`rejects a stale repair when raw ${key} changes from ${JSON.stringify(pair[0])} to ${JSON.stringify(pair[1])}`, async () => {
        const runtime = loadPrivacyRuntime({ legacy: true, initial: { [key]: pair[0] } });
        const { revision } = await runtime.options.getToolAccessConfig();
        runtime.values.set(prefNames[key], pair[1]);
        assert.match((await runtime.options.setToolAccess([], 10, revision)).error, /Reload/);
        assert.equal(runtime.writes.length, 0);
        assert.equal(runtime.values.get(prefNames[key]), pair[1]);
      });
    }
  }

  it("rejects missing tokens and tokens issued before a VM reload", async () => {
    const first = loadPrivacyRuntime();
    const { revision } = await first.options.getToolAccessConfig();
    const next = loadPrivacyRuntime({ legacy: true, values: first.values });
    assert.match((await next.options.setToolAccess([], 10)).error, /Reload/);
    assert.match((await next.options.setToolAccess([], 10, revision)).error, /Reload/);
    assert.equal(next.writes.length, 0);
  });
});
