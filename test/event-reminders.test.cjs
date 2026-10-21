"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadCalendarRuntime, plain, assertNoWrites } = require("./helpers/calendar-runtime.cjs");

const createArgs = { title: "Reminder test", startDate: "2026-09-28T10:00:00Z", calendarId: "calendar-1" };
const updateArgs = { eventId: "event-1", calendarId: "calendar-1" };
const range = { calendarId: "calendar-1", startDate: "2026-09-28", endDate: "2026-10-06" };
const recurrenceId = "2026-09-28T10:00:00.000Z";
const writeCases = [
  ["review create", "createEvent", createArgs],
  ["direct create", "createEvent", { ...createArgs, skipReview: true }],
  ["series update", "updateEvent", updateArgs],
  ["occurrence update", "updateEvent", { ...updateArgs, recurrenceId }],
];

// Full provider records, deliberately outside the subset exposed by reminders.
function unmanagedAlarms(runtime) {
  const related = runtime.Ci.calIAlarm;
  return [
    runtime.makeAlarm({ related: related.ALARM_RELATED_END, seconds: -600 }),
    runtime.makeAlarm({ related: related.ALARM_RELATED_END, seconds: 300 }),
    runtime.makeAlarm({ related: related.ALARM_RELATED_ABSOLUTE, alarmDate: runtime.date("2026-09-28T09:00:00Z") }),
    runtime.makeAlarm({ seconds: 300 }),
    runtime.makeAlarm({ action: "EMAIL", seconds: -1800 }),
    runtime.makeAlarm({ action: "AUDIO", seconds: -1800 }),
    runtime.makeAlarm({ action: "X-PROVIDER-ACTION", seconds: -1800 }),
  ].map((alarm, index) => {
    alarm.description = `Provider description ${index}`;
    alarm.summary = `Provider summary ${index}`;
    alarm.setProperty("X-PROVIDER-DATA", `opaque-${index}`);
    alarm.setProperty("X-DEFAULT-ALARM", "TRUE");
    return alarm;
  });
}

describe("Production createEvent reminders", () => {
  for (const skipReview of [false, true]) {
    for (const [label, reminders, expected] of [
      ["omitted", undefined, []], ["null", null, []], ["empty", [], []],
      ["normalized", [0, 40320, 60, 60], [40320, 60, 0]],
    ]) {
      it(`creates ${label} reminders through ${skipReview ? "direct write" : "review and save"}`, async () => {
        const runtime = loadCalendarRuntime(skipReview ? { blockSkipReview: false } : {});
        const result = await runtime.invoke("createEvent", {
          ...createArgs, skipReview, ...(reminders !== undefined ? { reminders } : {}),
        });
        assert.equal(result.success, true, result.error);
        assert.equal(runtime.calls.adds.length, skipReview ? 1 : 0);
        assert.equal(runtime.calls.dialogs.length, skipReview ? 0 : 1);
        const item = skipReview ? runtime.calls.adds[0] : runtime.calls.dialogs[0].calendarEvent;
        assert.equal(item.calendar, runtime.calendar);
        assert.deepEqual(item.getAlarms().map(alarm => alarm.offset.inSeconds), expected.map(minutes => minutes ? -minutes * 60 : 0));
        for (const alarm of item.getAlarms()) {
          assert.ok(alarm instanceof runtime.CalAlarm);
          assert.equal(alarm.action, "DISPLAY");
          assert.equal(alarm.related, runtime.Ci.calIAlarm.ALARM_RELATED_START);
          assert.equal(alarm.description, null, "Thunderbird supplies DISPLAY descriptions when serializing");
          assert.equal(alarm.offset.constructor, runtime.cal.createDuration().constructor);
        }
        if (!skipReview) {
          await runtime.calls.dialogs[0].onOk(item, runtime.calendar);
          assert.equal(runtime.calls.adds[0], item);
        }
        // Writes record calls; explicitly expose the persisted item for readback.
        runtime.items.set(item.id, item);
        const listed = await runtime.invoke("listEvents", range);
        assert.ok(Array.isArray(listed), listed.error);
        assert.deepEqual(plain(listed.map(event => event.reminders)), [expected]);
      });
    }
  }

  it("still refuses direct creation with reminders while Block skipReview is on", async () => {
    const runtime = loadCalendarRuntime();
    const result = await runtime.invoke("createEvent", { ...createArgs, reminders: [60], skipReview: true });
    assert.match(result.error, /skipReview/);
    assertNoWrites(runtime);
  });
});

