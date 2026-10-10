"use strict";

/**
 * Tests for saved-search (virtual folder) term construction.
 *
 * A saved search has no nsIMsgFilter to mint terms from, so buildSearchTerms
 * runs buildTerms against a throwaway nsIMsgSearchSession. These tests pin
 * that the session is a faithful stand-in: the same allow-lists, header
 * handling and typed nsIMsgSearchValue writes apply, and the terms come back
 * in order from the session.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Subset of nsMsgSearchAttrib / nsMsgSearchOp (nsMsgSearchCore.idl) with the
// real, non-contiguous values.
const ATTRIB = {
  Subject: 0, Sender: 1, Body: 2, Date: 3, Priority: 4, MsgStatus: 5,
  To: 6, CC: 7, ToOrCC: 8, AllAddresses: 9, AgeInDays: 12, Size: 14,
  Keywords: 16, HasAttachmentStatus: 44, JunkStatus: 45, JunkPercent: 46,
  OtherHeader: 52,
};
const OPS = {
  Contains: 0, DoesntContain: 1, Is: 2, Isnt: 3, IsEmpty: 4, IsBefore: 5,
  IsAfter: 6, BeginsWith: 9, EndsWith: 10, IsGreaterThan: 13, IsLessThan: 14,
  Matches: 19, DoesntMatch: 20,
};
const ATTACHMENT_FLAG = 0x10000000; // nsMsgMessageFlags.Attachment

// Which nsIMsgSearchValue accessor is legal for which attribute; anything
// not listed uses .str (IS_STRING_ATTRIBUTE in nsMsgSearchCore.idl).
const LEGAL_ACCESSOR = {
  [ATTRIB.Priority]: "priority",
  [ATTRIB.MsgStatus]: "status",
  [ATTRIB.Date]: "date",
  [ATTRIB.AgeInDays]: "age",
  [ATTRIB.Size]: "size",
  [ATTRIB.JunkStatus]: "junkStatus",
  [ATTRIB.JunkPercent]: "junkPercent",
  [ATTRIB.HasAttachmentStatus]: "status",
};

// The real Ci answers named property access but reports no own keys.
function nonEnumerable(constants) {
  return new Proxy({}, {
    get: (_t, name) => constants[name],
    has: (_t, name) => name in constants,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

// An nsIMsgSearchValue stand-in that throws, like XPCOM does, when the
// accessor does not match the attribute's type.
function makeSearchValue() {
  const state = { attrib: undefined, stored: undefined };
  const value = {
    get attrib() { return state.attrib; },
    set attrib(v) { state.attrib = v; },
  };
  const check = (accessor) => {
    const legal = LEGAL_ACCESSOR[state.attrib] || "str";
    if (accessor !== legal) {
      throw new Error(`NS_ERROR_ILLEGAL_VALUE [nsIMsgSearchValue.${accessor}]`);
    }
  };
  for (const accessor of ["str", "priority", "date", "status", "size", "age", "junkStatus", "junkPercent"]) {
    Object.defineProperty(value, accessor, {
      enumerable: true,
      get() { check(accessor); return state.stored; },
      set(v) { check(accessor); state.stored = v; },
    });
  }
  return value;
}

function makeSearchTerm() {
  return { attrib: undefined, op: undefined, booleanAnd: undefined, arbitraryHeader: "", value: makeSearchValue() };
}

// nsIMsgSearchSession: the createTerm/appendTerm/searchTerms trio that
// buildTerms otherwise gets from a filter.
function makeSearchSession() {
  const terms = [];
  return {
    createTerm: makeSearchTerm,
    appendTerm(term) { terms.push(term); },
    get searchTerms() { return terms.slice(); },
  };
}

function loadHelpers() {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const slice = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0, `${startMarker} missing`);
    assert.ok(end > start, `${endMarker} missing`);
    return source.slice(start, end);
  };

  let sessions = 0;
  const sandbox = {
    Ci: {
      nsMsgSearchAttrib: nonEnumerable(ATTRIB),
      nsMsgSearchOp: nonEnumerable(OPS),
      nsMsgFilterAction: nonEnumerable({}),
      nsMsgFilterType: nonEnumerable({}),
      nsMsgMessageFlags: nonEnumerable({ Attachment: ATTACHMENT_FLAG }),
      nsMsgPriority: nonEnumerable({}),
      nsIMsgSearchSession: {},
    },
    Cc: {
      "@mozilla.org/messenger/searchSession;1": {
        createInstance: () => { sessions += 1; return makeSearchSession(); },
      },
    },
    Services: {
      prefs: {
        getCharPref: (_name, fallback) => fallback,
        getBoolPref: (_name, fallback) => fallback,
      },
    },
    sessionCount: () => sessions,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"), sandbox);
  // The other helpers in the block resolve MailServices/ChromeUtils lazily at
  // call time, so declaring them needs no further stubs.
  vm.runInContext(`${slice("// BEGIN VIRTUAL FOLDER (SAVED SEARCH) HELPERS", "// END VIRTUAL FOLDER (SAVED SEARCH) HELPERS")}
this.buildSearchTerms = buildSearchTerms;`, sandbox);
  return sandbox;
}

const helpers = loadHelpers();
const { buildSearchTerms } = helpers;

describe("buildSearchTerms - terms via a throwaway search session", () => {
  it("returns the session's terms in condition order", () => {
    const before = helpers.sessionCount();
    const terms = buildSearchTerms([
      { attrib: "from", op: "contains", value: "invoice@example.com" },
      { attrib: "subject", op: "beginsWith", value: "Re:" },
    ]);
    assert.equal(helpers.sessionCount(), before + 1);
    assert.equal(terms.length, 2);
    assert.equal(terms[0].attrib, ATTRIB.Sender);
    assert.equal(terms[0].op, OPS.Contains);
    assert.equal(terms[0].value.str, "invoice@example.com");
    assert.equal(terms[1].attrib, ATTRIB.Subject);
    assert.equal(terms[1].op, OPS.BeginsWith);
  });

  it("writes the typed union member, not .str, for hasAttachment", () => {
    const [term] = buildSearchTerms([{ attrib: "hasAttachment", op: "is" }]);
    assert.equal(term.attrib, ATTRIB.HasAttachmentStatus);
    assert.equal(term.value.status, ATTACHMENT_FLAG);
    assert.throws(() => term.value.str, /ILLEGAL_VALUE/);
  });

  it("writes integer attributes through their own members and rejects junk", () => {
    const [size, age] = buildSearchTerms([
      { attrib: "size", op: "isGreaterThan", value: "1024" },
      { attrib: "ageInDays", op: "isGreaterThan", value: "30" },
    ]);
    assert.equal(size.value.size, 1024);
    assert.equal(age.value.age, 30);
    assert.throws(
      () => buildSearchTerms([{ attrib: "ageInDays", op: "isGreaterThan", value: "30abc" }]),
      /must be/
    );
  });

  it("rejects attributes and operators outside the allow-list, including raw enum values", () => {
    assert.throws(() => buildSearchTerms([{ attrib: "nope", op: "contains", value: "x" }]), /Unknown attribute/);
    assert.throws(() => buildSearchTerms([{ attrib: "subject", op: "nope", value: "x" }]), /Unknown operator/);
    assert.throws(() => buildSearchTerms([{ attrib: 44, op: 2, value: "x" }]), /Unknown attribute/);
  });

  it("requires a header for otherHeader and stores it on the term", () => {
    const [term] = buildSearchTerms([
      { attrib: "otherHeader", op: "contains", value: "bulk", header: "X-Precedence" },
    ]);
    assert.equal(term.arbitraryHeader, "X-Precedence");
    assert.ok(term.attrib > ATTRIB.OtherHeader, "arbitrary-header terms use an id above OtherHeader");
    assert.throws(
      () => buildSearchTerms([{ attrib: "otherHeader", op: "contains", value: "bulk" }]),
      /requires a "header" name/
    );
  });

  it("defaults booleanAnd to true and honours an explicit false", () => {
    const [a, b] = buildSearchTerms([
      { attrib: "subject", op: "contains", value: "Rechnung" },
      { attrib: "subject", op: "contains", value: "Invoice", booleanAnd: false },
    ]);
    assert.equal(a.booleanAnd, true);
    assert.equal(b.booleanAnd, false);
  });
});
