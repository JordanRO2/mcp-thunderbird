"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  loadContactRuntime, FakeStoredCard, FakeVCardPropertyEntry, FakeFlatCard, FakeAddressBook,
} = require("./helpers/contact-runtime.cjs");

const CONTACT_ID = "contact-uid";
const DEFAULT_EMAILS = ["viliam.klocok@gmail.com", "v.klocok@example.org", "third@example.net"];
const DEFAULT_NAME = "Klocok, Viliam";

// Searched the contact runtime and other search fixtures: reuse the lazy card
// and native service fakes, supplying raw text and parsed entries separately.
// No matching, parsing or formatting implementation is copied into this test.
function makeSearchCard({
  emails = DEFAULT_EMAILS, displayName = DEFAULT_NAME, firstName = "Viliam",
  lastName = "Klocok", raw, parseMode, properties = {},
} = {}) {
  const entries = [
    new FakeVCardPropertyEntry("uid", {}, "text", CONTACT_ID),
    new FakeVCardPropertyEntry("fn", {}, "text", displayName),
    new FakeVCardPropertyEntry("n", {}, "text", [lastName, firstName, "", "", ""]),
    ...emails.map((address, index) => new FakeVCardPropertyEntry(
      "email", index === 0 ? { pref: "1" } : {}, "text", address
    )),
  ];
  return new FakeStoredCard({
    properties: {
      UID: CONTACT_ID, DisplayName: displayName, FirstName: firstName, LastName: lastName,
      PrimaryEmail: emails[0] || "", SecondEmail: emails[1] || "", ...properties,
    },
    entries, parseMode,
    raw: raw ?? ["BEGIN:VCARD", "VERSION:4.0", "FN:" + displayName,
      ...emails.map(address => "EMAIL:" + address), "END:VCARD", ""].join("\r\n"),
  });
}

function runtimeForCards(cards) {
  return loadContactRuntime({ books: [new FakeAddressBook({ cards })] });
}

describe("searchContacts production tokenization and results", () => {
  for (const query of [
    "Klocok Viliam", "Viliam Klocok", "Klocok, Viliam", "Viliam", "KLOCOK",
    DEFAULT_EMAILS[0], DEFAULT_EMAILS[1], DEFAULT_EMAILS[2],
    "example.org Viliam", "THIRD@EXAMPLE.NET Viliam", "gmail.com example.net",
  ]) {
    it("matches names and any address with query " + query, () => {
      const card = makeSearchCard();
      const runtime = runtimeForCards([card]);
      const results = runtime.searchContacts(query);
      assert.ok(Array.isArray(results));
      assert.equal(results.length, 1);
      assert.equal(results[0].id, CONTACT_ID);
      assert.deepEqual(structuredClone(results[0].emails), DEFAULT_EMAILS.map(address => ({ address })));
      assert.deepEqual(structuredClone(results[0]), structuredClone(runtime.getContact(CONTACT_ID)));
    });
  }

  it("matches the other reported CardDAV name order", () => {
    const card = makeSearchCard({ displayName: "Guedes, Robson", firstName: "Robson", lastName: "Guedes" });
    const runtime = runtimeForCards([card]);
    assert.equal(runtime.searchContacts("Robson Guedes").length, 1);
    assert.equal(runtime.searchContacts("Guedes Robson").length, 1);
  });

  for (const query of ["John Doe", "klocok@example.com", "Viliam missing", " , ", "   ", ",,,"]) {
    it("does not match query " + JSON.stringify(query), () => {
      const card = makeSearchCard();
      assert.equal(runtimeForCards([card]).searchContacts(query).length, 0);
      assert.equal(card.stats.parses, 0);
      assert.equal(card.stats.emailReads, 0);
    });
  }

  it("lists contacts for an empty query and excludes mailing lists", () => {
    const card = makeSearchCard();
    const list = new FakeFlatCard({ UID: "list", DisplayName: DEFAULT_NAME });
    list.isMailList = true;
    assert.deepEqual(Array.from(runtimeForCards([list, card]).searchContacts(""), item => item.id), [CONTACT_ID]);
    assert.equal(card.stats.emailReads, 0);
    assert.equal(card.stats.parses, 1, "only formatting needs the parsed details");
  });

  it("keeps flat cached fields searchable even if vCard-style getters throw", () => {
    const card = new FakeFlatCard({ UID: CONTACT_ID, DisplayName: DEFAULT_NAME, SecondEmail: DEFAULT_EMAILS[1] });
    Object.defineProperty(card, "emailAddresses", { get() { throw new Error("must not read"); } });
    const result = runtimeForCards([card]).searchContacts(DEFAULT_EMAILS[1])[0];
    assert.equal(result.id, CONTACT_ID);
    assert.equal(result.displayName, DEFAULT_NAME);
  });

  it("preserves default, capped, fractional and invalid result limits", () => {
    const cards = Array.from({ length: 205 }, (_, i) => new FakeFlatCard({ UID: "card-" + i }));
    const runtime = runtimeForCards(cards);
    for (const [requested, expected] of [
      [undefined, runtime.limits.DEFAULT_MAX_RESULTS], [0, runtime.limits.DEFAULT_MAX_RESULTS],
      [-1, runtime.limits.DEFAULT_MAX_RESULTS], [NaN, runtime.limits.DEFAULT_MAX_RESULTS],
      [Infinity, runtime.limits.DEFAULT_MAX_RESULTS], [3.9, 3],
      [1000, runtime.limits.MAX_SEARCH_RESULTS_CAP],
    ]) {
      const result = runtime.searchContacts("", requested);
      assert.equal(result.contacts.length, expected);
      assert.equal(result.hasMore, true);
      assert.ok(result.message.includes(String(expected)));
    }
    assert.ok(Array.isArray(runtimeForCards(cards.slice(0, 2)).searchContacts("", 3)));
  });
});

