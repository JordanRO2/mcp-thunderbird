"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { SEND_LATER_NOW, SEND_LATER_READY: READY, makeSendLaterClock } = require("./helpers/send-later.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const FUTURE = "2027-01-01T01:00:00Z";
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function snippet(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
  return source.slice(start, end);
}

async function load(options = {}) {
  const clock = makeSendLaterClock(options.now);
  const context = vm.createContext({
    isSkipReviewBlocked: () => options.blocked === true,
    isToolEnabled: name => !(options.disabledTools || []).includes(name),
    Date: clock.Date,
  });
  // Execute the actual normalizer as an Experiment method, like privacy-access.
  vm.runInContext([
    snippet("TWO DIGIT PADDING"), snippet("SEND LATER SCHEDULING"),
    `this.options = { ${snippet("SEND LATER INFO API")} };`,
  ].join("\n"), context);
  await context.options.setSendLaterInfo(Object.hasOwn(options, "info") ? options.info : { ...READY, checkedAt: clock.now });
  return { context, clock };
}

describe("saveDraft sendAt (Send Later)", () => {
  it("returns the instance UUID and an RFC 5322 header for a future time", async () => {
    const { context } = await load();
    const result = context.resolveSendLaterSchedule(FUTURE);
    assert.equal(result.error, undefined);
    assert.equal(result.uuid, READY.uuid);
    assert.match(result.header, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:00 [+-]\d{4}$/);
    assert.equal(Date.parse(result.header), Date.parse(FUTURE));
  });

  it("accepts explicit positive/negative offsets and Z, reporting header precision", async () => {
    const { context } = await load();
    for (const at of [FUTURE, "2027-01-01T03:00:00+02:00", "2026-12-31T20:00:00-05:00", "2027-01-01T01:00:00.987Z"]) {
      const result = context.resolveSendLaterSchedule(at);
      assert.equal(result.error, undefined, at);
      assert.equal(result.date.toISOString(), "2027-01-01T01:00:00.000Z");
      assert.equal(Date.parse(result.header), result.date.getTime());
    }
  });

  it("accepts an ordinary local time without an offset", async () => {
    const { context } = await load();
    const local = "2027-01-02T12:34";
    assert.equal(context.resolveSendLaterSchedule(local).date.getTime(), new Date(local).getTime());
  });

  it("refuses when the skipReview safety block is on", async () => {
    const { context } = await load({ blocked: true });
    assert.match(context.resolveSendLaterSchedule(FUTURE).error, /blocks skipReview/);
  });

  it("refuses when sendMail is disabled", async () => {
    const { context } = await load({ disabledTools: ["sendMail"] });
    assert.match(context.resolveSendLaterSchedule(FUTURE).error, /requires the sendMail tool/);
  });

  it("refuses when Send Later has not answered", async () => {
    for (const info of [undefined, null, {}, { uuid: "" }]) {
      const { context } = await load({ info });
      assert.match(context.resolveSendLaterSchedule(FUTURE).error, /not installed, disabled/);
    }
  });

  for (const [pref, message] of [["sendDrafts", /does not send scheduled drafts/], ["sendUnsentMsgs", /send unsent messages/]]) {
    it(`requires strictly true ${pref}`, async () => {
      for (const value of [false, null, undefined, 1, "true"]) {
        const { context } = await load({ info: { ...READY, [pref]: value } });
        assert.match(context.resolveSendLaterSchedule(FUTURE).error, message);
      }
    });
  }

  it("refuses when Send Later's check interval is disabled or non-finite", async () => {
    for (const checkTimePref of [0, -1, null, undefined, NaN, Infinity, "1"]) {
      const { context } = await load({ info: { ...READY, checkTimePref } });
      assert.match(context.resolveSendLaterSchedule(FUTURE).error, /check interval/);
    }
  });

  it("rejects malformed dates", async () => {
    const { context } = await load();
    for (const bad of ["tomorrow 10:00", "x".repeat(65), "2027-01-01", "2027-01-01 10:00", "2027-01-01T10:00\r\nBcc: x@example.com", 42]) {
      assert.match(context.resolveSendLaterSchedule(bad).error, /ISO 8601/);
    }
  });

  it("rejects calendar rollover for local and offset inputs", async () => {
    const { context } = await load();
    for (const date of ["2027-02-30T10:00", "2027-02-29T10:00", "2027-04-31T10:00", "2027-13-01T10:00", "2027-00-01T10:00", "2027-01-00T10:00", "2027-01-01T24:00", "2027-01-01T10:60", "2027-01-01T10:00:60"]) {
      for (const offset of ["", "Z", "+02:00"]) {
        assert.match(context.resolveSendLaterSchedule(date + offset).error, /valid calendar/, date + offset);
      }
    }
    assert.match(context.resolveSendLaterSchedule("2027-01-01T10:00+99:99").error, /valid date/);
  });

  it("rejects a local DST gap and distinguishes explicit fall-back offsets", async () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = "Europe/Warsaw";
    try {
      const { context } = await load();
      assert.match(context.resolveSendLaterSchedule("2027-03-28T02:30").error, /valid local/);
      const earlier = context.resolveSendLaterSchedule("2027-10-31T02:30:00+02:00");
      const later = context.resolveSendLaterSchedule("2027-10-31T02:30:00+01:00");
      assert.equal(earlier.error, undefined);
      assert.equal(later.error, undefined);
      assert.equal(later.date.getTime() - earlier.date.getTime(), 60 * MINUTE_MS);
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
  });

  it("accepts leap day only in leap years", async () => {
    const { context } = await load({ now: Date.parse("2028-01-01T00:00:00Z") });
    assert.equal(context.resolveSendLaterSchedule("2028-02-29T10:00:00Z").error, undefined);
  });

  it("enforces past tolerance and the 366-day horizon with a controlled clock", async () => {
    const { context } = await load();
    for (const delta of [-MINUTE_MS, 366 * DAY_MS]) {
      assert.equal(context.resolveSendLaterSchedule(new Date(SEND_LATER_NOW + delta).toISOString()).error, undefined);
    }
    assert.match(context.resolveSendLaterSchedule(new Date(SEND_LATER_NOW - MINUTE_MS - 1000).toISOString()).error, /in the past/);
    assert.match(context.resolveSendLaterSchedule(new Date(SEND_LATER_NOW + 366 * DAY_MS + 1000).toISOString()).error, /more than 366 days/);
  });

  it("expires information older than three minutes and refuses backward clock changes", async () => {
    const { context, clock } = await load();
    clock.now += 3 * MINUTE_MS;
    assert.equal(context.resolveSendLaterSchedule(FUTURE).error, undefined);
    clock.now++;
    assert.match(context.resolveSendLaterSchedule(FUTURE).error, /older than 3 minutes/);
    clock.now = SEND_LATER_NOW - 1;
    assert.match(context.resolveSendLaterSchedule(FUTURE).error, /unavailable/);
  });

  it("formats local time with the local offset", async () => {
    const { context } = await load();
    const d = new Date(2026, 9, 17, 10, 5, 9);
    const header = context.formatRfc5322Local(d);
    assert.match(header, /^Sat, 17 Oct 2026 10:05:09 [+-]\d{4}$/);
    assert.equal(Date.parse(header), d.getTime());
  });
});