describe("Production reminder validation", () => {
  for (const [label, name, args] of writeCases) {
    it(`rejects invalid reminder inputs before lookup or writes on ${label}`, async () => {
      const runtime = loadCalendarRuntime({ blockSkipReview: false });
      runtime.seedSeries();
      for (const reminders of [
        "1440", 1440, {}, [30, 1.5], [-1], ["30"], [NaN], [Infinity], [null],
        [40321], Array.from({ length: 11 }, (_, index) => index), Array(11).fill(60),
      ]) {
        const result = await runtime.invoke(name, { ...args, reminders });
        assert.match(result.error, /reminders/, JSON.stringify(reminders));
        assertNoWrites(runtime);
        assert.deepEqual(runtime.calls.reads, [], "validation must precede calendar and item lookup");
      }
    });

    it(`accepts ten entries and the four-week boundary on ${label}`, async () => {
      const runtime = loadCalendarRuntime({ blockSkipReview: false });
      runtime.seedSeries();
      const reminders = [40320, 8, 7, 6, 5, 4, 3, 2, 1, 0];
      const result = await runtime.invoke(name, { ...args, reminders });
      assert.equal(result.success, true, result.error);
      const written = runtime.calls.modifies[0]?.item || runtime.calls.adds[0] || runtime.calls.dialogs[0].calendarEvent;
      assert.deepEqual(written.getAlarms().map(alarm => alarm.offset.inSeconds), reminders.map(minutes => minutes ? -minutes * 60 : 0));
    });
  }

  it("uses the existing array-string coercion through the dispatcher", async () => {
    const runtime = loadCalendarRuntime();
    runtime.seedEvent();
    const result = await runtime.invoke("updateEvent", { ...updateArgs, reminders: "[60, 15, 60]" });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(runtime.calls.modifies[0].item.getAlarms().map(alarm => alarm.offset.inSeconds), [-3600, -900]);
  });
});

