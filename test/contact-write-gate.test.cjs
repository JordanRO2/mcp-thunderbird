"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadContactRuntime, DIRECTORY_TYPES, FakeFlatCard, FakeAddressBook,
} = require("./helpers/contact-runtime.cjs");

const PREF = "extensions.thunderbird-mcp.allowContactWrites";
const CONTACT_ID = "boss";
const CONTACT_EMAIL = "boss@example.com";
const CREATED_EMAIL = "created@example.com";
const BOOK_TYPES = [
  ["vCard", DIRECTORY_TYPES.JS_DIRECTORY_TYPE],
  ["flat", DIRECTORY_TYPES.LDAP_DIRECTORY_TYPE],
];
const WRITE_CALLS = [
  {
    name: "createContact",
    args: { email: CREATED_EMAIL, emails: [{ address: CREATED_EMAIL }], displayName: "Created Contact" },
    invalid: { email: ["not a string"] },
    invoke: (runtime, args) => runtime.create(args),
  },
  {
    name: "updateContact",
    args: { contactId: CONTACT_ID, emails: [{ address: "updated@example.com" }], displayName: "Updated Contact" },
    invalid: { contactId: 42, email: { not: "a string" } },
    invoke: (runtime, { contactId, ...args }) => runtime.update(contactId, args),
  },
  {
    name: "deleteContact",
    args: { contactId: CONTACT_ID },
    invalid: { contactId: 42 },
    invoke: (runtime, { contactId }) => runtime.deleteContact(contactId),
  },
];
const CONTACT_TOOLS = ["getContact", "searchContacts", ...WRITE_CALLS.map(call => call.name)];
const BLOCKED_ERROR = /^Contact writes are disabled\. Enable "Allow contact writes" in Thunderbird MCP Options/;
const ADDRESS_BOOK_ERROR = /Account restrictions block.*Allow all address books/;

// Reuse S9's native-object fixtures and named adapters. Keep a second book and
// a second card in the target book so refusal/success assertions catch spillover.
function loadGateRuntime({ dirType = DIRECTORY_TYPES.JS_DIRECTORY_TYPE, ...options } = {}) {
  const card = new FakeFlatCard({ UID: CONTACT_ID, DisplayName: "Boss", PrimaryEmail: CONTACT_EMAIL });
  const bystander = new FakeFlatCard({ UID: "bystander", DisplayName: "Keep this contact" });
  const book = new FakeAddressBook({ dirType, cards: [card, bystander] });
  const untouchedBook = new FakeAddressBook({
    UID: "untouched-book", URI: "jsaddrbook://untouched.sqlite",
    cards: [new FakeFlatCard({ UID: "untouched", DisplayName: "Keep this book" })],
  });
  return { ...loadContactRuntime({ ...options, books: [book, untouchedBook] }), book, card, bystander, untouchedBook };
}

