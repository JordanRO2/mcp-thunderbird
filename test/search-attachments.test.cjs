"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadToolSchema } = require("./helpers/tool-schema.cjs");

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
  return loadToolSchema().buildTools().find(tool => tool.name === "searchAttachments");
}

const FLAGS = { Expunged: 0x8, Offline: 0x80, Partial: 0x400, Attachment: 0x10000000 };
const DECRYPTION_OKAY = 0x00020000;
const PDF = { name: "Invoice.PDF", contentType: "application/pdf", size: 10 };
const PNG = { name: "photo.png", contentType: "image/png", size: 20 };
// Searched the raw-MIME and message-read fixtures: their builders are local.
// Keep valid MIME here, including the attachment represented by each mock tree.
function attachmentRaw(attachments = [PDF]) {
  return [
    'From: a@example.test', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/plain; charset=utf-8', '', 'A clear message.',
    ...attachments.flatMap(att => [
      '--b', `Content-Type: ${att.contentType}`, `Content-Disposition: attachment; filename="${att.name}"`,
      'Content-Transfer-Encoding: base64', '', Buffer.alloc(att.size ?? 3, 65).toString('base64'),
    ]),
    '--b--', '',
  ].join('\r\n');
}
const PLAIN_RAW = attachmentRaw();
const SIGNED_RAW = [
  'From: a@example.test', 'MIME-Version: 1.0',
  'Content-Type: multipart/signed; boundary="signed"; protocol="application/pgp-signature"', '',
  '--signed', PLAIN_RAW, '--signed', 'Content-Type: application/pgp-signature', '',
  'detached signature', '--signed--', '',
].join('\r\n');
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
    mimeArgs: [], mimeFolders: [], rawOpens: 0, rawCloses: 0, serverFetches: 0,
  };
  let generation = 0;
  let now = 0;
  let accessible = true;
  let toolEnabled = true;
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
      headers,
      getUriForMsg(header) { return `${this.URI}#${header.messageKey}`; },
      getMsgInputStream(msgHdr) {
        stats.rawOpens++;
        const row = msgHdr.row;
        row.onRawOpen?.();
        if (row.rawThrows) throw new Error("local store unavailable");
        let offset = 0;
        const raw = row.raw ?? attachmentRaw(row.atts || [PDF]);
        return {
          available() { return Math.min(raw.length - offset, 1000); },
          read(count) {
            const chunk = raw.slice(offset, offset + count);
            offset += chunk.length;
            row.onRawRead?.();
            return chunk;
          },
          close() { stats.rawCloses++; },
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
        date: row.date !== undefined ? row.date : (index + 1) * 1000000,
        subject: "Subject",
        author: "Alice",
        recipients: "Bob",
        mime2DecodedSubject: "Subject",
        mime2DecodedAuthor: "Alice",
        mime2DecodedRecipients: "Bob",
        ccList: "",
        flags: (row.attach === false ? 0 : FLAGS.Attachment) | (row.offline === false ? 0 : FLAGS.Offline) | (row.partial ? FLAGS.Partial : 0),
        isRead: false,
        isFlagged: true,
        messageSize: row.messageSize ?? (row.raw ?? attachmentRaw(row.atts || [PDF])).length,
        folder,
        getStringProperty: () => "",
        getUint32Property: name => (name === "enigmail" ? (row.enigmail || 0) : 0),
        row,
      };
      row.header = header;
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
    stats.mimeArgs.push(JSON.parse(JSON.stringify(rest)));
    stats.mimeFolders.push(hdr.folder.URI);
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const row = hdr.row;
    row.timer = timers[timers.length - 1];
    if (row.mime === "throw") { stats.inFlight--; throw new Error("sync failure"); }
    let ended = false;
    const finish = () => {
      if (!ended) { stats.inFlight--; ended = true; }
      row.beforeMimeCallback?.();
      if (row.mime === "null") callback(hdr, null);
      else if (row.mime === "cbthrow") callback(hdr, { get allUserAttachments() { throw new Error("boom"); } });
      else callback(hdr, row.mimeMessage || {
        contentType: "multipart/mixed",
        parts: [{ contentType: "text/plain", body: "A clear message." },
          ...(row.atts || [PDF]).map(att => ({ contentType: att.contentType }))],
        allUserAttachments: row.atts || [PDF],
      });
      row.afterMimeCallback?.();
    };
    row.onMimeStart?.();
    if (row.mime === "hang") {
      row.release = () => { finish(); };
      return;
    }
    setTimeout(finish, parseDelayMs);
  }

  const runtime = vm.createContext({
    Date: FakeDate,
    TextDecoder, Uint8Array, atob, btoa,
    setTimeout,
    Cr: { NS_BASE_STREAM_CLOSED: 1, NS_BINDING_ABORTED: 2 },
    Components: { isSuccessCode: status => status === 0 },
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
      messageServiceFromURI() {
        stats.serverFetches++;
        throw new Error("Attachment searches must never request a server stream");
      },
      mimeConverter: { decodeMimeHeader: value => value },
      folderLookup: { getFolderForURL: uri => folders.find(candidate => candidate.URI === uri) || null },
      accounts: {
        accounts: folders.map(folder => folder.account),
        findAccountForServer: server => (accessible ? folders.find(folder => folder.server === server).account : null),
      },
    },
    isToolEnabled: () => toolEnabled,
    isAccountAllowed: () => true,
    getAllowedAccountIds: () => [],
    console,
  });
  const keywordStart = source.indexOf("const INTERNAL_KEYWORDS = new Set([");
  const keywordEnd = source.indexOf("]);", keywordStart);
  vm.runInContext([
    ...["SEARCH_YIELD_EVERY", "SEARCH_TIME_BUDGET_MS", "PREF_ALLOW_ENCRYPTED_MESSAGES", "DEFAULT_MAX_RESULTS", "MAX_SEARCH_RESULTS_CAP"].map(constant),
    snippet("// BEGIN ATTACHMENT SEARCH LIMITS", "// END ATTACHMENT SEARCH LIMITS"),
    snippet("// BEGIN PRIVACY PREFERENCE HELPERS", "// END PRIVACY PREFERENCE HELPERS"),
    snippet("// BEGIN INLINE ATTACHMENT BASE64 HELPERS", "// END INLINE ATTACHMENT BASE64 HELPERS"),
    snippet("// BEGIN MCP TEXT SANITIZATION", "// END MCP TEXT SANITIZATION"),
    snippet("// BEGIN MESSAGE TEXT CONVERSION", "// END MESSAGE TEXT CONVERSION"),
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
    "this.run = searchAttachments; this.constants = { MAX_MIME_CONCURRENCY, MIME_PARSE_TIMEOUT_MS }; this.pool = attachmentParsePool;",
  ].join("\n"), runtime);

  return {
    runtime, folder: folders[0], folders, stats, timers,
    get constants() { return runtime.constants; },
    advance(ms) { now += ms; },
    revokeAccess() { accessible = false; },
    disableTool() { toolEnabled = false; },
    setEncrypted(value) { allowEncrypted = value; },
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
  });
});

