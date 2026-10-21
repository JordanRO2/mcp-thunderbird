"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Search/reuse: rg found the marker/VM and constant extraction patterns in
// calendar-runtime.cjs and folder-tools.cjs, and the non-exported entry,
// collection and flat-card fakes in contact-fields.test.cjs. Adapt those fakes
// here without importing a test suite. Only Thunderbird objects are simulated;
// validation, formatting, reconciliation, search and handlers come from api.js.
const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");

function snippet(name) {
  const startMarker = `// BEGIN ${name}`;
  const endMarker = `// END ${name}`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `api.js marker missing: ${startMarker}`);
  assert.ok(end > start, `api.js marker missing: ${endMarker}`);
  return source.slice(start, end);
}

function constant(name) {
  const match = source.match(new RegExp(`^\\s*const ${name} = [^\\n]+;`, "m"));
  assert.ok(match, `api.js constant missing: ${name}`);
  return match[0];
}

// Deliberately unlike Thunderbird's numeric values: production must use Ci's
// named constants, including when unknown numeric directory types are supplied.
const DIRECTORY_TYPES = Object.freeze({
  JS_DIRECTORY_TYPE: "fixture:local-js",
  CARDDAV_DIRECTORY_TYPE: "fixture:carddav",
  LDAP_DIRECTORY_TYPE: "fixture:ldap",
  MAPI_DIRECTORY_TYPE: "fixture:mapi",
  ASYNC_DIRECTORY_TYPE: "fixture:os",
});

class FakeVCardPropertyEntry {
  constructor(name, params, type, value) {
    Object.assign(this, { name, params, type, value });
    this._original = this;
  }

  equals(other) {
    return this._original === other._original;
  }

  clone() {
    const copy = new FakeVCardPropertyEntry(
      this.name, structuredClone(this.params), this.type, structuredClone(this.value)
    );
    copy._original = this;
    return copy;
  }
}

class FakeVCardProperties {
  constructor(entries = []) {
    this.entries = entries.slice();
  }

  getAllEntries(name) {
    return this.entries.filter(entry => entry.name === name);
  }

  getAllEntriesSorted(name) {
    // Native VCardProperties uses the parameter as-is, not parseInt. This is
    // independent of production sortContactEmailEntries, which is under test.
    let nextPref = 101;
    return this.getAllEntries(name)
      .map(entry => ({ entry, pref: entry.params.pref || nextPref++ }))
      .sort((a, b) => a.pref - b.pref)
      .map(item => item.entry);
  }

  getAllValuesSorted(name) {
    return this.getAllEntriesSorted(name).map(entry => entry.value);
  }

  getFirstEntry(name) {
    return this.getAllEntries(name)[0] || null;
  }

  getFirstValue(name) {
    return this.getFirstEntry(name)?.value ?? null;
  }

  addEntry(entry) {
    if (this.entries.some(existing => existing.equals(entry))) return false;
    this.entries.push(entry);
    return true;
  }

  removeEntry(entry) {
    const index = this.entries.findIndex(existing => existing.equals(entry));
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  clearValues(name) {
    this.entries = this.entries.filter(entry => entry.name !== name);
  }

  clone() {
    return new FakeVCardProperties(this.entries.map(entry => entry.clone()));
  }
}

class FakeFlatCard {
  constructor(properties = {}) {
    this.stored = new Map(Object.entries(properties));
    this.writes = [];
    this.isMailList = false;
  }

  get supportsVCard() { return false; }

  getProperty(name, fallback = "") {
    return this.stored.has(name) ? this.stored.get(name) : fallback;
  }

  setProperty(name, value) {
    this.writes.push({ name, value });
    this.stored.set(name, value);
  }

  get emailAddresses() {
    return [this.primaryEmail, this.getProperty("SecondEmail", "")].filter(Boolean);
  }

