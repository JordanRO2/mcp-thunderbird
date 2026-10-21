"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  loadContactRuntime, FakeStoredCard, FakeAddressBook,
} = require("./helpers/contact-runtime.cjs");

const RAW_VCARD_PROPERTY = "_vCard";
const CACHED_CONTACT = {
  UID: "corrupt-contact", DisplayName: "Cached Name", FirstName: "Cached", LastName: "Name",
  PrimaryEmail: "old@example.com", SecondEmail: "second@example.com", Custom1: "Keep custom data",
};
const CORRUPT_VCARD = [
  "BEGIN:VCARD", "VERSION:4.0", "UID:corrupt-contact", "FN:Cached Name", "N:Name;Cached;;;",
  "EMAIL:old@example.com", "TEL;TYPE=cell:123", "NOTE:Keep this note", "X-CUSTOM:Keep this property",
  "THIS LINE HAS NO COLON", "END:VCARD", "",
].join("\r\n");

describe("updateContact refuses unreadable stored vCards before mutation", () => {
  for (const parseMode of ["empty", "null", "throw"]) {
    for (const [field, fields] of [
      ["emails", { emails: [{ address: "new@example.com" }] }],
      ["clearing emails", { emails: [] }],
      ["email", { email: "new@example.com" }],
      ["clearing email", { email: "" }],
      ["displayName", { displayName: "Changed" }],
      ["firstName", { firstName: "Changed" }],
      ["lastName", { lastName: "Changed" }],
      ["phones", { phones: [{ type: "mobile", number: "456" }] }],
      ["addresses", { addresses: [{ type: "home", city: "Changed" }] }],
      ["organization", { organization: "Changed" }],
      ["title", { title: "Changed" }],
      ["note", { note: "Changed" }],
      ["birthday", { birthday: "2000-01-01" }],
      ["mixed scalar and collection", { displayName: "Changed", emails: [{ address: "new@example.com" }] }],
      ["no fields", {}],
    ]) {
      it(`refuses ${field} when parsing returns ${parseMode}, without saving or changing cached data`, () => {
        // Reuse the lazy-card fixture; the production shared read/write check
        // must identify all native parser failure modes, including VERSION-only.
        const card = new FakeStoredCard({ properties: CACHED_CONTACT, raw: CORRUPT_VCARD, parseMode });
        const book = new FakeAddressBook({ cards: [card] });
        const runtime = loadContactRuntime({ books: [book] });
        const before = structuredClone(card.stored);
        const result = runtime.update(CACHED_CONTACT.UID, fields);

        assert.match(result.error, /stored vCard.*unreadable.*refusing to overwrite/i);
        assert.deepEqual(book.calls.modify, []);
        assert.deepEqual(book.calls.add, []);
        assert.equal(book.savedCards.size, 0);
        assert.deepEqual(card.writes, []);
        assert.deepEqual(card.stored, before);
        assert.equal(card.getProperty(RAW_VCARD_PROPERTY), CORRUPT_VCARD);
        if (parseMode === "empty") {
          assert.deepEqual(card.vCardProperties.entries.map(entry => entry.name), ["version"]);
        }
        const read = runtime.getContact(CACHED_CONTACT.UID);
        assert.equal(read.displayName, CACHED_CONTACT.DisplayName);
        assert.equal(read.email, CACHED_CONTACT.PrimaryEmail);
      });
    }
  }
});
