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

const FLAGS = { Expunged: 0x8, Offline: 0x80, Attachment: 0x10000000 };
const DECRYPTION_OKAY = 0x00020000;
const PDF = { name: "Invoice.PDF", contentType: "application/pdf", size: 10 };
const PNG = { name: "photo.png", contentType: "image/png", size: 20 };
const PLAIN_RAW = "From: a@example.test\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b--\r\n";
const SMIME_RAW = "From: a@example.test\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nAAAA\r\n";

/**
 * rows: { attach?: bool, offline?: bool, atts?, enigmail?, raw?, mime?: "hang"|"null"|"throw"|"cbthrow", mimeMessage? }
 * Parsing is driven by the harness: each MsgHdrToMimeMessage call is recorded and
 * completed on a later macrotask, so the in-flight count is real. A "hang" row's
 * parse completes only when the test calls row.release(), like a stuck stream
 * whose callback arrives late. row.timer is the timer armed for that parse.
 * extraFolders: more Inbox row lists, one extra account each.
 */
function makeHarness({
  rows, extraFolders = [], allowEncrypted = false, parseDelayMs = 0, msPerYield = 0,
  timerThrows = false, serverType = "imap",
} = {}) {
  const stats = {
    yields: 0, mimeCalls: 0, inFlight: 0, maxInFlight: 0, timersCreated: 0, timersCancelled: 0,
    mimeArgs: [], mimeFolders: [],
  };
  let generation = 0;
  let now = 0;
  let accessible = true;
  let onYield = null;
  const timers = [];
  const folders = [];

  [rows, ...extraFolders].forEach((folderRows, folderIndex) => {
    const headers = new Map();
    const folder = {
      URI: `imap://account${folderIndex + 1}/INBOX`,
      prettyName: "INBOX",
      isServer: false,
      server: null,
      updateFolder() {},
      getMsgInputStream(msgHdr) {
        let offset = 0;
        const raw = msgHdr.row.raw || PLAIN_RAW;
        return {
          available() { return Math.min(raw.length - offset, 1000); },
          read(count) { const chunk = raw.slice(offset, offset + count); offset += chunk.length; return chunk; },
          close() {},
        };
      },
      get msgDatabase() {
        const openedGeneration = generation;
        const assertLive = () => assert.equal(openedGeneration, generation, "Database retained across a yield");
        return {
          listAllKeys() { assertLive(); return Array.from(headers.keys()); },
          enumerateMessages() { assert.fail("The attachment scan must not open a native message enumerator"); },
          containsKey(key) { assertLive(); return headers.has(key); },
          getMsgHdrForKey(key) { assertLive(); return headers.get(key); },
        };
      },
    };
    folderRows.forEach((row, index) => {
      const header = {
        messageKey: index + 1,
        messageId: folderIndex === 0 ? `m-${index}@example.com` : `f${folderIndex}-m-${index}@example.com`,
        threadId: 100 + index,
        date: (index + 1) * 1000000,
        subject: "Subject",
        author: "Alice",
        recipients: "Bob",
        mime2DecodedSubject: "Subject",
        mime2DecodedAuthor: "Alice",
        mime2DecodedRecipients: "Bob",
        ccList: "",
        flags: (row.attach === false ? 0 : FLAGS.Attachment) | (row.offline === false ? 0 : FLAGS.Offline),
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
    const account = { key: `account${folderIndex + 1}`, incomingServer: { type: serverType, rootFolder: null } };
    account.incomingServer.rootFolder = { getFolderWithFlags: flag => (flag === 0x1000 ? folder : null) };
    folder.server = account.incomingServer;
    folder.account = account;
    folders.push(folder);
  });

  class FakeDate extends Date {
    static now() { return now; }
  }

  function MsgHdrToMimeMessage(hdr, partsOfInterest, callback, ...rest) {
    stats.mimeCalls++;
    stats.mimeArgs.push(rest.length);
    stats.mimeFolders.push(hdr.folder.URI);
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const row = hdr.row;
    row.timer = timers[timers.length - 1];
    if (row.mime === "throw") { stats.inFlight--; throw new Error("sync failure"); }
    const finish = () => {
      stats.inFlight--;
      if (row.mime === "null") callback(hdr, null);
      else if (row.mime === "cbthrow") callback(hdr, { get allUserAttachments() { throw new Error("boom"); } });
      else callback(hdr, row.mimeMessage || { contentType: "multipart/mixed", parts: [], allUserAttachments: row.atts || [PDF] });
    };
    if (row.mime === "hang") {
      row.release = () => { finish(); };
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
    Ci: { nsMsgMessageFlags: FLAGS, nsMsgFolderFlags: { Inbox: 0x1000 }, nsITimer: { TYPE_ONE_SHOT: 0 } },
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
    NetUtil: { readInputStreamToString: (stream, count) => stream.read(count) },
    MailServices: {
      mimeConverter: { decodeMimeHeader: value => value },
      folderLookup: { getFolderForURL: uri => folders.find(candidate => candidate.URI === uri) || null },
      accounts: {
        accounts: folders.map(folder => folder.account),
        findAccountForServer: server => (accessible ? folders.find(folder => folder.server === server).account : null),
      },
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
    snippet("// BEGIN MESSAGE HEADER READ TOOLS", "// END MESSAGE HEADER READ TOOLS"),
    snippet("// BEGIN ATTACHMENT SEARCH TOOL", "// END ATTACHMENT SEARCH TOOL"),
    "this.run = searchAttachments; this.constants = { MAX_MIME_CONCURRENCY, MIME_PARSE_TIMEOUT_MS };",
  ].join("\n"), runtime);

  return {
    runtime, folder: folders[0], folders, stats, timers,
    get constants() { return runtime.constants; },
    revokeAccess() { accessible = false; },
    setOnYield(callback) { onYield = callback; },
    async call(...args) {
      return JSON.parse(JSON.stringify(await runtime.run(...args)));
    },
  };
}

const rowsOf = (count, extra = {}) => Array.from({ length: count }, () => ({ ...extra }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Newest messages are scanned and parsed first, so hung rows go LAST in the list.
const hungRows = count => Array.from({ length: count }, () => ({ mime: "hang" }));

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
    assert.match(tool.description, /heuristic/);
    assert.match(tool.description, /notOffline/);
    assert.match(tool.description, /takes precedence over scanCap/);
  });
});

describe("searchAttachments results", () => {
  it("returns the shared header shape plus folderPath and matchingAttachments", async () => {
    const h = makeHarness({ rows: [{ atts: [PDF, PNG] }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.truncated, false);
    assert.equal("message" in result, false);
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
    const h = makeHarness({ rows: [{}], extraFolders: [[{}]] });
    const result = await h.call("invoice");
    assert.equal(result.matches.length, 2);
  });

  it("combines every applicable reason in one message", async () => {
    const h = makeHarness({ rows: [{ offline: false }, ...rowsOf(6), { mime: "null" }] });
    const result = await h.call("invoice", undefined, h.folder.URI, 2);
    assert.equal(result.truncated, true);
    assert.match(result.message, /more messages matched than maxResults/);
    assert.match(result.message, /no offline copy/);
    assert.match(result.message, /could not be parsed/);
  });
});

describe("searchAttachments cooperative scan", () => {
  it("scans through the shared helper, yields, and never opens a native enumerator", async () => {
    const h = makeHarness({ rows: rowsOf(600, { attach: false }) });
    const result = await h.call("x", undefined, h.folder.URI);
    assert.equal(result.totalScanned, 600);
    assert.equal(result.truncated, false);
    assert.ok(h.stats.yields >= 2, "the scan must yield between batches");
    assert.equal(h.stats.mimeCalls, 0, "messages without the attachment flag are never parsed");
  });

  it("stops at scanCap, preferring the newest messages, and reports truncation", async () => {
    const h = makeHarness({ rows: rowsOf(50) });
    const result = await h.call("invoice", undefined, h.folder.URI, 200, 5);
    assert.equal(result.totalScanned, 5);
    assert.equal(result.candidates, 5);
    assert.equal(result.matches[0].id, "m-49@example.com");
    assert.equal(result.truncated, true);
    assert.match(result.message, /scanCap/);
  });

  it("limits the candidate buffer to maxResults*4 and reports it", async () => {
    const h = makeHarness({ rows: rowsOf(100) });
    const result = await h.call("invoice", undefined, h.folder.URI, 2);
    assert.equal(result.candidates, 8);
    assert.equal(h.stats.mimeCalls, 8);
    assert.equal(result.truncated, true);
    assert.match(result.message, /candidate limit/);
  });

  it("does not report a candidate limit when the buffer fills on the very last message", async () => {
    const h = makeHarness({ rows: rowsOf(8) });
    const result = await h.call("nomatch", undefined, h.folder.URI, 2);
    assert.equal(result.candidates, 8);
    assert.equal(result.matches.length, 0);
    assert.equal(result.truncated, false);
  });

  it("shares the candidate limit fairly so the first inbox cannot starve the others", async () => {
    const h = makeHarness({ rows: rowsOf(100), extraFolders: [rowsOf(100)] });
    const result = await h.call("invoice", undefined, undefined, 5);
    assert.equal(result.candidates, 20);
    const perFolder = uri => h.stats.mimeFolders.filter(folder => folder === uri).length;
    assert.equal(perFolder(h.folders[0].URI), 10);
    assert.equal(perFolder(h.folders[1].URI), 10);
    assert.equal(result.truncated, true);
  });

  it("lets a later folder reuse the share an earlier folder did not need", async () => {
    const h = makeHarness({ rows: rowsOf(3), extraFolders: [rowsOf(100)] });
    await h.call("invoice", undefined, undefined, 5);
    const second = h.stats.mimeFolders.filter(folder => folder === h.folders[1].URI).length;
    assert.equal(second, 17);
  });

  it("yields between folders", async () => {
    const h = makeHarness({ rows: rowsOf(1), extraFolders: [rowsOf(1), rowsOf(1)] });
    await h.call("invoice");
    assert.ok(h.stats.yields >= 2);
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
    assert.equal(result.matches.length, 0);
    assert.equal(result.truncated, true);
  });
});

describe("searchAttachments remote messages without an offline copy", () => {
  it("counts them separately, spends no timer and no parse, and explains why", async () => {
    const h = makeHarness({ rows: [{ offline: false }, { offline: false }, {}] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.notOffline, 2);
    assert.equal(result.candidates, 1);
    assert.equal(h.stats.mimeCalls, 1);
    assert.equal(h.stats.timersCreated, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /no offline copy/);
    assert.doesNotMatch(result.message, /retry/i);
    assert.equal("notParsed" in result, false);
  });

  it("does not apply the offline check to local folders", async () => {
    const h = makeHarness({ rows: [{ offline: false }], serverType: "none" });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.matches.length, 1);
    assert.equal("notOffline" in result, false);
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

  it("reports a timed-out parse as not parsed and ignores its late callback", async () => {
    const rows = [...rowsOf(3), ...hungRows(1)];
    const h = makeHarness({ rows });
    const pending = h.call("invoice", undefined, h.folder.URI);
    await sleep(20);
    rows[3].timer.callback.notify();
    const result = await pending;
    assert.equal(result.matches.length, 3);
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /not parsed because MIME parses stalled/);
    rows[3].release();
    assert.equal(h.stats.inFlight, 0);
    assert.ok(h.timers.every(timer => timer.cancelled));
  });

  it("keeps a timed-out parse counted as in flight until its callback arrives", async () => {
    const rows = [...rowsOf(40), ...hungRows(4)];
    const h = makeHarness({ rows, parseDelayMs: 3 });
    const pending = h.call("invoice", undefined, h.folder.URI, 50);
    await sleep(15);
    for (const row of rows.slice(40)) row.timer.callback.notify();
    const result = await pending;
    // 4 stalled parses plus at most 4 live ones: never more than 8 in flight.
    assert.equal(h.stats.maxInFlight, 8);
    assert.equal(result.matches.length, 40);
    assert.equal(result.notParsed, 4);
    for (const row of rows.slice(40)) row.release();
    assert.equal(h.stats.inFlight, 0);
  });

  it("stops launching once every slot is held by a stalled parse and says so", async () => {
    const rows = [...rowsOf(20), ...hungRows(8)];
    const h = makeHarness({ rows, parseDelayMs: 1 });
    const pending = h.call("invoice", undefined, h.folder.URI, 50);
    await sleep(15);
    for (const row of rows.slice(20)) row.timer.callback.notify();
    const result = await pending;
    assert.equal(h.stats.maxInFlight, 8);
    assert.equal(h.stats.mimeCalls, 8 + result.matches.length);
    assert.equal(result.matches.length + result.notParsed, 28);
    assert.match(result.message, /stalled/);
    for (const row of rows.slice(20)) row.release();
    assert.equal(h.stats.inFlight, 0);
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
    assert.equal(result.matches.length, 0);
    assert.equal(result.notParsed, 3);
  });

  it("clamps each parse timeout to what is left of the shared budget", async () => {
    // Three flagged messages sit in the newest chunk; four more yields of 4500 ms
    // remain in the scan, so 20000 - 13500 = 6500 ms is left when parsing starts.
    const rows = [...rowsOf(997, { attach: false }), ...rowsOf(3)];
    const h = makeHarness({ rows, msPerYield: 4500 });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.timersCreated, 3);
    assert.ok(h.timers.every(timer => timer.ms === 6500), `timer ms: ${h.timers.map(t => t.ms)}`);
    assert.equal(result.matches.length, 3);
  });

  it("does not start parsing once the budget is spent and counts the candidates as not parsed", async () => {
    const rows = [...rowsOf(997, { attach: false }), ...rowsOf(3)];
    const h = makeHarness({ rows, msPerYield: 7000 });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.timersCreated, 0);
    assert.equal(h.stats.mimeCalls, 0);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
    assert.equal(result.notParsed, result.candidates);
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
    assert.equal(result.protectedWithheld, 1);
    assert.equal(result.truncated, false);
  });

  it("skips S/MIME and multipart/encrypted outer structures before any parse", async () => {
    const encrypted = 'From: a@example.test\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"\r\n\r\n--b--\r\n';
    const h = makeHarness({ rows: [{ raw: SMIME_RAW }, { raw: encrypted }, {}] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.mimeCalls, 1);
    assert.equal(h.stats.timersCreated, 1);
    assert.equal(result.protectedWithheld, 2);
    assert.equal(result.matches.length, 1);
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
    assert.equal(result.matches.length, 0);
    assert.equal(result.protectedWithheld, 1);
    assert.doesNotMatch(JSON.stringify(result), /Invoice/);
  });

  it("inspects encrypted messages only when the option allows it", async () => {
    const h = makeHarness({ rows: [{ enigmail: DECRYPTION_OKAY }, { raw: SMIME_RAW }, {}], allowEncrypted: true });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.matches.length, 3);
    assert.equal("protectedWithheld" in result, false);
    assert.deepEqual(h.stats.mimeArgs, [0, 0, 0]);
  });
});