describe("searchContacts lazy parsing and raw prefilter", () => {
  for (const query of [DEFAULT_NAME, DEFAULT_EMAILS[0], DEFAULT_EMAILS[1]]) {
    it("matches cached fields before parsing for " + query, () => {
      // Cached matches must not depend on finding any token in the raw text.
      const card = makeSearchCard({ raw: "tokens intentionally absent" });
      assert.equal(runtimeForCards([card]).searchContacts(query).length, 1);
      assert.equal(card.stats.emailReads, 0, "matching did not ask for all parsed emails");
      assert.equal(card.stats.rawReads, 1, "only the formatter checked the stored vCard");
      assert.equal(card.stats.parses, 1, "only returned details require parsing");
      for (const name of ["DisplayName", "FirstName", "LastName", "PrimaryEmail", "SecondEmail"]) {
        assert.ok(card.stats.events.indexOf(name) < card.stats.events.indexOf("parse"));
      }
    });
  }

  it("checks only still-unmatched tokens against raw and parsed addresses", () => {
    const card = makeSearchCard({ raw: "BEGIN:VCARD\r\nEMAIL:" + DEFAULT_EMAILS[2] + "\r\nEND:VCARD\r\n" });
    assert.equal(runtimeForCards([card]).searchContacts("Viliam " + DEFAULT_EMAILS[2]).length, 1);
    assert.equal(card.stats.emailReads, 1);
    assert.equal(card.stats.parses, 1);
  });

  for (const continuation of ["\r\n ", "\r\n\t", "\n "]) {
    it("finds a third address split across " + JSON.stringify(continuation), () => {
      const card = makeSearchCard({ raw: "BEGIN:VCARD\r\nEMAIL:third@" + continuation + "example.net\r\nEND:VCARD\r\n" });
      assert.equal(runtimeForCards([card]).searchContacts(DEFAULT_EMAILS[2]).length, 1);
    });
  }

  for (const [address, serialized] of [
    ['"a\\b"@example.net', '"a\\\\b"@example.net'],
    ['"a;b"@example.net', '"a\\;b"@example.net'],
    ['"a:b"@example.net', '"a\\:b"@example.net'],
  ]) {
    it("admits escaped address " + address + " for parsed verification", () => {
      const card = makeSearchCard({
        emails: [...DEFAULT_EMAILS.slice(0, 2), address],
        raw: "BEGIN:VCARD\r\nEMAIL:" + serialized + "\r\nEND:VCARD\r\n",
      });
      assert.equal(runtimeForCards([card]).searchContacts(address).length, 1);
    });
  }

  for (const property of ["EMAIL", "item1.EMAIL;TYPE=work", "email;TYPE=\"home\""]) {
    it("lets Thunderbird decode Google-escaped addresses in " + property, () => {
      const address = '"a:b"@example.com';
      const card = makeSearchCard({
        emails: [...DEFAULT_EMAILS.slice(0, 2), address],
        // ICAL removes one escaping layer, then Google decoding removes the
        // remaining colon escape. The prefilter must not implement a decoder.
        raw: "BEGIN:VCARD\r\n" + property + ":" + String.raw`"a\\:b"@example.com` + "\r\nEND:VCARD\r\n",
      });
      const runtime = runtimeForCards([card]);
      assert.equal(runtime.getContact(CONTACT_ID).emails[2].address, address);
      assert.equal(runtime.searchContacts("Viliam " + address)[0]?.id, CONTACT_ID);
      assert.equal(card.stats.emailReads, 1, "the native address list verifies the decoded match");
      assert.equal(runtime.searchContacts('"not-the-address"@example.com').length, 0);
      assert.equal(card.stats.emailReads, 2, "conservative candidates still require a parsed match");
    });
  }

  it("does not parse plain emails because another property has quotes or backslashes", () => {
    const card = makeSearchCard({ raw: [
      "BEGIN:VCARD", "EMAIL:plain@example.com", String.raw`NOTE:Contains "quotes" and a \\ backslash`,
      String.raw`NOTE:EMAIL:"a\\:b"@example.com`, "END:VCARD", "",
    ].join("\r\n") });
    assert.equal(runtimeForCards([card]).searchContacts('"absent"@example.net').length, 0);
    assert.equal(card.stats.parses, 0);
    assert.equal(card.stats.emailReads, 0);
  });

  it("does not search notes, photos or other vCard properties as addresses", () => {
    const card = makeSearchCard({ raw: "BEGIN:VCARD\r\nNOTE:unrelated-token\r\nEND:VCARD\r\n" });
    assert.equal(runtimeForCards([card]).searchContacts("unrelated-token").length, 0);
    assert.equal(card.stats.emailReads, 1);
  });

  it("rejects large photo cards without parsing when raw text cannot match", () => {
    const photo = "A".repeat(30000);
    const cards = Array.from({ length: 100 }, () => makeSearchCard({
      raw: "BEGIN:VCARD\r\nPHOTO;ENCODING=b:" + photo + "\r\nEND:VCARD\r\n",
    }));
    assert.equal(runtimeForCards(cards).searchContacts("missing@example.net").length, 0);
    assert.ok(cards.every(card => card.stats.parses === 0 && card.stats.emailReads === 0));
  });
});

