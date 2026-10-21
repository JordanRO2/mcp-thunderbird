"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");
const attachmentSnippets = [
  "INLINE ATTACHMENT BASE64 HELPERS",
  "OUTBOUND ATTACHMENT LIMITS",
  "SENSITIVE ATTACHMENT PATH HELPERS",
  "THUNDERBIRD PROFILE ROOTS",
  "NATIVE ATTACHMENT CONVERSION",
  "OUTBOUND ATTACHMENT CONVERSION",
].map(name => {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
  return source.slice(start, end);
}).join("\n");

// Searched for reusable production attachment fixtures -> found
// validation.test.cjs makeOutboundMailRuntime and makeMockLocalFile, both
// local to that suite. Reuse their in-memory XPCOM pattern in a small shared
// fixture with real conversion, path policy, base64, and native descriptors.
function makeDirectSendAttachments() {
  const calls = {
    fileAccesses: [],
    directoryAccesses: [],
    directoryCreates: [],
    tempCreates: [],
    writes: [],
    removals: [],
    nativeCreates: 0,
    openStreams: 0,
    tempFiles: new Map(),
  };
  const entries = [
    "/fixture/Documents/report.txt",
    { name: "inline.txt", contentType: "text/plain", base64: "QQ==" },
  ];

  // Searched for instrumented nsIFile doubles -> found validation's
  // makeMockLocalFile and tempFile. Its options are broader than this fixture;
  // retain their methods and count every simulated filesystem operation.
  function file(filePath, directory = false) {
    return {
      path: filePath,
      get leafName() { return this.path.split("/").pop(); },
      clone() { return file(this.path, directory); },
      append(name) { this.path += "/" + name; },
      normalize() { calls.fileAccesses.push(["normalize", this.path]); },
      exists() {
        calls.fileAccesses.push(["exists", this.path]);
        return !this.path.endsWith("/attachments");
      },
      isSymlink() {
        calls.fileAccesses.push(["isSymlink", this.path]);
        return false;
      },
      isFile() {
        calls.fileAccesses.push(["isFile", this.path]);
        return !directory;
      },
      get fileSize() {
        calls.fileAccesses.push(["fileSize", this.path]);
        return calls.tempFiles.get(this.path)?.length ?? 6;
      },
      create(type) {
        assert.equal(type, 1);
        calls.directoryCreates.push(this.path);
      },
      remove() {
        assert.equal(calls.openStreams, 0, "Temporary streams must close before cleanup");
        assert.ok(calls.tempFiles.has(this.path), "Only this call's files may be removed");
        calls.tempFiles.delete(this.path);
        calls.removals.push(this.path);
      },
    };
  }

  const sandbox = {
    _tempAttachFiles: new Set(),
    _tempFileCounter: 0,
    Uint8Array,
    atob: data => Buffer.from(data, "base64").toString("binary"),
    createLocalFile(filePath) {
      calls.fileAccesses.push(["createLocalFile", filePath]);
      return file(filePath);
    },
    Services: {
      appinfo: { OS: "Linux" },
      dirsvc: { get(key) {
        calls.directoryAccesses.push(key);
        if (key === "TmpD") return file("/fixture/tmp", true);
        if (key === "ProfD") return file("/fixture/mail-profile/current", true);
        if (key === "DefProfRt") return file("/fixture/mail-profile", true);
        throw new Error(`Unexpected directory: ${key}`);
      } },
      io: { newFileURI: value => ({ spec: "file://" + value.path }) },
    },
    Ci: { nsIFile: { DIRECTORY_TYPE: 1 } },
    Cc: {
      "@mozilla.org/messengercompose/attachment;1": { createInstance() {
        calls.nativeCreates++;
        return {};
      } },
      "@mozilla.org/network/file-output-stream;1": { createInstance: () => ({
        init(value, flags) {
          assert.ok(flags & 0x80, "Temporary files must be created exclusively");
          this.path = value.path;
          calls.tempCreates.push(value.path);
          calls.tempFiles.set(value.path, new Uint8Array());
          calls.openStreams++;
        },
        close() { calls.openStreams--; },
      }) },
      "@mozilla.org/binaryoutputstream;1": { createInstance: () => ({
        setOutputStream(output) { this.output = output; },
        writeByteArray(bytes, length) {
          assert.equal(length, bytes.length);
          calls.writes.push({ path: this.output.path, length });
          calls.tempFiles.set(this.output.path, Uint8Array.from(bytes));
        },
        close() {},
      }) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(attachmentSnippets, sandbox);
  return {
    entries,
    calls,
    convert: sandbox.filePathsToAttachDescs,
    toNative: sandbox.descsToMsgAttachments,
    materialize: sandbox.materializeAttachmentDescs,
  };
}

// Searched for zero attachment side-effect assertions -> found validation's
// cleanup checks after attempted conversion. Encryption refusals need stricter
// proof that conversion did not access a file or create one in the first place.
function assertNoAttachmentEffects(calls) {
  for (const name of ["fileAccesses", "directoryAccesses", "directoryCreates", "tempCreates", "writes", "removals"]) {
    assert.deepEqual(calls[name], [], `Encryption refusal must not perform attachment ${name}`);
  }
  assert.equal(calls.nativeCreates, 0, "Encryption refusal must not create a native attachment");
  assert.equal(calls.openStreams, 0);
  assert.equal(calls.tempFiles.size, 0);
}

module.exports = { makeDirectSendAttachments, assertNoAttachmentEffects };
