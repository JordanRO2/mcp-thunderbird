"use strict";

// Launched by message-headers/search-attachments tests, with production snippets
// on stdin. Both consumers must release native handles while awaiting work.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const scenario = process.argv[2];
const lookup = scenario === "lookup" || scenario === "lookup-without-direct";
const attachments = scenario === "attachments";
const ATTACHMENT_RAW = 'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\n\r\nA clear attachment.\r\n';
const tracked = [];
const state = {
  rows: 0, databases: 0, headers: 0, snapshots: 0, directHits: 0,
  directCalls: [], keyReads: [], visited: [], serialized: [],
  yields: 0, resume: null, settled: false,
  mimeCallback: null, parseTimer: null,
};

function messageId(key) { return `m-${key}@example.test`; }

function track(handle, label) {
  tracked.push({ ref: new WeakRef(handle), label });
  return handle;
}

// Shared methods live outside the allocation frames. No surviving callback or
// fixture index may capture a header/database, even through a shared scope.
function getStringProperty(name) {
  if (name === "references") {
    state.serialized.push({ key: this.messageKey, yield: state.yields });
    return "<parent@example.test>";
  }
  return name === "keywords" ? "custom junk" : "";
}

function getUint32Property() { return 0; }

function makeHeader(key, origin) {
  state.headers++;
  return track({
    messageKey: key,
    messageId: messageId(key),
    threadId: key + 100,
    date: key * 1000000,
    mime2DecodedSubject: `Subject ${key} at yield ${state.yields}`,
    mime2DecodedAuthor: "Alice",
    mime2DecodedRecipients: "Bob",
    ccList: "copy@example.test",
    flags: attachments ? 0x10000080 : 0,
    isRead: true,
    isFlagged: false,
    messageSize: 321,
    folder,
    getStringProperty,
    getUint32Property,
  }, `header ${state.headers}: ${origin}, key ${key}`);
}

function listAllKeys() {
  state.snapshots++;
  return Array.from({ length: state.rows }, (_, index) => index + 1);
}

function containsKey(key) { return Number.isInteger(key) && key >= 1 && key <= state.rows; }

function getMsgHdrForKey(key) {
  state.keyReads.push(key);
  return makeHeader(key, "key lookup");
}

function getMsgHdrForMessageID(id) {
  state.directCalls.push(id);
  if (id !== messageId(2)) return null;
  state.directHits++;
  return makeHeader(2, "direct hit");
}

function enumerateMessages() { assert.fail("Must not open a native header enumerator"); }

function makeDatabase() {
  state.databases++;
  const database = { listAllKeys, containsKey, getMsgHdrForKey, enumerateMessages };
  if (scenario !== "lookup-without-direct") database.getMsgHdrForMessageID = getMsgHdrForMessageID;
  return track(database, `database ${state.databases}`);
}

const folder = {
  URI: "imap://account1/INBOX",
  prettyName: "INBOX",
  server: { type: "imap" },
  updateFolder() {},
  getMsgInputStream() {
    let offset = 0;
    return {
      available: () => ATTACHMENT_RAW.length - offset,
      read(count) { const bytes = ATTACHMENT_RAW.slice(offset, offset + count); offset += bytes.length; return bytes; },
      close() {},
    };
  },
  get msgDatabase() { return makeDatabase(); },
};
const account = { key: "account1", incomingServer: folder.server };

class FakeDate extends Date {
  static now() { return 0; }
}

function dispatchToMainThread(resolve) {
  assert.equal(state.resume, null, "Only one production yield may be pending");
  state.yields++;
  state.resume = resolve;
}

function visit(header) { state.visited.push(header.messageKey); }

function progress() {
  return {
    databases: state.databases, headers: state.headers, snapshots: state.snapshots,
    directHits: state.directHits, directCalls: state.directCalls.length,
    keyReads: state.keyReads.length, visited: state.visited.length,
    serialized: state.serialized.length, tracked: tracked.length, yields: state.yields,
  };
}