describe("contact write gate", () => {
  for (const [kind, dirType] of BOOK_TYPES) {
    for (const [label, options] of [
      ["absent", {}],
      ["false", { initial: { PREF_ALLOW_CONTACT_WRITES: false } }],
      ["unreadable", { initial: { PREF_ALLOW_CONTACT_WRITES: true }, unreadable: ["PREF_ALLOW_CONTACT_WRITES"] }],
      ...["true", "false", 1, null, {}, []].map(value => [
        `non-boolean ${JSON.stringify(value)}`, { initial: { PREF_ALLOW_CONTACT_WRITES: value } },
      ]),
    ]) {
      for (const { name, args, invalid, invoke } of WRITE_CALLS) {
        it(`${name} refuses valid and invalid input before lookup or construction in a ${kind} book when consent is ${label}`, async () => {
          const runtime = loadGateRuntime({ dirType, ...options });
          const before = structuredClone(runtime.books);
          assert.equal((await runtime.options.getAllowContactWrites()).allowContactWrites, false);
          for (const input of [args, invalid]) {
            const result = invoke(runtime, input);
            assert.match(result.error, BLOCKED_ERROR);
            assert.ok(result.error.includes(name));
            assert.equal(result.success, undefined);
          }
          assert.equal(runtime.calls.directories, 0, "no address book may be read");
          assert.deepEqual(runtime.calls.vCardCards, [], "no vCard constructor may run");
          assert.deepEqual(runtime.calls.flatCards, [], "no flat card constructor may run");
          assert.deepEqual(runtime.calls.factoryInterfaces, []);
          assert.deepEqual(structuredClone(runtime.books), before, "all cards and books remain untouched");
          assert.deepEqual(runtime.writes, [], "refusal must not repair or write preferences");
        });
      }
    }

    it(`leaves getContact and searchContacts available with consent off in a ${kind} book`, () => {
      const runtime = loadGateRuntime({ dirType });
      const before = structuredClone(runtime.books);
      const read = runtime.getContact(CONTACT_ID);
      assert.equal(read.id, CONTACT_ID);
      assert.equal(read.email, CONTACT_EMAIL);
      assert.deepEqual(Array.from(runtime.searchContacts(CONTACT_EMAIL), contact => contact.id), [CONTACT_ID]);
      assert.deepEqual(structuredClone(runtime.books), before);
      assert.deepEqual(runtime.writes, []);
      assert.equal(runtime.values.has(PREF), false, "reads do not grant consent");
    });

    it(`performs all three writes after explicit consent in a ${kind} book`, async () => {
      const runtime = loadGateRuntime({ dirType });
      const otherBook = structuredClone(runtime.untouchedBook);
      const otherCard = structuredClone(runtime.bystander);
      assert.equal((await runtime.options.setAllowContactWrites(true)).success, true);
      for (const { name, args, invoke } of WRITE_CALLS) {
        const result = invoke(runtime, args);
        assert.equal(result.success, true, `${name}: ${result.error}`);
        if (name === "createContact") {
          assert.equal(result.displayName, args.displayName, "named adapter preserves S9's emails slot");
          assert.deepEqual(structuredClone(runtime.getContact(result.id).emails), args.emails);
        }
        if (name === "updateContact") {
          assert.deepEqual(structuredClone(runtime.getContact(CONTACT_ID).emails), args.emails);
        }
      }
      assert.deepEqual(Object.values(runtime.book.calls).map(calls => calls.length), [1, 1, 1]);
      assert.equal(runtime.calls.vCardCards.length, kind === "vCard" ? 1 : 0);
      assert.equal(runtime.calls.flatCards.length, kind === "flat" ? 1 : 0);
      assert.deepEqual(structuredClone(runtime.untouchedBook), otherBook);
      assert.deepEqual(structuredClone(runtime.bystander), otherCard);
      assert.ok(runtime.book.cards.includes(runtime.bystander));
    });

    it(`still validates before mutation with consent on in a ${kind} book`, async () => {
      const runtime = loadGateRuntime({ dirType });
      const before = structuredClone(runtime.books);
      await runtime.options.setAllowContactWrites(true);
      for (const { name, invalid, invoke } of WRITE_CALLS) {
        const result = invoke(runtime, invalid);
        assert.match(result.error, /must be/);
        assert.doesNotMatch(result.error, BLOCKED_ERROR, name);
      }
      assert.equal(runtime.calls.directories, 0);
      assert.deepEqual(runtime.calls.vCardCards, []);
      assert.deepEqual(runtime.calls.flatCards, []);
      assert.deepEqual(structuredClone(runtime.books), before);
    });

    it(`revokes all three writes immediately in the same ${kind} runtime while reads remain available`, async () => {
      const runtime = loadGateRuntime({ dirType });
      await runtime.options.setAllowContactWrites(true);
      const created = runtime.create({ displayName: "Temporary" });
      assert.equal(created.success, true);
      assert.equal(runtime.update(created.id, { displayName: "Updated" }).success, true);
      assert.equal(runtime.deleteContact(created.id).success, true);
      const before = structuredClone(runtime.books);
      const counts = [runtime.calls.directories, runtime.calls.vCardCards.length, runtime.calls.flatCards.length];

      await runtime.options.setAllowContactWrites(false);
      for (const { name, args, invoke } of WRITE_CALLS) {
        const result = invoke(runtime, args);
        assert.match(result.error, BLOCKED_ERROR, name);
      }
      assert.deepEqual([runtime.calls.directories, runtime.calls.vCardCards.length, runtime.calls.flatCards.length], counts);
      assert.deepEqual(structuredClone(runtime.books), before);
      assert.equal(runtime.getContact(CONTACT_ID).id, CONTACT_ID);
      assert.deepEqual(Array.from(runtime.searchContacts(CONTACT_EMAIL), contact => contact.id), [CONTACT_ID]);
      assert.equal(runtime.values.get(PREF), false);
    });
  }
});

