"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadPreflight } = require("./direct-send-preflight.test.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const CAP = 50 * 1024 * 1024;
const TIME = 120000;
const CLEAR = "Content-Type: text/plain\r\n\r\nvisible";
const ENCRYPTED = "Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nYWJj";
const UNKNOWN = "Content-Type: text/plain\r\nContent-Type: application/pkcs7-mime\r\n\r\nopaque";
const IMAGE_MIME = { contentType: "multipart/related", parts: [
  { contentType: "text/plain", body: "visible" },
  { contentType: "image/png", partName: "1.2", size: 3 },
] };
const ATTACHMENT_MIME = { contentType: "text/plain", body: "visible", allUserAttachments: [
  { name: "a.txt", contentType: "text/plain", size: 3, url: "mailbox://fixture?part=1.2" },
] };
const RAW_PARTS = [
  'Content-Type: multipart/related; boundary="b"', "", "--b", CLEAR,
  "--b", "Content-Type: image/png; name=a.png", "Content-ID: <image@example.test>",
  "Content-Transfer-Encoding: base64", "", "YWJj", "--b--", "",
].join("\r\n");

function snippet(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
  return source.slice(start, end);
}

// Searched existing VM/stream/timer fixtures: reuse loadPreflight's real raw
// reader and controllable native callbacks. Only part-channel/file/UI stubs
// are added here, following privacy-messages' in-memory file stub.
function loadRead(options = {}) {
  const h = loadPreflight({ raw: CLEAR, ...options });
  const { api, calls } = h;
  const access = { allowed: options.allowed === true, account: true, disabled: new Set() };
  Object.assign(calls, { parts: [], copies: [], files: [], dirs: 0, writes: 0, displayed: 0, logs: [] });
  const originalFind = api.findMessage;
  api.findMessage = (...args) => access.account ? originalFind(...args) : { error: "Account access denied" };
  api.isToolEnabled = name => !access.disabled.has(name);
  api.isPrivacyOptInEnabled = () => access.allowed;
  api.getUserTags = () => [];
  api.getConfiguredGetMessagesLimit = () => 20;
  api.console = { error: (...args) => calls.logs.push(args) };
  const importModule = api.ChromeUtils.importESModule;
  api.ChromeUtils.importESModule = url => url.includes("MailUtils") ? {
    MailUtils: {
      displayMessageInFolderTab() { calls.displayed++; },
      openMessageInNewWindow() { calls.displayed++; },
    },
  } : importModule(url);
  const messageService = api.MailServices.messageServiceFromURI;
  api.MailServices.messageServiceFromURI = uri => ({ ...messageService(uri), getUrlForUri: () => ({ spec: "mailbox://fixture" }) });
  api.Services.wm = { getMostRecentWindow: () => ({ document: { getElementById: () => ({ openTab() { calls.displayed++; } }) } }) };
  api.Services.dirsvc = { get: () => file("/tmp/mock") };
  api.Ci.nsIFile = { DIRECTORY_TYPE: 1, NORMAL_FILE_TYPE: 0 };
  function file(filePath) {
    return {
      path: filePath, fileSize: 0, removed: false,
      clone() { return file(this.path); },
      append(name) { this.path += "/" + name; },
      create() { calls.dirs++; },
      createUnique() { calls.files.push(this); },
      remove() { this.removed = true; },
    };
  }
  api.Cc["@mozilla.org/network/file-output-stream;1"] = { createInstance: () => ({
    init(target) { this.file = target; }, close() {},
  }) };
  api.Cc["@mozilla.org/binaryoutputstream;1"] = { createInstance: () => ({
    setOutputStream(stream) { this.stream = stream; },
    writeByteArray(_bytes, length) { calls.writes++; this.stream.file.fileSize = length; }, close() {},
  }) };
  api.NetUtil.newChannel = ({ uri }) => ({ uri, cancelled: 0, cancel() { this.cancelled++; } });
  api.NetUtil.asyncFetch = (channel, callback) => {
    const entry = { channel, callback, closes: 0 };
    entry.deliver = (bytes = "abc", status = 0) => {
      let offset = 0;
      const stream = {
        available: () => bytes.length - offset,
        read(n) { const value = bytes.slice(offset, offset + n); offset += value.length; return value; },
        close() { entry.closes++; },
      };
      callback(stream, status);
    };
    calls.parts.push(entry);
    if (!options.deferParts) entry.deliver(options.partBytes ?? "abc");
  };
  api.NetUtil.asyncCopy = (input, output, callback) => {
    const entry = { cancelled: 0, cancel() { this.cancelled++; } };
    entry.deliver = () => {
      output.file.fileSize = input.available();
      callback(0);
    };
    calls.copies.push(entry);
    if (!options.deferCopy) entry.deliver();
    return entry;
  };
  // loadPreflight already loads text sanitization and inline-image helpers for
  // the integrated compose-size guard. Extend that VM without redeclaring them.
  vm.runInContext([
    snippet("MESSAGE READ TOOLS"),
    source.slice(source.indexOf("async function displayMessage("), source.indexOf("function getRecentMessages(")),
  ].join("\n"), api);
  h.access = access;
  h.get = (args = {}) => api.getMessage("original@example.test", "folder", args.save, "text", args.raw, args.inline);
  h.batch = (count, raw = false) => api.getMessages(Array.from({ length: count }, (_, i) => ({ messageId: "message-" + i, folderPath: "folder" })), false, "text", raw);
  return h;
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function assertNoEffects(h) {
  assert.equal(h.calls.mime.length, 0);
  assert.equal(h.calls.parts.length, 0);
  assert.equal(h.calls.files.length, 0);
  assert.equal(h.calls.dirs, 0);
  assert.equal(h.calls.displayed, 0);
  assert.equal(h.calls.reviews, 0);
  assert.equal(h.calls.sends, 0);
}

function revoke(h, kind) {
  if (kind === "opt-in") h.access.allowed = false;
  if (kind === "tool") for (const name of ["getMessage", "getMessages", "displayMessage", "replyToMessage", "forwardMessage"]) h.access.disabled.add(name);
  if (kind === "account") h.access.account = false;
}

function assertRevoked(result, kind) {
  if (kind === "opt-in") assert.equal(result.encryptedContentWithheld, true);
  else assert.match(result.error, /disabled|access denied/);
  assert.equal(result.rawSource, undefined);
  assert.equal(result.subject === "Original", false);
}

describe("complete raw snapshot gate", () => {
  for (const [state, raw] of [["encrypted", ENCRYPTED], ["unknown", UNKNOWN]]) {
    for (const rawSource of [false, true]) {
      it(`withholds ${state} before native work, rawSource=${rawSource}`, async () => {
        const h = loadRead({ raw, mime: { get contentType() { return assert.fail("No MIME inspection"); } } });
        const result = await h.get({ raw: rawSource, save: true, inline: true });
        assert.equal(result.encryptedContentWithheld, true);
        if (state === "unknown") assert.match(result.body, /could not be determined/);
        else assert.doesNotMatch(result.body, /could not be determined/);
        assert.equal(h.calls.rawOpenAttempts, 1);
        assertNoEffects(h);
      });
    }
  }
  for (const [name, type, body] of [
    ["HTML character references", "text/html", "<pre>&#45;&#45;&#45;&#45;&#45;BEGIN PGP MESSAGE&#45;&#45;&#45;&#45;&#45;</pre>"],
    ["stateful charset escapes", "text/plain; charset=iso-2022-jp", "-----BEGIN P\x1b(BGP MESSAGE-----"],
  ]) {
    it(`withholds ${name} before Gloda, parts, exports or display UI`, async () => {
      const raw = `Content-Type: ${type}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
        Buffer.from(body).toString("base64").split("").join("!");
      const h = loadRead({ raw });
      for (const rawSource of [false, true]) {
        assert.equal((await h.get({ raw: rawSource, save: true, inline: true })).encryptedContentWithheld, true);
        assert.ok((await h.batch(2, rawSource)).messages.every(item => item.encryptedContentWithheld));
      }
      for (const mode of ["3pane", "tab", "window"]) {
        assert.match((await h.api.displayMessage("original@example.test", "folder", mode)).error, /Encrypted messages cannot be displayed/);
      }
      assertNoEffects(h);
    });
  }
  it("never treats the HTML presentation cap as a complete strict classification", async () => {
    const prefix = "<p>" + "ordinary ".repeat(250000) + "</p>";
    const raw = "Content-Type: text/html\r\n\r\n" + prefix +
      "<pre>&#45;&#45;&#45;&#45;&#45;BEGIN PGP MESSAGE&#45;&#45;&#45;&#45;&#45;</pre>";
    // Model the presentation parser returning only the harmless prefix. The
    // production raw gate must stop before relying on that shortened view.
    const DOMParser = class { parseFromString() {
      return { querySelectorAll: () => [], body: { nodeType: 1, tagName: "body",
        childNodes: [{ nodeType: 3, textContent: "ordinary prefix" }] } };
    } };
    const h = loadRead({ raw, DOMParser });
    assert.equal(h.api.classifyRawMessageEncryption(raw, 0, { signedRaw: true }), "unknown");
    assert.equal((await h.get({ save: true, inline: true })).encryptedContentWithheld, true);
    assert.equal((await h.get({ raw: true })).encryptedContentWithheld, true);
    assert.match((await h.api.displayMessage("original@example.test", "folder", "3pane")).error, /Encrypted messages cannot be displayed/);
    assertNoEffects(h);
  });
  for (const raw of [CLEAR, ENCRYPTED, UNKNOWN]) {
    for (const allowed of [false, true]) {
      it(`rawSource never calls Gloda: allowed=${allowed}, type=${raw.slice(14, 42)}`, async () => {
        const h = loadRead({ raw, allowed, mimeError: true });
        const result = await h.get({ raw: true });
        if (allowed || raw === CLEAR) assert.equal(result.rawSource, raw);
        else assert.equal(result.encryptedContentWithheld, true);
        assertNoEffects(h);
      });
    }
  }
  for (const options of [{ raw: "" }, { readError: true }, { noProgress: true }]) {
    it(`reports transport failure separately from unknown classification: ${JSON.stringify(options)}`, async () => {
      const h = loadRead(options);
      const result = await h.get();
      assert.match(result.error, /zero size|Failed to get message/);
      assert.equal(result.encryptedContentWithheld, undefined);
      assertNoEffects(h);
    });
  }
  it("uses the server snapshot for fallback bodies without reading a non-Offline local prefix", async () => {
    const h = loadRead({ serverType: "imap", offline: false, raw: CLEAR + " prefix", fetchChunks: [CLEAR + " complete"], mime: { parts: [] } });
    const result = await h.get();
    assert.equal(result.body, "visible complete");
    assert.equal(h.calls.rawOpenAttempts, 0);
    assert.equal(h.calls.rawFetches.length, 1);
    assert.deepEqual(h.calls.rawFetches[0].slice(2), [null, null, false, "", false]);
  });
  it("uses the read-safety decision for an ordinary unusual signed container", async () => {
    const raw = 'Content-Type: multipart/signed; protocol="application/checksum"; boundary="ordinary boundary"\r\n\r\n' +
      '--ordinary boundary \t\r\nContent-Type: text/plain\r\n\r\nvisible\r\n--ordinary boundary-- \t\r\n';
    const h = loadRead({ raw, mime: { contentType: "multipart/signed",
      headers: { "content-type": ["multipart/signed; protocol=application/checksum"] },
      parts: [{ contentType: "text/plain", body: "visible" }],
    } });
    assert.equal(h.api.classifyRawMessageEncryption(raw, 0, { signedRaw: true }), "unknown");
    assert.equal(h.api.classifyRawMessageReadSafety(raw), "clear");
    assert.equal((await h.get()).body, "visible");
    assert.equal(h.calls.mime.length, 1);
    assert.equal(h.calls.mime[0].examineEncryptedParts, false);
    assert.equal(h.calls.rawOpenAttempts, 1);
  });
  it("reuses the snapshot for CID metadata and attachment recovery", async () => {
    const h = loadRead({ raw: RAW_PARTS, mime: IMAGE_MIME, partBytes: "" });
    const result = await h.get({ inline: true, save: true });
    assert.equal(result.error, undefined);
    assert.equal(result.attachments[0].contentId, "image@example.test");
    assert.equal(result.attachments[0].error, undefined);
    assert.equal(h.calls.rawOpenAttempts, 1);
    assert.equal(h.calls.writes, 1, "wrong-size part recovers from the original snapshot");
  });
  it("S4 ignores a readable non-Offline prefix and refuses the complete protected original", async () => {
    const h = loadRead({ serverType: "imap", offline: false, raw: CLEAR, fetchChunks: [ENCRYPTED] });
    const result = await h.run("replyToMessage");
    assert.match(result.error, /encrypted messages is blocked/);
    assert.equal(h.calls.rawOpenAttempts, 0);
    assert.equal(h.calls.rawFetches.length, 1);
    assertNoEffects(h);
  });
});

describe("shared raw transport bounds", () => {
  for (const serverType of ["none", "pop3", "imap", "owl", "ews"]) {
    for (const extra of [0, 1]) {
      it(`${serverType} local read ${extra ? "over" : "at"} 50 MiB`, async () => {
        const h = loadRead({ serverType, offline: true, raw: "x".repeat(CAP + extra) });
        const result = h.api.readCompleteRawMessage(h.api.findMessage().msgHdr);
        if (extra) await assert.rejects(result, /message too large/);
        else assert.equal((await result).length, CAP);
        assert.equal(h.calls.rawFetches.length, 0);
        assert.equal(h.calls.rawCloses, 1);
      });
    }
  }
  for (const extra of [0, 1]) {
    it(`remote read ${extra ? "over" : "at"} 50 MiB`, async () => {
      const h = loadRead({ uncached: true, raw: "x".repeat(CAP + extra) });
      const result = h.api.readCompleteRawMessage(h.api.findMessage().msgHdr);
      if (extra) await assert.rejects(result, /message too large/);
      else assert.equal((await result).length, CAP);
      assert.equal(h.calls.fetchCancellations.length, extra);
      assert.equal(h.calls.rawOpenAttempts, 0);
    });
  }
  it("retries stale Offline storage using the non-converting service", async () => {
    const h = loadRead({ serverType: "imap", offline: true, readError: true });
    assert.equal((await h.get({ raw: true })).rawSource, CLEAR);
    assert.equal(h.calls.rawCloses, 1);
    assert.equal(h.calls.rawFetches.length, 1);
  });
  for (const uncached of [false, true]) {
    it(`preserves original 8-bit bytes, remote=${uncached}`, async () => {
      const raw = CLEAR + "\xff\xe9\x80";
      const h = loadRead({ raw, uncached, allowed: true });
      assert.equal((await h.get({ raw: true })).rawSource, raw);
    });
  }
  for (const started of [false, true]) {
    it(`cancels timeout ${started ? "after" : "before"} onStart, ignores late callbacks`, async () => {
      const h = loadRead({ uncached: true, deferFetch: true });
      const promise = h.get({ raw: true });
      if (started) h.calls.startFetch();
      h.calls.timers[0].callback.notify();
      assert.match((await promise).error, /deadline exceeded/);
      if (!started) h.calls.startFetch();
      h.calls.deliverRaw(CLEAR);
      h.calls.stopFetch();
      await flush();
      assert.equal(h.calls.fetchCancellations.length, 1);
      assertNoEffects(h);
      assert.ok(h.calls.timers.every(timer => timer.cancelled));
    });
  }
  it("checks the absolute deadline even when timer delivery is delayed", async () => {
    const h = loadRead({ uncached: true, deferFetch: true });
    const promise = h.get();
    h.calls.startFetch();
    h.clock.now += TIME;
    h.calls.deliverRaw(CLEAR);
    h.calls.stopFetch();
    assert.match((await promise).error, /deadline exceeded/);
    assert.equal(h.calls.fetchCancellations.length, 1);
    assertNoEffects(h);
  });
});

describe("whole read deadline and late native callbacks", () => {
  for (const stage of ["mime", "inline", "attachment fetch", "attachment copy"]) {
    it(`settles and cancels a stalled ${stage}`, async () => {
      const h = loadRead({ mime: stage === "inline" ? IMAGE_MIME : ATTACHMENT_MIME,
        deferMime: stage === "mime", deferParts: stage === "inline" || stage === "attachment fetch", deferCopy: stage === "attachment copy" });
      const promise = h.get({ inline: stage === "inline", save: stage.startsWith("attachment") });
      await flush();
      h.clock.now += TIME;
      h.calls.timers[0].callback.notify();
      assert.match((await promise).error, /deadline exceeded/);
      if (stage === "mime") h.calls.deliverMime({ get body() { return assert.fail("Late MIME must not be inspected"); } });
      else if (stage === "attachment copy") h.calls.copies[0].deliver();
      else h.calls.parts[0].deliver();
      await flush();
      if (stage !== "mime") assert.equal(h.calls.parts[0].channel.cancelled, 1);
      if (stage === "attachment copy") assert.equal(h.calls.copies[0].cancelled, 1);
      assert.ok(h.calls.files.every(file => file.removed));
      assert.ok(h.calls.timers.every(timer => timer.cancelled));
    });
  }
  it("does not reset the deadline after raw retrieval or MIME parsing", async () => {
    const h = loadRead({ uncached: true, deferFetch: true, deferMime: true });
    const promise = h.get();
    h.calls.startFetch();
    h.clock.now += 80000;
    h.calls.deliverRaw(CLEAR);
    h.calls.stopFetch();
    await flush();
    h.clock.now += 40000;
    h.calls.deliverMime({ contentType: "text/plain", body: "late" });
    assert.match((await promise).error, /deadline exceeded/);
    assert.equal(h.calls.timers.length, 2, "only request and raw transport timers");
  });
});

describe("message read revocation at asynchronous boundaries", () => {
  for (const kind of ["tool", "account", "opt-in"]) {
    for (const stage of ["raw", "mime", "inline", "inline resume", "attachment fetch", "attachment copy", "attachment resume"]) {
      it(`${kind} revoked during ${stage} prevents disclosure and further work`, async () => {
        const inline = stage.startsWith("inline") || stage === "attachment resume";
        const save = stage.startsWith("attachment");
        const h = loadRead({ raw: ENCRYPTED, allowed: true, mime: inline ? IMAGE_MIME : ATTACHMENT_MIME,
          deferMime: stage === "mime", deferParts: stage === "inline" || stage === "inline resume" || stage === "attachment fetch", deferCopy: stage === "attachment copy" || stage === "attachment resume" });
        const promise = h.get({ inline, save, raw: stage === "raw" });
        if (stage !== "raw") await flush();
        if (stage === "inline resume") h.calls.parts[0].deliver();
        if (stage === "attachment resume") h.calls.copies[0].deliver();
        revoke(h, kind);
        if (stage === "mime") h.calls.deliverMime({ get body() { return assert.fail("Revoked MIME must not be inspected"); } });
        if (stage === "inline" || stage === "attachment fetch") h.calls.parts[0].deliver();
        if (stage === "attachment copy") h.calls.copies[0].deliver();
        assertRevoked(await promise, kind);
        assert.ok(h.calls.files.every(file => file.removed));
        if (stage === "raw") assertNoEffects(h);
        if (stage === "attachment resume") assert.equal(h.calls.parts.length, 1, "no inline fetch after attachment await");
      });
    }
  }
  it("continues a clear snapshot after encrypted opt-in is revoked", async () => {
    const h = loadRead({ allowed: true, deferMime: true });
    const promise = h.get();
    await flush();
    h.access.allowed = false;
    h.calls.deliverMime({ contentType: "text/plain", body: "clear" });
    assert.equal((await promise).body, "clear");
    assert.equal(h.calls.rawOpenAttempts, 1);
  });
});

describe("batch deadline, output budgets, and current permissions", () => {
  it("shares 120 seconds across items and reports timeout plus not-attempted entries", async () => {
    const h = loadRead({ uncached: true, deferFetch: true });
    const promise = h.batch(3, true);
    h.calls.startFetch();
    h.clock.now += 80000;
    h.calls.deliverRaw(CLEAR);
    h.calls.stopFetch();
    await flush();
    assert.equal(h.calls.rawFetches.length, 2);
    assert.equal(h.calls.timers.at(-1).delay, 40000);
    h.calls.startFetch();
    h.clock.now += 40000;
    h.calls.deliverRaw(CLEAR);
    h.calls.stopFetch();
    const result = await promise;
    assert.equal(result.messages[0].rawSource, CLEAR);
    assert.match(result.messages[1].error, /deadline exceeded/);
    assert.equal(result.messages[2].notAttempted, true);
    assert.equal(h.calls.rawFetches.length, 2);
    assert.equal(result.succeeded, 1);
  });
  for (const raw of [false, true]) {
    it(`enforces aggregate ${raw ? "raw" : "structured"} output budget with explicit entries`, async () => {
      const large = "x".repeat(26 * 1024 * 1024);
      const h = loadRead({ raw: raw ? CLEAR + large : CLEAR, mime: { contentType: "text/plain", body: large } });
      const result = await h.batch(2, raw);
      assert.equal(result.messages[0].error, undefined);
      assert.match(result.messages[1].error, /remaining.*output budget/);
      assert.equal(result.messages[1].rawSource, undefined);
      assert.equal(result.succeeded, 1);
    });
  }
  it("stops scheduling after exhausting the raw output budget", async () => {
    const h = loadRead({ raw: CLEAR + "x".repeat(CAP - CLEAR.length) });
    const result = await h.batch(2, true);
    assert.equal(result.messages[0].rawSource.length, CAP);
    assert.equal(result.messages[1].notAttempted, true);
    assert.equal(h.calls.rawOpenAttempts, 1);
  });
  it("checks getMessages permission independently of getMessage", async () => {
    const h = loadRead();
    h.access.disabled.add("getMessage");
    assert.equal((await h.batch(2)).succeeded, 2);
  });
  it("keeps a timeout as a failure when the encrypted opt-in is then revoked", async () => {
    const h = loadRead({ raw: ENCRYPTED, allowed: true, deferMime: true });
    const promise = h.batch(2);
    await flush();
    h.clock.now += TIME;
    h.access.allowed = false;
    h.calls.timers[0].callback.notify();
    const result = await promise;
    assert.match(result.messages[0].error, /deadline exceeded/);
    assert.equal(result.messages[0].encryptedContentWithheld, undefined);
    assert.equal(result.messages[1].notAttempted, true);
    assert.equal(result.failed, 2);
    assert.equal(result.succeeded, 0);
  });
  it("includes row metadata, batch envelope and unattempted entries in the structured output limit", async () => {
    const mime = { contentType: "text/plain", body: "x" };
    const h = loadRead({ mime });
    const baseBytes = Buffer.byteLength(JSON.stringify(await h.get()));
    mime.body = "x".repeat(CAP - baseBytes + 1);
    const result = await h.batch(2);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CAP);
    assert.match(result.messages[0].error, /structured output budget/);
    assert.equal(result.messages[1].notAttempted, true);
    assert.equal(result.failed, 2);
  });
  for (const kind of ["tool", "account", "opt-in"]) {
    it(`rechecks earlier results when ${kind} is revoked during a later item`, async () => {
      const h = loadRead({ raw: ENCRYPTED, allowed: true, uncached: true, deferFetch: true });
      const promise = h.batch(2, true);
      h.calls.startFetch(); h.calls.deliverRaw(ENCRYPTED); h.calls.stopFetch();
      await flush();
      assert.equal(h.calls.rawFetches.length, 2);
      revoke(h, kind);
      h.calls.startFetch(); h.calls.deliverRaw(ENCRYPTED); h.calls.stopFetch();
      const result = await promise;
      for (const item of result.messages) assertRevoked(item, kind);
      assert.equal(h.calls.mime.length, 0);
    });
  }
});

describe("display and automatic draft entrypoints", () => {
  for (const raw of [ENCRYPTED, UNKNOWN]) {
    for (const mode of ["3pane", "tab", "window"]) {
      it(`refuses protected/unknown display before UI, ${mode}, ${raw.slice(14, 30)}`, async () => {
        const h = loadRead({ raw });
        const result = await h.api.displayMessage("original@example.test", "folder", mode);
        assert.match(result.error, /Encrypted messages cannot be displayed/);
        assertNoEffects(h);
      });
    }
  }
  for (const kind of ["tool", "account", "opt-in"]) {
    it(`rechecks ${kind} after display raw retrieval`, async () => {
      const h = loadRead({ raw: ENCRYPTED, allowed: true });
      const promise = h.api.displayMessage("original@example.test", "folder");
      revoke(h, kind);
      assert.match((await promise).error, /disabled|access denied|Encrypted messages cannot be displayed/);
      assertNoEffects(h);
    });
  }
  for (const raw of [ENCRYPTED, UNKNOWN]) {
    for (const allowed of [false, true]) {
      it(`refuses protected/unknown draft regardless of read opt-in=${allowed}, ${raw.slice(14, 30)}`, async () => {
        const h = loadRead({ raw, allowed });
        const result = await h.api.replyToMessage("original@example.test", "folder", "reply", false, false,
          undefined, undefined, undefined, undefined, undefined, false, true);
        assert.match(result.error, /Automatic drafting.*blocked/);
        assert.doesNotMatch(result.error, /enable.*read encrypted/i);
        assertNoEffects(h);
        assert.deepEqual(h.calls.created, { params: 0, fields: 0, compose: 0, sender: 0 });
      });
    }
  }
  it("rechecks saveDraft permission before continuing preflight", async () => {
    const h = loadRead({ deferMime: true });
    const promise = h.api.replyToMessage("original@example.test", "folder", "reply", false, false,
      undefined, undefined, undefined, undefined, undefined, false, true);
    await flush();
    h.access.disabled.add("saveDraft");
    h.calls.deliverMime({ contentType: "text/plain", body: "original" });
    assert.match((await promise).error, /saveDraft tool/);
    assert.equal(h.calls.reviews, 0);
    assert.equal(h.calls.created.params, 0);
  });
});
