"use strict";

/**
 * infrastructure/compose_adapter.js — the ONLY place the compose domain touches
 * XPCOM: MailServices, nsIMsgCompose / nsIMsgComposeParams / nsIMsgCompFields,
 * nsIMsgSend (headless send), the compose-window observer/state-listener flow,
 * nsIMsgAttachment building, base64-decode + temp-file writes for inline
 * attachments, template-directory file I/O, identity lookup, and the DOM
 * (DOMParser / editor) work that mutates a live compose window.
 *
 * Pure record/string shaping is delegated to domain/entities/compose.js
 * (ctx.composeEntity). The application service (application/compose_service.js)
 * calls these adapter methods and never sees a raw compose window or nsIFile.
 *
 * Behavior is preserved verbatim from the original domain/compose.js: every
 * function body is copied byte-for-byte (original indentation preserved) so
 * runtime behavior is identical.
 *
 * SHUTDOWN STATE: the three shutdown-tracked state objects (_attachTimers,
 * _tempAttachFiles, _claimedComposeWindows) are consumed from ctx BY REFERENCE
 * — they are owned/created by api.js's file scope and drained by its onShutdown
 * cleanup, so we must read the SAME object instances off ctx, never re-create
 * them. _tempFileCounter stays module-local here (it was a file-scope
 * `let _tempFileCounter = 0` in the monolith and is only read/incremented when
 * writing inline-attachment temp files), matching the original semantics: it
 * persists for the life of the loaded module since register runs once at start.
 *
 * Consumes from ctx:
 *   Cc, Ci, Services, MailServices, AUDIT_LOG_SUBDIR,
 *   isAccountAllowed, getAccessibleAccounts,
 *   isSensitiveFilePath, composeEntity,
 *   _attachTimers, _tempAttachFiles, _claimedComposeWindows
 *   (ChromeUtils / Components / DOMParser / atob are ambient subscript globals,
 *    used exactly as in the monolith — not destructured from ctx.)
 * Registers onto ctx:
 *   composeAdapter = { templatesDir, readTextFile, loadTemplate,
 *     listTemplateFiles, findIdentityIn, findIdentity, createLocalFile,
 *     filePathsToAttachDescs, descsToMsgAttachments, addAttachmentsToComposeWindow,
 *     injectAttachmentsAsync, getReplyAllCcRecipients,
 *     applyComposeRecipientOverrides, formatBodyFragmentHtml,
 *     moveComposeSelectionToBodyStartIfRange, insertReplyBodyIntoComposeWindow,
 *     openComposeWindowWithCustomizations, markMessageDispositionState,
 *     sendMessageDirectly, resolveComposeFormat, setComposeIdentity,
 *     MAX_BASE64_SIZE, MAX_FILE_PATH_ATTACHMENT_BYTES }
 */
