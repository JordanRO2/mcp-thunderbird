"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
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
const PDF = { name: "Invoice.PDF", contentType: "application/pdf", size: 10, disposition: "attachment" };
const PNG = { name: "photo.png", contentType: "image/png", size: 20, disposition: "attachment" };
// Searched the raw-MIME and message-read fixtures: their builders are local.
// Keep valid MIME here; search metadata is derived from these exact bytes.
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

/** Native MIME APIs are forbidden: the one local raw read is the only transport. */
function makeHarness({
  rows, extraFolders = [], allowEncrypted = false, msPerYield = 0,
  serverType = "imap",
} = {}) {
  const stats = {
    yields: 0, mimeCalls: 0, uriCalls: 0, channelCalls: 0, imports: 0,
    rawOpens: 0, rawCloses: 0, rawFolders: [], serverFetches: 0, refreshes: 0,
  };
  function forbidden(name) {
    stats[name]++;
    assert.fail(`Attachment search must not call native MIME transport (${name})`);
  }
  let generation = 0;
  let now = 0;
  let accessible = true;
  let toolEnabled = true;
  let onYield = null;
  const folders = [];

  [rows, ...extraFolders].forEach((folderRows, folderIndex) => {
    const headers = new Map();
    const folder = {
      URI: `imap://account${folderIndex + 1}/INBOX`,
      prettyName: "INBOX",
      isServer: false,
      server: null,
      updateFolder() { stats.refreshes++; },
      headers,
      getUriForMsg() { forbidden("uriCalls"); },
      generateMessageURI() { forbidden("uriCalls"); },
      getMsgInputStream(msgHdr) {
        stats.rawOpens++;
        stats.rawFolders.push(this.URI);
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
    Cc: new Proxy({}, { get: () => ({ createInstance: () => forbidden("channelCalls") }) }),
    ChromeUtils: { importESModule: () => forbidden("imports") },
    MsgHdrToMimeMessage: () => forbidden("mimeCalls"),
    NetUtil: {
      readInputStreamToString: (stream, count) => stream.read(count),
      newChannel: () => forbidden("channelCalls"),
    },
    MailServices: {
      messageServiceFromURI() {
        forbidden("serverFetches");
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
  const code = [
    ...["SEARCH_YIELD_EVERY", "SEARCH_TIME_BUDGET_MS", "PREF_ALLOW_ENCRYPTED_MESSAGES", "DEFAULT_MAX_RESULTS", "MAX_SEARCH_RESULTS_CAP"].map(constant),
    snippet("// BEGIN ATTACHMENT SEARCH LIMITS", "// END ATTACHMENT SEARCH LIMITS"),
    snippet("// BEGIN PRIVACY PREFERENCE HELPERS", "// END PRIVACY PREFERENCE HELPERS"),
    snippet("// BEGIN BOUNDED REFRESH HELPERS", "// END BOUNDED REFRESH HELPERS"),
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
    "this.run = searchAttachments;",
  ].join("\n");
  vm.runInContext(code, runtime);

  return {
    runtime, folder: folders[0], folders, stats, code,
    advance(ms) { now += ms; },
    revokeAccess() { accessible = false; },
    disableTool() { toolEnabled = false; },
    setEncrypted(value) { allowEncrypted = value; },
    setOnYield(callback) { onYield = callback; },
    afterExtraction(callback) {
      const extract = runtime.extractAttachmentSearchMetadata;
      runtime.extractAttachmentSearchMetadata = async (...args) => {
        const result = await extract(...args);
        callback();
        return result;
      };
    },
    async call(...args) {
      const result = JSON.parse(JSON.stringify(await runtime.run(...args)));
      for (const name of ["mimeCalls", "uriCalls", "channelCalls", "imports", "serverFetches"]) {
        assert.equal(stats[name], 0, `Forbidden native transport on ${name}`);
      }
      return result;
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
    assert.match(tool.description, /heuristic/);
    assert.match(tool.description, /notOffline/);
    assert.equal(tool.inputSchema.properties.maxResults.minimum, 1);
    assert.equal(tool.inputSchema.properties.maxResults.maximum, 200);
    assert.equal(tool.inputSchema.properties.maxResults.default, 50);
    assert.equal(tool.inputSchema.properties.scanCap.minimum, 1);
    assert.equal(tool.inputSchema.properties.scanCap.maximum, 50000);
    assert.equal(tool.inputSchema.properties.scanCap.default, 5000);
    assert.match(tool.description, /never decrypt/i);
    assert.match(tool.description, /2 MiB/);
  });
});

describe("searchAttachments results", () => {
  it("returns the shared header shape plus folderPath and matchingAttachments", async () => {
    const h = makeHarness({ rows: [{ atts: [PDF, PNG] }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.truncated, false);
    assert.equal("message" in result, false);
    assert.equal("matches" in result, false);
    assert.equal(result.messages.length, 1);
    assert.equal(h.stats.refreshes, 0, "a local-only search must not start a folder sync");
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

  it("uses the shared default and maximum result limits at runtime", async () => {
    const h = makeHarness({ rows: rowsOf(201) });
    const defaulted = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(defaulted.messages.length, 50);
    const capped = await h.call("invoice", undefined, h.folder.URI, 1000);
    assert.equal(capped.messages.length, 200);
    assert.equal(capped.overflow, 1);
    assert.equal(capped.truncated, true);
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
    const h = makeHarness({ rows: [{ offline: false }, ...rowsOf(6), { rawThrows: true }] });
    const result = await h.call("invoice", undefined, h.folder.URI, 2);
    assert.equal(result.truncated, true);
    assert.match(result.message, /more messages matched than maxResults/);
    assert.match(result.message, /no complete local copy/);
    assert.match(result.message, /could not be inspected/);
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

  it("applies the named default and maximum scan caps", async () => {
    const raw = "Content-Type: text/plain\r\n\r\nClear.\r\n";
    const h = makeHarness({ rows: rowsOf(50001, { attach: false, raw }) });
    const defaulted = await h.call("x", undefined, h.folder.URI);
    assert.equal(defaulted.totalScanned, 5000);
    assert.equal(defaulted.scanCapHit, true);
    const capped = await h.call("x", undefined, h.folder.URI, 200, 100000);
    assert.equal(capped.totalScanned, 50000);
    assert.equal(capped.scanCapHit, true);
    assert.equal(h.stats.mimeCalls, 0);
  });

  it("limits the candidate buffer to maxResults*4 and reports it", async () => {
    const h = makeHarness({ rows: rowsOf(100) });
    const result = await h.call("invoice", undefined, h.folder.URI, 2);
    assert.equal(result.candidates, 8);
    assert.equal(result.candidateLimitHit, true);
    assert.equal(h.stats.rawOpens, 8);
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
    assert.equal(h.stats.rawOpens, 200);
    assert.equal(result.truncated, true);
  });

  it("keeps the newest candidates across folders, not the first folder's", async () => {
    const older = Array.from({ length: 100 }, (_, i) => ({ date: 1000 + i }));
    const newer = Array.from({ length: 100 }, (_, i) => ({ date: 5000 + i }));
    const h = makeHarness({ rows: older, extraFolders: [newer] });
    const result = await h.call("invoice", undefined, undefined, 5);
    assert.equal(result.candidates, 20);
    assert.ok(h.stats.rawFolders.every(uri => uri === h.folders[1].URI));
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
  it("counts them separately without opening local raw input, and explains why", async () => {
    const h = makeHarness({ rows: [{ offline: false }, { offline: false }, {}] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.notOffline, 2);
    assert.equal(result.candidates, 1);
    assert.equal(h.stats.rawOpens, 1);
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
      it(`withholds ${name} without native MIME parsing with opt-in ${allowEncrypted}`, async () => {
        const h = makeHarness({ rows: [{ raw }], allowEncrypted });
        assert.notEqual(h.runtime.classifyRawMessageEncryption(raw, 0, { signedRaw: true }), "clear");
        const result = await h.call("invoice", undefined, h.folder.URI);
        assert.equal(h.stats.mimeCalls, 0, "native parsers must never be consulted");
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
    assert.equal(h.stats.rawOpens, 1);
  });
});


function rawPart(headers, body = "body") {
  return [...headers, "", body].join("\r\n");
}

function mixedRaw(parts, subtype = "mixed") {
  return [`Content-Type: multipart/${subtype}; boundary="semantics"`, "",
    ...parts.flatMap(part => ["--semantics", part]), "--semantics--", ""].join("\r\n");
}

describe("searchAttachments snapshot metadata", () => {
  it("returns only accepted snapshot metadata when the URI's later contents differ", async () => {
    const row = { raw: PLAIN_RAW };
    const h = makeHarness({ rows: [row] });
    row.onRawRead = () => { row.raw = attachmentRaw([{ ...PNG, name: "later.png" }]); };
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.deepEqual(result.messages[0].matchingAttachments, [PDF]);
    assert.equal(result.truncated, false);
    assert.equal(h.stats.rawOpens, 1);
    assert.equal(h.stats.rawCloses, 1);
    assert.doesNotMatch(JSON.stringify(result), /later\.png/);
  });

  it("never sees a future encrypted URI body after accepting clear snapshot bytes", async () => {
    const row = { raw: PLAIN_RAW };
    const h = makeHarness({ rows: [row], allowEncrypted: true });
    row.onRawRead = () => { row.raw = SMIME_RAW; };
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.deepEqual(result.messages[0].matchingAttachments, [PDF]);
    assert.equal(result.truncated, false);
    assert.equal(h.stats.rawOpens, 1);
  });

  it("includes named leaves and attachment dispositions, including named text and inline images", async () => {
    const raw = mixedRaw([
      rawPart(['Content-Type: text/plain; name="notes.txt"'], "notes"),
      rawPart(['Content-Type: image/png; name="inline.png"', 'Content-Disposition: inline; filename="inline.png"'], "image"),
      rawPart(['Content-Type: application/pdf', 'Content-Disposition: attachment'], "pdf"),
      rawPart(['Content-Type: image/png', 'Content-ID: <unnamed>'], "unnamed inline image"),
      rawPart(['Content-Type: text/plain'], "ordinary body"),
    ]);
    const h = makeHarness({ rows: [{ raw }] });
    const result = await h.call(undefined, "", h.folder.URI);
    assert.match(result.error, /at least one/);
    const found = await h.call(undefined, "t", h.folder.URI);
    assert.deepEqual(found.messages[0].matchingAttachments, [
      { name: "notes.txt", contentType: "text/plain", size: 5, disposition: "" },
    ]);
    const all = await h.call(undefined, "image", h.folder.URI);
    assert.deepEqual(all.messages[0].matchingAttachments, [
      { name: "inline.png", contentType: "image/png", size: 5, disposition: "inline" },
    ]);
    const unnamed = await h.call(undefined, "application/pdf", h.folder.URI);
    assert.deepEqual(unnamed.messages[0].matchingAttachments, [
      { name: "", contentType: "application/pdf", size: 3, disposition: "attachment" },
    ]);
    assert.equal(unnamed.truncated, false);
  });

  it("includes a single-part root attachment and decodes filename parameters", async () => {
    const raw = rawPart([
      'Content-Type: text/plain; charset=utf-8',
      "Content-Disposition: attachment; filename*=utf-8''caf%C3%A9.txt",
    ], "hello");
    const h = makeHarness({ rows: [{ raw }] });
    const result = await h.call("CAFÉ", undefined, h.folder.URI);
    assert.deepEqual(result.messages[0].matchingAttachments, [
      { name: "café.txt", contentType: "text/plain", size: 5, disposition: "attachment" },
    ]);
  });

  for (const type of ["message/rfc822", "message/news", "message/global"]) {
    it(`represents ${type} as one attachment without flattening its contained attachments`, async () => {
      const raw = mixedRaw([rawPart([`Content-Type: ${type}`], PLAIN_RAW)]);
      const h = makeHarness({ rows: [{ raw }] });
      const embedded = await h.call(undefined, "message/", h.folder.URI);
      assert.deepEqual(embedded.messages[0].matchingAttachments, [
        { name: "", contentType: type, size: PLAIN_RAW.length, disposition: "" },
      ]);
      assert.equal(embedded.truncated, false);
      const inner = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(inner.messages.length, 0);
      assert.equal(inner.truncated, false);
    });
  }

  it("applies multipart/digest's embedded-message default to untyped children", async () => {
    const raw = mixedRaw([`\r\n${PLAIN_RAW}`], "digest");
    const h = makeHarness({ rows: [{ raw }] });
    const result = await h.call(undefined, "message/", h.folder.URI);
    assert.deepEqual(result.messages[0].matchingAttachments, [
      { name: "", contentType: "message/rfc822", size: PLAIN_RAW.length, disposition: "" },
    ]);
  });

  it("reports decoded byte sizes for base64 and quoted-printable without fetching attachment content", async () => {
    const raw = mixedRaw([
      rawPart(['Content-Type: application/pdf', 'Content-Disposition: attachment; filename="base64.pdf"',
        'Content-Transfer-Encoding: base64'], "QUJD\r\nREU="),
      rawPart(['Content-Type: text/plain; charset=utf-8', 'Content-Disposition: attachment; filename="quoted.txt"',
        'Content-Transfer-Encoding: quoted-printable'], "caf=C3=A9=\r\n!"),
    ]);
    const h = makeHarness({ rows: [{ raw }] });
    const result = await h.call(".", undefined, h.folder.URI);
    assert.deepEqual(result.messages[0].matchingAttachments, [
      { name: "base64.pdf", contentType: "application/pdf", size: 5, disposition: "attachment" },
      { name: "quoted.txt", contentType: "text/plain", size: 6, disposition: "attachment" },
    ]);
    assert.equal(result.truncated, false);
  });

  it("reports external attachment metadata with an unknown size and never opens its location", async () => {
    const raw = rawPart([
      'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="external.pdf"',
      'X-Mozilla-External-Attachment-URL: file:///unread/external.pdf',
    ], "A stored detached-attachment stub.");
    const h = makeHarness({ rows: [{ raw }] });
    const result = await h.call("external", undefined, h.folder.URI);
    assert.deepEqual(result.messages[0].matchingAttachments, [
      { name: "external.pdf", contentType: "application/pdf", size: null, disposition: "attachment" },
    ]);
    assert.equal(result.truncated, false);
  });

  it("counts undecodable filename metadata instead of silently omitting a possible match", async () => {
    const raw = rawPart(['Content-Type: application/pdf', "Content-Disposition: attachment; filename*=unknown''bad"], "PDF");
    const h = makeHarness({ rows: [{ raw }] });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.protectedWithheld, 1);
    assert.equal(result.truncated, true);
  });
});

describe("searchAttachments signed snapshots", () => {
  for (const allowEncrypted of [false, true]) {
    it(`applies signed policy to the snapshot with opt-in ${allowEncrypted}`, async () => {
      const h = makeHarness({ rows: [{ raw: SIGNED_RAW }], allowEncrypted });
      assert.equal(h.runtime.classifyRawMessageEncryption(SIGNED_RAW, 0, { signedRaw: true }), "clear");
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(result.messages.length, allowEncrypted ? 1 : 0);
      assert.equal(result.protectedWithheld || 0, allowEncrypted ? 0 : 1);
      assert.equal(result.truncated, !allowEncrypted);
      assert.equal(h.stats.rawOpens, 1);
    });

    it(`withholds name-typed protection inside signed mail with opt-in ${allowEncrypted}`, async () => {
      const raw = SIGNED_RAW.replace('Content-Type: application/pdf', 'Content-Type: application/octet-stream')
        .replace('filename="Invoice.PDF"', 'filename="archive.pgp"');
      const h = makeHarness({ rows: [{ raw }], allowEncrypted });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(result.protectedWithheld, 1);
      assert.equal(result.truncated, true);
    });

    it(`withholds a stripped/incomplete signed snapshot with opt-in ${allowEncrypted}`, async () => {
      const raw = SIGNED_RAW.replace(PLAIN_RAW, "");
      const h = makeHarness({ rows: [{ raw }], allowEncrypted });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.equal(result.protectedWithheld, 1);
      assert.equal(result.truncated, true);
    });
  }

  const malformedSigned = [
    ["wrong signature type", SIGNED_RAW.replace(
      'Content-Type: application/pgp-signature',
      'Content-Type: application/pdf; name="hidden.pdf"',
    )],
    ["third ordinary attachment", SIGNED_RAW.replace('--signed--', [
      '--signed', 'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="hidden.pdf"', '', 'hidden', '--signed--',
    ].join('\r\n'))],
    ["missing protocol", SIGNED_RAW.replace('; protocol="application/pgp-signature"', '')],
    ["unknown protocol", SIGNED_RAW.replace('protocol="application/pgp-signature"', 'protocol="application/unknown-signature"')],
  ];
  for (const [label, signed] of malformedSigned) {
    for (const nested of [false, true]) {
      for (const allowEncrypted of [false, true]) {
        it(`counts ${nested ? "nested" : "top-level"} signed ${label} with opt-in ${allowEncrypted}`, async () => {
          const raw = nested ? mixedRaw([signed]) : signed;
          const h = makeHarness({ rows: [{ raw }], allowEncrypted });
          // These trees illustrate the attachment extractor's extra obligation:
          // the shared privacy gate establishes clear bytes, not valid signing.
          assert.equal(h.runtime.classifyRawMessageEncryption(raw, 0, { signedRaw: true }), "clear");
          const result = await h.call("invoice", undefined, h.folder.URI);
          assert.equal(result.messages.length, 0);
          assert.equal(result.protectedWithheld, 1);
          assert.equal(result.truncated, true);
          assert.equal(h.stats.rawOpens, 1);
          assert.doesNotMatch(JSON.stringify(result), /Invoice|hidden\.pdf/);
        });
      }
    }
  }

  it("does not return a detached signature as an attachment", async () => {
    const raw = SIGNED_RAW.replace('Content-Type: application/pgp-signature',
      'Content-Type: application/pgp-signature\r\nContent-Disposition: attachment; filename="signature.asc"');
    const h = makeHarness({ rows: [{ raw }], allowEncrypted: true });
    const result = await h.call("signature", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.truncated, false);
    assert.equal((await h.call("invoice", undefined, h.folder.URI)).messages.length, 1);
  });
});

describe("searchAttachments access, identity and deadlines across awaits", () => {
  it("rechecks local availability after collecting the primitive locator", async () => {
    const row = {};
    const h = makeHarness({ rows: [row] });
    h.setOnYield(() => { row.header.flags &= ~FLAGS.Offline; });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.notOffline, 1);
    assert.equal(h.stats.rawOpens, 0);
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

  it("rechecks signed-mail policy after raw acquisition before extraction", async () => {
    const row = { raw: SIGNED_RAW };
    const h = makeHarness({ rows: [row], allowEncrypted: true });
    row.onRawRead = () => h.setEncrypted(false);
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.messages.length, 0);
    assert.equal(result.protectedWithheld, 1);
    assert.equal(result.truncated, true);
  });

  for (const reason of ["access", "tool", "key reuse", "recorded encryption", "signed opt-out"]) {
    it(`rechecks ${reason} before publishing an extracted result`, async () => {
      const row = reason === "signed opt-out" ? { raw: SIGNED_RAW } : {};
      const h = makeHarness({ rows: [row], allowEncrypted: true });
      h.afterExtraction(() => {
        if (reason === "access") h.revokeAccess();
        if (reason === "tool") h.disableTool();
        if (reason === "key reuse") row.header.messageId = "replacement@example.test";
        if (reason === "recorded encryption") row.enigmail = DECRYPTION_OKAY;
        if (reason === "signed opt-out") h.setEncrypted(false);
      });
      const result = await h.call("invoice", undefined, h.folder.URI);
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
    it(`rechecks ${reason} for a nonmatching snapshot before reporting completeness`, async () => {
      const row = reason === "signed opt-out" ? { raw: SIGNED_RAW } : {};
      const h = makeHarness({ rows: [row], allowEncrypted: true });
      h.afterExtraction(() => {
        if (reason === "signed opt-out") h.setEncrypted(false);
        else row.header.messageId = "replacement@example.test";
      });
      const result = await h.call("does-not-match", undefined, h.folder.URI);
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
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
  });

  it("checks the deadline across cooperative extraction yields", async () => {
    const h = makeHarness({ rows: [{ raw: attachmentRaw(rowsOf(64, PDF)) }] });
    h.setOnYield(count => { if (count > 1) h.advance(20000); });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.ok(h.stats.yields > 1, "a large metadata walk must cooperate with the main thread");
    assert.equal(result.messages.length, 0);
    assert.equal(result.notParsed, 1);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
  });

  for (const reason of ["access", "tool", "key reuse", "recorded encryption", "signed opt-out", "offline copy"]) {
    it(`rechecks ${reason} changed during a metadata extraction yield`, async () => {
      const many = attachmentRaw(rowsOf(64, PDF));
      const row = { raw: reason === "signed opt-out" ? SIGNED_RAW.replace(PLAIN_RAW, many) : many };
      const h = makeHarness({ rows: [row], allowEncrypted: true });
      h.setOnYield(count => {
        if (count !== 2) return;
        if (reason === "access") h.revokeAccess();
        if (reason === "tool") h.disableTool();
        if (reason === "key reuse") row.header.messageId = "replacement@example.test";
        if (reason === "recorded encryption") row.enigmail = DECRYPTION_OKAY;
        if (reason === "signed opt-out") h.setEncrypted(false);
        if (reason === "offline copy") row.header.flags &= ~FLAGS.Offline;
      });
      const result = await h.call("invoice", undefined, h.folder.URI);
      assert.ok(h.stats.yields >= 2);
      if (reason === "tool") {
        assert.match(result.error, /disabled/);
        assert.equal(result.messages, undefined);
      } else {
        assert.equal(result.messages.length, 0);
        assert.equal(result.truncated, true);
        if (reason === "recorded encryption" || reason === "signed opt-out") assert.equal(result.protectedWithheld, 1);
        else if (reason === "offline copy") assert.equal(result.notOffline, 1);
        else assert.equal(result.notParsed, 1);
      }
    });
  }

  it("gives every candidate a separate turn for raw classification", async () => {
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
  });

  it("checks the deadline again before building the response", async () => {
    const h = makeHarness({ rows: [{}] });
    h.afterExtraction(() => h.advance(20000));
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
    assert.equal(result.messages.length, 0);
    assert.equal(result.notParsed, 1);
  });

  it("stops final database lookups when one lookup consumes the remaining budget", async () => {
    const rows = rowsOf(40);
    const h = makeHarness({ rows });
    let publishing = false;
    let finalOpens = 0;
    let extracted = 0;
    h.afterExtraction(() => {
      if (++extracted === rows.length) { publishing = true; h.advance(19000); }
    });
    const open = Object.getOwnPropertyDescriptor(h.folder, "msgDatabase").get;
    Object.defineProperty(h.folder, "msgDatabase", { get() {
      if (publishing) { finalOpens++; h.advance(1000); }
      return open.call(h.folder);
    } });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(finalOpens, 1);
    assert.equal(result.messages.length, 0);
    assert.equal(result.notParsed, 40);
    assert.equal(result.truncated, true);
  });

  it("does not open candidates once the budget is spent during the scan", async () => {
    const rows = [...rowsOf(997, { attach: false }), ...rowsOf(3)];
    const h = makeHarness({ rows, msPerYield: 7000 });
    const result = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(h.stats.rawOpens, 0);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
    assert.equal(result.notParsed, result.candidates);
  });

  it("counts candidates left at the shared deadline as unavailable", async () => {
    const h = makeHarness({ rows: rowsOf(40), msPerYield: 2500 });
    const result = await h.call("invoice", undefined, h.folder.URI, 200);
    assert.equal(result.truncated, true);
    assert.match(result.message, /20-second/);
    assert.ok(result.notParsed > 0);
    assert.equal(result.messages.length + result.notParsed, result.candidates);
  });
});

describe("searchAttachments search-local accounting", () => {
  it("keeps concurrent searches' failures and explanations independent", async () => {
    const h = makeHarness({ rows: [{ rawThrows: true }], extraFolders: [[{}]] });
    const [failed, complete] = await Promise.all([
      h.call("invoice", undefined, h.folders[0].URI),
      h.call("invoice", undefined, h.folders[1].URI),
    ]);
    assert.equal(failed.notParsed, 1);
    assert.equal(failed.truncated, true);
    assert.equal(complete.messages.length, 1);
    assert.equal(complete.truncated, false);
    assert.equal(complete.message, undefined);
    assert.equal(complete.notParsed, undefined);
  });

  it("does not carry another search's failure explanations into a complete search", async () => {
    const row = { rawThrows: true };
    const h = makeHarness({ rows: [row] });
    const failed = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(failed.notParsed, 1);
    assert.equal(failed.truncated, true);
    row.rawThrows = false;
    const complete = await h.call("invoice", undefined, h.folder.URI);
    assert.equal(complete.messages.length, 1);
    assert.equal(complete.truncated, false);
    assert.equal(complete.message, undefined);
    assert.equal(complete.notParsed, undefined);
  });
});

describe("searchAttachments native handle lifetime", () => {
  it("releases header/database handles across admission and metadata extraction awaits", () => {
    // Reuse S13's WeakRef/GC driver, with the same production code as these
    // behavior tests. Its fixture never retains native-like handles for us.
    const { code } = makeHarness({ rows: [] });
    const child = spawnSync(process.execPath, ["--expose-gc",
      path.resolve(__dirname, "helpers/message-header-retention.cjs"), "attachments"], {
      input: code, encoding: "utf8", timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout).ok, true);
  });
});
