"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");

// Searched validation/privacy-access/calendar-runtime: all use local marker
// loaders. Share the real schema builder for bridge routing and payload probes.
function loadToolSchema(transform = text => text) {
  const code = transform(source);
  const snippets = ["OUTBOUND ATTACHMENT LIMITS", "CONTACT FIELD CONSTANTS",
    "FILTER SEARCH TERM HELPERS", "BOUNDED REFRESH HELPERS", "TOOL SCHEMA BUILDER"];
  const runtime = { getConfiguredGetMessagesLimit: () => 10 };
  vm.createContext(runtime);
  vm.runInContext(snippets.map(name => {
    const start = code.indexOf(`// BEGIN ${name}`);
    const end = code.indexOf(`// END ${name}`, start);
    assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
    return code.slice(start, end);
  }).join("\n"), runtime);
  return runtime;
}

module.exports = { loadToolSchema };
