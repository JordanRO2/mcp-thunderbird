"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadThunderbirdHeaderParser } = require("./helpers/thunderbird-header-parser.cjs");
const recipientRowFixtures = require("./helpers/recipient-row-fixtures.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
// Same marker assertions and VM loading pattern as privacy-messages.test.cjs.
function snippet(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${startMarker}`);
  return source.slice(start, end);
}

const DECRYPTION_OKAY = 0x00020000;
const GOOD_SIGNATURE = 0x00000001;
const HEADER_LIMIT = 16 * 1024;
const CACHED_SUBJECT = "Cached decrypted subject";
const OUTER_SUBJECT = "Encrypted Message";
const ENCRYPTED_RAW = `From: sender@example.test\r\nSubject: =?utf-8?q?Encrypted_Message?=\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"\r\n\r\n--b--\r\n`;
const CLEAR_RAW = "From: sender@example.test\r\nSubject: Plain\r\nContent-Type: text/plain\r\n\r\nbody\r\n";

function makeStream(raw, stats) {
  let offset = 0;
  return {
    // Small chunks prove the header read stops at the header terminator.
    available() { return Math.min(raw.length - offset, 1000); },
    read(count) {
      const chunk = raw.slice(offset, offset + count);
      offset += chunk.length;
      stats.bytesRead += chunk.length;
      return chunk;
    },
    close() { stats.closed++; },
  };
}

function makeHeader(folder, { id, enigmail = 0, raw = CLEAR_RAW, date = 1, subject = CACHED_SUBJECT } = {}) {
  return {
    messageId: id, threadId: 1, folder, raw, date, flags: 0, isRead: false, isFlagged: false,
    subject, mime2DecodedSubject: subject, author: "sender@example.test", recipients: "reader@example.test",
    ccList: "",
    getStringProperty: (name) => (name === "preview" ? "Cached decrypted preview" : ""),
    getUint32Property: (name) => (name === "enigmail" ? enigmail : 0),
  };
}

function loadTools({ allowed = false, streamError = null } = {}) {
  const stats = { streams: 0, bytesRead: 0, closed: 0, displayed: 0, parsedHeaders: [], renders: 0 };
  const { headerParser, mimeConverter } = loadThunderbirdHeaderParser();
  const parseEncodedHeaderW = headerParser.parseEncodedHeaderW.bind(headerParser);
  const makeMimeHeader = headerParser.makeMimeHeader.bind(headerParser);
  headerParser.parseEncodedHeaderW = value => {
    stats.parsedHeaders.push(value);
    return parseEncodedHeaderW(value);
  };
  headerParser.makeMimeHeader = addresses => {
    stats.renders++;
    return makeMimeHeader(addresses);
  };
  const folder = {
    URI: "imap://account/INBOX", prettyName: "INBOX", hasSubFolders: false,
    getMsgInputStream(msgHdr) {
      stats.streams++;
      if (streamError) throw streamError;
      return makeStream(msgHdr.raw, stats);
    },
  };
  const headers = [];
  folder.msgDatabase = { enumerateMessages: () => headers };
  const sandbox = {
    console,
    TextDecoder, Uint8Array, atob,
    Cr: { NS_BASE_STREAM_CLOSED: "closed" },
    isToolEnabled: () => true,
    Services: { prefs: { getBoolPref: (name, fallback) => (name.endsWith(".allowEncryptedMessages") ? allowed : fallback) } },
    NetUtil: { readInputStreamToString: (stream, count) => stream.read(count) },
    MailServices: { mimeConverter, headerParser },
    ChromeUtils: { importESModule: () => ({ MailUtils: { displayMessageInFolderTab() { stats.displayed++; } } }) },
    findMessage: (messageId) => {
      const msgHdr = headers.find((header) => header.messageId === messageId);
      return msgHdr ? { msgHdr, folder } : { error: "not found" };
    },
    openFolder: () => ({ folder, db: folder.msgDatabase }),
    getAccessibleAccounts: () => [],
    getUserTags: () => [],
    DEFAULT_MAX_RESULTS: 50,
    MAX_SEARCH_RESULTS_CAP: 200,
    SEARCH_COLLECTION_CAP: 10000,
    buildTools: () => [{ name: "getRecentMessages", group: "messages" }],
  };
  vm.createContext(sandbox);
  vm.runInContext([
    source.match(/^const PREF_\w+ = .+;$/gm).join("\n"),
    snippet("// BEGIN PRIVACY PREFERENCE HELPERS", "// END PRIVACY PREFERENCE HELPERS"),
    snippet("// BEGIN MCP TEXT SANITIZATION", "// END MCP TEXT SANITIZATION"),
    snippet("// BEGIN MESSAGE TEXT CONVERSION", "// END MESSAGE TEXT CONVERSION"),
    snippet("// BEGIN RAW MIME PARSING HELPERS", "// END RAW MIME PARSING HELPERS"),
    snippet("// BEGIN RAW MIME ATTACHMENT HELPERS", "// END RAW MIME ATTACHMENT HELPERS"),
    snippet("// BEGIN ENCRYPTED MESSAGE GUARD", "// END ENCRYPTED MESSAGE GUARD"),
    snippet("// BEGIN SEARCH RESULT HELPERS", "// END SEARCH RESULT HELPERS"),
    snippet("async function displayMessage(", "function isTrashOrDescendant("),
    snippet("// BEGIN TOOL DISPATCH", "// END TOOL DISPATCH"),
  ].join("\n"), sandbox);
  return {
    api: sandbox, stats, folder,
    add(options) {
      const header = makeHeader(folder, options);
      headers.push(header);
      return header;
    },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("getRecentMessages rows cap address lists", () => {
  const longList = "a@x, b@x, c@x, d@x";
  const shortList = "a@x, b@x, c@x (+1 more)";

  for (const fixture of recipientRowFixtures) {
    it(`counts only real mailboxes in recent rows: ${fixture.raw}`, async () => {
      const h = loadTools();
      const display = h.api.MailServices.mimeConverter.decodeMimeHeader(fixture.raw, null, false, true);
      Object.assign(h.add({ id: "mailboxes" }), {
        recipients: fixture.raw, mime2DecodedRecipients: display, ccList: fixture.raw,
      });
      for (const fullRecipients of [undefined, false, null, true]) {
        const args = { folderPath: h.folder.URI, daysBack: 36500 };
        if (fullRecipients !== undefined) args.fullRecipients = fullRecipients;
        const [row] = await h.api.callTool("getRecentMessages", args);
        const summary = fullRecipients === true ? undefined : fixture.summary;
        assert.equal(row.recipients, summary ?? display);
        assert.equal(row.ccList, summary ?? fixture.raw);
      }
      assert.equal(h.stats.parsedHeaders.length, 6, "full mode bypasses the parser");
      assert.equal(h.stats.renders, fixture.mailboxes > 3 ? 6 : 0, "short fields are never re-rendered");
    });
  }

  it("preserves 0/1/3-mailbox display values exactly, including encoded punctuation", () => {
    const h = loadTools();
    const encoded = "a@x, =?UTF-8?Q?Doe=2C_John?= <j@x>, c@x";
    const fixtures = ["", "  Single (comment) <one@x>  ", encoded];
    for (const [index, raw] of fixtures.entries()) {
      const header = h.add({ id: `boundary-${index}`, date: index + 1 });
      header.recipients = raw;
      header.mime2DecodedRecipients = h.api.MailServices.mimeConverter.decodeMimeHeader(raw, null, false, true);
      header.ccList = raw;
    }
    const rows = h.api.getRecentMessages(h.folder.URI, 36500);
    assert.equal(rows.length, fixtures.length);
    for (const row of rows) {
      const raw = fixtures[Number(row.id.split("-")[1])];
      assert.equal(row.recipients, h.api.MailServices.mimeConverter.decodeMimeHeader(raw, null, false, true));
      assert.equal(row.ccList, raw);
    }
    assert.equal(h.stats.renders, 0, "short fields are never re-rendered");
    assert.ok(h.stats.parsedHeaders.includes(encoded), "count the original encoded header");
  });

  it("dispatches omitted/false/null/true and formats both ordinary and protected rows", async () => {
    for (const fullRecipients of [undefined, false, null, true]) {
      const h = loadTools();
      for (const [id, enigmail] of [["plain", 0], ["protected", DECRYPTION_OKAY]]) {
        const header = h.add({ id, enigmail, raw: ENCRYPTED_RAW });
        header.recipients = longList;
        header.mime2DecodedRecipients = longList;
        header.ccList = longList;
      }
      const args = { folderPath: h.folder.URI, daysBack: 36500 };
      if (fullRecipients !== undefined) args.fullRecipients = fullRecipients;
      const rows = await h.api.callTool("getRecentMessages", args);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.recipients, fullRecipients === true ? longList : shortList);
        assert.equal(row.ccList, fullRecipients === true ? longList : shortList);
        assert.deepEqual(Object.getOwnPropertyNames(row).filter(name => name.startsWith("_")), []);
      }
      assert.equal(rows.find(row => row.id === "protected").subject, OUTER_SUBJECT);
      if (fullRecipients === true) assert.equal(h.stats.parsedHeaders.length, 0);
    }
  });

  it("does not normalize full-mode values with encoded names, spacing or comments", () => {
    const h = loadTools();
    const raw = "  =?UTF-8?Q?Doe=2C_John?= <j@x>, b@x (B), c@x, d@x  ";
    const decoded = h.api.MailServices.mimeConverter.decodeMimeHeader(raw, null, false, true);
    const header = h.add({ id: "full" });
    header.recipients = raw;
    header.mime2DecodedRecipients = decoded;
    header.ccList = raw;
    const [row] = h.api.getRecentMessages(h.folder.URI, 36500, undefined, undefined, false, false, true, true);
    assert.equal(row.recipients, decoded);
    assert.equal(row.ccList, raw);
    assert.equal(h.stats.parsedHeaders.length, 0);
    assert.equal(h.stats.renders, 0);
  });

  it("keeps a row and later mail when its original To header cannot be read", () => {
    const h = loadTools();
    const header = h.add({ id: "unreadable", date: 2 });
    header.mime2DecodedRecipients = longList;
    Object.defineProperty(header, "recipients", { get() { throw new Error("unreadable original To"); } });
    h.add({ id: "later", date: 1 });
    const rows = h.api.getRecentMessages(h.folder.URI, 36500);
    assert.deepEqual(Array.from(rows, row => row.id), ["unreadable", "later"]);
    assert.equal(rows[0].recipients, longList);
    assert.deepEqual(Object.getOwnPropertyNames(rows[0]).filter(name => name.startsWith("_")), []);
  });

  for (const field of ["recipients", "ccList"]) {
    for (const failure of ["parse", "render"]) {
      it(`keeps before/failing/after rows and the other field when ${field} cannot ${failure}`, () => {
        const h = loadTools();
        const badList = `"${"A".repeat(901)}" <a@x>, b@x, c@x, d@x`;
        const parser = h.api.MailServices.headerParser;
        if (failure === "parse") {
          const parse = parser.parseEncodedHeaderW.bind(parser);
          parser.parseEncodedHeaderW = value => {
            if (value === badList) throw new Error("header parser failed");
            return parse(value);
          };
        } else {
          const addresses = parser.parseEncodedHeaderW(badList);
          assert.equal(addresses.length, 4);
          assert.throws(() => parser.makeMimeHeader(addresses.slice(0, 3)), /Cannot encode .* due to length\./,
            "the actual Thunderbird emitter must reject the 901-character display name");
        }
        for (const [index, id] of ["before", "bad", "after"].entries()) {
          const header = h.add({ id, date: 3 - index });
          header.recipients = longList;
          header.mime2DecodedRecipients = longList;
          header.ccList = longList;
          if (id === "bad") {
            header[field] = badList;
            if (field === "recipients") header.mime2DecodedRecipients = badList;
          }
        }
        const rows = plain(h.api.getRecentMessages(h.folder.URI, 36500));
        assert.deepEqual(rows.map(row => row.id), ["before", "bad", "after"]);
        for (const row of rows) {
          assert.equal(row.recipients, row.id === "bad" && field === "recipients" ? badList : shortList);
          assert.equal(row.ccList, row.id === "bad" && field === "ccList" ? badList : shortList);
        }
      });
    }
  }

  it("parses only returned fields, with no work for full mode or empty pages", () => {
    const h = loadTools();
    for (let index = 0; index < 100; index++) {
      const header = h.add({ id: `m-${index}`, date: index + 1 });
      header.recipients = longList;
      header.mime2DecodedRecipients = longList;
      header.ccList = longList;
    }
    const page = h.api.getRecentMessages(h.folder.URI, 36500, 1, 50);
    assert.equal(page.totalMatches, 100);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].id, "m-49");
    assert.equal(page.messages[0].recipients, shortList);
    assert.equal(page.messages[0].ccList, shortList);
    assert.deepEqual(Object.getOwnPropertyNames(page.messages[0]).filter(name => name.startsWith("_")), []);
    assert.equal(h.stats.parsedHeaders.length, 2);
    assert.equal(h.stats.renders, 2);
    const empty = h.api.getRecentMessages(h.folder.URI, 36500, 1, 100);
    assert.equal(empty.messages.length, 0);
    const full = h.api.getRecentMessages(h.folder.URI, 36500, 1, 50, false, false, true, true);
    assert.equal(full.messages[0].recipients, longList);
    assert.equal(full.messages[0].ccList, longList);
    assert.equal(h.stats.parsedHeaders.length, 2);
    assert.equal(h.stats.renders, 2);
  });
});