  clone() {
    const copy = new FakeFlatCard(Object.fromEntries(structuredClone(this.stored)));
    copy.isMailList = this.isMailList;
    return copy;
  }
}

for (const [field, property] of Object.entries({
  UID: "UID", displayName: "DisplayName", firstName: "FirstName",
  lastName: "LastName", primaryEmail: "PrimaryEmail",
})) {
  Object.defineProperty(FakeFlatCard.prototype, field, {
    configurable: true,
    get() { return this.getProperty(property, ""); },
    set(value) { this.setProperty(property, value); },
  });
}

class FakeAddrBookCard extends FakeFlatCard {
  constructor(properties = {}, vCardProperties = new FakeVCardProperties()) {
    super(properties);
    this._vCardProperties = vCardProperties;
  }

  get supportsVCard() { return true; }
  get vCardProperties() { return this._vCardProperties; }

  get displayName() { return this.vCardProperties.getFirstValue("fn") || ""; }
  set displayName(value) {
    const entry = this.vCardProperties.getFirstEntry("fn");
    if (entry) entry.value = value;
    else this.vCardProperties.addEntry(new FakeVCardPropertyEntry("fn", {}, "text", value));
  }

  get firstName() { return this.getNamePart(1); }
  set firstName(value) { this.setNamePart(1, value); }
  get lastName() { return this.getNamePart(0); }
  set lastName(value) { this.setNamePart(0, value); }

  getNamePart(index) {
    const name = this.vCardProperties.getFirstValue("n");
    if (!Array.isArray(name)) return "";
    return Array.isArray(name[index]) ? name[index].join(" ") : name[index];
  }

  setNamePart(index, value) {
    let entry = this.vCardProperties.getFirstEntry("n");
    if (!entry) {
      entry = new FakeVCardPropertyEntry("n", {}, "text", ["", "", "", "", ""]);
      this.vCardProperties.addEntry(entry);
    }
    entry.value[index] = value;
  }

  get primaryEmail() { return this.emailAddresses[0] ?? ""; }
  set primaryEmail(value) {
    const entries = this.vCardProperties.getAllEntriesSorted("email");
    if (entries.length && entries[0].value !== value) {
      this.vCardProperties.removeEntry(entries.shift());
    }
    if (value) {
      const existing = entries.find(entry => entry.value === value);
      if (existing) existing.params.pref = "1";
      else this.vCardProperties.addEntry(new FakeVCardPropertyEntry("email", { pref: "1" }, "text", value));
    } else if (entries.length) {
      entries[0].params.pref = "1";
    }
  }

  get emailAddresses() { return this.vCardProperties.getAllValuesSorted("email"); }

  clone() {
    const copy = new FakeAddrBookCard(
      Object.fromEntries(structuredClone(this.stored)), this.vCardProperties.clone()
    );
    copy.isMailList = this.isMailList;
    return copy;
  }
}

class FakeAddressBook {
  constructor({
    UID = "book-uid", URI = "jsaddrbook://fixture.sqlite", dirPrefId = "ldap_2.servers.fixture",
    dirName = "Fixture Book", dirType = DIRECTORY_TYPES.JS_DIRECTORY_TYPE,
    readOnly = false, cards = [],
  } = {}) {
    Object.assign(this, { UID, URI, dirPrefId, dirName, dirType, readOnly });
    this.cards = cards.slice();
    this.savedCards = new Map();
    this.calls = { add: [], modify: [], delete: [] };
    this.nextUID = 0;
  }

  get childCards() { return this.cards; }

  addCard(card) {
    this.calls.add.push(card);
    if (this.readOnly) throw new Error("Address book is read-only");
    const saved = card.clone();
    if (!saved.UID) saved.UID = `${this.UID}-contact-${++this.nextUID}`;
    this.savedCards.set(saved.UID, saved);
    return this.reloadCard(saved.UID);
  }

  modifyCard(card) {
    this.calls.modify.push(card);
    if (this.readOnly) throw new Error("Address book is read-only");
    this.savedCards.set(card.UID, card.clone());
  }

