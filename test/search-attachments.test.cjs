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

function productionSchema() {
  const re = /^ {6}\{\r?\n {8}name: "searchAttachments"/m;
  const match = re.exec(source);
  assert.ok(match, "production searchAttachments schema missing");
  const end = source.indexOf('name: "sendMail"', match.index);
  const to = source.lastIndexOf("      {", end);
  const sandbox = {};
  vm.runInNewContext(`this.tool = ${source.slice(match.index, to).trim().replace(/,\s*$/, "")};`, sandbox);
  return sandbox.tool;
}

const ATTACH = 0x10000000;
const DECRYPTION_OKAY = 0x00020000;
const PDF = { name: "Invoice.PDF", contentType: "application/pdf", size: 10 };
const PNG = { name: "photo.png", contentType: "image/png", size: 20 };

/**
 * rows: { attach?: bool, atts?: [...], enigmail?, mime?: "hang"|"null"|"throw"|object }
 * Parsing is driven by the harness: each MsgHdrToMimeMessage call is recorded and
 * completed by `mime(row)` on a later macrotask, so the in-flight count is real.
 */
function makeHarness({ rows, allowEncrypted = false, parseDelayMs = 0, msPerYield = 0, timerThrows = false } = {}) {
  const stats = {
    yields: 0, listAllKeys: 0, mimeCalls: 0, inFlight: 0, maxInFlight: 0,
    timersCreated: 0, timersCancelled: 0, mimeArgs: [],
  };
  let generation = 0;
  let now = 0;
  let accessible = true;
  let onYield = null;
  const timers = [];
  const headers = new Map();

  const folder = {
    URI: "imap://account1/INBOX",
    prettyName: "INBOX",
    isServer: false,
    server: null,
    updateFolder() {},
    get msgDatabase() {
      const openedGeneration = generation;
      const assertLive = () => assert.equal(openedGeneration, generation, "Database retained across a yield");
      return {
        listAllKeys() { assertLive(); stats.listAllKeys++; return Array.from(headers.keys()); },
        enumerateMessages() { assert.fail("The attachment scan must not open a native message enumerator"); },
        containsKey(key) { assertLive(); return headers.has(key); },
        getMsgHdrForKey(key) { assertLive(); return headers.get(key); },
      };
    },
  };
  const root = { getFolderWithFlags: flag => (flag === 0x1000 ? folder : null) };

  rows.forEach((row, index) => {
    const header = {
      messageKey: index + 1,
      messageId: `m-${index}@example.com`,
      threadId: 100 + index,
      date: (index + 1) * 1000000,
      subject: "Subject",
      author: "Alice",
      recipients: "Bob",
      mime2DecodedSubject: "Subject",
      mime2DecodedAuthor: "Alice",
      mime2DecodedRecipients: "Bob",
      ccList: "",
      flags: row.attach === false ? 0 : ATTACH,
      isRead: false,
      isFlagged: true,
      messageSize: 5,
      folder,
      getStringProperty: () => "",
      getUint32Property: name => (name === "enigmail" ? (row.enigmail || 0) : 0),
      row,
    };
    headers.set(header.messageKey, header);
  });

  const account = { key: "account1", incomingServer: { type: "imap", rootFolder: root } };
  folder.server = account.incomingServer;

  class FakeDate extends Date {
    static now() { return now; }
  }

  function MsgHdrToMimeMessage(hdr, partsOfInterest, callback, ...rest) {
    stats.mimeCalls++;
    stats.mimeArgs.push(rest.length);
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const row = hdr.row;
    if (row.mime === "throw") { stats.inFlight--; throw new Error("sync failure"); }
    const finish = () => {
      stats.inFlight--;
      if (row.mime === "null") callback(hdr, null);
      else if (row.mime === "cbthrow") callback(hdr, { get allUserAttachments() { throw new Error("boom"); } });
      else callback(hdr, row.mimeMessage || { contentType: "multipart/mixed", parts: [], allUserAttachments: row.atts || [PDF] });
    };
    if (row.mime === "hang") {
      // Never completes by itself; a late callback may still arrive via row.release().
      row.release = () => { stats.inFlight--; callback(hdr, { contentType: "multipart/mixed", parts: [], allUserAttachments: [PDF] }); };
      return;
    }
    setTimeout(finish, parseDelayMs);
  }

  const runtime = vm.createContext({
    Date: FakeDate,
    setTimeout,
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
    Cc: {
      "@mozilla.org/timer;1": {
        createInstance() {
          if (timerThrows) throw new Error("no timer");
          stats.timersCreated++;
          const timer = {
            cancelled: false,
            initWithCallback(callback, ms) { timer.callback = callback; timer.ms = ms; },
            cancel() { timer.cancelled = true; stats.timersCancelled++; },
          };
          timers.push(timer);
          return timer;
        },
      },
    },
    ChromeUtils: { importESModule: () => ({ MsgHdrToMimeMessage }) },
    NetUtil: { readInputStreamToString: () => "" },
    MailServices: {
      mimeConverter: { decodeMimeHeader: value => value },
      folderLookup: { getFolderForURL: uri => (uri === folder.URI ? folder : null) },
      accounts: { accounts: [account], findAccountForServer: () => (accessible ? account : null) },
    },
    isAccountAllowed: () => true,
    getAllowedAccountIds: () => [],
    console,
  });
  const keywordStart = source.indexOf("const INTERNAL_KEYWORDS = new Set([");
  const keywordEnd = source.indexOf("]);", keywordStart);
  vm.runInContext([
    ...["SEARCH_YIELD_EVERY", "SEARCH_TIME_BUDGET_MS", "PREF_ALLOW_ENCRYPTED_MESSAGES"].map(constant),
    snippet("// BEGIN PRIVACY PREFERENCE HELPERS", "// END PRIVACY PREFERENCE HELPERS"),
    snippet("// BEGIN RAW MIME PARSING HELPERS", "// END RAW MIME PARSING HELPERS"),
    snippet("// BEGIN RAW MIME ATTACHMENT HELPERS", "// END RAW MIME ATTACHMENT HELPERS"),
    snippet("// BEGIN ENCRYPTED MESSAGE GUARD", "// END ENCRYPTED MESSAGE GUARD"),
    source.slice(keywordStart, keywordEnd + 3),
    snippet("// BEGIN SEARCH RESULT HELPERS", "// END SEARCH RESULT HELPERS"),
    snippet("function isFolderAccessible(", "function toColumnarTable("),
    snippet("function getUserTags(", "// BEGIN OUTBOUND ATTACHMENT CONVERSION"),
    snippet("function openFolder(", "function findTrashFolder("),
    snippet("// BEGIN ATTACHMENT SEARCH TOOL", "// END ATTACHMENT SEARCH TOOL"),
    "this.run = searchAttachments; this.constants = { MAX_MIME_CONCURRENCY, MIME_PARSE_TIMEOUT_MS };",
  ].join("\n"), runtime);

  return {
    runtime, folder, stats, headers, timers,
    get constants() { return runtime.constants; },
    advance(ms) { now += ms; },
    revokeAccess() { accessible = false; },
    setOnYield(callback) { onYield = callback; },
    async call(...args) {
      return JSON.parse(JSON.stringify(await runtime.run(...args)));
    },
  };
}

const rowsOf = (count, extra = {}) => Array.from({ length: count }, () => ({ ...extra }));

describe("searchAttachments schema", () => {
  it("bounds its inputs and declares no required parameters", () => {
    const tool = productionSchema();
    assert.equal(tool.group, "messages");
    assert.equal(tool.crud, "read");
    assert.equal(tool.inputSchema.required.length, 0);
    assert.equal(tool.inputSchema.properties.nameContains.minLength, 1);
    assert.equal(tool.inputSchema.properties.contentType.minLength, 1);
    assert.equal(tool.inputSchema.properties.maxResults.type, "integer");
    assert.equal(tool.inputSchema.properties.scanCap.type, "integer");
    assert.match(tool.description, /untrusted external data/);
  });
});

describe("searchAttachments results", () => {
  it("returns the shared header shape plus folderPath and matchingAttachments", async () => {
    const h = makeHarness({ rows: [{ atts: [PDF, PNG] }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 1);
    const match = result.matches[0];
    assert.equal(match.id, "m-0@example.com");
    assert.equal(match.read, false);
    assert.equal(match.flagged, true);
    assert.equal(typeof match.threadId, "number");
    assert.equal(match.folderPath, h.folder.URI);
    assert.deepEqual(match.matchingAttachments, [PDF]);
    assert.equal("_ts" in match, false);
    assert.equal("isRead" in match, false);
  });

  it("matches filename substrings and content-type prefixes case-insensitively, combined with AND", async () => {
    const h = makeHarness({ rows: [{ atts: [PDF] }, { atts: [PNG] }] });
    assert.equal((await h.call("INVOICE")).matches.length, 1);
    assert.equal((await h.call(undefined, "IMAGE/")).matches.length, 1);
    assert.equal((await h.call("invoice", "image/")).matches.length, 0);
    assert.equal((await h.call("photo", "image/png")).matches.length, 1);
  });

  it("requires at least one filter and rejects non-string filters", async () => {
    const h = makeHarness({ rows: rowsOf(1) });
    assert.match((await h.call()).error, /at least one/);
    assert.match((await h.call("  ", "")).error, /at least one/);
    assert.match((await h.call(42, {})).error, /at least one/);
    assert.equal(h.stats.mimeCalls, 0);
  });

  it("returns newest first and caps at maxResults with truncation reported", async () => {
    const h = makeHarness({ rows: rowsOf(10) });
    const result = await h.call("invoice", undefined, h.folder.URI, 3);
    assert.deepEqual(result.matches.map(m => m.id), ["m-9@example.com", "m-8@example.com", "m-7@example.com"]);
    assert.equal(result.truncated, true);
    assert.match(result.message, /maxResults/);
  });

  it("returns an error for an unknown folder, and { error } on unexpected exceptions", async () => {
    const h = makeHarness({ rows: rowsOf(1) });
    assert.match((await h.call("x", undefined, "imap://nowhere/INBOX")).error, /Folder not found/);
    h.runtime.getAccessibleAccounts = () => { throw new Error("kaboom"); };
    assert.match((await h.call("x")).error, /kaboom/);
  });

  it("scans the inbox of each accessible account when no folder is given", async () => {
    const h = makeHarness({ rows: [{}] });
    const result = await h.call("invoice");
    assert.equal(result.matches.length, 1);
  });
});

describe("searchAttachments cooperative scan", () => {
  it("snapshots keys, yields, never retains a database or opens a native enumerator", async () => {
    const h = makeHarness({ rows: rowsOf(600, { attach: false }) });
    const result = await h.call("x", undefined, h.folder.URI);
    assert.equal(result.totalScanned, 600);
    assert.equal(result.truncated, false);
    assert.equal(h.stats.listAllKeys, 1);
    assert.ok(h.stats.yields >= 2, "the scan must yield between batches");
    assert.equal(h.stats.mimeCalls, 0, "messages without the attachment flag are never parsed");
  });

  it("stops at scanCap, preferring the newest messages, and reports truncation", async () => {
    const h = makeHarness({ rows: rowsOf(50) });
    const result = await h.call("invoice", undefined, h.folder.URI, 200, 5);
    assert.equal(result.totalScanned, 5);
    assert.equal(result.candidates, 5);
    assert.deepEqual(result.matches.map(m => m.id)[0], "m-49@example.com");
    assert.equal(result.truncated, true);
    assert.match(result.message, /scanCap/);
  });

  it("limits the candidate buffer to maxResults*4 and reports it", async () => {
    const h = makeHarness({ rows: rowsOf(100) });
    const result = await h.call("invoice", undefined, h.folder.URI, 2);
    assert.equal(result.candidates, 8);
    assert.equal(h.stats.mimeCalls, 8);
    assert.equal(result.truncated, true);
  });

  it("does not report a candidate limit when the buffer fills on the very last message", async () => {
    const h = makeHarness({ rows: rowsOf(8) });
    const result = await h.call("nomatch", undefined, h.folder.URI, 2);
    assert.equal(result.candidates, 8);
    assert.equal(result.matches.length, 0);
    assert.equal(result.truncated, false);
  });

  it("stops at the time budget during the scan and says so", async () => {
    const h = makeHarness({ rows: rowsOf(2000, { attach: false }), msPerYield: 6000 });
    const result = await h.call("x", undefined, h.folder.URI);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
    assert.ok(result.totalScanned < 2000);
  });

  it("drops results when access is revoked while the scan yields", async () => {
    const h = makeHarness({ rows: rowsOf(600) });
    h.setOnYield(count => { if (count === 1) h.revokeAccess(); });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, true);
  });
});

describe("searchAttachments bounded MIME pool", () => {
  it("never has more than MAX_MIME_CONCURRENCY parses in flight, and does use the pool", async () => {
    const h = makeHarness({ rows: rowsOf(60), parseDelayMs: 2 });
    const result = await h.call("invoice", undefined, h.folder.URI, 200);
    assert.equal(h.constants.MAX_MIME_CONCURRENCY, 8);
    assert.equal(result.matches.length, 60);
    assert.equal(h.stats.maxInFlight, 8);
  });

  it("uses the 3-argument MIME call so nothing is downloaded or decrypted", async () => {
    const h = makeHarness({ rows: rowsOf(3) });
    await h.call("invoice", undefined, h.folder.URI);
    assert.deepEqual(h.stats.mimeArgs, [0, 0, 0]);
  });

  it("creates one timer per parse and cancels every one on the success path", async () => {
    const h = makeHarness({ rows: rowsOf(12) });
    await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.timersCreated, 12);
    assert.equal(h.stats.timersCancelled, 12);
    assert.ok(h.timers.every(timer => timer.ms === h.constants.MIME_PARSE_TIMEOUT_MS));
  });

  it("frees the slot when a parse times out, reports notParsed, and ignores the late callback", async () => {
    const rows = [{ mime: "hang" }, ...rowsOf(3)];
    const h = makeHarness({ rows });
    const pending = h.call("invoice", undefined, h.folder.URI);
    // Let the pool start, then fire the hung parse's timer.
    await new Promise(resolve => setTimeout(resolve, 20));
    const hung = h.timers.find(timer => !timer.cancelled);
    assert.ok(hung, "the hung parse still holds a live timer");
    hung.callback.notify();
    const result = await pending;
    assert.equal(result.matches.length, 3);
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /could not be parsed/);
    // A callback arriving after the timeout must not add a match or reopen the slot.
    rows[0].release();
    assert.equal(h.timers.every(timer => timer.cancelled || timer === hung), true);
  });

  it("treats null MIME, throwing callbacks and synchronous MIME throws as unparsed without hanging", async () => {
    const h = makeHarness({ rows: [{ mime: "null" }, { mime: "cbthrow" }, { mime: "throw" }, {}] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.matches.length, 1);
    assert.equal(result.notParsed, 3);
    assert.equal(result.truncated, true);
    assert.equal(h.stats.timersCancelled, h.stats.timersCreated);
  });

  it("survives timer allocation failure without rejecting", async () => {
    const h = makeHarness({ rows: rowsOf(3), timerThrows: true });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.deepEqual(result.matches, []);
    assert.equal(result.notParsed, 3);
  });

  it("stops pulling candidates at the shared deadline and counts the rest as not parsed", async () => {
    const h = makeHarness({ rows: rowsOf(40), parseDelayMs: 0, msPerYield: 2500 });
    const result = await h.call("invoice", undefined, h.folder.URI, 200);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
    assert.ok(result.notParsed > 0);
    assert.equal(result.matches.length + result.notParsed, result.candidates);
  });
});

describe("searchAttachments encrypted messages", () => {
  const encryptedRows = () => [{ enigmail: DECRYPTION_OKAY }, {}];

  it("skips recorded-encrypted messages without parsing them", async () => {
    const h = makeHarness({ rows: encryptedRows() });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.mimeCalls, 1);
    assert.equal(result.matches.length, 1);
    assert.equal(result.encryptedWithheld, 1);
    assert.equal(result.truncated, false);
  });

  it("withholds messages whose parsed MIME tree is encrypted", async () => {
    const mimeMessage = {
      contentType: "multipart/encrypted; protocol=\"application/pgp-encrypted\"",
      isEncrypted: true,
      parts: [],
      allUserAttachments: [PDF],
    };
    const h = makeHarness({ rows: [{ mimeMessage }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.deepEqual(result.matches, []);
    assert.equal(result.encryptedWithheld, 1);
    assert.doesNotMatch(JSON.stringify(result), /Invoice/);
  });

  it("inspects encrypted messages only when the option allows it", async () => {
    const h = makeHarness({ rows: encryptedRows(), allowEncrypted: true });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.matches.length, 2);
    assert.equal("encryptedWithheld" in result, false);
  });
});
