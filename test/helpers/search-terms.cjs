"use strict";

// The real nsMsgSearchAttrib enum, from
// comm-central/mailnews/search/public/nsMsgSearchCore.idl. Note the gaps: the
// enum is not contiguous past AllAddresses(9), which is what the original
// ATTRIB_MAP got wrong.
const ATTRIB = {
  Custom: -2, Default: -1,
  Subject: 0, Sender: 1, Body: 2, Date: 3, Priority: 4, MsgStatus: 5,
  To: 6, CC: 7, ToOrCC: 8, AllAddresses: 9, Location: 10, MessageKey: 11,
  AgeInDays: 12, FolderInfo: 13, Size: 14, AnyText: 15, Keywords: 16,
  HasAttachmentStatus: 44, JunkStatus: 45, JunkPercent: 46, JunkScoreOrigin: 47,
  HdrProperty: 49, FolderFlag: 50, Uint32HdrProperty: 51, OtherHeader: 52,
};

const ATTACHMENT_FLAG = 0x10000000; // nsMsgMessageFlags.Attachment

// nsMsgMessageFlags (nsMsgMessageFlags.idl) -- the bits the filter UI offers
// as "status", plus the attachment flag hasAttachment stores.
const MESSAGE_FLAGS = {
  Read: 0x1, Replied: 0x2, Marked: 0x4, Forwarded: 0x1000, New: 0x10000,
  Attachment: ATTACHMENT_FLAG,
};

// nsMsgPriority (MailNewsTypes2.idl).
const PRIORITY = { notSet: 0, none: 1, lowest: 2, low: 3, normal: 4, high: 5, highest: 6, Default: 4 };

// The real nsMsgFilterAction enum (nsMsgFilterCore.idl). Note the hole at 8:
// Label existed only up to TB 102.
const ACTIONS = {
  Custom: -1, None: 0, MoveToFolder: 1, ChangePriority: 2, Delete: 3,
  MarkRead: 4, KillThread: 5, WatchThread: 6, MarkFlagged: 7, Reply: 9,
  Forward: 10, StopExecution: 11, DeleteFromPop3Server: 12,
  LeaveOnPop3Server: 13, JunkScore: 14, FetchBodyFromPop3Server: 15,
  CopyToFolder: 16, AddTag: 17, KillSubthread: 18, MarkUnread: 19,
};

const LEGACY_ATTRIB = { Label: 48 };
const LEGACY_ACTIONS = { Label: 8 };
const FILTER_TYPES = {
  None: 0, InboxRule: 1, InboxJavaScript: 2, Inbox: 3,
  NewsRule: 4, NewsJavaScript: 8, News: 12, Incoming: 15,
  Manual: 16, PostPlugin: 32, PostOutgoing: 64, Archive: 128, Periodic: 256,
  All: 31,
};

// The real nsMsgSearchOp enum (nsMsgSearchCore.idl), including the
// kNumMsgSearchOperators sentinel that must NOT become an operator.
const OPS = {
  Contains: 0, DoesntContain: 1, Is: 2, Isnt: 3, IsEmpty: 4,
  IsBefore: 5, IsAfter: 6, IsHigherThan: 7, IsLowerThan: 8,
  BeginsWith: 9, EndsWith: 10, SoundsLike: 11, LdapDwim: 12,
  IsGreaterThan: 13, IsLessThan: 14, NameCompletion: 15,
  IsInAB: 16, IsntInAB: 17, IsntEmpty: 18, Matches: 19, DoesntMatch: 20,
  kNumMsgSearchOperators: 21,
};

// Which nsIMsgSearchValue accessor is legal for which attribute. Mirrors
// IS_STRING_ATTRIBUTE in nsMsgSearchCore.idl and Thunderbird's
// searchWidgets.js save()/updateDisplay(); anything not listed uses .str.
const LEGAL_ACCESSOR = {
  [ATTRIB.Priority]: "priority",
  [ATTRIB.MsgStatus]: "status",
  [ATTRIB.Date]: "date",
  [ATTRIB.AgeInDays]: "age",
  [ATTRIB.Size]: "size",
  [ATTRIB.JunkStatus]: "junkStatus",
  [ATTRIB.JunkPercent]: "junkPercent",
  [ATTRIB.HasAttachmentStatus]: "status",
  [ATTRIB.FolderFlag]: "status",
  [ATTRIB.Uint32HdrProperty]: "status",
  [LEGACY_ATTRIB.Label]: "label",
};

// The real extension context exposes Ci as a wrapper that answers named
// property access but reports no own keys -- Object.keys/entries come back
// empty. Model that exactly, so an enumeration-based implementation cannot
// pass these tests again.
function nonEnumerable(constants) {
  return new Proxy({}, {
    get: (_t, name) => constants[name],
    has: (_t, name) => name in constants,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

function makeCi(overrides = {}) {
  const attribs = { ...ATTRIB, ...(overrides.attribs || {}) };
  for (const name of overrides.removeAttribs || []) delete attribs[name];
  return {
    nsMsgSearchAttrib: nonEnumerable(attribs),
    nsMsgSearchOp: nonEnumerable({ ...OPS }),
    nsMsgFilterAction: nonEnumerable({ ...ACTIONS, ...(overrides.actions || {}) }),
    nsMsgFilterType: nonEnumerable({ ...FILTER_TYPES, ...(overrides.filterTypes || {}) }),
    nsMsgMessageFlags: nonEnumerable({ ...MESSAGE_FLAGS }),
    nsMsgPriority: nonEnumerable({ ...PRIORITY }),
  };
}

// An nsIMsgSearchValue stand-in that enforces the union rule the real XPCOM
// object enforces: "accessing these will throw an exception if the above
// attribute does not match the type!"
function makeSearchValue() {
  const state = { attrib: undefined, stored: undefined };
  const value = {
    get attrib() { return state.attrib; },
    set attrib(v) { state.attrib = v; },
  };
  const check = (accessor) => {
    const legal = LEGAL_ACCESSOR[state.attrib] || "str";
    if (accessor !== legal) {
      throw new Error(
        `Component returned failure code: 0x80070057 (NS_ERROR_ILLEGAL_VALUE) [nsIMsgSearchValue.${accessor}]`
      );
    }
  };
  for (const accessor of ["str", "priority", "date", "status", "size", "age", "junkStatus", "junkPercent", "label"]) {
    Object.defineProperty(value, accessor, {
      enumerable: true,
      get() { check(accessor); return state.stored; },
      set(v) { check(accessor); state.stored = v; },
    });
  }
  return value;
}

function makeSearchTerm() {
  return {
    attrib: undefined,
    op: undefined,
    booleanAnd: undefined,
    arbitraryHeader: "",
    hdrProperty: "",
    customId: "",
    beginsGrouping: false,
    endsGrouping: false,
    matchAll: false,
    value: makeSearchValue(),
  };
}

// nsIMsgSearchSession exposes the term factory and collection used by filters.
function makeSearchSession() {
  const terms = [];
  return {
    createTerm: makeSearchTerm,
    appendTerm(term) { terms.push(term); },
    get searchTerms() { return terms.slice(); },
  };
}

module.exports = {
  ATTRIB, OPS, ACTIONS, ATTACHMENT_FLAG,
  LEGACY_ATTRIB, LEGACY_ACTIONS, FILTER_TYPES, LEGAL_ACCESSOR,
  makeCi, makeSearchValue, makeSearchTerm, makeSearchSession,
};
