"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  loadContactRuntime, DIRECTORY_TYPES, FakeVCardPropertyEntry, FakeVCardProperties,
  FakeFlatCard, FakeAddrBookCard, FakeAddressBook,
} = require("./helpers/contact-runtime.cjs");

const emails = [
  { type: "work", address: "ada@work.example" },
  { type: "home", address: "ada@home.example" },
  { type: "work", address: "ada@research.example" },
];
const phones = [
  { type: "mobile", number: "+48 111 222 333" },
  { type: "mobile", number: "+48 444 555 666" },
];
const scalarFields = {
  displayName: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace",
  organization: "Analytical Engines", title: "Programmer", note: "First line\nSecond line",
  birthday: "--12-10",
};

describe("createContact native card selection and persistence", () => {
  for (const [name, dirType] of [
    ["local", DIRECTORY_TYPES.JS_DIRECTORY_TYPE],
    ["CardDAV", DIRECTORY_TYPES.CARDDAV_DIRECTORY_TYPE],
  ]) {
    it(`creates and reloads three typed emails and two mobile phones in a ${name} book`, () => {
      const book = new FakeAddressBook({ dirType });
      const runtime = loadContactRuntime({ books: [book] });
      const addresses = [{ type: "home", street: "12 Engine Lane", city: "London", country: "UK" }];
      const result = runtime.create({ ...scalarFields, email: emails[0].address, emails, phones, addresses });

      assert.equal(result.success, true, result.error);
      assert.equal(result.email, emails[0].address);
      assert.equal(result.displayName, scalarFields.displayName);
      assert.equal(runtime.calls.vCardCards.length, 1);
      assert.equal(runtime.calls.flatCards.length, 0);
      assert.equal(runtime.calls.factoryInterfaces.length, 0);
      assert.equal(book.calls.add.length, 1);
      const constructed = runtime.calls.vCardCards[0];
      assert.strictEqual(book.calls.add[0], constructed);
      assert.ok(constructed instanceof FakeAddrBookCard);

      const firstLoad = book.childCards[0];
      const saved = book.savedCards.get(result.id);
      assert.notStrictEqual(firstLoad, constructed);
      assert.notStrictEqual(firstLoad, saved);
      assert.notStrictEqual(saved.vCardProperties, constructed.vCardProperties);
      assert.notStrictEqual(firstLoad.vCardProperties, saved.vCardProperties);
      // A response from the still-live card must not stand in for persistence.
      constructed.displayName = "Unsaved constructor change";
      constructed.vCardProperties.getFirstEntry("email").value = "unsaved@example.com";
      firstLoad.firstName = "Unsaved loaded change";
      firstLoad.vCardProperties.getAllEntries("email")[1].params.type = "work";

      const reloaded = book.reloadCard(result.id);
      assert.notStrictEqual(reloaded, firstLoad);
      assert.equal(reloaded.getProperty("DisplayName", ""), "");
      assert.equal(reloaded.vCardProperties.getFirstValue("fn"), scalarFields.displayName);
      assert.deepEqual(reloaded.vCardProperties.getFirstValue("n"), ["Lovelace", "Ada", "", "", ""]);
      assert.deepEqual(reloaded.emailAddresses, emails.map(email => email.address));
      assert.equal(reloaded.primaryEmail, emails[0].address);
      assert.deepEqual(reloaded.vCardProperties.getAllEntries("email").map(entry => entry.params.pref), ["1", undefined, undefined]);
      assert.deepEqual(reloaded.vCardProperties.getAllEntries("tel").map(entry => entry.params.type), ["cell", "cell"]);
      assert.deepEqual(structuredClone(runtime.getContact(result.id)), {
        id: result.id, ...scalarFields, email: emails[0].address, emails, phones, addresses,
        addressBook: book.dirName, addressBookId: book.URI,
      });
    });
  }

  for (const [name, dirType] of [
    ["LDAP", DIRECTORY_TYPES.LDAP_DIRECTORY_TYPE],
    ["MAPI", DIRECTORY_TYPES.MAPI_DIRECTORY_TYPE],
    ["OS", DIRECTORY_TYPES.ASYNC_DIRECTORY_TYPE],
    ["unknown", "fixture:unknown-directory"],
    ["numeric 101", 101],
    ["numeric 102", 102],
  ]) {
    it(`uses the flat factory for ${name}, saves two emails and refuses three before mutation`, () => {
      const book = new FakeAddressBook({ dirType });
      const runtime = loadContactRuntime({ books: [book] });
      const result = runtime.create({ ...scalarFields, emails: emails.slice(0, 2), phones: phones.slice(0, 1) });
      assert.equal(result.success, true, result.error);
      assert.equal(runtime.calls.vCardCards.length, 0);
      assert.equal(runtime.calls.flatCards.length, 1);
      assert.deepEqual(runtime.calls.factoryInterfaces, [runtime.Ci.nsIAbCard]);
      assert.strictEqual(book.calls.add[0], runtime.calls.flatCards[0]);

      const reloaded = book.reloadCard(result.id);
      assert.equal(reloaded.supportsVCard, false);
      assert.notStrictEqual(reloaded, runtime.calls.flatCards[0]);
      assert.equal(reloaded.getProperty("PrimaryEmail"), emails[0].address);
      assert.equal(reloaded.getProperty("SecondEmail"), emails[1].address);
      assert.equal(reloaded.getProperty("DisplayName"), scalarFields.displayName);
      assert.deepEqual(structuredClone(runtime.getContact(result.id)), {
        id: result.id, ...scalarFields, email: emails[0].address,
        emails: emails.slice(0, 2).map(({ address }) => ({ address })),
        phones: phones.slice(0, 1), addresses: [], addressBook: book.dirName, addressBookId: book.URI,
      });

      const rejected = runtime.create({ ...scalarFields, displayName: "Must not be written", emails });
      assert.match(rejected.error, /Non-vCard.*at most two email addresses/);
      assert.equal(runtime.calls.vCardCards.length, 0);
      assert.equal(runtime.calls.flatCards.length, 2);
      assert.deepEqual(runtime.calls.factoryInterfaces, [runtime.Ci.nsIAbCard, runtime.Ci.nsIAbCard]);
      const refusedCard = runtime.calls.flatCards[1];
      assert.equal(refusedCard.stored.size, 0);
      assert.deepEqual(refusedCard.writes, []);
      assert.equal(book.calls.add.length, 1);
      assert.equal(book.savedCards.size, 1);
      assert.equal(book.childCards.length, 1);
      assert.equal(runtime.getContact(result.id).displayName, scalarFields.displayName);
    });
  }
});

