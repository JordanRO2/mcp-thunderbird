"use strict";

const SEND_LATER_NOW = Date.parse("2027-01-01T00:00:00Z");
const SEND_LATER_READY = Object.freeze({
  uuid: "draft-test-instance", checkedAt: SEND_LATER_NOW,
  sendDrafts: true, sendUnsentMsgs: true, checkTimePref: 1,
});

// No existing headerParser fixture was found in test/helpers or the compose
// suites. This models the native boundary's successful mailbox result; tests
// override it with empty/failed parses instead of duplicating Thunderbird's parser.
const SEND_LATER_HEADER_PARSER = Object.freeze({
  parseDecodedHeader(_header, preserveGroups) {
    if (preserveGroups !== false) throw new Error("Expected flattened mailboxes");
    return [{ email: "recipient@example.test" }];
  },
});

// Searched for reusable clocks: search-messages-scan and direct-send-preflight
// have private Date subclasses. Use the same boundary for scheduling and its
// background-refresh harness, without loading either suite's unrelated mocks.
function makeSendLaterClock(now = SEND_LATER_NOW) {
  const clock = { now };
  clock.Date = class extends Date {
    static now() { return clock.now; }
  };
  return clock;
}

module.exports = { SEND_LATER_NOW, SEND_LATER_READY, SEND_LATER_HEADER_PARSER, makeSendLaterClock };
