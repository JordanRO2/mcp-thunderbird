"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { createHttpdHarness } = require("./helpers/httpd.cjs");
const { createResourceLoader } = require("./helpers/resource-loader.cjs");

describe("httpd server-side scripts with trusted URIs", () => {
  for (const fails of [false, true]) {
    it(`releases its private resource mapping after ${fails ? "a script load error" : "a successful load"}`, () => {
      let closed = 0;
      const { sandbox, server } = createHttpdHarness({
        xpcomFactories: {
          "@mozilla.org/network/file-input-stream;1": () => ({ close() { closed++; } }),
        },
      });
      const file = {
        path: "/mock-scripts/server #%.sjs",
        leafName: "server #%.sjs",
        parent: { path: "/mock-scripts", isDirectory: () => true },
        isDirectory: () => false,
      };
      function newFileURI(value) {
        const spec = pathToFileURL(value.path + (value.isDirectory() ? "/" : "")).href;
        return { spec, resolve: relative => new URL(relative, spec).href };
      }
      const script = fails ? "throw new Error('script failure');" :
        "function handleRequest(request, response) { response.write('loaded'); }";
      const resources = createResourceLoader(new Map([[newFileURI(file).spec, script]]));
      sandbox.Services.scriptloader = resources.scriptloader;
      sandbox.Services.uuid = { generateUUID: () => `{${randomUUID()}}` };
      sandbox.Services.io.newFileURI = newFileURI;
      sandbox.Services.io.getProtocolHandler = name => {
        assert.equal(name, "resource");
        return resources.protocol;
      };
      sandbox.Ci.nsIFileInputStream = { CLOSE_ON_EOF: 1 };
      sandbox.Cu = {
        getGlobalForObject: () => sandbox,
        Sandbox: () => ({ importFunction(fn, name = fn.name) { this[name] = fn; } }),
      };
      server.registerContentType("sjs", "sjs");
      const output = [];
      const load = () => server._handler._writeFileResponse({ path: "/example.sjs" }, file,
        { write: value => output.push(value) }, 0, 0);
      if (fails) assert.throws(load, error => error.code === 500);
      else {
        load();
        assert.deepEqual(output, ["loaded"]);
      }
      assert.equal(resources.loads.length, 1);
      assert.match(resources.loads[0].uri, /^resource:\/\//);
      assert.equal(resources.loads[0].resolved, newFileURI(file).spec);
      assert.equal(resources.loads[0].flags, 0, "SJS files are not exposed to content");
      assert.equal(resources.substitutions.size, 0);
      assert.equal(closed, 1);
    });
  }
});
