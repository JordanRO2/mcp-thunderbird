"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  loadContactRuntime, DIRECTORY_TYPES, FakeVCardPropertyEntry, FakeVCardProperties,
  FakeFlatCard, FakeAddrBookCard, FakeStoredCard, FakeAddressBook,
} = require("./helpers/contact-runtime.cjs");

const VCARD_PROPERTY = "_vCard";
const VCARD_VERSION = "4.0";
const VCARD_LINE_ENDING = "\r\n";
const VCARD_BOOK_TYPES = [
  ["local", DIRECTORY_TYPES.JS_DIRECTORY_TYPE],
  ["CardDAV", DIRECTORY_TYPES.CARDDAV_DIRECTORY_TYPE],
];
const NAME_FIELDS = ["displayName", "firstName", "lastName"];
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

describe("stored vCard fixture fidelity", () => {
  it("serializes supported values and metadata without sharing nested data across saves and loads", () => {
    const uid = "serialized-contact";
    const params = {
      type: ["WoRk", "internet"], pref: "1", group: "item7",
      "x-label": 'Desk, west; "A"\nLevel^2', pid: ["1.1", "2.1"],
    };
    const structuredName = [["Love;lace", "By,ron"], ["Ada", "Augusta"], "", "", ""];
    const properties = new FakeVCardProperties([
      new FakeVCardPropertyEntry("uid", {}, "text", uid),
      new FakeVCardPropertyEntry("fn", {}, "text", "Ada, Countess; C:\\notes\nNext"),
      new FakeVCardPropertyEntry("n", {}, "text", structuredName),
      new FakeVCardPropertyEntry("email", params, "text", '"a;b\\c"@example.net'),
      new FakeVCardPropertyEntry("adr", { group: "item8", type: "HoMe" }, "text",
        ["PO;1", "", ["Main, St", "Floor\\2"], "Paris", "", "", ""]),
      new FakeVCardPropertyEntry("org", {}, "text", ["Analytical; Engines", "R&D, team"]),
      new FakeVCardPropertyEntry("nickname", {}, "text", ["Ada, A", "Countess; C"]),
      new FakeVCardPropertyEntry("note", {}, "text", ["line1\r\nline2", "line3\rline4"]),
      new FakeVCardPropertyEntry("url", { group: "item7" }, "uri", "https://example.com/a;b?q=x,y"),
      new FakeVCardPropertyEntry("bday", {}, "date", "--12-10"),
    ]);
    const expectedRaw = [
      "BEGIN:VCARD", "VERSION:" + VCARD_VERSION, "UID:" + uid,
      "FN:Ada\\, Countess\\; C:\\\\notes\\nNext",
      "N:Love\\;lace,By\\,ron;Ada,Augusta;;;",
      "item7.EMAIL;TYPE=WoRk,internet;PREF=1;X-LABEL=\"Desk, west; ^'A^'^nLevel^^2\";PID=1.1,2.1:\"a\\;b\\\\c\"@example.net",
      "item8.ADR;TYPE=HoMe:PO\\;1;;Main\\, St,Floor\\\\2;Paris;;;",
      "ORG:Analytical\\; Engines;R&D\\, team",
      "NICKNAME:Ada\\, A,Countess\\; C",
      "NOTE:line1\\nline2,line3\\nline4",
      "item7.URL;VALUE=URI:https://example.com/a;b?q=x,y",
      "BDAY;VALUE=DATE:--12-10", "END:VCARD", "",
    ].join(VCARD_LINE_ENDING);
    assert.equal(properties.toVCard(), expectedRaw);

    const book = new FakeAddressBook();
    const loaded = book.addCard(new FakeAddrBookCard({ UID: uid }, properties));
    assert.equal(loaded.getProperty(VCARD_PROPERTY), expectedRaw);
    assert.equal(loaded.firstName, "Ada Augusta");
    assert.equal(loaded.lastName, "Love;lace By,ron");
    assert.equal(loaded.parsed, false);
    params.type[0] = "Unsaved source type";
    structuredName[0][0] = "Unsaved source name";
    loaded.vCardProperties.getFirstEntry("email").params.type[1] = "Unsaved loaded type";
    loaded.vCardProperties.getFirstEntry("n").value[0][1] = "Unsaved loaded name";
    const fresh = book.reloadCard(uid);
    assert.equal(fresh.getProperty(VCARD_PROPERTY), expectedRaw);
    assert.equal(fresh.vCardProperties.toVCard(), expectedRaw);
    assert.equal(book.savedCards.get(uid).vCardProperties.toVCard(), expectedRaw);
  });

  it("forwards the reloaded primaryEmail setter and rebuilds its cache on save", () => {
    const book = new FakeAddressBook();
    const runtime = loadContactRuntime({ books: [book] });
    const created = runtime.create({ emails });
    assert.equal(created.success, true, created.error);
    const loaded = book.reloadCard(created.id);
    const replacementAddress = "updated@example.com";
    loaded.primaryEmail = replacementAddress;
    assert.equal(loaded.primaryEmail, replacementAddress);
    assert.equal(loaded.stats.parses, 1);
    assert.equal(loaded.getProperty("PrimaryEmail"), emails[0].address, "cache changes only on save");
    book.modifyCard(loaded);
    const fresh = book.reloadCard(created.id);
    assert.equal(fresh.primaryEmail, replacementAddress);
    assert.equal(fresh.parsed, false);
    assert.equal(runtime.searchContacts(replacementAddress)[0].id, created.id);
    assert.equal(runtime.searchContacts(emails[0].address).length, 0);
  });
});

