"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const apiSource = fs.readFileSync(
  path.resolve(__dirname, "../../extension/mcp_server/api.js"), "utf8"
);
const manifest = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../extension/manifest.json"), "utf8"
));

// Use the marker assertions and VM loading pattern from validation.test.cjs.
function getMarkedApiSnippet(startMarker, endMarker) {
  const start = apiSource.indexOf(startMarker);
  const end = apiSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `api.js marker missing: ${startMarker}`);
  assert.ok(end > start, `api.js marker missing: ${endMarker}`);
  return apiSource.slice(start, end);
}

function getConstantDeclaration(name) {
  const declaration = apiSource.match(new RegExp(`^\\s*const ${name} = [^\\n]+;`, "m"));
  assert.ok(declaration, `api.js constant missing: ${name}`);
  return declaration[0];
}

function loadPrivacyRuntime({
  initial = {}, unreadable = [], legacyAddonManager = false, legacy = false, initialize = true,
  values = new Map(), writeErrors = new Set(), beforeWrite = () => {},
  defaults = new Map(), locked = new Set(), exposeLocks = true,
  policyTransform = code => code, schemaTransform = code => code,
} = {}) {
  const readErrors = new Set();
  const writes = [];
  const calls = [];
  const handlerResults = new Map();
  const addonListeners = new Set();
  const addedListeners = [];
  const removedListeners = [];
  const warnings = [];
  const prefTypes = { PREF_INVALID: 0, PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128 };
  // Reuse the existing memory preference boundary; allow restarts over the same
  // store and failures before individual writes, without touching real profiles.
  function checkWrite(name, value) {
    beforeWrite(name, value);
    if (writeErrors.has(name)) throw new Error("Preference write failed");
  }
  // Searched preference mocks for locks/read-back overrides: none model Gecko's
  // accepted user writes hidden by locked defaults. Keep both stores separate.
  function getEffectiveValue(name) {
    if (readErrors.has(name)) throw new Error("Preference is unreadable");
    return locked.has(name) || !values.has(name) ? defaults.get(name) : values.get(name);
  }
  const prefs = {
    prefIsLocked: exposeLocks ? name => locked.has(name) : undefined,
    getPrefType(name) {
      const value = getEffectiveValue(name);
      if (value === undefined) return prefTypes.PREF_INVALID;
      if (typeof value === "string") return prefTypes.PREF_STRING;
      if (typeof value === "boolean") return prefTypes.PREF_BOOL;
      if (Number.isInteger(value)) return prefTypes.PREF_INT;
      throw new Error("Unsupported preference value");
    },
    getStringPref(name, fallback) {
      const value = getEffectiveValue(name);
      if (typeof value === "string") return value;
      if (arguments.length > 1) return fallback;
      throw new Error("Preference is not a string");
    },
    getBoolPref(name, fallback) {
      const value = getEffectiveValue(name);
      if (typeof value === "boolean") return value;
      if (arguments.length > 1) return fallback;
      throw new Error("Preference is not a boolean");
    },
    getIntPref(name, fallback) {
      const value = getEffectiveValue(name);
      if (Number.isInteger(value)) return value;
      if (arguments.length > 1) return fallback;
      throw new Error("Preference is not an integer");
    },
    setStringPref(name, value) {
      checkWrite(name, value);
      writes.push({ name, value });
      values.set(name, value);
    },
    setBoolPref(name, value) {
      checkWrite(name, value);
      writes.push({ name, value });
      values.set(name, value);
    },
    setIntPref(name, value) {
      checkWrite(name, value);
      writes.push({ name, value });
      values.set(name, value);
    },
    clearUserPref(name) {
      checkWrite(name);
      writes.push({ name });
      values.delete(name);
    },
  };
  const AddonManager = {
    addAddonListener(listener) {
      addedListeners.push(listener);
      addonListeners.add(listener);
    },
    removeAddonListener(listener) {
      removedListeners.push(listener);
      addonListeners.delete(listener);
    },
  };
  const accounts = [
    { key: "account1", incomingServer: { prettyName: "First account", type: "imap" } },
    { key: "account2", incomingServer: { prettyName: "Second account", type: "pop3" } },
  ];
  let httpHandler;
  const sandbox = {
    server: { registerPathHandler(_path, handler) { httpHandler = handler; } },
    authToken: "fixture-token", timingSafeEqual: (a, b) => a === b,
    MAX_REQUEST_BODY: 1024 * 1024, readRequestBody: request => request.body,
    Services: { prefs, uuid: { generateUUID: randomUUID }, scriptloader: { loadSubScript(url, scope) {
      assert.equal(url, "resource://thunderbird-mcp/tool-access.js");
      vm.runInNewContext(policyTransform(fs.readFileSync(path.resolve(__dirname, "../../extension/tool-access.js"), "utf8")), scope);
    } } },
    Ci: { nsIPrefBranch: prefTypes },
    ChromeUtils: {
      importESModule(uri) {
        if (uri === "resource:///modules/MailServices.sys.mjs") {
          return { MailServices: { accounts: { accounts } } };
        }
        assert.equal(uri, "resource://gre/modules/AddonManager.sys.mjs");
        if (legacyAddonManager) throw new Error("ES module unavailable");
        return { AddonManager };
      },
      import(uri) {
        assert.equal(uri, "resource://gre/modules/AddonManager.jsm");
        return { AddonManager };
      },
    },
    console: { warn: (...args) => warnings.push(args), error() {} },
  };
  const prefConstants = [
    "PREF_ALLOWED_ACCOUNTS", "PREF_DISABLED_TOOLS", "PREF_TOOL_ACCESS_STATE", "PREF_TOOL_ACCESS_CUSTOMIZED", "PREF_BLOCK_SKIPREVIEW",
    "PREF_STABLE_AUTH_TOKEN", "PREF_GET_MESSAGES_LIMIT", "PREF_ALLOW_ENCRYPTED_MESSAGES",
    "PREF_ALLOW_ALL_CALENDARS", "PREF_ALLOW_ALL_ADDRESS_BOOKS",
  ];
  const constants = [
    ...prefConstants, "DEFAULT_GET_MESSAGES_LIMIT", "MAX_GET_MESSAGES_LIMIT",
    "UNDISABLEABLE_TOOLS", "GROUP_ORDER", "GROUP_LABELS", "CRUD_ORDER",
  ];
  vm.createContext(sandbox);
  vm.runInContext([
    getMarkedApiSnippet("// BEGIN TOOL ACCESS IMPORT", "// END TOOL ACCESS IMPORT"),
    ...constants.map(getConstantDeclaration),
    getMarkedApiSnippet("// BEGIN CONTACT FIELD CONSTANTS", "// END CONTACT FIELD CONSTANTS"),
    getMarkedApiSnippet("// BEGIN OUTBOUND ATTACHMENT LIMITS", "// END OUTBOUND ATTACHMENT LIMITS"),
    getMarkedApiSnippet("// BEGIN MESSAGE HEADER LIMITS", "// END MESSAGE HEADER LIMITS"),
    getMarkedApiSnippet("function normalizeGetMessagesLimit(", "// BEGIN TOOL SCHEMA BUILDER"),
    getMarkedApiSnippet("// BEGIN PRIVACY PREFERENCE HELPERS", "// END PRIVACY PREFERENCE HELPERS"),
    getMarkedApiSnippet("// BEGIN SERVER ACCESS HELPERS", "// END SERVER ACCESS HELPERS"),
    getMarkedApiSnippet("// BEGIN MCP TEXT SANITIZATION", "// END MCP TEXT SANITIZATION"),
    getMarkedApiSnippet("// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
    getMarkedApiSnippet("// BEGIN BOUNDED REFRESH HELPERS", "// END BOUNDED REFRESH HELPERS"),
    schemaTransform(getMarkedApiSnippet("// BEGIN TOOL SCHEMA BUILDER", "// END TOOL SCHEMA BUILDER")),
    getMarkedApiSnippet("// BEGIN INLINE ATTACHMENT BASE64 HELPERS", "// END INLINE ATTACHMENT BASE64 HELPERS"),
    getMarkedApiSnippet("// BEGIN INLINE IMAGE CONTENT HELPERS", "// END INLINE IMAGE CONTENT HELPERS"),
    getMarkedApiSnippet("// BEGIN TOOL SCHEMA VALIDATOR", "// END TOOL SCHEMA VALIDATOR"),
    getMarkedApiSnippet("// BEGIN TOOL CALL DISPATCH", "// END TOOL CALL DISPATCH"),
    getMarkedApiSnippet("// BEGIN MCP HTTP HANDLER", "// END MCP HTTP HANDLER"),
    "this.options = {",
    getMarkedApiSnippet("// BEGIN OPTIONS ACCESS API", "// END OPTIONS ACCESS API"),
    getMarkedApiSnippet("// BEGIN PRIVACY OPTIONS API", "// END PRIVACY OPTIONS API"),
    "};",
    `this.prefNames = { ${prefConstants.join(", ")} };`,
    "this.tools = buildTools();",
    "this.buildTools = buildTools;",
    "this.getConfiguredGetMessagesLimit = getConfiguredGetMessagesLimit;",
    "this.policy = toolAccess;",
    "this.readAccessListPref = readAccessListPref;",
    "this.isAccountAllowed = isAccountAllowed;",
    "this.isToolEnabled = isToolEnabled;",
    "this.isPrivacyOptInEnabled = isPrivacyOptInEnabled;",
    "this.isAddressBookAccessRestricted = isAddressBookAccessRestricted;",
    "this.callTool = callTool;",
    "this.stripInvisibleCharacters = stripInvisibleCharacters;",
    "this.sanitizeToolResultText = sanitizeToolResultText;",
    "this.registerUninstallListener = function(context) {",
    getMarkedApiSnippet("// BEGIN UNINSTALL LISTENER REGISTRATION", "// END UNINSTALL LISTENER REGISTRATION"),
    "};",
    "this.removeUninstallListener = function() {",
    getMarkedApiSnippet("// BEGIN UNINSTALL LISTENER REMOVAL", "// END UNINSTALL LISTENER REMOVAL"),
    "};",
  ].join("\n"), sandbox);

  for (const [name, value] of Object.entries(initial)) {
    assert.ok(sandbox.prefNames[name], `Unknown preference constant: ${name}`);
    values.set(sandbox.prefNames[name], value);
  }
  for (const name of unreadable) {
    assert.ok(sandbox.prefNames[name], `Unknown preference constant: ${name}`);
    readErrors.add(sandbox.prefNames[name]);
  }
  // Ordinary access/dependency fixtures describe existing choices. Migration
  // cases opt into legacy:true; seed before executing the real initialization.
  if (!legacy && !values.has(sandbox.prefNames.PREF_TOOL_ACCESS_STATE)) {
    const { state } = sandbox.policy.considerTools([], null, sandbox.tools.map(tool => tool.name));
    state.customized = sandbox.readAccessListPref(sandbox.prefNames.PREF_DISABLED_TOOLS).values.length > 0;
    values.set(sandbox.prefNames.PREF_TOOL_ACCESS_STATE, JSON.stringify(state));
  }
  vm.runInContext([
    getConstantDeclaration("ALL_TOOL_NAMES").replace("tools.map", "this.tools.map"),
    initialize
      ? getMarkedApiSnippet("// BEGIN TOOL ACCESS STATE", "// END TOOL ACCESS STATE")
      : getMarkedApiSnippet("// BEGIN TOOL ACCESS STATE", "// END TOOL ACCESS STATE").replace("    ensureToolAccessState();", ""),
    "this.ensureToolAccessState = ensureToolAccessState;",
  ].join("\n"), sandbox);
  for (const tool of sandbox.tools) {
    const handler = tool.name === "sendMail" ? "composeMail" : tool.name;
    sandbox[handler] = (...args) => {
      calls.push({ name: tool.name, args });
      return handlerResults.has(tool.name)
        ? handlerResults.get(tool.name) : { handled: tool.name };
    };
  }
  return {
    ...sandbox, values, defaults, locked, writes, writeErrors, readErrors, calls, handlerResults, addonListeners,
    addedListeners, removedListeners, warnings,
    http(method, params) {
      // Reuse validation.test.cjs's complete production HTTP boundary.
      return new Promise(resolve => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
        let response = "";
        httpHandler({ method: "POST", body,
          getHeader: name => name === "Authorization" ? "Bearer fixture-token" : String(Buffer.byteLength(body)),
        }, {
          processAsync() {}, setStatusLine() {}, setHeader() {},
          write(text) { response += text; }, finish() { resolve(JSON.parse(response)); },
        });
      });
    },
  };
}

module.exports = { loadPrivacyRuntime, manifest, getConstantDeclaration };