describe("Send Later information normalizer", () => {
  it("preserves printable identifiers, including historical non-UUID formats", async () => {
    const { context } = await load();
    for (const uuid of ["!", "x".repeat(64), "{11111111-2222-4333-8444-555555555555}", "older/instance:token"]) {
      await context.options.setSendLaterInfo({ ...READY, uuid, version: "unused", extra: "ignored" });
      assert.equal(context.__tbMcpSendLaterInfo.uuid, uuid);
      assert.equal(context.__tbMcpSendLaterInfo.checkedAt, SEND_LATER_NOW);
      assert.equal(context.__tbMcpSendLaterInfo.version, undefined);
      assert.equal(context.__tbMcpSendLaterInfo.extra, undefined);
      assert.equal(context.resolveSendLaterSchedule(FUTURE).uuid, uuid);
    }
  });

  it("rejects rather than repairs invalid identifiers and clears prior readiness", async () => {
    const { context } = await load();
    for (const uuid of ["", "x".repeat(65), " token", "token ", "a b", "token\n", "a\r\nb", "a\tb", "a\0b", "a\x7fb", "a\u0085b", "aé", "a\u2028b", 123, {}, null]) {
      await context.options.setSendLaterInfo(READY);
      await context.options.setSendLaterInfo({ ...READY, uuid });
      assert.equal(context.__tbMcpSendLaterInfo, null, JSON.stringify(uuid));
      assert.match(context.resolveSendLaterSchedule(FUTURE).error, /unavailable/);
    }
  });

  it("refuses missing, invalid or future observation timestamps", async () => {
    const { context } = await load();
    for (const checkedAt of [undefined, null, "now", NaN, Infinity, SEND_LATER_NOW + 1]) {
      await context.options.setSendLaterInfo({ ...READY, checkedAt });
      assert.equal(context.__tbMcpSendLaterInfo, null);
    }
  });

  it("normalizes unreadable preferences to null and clears absent information", async () => {
    const { context } = await load();
    await context.options.setSendLaterInfo({ ...READY, sendDrafts: "true", sendUnsentMsgs: 1, checkTimePref: Infinity });
    for (const pref of ["sendDrafts", "sendUnsentMsgs", "checkTimePref"]) assert.equal(context.__tbMcpSendLaterInfo[pref], null);
    for (const info of [undefined, null, {}]) {
      await context.options.setSendLaterInfo(READY);
      await context.options.setSendLaterInfo(info);
      assert.equal(context.__tbMcpSendLaterInfo, null);
    }
  });
});