describe("createContact address book selection", () => {
  it("uses the first writable book by default", () => {
    const readOnly = new FakeAddressBook({ UID: "read-only", readOnly: true });
    const chosen = new FakeAddressBook({ UID: "chosen", dirName: "Writable", dirType: DIRECTORY_TYPES.CARDDAV_DIRECTORY_TYPE });
    const later = new FakeAddressBook({ UID: "later" });
    const runtime = loadContactRuntime({ books: [readOnly, chosen, later] });
    const result = runtime.create({ displayName: "Selected" });
    assert.equal(result.success, true, result.error);
    assert.equal(result.addressBook, chosen.dirName);
    assert.deepEqual([readOnly, chosen, later].map(book => book.calls.add.length), [0, 1, 0]);
  });

  for (const key of ["URI", "UID", "dirPrefId"]) {
    it(`selects an explicit book by ${key}`, () => {
      const first = new FakeAddressBook();
      const selected = new FakeAddressBook({
        UID: "selected-uid", URI: "jsaddrbook://selected.sqlite",
        dirPrefId: "ldap_2.servers.selected", dirName: "Selected Book",
      });
      const runtime = loadContactRuntime({ books: [first, selected] });
      const result = runtime.create({ displayName: "Explicit", addressBookId: selected[key] });
      assert.equal(result.success, true, result.error);
      assert.equal(result.addressBook, selected.dirName);
      assert.equal(first.calls.add.length, 0);
      assert.equal(selected.calls.add.length, 1);
      assert.equal(runtime.getContact(result.id).addressBookId, selected.URI);
    });
  }

  for (const [name, books, addressBookId, error] of [
    ["an absent explicit book", [new FakeAddressBook()], "missing-book", /Address book not found/],
    ["no books", [], undefined, /No writable address book/],
    ["only read-only books", [new FakeAddressBook({ readOnly: true })], undefined, /No writable address book/],
  ]) {
    it(`rejects ${name} without constructing or adding a card`, () => {
      const runtime = loadContactRuntime({ books });
      assert.match(runtime.create({ displayName: "Valid", addressBookId }).error, error);
      assert.deepEqual(runtime.calls.vCardCards, []);
      assert.deepEqual(runtime.calls.flatCards, []);
      assert.ok(books.every(book => book.calls.add.length === 0));
    });
  }
});

