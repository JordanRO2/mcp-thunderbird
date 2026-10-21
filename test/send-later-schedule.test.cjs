"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

// Production-marker VM pattern (see compose-signature.test.cjs): only the
// skipReview preference and the Send Later info are substituted.
function snippet(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
  return source.slice(start, end);
}

const READY = { uuid: "1f0e-uuid", version: "10.7.9", sendDrafts: true, checkTimePref: 1 };

function load(options = {}) {
  const blocked = options.blocked ?? false;
  const context = vm.createContext({ isSkipReviewBlocked: () => blocked, Date });
  // An explicit `info: undefined` must reach the code as undefined.
  context.__tbMcpSendLaterInfo = Object.hasOwn(options, "info") ? options.info : READY;
  vm.runInContext(
    `${snippet("SEND LATER SCHEDULING")}
     globalThis.resolveSendLaterSchedule = resolveSendLaterSchedule;
     globalThis.formatRfc5322Local = formatRfc5322Local;`,
    context,
  );
  return context;
}

function isoInMinutes(minutes) {
  const d = new Date(Date.now() + minutes * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("saveDraft sendAt (Send Later)", () => {
  it("returns the instance UUID and an RFC 5322 header for a future local time", () => {
    const { resolveSendLaterSchedule } = load();
    const result = resolveSendLaterSchedule(isoInMinutes(30));
    assert.equal(result.error, undefined);
    assert.equal(result.uuid, READY.uuid);
    assert.match(result.header, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:00 [+-]\d{4}$/);
    assert.equal(new Date(result.header).getTime(), result.date.getTime());
  });

  it("accepts an explicit offset or Z", () => {
    const { resolveSendLaterSchedule } = load();
    const at = new Date(Date.now() + 3600000);
    at.setUTCSeconds(0, 0);
    const result = resolveSendLaterSchedule(at.toISOString().replace(".000", ""));
    assert.equal(result.error, undefined);
    assert.equal(result.date.getTime(), at.getTime());
  });

  it("refuses when the skipReview safety block is on", () => {
    const { resolveSendLaterSchedule } = load({ blocked: true });
    assert.match(resolveSendLaterSchedule(isoInMinutes(30)).error, /blocks skipReview/);
  });

  it("refuses when Send Later has not answered", () => {
    for (const info of [undefined, null, {}, { uuid: "" }]) {
      const { resolveSendLaterSchedule } = load({ info });
      assert.match(resolveSendLaterSchedule(isoInMinutes(30)).error, /not installed, disabled/);
    }
  });

  it("refuses when Send Later does not send scheduled drafts", () => {
    for (const sendDrafts of [false, null, undefined]) {
      const { resolveSendLaterSchedule } = load({ info: { ...READY, sendDrafts } });
      assert.match(resolveSendLaterSchedule(isoInMinutes(30)).error, /does not send scheduled drafts/);
    }
  });

  it("refuses when Send Later's check interval is disabled", () => {
    for (const checkTimePref of [0, -1, null, undefined]) {
      const { resolveSendLaterSchedule } = load({ info: { ...READY, checkTimePref } });
      assert.match(resolveSendLaterSchedule(isoInMinutes(30)).error, /check interval/);
    }
  });

  it("rejects malformed, past and far-future dates", () => {
    const { resolveSendLaterSchedule } = load();
    for (const bad of ["tomorrow 10:00", "2026-10-17", "2026-10-17 10:00", "2026-10-17T10:00\r\nBcc: x@example.com", 42]) {
      assert.match(resolveSendLaterSchedule(bad).error, /ISO 8601/);
    }
    assert.match(resolveSendLaterSchedule(isoInMinutes(-10)).error, /in the past/);
    assert.match(resolveSendLaterSchedule(isoInMinutes(367 * 24 * 60)).error, /more than 366 days/);
  });

  it("formats local time with the local offset", () => {
    const { formatRfc5322Local } = load();
    const d = new Date(2026, 9, 17, 10, 5, 9);
    const header = formatRfc5322Local(d);
    assert.match(header, /^Sat, 17 Oct 2026 10:05:09 [+-]\d{4}$/);
    assert.equal(new Date(header).getTime(), d.getTime());
  });
});