  deleteCards(cards) {
    this.calls.delete.push(Array.from(cards));
    if (this.readOnly) throw new Error("Address book is read-only");
    for (const card of cards) {
      this.savedCards.delete(card.UID);
      this.cards = this.cards.filter(existing => existing.UID !== card.UID);
    }
  }

  // A saved vCard collection (including params.group) is cloned again on load.
  // Never copy scalar getters into snapshots, and never parse vCard text here.
  reloadCard(id) {
    const saved = this.savedCards.get(id);
    if (!saved) return null;
    const card = saved.clone();
    const index = this.cards.findIndex(existing => existing.UID === id);
    if (index < 0) this.cards.push(card);
    else this.cards[index] = card;
    return card;
  }
}

function loadContactRuntime({ books = [new FakeAddressBook()], esmUnavailable = [] } = {}) {
  const calls = { imports: [], vCardCards: [], flatCards: [], factoryInterfaces: [] };
  class AddrBookCard extends FakeAddrBookCard {
    constructor() {
      super();
      calls.vCardCards.push(this);
    }
  }
  const exportsByModule = {
    VCardUtils: { VCardPropertyEntry: FakeVCardPropertyEntry },
    AddrBookCard: { AddrBookCard },
  };
  const modules = new Map();
  for (const [name, exports] of Object.entries(exportsByModule)) {
    modules.set(`resource:///modules/${name}.sys.mjs`, exports);
    modules.set(`resource:///modules/${name}.jsm`, exports);
  }
  const unavailable = new Set(esmUnavailable.map(name => `resource:///modules/${name}.sys.mjs`));
  function importModule(method, uri) {
    calls.imports.push({ method, uri });
    assert.ok(modules.has(uri), `Unexpected contact module import: ${uri}`);
    if (method === "importESModule" && unavailable.has(uri)) {
      throw new Error(`ESM unavailable: ${uri}`);
    }
    return modules.get(uri);
  }

  const sandbox = vm.createContext({
    console,
    Ci: { nsIAbManager: DIRECTORY_TYPES, nsIAbCard: "fixture:nsIAbCard" },
    Cc: {
      "@mozilla.org/addressbook/cardproperty;1": {
        createInstance(iface) {
          calls.factoryInterfaces.push(iface);
          const card = new FakeFlatCard();
          calls.flatCards.push(card);
          return card;
        },
      },
    },
    ChromeUtils: {
      importESModule: uri => importModule("importESModule", uri),
      import: uri => importModule("import", uri),
    },
    MailServices: { ab: { directories: books } },
  });
  vm.runInContext([
    constant("DEFAULT_MAX_RESULTS"),
    constant("MAX_SEARCH_RESULTS_CAP"),
    snippet("CONTACT FIELD HELPERS"),
    snippet("CONTACT MODULE IMPORTS"),
    snippet("CONTACT SEARCH"),
    snippet("CONTACT TOOL HANDLERS"),
    "this.limits = { DEFAULT_MAX_RESULTS, MAX_SEARCH_RESULTS_CAP };",
  ].join("\n"), sandbox, { filename: "contact-runtime.api.js" });

  // Convenience adapters only unpack arguments; production owns all decisions.
  const fields = [
    "email", "emails", "displayName", "firstName", "lastName", "phones", "addresses",
    "organization", "title", "note", "birthday",
  ];
  return {
    ...sandbox, books, calls,
    create(args = {}) {
      return sandbox.createContact(...fields.map(field => args[field]), args.addressBookId);
    },
    update(contactId, args = {}) {
      return sandbox.updateContact(contactId, ...fields.map(field => args[field]));
    },
  };
}

module.exports = {
  loadContactRuntime, DIRECTORY_TYPES, FakeVCardPropertyEntry, FakeVCardProperties,
  FakeFlatCard, FakeAddrBookCard, FakeAddressBook,
};
