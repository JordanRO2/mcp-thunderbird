"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");

// Model the ESR 153 default loader: trust the requested scheme, then resolve
// its registered resource substitution. No unsafe option or preference escape.
function createResourceLoader(scripts) {
  const substitutions = new Map();
  const loads = [];
  const protocol = {
    ALLOW_CONTENT_ACCESS: 1,
    QueryInterface() { return this; },
    setSubstitutionWithFlags(name, uri, flags) {
      substitutions.set(name, { uri, flags });
    },
    setSubstitution(name, uri) {
      if (uri === null) substitutions.delete(name);
      else this.setSubstitutionWithFlags(name, uri, 0);
    },
  };
  const scriptloader = {
    loadSubScript(uri, scope) {
      const url = new URL(uri);
      if (!["resource:", "chrome:", "moz-src:"].includes(url.protocol)) {
        throw new Error("Trying to load untrusted URI.: " + uri);
      }
      const substitution = substitutions.get(url.hostname);
      assert.ok(substitution, "resource substitution must precede the script load");
      const resolved = substitution.uri.resolve(url.pathname.slice(1));
      assert.ok(scripts.has(resolved), `Unexpected script: ${resolved}`);
      loads.push({ uri, resolved, flags: substitution.flags });
      vm.runInNewContext(scripts.get(resolved), scope, { filename: uri });
    },
  };
  return { protocol, scriptloader, substitutions, loads };
}

module.exports = { createResourceLoader };