describe("Production managed reminder replacement", () => {
  for (const occurrence of [false, true]) {
    const label = occurrence ? "occurrence" : "series";
    for (const reminders of [[], [0, 1440, 30, 30]]) {
      it(`${reminders.length ? "replaces" : "clears"} only managed ${label} alarms, retaining full provider records`, async () => {
        const runtime = loadCalendarRuntime();
        const retained = unmanagedAlarms(runtime);
        const managed = runtime.makeAlarm();
        managed.setProperty("X-DEFAULT-ALARM", "TRUE");
        const { master, occurrences } = runtime.seedSeries({ alarms: [managed, ...retained] });
        const original = occurrence ? occurrences[0] : master;
        original.alarmLastAck = runtime.date("2026-09-27T09:00:00Z");
        original.setProperty("X-MOZ-SNOOZE-TIME", "20260928T090000Z");
        original.setProperty("X-MOZ-SNOOZE-TIME-123", "20260928T100000Z");
        const result = await runtime.invoke("updateEvent", {
          ...updateArgs, reminders, ...(occurrence ? { recurrenceId } : {}),
        });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(plain(result.updated), ["reminders"]);
        const { item, previous } = runtime.calls.modifies[0];
        assert.equal(previous, original, "modifyItem requires the original occurrence, not its master");
        assert.notEqual(item, original);
        if (occurrence) {
          assert.equal(result.mode, "occurrence");
          assert.equal(item.parentItem, master);
          assert.equal(item.recurrenceId.compare(original.recurrenceId), 0);
          assert.equal(original.alarms, null, "the stored occurrence still inherits");
        }
        const alarms = item.getAlarms();
        assert.deepEqual(alarms.slice(0, retained.length), retained);
        const requested = alarms.slice(retained.length);
        assert.deepEqual(requested.map(alarm => alarm.offset.inSeconds), reminders.length ? [-86400, -1800, 0] : []);
        assert.ok(requested.every(alarm => alarm.action === "DISPLAY" && alarm.description === null));
        assert.deepEqual(original.getAlarms(), [managed, ...retained]);
        assert.deepEqual(master.getAlarms(), [managed, ...retained]);
        assert.deepEqual(item.alarmLastAck, original.alarmLastAck);
        assert.equal(item.getProperty("X-MOZ-SNOOZE-TIME"), "20260928T090000Z");
        assert.equal(item.getProperty("X-MOZ-SNOOZE-TIME-123"), "20260928T100000Z");
        assert.notEqual(alarms[0], retained[0]);
        assert.notEqual(alarms[0].offset, retained[0].offset);
        alarms[0].setProperty("X-PROVIDER-DATA", "clone-only");
        alarms[0].offset.inSeconds = -123;
        assert.equal(retained[0].getProperty("X-PROVIDER-DATA"), "opaque-0");
        assert.equal(retained[0].offset.inSeconds, -600);
      });
    }

    for (const reminders of [undefined, null]) {
      it(`preserves ${label} second offsets and all metadata with reminders ${String(reminders)}`, async () => {
        const runtime = loadCalendarRuntime();
        const managed = runtime.makeAlarm({ seconds: -90, description: "Existing description" });
        managed.setProperty("X-DEFAULT-ALARM", "TRUE");
        const alarms = [managed, ...unmanagedAlarms(runtime)];
        const { master, occurrences } = runtime.seedSeries({ alarms });
        const original = occurrence ? occurrences[0] : master;
        original.clearAlarms = () => assert.fail("unrelated edits must not rewrite alarms");
        original.addAlarm = () => assert.fail("unrelated edits must not re-add alarms");
        const listed = await runtime.invoke("listEvents", range);
        assert.ok(Array.isArray(listed), listed.error);
        assert.deepEqual(plain(listed.map(event => event.reminders)), [[2], [2]]);
        const result = await runtime.invoke("updateEvent", {
          ...updateArgs, title: "Renamed", ...(reminders !== undefined ? { reminders } : {}),
          ...(occurrence ? { recurrenceId } : {}),
        });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(plain(result.updated), ["title"]);
        const { item, previous } = runtime.calls.modifies[0];
        assert.equal(previous, original);
        assert.deepEqual(item.getAlarms(), alarms);
        assert.equal(item.getAlarms()[0].offset.inSeconds, -90);
        assert.deepEqual(original.getAlarms(), alarms);
        assert.deepEqual(master.getAlarms(), alarms);
      });
    }

    it(`does not count omitted/null reminders as a ${label} change`, async () => {
      const runtime = loadCalendarRuntime();
      runtime.seedSeries({ alarms: [runtime.makeAlarm()] });
      for (const reminders of [undefined, null]) {
        const result = await runtime.invoke("updateEvent", {
          ...updateArgs, reminders, ...(occurrence ? { recurrenceId } : {}),
        });
        assert.match(result.error, /No changes/);
        assertNoWrites(runtime);
      }
    });

    it(`allows reminders-only meeting ${label} changes when Block skipReview is disabled`, async () => {
      const runtime = loadCalendarRuntime({ blockSkipReview: false });
      runtime.seedSeries({ attendees: [{ id: "mailto:other@example.com" }] });
      const result = await runtime.invoke("updateEvent", {
        ...updateArgs, reminders: [60], ...(occurrence ? { recurrenceId } : {}),
      });
      assert.equal(result.success, true, result.error);
      assert.equal(runtime.calls.modifies.length, 1);
    });
  }

  it("clears inherited occurrence alarms without inheriting them again", async () => {
    const runtime = loadCalendarRuntime();
    const alarm = runtime.makeAlarm();
    const { master, occurrences } = runtime.seedSeries({ alarms: [alarm] });
    const result = await runtime.invoke("updateEvent", { ...updateArgs, recurrenceId, reminders: [] });
    assert.equal(result.success, true, result.error);
    const { item, previous } = runtime.calls.modifies[0];
    assert.equal(previous, occurrences[0]);
    assert.deepEqual(item.getAlarms(), []);
    assert.deepEqual(item.alarms, []);
    assert.deepEqual(master.getAlarms(), [alarm]);
    assert.deepEqual(occurrences[0].getAlarms(), [alarm]);
  });

  it("distinguishes an explicit empty occurrence from inherited alarms", async () => {
    const runtime = loadCalendarRuntime();
    const { master, occurrences } = runtime.seedSeries({ alarms: unmanagedAlarms(runtime) });
    occurrences[0].clearAlarms();
    const result = await runtime.invoke("updateEvent", { ...updateArgs, recurrenceId, reminders: [15] });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(runtime.calls.modifies[0].item.getAlarms().map(alarm => alarm.offset.inSeconds), [-900]);
    assert.deepEqual(occurrences[0].getAlarms(), []);
    assert.equal(master.getAlarms().length, 7);
  });

  it("keeps modified exceptions and their own alarms when changing the series", async () => {
    const runtime = loadCalendarRuntime();
    const { master, occurrences } = runtime.seedSeries({ alarms: [runtime.makeAlarm()] });
    const exception = occurrences[1];
    exception.title = "Modified occurrence";
    exception.alarms = [runtime.makeAlarm({ seconds: -300 }), ...unmanagedAlarms(runtime)];
    master.recurrenceInfo.exceptions.push(exception);
    const result = await runtime.invoke("updateEvent", { ...updateArgs, reminders: [90] });
    assert.equal(result.success, true, result.error);
    const written = runtime.calls.modifies[0].item;
    const keptException = written.recurrenceInfo.getExceptionFor(exception.recurrenceId);
    assert.deepEqual(keptException.getAlarms(), exception.getAlarms());
    assert.notEqual(keptException, exception);
    assert.equal(keptException.title, exception.title);
    assert.equal(master.getAlarms()[0].offset.inSeconds, -3600);
    assert.equal(exception.getAlarms()[0].offset.inSeconds, -300);
    runtime.items.set(master.id, written);
    const listed = await runtime.invoke("listEvents", range);
    assert.ok(Array.isArray(listed), listed.error);
    assert.deepEqual(plain(listed.map(event => event.reminders)), [[90], [5]]);
  });

  it("round-trips listed reminders without deleting unseen alarms", async () => {
    const runtime = loadCalendarRuntime();
    const retained = unmanagedAlarms(runtime);
    const source = runtime.seedEvent({ alarms: [runtime.makeAlarm(), ...retained] });
    const before = await runtime.invoke("listEvents", range);
    assert.deepEqual(plain(before[0].reminders), [60]);
    const result = await runtime.invoke("updateEvent", { ...updateArgs, reminders: [...before[0].reminders, 10] });
    assert.equal(result.success, true, result.error);
    const written = runtime.calls.modifies[0].item;
    assert.deepEqual(written.getAlarms().slice(0, retained.length), retained);
    assert.equal(source.getAlarms().length, retained.length + 1);
    runtime.items.set(source.id, written);
    const after = await runtime.invoke("listEvents", range);
    assert.deepEqual(plain(after[0].reminders), [60, 10]);
  });
});