describe("searchAttachments results", () => {
  it("returns the shared header shape plus folderPath and matchingAttachments", async () => {
    const h = makeHarness({ rows: [{ atts: [PDF, PNG] }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.truncated, false);
    assert.equal("message" in result, false);
    assert.equal(result.messages.length, 1);
    const match = result.messages[0];
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
    assert.equal((await h.call("INVOICE")).messages.length, 1);
    assert.equal((await h.call(undefined, "IMAGE/")).messages.length, 1);
    assert.equal((await h.call("invoice", "image/")).messages.length, 0);
    assert.equal((await h.call("photo", "image/png")).messages.length, 1);
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
    assert.deepEqual(result.messages.map(m => m.id), ["m-9@example.com", "m-8@example.com", "m-7@example.com"]);
    assert.equal(result.overflow, 7);
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
    assert.equal(result.messages.length, 2);
  });

  it("combines every applicable reason in one message", async () => {
    const h = makeHarness({ rows: [{ offline: false }, ...rowsOf(6), { mime: "null" }] });
    const result = await h.call("invoice", undefined, h.folder.URI, 2);
    assert.equal(result.truncated, true);
    assert.match(result.message, /more messages matched than maxResults/);
    assert.match(result.message, /no complete local copy/);
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
    assert.equal(result.scanCapHit, true);
    assert.equal(result.candidates, 5);
    assert.equal(result.messages[0].id, "m-49@example.com");
    assert.equal(result.truncated, true);
    assert.match(result.message, /scanCap/);
  });

  it("limits the candidate buffer to maxResults*4 and reports it", async () => {
    const h = makeHarness({ rows: rowsOf(100) });
    const result = await h.call("invoice", undefined, h.folder.URI, 2);
    assert.equal(result.candidates, 8);
    assert.equal(result.candidateLimitHit, true);
    assert.equal(h.stats.mimeCalls, 8);
    assert.equal(result.truncated, true);
    assert.match(result.message, /candidate limit/);
  });

  it("does not report a candidate limit when the buffer fills on the very last message", async () => {
    const h = makeHarness({ rows: rowsOf(8) });
    const result = await h.call("nomatch", undefined, h.folder.URI, 2);
    assert.equal(result.candidates, 8);
    assert.equal(result.messages.length, 0);
    assert.equal(result.truncated, false);
  });

  it("examines the full candidate limit when one inbox is busy and the others are empty", async () => {
    const h = makeHarness({ rows: rowsOf(300), extraFolders: [[], []] });
    const result = await h.call("invoice", undefined, undefined, 50);
    assert.equal(result.candidates, 200);
    assert.equal(h.stats.mimeCalls, 200);
    assert.equal(result.truncated, true);
  });

  it("keeps the newest candidates across folders, not the first folder's", async () => {
    const older = Array.from({ length: 100 }, (_, i) => ({ date: 1000 + i }));
    const newer = Array.from({ length: 100 }, (_, i) => ({ date: 5000 + i }));
    const h = makeHarness({ rows: older, extraFolders: [newer] });
    const result = await h.call("invoice", undefined, undefined, 5);
    assert.equal(result.candidates, 20);
    assert.ok(h.stats.mimeFolders.every(uri => uri === h.folders[1].URI));
    assert.ok(result.messages.every(match => match.folderPath === h.folders[1].URI));
    assert.equal(result.truncated, true);
  });

  it("interleaves folders by date when both hold recent mail", async () => {
    const a = Array.from({ length: 10 }, (_, i) => ({ date: 2 * i + 1 }));
    const b = Array.from({ length: 10 }, (_, i) => ({ date: 2 * i + 2 }));
    const h = makeHarness({ rows: a, extraFolders: [b] });
    const result = await h.call("invoice", undefined, undefined, 3);
    assert.equal(result.candidates, 12);
    assert.deepEqual(result.messages.map(m => m.id), ["f1-m-9@example.com", "m-9@example.com", "f1-m-8@example.com"]);
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

  it("reports a scan failure separately from candidate parse outcomes", async () => {
    const h = makeHarness({ rows: [{}] });
    const original = Object.getOwnPropertyDescriptor(h.folder, "msgDatabase").get;
    Object.defineProperty(h.folder, "msgDatabase", { get() {
      const database = original.call(h.folder);
      const list = database.listAllKeys;
      database.listAllKeys = () => [...list(), 9999];
      return database;
    } });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.scanFailures, 1);
    assert.equal(result.messages.length, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /scan|unavailable/i);
    assert.equal(result.notParsed, undefined);
  });

  it("drops results when access is revoked while the scan yields", async () => {
    const h = makeHarness({ rows: rowsOf(600) });
    h.setOnYield(count => { if (count === 1) h.revokeAccess(); });
    const result = await h.call("invoice", undefined, h.folder.URI, 200);
    assert.equal(result.messages.length, 0);
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
    assert.match(result.message, /no complete local copy/);
    assert.match(result.message, /enable offline use and sync/);
    assert.match(result.message, /getMessage can separately fetch an individual message/);
    assert.equal("notParsed" in result, false);
  });

  it("treats every non-local server type as remote, including native Exchange", async () => {
    for (const serverType of ["ews", "graph", "nntp", "someaddon"]) {
      const h = makeHarness({ rows: [{ offline: false }], serverType });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(result.notOffline, 1, serverType);
      assert.equal(h.stats.mimeCalls, 0, serverType);
    }
  });

  it("does not apply the offline check to local folders", async () => {
    for (const serverType of ["none", "pop3", "movemail", "rss"]) {
      const h = makeHarness({ rows: [{ offline: false }], serverType });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(result.messages.length, 1, serverType);
    }
  });
});

describe("searchAttachments bounded MIME pool", () => {
  it("never has more than MAX_MIME_CONCURRENCY parses in flight, and does use the pool", async () => {
    const h = makeHarness({ rows: rowsOf(60), parseDelayMs: 2 });
    const result = await h.call("invoice", undefined, h.folder.URI, 200);
    assert.equal(h.constants.MAX_MIME_CONCURRENCY, 8);
    assert.equal(result.messages.length, 60);
    assert.equal(h.stats.maxInFlight, 8);
  });

  it("disables download and encrypted-part examination after the raw gate", async () => {
    const h = makeHarness({ rows: rowsOf(3) });
    await h.call("invoice", undefined, h.folder.URI);
    assert.deepEqual(h.stats.mimeArgs, Array.from({ length: 3 }, () => [false, { examineEncryptedParts: false }]));
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
    assert.equal(result.messages.length, 3);
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
    assert.equal(result.messages.length, 40);
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
    assert.equal(h.stats.mimeCalls, 8 + result.messages.length);
    assert.equal(result.messages.length + result.notParsed, 28);
    assert.match(result.message, /stalled/);
    for (const row of rows.slice(20)) row.release();
    assert.equal(h.stats.inFlight, 0);
  });

  it("treats null MIME, throwing callbacks and synchronous MIME throws as unparsed without hanging", async () => {
    const h = makeHarness({ rows: [{ mime: "null" }, { mime: "cbthrow" }, { mime: "throw" }, {}] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 1);
    assert.equal(result.notParsed, 3);
    assert.equal(result.truncated, true);
    assert.equal(h.stats.timersCancelled, h.stats.timersCreated);
  });

  it("survives timer allocation failure without rejecting", async () => {
    const h = makeHarness({ rows: rowsOf(3), timerThrows: true });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.notParsed, 3);
  });

  it("clamps each parse timeout to what is left of the shared budget", async () => {
    const row = {};
    const h = makeHarness({ rows: [row] });
    row.onRawRead = () => h.advance(13500);
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.timersCreated, 1);
    assert.equal(h.timers[0].ms, 6500);
    assert.equal(result.messages.length, 1);
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
    assert.equal(result.messages.length + result.notParsed, result.candidates);
  });
});

describe("searchAttachments complete raw privacy gate", () => {
  const protectedRaw = [
    ["S/MIME", SMIME_RAW],
    ["PGP/MIME", [
      'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="e"', '',
      '--e', 'Content-Type: application/pgp-encrypted', '', 'Version: 1',
      '--e', 'Content-Type: application/octet-stream', '', 'opaque', '--e--', '',
    ].join('\r\n')],
    ["nested S/MIME", PLAIN_RAW.replace('Content-Type: application/pdf', 'Content-Type: application/pkcs7-mime')],
    ["name-typed PGP attachment", attachmentRaw([{ name: "archive.pgp", contentType: "application/octet-stream", size: 3 }])],
    ["name-typed S/MIME attachment", attachmentRaw([{ name: "secret.p7m", contentType: "application/octet-stream", size: 3 }])],
    ["nested inline PGP", PLAIN_RAW.replace('A clear message.', '-----BEGIN PGP MESSAGE-----\r\nopaque')],
    ["embedded S/MIME", PLAIN_RAW.replace(
      'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="Invoice.PDF"\r\nContent-Transfer-Encoding: base64\r\n\r\nQUFBQUFBQUFBQQ==',
      `Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forward.eml"\r\n\r\n${SMIME_RAW}`,
    )],
    ["untyped encoded protected name", 'From: a@example.test\r\n\r\nbegin 644 archive.pgp\r\nopaque\r\nend\r\n'],
    ["malformed duplicate type", PLAIN_RAW.replace('MIME-Version: 1.0', 'Content-Type: text/plain')],
    ["missing closing boundary", PLAIN_RAW.replace('--b--', '')],
    ["ambiguous boundary", PLAIN_RAW.replace('boundary="b"', 'boundary="odd:(boundary)"').replaceAll('--b', '--odd:(boundary)')],
    ["invalid transfer encoding", PLAIN_RAW.replace('base64', 'x-opaque')],
  ];

  for (const allowEncrypted of [false, true]) {
    for (const [name, raw] of protectedRaw) {
      it(`withholds ${name} before Gloda with opt-in ${allowEncrypted}`, async () => {
        const h = makeHarness({ rows: [{ raw }], allowEncrypted });
        assert.notEqual(h.runtime.classifyRawMessageEncryption(raw, 0, { signedRaw: true }), "clear");
        const result = await h.call("invoice", undefined, h.folder.URI);
        assert.equal(h.stats.mimeCalls, 0, "the raw gate must run before Gloda can decrypt");
        assert.equal(h.stats.rawOpens, 1, "use one complete local snapshot");
        assert.equal(h.stats.rawCloses, 1);
        assert.equal(h.stats.serverFetches, 0);
        assert.equal(result.messages.length, 0);
        assert.equal(result.protectedWithheld, 1);
        assert.equal(result.truncated, true);
        assert.match(result.message, /protected|unverifiable|withheld/i);
        assert.doesNotMatch(JSON.stringify(result), /Invoice|archive\.pgp|secret\.p7m/);
      });
    }

    it(`withholds recorded-encrypted messages without parsing with opt-in ${allowEncrypted}`, async () => {
      const h = makeHarness({ rows: [{ enigmail: DECRYPTION_OKAY }], allowEncrypted });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(h.stats.mimeCalls, 0);
      assert.equal(result.messages.length, 0);
      assert.equal(result.protectedWithheld, 1);
      assert.equal(result.truncated, true);
    });

    it(`withholds an encrypted returned tree with opt-in ${allowEncrypted}`, async () => {
      const mimeMessage = {
        contentType: 'multipart/encrypted; protocol="application/pgp-encrypted"',
        isEncrypted: true, parts: [],
        get allUserAttachments() { return assert.fail("Do not inspect protected attachment metadata"); },
      };
      const h = makeHarness({ rows: [{ mimeMessage }], allowEncrypted });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(h.stats.mimeCalls, 1, "the contradictory mocked tree is rejected after the clear raw gate");
      assert.equal(result.messages.length, 0);
      assert.equal(result.protectedWithheld, 1);
      assert.equal(result.truncated, true);
    });
  }

  it("rejects search input that only the permissive getMessage tier accepts", async () => {
    const raw = protectedRaw.find(([name]) => name === "ambiguous boundary")[1];
    const h = makeHarness({ rows: [{ raw }], allowEncrypted: true });
    assert.equal(h.runtime.classifyRawMessageReadSafety(raw), "clear");
    assert.equal(h.runtime.classifyRawMessageEncryption(raw, 0, { signedRaw: true }), "unknown");
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.protectedWithheld, 1);
    assert.equal(h.stats.mimeCalls, 0);
  });

  it("keeps the real classifier's benign PDF control searchable and reads it once", async () => {
    const h = makeHarness({ rows: rowsOf(5) });
    assert.equal(h.runtime.classifyRawMessageEncryption(PLAIN_RAW, 0, { signedRaw: true }), "clear");
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 5);
    assert.equal(result.truncated, false);
    assert.equal(h.stats.rawOpens, 5);
    assert.equal(h.stats.rawCloses, 5);
    assert.equal(h.stats.serverFetches, 0);
  });

  it("accepts complete ordinary messages whose outer headers exceed the old header-only limit", async () => {
    const raw = `X-Pad: ${"x".repeat(20000)}\r\n${PLAIN_RAW}`;
    const h = makeHarness({ rows: [{ raw }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 1);
    assert.equal(h.stats.rawOpens, 1);
    assert.equal(result.truncated, false);
  });

  it("counts incomplete local copies without a server fallback", async () => {
    const h = makeHarness({ rows: [{ partial: true }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.mimeCalls, 0);
    assert.equal(h.stats.serverFetches, 0);
    assert.equal(result.messages.length, 0);
    assert.equal((result.notParsed || 0) + (result.protectedWithheld || 0), 1);
    assert.equal(result.truncated, true);
  });

  it("does not fetch when an Offline flag points at a missing local store", async () => {
    const h = makeHarness({ rows: [{ rawThrows: true }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.mimeCalls, 0);
    assert.equal(h.stats.rawOpens, 1);
    assert.equal(h.stats.serverFetches, 0);
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
  });
});

describe("searchAttachments incomplete MIME accounting", () => {
  for (const [name, makeTree] of [
    ["empty multipart", () => ({ contentType: "multipart/mixed", parts: [], allUserAttachments: [] })],
    ["missing attachment list", () => ({ contentType: "text/plain", body: "A clear message." })],
    ["truncated nested part", () => ({ contentType: "multipart/mixed", parts: [
      { contentType: "text/plain", body: "A clear message.", isTruncated: true },
    ], allUserAttachments: [PDF] })],
    ["cyclic part tree", () => {
      const mime = { contentType: "multipart/mixed", parts: [], allUserAttachments: [] };
      mime.parts.push(mime);
      return mime;
    }],
  ]) {
    it(`counts a ${name} result as an omission, never no match`, async () => {
      const h = makeHarness({ rows: [{ mimeMessage: makeTree() }] });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(h.stats.mimeCalls, 1);
      assert.equal(result.messages.length, 0);
      assert.equal(result.notParsed, 1);
      assert.equal(result.truncated, true);
      assert.equal(h.runtime.pool.live, 0);
    });
  }
});

describe("searchAttachments synchronous raw-size budget", () => {
  it("counts an oversized local snapshot without parsing or downloading it", async () => {
    const prefix = 'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="Invoice.PDF"\r\n\r\n';
    const h = makeHarness({ rows: [{ raw: prefix + "a".repeat(2 * 1024 * 1024), messageSize: 1 }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.tooLarge, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /2 MiB|2097152|size/i);
    assert.equal(h.stats.mimeCalls, 0);
    assert.equal(h.stats.serverFetches, 0);
    assert.equal(h.stats.rawCloses, 1);
  });

  it("accepts a complete strictly clear snapshot exactly at the search cap", async () => {
    const prefix = 'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="Invoice.PDF"\r\n\r\n';
    const h = makeHarness({ rows: [{ raw: prefix + "a".repeat(2 * 1024 * 1024 - prefix.length) }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 1);
    assert.equal(result.truncated, false);
    assert.equal(h.stats.mimeCalls, 1);
    assert.equal(h.stats.rawOpens, 1);
  });
});

describe("searchAttachments signed messages", () => {
  const populated = () => ({
    contentType: 'multipart/signed; protocol="application/pgp-signature"',
    parts: [{ contentType: "multipart/mixed", parts: [
      { contentType: "text/plain", body: "A clear message." },
      { contentType: "application/pdf" },
    ] }, { contentType: "application/pgp-signature" }],
    allUserAttachments: [PDF],
  });
  const stripped = () => ({
    contentType: 'multipart/signed; protocol="application/pgp-signature"',
    isEncrypted: true, parts: [], allUserAttachments: [],
  });

  for (const [shape, tree] of [["populated", populated], ["stripped", stripped]]) {
    for (const allowEncrypted of [false, true]) {
      it(`accounts for ${shape} signed mail with opt-in ${allowEncrypted}`, async () => {
        const h = makeHarness({ rows: [{ raw: SIGNED_RAW, mimeMessage: tree() }], allowEncrypted });
        assert.equal(h.runtime.classifyRawMessageEncryption(SIGNED_RAW, 0, { signedRaw: true }), "clear");
        const result = await h.call("invoice", undefined, h.folder.URI);
        const searchable = allowEncrypted && shape === "populated";
        assert.equal(h.stats.mimeCalls, allowEncrypted ? 1 : 0);
        assert.equal(result.messages.length, searchable ? 1 : 0);
        assert.equal(result.protectedWithheld || 0, searchable ? 0 : 1);
        assert.equal(result.truncated, !searchable);
        assert.equal(h.stats.rawOpens, 1);
      });
    }
  }

  it("withholds a flagged signed tree with children, even with opt-in", async () => {
    const h = makeHarness({ rows: [{ raw: SIGNED_RAW, mimeMessage: { ...populated(), isEncrypted: true } }], allowEncrypted: true });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.protectedWithheld, 1);
    assert.equal(result.truncated, true);
  });

  for (const allowEncrypted of [false, true]) {
    it(`rejects name-typed protection inside signed mail before Gloda with opt-in ${allowEncrypted}`, async () => {
      const raw = SIGNED_RAW.replace('Content-Type: application/pdf', 'Content-Type: application/octet-stream')
        .replace('filename="Invoice.PDF"', 'filename="archive.pgp"');
      const h = makeHarness({ rows: [{ raw, mimeMessage: populated() }], allowEncrypted });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(h.stats.mimeCalls, 0);
      assert.equal(result.protectedWithheld, 1);
      assert.equal(result.truncated, true);
    });
  }
});

describe("searchAttachments access, identity and deadlines across awaits", () => {
  it("rechecks local availability after collecting the primitive locator", async () => {
    const row = {};
    const h = makeHarness({ rows: [row] });
    const original = h.runtime.acquireParseSlot;
    h.runtime.acquireParseSlot = async (...args) => {
      const acquired = await original(...args);
      row.header.flags &= ~FLAGS.Offline;
      return acquired;
    };
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.notOffline, 1);
    assert.equal(h.stats.mimeCalls, 0);
    assert.equal(h.stats.serverFetches, 0);
  });

  for (const reason of ["access", "tool", "key reuse"]) {
    it(`rejects ${reason} changing while raw acquisition resolves`, async () => {
      const row = {};
      const h = makeHarness({ rows: [row] });
      row.onRawRead = () => {
        if (reason === "access") h.revokeAccess();
        if (reason === "tool") h.disableTool();
        if (reason === "key reuse") row.header.messageId = "replacement@example.test";
      };
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(h.stats.mimeCalls, 0);
      if (reason === "tool") {
        assert.match(result.error, /disabled/);
        assert.equal(result.messages, undefined);
      } else {
        assert.equal(result.messages.length, 0);
        assert.equal(result.notParsed, 1);
        assert.equal(result.truncated, true);
      }
    });
  }

  it("rechecks signed-mail policy after raw acquisition before starting Gloda", async () => {
    const row = { raw: SIGNED_RAW };
    const h = makeHarness({ rows: [row], allowEncrypted: true });
    row.onRawRead = () => h.setEncrypted(false);
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.mimeCalls, 0);
    assert.equal(result.messages.length, 0);
    assert.equal(result.protectedWithheld, 1);
    assert.equal(result.truncated, true);
  });

  for (const reason of ["access", "tool", "key reuse", "recorded encryption", "signed opt-out"]) {
    it(`rechecks ${reason} before publishing a parsed result`, async () => {
      const row = reason === "signed opt-out" ? {
        raw: SIGNED_RAW,
        mimeMessage: { contentType: 'multipart/signed; protocol="application/pgp-signature"', parts: [{ contentType: "application/pdf" }], allUserAttachments: [PDF] },
      } : {};
      const h = makeHarness({ rows: [row], allowEncrypted: true });
      row.afterMimeCallback = () => {
        if (reason === "access") h.revokeAccess();
        if (reason === "tool") h.disableTool();
        if (reason === "key reuse") row.header.messageId = "replacement@example.test";
        if (reason === "recorded encryption") row.enigmail = DECRYPTION_OKAY;
        if (reason === "signed opt-out") h.setEncrypted(false);
      };
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(h.stats.mimeCalls, 1);
      if (reason === "tool") {
        assert.match(result.error, /disabled/);
        assert.equal(result.messages, undefined);
      } else {
        assert.equal(result.messages.length, 0);
        assert.equal(result.truncated, true);
        if (reason === "recorded encryption" || reason === "signed opt-out") assert.equal(result.protectedWithheld, 1);
        else assert.equal(result.notParsed, 1);
      }
    });
  }

  for (const reason of ["signed opt-out", "key reuse"]) {
    it(`rechecks ${reason} for a parsed nonmatching candidate before reporting completeness`, async () => {
      const row = reason === "signed opt-out" ? {
        raw: SIGNED_RAW,
        mimeMessage: { contentType: 'multipart/signed; protocol="application/pgp-signature"', parts: [{ contentType: "application/pdf" }], allUserAttachments: [PDF] },
      } : {};
      const h = makeHarness({ rows: [row], allowEncrypted: true });
      row.afterMimeCallback = () => {
        if (reason === "signed opt-out") h.setEncrypted(false);
        else row.header.messageId = "replacement@example.test";
      };
      const result = await h.call("does-not-match", undefined, h.folder.URI);
      assert.equal(h.stats.mimeCalls, 1);
      assert.equal(result.messages.length, 0);
      assert.equal(result.truncated, true);
      if (reason === "signed opt-out") assert.equal(result.protectedWithheld, 1);
      else assert.equal(result.notParsed, 1);
    });
  }

  it("checks the deadline immediately after raw classification", async () => {
    const h = makeHarness({ rows: [{}] });
    const classify = h.runtime.classifyRawMessageEncryption;
    h.runtime.classifyRawMessageEncryption = (...args) => {
      const state = classify(...args);
      h.advance(20000);
      return state;
    };
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.mimeCalls, 0);
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
  });

  it("rejects a callback after the deadline even when its timer has not fired", async () => {
    const row = {};
    const h = makeHarness({ rows: [row] });
    row.beforeMimeCallback = () => h.advance(20000);
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.mimeCalls, 1);
    assert.equal(result.messages.length, 0);
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
    assert.equal(h.runtime.pool.live, 0);
  });

  it("rejects a callback past its own 8-second limit when its timer is delayed", async () => {
    const row = {};
    const h = makeHarness({ rows: [row] });
    row.beforeMimeCallback = () => h.advance(8001);
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
    assert.equal(h.runtime.pool.live, 0);
    assert.ok(h.timers.every(timer => timer.cancelled));
  });

  it("gives each initial candidate a separate turn for raw classification", async () => {
    const rows = rowsOf(8);
    const h = makeHarness({ rows });
    const turns = [];
    for (const row of rows) row.onRawOpen = () => turns.push(h.stats.yields);
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 8);
    assert.equal(new Set(turns).size, 8);
  });

  it("counts a newly recorded encryption status during raw acquisition as protected", async () => {
    const row = {};
    const h = makeHarness({ rows: [row], allowEncrypted: true });
    row.onRawRead = () => { row.enigmail = DECRYPTION_OKAY; };
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.protectedWithheld, 1);
    assert.equal(result.truncated, true);
    assert.equal(h.stats.mimeCalls, 0);
  });

  it("checks the deadline again before building the response", async () => {
    const row = {};
    const h = makeHarness({ rows: [row] });
    row.afterMimeCallback = () => h.advance(20000);
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
  });
});

describe("searchAttachments in-flight limit across calls", () => {
  it("counts streams left by a timed-out parse of an earlier call against later calls", async () => {
    const hung = hungRows(3);
    const rows = [...rowsOf(40), ...hung];
    const h = makeHarness({ rows, parseDelayMs: 2 });
    const first = h.call("invoice", undefined, h.folder.URI, 50);
    await sleep(15);
    for (const row of hung) row.timer.callback.notify();
    await first;
    for (const row of hung) row.mime = undefined; // later calls parse them normally
    assert.equal(h.stats.inFlight, 3, "three streams are still running");
    h.stats.maxInFlight = 0;
    const second = await h.call("invoice", undefined, h.folder.URI, 50);
    assert.equal(second.messages.length, 43, "normal messages still parse");
    assert.ok(h.stats.maxInFlight <= 8, `max in flight ${h.stats.maxInFlight}`);
    assert.equal(h.stats.maxInFlight, 8);
    for (const row of hung) row.release();
    assert.equal(h.stats.inFlight, 0);
  });

  it("refuses new parses while every slot is held by an earlier call's stalled streams, then recovers", async () => {
    const hung = hungRows(8);
    const h = makeHarness({ rows: [{}, {}, ...hung] });
    const first = h.call("invoice", undefined, h.folder.URI, 50);
    await sleep(15);
    for (const row of hung) row.timer.callback.notify();
    await first;
    for (const row of hung) row.mime = undefined;
    const calls = h.stats.mimeCalls;
    const blocked = await h.call("invoice", undefined, h.folder.URI, 50);
    assert.equal(h.stats.mimeCalls, calls, "nothing new may start while all slots are stalled");
    assert.equal(blocked.messages.length, 0);
    assert.match(blocked.message, /stalled/);
    for (const row of hung) row.release();
    const recovered = await h.call("invoice", undefined, h.folder.URI, 50);
    assert.equal(recovered.messages.length, 10);
  });

  it("rechecks access when another call releases a waited-for parse slot", async () => {
    const rows = hungRows(8);
    const h = makeHarness({ rows });
    const first = h.call("invoice", undefined, h.folder.URI);
    await sleep(20);
    assert.equal(h.stats.mimeCalls, 8);
    const second = h.call("invoice", undefined, h.folder.URI);
    await sleep(10);
    assert.ok(h.runtime.pool.waiters.length > 0, "the second search must wait for the shared pool");
    h.revokeAccess();
    for (const row of rows) row.release();
    const [, result] = await Promise.all([first, second]);
    assert.equal(h.stats.mimeCalls, 8, "no parse starts using access checked before the wait");
    assert.equal(result.messages.length, 0);
    assert.equal(result.notParsed, 8);
    assert.equal(result.truncated, true);
    assert.equal(h.runtime.pool.live, 0);
    assert.equal(h.runtime.pool.waiters.length, 0);
  });

  it("releases a timed-out stream only once even if its callback repeats", async () => {
    const row = { mime: "hang" };
    const h = makeHarness({ rows: [row] });
    const pending = h.call("invoice", undefined, h.folder.URI);
    await sleep(20);
    row.timer.callback.notify();
    const result = await pending;
    assert.equal(result.notParsed, 1);
    assert.equal(result.messages.length, 0);
    assert.equal(h.runtime.pool.live, 1);
    row.release();
    row.release();
    assert.equal(h.runtime.pool.live, 0);
    assert.equal(h.runtime.pool.stalledSlots.size, 0);
    assert.equal(result.messages.length, 0, "late callbacks cannot append to the settled response");
  });

  it("reclaims slots of streams that never call back after the stall TTL", async () => {
    const hung = hungRows(8);
    const h = makeHarness({ rows: [{}, {}, ...hung] });
    const first = h.call("invoice", undefined, h.folder.URI, 50);
    await sleep(15);
    for (const row of hung) row.timer.callback.notify();
    await first;
    for (const row of hung) row.mime = undefined;
    h.advance(6 * 60 * 1000);
    const later = await h.call("invoice", undefined, h.folder.URI, 50);
    assert.equal(later.messages.length, 10);
    // A callback arriving after reclamation must not free a slot twice.
    for (const row of hung) row.release();
    assert.equal(h.runtime.pool.live, 0);
    assert.equal(h.runtime.pool.stalledSlots.size, 0);
  });
});