describe("corrupt stored vCards in production search and getContact", () => {
  for (const parseMode of ["empty", "null", "throw"]) {
    for (const query of [DEFAULT_EMAILS[0], DEFAULT_EMAILS[1], "Viliam", "Klocok", ""]) {
      it("retains cached matches and fields for " + parseMode + " parsing: " + JSON.stringify(query), () => {
        const broken = makeSearchCard({ parseMode, raw: "garbage" });
        const healthy = new FakeFlatCard({ UID: "healthy", DisplayName: "Healthy" });
        const runtime = runtimeForCards([broken, healthy]);
        const result = runtime.searchContacts(query);
        const found = result.find(item => item.id === CONTACT_ID);
        assert.ok(found, "cached contact must remain visible");
        assert.equal(found.email, DEFAULT_EMAILS[0]);
        assert.equal(found.displayName, DEFAULT_NAME);
        assert.equal(found.firstName, "Viliam");
        assert.equal(found.lastName, "Klocok");
        assert.deepEqual(structuredClone(found.emails), DEFAULT_EMAILS.slice(0, 2).map(address => ({ address })));
        assert.deepEqual(structuredClone(runtime.getContact(CONTACT_ID)), structuredClone(found));
        if (!query) assert.equal(result.length, 2, "a bad card must not hide other contacts");
      });
    }

    it("contains " + parseMode + " parsing failures after a raw prefilter hit", () => {
      const card = makeSearchCard({ parseMode, raw: "BEGIN:VCARD\r\nNOTE:unmatched-token\r\nEND:VCARD\r\n" });
      const runtime = runtimeForCards([card]);
      assert.equal(runtime.searchContacts("unmatched-token").length, 0);
      assert.equal(card.stats.emailReads, 1);
      assert.equal(runtime.searchContacts(DEFAULT_EMAILS[0]).length, 1, "still searchable after a failed parse");
      assert.equal(runtime.getContact(CONTACT_ID).email, DEFAULT_EMAILS[0]);
    });
  }

  it("falls back when raw property access itself throws", () => {
    const card = makeSearchCard({ parseMode: "throw" });
    const getProperty = card.getProperty.bind(card);
    card.getProperty = (name, fallback) => {
      if (name === "_vCard") throw new Error("raw property unavailable");
      return getProperty(name, fallback);
    };
    const runtime = runtimeForCards([card]);
    assert.equal(runtime.searchContacts("no-such-address").length, 0);
    assert.equal(runtime.searchContacts("Viliam")[0].email, DEFAULT_EMAILS[0]);
  });

  it("never substitutes cached primary data for a valid empty preferred entry", () => {
    const card = makeSearchCard({ emails: ["", DEFAULT_EMAILS[1]], properties: { PrimaryEmail: "stale@example.com" } });
    const runtime = runtimeForCards([card]);
    const result = runtime.getContact(CONTACT_ID);
    assert.equal(result.email, "");
    assert.deepEqual(structuredClone(result.emails), [{ address: DEFAULT_EMAILS[1] }]);
    assert.equal(card.primaryEmail, "");
  });
});