module.exports = function register(ctx) {
  const {
    Cc, Ci, Services, MailServices, AUDIT_LOG_SUBDIR,
    isAccountAllowed, getAccessibleAccounts,
    isSensitiveFilePath, composeEntity,
    _attachTimers, _tempAttachFiles, _claimedComposeWindows,
  } = ctx;

  // Pure helpers shaped in the entity layer; pulled into bare names so the
  // copied-verbatim bodies below keep calling them exactly as in the monolith.
  const {
    escapeHtml, formatBodyHtml, splitAddressHeader, extractAddressEmail,
    mergeAddressHeaders, getIdentityAutoRecipientHeader,
  } = composeEntity;

  // ── Compose-related constants (used only by the compose/template tools). ──
  const MAX_BASE64_SIZE = 25 * 1024 * 1024; // 25 MB limit for inline base64 data (encoded)
  const MAX_FILE_PATH_ATTACHMENT_BYTES = 50 * 1024 * 1024;
  const COMPOSE_WINDOW_LOAD_DELAY_MS = 1500;
  const TEMPLATES_SUBDIR = "templates";
  // Monotonic counter for temp inline-attachment filenames. Persists for the
  // life of the loaded module (register runs once at server start), matching
  // the original file-scope `let _tempFileCounter = 0` semantics.
  let _tempFileCounter = 0;

            function templatesDir() {
              const profDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
              const auditDir = profDir.clone();
              auditDir.append(AUDIT_LOG_SUBDIR);
              auditDir.append(TEMPLATES_SUBDIR);
              return auditDir;
            }

            function readTextFile(file) {
              const fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
              fis.init(file, 0x01, 0, 0);
              const cis = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
              cis.init(fis, "UTF-8", 0, 0);
              let text = "";
              const buf = {};
              while (cis.readString(65536, buf) > 0) text += buf.value;
              cis.close();
              return text;
            }

            function loadTemplate(name) {
              if (typeof name !== "string" || !name) return { error: "name must be a non-empty string" };
              if (!/^[A-Za-z0-9._-]+$/.test(name)) {
                return { error: "name must match /^[A-Za-z0-9._-]+$/ (no path separators)" };
              }
              const dir = templatesDir();
              if (!dir.exists()) {
                return { error: `Templates directory not found: ${dir.path}. Create it and add <name>.md files.` };
              }
              // Try <name>.md and <name> with no extension.
              for (const candidate of [name + ".md", name]) {
                const f = dir.clone();
                f.append(candidate);
                if (f.exists() && f.isFile()) {
                  try {
                    const raw = readTextFile(f);
                    const parsed = composeEntity.parseFrontmatter(raw);
                    parsed.file = f.path;
                    return parsed;
                  } catch (e) {
                    return { error: `Failed to read template '${name}': ${e}` };
                  }
                }
              }
              return { error: `Template not found: ${name}` };
            }

            /**
             * Enumerate the templates directory and parse each *.md file's
             * frontmatter into a listing record. Returns the same envelope the
             * original listTemplates tool returned: { templates } on success,
             * { templates, note } when the directory is missing, or { error }
             * when enumeration fails. Behavior is byte-for-byte identical to the
             * monolith's listTemplates -- the service just forwards it.
             */
            function listTemplateFiles() {
              const dir = templatesDir();
              if (!dir.exists()) {
                return { templates: [], note: `Templates directory does not exist yet. Create ${dir.path} and drop *.md files inside.` };
              }
              const out = [];
              let entries;
              try {
                entries = dir.directoryEntries;
              } catch (e) {
                return { error: `Failed to list templates: ${e}` };
              }
              while (entries.hasMoreElements()) {
                const f = entries.getNext().QueryInterface(Ci.nsIFile);
                if (!f.isFile()) continue;
                if (!/\.md$/i.test(f.leafName)) continue;
                try {
                  const raw = readTextFile(f);
                  const { meta } = composeEntity.parseFrontmatter(raw);
                  out.push({
                    name: typeof meta.name === "string" && meta.name ? meta.name : f.leafName.replace(/\.md$/i, ""),
                    description: typeof meta.description === "string" ? meta.description : "",
                    subject: typeof meta.subject === "string" ? meta.subject : "",
                    isHtml: !!meta.isHtml,
                    vars: Array.isArray(meta.vars) ? meta.vars : [],
                    file: f.path,
                  });
                } catch { /* skip unreadable templates */ }
              }
              return { templates: out };
            }

            /**
             * Searches the given accounts for an identity matching emailOrId
             * (by key or case-insensitive email).
             * Returns the identity object, or null if not found.
             */
            function findIdentityIn(accounts, emailOrId) {
              if (!emailOrId) return null;
              const lowerInput = emailOrId.toLowerCase();
              for (const account of accounts) {
                for (const identity of account.identities) {
                  if (identity.key === emailOrId || (identity.email || "").toLowerCase() === lowerInput) {
                    return identity;
                  }
                }
              }
              return null;
            }

            /**
             * Finds an identity by email address or identity ID
             * among accessible accounts only.  Returns null if not found.
             */
            function findIdentity(emailOrId) {
              return findIdentityIn(getAccessibleAccounts(), emailOrId);
            }

            /** Creates an nsIFile instance for the given path. */
            function createLocalFile(path) {
              const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
              file.initWithPath(path);
              return file;
            }

            /**
             * Converts attachment entries to attachment descriptors.
             * Each entry can be:
             *   - A string (file path) — resolved from disk
             *   - An object { name, contentType, base64 } — decoded and written
             *     to a temp file under <TmpD>/thunderbird-mcp/attachments/
             * Returns { descs: [{url, name, size, contentType?}], failed: string[] }
             */
            function filePathsToAttachDescs(filePaths) {
              const descs = [];
              const failed = [];
              if (!filePaths || !Array.isArray(filePaths)) return { descs, failed };
              for (const entry of filePaths) {
                try {
                  if (typeof entry === "string") {
                    // File path attachment.
                    //
                    // SECURITY: reject paths that point at credentials, system
                    // files, or browser/mail profile data BEFORE touching the
                    // filesystem. This is the LLM-confused-deputy defense:
                    // attacker-controlled email content can prompt-inject an
                    // assistant into calling sendMail with attachments=["/path/to/id_rsa"]
                    // and we never want that to succeed regardless of skipReview.
                    if (isSensitiveFilePath(entry)) {
                      failed.push(`${entry} (sensitive path blocked)`);
                      continue;
                    }
                    const file = createLocalFile(entry);
                    if (!file.exists()) {
                      failed.push(entry);
                      continue;
                    }
                    // SECURITY: re-check the *resolved* path. The raw string can
                    // look benign while pointing at a credential store through a
                    // symlink (e.g. /tmp/report.pdf -> ~/.ssh/id_rsa). Canonicalize
                    // (resolves symlinks + . / .. components) and re-run the
                    // deny-list before reading the file.
                    try { file.normalize(); } catch (_) { /* keep raw path if normalize fails */ }
                    if (isSensitiveFilePath(file.path)) {
                      failed.push(`${entry} (sensitive path blocked)`);
                      continue;
                    }
                    // Size cap mirrors the saved-attachment ceiling and avoids
                    // ballooning outgoing messages when a caller points at a huge file.
                    let fileSize = 0;
                    try { fileSize = file.fileSize; } catch { fileSize = 0; }
                    if (fileSize > MAX_FILE_PATH_ATTACHMENT_BYTES) {
                      failed.push(`${entry} (exceeds ${MAX_FILE_PATH_ATTACHMENT_BYTES / 1024 / 1024}MB size limit)`);
                      continue;
                    }
                    descs.push({ url: Services.io.newFileURI(file).spec, name: file.leafName, size: fileSize });
                  } else if (entry && typeof entry === "object" && (entry.base64 || entry.content) && entry.name) {
                    // Inline base64 attachment — decode and write to temp file
                    const b64Data = entry.base64 || entry.content;
                    if (b64Data.length > MAX_BASE64_SIZE) {
                      failed.push(`${entry.name} (exceeds ${MAX_BASE64_SIZE / 1024 / 1024}MB size limit)`);
                      continue;
                    }
                    // Decode base64 to binary bytes
                    let bytes;
                    try {
                      // Use the global atob when available, otherwise fall back
                      const raw = typeof atob === "function" ? atob(b64Data) : ChromeUtils.base64Decode(b64Data);
                      bytes = new Uint8Array(raw.length);
                      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                    } catch {
                      // Fallback: manual base64 decode (atob may not be available in XPCOM context)
                      try {
                        const lookup = new Uint8Array(256);
                        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                        for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
                        const clean = b64Data.replace(/[^A-Za-z0-9+/]/g, "");
                        const len = clean.length;
                        const outLen = (len * 3) >> 2;
                        bytes = new Uint8Array(outLen);
                        let p = 0;
                        for (let i = 0; i < len; i += 4) {
                          const a = lookup[clean.charCodeAt(i)];
                          const b = lookup[clean.charCodeAt(i + 1)];
                          const c = lookup[clean.charCodeAt(i + 2)];
                          const d = lookup[clean.charCodeAt(i + 3)];
                          bytes[p++] = (a << 2) | (b >> 4);
                          if (i + 2 < len) bytes[p++] = ((b & 15) << 4) | (c >> 2);
                          if (i + 3 < len) bytes[p++] = ((c & 3) << 6) | d;
                        }
                        bytes = bytes.subarray(0, p);
                      } catch {
                        failed.push(`${entry.name} (invalid base64 data)`);
                        continue;
                      }
                    }
                    const tmpDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
                    tmpDir.append("thunderbird-mcp");
                    tmpDir.append("attachments");
                    if (!tmpDir.exists()) {
                      tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
                    }
                    const tmpFile = tmpDir.clone();
                    let safeName = (entry.name || entry.filename || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
                    if (!safeName || safeName === "." || safeName === "..") safeName = "attachment";
                    tmpFile.append(`${Date.now()}_${++_tempFileCounter}_${safeName}`);
                    // Write via XPCOM binary stream
                    const ostream = Cc["@mozilla.org/network/file-output-stream;1"]
                      .createInstance(Ci.nsIFileOutputStream);
                    ostream.init(tmpFile, 0x02 | 0x08 | 0x20, 0o600, 0);
                    const bstream = Cc["@mozilla.org/binaryoutputstream;1"]
                      .createInstance(Ci.nsIBinaryOutputStream);
                    bstream.setOutputStream(ostream);
                    bstream.writeByteArray(bytes, bytes.length);
                    bstream.close();
                    ostream.close();
                    _tempAttachFiles.add(tmpFile.path);
                    const desc = { url: Services.io.newFileURI(tmpFile).spec, name: entry.name || entry.filename, size: tmpFile.fileSize };
                    if (entry.contentType) desc.contentType = entry.contentType;
                    descs.push(desc);
                  } else {
                    failed.push(typeof entry === "object" ? JSON.stringify(entry) : String(entry));
                  }
                } catch (e) {
                  failed.push(typeof entry === "object" ? (entry.name || JSON.stringify(entry)) : String(entry));
                }
              }
              return { descs, failed };
            }

            /**
             * Injects attachment descriptors into the most recently opened compose window.
             * Uses nsITimer so the window has time to finish loading before injection.
             * Each call gets its own timer stored in _attachTimers to prevent GC.
             *
             * Known limitation: uses getMostRecentWindow("msgcompose") which is a race
             * if two compose operations happen within COMPOSE_WINDOW_LOAD_DELAY_MS --
             * attachments from the first may land on the second window.
             * OpenComposeWindowWithParams doesn't return a window handle, so there's
             * no reliable way to target a specific window. Injection failures are
             * silent (callers report success based on pre-validated descriptor counts).
             */
            /**
             * Converts attachment descriptors to nsIMsgAttachment objects.
             * Shared by injectAttachmentsAsync (compose window) and
             * sendMessageDirectly (headless send).
             */
            function descsToMsgAttachments(attachDescs) {
              const result = [];
              for (const desc of attachDescs) {
                try {
                  const att = Cc["@mozilla.org/messengercompose/attachment;1"]
                    .createInstance(Ci.nsIMsgAttachment);
                  att.url = desc.url;
                  att.name = desc.name;
                  if (desc.size != null) att.size = desc.size;
                  if (desc.contentType) att.contentType = desc.contentType;
                  result.push(att);
                } catch (e) {
                  console.warn("thunderbird-mcp: failed to convert attachment descriptor:", desc?.name || desc?.url || desc, e);
                }
              }
              return result;
            }

            function addAttachmentsToComposeWindow(composeWin, attachDescs) {
              if (!composeWin) {
                console.warn("thunderbird-mcp: skipping attachment add — no compose window");
                return;
              }
              if (typeof composeWin.AddAttachments !== "function") {
                console.warn("thunderbird-mcp: skipping attachment add — composeWin.AddAttachments not a function");
                return;
              }
              const attachList = descsToMsgAttachments(attachDescs);
              if (attachList.length > 0) {
                // Caller's try/catch (or fire-and-forget caller) is responsible for
                // surfacing failures — do not swallow here.
                composeWin.AddAttachments(attachList);
              }
            }

            function injectAttachmentsAsync(attachDescs) {
              if (!attachDescs || attachDescs.length === 0) return;
              const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
              _attachTimers.add(timer);
              timer.initWithCallback({
                notify() {
                  _attachTimers.delete(timer);
                  try {
                    const composeWin = Services.wm.getMostRecentWindow("msgcompose");
                    addAttachmentsToComposeWindow(composeWin, attachDescs);
                  } catch (e) {
                    // Fire-and-forget timer — no client to error back to.
                    // Log loudly so users can find the cause in the Error Console
                    // when an "email sent without attachments" report comes in.
                    console.error("thunderbird-mcp: injectAttachmentsAsync failed:", e);
                  }
                }
              }, COMPOSE_WINDOW_LOAD_DELAY_MS, Ci.nsITimer.TYPE_ONE_SHOT);
            }

            function getReplyAllCcRecipients(msgHdr, folder) {
              const ownAccount = MailServices.accounts.findAccountForServer(folder.server);
              const ownEmails = new Set();
              if (ownAccount) {
                for (const identity of ownAccount.identities) {
                  if (identity.email) ownEmails.add(identity.email.toLowerCase());
                }
              }

              const allRecipients = [
                ...splitAddressHeader(msgHdr.recipients),
                ...splitAddressHeader(msgHdr.ccList)
              ]
                .map(r => r.trim())
                .filter(r => r && (ownEmails.size === 0 || !ownEmails.has(extractAddressEmail(r))));

              const seen = new Set();
              const uniqueRecipients = allRecipients.filter(r => {
                const email = extractAddressEmail(r);
                if (seen.has(email)) return false;
                seen.add(email);
                return true;
              });

              return uniqueRecipients.join(", ");
            }

            function applyComposeRecipientOverrides(composeWin, identity, to, cc, bcc) {
              if (!composeWin) return;
              // Build a recipients-only delta. Do NOT pass identityKey here --
              // the compose window already has the identity from
              // msgComposeParams, and including `identityKey: null` is sketchy:
              // modern Thunderbird ignores it (`if (details.identityKey)`
              // short-circuits on null), but a future TB version could
              // interpret it as "clear the identity", which would also wipe
              // the OpenPGP signing/encrypting state that depends on it.
              const overrides = {};
              if (to) overrides.to = to;
              if (cc) overrides.cc = mergeAddressHeaders(getIdentityAutoRecipientHeader(identity, "cc"), cc);
              if (bcc) overrides.bcc = mergeAddressHeaders(getIdentityAutoRecipientHeader(identity, "bcc"), bcc);
              if (Object.keys(overrides).length === 0) return;

              if (typeof composeWin.SetComposeDetails === "function") {
                composeWin.SetComposeDetails(overrides);
                return;
              }

              const fields = composeWin.gMsgCompose?.compFields;
              if (!fields) return;
              if (Object.prototype.hasOwnProperty.call(overrides, "to")) fields.to = overrides.to;
              if (Object.prototype.hasOwnProperty.call(overrides, "cc")) fields.cc = overrides.cc;
              if (Object.prototype.hasOwnProperty.call(overrides, "bcc")) fields.bcc = overrides.bcc;
              if (typeof composeWin.CompFields2Recipients === "function") {
                composeWin.CompFields2Recipients(fields);
              }
            }

            function formatBodyFragmentHtml(body, isHtml) {
              const formatted = formatBodyHtml(body, isHtml);
              if (!isHtml) return formatted;
              if (!formatted) return "";

              const needsParsing = /<(?:html|body|head)\b/i.test(formatted) || /\bmoz-signature\b/i.test(formatted);
              if (!needsParsing) return formatted;

              try {
                const doc = new DOMParser().parseFromString(formatted, "text/html");
                for (const node of doc.querySelectorAll("div.moz-signature, pre.moz-signature")) {
                  node.remove();
                }
                return doc.body ? doc.body.innerHTML : formatted;
              } catch {
                return formatted;
              }
            }

            function moveComposeSelectionToBodyStartIfRange(composeWin) {
              const browser = typeof composeWin?.getBrowser === "function" ? composeWin.getBrowser() : null;
              const editorDoc = browser?.contentDocument;
              const root = editorDoc?.body;
              const selection = typeof editorDoc?.getSelection === "function" ? editorDoc.getSelection() : null;
              let shouldMove = false;
              let moveError = null;

              if (selection) {
                if (selection.isCollapsed) return true;
                shouldMove = true;
              }

              if (shouldMove && root && typeof editorDoc.createRange === "function") {
                try {
                  const range = editorDoc.createRange();
                  range.setStart(root, 0);
                  range.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(range);
                  return true;
                } catch (e) {
                  moveError = e;
                }
              }

              const editor = typeof composeWin?.GetCurrentEditor === "function" ? composeWin.GetCurrentEditor() : null;
              let editorSelection = null;
              if (!selection && editor) {
                try {
                  editorSelection = editor.selection || null;
                } catch (e) {
                  moveError = e;
                }
              }

              if (!selection && editorSelection) {
                try {
                  if (editorSelection.isCollapsed) return true;
                  shouldMove = true;
                } catch (e) {
                  moveError = e;
                }
              }

              if (!selection && !editorSelection) {
                // Legacy editor-only path does not expose a reliable DOM
                // selection, so anchor defensively before insertHTML.
                shouldMove = true;
              }

              if (shouldMove && editor && typeof editor.beginningOfDocument === "function") {
                try {
                  editor.beginningOfDocument();
                  return true;
                } catch (e) {
                  moveError = e;
                }
              }

              if (shouldMove) {
                console.warn("thunderbird-mcp: could not anchor compose body insertion; insertHTML may replace selected quote", moveError);
              }
              return !shouldMove;
            }

            function insertReplyBodyIntoComposeWindow(composeWin, body, isHtml) {
              if (!composeWin || !body) return;
              const fragment = formatBodyFragmentHtml(body, isHtml);
              if (!fragment) return;

              const browser = typeof composeWin.getBrowser === "function" ? composeWin.getBrowser() : null;
              const editorDoc = browser?.contentDocument;
              if (editorDoc && typeof editorDoc.execCommand === "function") {
                // Body-ready can leave the original quote selected. insertHTML
                // replaces active ranges, so anchor only when TB selected text.
                moveComposeSelectionToBodyStartIfRange(composeWin);
                editorDoc.execCommand("insertHTML", false, fragment);
              } else {
                const editor = typeof composeWin.GetCurrentEditor === "function" ? composeWin.GetCurrentEditor() : null;
                if (editor && typeof editor.insertHTML === "function") {
                  moveComposeSelectionToBodyStartIfRange(composeWin);
                  editor.insertHTML(fragment);
                }
              }

              if (composeWin.gMsgCompose) {
                composeWin.gMsgCompose.bodyModified = true;
              }
              if ("gContentChanged" in composeWin) {
                composeWin.gContentChanged = true;
              }
            }

            function shouldUseDirectComposeOpen(compType) {
              return compType === Ci.nsIMsgCompType.ForwardInline;
            }

            function openComposeWindowWithCustomizations(msgComposeParams, originalMsgURI, compType, identity, body, isHtml, to, cc, bcc, attachDescs) {
              return new Promise((resolve) => {
                // ForwardInline needs OpenComposeWindow (libmime inline-forward body +
                // attachment population), which streams the original before the window
                // opens -- slow on IMAP / large attachments, so it gets a longer timeout.
                const OPEN_TIMEOUT_MS = shouldUseDirectComposeOpen(compType) ? 60000 : 15000;
                let settled = false;
                let matchedWindow = null;
                let pendingStateListener = null;
                let pendingStateCompose = null;

                const finish = (result) => {
                  if (settled) return;
                  settled = true;
                  try { Services.ww.unregisterNotification(windowObserver); } catch {}
                  try { timeout.cancel(); } catch {}
                  // Unregister any dangling state listener so a late
                  // NotifyComposeBodyReady cannot mutate the compose window
                  // after we have already resolved (e.g. after a timeout).
                  if (pendingStateListener && pendingStateCompose) {
                    try { pendingStateCompose.UnregisterStateListener(pendingStateListener); } catch {}
                  }
                  pendingStateListener = null;
                  pendingStateCompose = null;
                  resolve(result);
                };

                const timeout = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
                timeout.initWithCallback({
                  notify() {
                    finish({ error: "Timed out waiting for compose window" });
                  }
                }, OPEN_TIMEOUT_MS, Ci.nsITimer.TYPE_ONE_SHOT);

                const maybeCustomizeWindow = (composeWin) => {
                  try {
                    if (!composeWin || composeWin === matchedWindow) return;
                    if (composeWin.document?.documentElement?.getAttribute("windowtype") !== "msgcompose") return;
                    if (!composeWin.gMsgCompose) return;
                    if (composeWin.gMsgCompose.originalMsgURI !== originalMsgURI) return;
                    if (composeWin.gComposeType !== compType) return;
                    // When two callers reply to the same message concurrently,
                    // both observers see both compose windows. Skip any window
                    // that has already been claimed by a prior observer so each
                    // call binds to exactly one compose window.
                    if (_claimedComposeWindows.has(composeWin)) return;
                    _claimedComposeWindows.add(composeWin);

                    matchedWindow = composeWin;
                    try { Services.ww.unregisterNotification(windowObserver); } catch {}

                    const stateListener = {
                      QueryInterface: ChromeUtils.generateQI(["nsIMsgComposeStateListener"]),
                      NotifyComposeFieldsReady() {},
                      ComposeProcessDone() {},
                      SaveInFolderDone() {},
                      NotifyComposeBodyReady() {
                        // Guard against a late body-ready firing after the
                        // caller already timed out -- don't mutate the compose
                        // window once the promise is settled.
                        if (settled) {
                          try { composeWin.gMsgCompose.UnregisterStateListener(stateListener); } catch {}
                          return;
                        }

                        try {
                          composeWin.gMsgCompose.UnregisterStateListener(stateListener);
                        } catch {}
                        pendingStateListener = null;
                        pendingStateCompose = null;

                        try {
                          applyComposeRecipientOverrides(composeWin, identity, to, cc, bcc);
                          insertReplyBodyIntoComposeWindow(composeWin, body, isHtml);
                          addAttachmentsToComposeWindow(composeWin, attachDescs);
                          finish({ success: true });
                        } catch (e) {
                          finish({ error: e.toString() });
                        }
                      },
                    };

                    pendingStateListener = stateListener;
                    pendingStateCompose = composeWin.gMsgCompose;
                    composeWin.gMsgCompose.RegisterStateListener(stateListener);
                  } catch (e) {
                    finish({ error: e.toString() });
                  }
                };

                const windowObserver = {
                  observe(subject, topic) {
                    if (topic !== "domwindowopened") return;
                    const composeWin = subject;
                    if (!composeWin || typeof composeWin.addEventListener !== "function") return;

                    // Thunderbird dispatches a non-bubbling compose-window-init event
                    // from MsgComposeCommands.js after gMsgCompose is initialized and
                    // the built-in state listener is registered, but before editor
                    // creation begins. Capturing it on the window lets us register our
                    // own ComposeBodyReady listener for the specific reply window
                    // without relying on getMostRecentWindow("msgcompose").
                    composeWin.addEventListener("compose-window-init", () => {
                      maybeCustomizeWindow(composeWin);
                    }, { once: true, capture: true });
                  },
                };

                try {
                  Services.ww.registerNotification(windowObserver);
                  const msgComposeService = MailServices.compose || Cc["@mozilla.org/messengercompose;1"]
                    .getService(Ci.nsIMsgComposeService);
                  if (shouldUseDirectComposeOpen(compType)) {
                    // Native inline-forward body/attachment population only runs through OpenComposeWindow.
                    msgComposeService.OpenComposeWindow(
                      null,
                      msgComposeParams.origMsgHdr,
                      originalMsgURI,
                      compType,
                      msgComposeParams.format,
                      identity,
                      identity?.email || "",
                      null
                    );
                  } else {
                    msgComposeService.OpenComposeWindowWithParams(null, msgComposeParams);
                  }
                } catch (e) {
                  finish({ error: e.toString() });
                }
              });
            }

            function markMessageDispositionState(msgHdr, dispositionState) {
              try {
                const folder = msgHdr?.folder;
                if (!folder || dispositionState == null) return false;
                if (typeof folder.addMessageDispositionState === "function") {
                  folder.addMessageDispositionState(msgHdr, dispositionState);
                  return true;
                }
                if (typeof folder.AddMessageDispositionState === "function") {
                  folder.AddMessageDispositionState(msgHdr, dispositionState);
                  return true;
                }
              } catch {}
              return false;
            }

            /**
             * Sends a message directly via nsIMsgSend without opening a compose window.
             * Used by composeMail, replyToMessage, forwardMessage when skipReview=true.
             *
             * Handles two createAndSendMessage signatures:
             * - TB 102-127 (C++): 18 args, includes aAttachments + aPreloadedAttachments
             * - TB 128+   (JS):  16 args, attachments via composeFields only
             * Attachments are always added to composeFields (works in both).
             * We try the modern 16-arg call first; if TB throws
             * NS_ERROR_XPC_NOT_ENOUGH_ARGS, fall back to the legacy 18-arg call.
             */
            function sendMessageDirectly(composeFields, identity, attachDescs, originalMsgURI, compType, deliverMode, bodyType) {
              if (!identity) {
                return Promise.resolve({ error: "No identity available for direct send" });
              }

              const mode = deliverMode ?? Ci.nsIMsgCompDeliverMode.Now;
              const bodyMimeType = bodyType || "text/html";
              const SEND_TIMEOUT_MS = 120000; // 2 min safety timeout

              return new Promise((resolve) => {
                let settled = false;
                const settle = (result) => {
                  if (!settled) {
                    settled = true;
                    resolve(result);
                  }
                };

                // Safety timeout -- if neither listener callback nor error fires
                const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
                timer.initWithCallback({
                  notify() { settle({ error: "Send timed out after " + (SEND_TIMEOUT_MS / 1000) + "s" }); }
                }, SEND_TIMEOUT_MS, Ci.nsITimer.TYPE_ONE_SHOT);

                try {
                  const msgSend = Cc["@mozilla.org/messengercompose/send;1"]
                    .createInstance(Ci.nsIMsgSend);

                  // Populate sender fields from identity (normally done by compose window)
                  if (identity.email) {
                    const name = identity.fullName || "";
                    composeFields.from = name
                      ? `"${name}" <${identity.email}>`
                      : identity.email;
                  }
                  if (identity.organization) {
                    composeFields.organization = identity.organization;
                  }

                  // Add attachments to composeFields (works in all TB versions)
                  for (const att of descsToMsgAttachments(attachDescs)) {
                    composeFields.addAttachment(att);
                  }

                  // Extract body -- createAndSendMessage takes it as a separate param
                  const body = composeFields.body || "";

                  // Resolve account key from identity
                  let accountKey = "";
                  try {
                    for (const account of MailServices.accounts.accounts) {
                      for (let i = 0; i < account.identities.length; i++) {
                        if (account.identities[i].key === identity.key) {
                          accountKey = account.key;
                          break;
                        }
                      }
                      if (accountKey) break;
                    }
                  } catch {}

                  // SaveAsDraft mode routes through _mimeDoFcc() which does not
                  // call onStopSending. Completion is signaled via the copy
                  // service's onStopCopy after the message lands in the Drafts
                  // folder, so the listener also QIs nsIMsgCopyServiceListener.
                  const listener = {
                    QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener", "nsIMsgCopyServiceListener"]),
                    // nsIMsgSendListener -- fires for SMTP send paths
                    onStartSending() {},
                    onProgress() {},
                    onSendProgress() {},
                    onStatus() {},
                    onStopSending(msgID, status) {
                      timer.cancel();
                      if (Components.isSuccessCode(status)) {
                        settle({ success: true, message: "Message sent" });
                      } else {
                        settle({ error: `Send failed (status: 0x${status.toString(16)})` });
                      }
                    },
                    onGetDraftFolderURI() {},
                    onSendNotPerformed(msgID, status) {
                      timer.cancel();
                      settle({ error: "Send was not performed" });
                    },
                    onTransportSecurityError(msgID, status, secInfo, location) {
                      timer.cancel();
                      settle({ error: `Transport security error${location ? ": " + location : ""}` });
                    },
                    // nsIMsgCopyServiceListener -- fires for SaveAsDraft / Sent-folder copy
                    onStartCopy() {},
                    setMessageKey() {},
                    onStopCopy(status) {
                      timer.cancel();
                      if (Components.isSuccessCode(status)) {
                        settle({ success: true, message: "Saved" });
                      } else {
                        settle({ error: `Save failed (status: 0x${status.toString(16)})` });
                      }
                    },
                  };

                  // Common args shared by both signatures (positions 1-10)
                  const commonArgs = [
                    null,                           // editor
                    identity,                       // identity
                    accountKey,                     // account key
                    composeFields,                  // fields
                    false,                          // isDigest
                    false,                          // dontDeliver
                    mode,                           // deliver mode
                    null,                           // msgToReplace
                    bodyMimeType,                   // body type
                    body,                           // body
                  ];

                  // Tail args shared by both (parentWindow..compType)
                  const tailArgs = [
                    null,                           // parent window
                    null,                           // progress
                    listener,                       // listener
                    "",                             // password
                    originalMsgURI || "",           // original msg URI
                    compType,                       // compose type
                  ];

                  // Try modern 16-arg signature first (TB 128+).
                  // On TB 102-127, XPCOM throws NS_ERROR_XPC_NOT_ENOUGH_ARGS
                  // (0x80570001), so we fall back to legacy 18-arg with null
                  // attachment params (attachments already on composeFields).
                  // Modern TB may return a Promise -- catch async rejections.
                  let sendResult;
                  try {
                    sendResult = msgSend.createAndSendMessage(...commonArgs, ...tailArgs);
                  } catch (e) {
                    const isArgError = (e && e.result === 0x80570001) ||
                      String(e).includes("Not enough arguments");
                    if (isArgError) {
                      sendResult = msgSend.createAndSendMessage(...commonArgs, null, null, ...tailArgs);
                    } else {
                      throw e;
                    }
                  }
                  // Modern TB (128+) returns a Promise from createAndSendMessage.
                  // Handle both fulfillment and rejection -- belt-and-suspenders
                  // with the listener (settle is idempotent). For SaveAsDraft on
                  // older TB without the copy listener, the Promise fulfillment
                  // can be the only completion signal we get.
                  if (sendResult && typeof sendResult.then === "function") {
                    sendResult.then(
                      () => {
                        timer.cancel();
                        settle({ success: true });
                      },
                      e => {
                        timer.cancel();
                        settle({ error: e.toString() });
                      }
                    );
                  }
                } catch (e) {
                  timer.cancel();
                  settle({ error: e.toString() });
                }
              });
            }

            /**
             * Decides whether a compose operation will (or should) run in HTML
             * mode, and returns the matching msgComposeParams.format value.
             *
             * The caller's explicit isHtml wins (true/false). When isHtml is
             * omitted, the identity's compose-format preference is consulted.
             *
             * ForwardInline is a special case: Thunderbird's compose service
             * only passes format through when it's Default or OppositeOfDefault
             * for that compType, so when the caller's explicit isHtml conflicts
             * with the identity pref on a forward, we have to ask for
             * OppositeOfDefault instead of HTML/PlainText.
             *
             * Identity must be resolved (setComposeIdentity) before calling this.
             */
            function resolveComposeFormat(identity, isHtml, compType) {
              const identityUsesHtml = identity?.composeHtml !== false;
              const useHtml = isHtml === true || (isHtml !== false && identityUsesHtml);
              const isForward = compType === Ci.nsIMsgCompType.ForwardInline
                             || compType === Ci.nsIMsgCompType.ForwardAsAttachment;

              let format;
              if (isHtml === undefined) {
                format = Ci.nsIMsgCompFormat.Default;
              } else if (isForward) {
                const explicitMatchesPref = (isHtml === true) === identityUsesHtml;
                format = explicitMatchesPref
                  ? Ci.nsIMsgCompFormat.Default
                  : Ci.nsIMsgCompFormat.OppositeOfDefault;
              } else {
                format = isHtml === true ? Ci.nsIMsgCompFormat.HTML : Ci.nsIMsgCompFormat.PlainText;
              }
              return { useHtml, format };
            }

            /**
             * Sets compose identity from `from` param or falls back to default.
             * Returns "" on success, or { error } if `from` was explicitly
             * provided but not found / restricted.  Fallback to default only
             * applies when `from` is omitted.
             */
            function setComposeIdentity(msgComposeParams, from, fallbackServer) {
              if (from) {
                // Explicit `from` -- must resolve or fail, never silently substitute
                const identity = findIdentity(from);
                if (identity) {
                  // findIdentity searches accessible accounts, so this is safe
                  msgComposeParams.identity = identity;
                  return "";
                }
                // Not found in accessible accounts -- check ALL accounts to
                // distinguish "restricted" from "genuinely unknown"
                if (findIdentityIn(MailServices.accounts.accounts, from)) {
                  return { error: `identity ${from} belongs to a restricted account` };
                }
                return { error: `unknown identity: ${from} -- no matching account configured in Thunderbird` };
              }
              // No explicit `from` -- fall back to contextual default
              if (fallbackServer) {
                const account = MailServices.accounts.findAccountForServer(fallbackServer);
                if (account && isAccountAllowed(account.key)) {
                  msgComposeParams.identity = account.defaultIdentity;
                }
              } else {
                const defaultAccount = MailServices.accounts.defaultAccount;
                if (defaultAccount && isAccountAllowed(defaultAccount.key)) {
                  msgComposeParams.identity = defaultAccount.defaultIdentity;
                }
              }
              // If no identity was set (all fallbacks restricted), explicitly set
              // the first accessible identity. Without this, Thunderbird's
              // OpenComposeWindowWithParams fills identity from defaultAccount
              // internally, bypassing account restrictions.
              if (!msgComposeParams.identity) {
                for (const account of getAccessibleAccounts()) {
                  if (account.defaultIdentity) {
                    msgComposeParams.identity = account.defaultIdentity;
                    break;
                  }
                }
                if (!msgComposeParams.identity) {
                  return { error: "No accessible identity found -- all accounts are restricted" };
                }
              }
              return "";
            }

  Object.assign(ctx, {
    composeAdapter: {
      templatesDir,
      readTextFile,
      loadTemplate,
      listTemplateFiles,
      findIdentityIn,
      findIdentity,
      createLocalFile,
      filePathsToAttachDescs,
      descsToMsgAttachments,
      addAttachmentsToComposeWindow,
      injectAttachmentsAsync,
      getReplyAllCcRecipients,
      applyComposeRecipientOverrides,
      formatBodyFragmentHtml,
      moveComposeSelectionToBodyStartIfRange,
      insertReplyBodyIntoComposeWindow,
      openComposeWindowWithCustomizations,
      markMessageDispositionState,
      sendMessageDirectly,
      resolveComposeFormat,
      setComposeIdentity,
      MAX_BASE64_SIZE,
      MAX_FILE_PATH_ATTACHMENT_BYTES,
    },
  });
};