describe("createContact native card selection and persistence", () => {
  for (const [name, dirType] of VCARD_BOOK_TYPES) {
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
      assert.ok(firstLoad instanceof FakeStoredCard);
      assert.equal(firstLoad.parsed, false, "create response uses the saved scalar caches");
      assert.equal(firstLoad.displayName, scalarFields.displayName);
      assert.equal(firstLoad.firstName, scalarFields.firstName);
      assert.equal(firstLoad.lastName, scalarFields.lastName);
      assert.equal(firstLoad.primaryEmail, emails[0].address);
      assert.equal(firstLoad.getProperty("SecondEmail"), emails[1].address);
      const raw = firstLoad.getProperty(VCARD_PROPERTY);
      assert.ok(raw.startsWith("BEGIN:VCARD" + VCARD_LINE_ENDING + "VERSION:" + VCARD_VERSION + VCARD_LINE_ENDING));
      assert.ok(raw.endsWith("END:VCARD" + VCARD_LINE_ENDING));
      assert.ok(raw.includes(`UID:${result.id}${VCARD_LINE_ENDING}`));
      assert.ok(raw.includes("NOTE:First line\\nSecond line" + VCARD_LINE_ENDING));
      for (const { address } of emails) assert.ok(raw.includes(address));
      assert.equal(firstLoad.stats.parses, 0, "cached scalars and raw text do not parse");
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
      assert.equal(reloaded.getProperty("DisplayName"), scalarFields.displayName);
      assert.equal(reloaded.getProperty("FirstName"), scalarFields.firstName);
      assert.equal(reloaded.getProperty("LastName"), scalarFields.lastName);
      assert.equal(reloaded.getProperty("PrimaryEmail"), emails[0].address);
      assert.equal(reloaded.getProperty("SecondEmail"), emails[1].address);
      assert.equal(reloaded.getProperty(VCARD_PROPERTY), raw);
      assert.equal(reloaded.parsed, false);
      assert.equal(reloaded.vCardProperties.getFirstValue("version"), VCARD_VERSION);
      assert.equal(reloaded.vCardProperties.getFirstValue("fn"), scalarFields.displayName);
      assert.deepEqual(reloaded.vCardProperties.getFirstValue("n"), ["Lovelace", "Ada", "", "", ""]);
      assert.deepEqual(reloaded.emailAddresses, emails.map(email => email.address));
      assert.equal(reloaded.primaryEmail, emails[0].address);
      assert.deepEqual(reloaded.vCardProperties.getAllEntries("email").map(entry => entry.params.pref), ["1", undefined, undefined]);
      assert.deepEqual(reloaded.vCardProperties.getAllEntries("tel").map(entry => entry.params.type), ["cell", "cell"]);
      const expectedContact = {
        id: result.id, ...scalarFields, email: emails[0].address, emails, phones, addresses,
        addressBook: book.dirName, addressBookId: book.URI,
      };
      assert.deepEqual(structuredClone(runtime.getContact(result.id)), expectedContact);
      for (const query of [...NAME_FIELDS.map(field => scalarFields[field]), ...emails.map(email => email.address)]) {
        const fresh = book.reloadCard(result.id);
        assert.equal(fresh.parsed, false);
        const matches = runtime.searchContacts(query);
        assert.deepEqual(structuredClone(matches), [expectedContact], query);
        assert.equal(fresh.stats.parses, 1);
        assert.equal(fresh.stats.emailReads, query === emails[2].address ? 1 : 0,
          "only the third address needs parsed matching; names and the first two use caches");
      }
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
  for (const [name, dirType] of VCARD_BOOK_TYPES) {
    it(`replaces stale caches and raw data when updating and clearing a reloaded ${name} card`, () => {
      const book = new FakeAddressBook({ dirType });
      const runtime = loadContactRuntime({ books: [book] });
      const created = runtime.create({ ...scalarFields, emails });
      assert.equal(created.success, true, created.error);
      const originalSnapshot = book.savedCards.get(created.id);
      const originalRaw = originalSnapshot.getProperty(VCARD_PROPERTY);
      const originalQueries = [...NAME_FIELDS.map(field => scalarFields[field]), ...emails.map(email => email.address)];
      const changedNames = { displayName: "Rear Admiral", firstName: "Grace", lastName: "Hopper" };
      const changedEmails = [
        { type: "work", address: "grace@navy.example" },
        { type: "home", address: "grace@home.example" },
        { address: "grace@research.example" },
      ];
      const changedQueries = [...Object.values(changedNames), ...changedEmails.map(email => email.address)];
      const live = book.reloadCard(created.id);
      assert.equal(live.parsed, false);
      const changed = runtime.update(created.id, { ...changedNames, emails: changedEmails });
      assert.equal(changed.success, true, changed.error);
      assert.deepEqual(book.calls.modify, [live]);
      assert.equal(originalSnapshot.getProperty(VCARD_PROPERTY), originalRaw, "previous snapshots stay independent");

      const reloaded = book.reloadCard(created.id);
      for (const [property, value] of Object.entries({
        DisplayName: changedNames.displayName, FirstName: changedNames.firstName, LastName: changedNames.lastName,
        PrimaryEmail: changedEmails[0].address, SecondEmail: changedEmails[1].address,
      })) {
        assert.equal(reloaded.getProperty(property), value);
      }
      const changedRaw = reloaded.getProperty(VCARD_PROPERTY);
      assert.notEqual(changedRaw, originalRaw);
      for (const query of changedQueries) assert.ok(changedRaw.includes(query), query);
      for (const query of originalQueries) assert.ok(!changedRaw.includes(query), query);
      assert.equal(reloaded.parsed, false);
      assert.equal(changedRaw, book.savedCards.get(created.id).vCardProperties.toVCard());

      for (const query of changedQueries) {
        const fresh = book.reloadCard(created.id);
        const matches = runtime.searchContacts(query);
        assert.equal(matches.length, 1, query);
        assert.equal(matches[0].id, created.id);
        for (const field of NAME_FIELDS) assert.equal(matches[0][field], changedNames[field]);
        assert.deepEqual(structuredClone(matches[0].emails), changedEmails);
        assert.equal(fresh.stats.emailReads, query === changedEmails[2].address ? 1 : 0);
      }
      for (const query of originalQueries) {
        book.reloadCard(created.id);
        assert.equal(runtime.searchContacts(query).length, 0, query);
      }

      const cleared = runtime.update(created.id, { displayName: "", firstName: "", lastName: "", emails: [] });
      assert.equal(cleared.success, true, cleared.error);
      const empty = book.reloadCard(created.id);
      for (const property of ["DisplayName", "FirstName", "LastName", "PrimaryEmail", "SecondEmail"]) {
        assert.equal(empty.getProperty(property), "", property);
      }
      assert.equal(empty.stored.has("PrimaryEmail"), false);
      assert.equal(empty.stored.has("SecondEmail"), false);
      const emptyRaw = empty.getProperty(VCARD_PROPERTY);
      assert.notEqual(emptyRaw, changedRaw);
      assert.equal(empty.parsed, false);
      for (const query of [...originalQueries, ...changedQueries]) {
        assert.ok(!emptyRaw.includes(query), query);
        book.reloadCard(created.id);
        assert.equal(runtime.searchContacts(query).length, 0, query);
      }
      assert.deepEqual(structuredClone(runtime.getContact(created.id).emails), []);
    });
  }

  for (const [name, dirType] of [
    ["vCard", DIRECTORY_TYPES.JS_DIRECTORY_TYPE], ["flat", DIRECTORY_TYPES.LDAP_DIRECTORY_TYPE],
  ]) {
    it(`rejects control characters before constructing or modifying ${name} cards`, () => {
      const book = new FakeAddressBook({ dirType });
      const runtime = loadContactRuntime({ books: [book] });
      const created = runtime.create({ displayName: "Unchanged", emails: emails.slice(0, 2) });
      const before = structuredClone(runtime.getContact(created.id));
      // C0, DEL and C1 are forbidden, including whitespace that trim() would remove.
      for (const control of ["\0", "\t", "\n", "\r", "\x1f", "\x7f", "\x85", "\x9f"]) {
        for (const fields of [
          { email: `ada${control}@example.com` },
          { emails: [{ address: `ada@example.com${control}` }] },
        ]) {
          assert.match(runtime.create(fields).error, /must not contain control characters/);
          assert.match(runtime.update(created.id, { displayName: "Must not change", ...fields }).error, /must not contain control characters/);
          assert.deepEqual(structuredClone(runtime.getContact(created.id)), before);
        }
      }
      assert.equal(runtime.calls.vCardCards.length + runtime.calls.flatCards.length, 1);
      assert.equal(book.calls.add.length, 1);
      assert.deepEqual(book.calls.modify, []);
    });

    it(`accepts non-ASCII and quoted punctuation in ${name} addresses`, () => {
      const runtime = loadContactRuntime({ books: [new FakeAddressBook({ dirType })] });
      const address = '"é;x:y"@例え.example';
      const created = runtime.create({ email: address, emails: [{ address }] });
      assert.equal(created.success, true, created.error);
      assert.equal(runtime.getContact(created.id).email, address);
    });

    it(`documents scalar empty-email clearing through the ${name} handler`, () => {
      const book = new FakeAddressBook({ dirType });
      const runtime = loadContactRuntime({ books: [book] });
      const created = runtime.create({ emails: emails.slice(0, 2) });
      assert.equal(runtime.update(created.id, { email: "" }).success, true);
      book.reloadCard(created.id);
      const read = runtime.getContact(created.id);
      assert.equal(read.email, "");
      assert.deepEqual(structuredClone(read.emails), name === "vCard" ? [] : [{ address: emails[1].address }]);
      assert.equal(runtime.update(created.id, { emails: [] }).success, true);
      book.reloadCard(created.id);
      assert.deepEqual(structuredClone(runtime.getContact(created.id).emails), []);
    });
  }

  it("reads duplicates without deduplication and refuses their write-back before mutation", () => {
    const card = new FakeAddrBookCard({ UID: "duplicates" }, new FakeVCardProperties([
      new FakeVCardPropertyEntry("fn", {}, "text", "Unchanged"),
      new FakeVCardPropertyEntry("email", { pref: "1", type: "work" }, "text", "same@example.com"),
      new FakeVCardPropertyEntry("email", { type: "home" }, "text", "SAME@example.com"),
    ]));
    const book = new FakeAddressBook({ cards: [card] });
    const runtime = loadContactRuntime({ books: [book] });
    const before = structuredClone(runtime.getContact(card.UID));
    assert.deepEqual(before.emails, [
      { type: "work", address: "same@example.com" }, { type: "home", address: "SAME@example.com" },
    ]);
    assert.match(runtime.update(card.UID, { displayName: "Must not change", emails: before.emails }).error, /repeats an earlier address/);
    assert.deepEqual(structuredClone(runtime.getContact(card.UID)), before);
    assert.deepEqual(book.calls.modify, []);
  });

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
