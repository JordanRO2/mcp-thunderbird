# Thunderbird header-parser test fixtures

These are unmodified parser modules from the official Thunderbird **153.3.1esr**
Linux x86-64 en-US release. They are test inputs, not extension dependencies.
The shared loader is `test/helpers/thunderbird-header-parser.cjs`; tests read only
the checked-in files and never download modules or use a locally installed
Thunderbird/profile.

## Provenance

Retrieved on 2026-10-21 from Mozilla:

- [Release archive](https://archive.mozilla.org/pub/thunderbird/releases/153.3.1esr/linux-x86_64/en-US/thunderbird-153.3.1esr.tar.xz)
- [Release SHA512SUMS](https://archive.mozilla.org/pub/thunderbird/releases/153.3.1esr/SHA512SUMS)
- `thunderbird/application.ini`: `Version=153.3.1`, `BuildID=20260917204311`,
  `SourceRepository=https://hg.mozilla.org/releases/comm-esr153`,
  `SourceStamp=7bff0142fe10fb8bee82d38a0e65f728cbb0c2cb`.

The downloaded archive was verified against Mozilla's SHA512SUMS entry for
`linux-x86_64/en-US/thunderbird-153.3.1esr.tar.xz`:

```text
SHA-512 80c72b16bb043009a2b88dd753a7db43a575a9e138c57a4097217fbc58f9d5049d97f186f0e17e30cc5cc7e8d3a8c58e08e4e247757c548ae8fe8aa6b682dafe
SHA-256 40ec746c0807aad268d513b8465ea30fcd7a123c7ab444b30dd083baa43a8308
```

The three modules were read from `thunderbird/omni.ja` inside that archive. No
source edits, formatting, or line-ending conversions were applied.

| Checked-in file | Path inside `omni.ja` | SHA-256 |
| --- | --- | --- |
| `jsmime.mjs` | `modules/jsmime/jsmime.mjs` | `147e2437e338387d56e1ee026fb29133597fe4dbf24c10ef0b7ec8f189ff18be` |
| `mimeParser.sys.mjs` | `modules/mimeParser.sys.mjs` | `4db8ee1461a142699c80a795713d4cddf6d490de617b214ddd565b90a9fa41c1` |
| `MimeJSComponents.sys.mjs` | `modules/MimeJSComponents.sys.mjs` | `6c440b004e95c27599be7a4133ada54c55e44201fbe203aa0e817e739d8429ed` |

`jsmime.mjs` was also byte-verified against the [source at the application
SourceStamp](https://hg.mozilla.org/releases/comm-esr153/raw-file/7bff0142fe10fb8bee82d38a0e65f728cbb0c2cb/mailnews/mime/jsmime/jsmime.mjs).

## Licences

- **jsmime.mjs:** MIT, copyright (c) 2013 Joshua Cranmer. `LICENSE-jsmime` is the
  unmodified [upstream licence at the same SourceStamp](https://hg.mozilla.org/releases/comm-esr153/raw-file/7bff0142fe10fb8bee82d38a0e65f728cbb0c2cb/mailnews/mime/jsmime/LICENSE).
  SHA-256: `d7cc10b09e57053b82df0c5533b7c3e28e011746af67e4915353b8f6a2d7cb96`.
- **mimeParser.sys.mjs and MimeJSComponents.sys.mjs:** Mozilla Public License 2.0.
  Their source notices are retained. `MPL-2.0.txt` contains the unmodified
  [Mozilla licence text](https://www.mozilla.org/media/MPL/2.0/index.txt).
  SHA-256: `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04`.

These upstream licences apply to the vendored files independently of this
repository's own licence. Keep their notices and licence files with any copies.

## VM adaptations and limits

The loader compiles these files with `node:vm`, removing only ES module
import/export declarations in memory. It connects the real jsmime, MimeParser,
MimeAddressParser, and MimeConverter implementations in fresh module scopes for
each call. Standard Node `TextDecoder`, `TextEncoder`, `atob`, and `btoa` supply
web-compatible globals; `ChromeUtils.generateQI` returns an identity interface
method. The parser, RFC 2047 decoder, group flattening, quoting and header emitter
are upstream code, including the emitter's real 900-character margin.

The Gecko-only `jsmime.sys.mjs` wrapper is not loaded: it adds charset aliases and
UTF-7 through an XPCOM charset-converter service. Consequently these tests cover
charsets supported by Node's TextDecoder, including the UTF-8 regression fixtures;
they do not prove Gecko charset-alias/UTF-7 handling, XPConnect conversions, or
live Thunderbird header-getter behavior. Stream and structured-header XPCOM APIs
outside the address parser/converter are not stubbed or exposed by this loader.

To update the fixture, select a specific official Mozilla release, verify its
archive checksum, extract the same three files without modifying them, and update
the loader path, provenance, hashes and licence records together. Re-run encoded
punctuation, group, Unicode and emitter-failure regressions before accepting an
update. Do not add runtime network access to the tests.
