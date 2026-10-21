"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const PREF = "extensions.thunderbird-mcp.allowContactWrites";

// Same marker assertions and VM loading pattern as filter-search-terms.test.cjs.
function snippet(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `api.js marker missing: ${startMarker}`);
  assert.ok(end > start, `api.js marker missing: ${endMarker}`);
  return source.slice(start, end);
}

function makeCard(fields = {}) {
  const stored = new Map();
  return {
    UID: "uid-1",
    supportsVCard: false,
    displayName: "",
    primaryEmail: "",
    firstName: "",
    lastName: "",
    isMailList: false,
    getProperty: (name, fallback = "") => stored.has(name) ? stored.get(name) : fallback,
    setProperty: (name, value) => stored.set(name, value),
    ...fields,
  };
}

// Only Thunderbird objects and the preference service are stubbed; the gate,
// validation and handlers come from api.js.
function loadContactTools({ prefs = {}, unreadable = false, cards } = {}) {
  const stored = new Map(Object.entries(prefs));
  const writes = [];
  const mutations = [];
  const book = {
    dirName: "Personal",
    readOnly: false,
    childCards: cards || [makeCard({ UID: "boss", displayName: "Boss", primaryEmail: "boss@example.com" })],
    addCard(card) { mutations.push(["addCard", card]); card.UID = "new-uid"; return card; },
    modifyCard(card) { mutations.push(["modifyCard", card]); },
    deleteCards(list) { mutations.push(["deleteCards", list]); },
  };
  const touched = { directories: 0, instances: 0 };
  const sandbox = {
    Services: { prefs: {
      getBoolPref(name, fallback) {
        if (unreadable) throw new Error("preference unavailable");
        return stored.has(name) ? stored.get(name) : fallback;
      },
      setBoolPref(name, value) { stored.set(name, value); writes.push([name, value]); },
    } },
    MailServices: { ab: { get directories() { touched.directories++; return [book]; } } },
    Cc: { "@mozilla.org/addressbook/cardproperty;1": { createInstance() { touched.instances++; return makeCard(); } } },
    Ci: { nsIAbCard: {} },
    VCardPropertyEntry: class {},
  };
  vm.createContext(sandbox);
  vm.runInContext([
    source.match(/^const PREF_ALLOW_CONTACT_WRITES = .+;$/m)[0],
    snippet("// BEGIN CONTACT FIELD HELPERS", "// END CONTACT FIELD HELPERS"),
    snippet("// BEGIN PRIVACY PREFERENCE HELPERS", "// END PRIVACY PREFERENCE HELPERS"),
    snippet("// BEGIN CONTACT TOOL HANDLERS", "// END CONTACT TOOL HANDLERS"),
    "this.handlers = { createContact, updateContact, deleteContact, getContact };",
    "this.preferenceAPI = {",
    snippet("// BEGIN CONTACT WRITE PREFERENCE METHODS", "// END CONTACT WRITE PREFERENCE METHODS"),
    "};",
  ].join("\n"), sandbox);
  return { ...sandbox.handlers, api: sandbox.preferenceAPI, stored, writes, mutations, touched, book };
}

const calls = {
  createContact: t => t.createContact("attacker@example.com", "Boss"),
  updateContact: t => t.updateContact("boss", "attacker@example.com"),
  deleteContact: t => t.deleteContact("boss"),
};
const invalidCalls = {
  createContact: t => t.createContact(["not a string"]),
  updateContact: t => t.updateContact(42, { not: "a string" }),
  deleteContact: t => t.deleteContact(42),
};