async function assertCollected(checkpoint, assertPending) {
  let survivors;
  for (let attempt = 0; attempt < 20; attempt++) {
    // WeakRef construction/deref keeps targets alive for the current job.
    // Each retry must cross a turn before GC, and retain only labels afterward.
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
    if (assertPending) assertPending();
    survivors = tracked.filter(({ ref }) => ref.deref() !== undefined).map(({ label }) => label);
    if (survivors.length === 0) return;
  }
  assert.fail(`${scenario} ${checkpoint}: retained handles: ${survivors.join(", ")}`);
}

function releaseYield() {
  const resolve = state.resume;
  state.resume = null;
  resolve();
}

async function main() {
  assert.ok(["forward", "reverse", "lookup", "lookup-without-direct", "attachments"].includes(scenario));
  assert.equal(typeof global.gc, "function", "Child requires --expose-gc");
  const runtime = vm.createContext({
    Date: FakeDate,
    TextDecoder, Uint8Array, atob, btoa,
    Services: { prefs: { getBoolPref: () => false }, tm: { dispatchToMainThread } },
    Ci: { nsMsgMessageFlags: { Expunged: 0x8, Offline: 0x80, Partial: 0x400, Attachment: 0x10000000 }, nsITimer: { TYPE_ONE_SHOT: 0 } },
    Cc: { "@mozilla.org/timer;1": { createInstance() {
      return { initWithCallback(callback) { state.parseTimer = callback; }, cancel() {} };
    } } },
    Cr: { NS_BASE_STREAM_CLOSED: 1 },
    NetUtil: { readInputStreamToString: (stream, count) => stream.read(count) },
    ChromeUtils: { importESModule: () => ({
      MsgHdrToMimeMessage(_hdr, _parts, callback) { state.mimeCallback = callback; },
    }) },
    MailServices: {
      mimeConverter: { decodeMimeHeader: value => value },
      folderLookup: { getFolderForURL: uri => uri === folder.URI ? folder : null },
      accounts: { findAccountForServer: server => server === folder.server ? account : null },
    },
    isAccountAllowed: () => true,
    isToolEnabled: () => true,
  });
  vm.runInContext(fs.readFileSync(0, "utf8"), runtime, { filename: "api-message-header-retention.js" });
  if (attachments) {
    state.rows = 1;
    for (const timeout of [false, true]) {
      state.settled = false;
      state.mimeCallback = null;
      const pending = runtime.run("invoice", undefined, folder.URI).then(value => {
        state.settled = true;
        return value;
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof state.resume, "function", "Raw admission must yield");
      await assertCollected("raw admission", () => assert.equal(state.settled, false));
      releaseYield();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof state.mimeCallback, "function", "Native parse must be pending");
      assert.equal(runtime.pool.live, 1);
      await assertCollected("awaiting MIME", () => assert.equal(state.settled, false));
      const mime = { contentType: "application/pdf", allUserAttachments: [
        { name: "invoice.pdf", contentType: "application/pdf", size: 19 },
      ] };
      if (timeout) state.parseTimer.notify();
      else state.mimeCallback(null, mime);
      const result = await pending;
      assert.equal(result.messages.length, timeout ? 0 : 1);
      assert.equal(result.truncated, timeout);
      assert.equal(runtime.pool.live, timeout ? 1 : 0);
      // Keep the response and native callback alive even after a timeout.
      await assertCollected("settled search with callback retained");
      if (timeout) {
        assert.equal(result.notParsed, 1);
        state.mimeCallback(null, mime);
        state.mimeCallback(null, mime);
        assert.equal(result.messages.length, 0);
        assert.equal(runtime.pool.live, 0);
        await assertCollected("late callback");
      }
    }
    process.stdout.write(JSON.stringify({ scenario, ok: true }) + "\n");
    return;
  }
  const chunkSize = vm.runInContext("SEARCH_YIELD_EVERY", runtime);
  assert.ok(Number.isInteger(chunkSize) && chunkSize > 1);
  state.rows = 3 * chunkSize + 1;
  // Keep the last direct call a HIT, to expose a retained last-header local.
  // The first ID is scan-only and must leave a detached result across all yields.
  const requested = [messageId(1), messageId(chunkSize + 1), "absent@example.test", messageId(2)];
  const pending = lookup
    ? runtime.readMessageHeaders(requested, folder.URI)
    : runtime.scanFolderCooperatively(folder, { deadline: 1e9 }, visit, { newestFirst: scenario === "reverse" });
  // Keep the operation and its continuation alive throughout the checkpoints.
  // Record failures without an unhandled rejection while the driver checks GC.
  const completion = pending.then(value => {
    state.settled = true;
    return { value };
  }).catch(error => {
    state.settled = true;
    return { error };
  });

  let checkedYields = 0;
  for (let yieldNumber = 1; yieldNumber <= 3; yieldNumber++) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.settled, false, "Operation must still be pending");
    assert.equal(typeof state.resume, "function", "Production must be suspended at a yield");
    assert.equal(state.yields, yieldNumber);
    assert.equal(state.snapshots, 1);
    assert.equal(state.databases, (lookup ? 2 : 1) + yieldNumber,
      "Track the initial open (lookup only), snapshot, and every chunk database");
    assert.equal(state.directHits, scenario === "lookup" ? 1 : 0);
    assert.deepEqual(state.directCalls, scenario === "lookup" ? requested : []);
    assert.equal(state.keyReads.length, yieldNumber * chunkSize);
    assert.equal(state.headers, yieldNumber * chunkSize + state.directHits);
    assert.equal(tracked.length, state.databases + state.headers);
    assert.equal(state.visited.length, lookup ? 0 : yieldNumber * chunkSize);
    if (lookup) {
      assert.ok(state.serialized.some(row => row.key === 1 && row.yield === 0),
        "The first-chunk scan hit must already have been serialized");
    }

    const before = progress();
    const resolver = state.resume;
    await assertCollected(`yield ${yieldNumber}`, () => {
      assert.equal(state.settled, false, "GC must happen while the operation is pending");
      assert.equal(state.resume, resolver, "The production yield must remain unresolved");
      assert.deepEqual(progress(), before, "No scan/lookup progress is allowed during GC");
    });
    checkedYields++;
    releaseYield();
  }

  const outcome = await completion;
  if (outcome.error) throw outcome.error;
  assert.equal(state.settled, true);
  assert.equal(state.resume, null);
  assert.equal(state.yields, 3);
  const expectedKeys = Array.from({ length: state.rows }, (_, index) => index + 1);
  if (scenario === "reverse") expectedKeys.reverse();
  assert.deepEqual(state.keyReads.slice(0, state.rows), expectedKeys);
  if (lookup) {
    const result = outcome.value;
    assert.equal(result.error, undefined);
    assert.equal(result.headers.size, 3);
    assert.deepEqual([...result.notFound], ["absent@example.test"]);
    assert.deepEqual([...result.notScanned], []);
    assert.equal(result.timedOut, false);
    for (const [key, capturedYield] of [[1, 0], [2, 0], [chunkSize + 1, 1]]) {
      const header = result.headers.get(messageId(key));
      assert.equal(header.id, messageId(key));
      assert.equal(header.subject, `Subject ${key} at yield ${capturedYield}`);
      assert.equal(header.inReplyTo, "parent@example.test");
      assert.deepEqual([...header.tags], ["custom"]);
    }
  } else {
    assert.deepEqual({ ...outcome.value }, { complete: true, stopped: false, scanned: state.rows });
    assert.deepEqual(state.visited, expectedKeys);
  }
  // The tail chunk and reader's final privacy rechecks have no subsequent yield.
  // Keep the returned snapshots alive while checking those remaining handles too.
  await assertCollected("after completion");
  assert.ok(outcome.value);
  process.stdout.write(JSON.stringify({ scenario, checkedYields, ok: true }) + "\n");
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
