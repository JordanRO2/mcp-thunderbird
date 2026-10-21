"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { TextDecoder, TextEncoder } = require("node:util");
const { atob, btoa } = require("node:buffer");

const VENDOR_DIR = path.resolve(__dirname, "../vendor/thunderbird/153.3.1esr");

// Keep upstream bytes untouched on disk. Node 18's VM module loader requires an
// experimental flag, so adapt only the static import/export declarations here.
// Each script runs in its own module scope, with imports supplied as globals.
function compileModule(filename, exports) {
  const source = fs.readFileSync(path.join(VENDOR_DIR, filename), "utf8")
    .replace(/^import \{ (?:jsmime|MimeParser) \} from "resource:\/\/\/modules\/(?:jsmime|mimeParser)\.sys\.mjs";\n/gm, "")
    .replace(/^export (?=(?:const|var|function) )/gm, "");
  return new vm.Script(`"use strict";\n${source}\n({ ${exports.join(", ")} });`, { filename });
}

const jsmimeModule = compileModule("jsmime.mjs", ["jsmime"]);
const mimeParserModule = compileModule("mimeParser.sys.mjs", ["MimeParser"]);
const componentsModule = compileModule("MimeJSComponents.sys.mjs", ["MimeAddressParser", "MimeConverter"]);

// Search/recent/header tests can wrap these fresh service instances for call
// counts or fault injection without changing another test's parser prototypes.
// Parsing, RFC 2047 decoding, mailbox flattening and emission remain upstream.
function loadThunderbirdHeaderParser() {
  const globals = {
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    ChromeUtils: { generateQI: () => function () { return this; } },
  };
  const { jsmime } = jsmimeModule.runInNewContext({ ...globals });
  const { MimeParser } = mimeParserModule.runInNewContext({ ...globals, jsmime });
  const { MimeAddressParser, MimeConverter } = componentsModule.runInNewContext({ ...globals, jsmime, MimeParser });
  return {
    headerParser: new MimeAddressParser(),
    mimeConverter: new MimeConverter(),
  };
}

module.exports = { loadThunderbirdHeaderParser };
