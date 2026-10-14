"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");

function snippet(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Production markers missing: ${startMarker}`);
  return source.slice(start, end);
}

function constant(name) {
  const match = source.match(new RegExp(`^const ${name} = [^\\n]+;`, "m"));
  assert.ok(match, `Production constant missing: ${name}`);
  return match[0];
}

// The real production schemas of the header and query tools, evaluated in isolation.
function productionTools() {
  const startLf = source.indexOf('      {\n        name: "getMessageHeaders"');
  const from = startLf >= 0 ? startLf : source.indexOf('      {\r\n        name: "getMessageHeaders"');
  const end = source.indexOf('name: "sendMail"', from);
  const to = source.lastIndexOf("      {", end);
  assert.ok(from >= 0 && to > from, "production tool schemas missing");
  const sandbox = {};
  vm.runInNewContext(`this.tools = [${source.slice(from, to)}];`, sandbox);
  return sandbox.tools;
}

const ENCRYPTED_RAW = 'From: sender@example.test\r\nSubject: =?utf-8?q?Encrypted_Message?=\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"\r\n\r\n--b--\r\n';
const DECRYPTION_OKAY = 0x00020000;

/**
 * folders: [{ uri, rows, inbox }]. Each row: { id, thread, author, date (ms), hdr,
 * properties, enigmail, throwOn }. Every folder is its own account.
 */
function makeHarness({ folders, allowEncrypted = false, msPerYield = 0 } = {}) {
  const stats = { yields: 0, listAllKeys: 0, headerReads: 0 };
  let generation = 0;
  let now = 1000 * 86400 * 1000 * 365;
  const revoked = new Set();
  let onYield = null;
  const byUri = new Map();
  const accounts = [];

  for (const [folderIndex, spec] of folders.entries()) {
    const headers = new Map();
    const byMessageId = new Map();
    const folder = {
      URI: spec.uri,
      prettyName: "INBOX",
      hasSubFolders: false,
      server: null,
      updateFolder() {},
      getMsgInputStream(msgHdr) {
        let offset = 0;
        const raw = msgHdr.raw;
        return {
          available() { return Math.min(raw.length - offset, 1000); },
          read(count) { const chunk = raw.slice(offset, offset + count); offset += chunk.length; return chunk; },
          close() {},
        };
      },
      getFolderWithFlags() { return null; },
      get msgDatabase() {
        const openedGeneration = generation;
        const assertLive = () => assert.equal(openedGeneration, generation, "Database retained across a yield");
        return {
          listAllKeys() { assertLive(); stats.listAllKeys++; return Array.from(headers.keys()); },
          enumerateMessages() { assert.fail("A folder query must not open a native message enumerator"); },
          containsKey(key) { assertLive(); return headers.has(key); },
          getMsgHdrForKey(key) { assertLive(); stats.headerReads++; return headers.get(key); },
          getMsgHdrForMessageID(id) { assertLive(); return byMessageId.get(id) || null; },
        };
      },
    };
    spec.rows.forEach((row, index) => {
      const properties = { keywords: "custom", ...row.properties };
      const header = {
        messageKey: index + 1,
        messageId: row.id || `f${folderIndex}-m${index}@example.com`,
        threadId: row.thread === undefined ? 100 + index : row.thread,
        date: row.date === undefined ? (index + 1) * 1000000 : row.date * 1000,
        subject: "Raw subject",
        author: row.author || "Raw author",
        recipients: "Bob Jones",
        mime2DecodedSubject: "Decoded subject",
        mime2DecodedAuthor: row.author || "Alice Smith <alice@example.com>",
        mime2DecodedRecipients: "Bob Jones",
        ccList: "",
        flags: 0,
        isRead: true,
        isFlagged: false,
        messageSize: 321,
        folder,
        getStringProperty: name => properties[name] || "",
        getUint32Property: name => (name === "enigmail" ? (row.enigmail || 0) : 0),
        ...row.hdr,
      };
      for (const field of row.throwOn || []) {
        Object.defineProperty(header, field, { get() { throw new Error(`unreadable ${field}`); } });
      }
      headers.set(header.messageKey, header);
      byMessageId.set(header.messageId, header);
    });
    const server = { type: "imap", rootFolder: folder };
    folder.server = server;
    const account = { key: `account${folderIndex}`, incomingServer: server };
    accounts.push(account);
    byUri.set(spec.uri, { folder, account, headers });
  }

  class FakeDate extends Date {
    static now() { return now; }
  }
  const runtime = vm.createContext({
    Date: FakeDate,
    Services: {
      prefs: { getBoolPref: (name, fallback) => (name.endsWith(".allowEncryptedMessages") ? allowEncrypted : fallback) },
      tm: {
        dispatchToMainThread(resolve) {
          setImmediate(() => {
            stats.yields++;
            now += msPerYield;
            generation++;
            if (onYield) onYield(stats.yields);
            resolve();
          });
        },
      },
    },
    Ci: { nsMsgMessageFlags: { Expunged: 0x8 }, nsITimer: { TYPE_ONE_SHOT: 0 } },
    NetUtil: { readInputStreamToString: (stream, count) => stream.read(count) },
    MailServices: {
      mimeConverter: {
        decodeMimeHeader: value => value.replace(/=\?utf-8\?q\?([^?]*)\?=/gi, (_, text) => text.replace(/_/g, " ")),
      },
      folderLookup: { getFolderForURL: uri => (byUri.has(uri) ? byUri.get(uri).folder : null) },
      accounts: {
        accounts,
        findAccountForServer: server => accounts.find(a => a.incomingServer === server) || null,
      },
    },
    isAccountAllowed: key => !revoked.has(key),
    getAllowedAccountIds: () => [],
    console,
  });
  const keywordStart = source.indexOf("const INTERNAL_KEYWORDS = new Set([");
  const keywordEnd = source.indexOf("]);", keywordStart);
  const tools = productionTools();
  runtime.buildTools = () => tools;
  vm.runInContext([
    ...[
      "SEARCH_YIELD_EVERY", "SEARCH_TIME_BUDGET_MS", "MAX_HEADER_BATCH_IDS", "PREF_ALLOW_ENCRYPTED_MESSAGES",
      "DEFAULT_THREAD_RESULTS", "MAX_THREAD_RESULTS", "DEFAULT_SENDER_RESULTS", "MAX_SENDER_RESULTS",
      "DEFAULT_SENDER_SCAN_CAP", "MAX_SENDER_SCAN_CAP", "FOLDER_FLAG_INBOX",
    ].map(constant),
    snippet("// BEGIN PRIVACY PREFERENCE HELPERS", "// END PRIVACY PREFERENCE HELPERS"),
    snippet("// BEGIN RAW MIME PARSING HELPERS", "// END RAW MIME PARSING HELPERS"),
    snippet("// BEGIN PROTECTED SUBJECT HELPERS", "// END PROTECTED SUBJECT HELPERS"),
    source.slice(keywordStart, keywordEnd + 3),
    snippet("// BEGIN SEARCH RESULT HELPERS", "// END SEARCH RESULT HELPERS"),
    snippet("function isFolderAccessible(", "function toColumnarTable("),
    snippet("function getUserTags(", "// BEGIN OUTBOUND ATTACHMENT CONVERSION"),
    snippet("function openFolder(", "function findTrashFolder("),
    snippet("// BEGIN MESSAGE HEADER READ TOOLS", "// END MESSAGE HEADER READ TOOLS"),
    snippet("// BEGIN INLINE ATTACHMENT BASE64 HELPERS", "// END INLINE ATTACHMENT BASE64 HELPERS"),
    snippet("// BEGIN TOOL SCHEMA VALIDATOR", "// END TOOL SCHEMA VALIDATOR"),
    snippet("// BEGIN MCP TEXT SANITIZATION", "// END MCP TEXT SANITIZATION"),
    snippet("// BEGIN TOOL CALL DISPATCH", "// END TOOL CALL DISPATCH"),
  ].join("\n"), runtime);

  return {
    runtime,
    stats,
    now: () => now,
    rows: uri => byUri.get(uri).headers,
    accountKey: uri => byUri.get(uri).account.key,
    revoke(uri) { revoked.add(byUri.get(uri).account.key); },
    setOnYield(callback) { onYield = callback; },
    async call(name, args) {
      const result = await runtime.callTool(name, args);
      return JSON.parse(JSON.stringify(result));
    },
  };
}

const INBOX = "imap://account0/INBOX";
const rowsOf = (count, make = () => ({})) => Array.from({ length: count }, (_, i) => make(i));
const oneFolder = rows => makeHarness({ folders: [{ uri: INBOX, rows }] });

describe("query tool schemas", () => {
  const tools = Object.fromEntries(productionTools().map(t => [t.name, t.inputSchema]));

  it("declare the bounds the handlers clamp to", () => {
    const thread = tools.searchByThread.properties;
    assert.equal(thread.maxResults.minimum, 1);
    assert.equal(thread.maxResults.maximum, 500);
    assert.equal(thread.messageId.minLength, 1);
    assert.equal(thread.folderPath.minLength, 1);
    const sender = tools.getSenderHistory.properties;
    assert.equal(sender.maxResults.maximum, 200);
    assert.equal(sender.scanCap.maximum, 50000);
    assert.equal(sender.scanCap.minimum, 1);
    assert.equal(sender.sinceDays.minimum, 1);
    assert.equal(sender.email.minLength, 1);
  });

  it("keep the schema maximums in sync with the handler constants", () => {
    const h = oneFolder([]);
    assert.equal(vm.runInContext("MAX_THREAD_RESULTS", h.runtime), tools.searchByThread.properties.maxResults.maximum);
    assert.equal(vm.runInContext("MAX_SENDER_RESULTS", h.runtime), tools.getSenderHistory.properties.maxResults.maximum);
    assert.equal(vm.runInContext("MAX_SENDER_SCAN_CAP", h.runtime), tools.getSenderHistory.properties.scanCap.maximum);
  });

  it("reject empty strings through the production validator", () => {
    const h = oneFolder([]);
    assert.match(h.runtime.validateToolArgs("searchByThread", { messageId: "", folderPath: INBOX })[0], /at least 1 character/);
    assert.match(h.runtime.validateToolArgs("getSenderHistory", { email: "" })[0], /at least 1 character/);
  });
});

describe("searchByThread", () => {
  it("returns the shared header shape, newest-first, anchor included", async () => {
    const h = oneFolder([
      { id: "a@x", thread: 7, date: 1000 },
      { id: "b@x", thread: 7, date: 3000 },
      { id: "other@x", thread: 8, date: 5000 },
      { id: "c@x", thread: 7, date: 2000 },
    ]);
    const result = await h.call("searchByThread", { messageId: "a@x", folderPath: INBOX });
    assert.equal(result.threadId, 7);
    assert.equal(typeof result.threadId, "number");
    assert.equal(result.anchorId, "a@x");
    assert.deepEqual(result.thread.map(m => m.id), ["b@x", "c@x", "a@x"]);
    assert.equal(result.total, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.notScanned, undefined);
    assert.deepEqual(Object.keys(result.thread[0]).sort(), [
      "author", "ccList", "date", "flagged", "id", "inReplyTo", "read", "recipients",
      "references", "size", "subject", "tags", "threadId",
    ]);
    assert.equal(result.thread[0].read, true);
    assert.equal(result.thread[0].threadId, 7);
  });

  it("scans cooperatively past 50,000 rows without a native enumerator", async () => {
    const rows = rowsOf(60000, i => ({ thread: 1000 + i }));
    rows[59990].thread = 5;
    rows[10].thread = 5;
    const h = oneFolder(rows);
    const result = await h.call("searchByThread", { messageId: "f0-m10@example.com", folderPath: INBOX });
    assert.equal(result.total, 2);
    assert.equal(result.truncated, false);
    assert.ok(h.stats.yields >= Math.floor(60000 / 250) - 1, `expected a yield every 250 rows, saw ${h.stats.yields}`);
  });

  it("reports the result cap as truncated with the full match total", async () => {
    const h = oneFolder(rowsOf(30, i => ({ thread: 1, date: i + 1 })));
    const result = await h.call("searchByThread", { messageId: "f0-m0@example.com", folderPath: INBOX, maxResults: 5 });
    assert.equal(result.thread.length, 5);
    assert.equal(result.total, 30);
    assert.equal(result.truncated, true);
    assert.equal(result.notScanned, undefined);
    // Newest rows win even though the scan met them last.
    assert.equal(result.thread[0].id, "f0-m29@example.com");
  });

  it("clamps an over-cap maxResults to 500", async () => {
    const h = oneFolder(rowsOf(600, () => ({ thread: 1 })));
    const result = await h.call("searchByThread", { messageId: "f0-m0@example.com", folderPath: INBOX, maxResults: 99999 });
    assert.equal(result.thread.length, 500);
    assert.equal(result.total, 600);
    assert.equal(result.truncated, true);
  });

  it("flags an unfinished scan as notScanned instead of returning a silent partial thread", async () => {
    const rows = rowsOf(5000, i => ({ thread: i === 4000 ? 1 : (i === 0 ? 1 : 100 + i) }));
    const h = makeHarness({ folders: [{ uri: INBOX, rows }], msPerYield: 6000 });
    const result = await h.call("searchByThread", { messageId: "f0-m0@example.com", folderPath: INBOX });
    assert.equal(result.truncated, true);
    assert.equal(result.notScanned, true);
    assert.match(result.message, /20-second time budget/);
    assert.deepEqual(result.thread.map(m => m.id), ["f0-m0@example.com"]);
    assert.ok(h.stats.headerReads < 5000, "bounded by the time budget");
  });

  it("treats unreadable rows as an incomplete scan", async () => {
    const rows = rowsOf(20, () => ({ thread: 1 }));
    rows[5].throwOn = ["flags"];
    const result = await oneFolder(rows).call("searchByThread", { messageId: "f0-m0@example.com", folderPath: INBOX });
    assert.equal(result.notScanned, true);
    assert.doesNotMatch(result.message, /time budget/);
  });

  it("returns the anchor alone when it has no thread id", async () => {
    const result = await oneFolder([{ id: "a@x", thread: 0 }, { id: "b@x", thread: 0 }])
      .call("searchByThread", { messageId: "a@x", folderPath: INBOX });
    assert.equal(result.threadId, null);
    assert.equal(result.anchored, true);
    assert.deepEqual(result.thread.map(m => m.id), ["a@x"]);
    assert.equal(result.truncated, false);
  });

  it("distinguishes an absent anchor from an unscanned one", async () => {
    const absent = await oneFolder(rowsOf(10)).call("searchByThread", { messageId: "nope@x", folderPath: INBOX });
    assert.deepEqual(absent, { error: "Message not found: nope@x" });

    const slow = makeHarness({ folders: [{ uri: INBOX, rows: rowsOf(2000) }], msPerYield: 25000 });
    slow.runtime.MailServices.folderLookup.getFolderForURL(INBOX).msgDatabase;
    const unknown = await slow.call("searchByThread", { messageId: "nope@x", folderPath: INBOX });
    assert.equal(unknown.notScanned, true);
    assert.match(unknown.error, /time budget/);
  });

  it("withholds encrypted subjects like the base header tools", async () => {
    const rows = [{ id: "e@x", thread: 1, enigmail: DECRYPTION_OKAY, hdr: { raw: ENCRYPTED_RAW, mime2DecodedSubject: "Cached decrypted subject" } }];
    const blocked = await oneFolder(rows).call("searchByThread", { messageId: "e@x", folderPath: INBOX });
    assert.equal(blocked.thread[0].subject, "Encrypted Message");
    assert.doesNotMatch(JSON.stringify(blocked), /Cached decrypted/);
    const open = await makeHarness({ folders: [{ uri: INBOX, rows }], allowEncrypted: true })
      .call("searchByThread", { messageId: "e@x", folderPath: INBOX });
    assert.equal(open.thread[0].subject, "Cached decrypted subject");
  });

  it("returns an error and no rows when access is revoked during the scan", async () => {
    const h = oneFolder(rowsOf(2000, () => ({ thread: 1 })));
    h.setOnYield(() => h.revoke(INBOX));
    const result = await h.call("searchByThread", { messageId: "f0-m0@example.com", folderPath: INBOX });
    assert.match(result.error, /not accessible/);
    assert.equal(result.thread, undefined);
  });

  it("returns { error } for guards, unknown folders and unexpected exceptions", async () => {
    const h = oneFolder(rowsOf(2));
    assert.match((await h.runtime.searchByThread("", INBOX)).error, /non-empty string/);
    assert.match((await h.call("searchByThread", { messageId: "x", folderPath: "imap://account0/Missing" })).error, /Folder not found/);
    h.runtime.openFolder = () => { throw new Error("boom"); };
    assert.match((await h.runtime.searchByThread("f0-m0@example.com", INBOX)).error, /boom/);
  });
});

describe("getSenderHistory", () => {
  const DAY = 86400 * 1000;

  it("matches the sender case-insensitively, newest-first, in the shared shape plus folderPath", async () => {
    const h = oneFolder([
      { id: "1@x", author: "Alice <ALICE@example.com>", date: 1000 },
      { id: "2@x", author: "Bob <bob@example.com>", date: 9000 },
      { id: "3@x", author: "alice@example.com", date: 3000 },
    ]);
    const result = await h.call("getSenderHistory", { email: "Alice@Example.com" });
    assert.deepEqual(result.messages.map(m => m.id), ["3@x", "1@x"]);
    assert.equal(result.messages[0].folderPath, INBOX);
    assert.equal(result.messages[0].read, true);
    assert.equal(result.messages[0].threadId, 102);
    assert.equal(result.totalScanned, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.notScanned, undefined);
  });

  it("scans every account so newest-first holds across them", async () => {
    const h = makeHarness({
      folders: [
        { uri: "imap://account0/INBOX", rows: rowsOf(5, i => ({ id: `old${i}@x`, date: 1000 + i })) },
        { uri: "imap://account1/INBOX", rows: rowsOf(3, i => ({ id: `new${i}@x`, date: 50000 + i })) },
      ],
    });
    const result = await h.call("getSenderHistory", { email: "alice", maxResults: 4 });
    assert.deepEqual(result.messages.map(m => m.id), ["new2@x", "new1@x", "new0@x", "old4@x"]);
    assert.equal(result.truncated, true, "matches exceeded maxResults");
    assert.equal(result.notScanned, undefined);
  });

  it("skips accounts that are not accessible", async () => {
    const h = makeHarness({
      folders: [
        { uri: "imap://account0/INBOX", rows: [{ id: "ok@x" }] },
        { uri: "imap://account1/INBOX", rows: [{ id: "hidden@x" }] },
      ],
    });
    h.revoke("imap://account1/INBOX");
    const result = await h.call("getSenderHistory", { email: "alice" });
    assert.deepEqual(result.messages.map(m => m.id), ["ok@x"]);
  });

  it("applies sinceDays", async () => {
    const h = oneFolder([]);
    const nowMs = h.now();
    const fresh = makeHarness({
      folders: [{ uri: INBOX, rows: [
        { id: "recent@x", date: nowMs - 2 * DAY },
        { id: "stale@x", date: nowMs - 40 * DAY },
      ] }],
    });
    const result = await fresh.call("getSenderHistory", { email: "alice", sinceDays: 30 });
    assert.deepEqual(result.messages.map(m => m.id), ["recent@x"]);
  });

  it("reports a folder that hits scanCap in notScanned and as truncated", async () => {
    const h = oneFolder(rowsOf(50, (i) => ({ id: `m${i}@x`, date: i + 1 })));
    const result = await h.call("getSenderHistory", { email: "alice", scanCap: 10, maxResults: 200 });
    assert.equal(result.totalScanned, 10);
    assert.equal(result.messages.length, 10);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.notScanned, [INBOX]);
    assert.match(result.message, /scanCap \(10\)/);

    const exact = await oneFolder(rowsOf(10)).call("getSenderHistory", { email: "alice", scanCap: 10 });
    assert.equal(exact.truncated, false, "a folder exactly at the cap was fully examined");
  });

  it("scans past 50,000 rows cooperatively with one shared budget", async () => {
    const h = oneFolder(rowsOf(60000, i => ({ author: i === 59999 ? "target@example.com" : "other@example.com" })));
    const result = await h.call("getSenderHistory", { email: "target@", scanCap: 50000 + 10000 });
    assert.equal(result.messages.length, 0, "scanCap clamps to 50,000 so the last row is not examined");
    assert.deepEqual(result.notScanned, [INBOX]);
    assert.ok(h.stats.yields >= 50000 / 250 - 1);
  });

  it("marks later accounts notScanned when the shared time budget runs out", async () => {
    const h = makeHarness({
      folders: [
        { uri: "imap://account0/INBOX", rows: rowsOf(3000) },
        { uri: "imap://account1/INBOX", rows: rowsOf(10) },
      ],
      msPerYield: 6000,
    });
    const result = await h.call("getSenderHistory", { email: "alice", maxResults: 200 });
    assert.equal(result.truncated, true);
    assert.ok(result.notScanned.includes("imap://account0/INBOX"));
    assert.ok(result.notScanned.includes("imap://account1/INBOX"));
    assert.match(result.message, /20-second time budget/);
    assert.ok(h.stats.headerReads < 3010);
  });

  it("treats unreadable rows as an incomplete scan", async () => {
    const rows = rowsOf(10);
    rows[2].throwOn = ["flags"];
    const result = await oneFolder(rows).call("getSenderHistory", { email: "alice" });
    assert.deepEqual(result.notScanned, [INBOX]);
    assert.equal(result.truncated, true);
  });

  it("withholds encrypted subjects like the base header tools", async () => {
    const rows = [{ id: "e@x", enigmail: DECRYPTION_OKAY, hdr: { raw: ENCRYPTED_RAW, mime2DecodedSubject: "Cached decrypted subject" } }];
    const result = await oneFolder(rows).call("getSenderHistory", { email: "alice" });
    assert.equal(result.messages[0].subject, "Encrypted Message");
    assert.doesNotMatch(JSON.stringify(result), /Cached decrypted/);
  });

  it("drops rows from an account revoked during the scan", async () => {
    const h = makeHarness({
      folders: [
        { uri: "imap://account0/INBOX", rows: rowsOf(600) },
        { uri: "imap://account1/INBOX", rows: rowsOf(5) },
      ],
    });
    h.setOnYield(() => h.revoke("imap://account0/INBOX"));
    const result = await h.call("getSenderHistory", { email: "alice", maxResults: 200 });
    assert.ok(result.messages.every(m => m.folderPath !== "imap://account0/INBOX"));
    assert.ok(result.notScanned.includes("imap://account0/INBOX"));
  });

  it("clamps maxResults to 200 and returns { error } for bad input or exceptions", async () => {
    const h = oneFolder(rowsOf(300));
    const result = await h.call("getSenderHistory", { email: "alice", maxResults: 99999 });
    assert.equal(result.messages.length, 200);
    assert.equal(result.truncated, true);
    assert.match((await h.runtime.getSenderHistory("  ")).error, /non-empty string/);
    h.runtime.getAccessibleAccounts = () => { throw new Error("boom"); };
    assert.match((await h.runtime.getSenderHistory("alice")).error, /boom/);
  });
});