describe("getRecentMessages protects subjects of encrypted mail", () => {
  it("returns the transmitted subject without a preview for recorded encrypted messages", () => {
    const h = loadTools();
    h.add({ id: "encrypted", enigmail: DECRYPTION_OKAY, raw: ENCRYPTED_RAW, date: 2 });
    h.add({ id: "clear", date: 1 });
    const rows = plain(h.api.getRecentMessages(h.folder.URI, 36500));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "encrypted");
    assert.equal(rows[0].subject, OUTER_SUBJECT);
    assert.equal(rows[0].preview, undefined);
    assert.equal(rows[0].encryptedContentWithheld, true);
    assert.equal(rows[1].subject, CACHED_SUBJECT);
    assert.equal(rows[1].preview, "Cached decrypted preview");
    assert.equal(rows[1].encryptedContentWithheld, undefined);
    assert.doesNotMatch(JSON.stringify(rows[0]), /Cached decrypted/);
    assert.equal(h.stats.streams, 1, "only the protected row is read");
    assert.equal(h.stats.closed, 1);
  });

  it("reads stored messages only for protected rows on the returned page", () => {
    const h = loadTools();
    for (let index = 0; index < 30; index++) {
      h.add({ id: `m-${index}`, enigmail: DECRYPTION_OKAY, raw: ENCRYPTED_RAW, date: index + 1 });
    }
    const page = plain(h.api.getRecentMessages(h.folder.URI, 36500, 3, 0));
    assert.equal(page.messages.length, 3);
    assert.equal(page.totalMatches, 30);
    for (const row of page.messages) {
      assert.equal(row.subject, OUTER_SUBJECT);
      assert.equal(row.encryptedContentWithheld, true);
      assert.equal(Object.hasOwn(row, "_protectedHdr"), false);
    }
    assert.equal(h.stats.streams, 3);
  });

  it("returns cached subjects and previews after explicit opt-in", () => {
    const h = loadTools({ allowed: true });
    h.add({ id: "encrypted", enigmail: DECRYPTION_OKAY, raw: ENCRYPTED_RAW });
    const [row] = plain(h.api.getRecentMessages(h.folder.URI, 36500));
    assert.equal(row.subject, CACHED_SUBJECT);
    assert.equal(row.preview, "Cached decrypted preview");
    assert.equal(row.encryptedContentWithheld, undefined);
    assert.equal(h.stats.streams, 0);
  });

  it("leaves signed-only messages unchanged", () => {
    const h = loadTools();
    h.add({ id: "signed", enigmail: GOOD_SIGNATURE });
    const [row] = plain(h.api.getRecentMessages(h.folder.URI, 36500));
    assert.equal(row.subject, CACHED_SUBJECT);
    assert.equal(h.stats.streams, 0);
  });

  it("uses a placeholder when the transmitted subject cannot be read within the header bound", () => {
    const oversized = `X-Padding: ${"a".repeat(HEADER_LIMIT)}\r\nSubject: Outer\r\n\r\nbody`;
    const duplicate = "Subject: One\r\nSubject: Two\r\n\r\nbody";
    for (const [label, options] of [
      ["oversized headers", { raw: oversized }],
      ["duplicate subjects", { raw: duplicate }],
      ["unreadable stream", { streamError: new Error("not available offline") }],
    ]) {
      const h = loadTools({ streamError: options.streamError });
      h.add({ id: "encrypted", enigmail: DECRYPTION_OKAY, raw: options.raw || ENCRYPTED_RAW });
      const [row] = plain(h.api.getRecentMessages(h.folder.URI, 36500));
      assert.equal(row.subject, "[Encrypted message]", label);
      assert.equal(row.encryptedContentWithheld, true, label);
      assert.ok(h.stats.bytesRead <= HEADER_LIMIT, `${label}: read ${h.stats.bytesRead} bytes`);
    }
  });
});