describe("createContact validation before construction", () => {
  for (const [name, fields, error] of [
    ["empty fields", {}, /non-empty contact field/],
    ["blank content", { displayName: " ", email: "", emails: [], phones: [], addresses: [] }, /non-empty contact field/],
    ["invalid scalar", { displayName: 42 }, /displayName must be a string/],
    ["invalid email collection", { emails: "ada@example.com" }, /emails must be an array/],
    ["invalid email type", { emails: [{ type: "other", address: "ada@example.com" }] }, /emails\[0\]\.type/],
    ["conflicting primary email", { email: "other@example.com", emails }, /email must equal emails\[0\]/],
    ["duplicate emails", { emails: [emails[0], { address: " ADA@WORK.EXAMPLE " }] }, /repeats an earlier address/],
    ["invalid phone", { phones: [{ type: "cell", number: "123" }] }, /phones\[0\]\.type/],
    ["empty address", { addresses: [{ type: "home" }] }, /non-empty address field/],
    ["invalid birthday", { birthday: "2023-02-29" }, /birthday must be/],
  ]) {
    it(`rejects ${name} without constructors or addCard`, () => {
      for (const dirType of [DIRECTORY_TYPES.JS_DIRECTORY_TYPE, DIRECTORY_TYPES.LDAP_DIRECTORY_TYPE]) {
        const book = new FakeAddressBook({ dirType });
        const runtime = loadContactRuntime({ books: [book] });
        assert.match(runtime.create(fields).error, error);
        assert.deepEqual(runtime.calls.vCardCards, []);
        assert.deepEqual(runtime.calls.flatCards, []);
        assert.deepEqual(runtime.calls.factoryInterfaces, []);
        assert.deepEqual(book.calls.add, []);
        assert.equal(book.savedCards.size, 0);
      }
    });
  }

  for (const [name, dirType] of [
    ["vCard", DIRECTORY_TYPES.JS_DIRECTORY_TYPE],
    ["flat", DIRECTORY_TYPES.LDAP_DIRECTORY_TYPE],
  ]) {
    it(`keeps phone-only display name synthesis for ${name} cards`, () => {
      const book = new FakeAddressBook({ dirType });
      const runtime = loadContactRuntime({ books: [book] });
      const result = runtime.create({ phones: [{ type: "mobile", number: "  +48 123 456 789  " }] });
      assert.equal(result.success, true, result.error);
      assert.equal(result.displayName, "+48 123 456 789");
      book.reloadCard(result.id);
      const contact = runtime.getContact(result.id);
      assert.equal(contact.displayName, "+48 123 456 789");
      assert.equal(contact.email, "");
      assert.deepEqual(structuredClone(contact.phones), [{ type: "mobile", number: "+48 123 456 789" }]);
    });
  }
});

describe("contact production module imports", () => {
  for (const esmUnavailable of [[], ["VCardUtils"], ["AddrBookCard"], ["VCardUtils", "AddrBookCard"]]) {
    it(`creates a vCard using ${esmUnavailable.length ? `JSM fallback for ${esmUnavailable.join(" and ")}` : "ESM modules"}`, () => {
      const runtime = loadContactRuntime({ esmUnavailable });
      const expectedImports = [];
      for (const name of ["VCardUtils", "AddrBookCard"]) {
        expectedImports.push({ method: "importESModule", uri: `resource:///modules/${name}.sys.mjs` });
        if (esmUnavailable.includes(name)) {
          expectedImports.push({ method: "import", uri: `resource:///modules/${name}.jsm` });
        }
      }
      assert.deepEqual(runtime.calls.imports, expectedImports);
      const result = runtime.create({ emails, phones });
      assert.equal(result.success, true, result.error);
      assert.equal(runtime.calls.vCardCards.length, 1);
      assert.equal(runtime.calls.flatCards.length, 0);
      runtime.books[0].reloadCard(result.id);
      assert.deepEqual(structuredClone(runtime.getContact(result.id).emails), emails);
    });
  }
});