describe("contact write preference methods", () => {
  it("defaults to off and stores explicit booleans under the documented preference", async () => {
    const runtime = loadContactRuntime();
    assert.equal(runtime.prefNames.PREF_ALLOW_CONTACT_WRITES, PREF);
    assert.deepEqual({ ...await runtime.options.getAllowContactWrites() }, { allowContactWrites: false });
    assert.deepEqual({ ...await runtime.options.setAllowContactWrites(true) }, { success: true, allowContactWrites: true });
    assert.deepEqual({ ...await runtime.options.getAllowContactWrites() }, { allowContactWrites: true });
    assert.deepEqual({ ...await runtime.options.setAllowContactWrites(false) }, { success: true, allowContactWrites: false });
    assert.deepEqual({ ...await runtime.options.getAllowContactWrites() }, { allowContactWrites: false });
    assert.deepEqual(runtime.writes, [{ name: PREF, value: true }, { name: PREF, value: false }]);
  });

  it("fails closed if the preference becomes unreadable after consent was granted", async () => {
    const runtime = loadGateRuntime();
    await runtime.options.setAllowContactWrites(true);
    runtime.readErrors.add(PREF);
    assert.equal((await runtime.options.getAllowContactWrites()).allowContactWrites, false);
    const before = structuredClone(runtime.books);
    for (const { args, invoke } of WRITE_CALLS) assert.match(invoke(runtime, args).error, BLOCKED_ERROR);
    assert.equal(runtime.calls.directories, 0);
    assert.deepEqual(structuredClone(runtime.books), before);
    runtime.readErrors.delete(PREF);
    assert.equal((await runtime.options.getAllowContactWrites()).allowContactWrites, true);
  });

  it("rejects non-boolean setters without changing the preference", async () => {
    const runtime = loadContactRuntime();
    for (const allowed of [false, true]) {
      await runtime.options.setAllowContactWrites(allowed);
      const before = structuredClone(runtime.writes);
      for (const value of [undefined, null, 0, 1, "true", "false", {}, []]) {
        assert.deepEqual({ ...await runtime.options.setAllowContactWrites(value) }, { error: "allowContactWrites must be a boolean" });
        assert.equal((await runtime.options.getAllowContactWrites()).allowContactWrites, allowed);
      }
      assert.deepEqual(runtime.writes, before);
    }
  });
});

