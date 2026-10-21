"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const prefTypes = { PREF_INVALID: 0, PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128 };

// Searched for shared typed preference fixtures -> found local mocks in
// privacy-access and calendar-runtime, but neither can be imported on its own.
// Reuse privacy-access's type checks with explicit ordinary-identity defaults.
function makeDirectSendPrefs(overrides = {}) {
  const values = {
    "mail.identity.default.encryptionpolicy": 0,
    "mail.identity.default.openpgp_key_id": "",
    "mail.identity.default.encryption_cert_name": "",
    "mail.e2ee.auto_enable": false,
    ...overrides,
  };
  return {
    getPrefType(name) {
      const value = values[name];
      if (value === undefined) return prefTypes.PREF_INVALID;
      if (typeof value === "string") return prefTypes.PREF_STRING;
      if (typeof value === "boolean") return prefTypes.PREF_BOOL;
      if (typeof value === "number") return prefTypes.PREF_INT;
      throw new Error("Unsupported preference value");
    },
    getIntPref(name) {
      if (typeof values[name] !== "number") throw new Error("Preference is not an integer");
      return values[name];
    },
    getStringPref(name) {
      if (typeof values[name] !== "string") throw new Error("Preference is not a string");
      return values[name];
    },
    getBoolPref(name) {
      if (typeof values[name] !== "boolean") throw new Error("Preference is not a boolean");
      return values[name];
    },
  };
}

// Searched for shared raw-message fixtures -> found only per-suite privacy
// classifiers. Other direct-send harnesses stub MIME quoting, so reuse one
// explicit clear-raw control while privacy-messages runs the real classifiers.
const clearOriginalRawFixture = {
  readBoundedRawMessage: () => "Content-Type: text/plain\r\n\r\nOriginal text",
  classifyRawMessageEncryption: () => "clear",
  isRawTopLevelMultipartSigned: () => false,
};

// Searched for reusable UTF-8/MIME completeness dependencies -> found production
// marker blocks and the shared attachment fixture's isolated VM pattern.
// Export the real dependencies once instead of duplicating counting or parsing
// in the lifecycle harnesses that otherwise stub their original-message quote.
const source = fs.readFileSync(path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8");
const dependencySource = [
  "MESSAGE TEXT CONVERSION", "RAW MIME PARSING HELPERS",
  "RAW MIME ATTACHMENT HELPERS", "ENCRYPTED MESSAGE GUARD",
].map(name => {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
  return source.slice(start, end);
}).join("\n");
const dependencies = vm.runInNewContext(dependencySource + "\n({ RAW_MESSAGE_MAX_BYTES, MAX_HTML_PARSE_BYTES, getMimePartContentTypes, parseRawMimeHeaderValue, truncateHtmlForParsing });");
Object.assign(clearOriginalRawFixture, dependencies);

// Reuse the scheduling harness's native boundary convention. This fixture
// handles only simple harness addresses, not Thunderbird's parsing algorithm.
const composeHeaderParser = {
  parseDecodedHeader(header, preserveGroups) {
    assert.equal(preserveGroups, false);
    return header.split(",").filter(value => value.trim()).map(email => ({ email }));
  },
  removeDuplicateAddresses(header, other) {
    return header.split(",").filter(value => value.trim() && !other.split(",").includes(value)).join(",");
  },
};

module.exports = { makeDirectSendPrefs, prefTypes, clearOriginalRawFixture, composeHeaderParser };