describe("displayMessage while encrypted message access is off", () => {
  it("refuses messages that are encrypted or recorded as encrypted, before opening them", async () => {
    for (const options of [
      { raw: ENCRYPTED_RAW },
      { raw: "Subject: S/MIME\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nx" },
      { raw: "Subject: Ambiguous\r\nContent-Type: text/plain\r\nContent-Type: multipart/encrypted\r\n\r\nx" },
      { raw: CLEAR_RAW, enigmail: DECRYPTION_OKAY },
    ]) {
      const h = loadTools();
      h.add({ id: "message", ...options });
      const result = await h.api.displayMessage("message", h.folder.URI);
      assert.match(result.error, /Encrypted messages cannot be displayed while encrypted message access is off/);
      assert.equal(result.subject, undefined);
      assert.equal(h.stats.displayed, 0);
      assert.ok(h.stats.bytesRead <= HEADER_LIMIT);
    }
  });

  it("displays clear messages and, after opt-in, encrypted ones", async () => {
    for (const [allowed, raw] of [[false, CLEAR_RAW], [true, ENCRYPTED_RAW]]) {
      const h = loadTools({ allowed });
      h.add({ id: "message", raw });
      const result = await h.api.displayMessage("message", h.folder.URI);
      assert.equal(result.success, true, result.error);
      assert.equal(h.stats.displayed, 1);
    }
  });
});