describe("independent contact gates through production MCP dispatch and real handlers", () => {
  for (const toolAccess of [false, true]) {
    for (const addressBookAccess of [false, true]) {
      for (const consent of [false, true]) {
        it(`Tool Access=${toolAccess}, address-book scope=${addressBookAccess}, write consent=${consent}`, async () => {
          const runtime = loadGateRuntime({ dispatch: true, initial: {
            PREF_ALLOWED_ACCOUNTS: '["account1"]',
            PREF_DISABLED_TOOLS: JSON.stringify(toolAccess ? [] : CONTACT_TOOLS),
          } });
          await runtime.options.setPrivacySettings(false, false, addressBookAccess);
          if (consent) await runtime.options.setAllowContactWrites(true);
          const before = structuredClone(runtime.books);
          const otherBook = structuredClone(runtime.untouchedBook);
          const otherCard = structuredClone(runtime.bystander);
          const preferences = structuredClone(runtime.values);
          const listed = await runtime.request("tools/list");
          assert.equal(listed.error, undefined);
          for (const name of CONTACT_TOOLS) {
            assert.equal(listed.result.tools.some(tool => tool.name === name), toolAccess,
              `${name} listing depends only on Tool Access`);
          }

          for (const [name, args] of [
            ["getContact", { contactId: CONTACT_ID }], ["searchContacts", { query: CONTACT_EMAIL }],
          ]) {
            const response = await runtime.request("tools/call", { name, arguments: args });
            if (!toolAccess) {
              assert.match(response.error.message, /Tool is disabled/);
              continue;
            }
            assert.equal(response.error, undefined);
            const result = JSON.parse(response.result.content[0].text);
            if (!addressBookAccess) assert.match(result.error, ADDRESS_BOOK_ERROR);
            else assert.equal(name === "getContact" ? result.id : result[0].id, CONTACT_ID);
          }
          const directoriesAfterReads = runtime.calls.directories;

          for (const { name, args } of WRITE_CALLS) {
            const response = await runtime.request("tools/call", { name, arguments: args });
            if (!toolAccess) {
              assert.match(response.error.message, /Tool is disabled/);
              continue;
            }
            assert.equal(response.error, undefined);
            const result = JSON.parse(response.result.content[0].text);
            if (!addressBookAccess) {
              assert.match(result.error, ADDRESS_BOOK_ERROR);
              assert.doesNotMatch(result.error, BLOCKED_ERROR, "scope refusal precedes the handler's write-consent check");
            } else if (!consent) {
              assert.match(result.error, BLOCKED_ERROR);
              assert.ok(result.error.includes(name));
            } else {
              assert.equal(result.success, true, `${name}: ${result.error}`);
            }
          }
          if (!(toolAccess && addressBookAccess && consent)) {
            assert.deepEqual(structuredClone(runtime.books), before);
            assert.equal(runtime.calls.directories, directoriesAfterReads, "blocked writes do not look up books");
            assert.deepEqual(runtime.calls.vCardCards, []);
            assert.deepEqual(runtime.calls.flatCards, []);
          } else {
            assert.deepEqual(Object.values(runtime.book.calls).map(calls => calls.length), [1, 1, 1]);
            assert.equal(runtime.calls.vCardCards.length, 1, "HTTP dispatch reaches the real create handler");
          }
          if (!toolAccess || !addressBookAccess) assert.equal(runtime.calls.directories, 0);
          assert.deepEqual(structuredClone(runtime.untouchedBook), otherBook);
          assert.deepEqual(structuredClone(runtime.bystander), otherCard);
          assert.ok(runtime.book.cards.includes(runtime.bystander));
          assert.deepEqual(runtime.values, preferences, "MCP calls do not change any access preference");
        });
      }
    }
  }

  for (const consent of [false, true]) {
    it(`keeps Options getter/setter out of tools/list and rejects them through MCP with consent=${consent}`, async () => {
      const runtime = loadGateRuntime({ dispatch: true });
      if (consent) await runtime.options.setAllowContactWrites(true);
      const preferences = structuredClone(runtime.values);
      const writes = structuredClone(runtime.writes);
      const books = structuredClone(runtime.books);
      const listed = await runtime.request("tools/list");
      assert.equal(listed.error, undefined);
      for (const name of ["getAllowContactWrites", "setAllowContactWrites"]) {
        assert.ok(!runtime.buildTools().some(tool => tool.name === name));
        assert.ok(!listed.result.tools.some(tool => tool.name === name));
        const args = name.startsWith("set") ? { allowContactWrites: !consent } : {};
        const response = await runtime.request("tools/call", { name, arguments: args });
        assert.match(response.error.message, /Unknown tool/);
        await assert.rejects(runtime.callTool(name, args), /Unknown tool/);
      }
      assert.equal((await runtime.options.getAllowContactWrites()).allowContactWrites, consent);
      assert.deepEqual(runtime.values, preferences);
      assert.deepEqual(runtime.writes, writes);
      assert.equal(runtime.calls.directories, 0);
      assert.deepEqual(structuredClone(runtime.books), books);
    });
  }
});

describe("contact write tool and schema surface", () => {
  it("documents the opt-in on each production write tool description", () => {
    const runtime = loadContactRuntime({ dispatch: true });
    for (const { name } of WRITE_CALLS) {
      const tool = runtime.buildTools().find(tool => tool.name === name);
      assert.ok(tool.description.includes('Requires "Allow contact writes" in Thunderbird MCP Options'), name);
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
