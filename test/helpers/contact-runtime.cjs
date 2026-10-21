"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installMcpHandler } = require("./httpd.cjs");

// Search/reuse: rg found the marker/VM and constant extraction patterns in
// calendar-runtime.cjs and folder-tools.cjs, and the non-exported entry,
// collection and flat-card fakes in contact-fields.test.cjs. Adapt those fakes
// here without importing a test suite. Only Thunderbird objects are simulated;
// validation, formatting, reconciliation, search and handlers come from api.js.
const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");

function snippet(startMarker, endMarker) {
  if (endMarker === undefined) {
    endMarker = `// END ${startMarker}`;
    startMarker = `// BEGIN ${startMarker}`;
  }
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

const VCARD_PROPERTY = "_vCard";
const VCARD_VERSION = "4.0";
const VCARD_LINE_ENDING = "\r\n";
const VCARD_STRUCTURED_PROPERTIES = new Set(["n", "adr", "org"]);
const VCARD_CACHED_PROPERTIES = [
  "DisplayName", "FirstName", "LastName", "PrimaryEmail", "SecondEmail",
];

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
    // the same ordering that AddrBookCard's primaryEmail getter uses.
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

  // Search/reuse: no fixture vCard serializer exists in test/helpers or the
  // contact tests. This only writes the scalar/list/structured data used by
  // these fakes; reload supplies cloned entries, never a handwritten parser.
  toVCard() {
    const escapeText = value => String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/[,;]/g, "\\$&");
    const escapeParameter = value => {
      const escaped = String(value)
        .replace(/\^/g, "^^")
        .replace(/\r\n|\r|\n/g, "^n")
        .replace(/"/g, "^'");
      return /[,:;]/.test(escaped) ? `"${escaped}"` : escaped;
    };
    const lines = ["BEGIN:VCARD"];
    if (!this.getFirstEntry("version")) lines.push(`VERSION:${VCARD_VERSION}`);
    for (const { name, params, type, value } of this.entries) {
      let header = `${params.group ? `${params.group}.` : ""}${name.toUpperCase()}`;
      for (const [key, parameter] of Object.entries(params)) {
        if (key === "group") continue;
        const values = Array.isArray(parameter) ? parameter : [parameter];
        header += `;${key.toUpperCase()}=${values.map(escapeParameter).join(",")}`;
      }
      if (type !== "text" && !Object.hasOwn(params, "value")) {
        header += `;VALUE=${type.toUpperCase()}`;
      }
      const scalar = part => type === "text" ? escapeText(part) : String(part ?? "");
      const serialized = Array.isArray(value)
        ? value.map(part => Array.isArray(part) ? part.map(scalar).join(",") : scalar(part))
          .join(VCARD_STRUCTURED_PROPERTIES.has(name) ? ";" : ",")
        : scalar(value);
      lines.push(`${header}:${serialized}`);
    }
    return [...lines, "END:VCARD", ""].join(VCARD_LINE_ENDING);
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

  get primaryEmail() { return this.vCardProperties.getAllValuesSorted("email")[0] ?? ""; }
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

// AddrBookCard reads cached scalars until the first vCard access. After that,
// even a failed parse changes what its scalar getters see. The parse outcomes
// are supplied by tests; this fixture intentionally does not parse vCard text.
class FakeStoredCard extends FakeAddrBookCard {
  constructor({ properties = {}, raw = "", entries = [], parseMode = "valid" } = {}) {
    super({ ...properties, [VCARD_PROPERTY]: raw }, new FakeVCardProperties(entries));
    this.parseMode = parseMode;
    this.parsed = false;
    this.stats = { parses: 0, emailReads: 0, rawReads: 0, events: [] };
  }

  getProperty(name, fallback = "") {
    if (name === VCARD_PROPERTY) this.stats.rawReads++;
    this.stats.events.push(name);
    return super.getProperty(name, fallback);
  }

  get vCardProperties() {
    if (!this.parsed) {
      this.parsed = true;
      this.stats.parses++;
      this.stats.events.push("parse");
      if (this.parseMode === "empty") {
        this._vCardProperties = new FakeVCardProperties([
          new FakeVCardPropertyEntry("version", {}, "text", VCARD_VERSION),
        ]);
      } else if (this.parseMode === "null") {
        this._vCardProperties = null;
      }
    }
    if (this.parseMode === "throw") throw new Error("Invalid stored vCard");
    return this._vCardProperties;
  }

  get displayName() { return this.parsed ? super.displayName : this.getProperty("DisplayName"); }
  set displayName(value) { super.displayName = value; }
  get firstName() { return this.parsed ? super.firstName : this.getProperty("FirstName"); }
  set firstName(value) { super.firstName = value; }
  get lastName() { return this.parsed ? super.lastName : this.getProperty("LastName"); }
  set lastName(value) { super.lastName = value; }
  get primaryEmail() { return this.parsed ? super.primaryEmail : this.getProperty("PrimaryEmail"); }
  set primaryEmail(value) { super.primaryEmail = value; }
  get emailAddresses() {
    this.stats.emailReads++;
    return super.emailAddresses;
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
    const uid = card.UID || `${this.UID}-contact-${++this.nextUID}`;
    const saved = this.prepareToSaveCard(card, uid);
    this.savedCards.set(saved.UID, saved);
    return this.reloadCard(saved.UID);
  }

  modifyCard(card) {
    this.calls.modify.push(card);
    if (this.readOnly) throw new Error("Address book is read-only");
    this.savedCards.set(card.UID, this.prepareToSaveCard(card));
  }

  deleteCards(cards) {
    this.calls.delete.push(Array.from(cards));
    if (this.readOnly) throw new Error("Address book is read-only");
    for (const card of cards) {
      this.savedCards.delete(card.UID);
      this.cards = this.cards.filter(existing => existing.UID !== card.UID);
    }
  }

  // Model AddrBookDirectory.prepareToSaveCard's cache/raw rebuild for the
  // supported vCard fields. Reuse clone/getNamePart/native email ordering;
  // caches must come from entries, never the potentially stale property bag.
  prepareToSaveCard(card, uid = card.UID) {
    const saved = card.clone();
    if (saved.UID !== uid) saved.UID = uid;
    if (!saved.supportsVCard) return saved;

    const properties = saved.vCardProperties;
    if (!properties.getFirstEntry("version")) {
      properties.entries.unshift(new FakeVCardPropertyEntry("version", {}, "text", VCARD_VERSION));
    }
    if (properties.getFirstValue("uid") !== uid) {
      properties.clearValues("uid");
      properties.addEntry(new FakeVCardPropertyEntry("uid", {}, "text", uid));
    }
    for (const name of VCARD_CACHED_PROPERTIES) saved.stored.delete(name);
    saved.stored.set(VCARD_PROPERTY, properties.toVCard());
    saved.stored.set("DisplayName", properties.getFirstValue("fn") || "");
    if (Array.isArray(properties.getFirstValue("n"))) {
      saved.stored.set("FirstName", saved.getNamePart(1));
      saved.stored.set("LastName", saved.getNamePart(0));
    }
    const emails = properties.getAllValuesSorted("email");
    if (emails[0]) saved.stored.set("PrimaryEmail", emails[0]);
    if (emails[1]) saved.stored.set("SecondEmail", emails[1]);
    return saved;
  }

  // Loading exposes cached scalars and serialized text before the first lazy
  // vCard access. Both the property bag and supplied parse result are isolated
  // from the saved snapshot. Flat providers keep their existing clone path.
  reloadCard(id) {
    const saved = this.savedCards.get(id);
    if (!saved) return null;
    const card = saved.supportsVCard
      ? new FakeStoredCard({
        properties: Object.fromEntries(structuredClone(saved.stored)),
        raw: saved.getProperty(VCARD_PROPERTY),
        entries: saved.vCardProperties.clone().entries,
      })
      : saved.clone();
    card.isMailList = saved.isMailList;
    const index = this.cards.findIndex(existing => existing.UID === id);
    if (index < 0) this.cards.push(card);
    else this.cards[index] = card;
    return card;
  }
}

function loadContactRuntime({
  books = [new FakeAddressBook()], esmUnavailable = [], initial = {}, unreadable = [], dispatch = false,
} = {}) {
  const calls = { imports: [], vCardCards: [], flatCards: [], factoryInterfaces: [], directories: 0 };
  // Search/reuse: privacy-access has a mutable preference fixture but does not
  // export it; direct-send-prefs is read-only. Keep only the needed service
  // boundary here, while loading privacy/access decisions from production.
  const values = new Map();
  const readErrors = new Set();
  const writes = [];
  const prefTypes = { PREF_INVALID: 0, PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128 };
  const prefs = {
    getPrefType(name) {
      if (readErrors.has(name)) throw new Error("Preference is unreadable");
      if (!values.has(name)) return prefTypes.PREF_INVALID;
      const value = values.get(name);
      if (typeof value === "string") return prefTypes.PREF_STRING;
      if (typeof value === "boolean") return prefTypes.PREF_BOOL;
      if (Number.isInteger(value)) return prefTypes.PREF_INT;
      throw new Error("Unsupported preference value");
    },
    clearUserPref(name) {
      values.delete(name);
      writes.push({ name });
    },
  };
  for (const kind of ["Bool", "String", "Int"]) {
    prefs[`get${kind}Pref`] = (name, fallback) => {
      if (readErrors.has(name)) throw new Error("Preference is unreadable");
      // Return malformed values too, so the real opt-in helper must require
      // strict true rather than relying on a fixture's boolean coercion.
      return values.has(name) ? values.get(name) : fallback;
    };
    prefs[`set${kind}Pref`] = (name, value) => {
      values.set(name, value);
      writes.push({ name, value });
    };
  }
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
    Services: { prefs },
    Ci: { nsIAbManager: DIRECTORY_TYPES, nsIAbCard: "fixture:nsIAbCard", nsIPrefBranch: prefTypes },
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
    MailServices: { ab: { get directories() { calls.directories++; return books; } } },
  });
  const prefConstants = [
    "PREF_ALLOW_CONTACT_WRITES", "PREF_ALLOWED_ACCOUNTS", "PREF_DISABLED_TOOLS", "PREF_TOOL_ACCESS_STATE", "PREF_TOOL_ACCESS_CUSTOMIZED",
    "PREF_ALLOW_ALL_ADDRESS_BOOKS", "PREF_ALLOW_ALL_CALENDARS", "PREF_ALLOW_ENCRYPTED_MESSAGES",
    "PREF_GET_MESSAGES_LIMIT",
  ];
  vm.runInContext([
    ...prefConstants.map(constant),
    constant("DEFAULT_MAX_RESULTS"),
    constant("MAX_SEARCH_RESULTS_CAP"),
    snippet("PRIVACY PREFERENCE HELPERS"),
    snippet("CONTACT FIELD HELPERS"),
    snippet("CONTACT MODULE IMPORTS"),
    snippet("CONTACT SEARCH"),
    snippet("CONTACT TOOL HANDLERS"),
    "this.limits = { DEFAULT_MAX_RESULTS, MAX_SEARCH_RESULTS_CAP };",
    `this.prefNames = { ${prefConstants.join(", ")} };`,
    "this.options = {",
    snippet("CONTACT WRITE PREFERENCE METHODS"),
    snippet("PRIVACY OPTIONS API"),
    "};",
  ].join("\n"), sandbox, { filename: "contact-runtime.api.js" });

  for (const [name, value] of Object.entries(initial)) {
    assert.ok(sandbox.prefNames[name], `Unknown preference constant: ${name}`);
    values.set(sandbox.prefNames[name], value);
  }
  for (const name of unreadable) {
    assert.ok(sandbox.prefNames[name], `Unknown preference constant: ${name}`);
    readErrors.add(sandbox.prefNames[name]);
  }

  if (dispatch) {
    // Reuse privacy-access/calendar-runtime's production schema dependencies
    // and the existing HTTP installer. No handler or access gate is replaced.
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../extension/tool-access.js"), "utf8"), sandbox);
    vm.runInContext([
      "const toolAccess = globalThis.ToolAccess;",
      ...["DEFAULT_GET_MESSAGES_LIMIT", "MAX_GET_MESSAGES_LIMIT", "UNDISABLEABLE_TOOLS"].map(constant),
      snippet("OUTBOUND ATTACHMENT LIMITS"),
      snippet("MESSAGE HEADER LIMITS"),
      snippet("function normalizeGetMessagesLimit(", "// BEGIN TOOL SCHEMA BUILDER"),
      snippet("FILTER SEARCH TERM HELPERS"),
      snippet("BOUNDED REFRESH HELPERS"),
      snippet("TOOL SCHEMA BUILDER"),
      "const ALL_TOOL_NAMES = buildTools().map(tool => tool.name);",
      snippet("TOOL ACCESS STATE"),
      snippet("TOOL SCHEMA VALIDATOR"),
      snippet("SERVER ACCESS HELPERS"),
      snippet("MCP TEXT SANITIZATION"),
      snippet("INLINE IMAGE CONTENT HELPERS"),
      snippet("TOOL CALL DISPATCH"),
    ].join("\n"), sandbox, { filename: "contact-dispatch.api.js" });

    let handler;
    const authToken = "contact-fixture-token";
    installMcpHandler({
      sandbox,
      server: { registerPathHandler(route, callback) { assert.equal(route, "/"); handler = callback; } },
    }, authToken);
    // Search/reuse: validation.test.cjs captures HTTP responses this way; the
    // exported httpd.request instead drives socket framing. Simulate only I/O.
    sandbox.request = (method, params) => new Promise(resolve => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
      let output = "";
      handler({
        method: "POST",
        bodyInputStream: { available: () => body.length, read: count => body.subarray(0, count) },
        getHeader: name => name === "Authorization" ? `Bearer ${authToken}` : String(body.length),
      }, {
        processAsync() {}, setStatusLine() {}, setHeader() {},
        write(text) { output += text; },
        finish() { resolve(JSON.parse(output)); },
      });
    });
  }

  // Convenience adapters only unpack arguments; production owns all decisions.
  const fields = [
    "email", "emails", "displayName", "firstName", "lastName", "phones", "addresses",
    "organization", "title", "note", "birthday",
  ];
  return {
    ...sandbox, books, calls, values, readErrors, writes,
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
  FakeFlatCard, FakeAddrBookCard, FakeStoredCard, FakeAddressBook,
};