describe("Production reminder listing and read failures", () => {
  it("lists only managed stored alarms, rounding seconds without applying write caps", async () => {
    const runtime = loadCalendarRuntime();
    const alarms = [0, -0, -29, -30, -89, -90, -3600, -3600, -40321 * 60].map(seconds => runtime.makeAlarm({ seconds }));
    alarms[0].setProperty("X-DEFAULT-ALARM", "TRUE");
    runtime.seedEvent({ alarms: [...alarms, ...unmanagedAlarms(runtime)] });
    runtime.seedEvent({ id: "no-alarms" });
    const listed = await runtime.invoke("listEvents", range);
    assert.ok(Array.isArray(listed), listed.error);
    assert.deepEqual(plain(listed.find(event => event.id === "event-1").reminders), [40321, 60, 2, 1, 0]);
    assert.ok(Object.is(listed.find(event => event.id === "event-1").reminders.at(-1), 0));
    assert.deepEqual(plain(listed.find(event => event.id === "no-alarms").reminders), []);
    assert.equal(alarms[5].offset.inSeconds, -90);
  });

  it("contains an alarm-read failure to one listing row", async () => {
    const runtime = loadCalendarRuntime();
    const broken = runtime.seedEvent({ id: "broken" });
    broken.getAlarms = () => { throw new Error("provider getAlarms failure"); };
    runtime.seedEvent({ id: "healthy", alarms: [runtime.makeAlarm()] });
    const listed = await runtime.invoke("listEvents", range);
    assert.ok(Array.isArray(listed), listed.error);
    assert.equal(listed.length, 2);
    assert.deepEqual(plain(listed.find(event => event.id === "broken").reminders), []);
    assert.deepEqual(plain(listed.find(event => event.id === "healthy").reminders), [60]);
  });

  for (const occurrence of [false, true]) {
    for (const failOnClone of [false, true]) {
      it(`fails closed reading ${occurrence ? "occurrence" : "series"} alarms on the ${failOnClone ? "clone" : "original"}`, async () => {
        const runtime = loadCalendarRuntime({ blockSkipReview: false });
        const { master, occurrences } = runtime.seedSeries({ alarms: [runtime.makeAlarm()] });
        const original = occurrence ? occurrences[0] : master;
        if (failOnClone) {
          const clone = original.clone.bind(original);
          original.clone = () => {
            const item = clone();
            item.getAlarms = () => { throw new Error("provider getAlarms failure"); };
            item.clearAlarms = () => assert.fail("must read before replacing alarms");
            return item;
          };
        } else {
          original.getAlarms = () => { throw new Error("provider getAlarms failure"); };
        }
        for (const reminders of [[], [60]]) {
          const result = await runtime.invoke("updateEvent", {
            ...updateArgs, reminders, attendees: [{ email: "invitee@example.com" }],
            ...(occurrence ? { recurrenceId } : {}),
          });
          assert.match(result.error, /provider getAlarms failure/);
          assertNoWrites(runtime);
        }
      });
    }

    it(`runs Send Safety before reading ${occurrence ? "occurrence" : "series"} alarms`, async () => {
      const runtime = loadCalendarRuntime();
      const { master, occurrences } = runtime.seedSeries({ attendees: [{ id: "mailto:other@example.com" }] });
      const original = occurrence ? occurrences[0] : master;
      original.getAlarms = () => assert.fail("guard must run before alarm inspection");
      const result = await runtime.invoke("updateEvent", {
        ...updateArgs, reminders: [60], ...(occurrence ? { recurrenceId } : {}),
      });
      assert.match(result.error, /Block skipReview/);
      assertNoWrites(runtime);
    });
  }
});