describe("contact get/update/delete handler wiring", () => {
  it("finds a UID across books, skips mailing lists, and preserves native entries and metadata on update", () => {
    const primary = new FakeVCardPropertyEntry("email", { type: ["WORK", "internet"], pref: "1", group: "item1" }, "text", "first@example.com");
    const second = new FakeVCardPropertyEntry("email", { type: "home", pref: "2" }, "text", "second@example.com");
    const extra = new FakeVCardPropertyEntry("url", { group: "item1" }, "uri", "https://example.com");
    const properties = new FakeVCardProperties([second, extra, primary]);
    const card = new FakeAddrBookCard({ UID: "existing" }, properties);
    const mailingList = Object.assign(new FakeFlatCard({ UID: "existing", DisplayName: "A mailing list" }), { isMailList: true });
    const first = new FakeAddressBook({ cards: [mailingList] });
    const book = new FakeAddressBook({ UID: "second-book", dirName: "Second Book", cards: [card] });
    const runtime = loadContactRuntime({ books: [first, book] });

    const before = runtime.getContact(card.UID);
    assert.equal(before.addressBook, book.dirName);
    assert.equal(before.email, "first@example.com");
    assert.deepEqual(structuredClone(before.emails), [
      { type: "work", address: "first@example.com" }, { type: "home", address: "second@example.com" },
    ]);
    assert.deepEqual(properties.getAllEntriesSorted("email"), [primary, second]);
    assert.deepEqual(properties.getAllEntries("email"), [second, primary]);

    const params = primary.params;
    const changedEmails = [{ type: "work", address: "changed@example.com" }, { type: "home", address: "second@example.com" }];
    const result = runtime.update(card.UID, { ...scalarFields, emails: changedEmails, phones: phones.slice(0, 1) });
    assert.equal(result.success, true, result.error);
    assert.equal(result.email, "changed@example.com");
    assert.deepEqual(book.calls.modify, [card]);
    assert.deepEqual(first.calls.modify, []);
    assert.strictEqual(properties.getFirstEntry("email"), primary);
    assert.strictEqual(primary.params, params);
    assert.deepEqual(params, { type: ["WORK", "internet"], pref: "1", group: "item1" });
    assert.strictEqual(properties.getFirstEntry("url"), extra);
    const reloaded = book.reloadCard(card.UID);
    assert.notStrictEqual(reloaded, card);
    assert.notStrictEqual(reloaded.vCardProperties.getFirstEntry("email"), primary);
    assert.deepEqual(reloaded.vCardProperties.getFirstEntry("email").params, params);
    assert.equal(reloaded.vCardProperties.getFirstEntry("url").params.group, "item1");
    assert.deepEqual(structuredClone(runtime.getContact(card.UID).emails), changedEmails);

    assert.equal(runtime.update(card.UID, { email: "", emails: [], phones: [], note: "" }).success, true);
    const cleared = book.reloadCard(card.UID);
    assert.equal(cleared.vCardProperties.getAllEntries("email").length, 0);
    assert.equal(cleared.vCardProperties.getAllEntries("tel").length, 0);
    assert.equal(cleared.vCardProperties.getAllEntries("note").length, 0);
    assert.equal(cleared.vCardProperties.getFirstValue("url"), extra.value);

    assert.equal(runtime.deleteContact(card.UID).success, true);
    assert.deepEqual(book.calls.delete, [[cleared]]);
    assert.deepEqual(first.calls.delete, []);
    assert.equal(book.savedCards.size, 0);
    assert.match(runtime.getContact(card.UID).error, /Contact not found/);
  });

  it("updates, reloads and deletes flat cards through the production handlers", () => {
    const book = new FakeAddressBook({ dirType: DIRECTORY_TYPES.MAPI_DIRECTORY_TYPE });
    const runtime = loadContactRuntime({ books: [book] });
    const created = runtime.create({ email: "old@example.com", displayName: "Old" });
    assert.equal(created.success, true, created.error);
    const changed = runtime.update(created.id, { email: "new@example.com", firstName: "New", lastName: "Name", displayName: "New Name" });
    assert.equal(changed.success, true, changed.error);
    const reloaded = book.reloadCard(created.id);
    assert.equal(reloaded.getProperty("PrimaryEmail"), "new@example.com");
    assert.equal(reloaded.getProperty("FirstName"), "New");
    assert.equal(reloaded.getProperty("LastName"), "Name");
    assert.equal(runtime.getContact(created.id).displayName, "New Name");
    assert.equal(book.calls.modify.length, 1);
    assert.equal(runtime.deleteContact(created.id).success, true);
    assert.deepEqual(book.calls.delete, [[reloaded]]);
    assert.equal(book.childCards.length, 0);
    assert.match(runtime.getContact(created.id).error, /Contact not found/);
  });

  it("rejects invalid IDs, missing contacts and invalid updates without modifying or deleting cards", () => {
    const card = new FakeFlatCard({ UID: "existing", DisplayName: "Unchanged" });
    const book = new FakeAddressBook({ cards: [card] });
    const runtime = loadContactRuntime({ books: [book] });
    for (const id of [undefined, "", 42]) {
      assert.match(runtime.getContact(id).error, /contactId must be a non-empty string/);
      assert.match(runtime.update(id, { displayName: "Changed" }).error, /contactId must be a non-empty string/);
      assert.match(runtime.deleteContact(id).error, /contactId must be a non-empty string/);
    }
    assert.match(runtime.getContact("missing").error, /Contact not found/);
    assert.match(runtime.update("missing", { displayName: "Changed" }).error, /Contact not found/);
    assert.match(runtime.deleteContact("missing").error, /Contact not found/);
    assert.match(runtime.update(card.UID, { displayName: "Changed", birthday: "bad" }).error, /birthday must be/);
    assert.equal(card.displayName, "Unchanged");
    assert.deepEqual(card.writes, []);
    assert.deepEqual(book.calls.modify, []);
    assert.deepEqual(book.calls.delete, []);
  });
});
