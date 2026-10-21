"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTTPD_PORT = 43123; // Mock only: this helper never opens a socket.
const httpdSource = fs.readFileSync(path.resolve(__dirname, "../../extension/httpd.sys.mjs"), "utf8");

// The Host snippet tests and exploratory httpd probes do not serialize replies
// or preserve body bytes. Load the whole module; fake only XPCOM I/O/scheduling.
function createHttpdHarness({ mode = "loopback" } = {}) {
  const jobs = [];
  const logs = [];
  const requests = [];
  const Cr = { NS_OK: 0, NS_BASE_STREAM_CLOSED: 1, NS_ERROR_UNEXPECTED: 2, NS_BINDING_ABORTED: 3, NS_ERROR_ILLEGAL_VALUE: 4 };
  const Ci = { nsIThread: { DISPATCH_NORMAL: 0 }, nsIAsyncOutputStream: { WAIT_CLOSURE_ONLY: 1 } };
  const thread = { dispatch(event) { jobs.push(() => event.run()); } };

  // A byte-preserving pipe is necessary for both request bodies and the real
  // Response/WriteThroughCopier path. Callbacks must run after writes return.
  function createPipe() {
    const chunks = [];
    let length = 0;
    let offset = 0;
    let ended = false;
    let closed = false;
    let waiter = null;
    function notifyReadable() {
      if (waiter && (length || ended || closed)) {
        const callback = waiter;
        waiter = null;
        jobs.push(() => callback.onInputStreamReady(inputStream));
      }
    }
    const inputStream = {
      QueryInterface() { return this; },
      available() {
        if (closed) throw { result: Cr.NS_BASE_STREAM_CLOSED };
        return length;
      },
      read(count) {
        assert.ok(count <= length, "cannot read beyond available pipe bytes");
        const pieces = [];
        let remaining = count;
        while (remaining) {
          const chunk = chunks[0];
          const take = Math.min(remaining, chunk.length - offset);
          pieces.push(chunk.subarray(offset, offset + take));
          offset += take;
          remaining -= take;
          if (offset === chunk.length) {
            chunks.shift();
            offset = 0;
          }
        }
        length -= count;
        return Buffer.concat(pieces, count);
      },
      asyncWait(callback) { waiter = callback; notifyReadable(); },
      close() { closed = true; notifyReadable(); },
      closeWithStatus() { this.close(); },
    };
    const outputStream = {
      write(data, count) {
        assert.ok(!ended && !closed, "cannot write to a closed pipe");
        const bytes = Buffer.from(data, "latin1").subarray(0, count);
        if (bytes.length) chunks.push(bytes);
        length += bytes.length;
        notifyReadable();
        return bytes.length;
      },
      close() { ended = true; notifyReadable(); },
    };
    return { inputStream, outputStream };
  }

  const factories = {
    "@mozilla.org/pipe;1": createPipe,
    "@mozilla.org/binaryinputstream;1": stream => ({
      available() { return stream.available(); },
      readByteArray(count) { return Array.from(stream.read(count)); },
    }),
    "@mozilla.org/binaryoutputstream;1": stream => ({
      writeByteArray(bytes) { return stream.write(Buffer.from(bytes), bytes.length); },
    }),
    "@mozilla.org/supports-string;1": () => ({ QueryInterface() { return this; } }),
  };
  const sandbox = vm.createContext({
    Cr, Ci, Cc: {}, TextEncoder,
    Components: {
      Constructor(contract) {
        return function (...args) {
          assert.ok(factories[contract], `Unexpected XPCOM constructor: ${contract}`);
          return factories[contract](...args);
        };
      },
      Exception(message, result) { return Object.assign(new Error(message), { result }); },
      isSuccessCode: result => result === Cr.NS_OK,
      stack: { caller: null },
    },
    ChromeUtils: { generateQI: () => function () { return this; } },
    Services: {
      tm: { currentThread: thread, mainThread: thread },
      prefs: { getIntPref: () => 6 },
      io: { newURI() { throw new Error("URI service not configured for this test"); }, allowPort: () => true },
    },
    console: { error(...args) { logs.push(args); } },
    dump() {},
  });
  vm.runInContext(httpdSource.replace(/^export /gm, ""), sandbox, { filename: "httpd.sys.mjs" });

  const server = new sandbox.nsHttpServer();
  const host = mode === "listenAll" ? "0.0.0.0" : "localhost";
  const socket = { port: HTTPD_PORT, closed: false, close() { this.closed = true; } };
  // Match _start() after binding, without any native socket or profile access.
  server._port = HTTPD_PORT;
  server._host = host;
  server._socketClosed = false;
  server._socket = socket;
  server._identity._initialize(HTTPD_PORT, host, true);
  server.registerPathHandler("/", (req, res) => {
    requests.push(req);
    res.setStatusLine("1.1", 200, "OK");
    res.write("ok");
  });

  // An explicit queue keeps native asyncWait ordering without timers or sockets.
  function drain() {
    let count = 0;
    while (jobs.length) {
      assert.ok(++count < 100000, "fake I/O failed to quiesce");
      jobs.shift()();
    }
  }

  function openRequest() {
    assert.equal(socket.closed, false, "listener was closed");
    assert.equal(server._socket, socket, "listener was stopped");
    const pipe = createPipe();
    const input = pipe.inputStream;
    const output = {
      chunks: [], closed: false,
      write(data, count) { this.chunks.push(data.slice(0, count)); return count; },
      asyncWait(callback, flags) {
        if (callback && flags !== Ci.nsIAsyncOutputStream.WAIT_CLOSURE_ONLY) {
          jobs.push(() => callback.onOutputStreamReady(this));
        }
      },
      close() { this.closed = true; },
    };
    const number = ++server._connectionGen;
    const connection = new sandbox.Connection(input, output, server, HTTPD_PORT, 50000, number, {});
    server._connections[number] = connection;
    const reader = new sandbox.RequestReader(connection);
    const errors = [];
    const handleError = reader._handleError;
    reader._handleError = function (error) { errors.push(error); return handleError.call(this, error); };
    let peakBuffered = 0;
    const data = reader._data;
    const appendBytes = data.appendBytes;
    data.appendBytes = function (bytes) {
      appendBytes.call(this, bytes);
      peakBuffered = Math.max(peakBuffered, this._data.length);
    };
    input.asyncWait(reader, 0, 0, thread);
    return {
      reader, connection, input, output, errors,
      get wire() { return output.chunks.join(""); },
      get peakBuffered() { return peakBuffered; },
      feed(bytes) {
        if (!connection._closed) {
          pipe.outputStream.write(bytes, Buffer.byteLength(bytes, "latin1"));
          drain();
        }
      },
    };
  }

  function request(chunks) {
    const exchange = openRequest();
    for (const chunk of typeof chunks === "string" || Buffer.isBuffer(chunks) ? [chunks] : chunks) exchange.feed(chunk);
    return exchange;
  }

  return { sandbox, server, socket, logs, requests, drain, openRequest, request };
}

// Reuse validation.test.cjs's marker pattern, without loading its attachment and
// tool suites. The exercised resources/list path needs only auth and body I/O.
function installMcpHandler(harness, authToken) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");
  function snippet(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `Missing api.js snippet: ${startMarker}`);
    return source.slice(start, end);
  }
  Object.assign(harness.sandbox, {
    server: harness.server, authToken,
    NetUtil: { readInputStreamToString: (stream, count) => stream.read(count).toString("utf8") },
  });
  vm.runInContext([
    source.match(/^const MAX_REQUEST_BODY = .*$/m)[0],
    snippet("function readRequestBody(", "// BEGIN SEARCH RESULT HELPERS"),
    snippet("function timingSafeEqual(", "// BEGIN SERVER ACCESS HELPERS"),
    snippet("// BEGIN MCP HTTP HANDLER", "// END MCP HTTP HANDLER"),
  ].join("\n"), harness.sandbox, { filename: "api-http-handler.js" });
}

module.exports = { HTTPD_PORT, createHttpdHarness, installMcpHandler };