describe("Production calendar alarm capabilities", () => {
  for (const [label, name, args] of writeCases) {
    const updating = name === "updateEvent";

    it(`accepts the normalized total at maxCount on ${label}, including retained unsupported actions`, async () => {
      const limit = updating ? 3 : 2;
      const runtime = loadCalendarRuntime({ blockSkipReview: false, alarmMaxCount: limit, alarmActions: ["DISPLAY"] });
      const retained = runtime.makeAlarm({ action: "EMAIL" });
      retained.setProperty("X-DEFAULT-ALARM", "TRUE");
      if (updating) runtime.seedSeries({ alarms: [runtime.makeAlarm(), retained] });
      const result = await runtime.invoke(name, { ...args, reminders: [60, 0, 60] });
      assert.equal(result.success, true, result.error);
      const item = runtime.calls.modifies[0]?.item || runtime.calls.adds[0] || runtime.calls.dialogs[0].calendarEvent;
      assert.equal(item.getAlarms().length, limit);
      assert.deepEqual(item.getAlarms().slice(updating ? 1 : 0).map(alarm => alarm.offset.inSeconds), [-3600, 0]);
      if (updating) assert.deepEqual(item.getAlarms()[0], retained, "undeclared EMAIL actions must not be filtered");
    });

    it(`rejects an excess count before alarm replacement, organizer writes or persistence on ${label}`, async () => {
      const runtime = loadCalendarRuntime({ blockSkipReview: false, alarmMaxCount: updating ? 2 : 1 });
      if (updating) {
        const { master, occurrences } = runtime.seedSeries({ alarms: [runtime.makeAlarm(), runtime.makeAlarm({ action: "EMAIL" })] });
        const original = args.recurrenceId ? occurrences[0] : master;
        original.clearAlarms = () => assert.fail("capabilities must be checked before replacing alarms");
      }
      const result = await runtime.invoke(name, { ...args, reminders: [60, 0], attendees: [{ email: "invitee@example.com" }] });
      assert.match(result.error, updating ? /at most 2 alarms; 1 retained alarms plus 2 requested/ : /at most 1 alarms; 0 retained alarms plus 2 requested/);
      assertNoWrites(runtime);
    });

    it(`treats maxCount zero as zero and preserves omitted/null reminders on ${label}`, async () => {
      for (const reminders of [undefined, null, [], [0]]) {
        const runtime = loadCalendarRuntime({ blockSkipReview: false, alarmMaxCount: 0, alarmActions: [] });
        if (updating) runtime.seedSeries({ alarms: [runtime.makeAlarm()] });
        const result = await runtime.invoke(name, {
          ...args, title: "Zero limit", ...(reminders !== undefined ? { reminders } : {}),
        });
        if (reminders?.length) {
          assert.match(result.error, /at most 0 alarms/);
          assertNoWrites(runtime);
        } else {
          assert.equal(result.success, true, result.error);
          const item = runtime.calls.modifies[0]?.item || runtime.calls.adds[0] || runtime.calls.dialogs[0].calendarEvent;
          assert.equal(item.getAlarms().length, updating && reminders == null ? 1 : 0);
        }
      }
    });

    it(`ignores absent, non-integer and non-numeric maxCount declarations on ${label}`, async () => {
      for (const alarmMaxCount of [undefined, null, "0", "1", false, true, -1, 1.5, NaN, Infinity]) {
        const runtime = loadCalendarRuntime({ blockSkipReview: false, alarmMaxCount });
        if (updating) runtime.seedSeries({ alarms: [runtime.makeAlarm({ action: "EMAIL" })] });
        const result = await runtime.invoke(name, { ...args, reminders: [60, 0] });
        assert.equal(result.success, true, `${String(alarmMaxCount)}: ${result.error}`);
      }
    });

    it(`refuses new DISPLAY alarms before side effects when undeclared on ${label}`, async () => {
      for (const alarmActions of [[], ["EMAIL"], ["AUDIO"]]) {
        const runtime = loadCalendarRuntime({ blockSkipReview: false, alarmActions });
        if (updating) {
          const { master, occurrences } = runtime.seedSeries({ alarms: [runtime.makeAlarm()] });
          (args.recurrenceId ? occurrences[0] : master).clearAlarms = () => assert.fail("action check must precede replacement");
        }
        const result = await runtime.invoke(name, {
          ...args, reminders: [60], attendees: [{ email: "invitee@example.com" }],
        });
        assert.match(result.error, /does not support DISPLAY/);
        assertNoWrites(runtime);
      }
    });

    it(`skips capability reads for omitted/null reminders on ${label}`, async () => {
      for (const reminders of [undefined, null]) {
        const runtime = loadCalendarRuntime({ blockSkipReview: false });
        const getProperty = runtime.calendar.getProperty.bind(runtime.calendar);
        runtime.calendar.getProperty = property => {
          if (property.startsWith("capabilities.alarms.")) assert.fail("preserving reminders must not inspect capabilities");
          return getProperty(property);
        };
        const alarms = unmanagedAlarms(runtime);
        if (updating) runtime.seedSeries({ alarms });
        const result = await runtime.invoke(name, {
          ...args, title: "Unrelated edit", ...(reminders !== undefined ? { reminders } : {}),
        });
        assert.equal(result.success, true, result.error);
        if (updating) assert.deepEqual(runtime.calls.modifies[0].item.getAlarms(), alarms);
      }
    });
  }

  for (const skipReview of [false, true]) {
    for (const explicit of [false, true]) {
      it(`checks the resolved ${explicit ? "explicit" : "default"} target before ${skipReview ? "direct creation" : "review"}`, async () => {
        const runtime = loadCalendarRuntime({ blockSkipReview: false, disabled: true, alarmMaxCount: 0, alarmActions: [] });
        const readOnly = loadCalendarRuntime({ alarmMaxCount: 0, alarmActions: [] });
        readOnly.calendar.id = "read-only";
        readOnly.calendar.readOnly = true;
        const target = loadCalendarRuntime({ alarmMaxCount: 1, alarmActions: ["DISPLAY"] });
        target.calendar.id = "target";
        runtime.cal.manager.getCalendars = () => [runtime.calendar, readOnly.calendar, target.calendar];
        const args = {
          ...createArgs, calendarId: explicit ? target.calendar.id : undefined,
          skipReview, attendees: [{ email: "invitee@example.com" }],
        };
        const rejected = await runtime.invoke("createEvent", { ...args, reminders: [60, 0] });
        assert.match(rejected.error, /at most 1 alarms/);
        for (const fixture of [runtime, readOnly, target]) assertNoWrites(fixture);
        const accepted = await runtime.invoke("createEvent", { ...args, reminders: [60] });
        assert.equal(accepted.success, true, accepted.error);
        const item = skipReview ? target.calls.adds[0] : runtime.calls.dialogs[0].calendarEvent;
        assert.equal(item.calendar, target.calendar);
        assert.equal(item.getAlarms().length, 1);
        assert.equal(target.calls.calendarProperties.length, 1, "organizer initialization follows successful capability checks");
        assertNoWrites(readOnly);
      });
    }

    it(`keeps create Send Safety ahead of capability checks (skipReview=${skipReview})`, async () => {
      const runtime = loadCalendarRuntime({ alarmMaxCount: 0, alarmActions: [] });
      const result = await runtime.invoke("createEvent", {
        ...createArgs, skipReview, reminders: [60], attendees: [{ email: "invitee@example.com" }],
      });
      assert.match(result.error, /Block skipReview/);
      assert.deepEqual(runtime.calls.reads, [], "the guard must precede even calendar resolution");
      assertNoWrites(runtime);
    });
  }

  for (const occurrence of [false, true]) {
    const args = { ...updateArgs, ...(occurrence ? { recurrenceId } : {}) };
    const label = occurrence ? "occurrence" : "series";

    it(`counts every retained ${label} alarm and never drops them to meet maxCount`, async () => {
      for (const reminders of [[], [60]]) {
        const runtime = loadCalendarRuntime({ alarmMaxCount: 6 });
        const retained = unmanagedAlarms(runtime);
        const { master, occurrences } = runtime.seedSeries({ alarms: [runtime.makeAlarm(), ...retained] });
        const result = await runtime.invoke("updateEvent", { ...args, reminders });
        assert.match(result.error, /at most 6 alarms; 7 retained alarms/);
        assertNoWrites(runtime);
        assert.deepEqual(master.getAlarms().slice(1), retained);
        assert.deepEqual(occurrences[0].getAlarms().slice(1), retained);
      }
    });

    it(`refuses clearing ${label} reminders when retained alarms exceed maxCount zero`, async () => {
      const runtime = loadCalendarRuntime({ alarmMaxCount: 0, alarmActions: [] });
      const retained = runtime.makeAlarm({ action: "EMAIL" });
      runtime.seedSeries({ alarms: [runtime.makeAlarm(), retained] });
      const result = await runtime.invoke("updateEvent", { ...args, reminders: [] });
      assert.match(result.error, /at most 0 alarms; 1 retained alarms plus 0 requested/);
      assertNoWrites(runtime);
    });

    it(`allows clearing ${label} managed alarms while keeping undeclared actions`, async () => {
      const runtime = loadCalendarRuntime({ alarmMaxCount: 7, alarmActions: [] });
      const retained = unmanagedAlarms(runtime);
      runtime.seedSeries({ alarms: [runtime.makeAlarm(), ...retained] });
      const getProperty = runtime.calendar.getProperty.bind(runtime.calendar);
      runtime.calendar.getProperty = property => {
        assert.notEqual(property, "capabilities.alarms.actionValues", "[] must not validate retained actions");
        return getProperty(property);
      };
      const result = await runtime.invoke("updateEvent", { ...args, reminders: [] });
      assert.equal(result.success, true, result.error);
      assert.deepEqual(runtime.calls.modifies[0].item.getAlarms(), retained);
    });

    it(`keeps the ${label} Send Safety error ahead of capability failures`, async () => {
      const runtime = loadCalendarRuntime({ alarmMaxCount: 0, alarmActions: [] });
      runtime.seedSeries({ attendees: [{ id: "mailto:other@example.com" }] });
      const getProperty = runtime.calendar.getProperty.bind(runtime.calendar);
      let capabilityReads = 0;
      runtime.calendar.getProperty = property => {
        if (property.startsWith("capabilities.alarms.")) capabilityReads++;
        return getProperty(property);
      };
      const result = await runtime.invoke("updateEvent", { ...args, reminders: [60] });
      assert.match(result.error, /Block skipReview/);
      assert.equal(capabilityReads, 0);
      assertNoWrites(runtime);
    });
  }

  it("uses a selected occurrence's own alarms for the count, including an explicit empty override", async () => {
    for (const empty of [false, true]) {
      const runtime = loadCalendarRuntime({ alarmMaxCount: empty ? 0 : 2 });
      const { master, occurrences } = runtime.seedSeries({ alarms: unmanagedAlarms(runtime) });
      occurrences[0].alarms = empty ? [] : [runtime.makeAlarm({ action: "EMAIL" })];
      const result = await runtime.invoke("updateEvent", { ...updateArgs, recurrenceId, reminders: empty ? [] : [60] });
      assert.equal(result.success, true, result.error);
      const { item, previous } = runtime.calls.modifies[0];
      assert.equal(previous, occurrences[0]);
      assert.equal(item.getAlarms().length, empty ? 0 : 2);
      assert.equal(master.getAlarms().length, 7);
    }
  });

  it("does not count unchanged exceptions toward the series alarm limit", async () => {
    const runtime = loadCalendarRuntime({ alarmMaxCount: 1 });
    const { master, occurrences } = runtime.seedSeries({ alarms: [runtime.makeAlarm()] });
    occurrences[1].alarms = unmanagedAlarms(runtime);
    master.recurrenceInfo.exceptions.push(occurrences[1]);
    const result = await runtime.invoke("updateEvent", { ...updateArgs, reminders: [30] });
    assert.equal(result.success, true, result.error);
    const item = runtime.calls.modifies[0].item;
    assert.equal(item.getAlarms().length, 1);
    assert.deepEqual(item.recurrenceInfo.exceptions[0].getAlarms(), occurrences[1].getAlarms());
  });
});