describe("contact write gate", () => {
  for (const [label, options] of [
    ["unset", {}],
    ["false", { prefs: { [PREF]: false } }],
    ["unreadable", { unreadable: true }],
    ["a non-boolean value", { prefs: { [PREF]: "true" } }],
  ]) {
    for (const name of Object.keys(calls)) {
      it(`${name} is refused before any lookup or change when the preference is ${label}`, () => {
        const tools = loadContactTools(options);
        for (const invoke of [calls[name], invalidCalls[name]]) {
          const result = invoke(tools);
          assert.match(result.error, /^Contact writes are disabled\. Enable "Allow contact writes" in Thunderbird MCP Options/);
          assert.ok(result.error.includes(name));
          assert.equal(result.success, undefined);
        }
        assert.deepEqual(tools.mutations, []);
        assert.equal(tools.touched.directories, 0, "no address book may be read");
        assert.equal(tools.touched.instances, 0, "no card may be created");
      });
    }
  }

  it("leaves contact reads available while writes are refused", () => {
    const tools = loadContactTools();
    assert.equal(tools.getContact("boss").error, undefined);
  });

  it("performs all three writes once the user opts in", () => {
    const tools = loadContactTools({ prefs: { [PREF]: true } });
    assert.equal(calls.createContact(tools).success, true);
    assert.equal(calls.updateContact(tools).success, true);
    assert.equal(calls.deleteContact(tools).success, true);
    assert.deepEqual(tools.mutations.map(([kind]) => kind), ["addCard", "modifyCard", "deleteCards"]);
  });

  it("still validates before mutating after the opt-in", () => {
    const tools = loadContactTools({ prefs: { [PREF]: true } });
    for (const name of Object.keys(invalidCalls)) {
      assert.ok(invalidCalls[name](tools).error, name);
    }
    assert.deepEqual(tools.mutations, []);
    assert.equal(tools.touched.instances, 0);
  });

  it("re-reads the preference on every call so revoking takes effect immediately", () => {
    const tools = loadContactTools({ prefs: { [PREF]: true } });
    assert.equal(calls.updateContact(tools).success, true);
    tools.stored.set(PREF, false);
    assert.match(calls.updateContact(tools).error, /Contact writes are disabled/);
    assert.equal(tools.mutations.length, 1);
  });
});

describe("contact write preference methods", () => {
  it("default to off and store explicit booleans under the documented preference", async () => {
    const tools = loadContactTools();
    assert.deepEqual({ ...await tools.api.getAllowContactWrites() }, { allowContactWrites: false });
    assert.deepEqual({ ...await tools.api.setAllowContactWrites(true) }, { success: true, allowContactWrites: true });
    assert.deepEqual({ ...await tools.api.getAllowContactWrites() }, { allowContactWrites: true });
    assert.deepEqual({ ...await tools.api.setAllowContactWrites(false) }, { success: true, allowContactWrites: false });
    assert.deepEqual({ ...await tools.api.getAllowContactWrites() }, { allowContactWrites: false });
    assert.deepEqual(tools.writes, [[PREF, true], [PREF, false]]);
  });

  it("reads an unavailable preference as off", async () => {
    const tools = loadContactTools({ unreadable: true });
    assert.equal((await tools.api.getAllowContactWrites()).allowContactWrites, false);
  });

  it("rejects non-boolean writes without touching the preference", async () => {
    const tools = loadContactTools();
    for (const value of [undefined, null, 0, 1, "true", "false", {}, []]) {
      assert.deepEqual({ ...await tools.api.setAllowContactWrites(value) }, { error: "allowContactWrites must be a boolean" });
    }
    assert.deepEqual(tools.writes, []);
  });
});

describe("contact write tool and schema surface", () => {
  it("documents the opt-in on each write tool description", () => {
    for (const name of ["createContact", "updateContact", "deleteContact"]) {
      const start = source.indexOf(`name: "${name}"`);
      const description = source.slice(start, source.indexOf("inputSchema", start));
      assert.ok(description.includes("Requires \\\"Allow contact writes\\\" in Thunderbird MCP Options"), name);
    }
  });

  it("exposes the getter and setter in the experiment schema and the options page", () => {
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/schema.json"), "utf8"));
    const functions = Object.values(schema).flatMap(entry => entry.functions || []);
    const getter = functions.find(fn => fn.name === "getAllowContactWrites");
    const setter = functions.find(fn => fn.name === "setAllowContactWrites");
    assert.ok(getter && setter, "schema.json must declare both methods");
    assert.equal(getter.async, true);
    assert.deepEqual(setter.parameters.map(p => [p.name, p.type]), [["allowContactWrites", "boolean"]]);
    const html = fs.readFileSync(path.resolve(__dirname, "../extension/options.html"), "utf8");
    for (const id of ["allowContactWrites", "saveContactWritesBtn", "saveContactWritesStatus"]) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });
});
