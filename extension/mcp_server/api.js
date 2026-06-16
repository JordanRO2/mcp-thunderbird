/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci */
"use strict";

/**
 * Thunderbird MCP Server Extension
 * Exposes email, calendar, and contacts via MCP protocol over HTTP.
 *
 * Architecture: MCP Client <-> mcp-bridge.cjs (stdio<->HTTP) <-> This extension (port 8765)
 *
 * Key quirks documented inline:
 * - MIME header decoding (mime2Decoded* properties)
 * - HTML body charset handling (emojis require HTML entity encoding)
 * - Compose window body preservation (must use New type, not Reply)
 * - IMAP folder sync (msgDatabase may be stale)
 */

const resProto = Cc[
  "@mozilla.org/network/protocol;1?name=resource"
].getService(Ci.nsISubstitutingProtocolHandler);

const MCP_DEFAULT_PORT = 8765;
const MCP_MAX_PORT_ATTEMPTS = 10;

// Versions of the MCP protocol this server understands. Behavior never depends
// on the negotiated version inside Thunderbird (the bridge intercepts initialize
// for clients), but for the rare case a client talks directly to the HTTP server
// we still need a spec-compliant negotiated value. Keep in sync with mcp-bridge.cjs.
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-10-07",
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const MCP_LATEST_PROTOCOL_VERSION = "2025-11-25";

// Bridged into serverInfo.version on initialize. Resolved lazily from the
// extension manifest so a single bump in extension/manifest.json propagates here.
let _cachedExtVersion = null;
function getExtVersion() {
  if (_cachedExtVersion) return _cachedExtVersion;
  try {
    const uri = Services.io.newURI("resource://thunderbird-mcp/manifest.json");
    const channel = Services.io.newChannelFromURI(uri, null,
      Services.scriptSecurityManager.getSystemPrincipal(), null,
      Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      Ci.nsIContentPolicy.TYPE_OTHER);
    const sis = Cc["@mozilla.org/scriptableinputstream;1"]
      .createInstance(Ci.nsIScriptableInputStream);
    sis.init(channel.open());
    const text = sis.read(sis.available());
    sis.close();
    _cachedExtVersion = JSON.parse(text).version || "0.0.0";
  } catch (e) {
    console.warn("thunderbird-mcp: could not read extension manifest version:", e);
    _cachedExtVersion = "0.0.0";
  }
  return _cachedExtVersion;
}
// Keep references to active attach timers to prevent GC before they fire.
const _attachTimers = new Set();
// Track temp files created for inline base64 attachments (cleaned up on shutdown).
const _tempAttachFiles = new Set();
// Track compose windows already claimed by an in-flight replyToMessage or
// forwardMessage call, so concurrent reply/forward operations on the same
// original message never bind two observers to the same compose window
// (which would double-inject the body/attachments).
// WeakSet so entries are collected automatically when the window is destroyed.
const _claimedComposeWindows = new WeakSet();
// Must be large enough to carry the inline-attachment base64 cap plus JSON-RPC
// framing overhead. The httpd.sys.mjs pre-buffer cap uses the same value.
const MAX_REQUEST_BODY = 32 * 1024 * 1024; // 32 MB limit for incoming HTTP request bodies

// Pure helpers (deny-list, header sanitizer, URL allow-lists, schema walker,
// audit helpers) live in security_helpers.js so the Node test suite can
// exercise the same code that ships in production. The module is loaded
// inside getAPI() below because resource:// URIs aren't usable at file scope.
const DEFAULT_MAX_RESULTS = 50;
const PREF_ALLOWED_ACCOUNTS = "extensions.thunderbird-mcp.allowedAccounts";
const PREF_DISABLED_TOOLS = "extensions.thunderbird-mcp.disabledTools";
const PREF_BLOCK_SKIPREVIEW = "extensions.thunderbird-mcp.blockSkipReview";
const PREF_STABLE_AUTH_TOKEN = "extensions.thunderbird-mcp.stableAuthToken";
// Gate `forward` and `reply` actions on filter creation/update. Filters run on
// every incoming message and never open a review UI, so a single createFilter
// call can install a permanent silent-exfiltration rule. Default is to refuse
// these action types via the MCP API; users who legitimately need them can
// flip this pref or create the filter manually in Thunderbird.
const PREF_BLOCK_FILTER_FORWARD_REPLY = "extensions.thunderbird-mcp.blockFilterForwardReply";
// Gate write operations on address books. createContact / updateContact /
// deleteContact have no UI confirmation, span every address book the user has
// configured, and could be used to spoof an existing contact (change Boss's
// email to attacker@evil.com) so the user's future replies are silently
// misrouted. Default is to refuse contact writes; users who want LLM-driven
// contact management opt in via the options page.
const PREF_BLOCK_CONTACT_WRITES = "extensions.thunderbird-mcp.blockContactWrites";
// Gate exportMailbox. Bulk-exports walk thousands of messages, may run for
// many seconds, and write the user's mail content to a JSON file on disk.
// Default off-by-pref so an LLM cannot mass-extract mailbox content silently.
const PREF_BLOCK_MAILBOX_EXPORT = "extensions.thunderbird-mcp.blockMailboxExport";
const AUTH_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// Valid group and CRUD values for tool metadata validation
const VALID_GROUPS = ["messages", "folders", "contacts", "calendar", "filters", "system"];
const VALID_CRUD = ["create", "read", "update", "delete"];
// CRUD sort order: read first, then create, update, delete (safe → destructive)
const CRUD_ORDER = { read: 0, create: 1, update: 2, delete: 3 };
// Tools that cannot be disabled via the settings page (infrastructure tools)
const UNDISABLEABLE_TOOLS = new Set(["listAccounts", "listFolders", "getAccountAccess"]);
const MAX_SEARCH_RESULTS_CAP = 200;
// Internal IMAP/Thunderbird keywords that should not appear as user-visible tags
const INTERNAL_KEYWORDS = new Set([
  "junk", "notjunk", "$forwarded", "$replied",
  "\\seen", "\\answered", "\\flagged", "\\deleted", "\\draft", "\\recent",
  // Some IMAP servers store flags without the backslash prefix
  "seen", "answered", "flagged", "deleted", "draft", "recent",
]);

var mcpServer = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const extensionRoot = context.extension.rootURI;
    const resourceName = "thunderbird-mcp";

    resProto.setSubstitutionWithFlags(
      resourceName,
      extensionRoot,
      resProto.ALLOW_CONTENT_ACCESS
    );

    // Load pure helpers from security_helpers.js. We pass a scope object with
    // a `module.exports` shim so the file can use standard CommonJS exports
    // syntax; that lets the Node test suite require() it directly without a
    // dual-format wrapper.
    const __helperScope = { module: { exports: {} } };
    Services.scriptloader.loadSubScript(
      "resource://thunderbird-mcp/mcp_server/security_helpers.js?" + Date.now(),
      __helperScope
    );
    const {
      isSensitiveFilePath,
      sanitizeHeaderLine,
      UNTRUSTED_CLOSE,
      wrapUntrustedBody,
      wrapUntrustedPreview,
      countRecipients,
      summarizeAttachmentsForAudit,
      isSafeMarkdownHref,
      isSafeImageSrc,
      escapeMarkdownLinkText,
      renderMarkdownLink,
      isSystemPrincipalFetchAllowed,
      validateAgainstSchema,
      createRateLimiterState,
      consumeRateLimit,
      inspectRateLimits,
      attachmentSaveLooksWrong,
      parseAttachmentPartsFromRawMime,
    } = __helperScope.module.exports;

    // The rate-limiter STATE is now created and owned by
    // infrastructure/audit.js (registered as ctx.rateLimiterState, consumed via
    // ctx.consumeRateLimitFor / ctx.inspectRateLimitsState). The algorithm
    // (createRateLimiterState/consumeRateLimit/inspectRateLimits) still lives in
    // security_helpers.js and is passed down through ctx.

    const tools = [
      {
        name: "listAccounts",
        group: "system", crud: "read",
        title: "List Accounts",
        description: "List all email accounts and their identities",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "listFolders",
        group: "system", crud: "read",
        title: "List Folders",
        description: "List all mail folders with URIs and message counts",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Optional account ID (from listAccounts) to limit results to a single account" },
            folderPath: { type: "string", description: "Optional folder URI (from listFolders) to list only that folder and its subfolders" },
          },
          required: [],
        },
      },
      {
        name: "searchMessages",
        group: "messages", crud: "read",
        title: "Search Mail",
        description: "Search message headers and return IDs/folder paths you can use with getMessage to read full email content",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Text to search. Multi-word queries are AND-of-tokens: every word must appear somewhere across subject/author/recipients/ccList/preview (or inside the selected field when an operator is used). Prefix with 'from:', 'subject:', 'to:', or 'cc:' to restrict matching to one field (e.g. 'from:Alice Smith' requires both tokens in the author field). Use empty string to match all." },
            folderPath: { type: "string", description: "Optional folder URI (from listFolders) to limit search to that folder and its subfolders" },
            startDate: { type: "string", description: "Filter messages on or after this ISO 8601 date" },
            endDate: { type: "string", description: "Filter messages on or before this ISO 8601 date. Date-only strings (e.g. '2024-01-15') include the full day." },
            maxResults: { type: "number", description: "Maximum number of results to return (default 50, max 200)" },
            offset: { type: "number", description: "Number of results to skip for pagination (default 0). When provided, returns {messages, totalMatches, offset, limit, hasMore} instead of a plain array. Note: totalMatches is capped at 10000." },
            sortOrder: { type: "string", description: "Date sort order: asc (oldest first) or desc (newest first, default)" },
            unreadOnly: { type: "boolean", description: "Only return unread messages (default: false)" },
            flaggedOnly: { type: "boolean", description: "Only return flagged/starred messages (default: false)" },
            tag: { type: "string", description: "Filter by tag keyword (e.g. '$label1' for Important, or a custom tag). Only messages with this tag are returned." },
            includeSubfolders: { type: "boolean", description: "If false, only search the specified folder — not its subfolders. Default: true." },
            countOnly: { type: "boolean", description: "If true, return only the match count instead of full results. Much faster for 'how many unread?' queries." },
            searchBody: { type: "boolean", description: "If true, search full message bodies using Thunderbird's Gloda index (slower but finds text beyond the ~200 char preview). Requires query. IMAP accounts need offline sync enabled for body indexing." },
            dedupByMessageId: { type: "boolean", description: "If false, return every folder/label location for messages found in multiple folders. Default: true, which collapses the same RFC Message-ID into one row and lists the other folder paths in dupLocations." },
          },
          required: ["query"],
        },
      },
      {
        name: "getMessage",
        group: "messages", crud: "read",
        title: "Get Message",
        description: "Read the full content of an email message by its ID",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            saveAttachments: { type: "boolean", description: "If true, save attachments to <OS temp dir>/thunderbird-mcp/<messageId>/ and include filePath in response (default: false)" },
            bodyFormat: { type: "string", enum: ["markdown", "text", "html"], description: "Body output format: 'markdown' (default, preserves structure), 'text' (plain text), 'html' (raw HTML)" },
            rawSource: { type: "boolean", description: "If true, return the full raw RFC 2822 message source (all headers + MIME parts). Useful for extracting calendar invites, S/MIME data, or debugging. Other fields (body, attachments) are omitted when this is set. Note: requires local/offline message copy; IMAP messages not cached offline may fail." },
          },
          required: ["messageId", "folderPath"],
        },
      },
      {
        name: "getMessages",
        group: "messages", crud: "read",
        title: "Get Messages",
        description: "Read full email content for up to 20 messages in one call. Each item needs messageId and folderPath from searchMessages/getRecentMessages results.",
        inputSchema: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              description: "Messages to read, max 20. Each item is { messageId, folderPath }.",
              items: {
                type: "object",
                properties: {
                  messageId: { type: "string", description: "The message ID" },
                  folderPath: { type: "string", description: "The folder URI path containing the message" },
                },
                required: ["messageId", "folderPath"],
                additionalProperties: false,
              },
            },
            saveAttachments: { type: "boolean", description: "If true, save attachments for each message and include filePath in attachment metadata (default: false)" },
            bodyFormat: { type: "string", enum: ["markdown", "text", "html"], description: "Body output format shared by all messages: 'markdown' (default), 'text', or 'html'" },
            rawSource: { type: "boolean", description: "If true, return raw RFC 2822 source for each message instead of parsed body fields" },
          },
          required: ["messages"],
        },
      },
      {
        name: "getMessageHeaders",
        group: "messages", crud: "read",
        title: "Get Message Headers",
        description: "Read message headers only (subject, author, recipients, date, tags, threading headers) without decoding the body or attachments. Much cheaper than getMessage when you only need to triage or quote a small set of messages.",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
          },
          required: ["messageId", "folderPath"],
        },
      },
      {
        name: "exportMailbox",
        group: "messages", crud: "read",
        title: "Export Mailbox",
        description: "Stream a folder's messages to a JSON-lines file under <ProfD>/thunderbird-mcp/exports/. Default mode is headers-only; pass includeBody:true to also embed each message's plain-text body and attachment metadata (slower). The destination file is named with a UTC timestamp and a sanitized folder name; the path is returned so the caller knows where to find it. Disabled by default via extensions.thunderbird-mcp.blockMailboxExport -- enable it in the options page when you actually need a bulk export.",
        inputSchema: {
          type: "object",
          properties: {
            folderPath: { type: "string", description: "Folder URI to export (required). Subfolders are NOT recursed -- call once per folder." },
            maxMessages: { type: "integer", description: "Cap on exported messages (default 1000, hard cap 50000). Use sortOrder:'desc' (default) to take the newest N." },
            includeBody: { type: "boolean", description: "If true, extract each message's plain-text body and embed it on the JSON line. Default false. Adds a MIME parse per message so a 5000-message export takes substantially longer." },
            includeAttachmentMeta: { type: "boolean", description: "If true and includeBody is true, embed attachment {name, contentType, size} metadata too. Attachment CONTENT is never written -- only metadata. Default false." },
            scanCap: { type: "integer", description: "Hard cap on messages enumerated before stopping (default 50000). Prevents the LLM from walking a 200k-message archive forever." },
            sortOrder: { type: "string", enum: ["asc", "desc"], description: "Date sort order before applying maxMessages. 'desc' (default) = newest first." },
          },
          required: ["folderPath"],
        },
      },
      {
        name: "getSenderHistory",
        group: "messages", crud: "read",
        title: "Get Sender History",
        description: "Return recent message headers from a given email address, scanned across the inbox of every accessible account. Useful for 'have I corresponded with this person before?' or 'have we already approached this outreach target?' decisions before drafting a reply.",
        inputSchema: {
          type: "object",
          properties: {
            email: { type: "string", description: "Sender email address to match (case-insensitive substring match against the author field)" },
            maxResults: { type: "integer", description: "Cap on returned headers (default 50, max 200)" },
            scanCap: { type: "integer", description: "Hard cap on messages enumerated per folder before stopping (default 5000, max 50000)" },
            sinceDays: { type: "integer", description: "Restrict to messages from the last N days (default unlimited)" },
          },
          required: ["email"],
        },
      },
      {
        name: "searchAttachments",
        group: "messages", crud: "read",
        title: "Search Attachments",
        description: "Find messages with attachments matching a filename substring and/or MIME-type pattern. Walks messages in the chosen folder (or the inbox of every accessible account when folderPath is omitted) and inspects allUserAttachments metadata. Returns header objects with the matching attachment names attached. Capped to avoid mailbox scans.",
        inputSchema: {
          type: "object",
          properties: {
            nameContains: { type: "string", description: "Case-insensitive substring matched against the attachment filename (e.g. 'invoice', '.pdf')" },
            contentType: { type: "string", description: "Case-insensitive prefix matched against the attachment Content-Type (e.g. 'application/pdf', 'image/')" },
            folderPath: { type: "string", description: "Optional folder URI to limit the search. Omitted = scan inbox of each accessible account." },
            maxResults: { type: "integer", description: "Cap on matching messages (default 50, max 200)" },
            scanCap: { type: "integer", description: "Hard cap on messages enumerated per folder before stopping (default 5000, max 50000). Prevents the LLM from accidentally walking a 200k-message archive." },
          },
          required: [],
        },
      },
      {
        name: "searchByThread",
        group: "messages", crud: "read",
        title: "Search By Thread",
        description: "Given any messageId + folderPath, return headers for every other message in the same thread. Uses msgHdr.threadId. Results are headers-only -- call getMessage on a specific id for its body.",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "Any message in the thread you want to fetch" },
            folderPath: { type: "string", description: "Folder URI containing the message" },
            maxResults: { type: "integer", description: "Cap on returned headers (default 100, max 500)" },
          },
          required: ["messageId", "folderPath"],
        },
      },
      {
        name: "batchGetMessageHeaders",
        group: "messages", crud: "read",
        title: "Batch Get Message Headers",
        description: "Fetch headers for up to 200 messages in a single round-trip. Returns a map of messageId -> { header object | { error: ... } }. Pair with searchMessages to enrich a result set without N round-trips.",
        inputSchema: {
          type: "object",
          properties: {
            messageIds: { type: "array", items: { type: "string" }, description: "Array of message IDs to fetch headers for (hard cap 200)" },
            folderPath: { type: "string", description: "Folder URI shared by all of the IDs" },
          },
          required: ["messageIds", "folderPath"],
        },
      },
      {
        name: "listTemplates",
        group: "system", crud: "read",
        title: "List Compose Templates",
        description: "List user-authored compose templates stored under <ProfD>/thunderbird-mcp/templates/*.md. Each file has YAML-style frontmatter (---\\nname: short-id\\ndescription: ...\\nsubject: ...\\nisHtml: false\\nvars: [target, contact_name]\\n---) followed by the body. The variable names listed in `vars` are the placeholders renderTemplate accepts.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "renderTemplate",
        group: "system", crud: "read",
        title: "Render Compose Template",
        description: "Render a template by name with the supplied variable bindings. Returns { subject, body, isHtml } ready to feed into sendMail. Pure read-only -- nothing is sent. Use this to standardize outreach / reply patterns so the LLM doesn't drift across messages.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Template `name` value from its frontmatter" },
            vars: {
              type: "object",
              description: "Variable bindings; keys must match the template's declared `vars` list. Unknown keys are silently ignored; missing required keys produce an error.",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "getServerCapabilities",
        group: "system", crud: "read",
        title: "Get Server Capabilities",
        description: "Return a snapshot of the LLM's sandbox: enabled / disabled tool names, accessible account IDs, current safeguard pref states (blockSkipReview, blockFilterForwardReply, blockContactWrites), current rate-limit bucket states with remaining slots per tool, server version, and audit-log location. Call this once at the start of an agent loop so you know what you can do before you try things that will fail.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "getAuditLog",
        group: "system", crud: "read",
        title: "Get Audit Log",
        description: "Read parsed entries from the MCP audit log newest-first. Every outbound compose (sendMail / replyToMessage / forwardMessage / saveDraft) and every contact write are recorded as JSON lines with timestamp + tool + metadata (no body, no attachment content, no recipient addresses beyond counts). Useful for the agent to answer 'what did I send today?' or 'have I already contacted this target?'",
        inputSchema: {
          type: "object",
          properties: {
            maxEntries: { type: "integer", description: "Max entries to return (default 200, hard cap 10000)" },
            tool: { type: "string", description: "Filter by exact tool name (e.g. 'sendMail')" },
            since: { type: "string", description: "Filter to entries on or after this ISO 8601 timestamp" },
            until: { type: "string", description: "Filter to entries on or before this ISO 8601 timestamp" },
          },
          required: [],
        },
      },
      {
        name: "dryRunCompose",
        group: "messages", crud: "read",
        title: "Dry-Run Compose",
        description: "Validate compose parameters WITHOUT sending or saving. Resolves the from identity, parses recipient counts, evaluates every attachment through the same path / size / deny-list pipeline that sendMail uses, and reports the rendered subject (after header sanitization). Useful for an agent that wants to self-check a compose call before triggering the review window or skipReview send.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email address" },
            subject: { type: "string", description: "Email subject line" },
            body: { type: "string", description: "Email body text (length is reported back; content is not echoed)" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            isHtml: { type: "boolean", description: "Treat body as HTML (default: false)" },
            from: { type: "string", description: "Sender identity (email address or identity ID)" },
            attachments: {
              type: "array",
              description: "Attachments to evaluate (same shape as sendMail). Each entry is checked but neither read nor copied; only path/size/deny-list status is returned.",
              items: {
                oneOf: [
                  { type: "string", description: "Absolute file path to attach" },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      contentType: { type: "string" },
                      base64: { type: "string" },
                    },
                    required: ["name", "base64"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "sendMail",
        group: "messages", crud: "create",
        title: "Compose Mail",
        description: "Compose a new email. By default opens a compose window for review; set skipReview to send directly.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email address" },
            subject: { type: "string", description: "Email subject line" },
            body: { type: "string", description: "Email body text" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
            from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
            skipReview: { type: "boolean", description: "If true, send the message directly without opening a compose window (default: false)" },
            idempotencyKey: { type: "string", description: "Optional client-supplied key (max 256 chars). If sendMail was previously called with this same key within the last 24 hours AND succeeded, the prior result is returned instead of sending again. Use this to make retries safe across crashes / network errors -- especially for outreach where re-sending to a real target is costly." },
            attachments: {
              type: "array",
              description: "Attachments: file paths (strings) or inline objects ({name, contentType, base64})",
              items: {
                oneOf: [
                  { type: "string", description: "Absolute file path to attach" },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "Attachment filename" },
                      contentType: { type: "string", description: "MIME type, e.g. application/pdf" },
                      base64: { type: "string", description: "Base64-encoded file content" },
                    },
                    required: ["name", "base64"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "saveDraft",
        group: "messages", crud: "create",
        title: "Save Draft",
        description: "Save a composed message to the identity's Drafts folder without sending or opening a compose window. Useful when a human will review and send the message later from Thunderbird.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email address(es), comma-separated. Optional -- a draft can have no recipient." },
            subject: { type: "string", description: "Email subject line (optional)" },
            body: { type: "string", description: "Email body (optional)" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
            from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
            attachments: {
              type: "array",
              description: "Attachments: file paths (strings) or inline objects ({name, contentType, base64})",
              items: {
                oneOf: [
                  { type: "string", description: "Absolute file path to attach" },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "Attachment filename" },
                      contentType: { type: "string", description: "MIME type, e.g. application/pdf" },
                      base64: { type: "string", description: "Base64-encoded file content" },
                    },
                    required: ["name", "base64"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: [],
        },
      },
      {
        name: "listCalendars",
        group: "calendar", crud: "read",
        title: "List Calendars",
        description: "Return the user's calendars",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "createEvent",
        group: "calendar", crud: "create",
        title: "Create Event",
        description: "Create a calendar event. By default opens a review dialog; set skipReview to add directly.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Event title" },
            startDate: { type: "string", description: "Start date/time in ISO 8601 format" },
            endDate: { type: "string", description: "End date/time in ISO 8601 (defaults to startDate + 1h for timed, +1 day for all-day)" },
            location: { type: "string", description: "Event location" },
            description: { type: "string", description: "Event description" },
            calendarId: { type: "string", description: "Target calendar ID (from listCalendars, defaults to first writable calendar)" },
            allDay: { type: "boolean", description: "Create an all-day event (default: false)" },
            status: { type: "string", description: "VEVENT STATUS: 'tentative', 'confirmed', or 'cancelled'. Defaults to confirmed if omitted." },
            showAs: { type: "string", enum: ["busy", "free"], description: "How the event appears in the calendar: 'busy' (solid block, TRANSP:OPAQUE + STATUS:CONFIRMED) or 'free' (hatched, TRANSP:TRANSPARENT + STATUS:TENTATIVE). Defaults to 'busy'. Overridden per-property by explicit status parameter." },
            categories: { type: "array", items: { type: "string" }, description: "Category labels (optional). Use listCategories to get exact existing names before setting." },
            onlineMeeting: { type: "boolean", description: "If true, generates a Microsoft Teams meeting link via Exchange (OWL/Office 365 accounts only). After creation, OWL embeds the join URL in the event description and exposes it via listEvents (onlineMeetingURL). No-op on non-OWL backends." },
            skipReview: { type: "boolean", description: "If true, add the event directly without opening a review dialog (default: false)" },
          },
          required: ["title", "startDate"],
        },
      },
      {
        name: "listEvents",
        group: "calendar", crud: "read",
        title: "List Events",
        description: "List calendar events within a date range",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: { type: "string", description: "Calendar ID to query (from listCalendars). If omitted, queries all calendars." },
            startDate: { type: "string", description: "Start of date range in ISO 8601 format (default: now)" },
            endDate: { type: "string", description: "End of date range in ISO 8601 format (default: 30 days from startDate)" },
            maxResults: { type: "number", description: "Maximum number of events to return (default: 100, max: 500)" },
          },
          required: [],
        },
      },
      {
        name: "updateEvent",
        group: "calendar", crud: "update",
        title: "Update Event",
        description: "Update an existing calendar event's title, dates, location, or description. For recurring events, recurringScope must be supplied explicitly: 'series' edits the entire series, no other scopes are currently supported. The call FAILS for recurring events when recurringScope is omitted, so the agent cannot accidentally rewrite years of past occurrences.",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event ID (from listEvents results)" },
            calendarId: { type: "string", description: "The calendar ID containing the event (from listEvents results)" },
            title: { type: "string", description: "New event title (optional)" },
            startDate: { type: "string", description: "New start date/time in ISO 8601 format (optional)" },
            endDate: { type: "string", description: "New end date/time in ISO 8601 format (optional)" },
            location: { type: "string", description: "New event location (optional)" },
            description: { type: "string", description: "New event description (optional)" },
            status: { type: "string", description: "New VEVENT STATUS: 'tentative', 'confirmed', or 'cancelled' (optional)" },
            showAs: { type: "string", enum: ["busy", "free"], description: "How the event appears in the calendar: 'busy' (solid, TRANSP:OPAQUE + STATUS:CONFIRMED) or 'free' (hatched, TRANSP:TRANSPARENT + STATUS:TENTATIVE). Pass null to clear TRANSP only. Explicit status parameter overrides the STATUS coupling." },
            categories: { type: "array", items: { type: "string" }, description: "Category labels (optional). Replaces existing categories; empty array clears them." },
            onlineMeeting: { type: "boolean", description: "If true, generates a Microsoft Teams meeting link via Exchange (OWL/Office 365 accounts only). Pass false to remove an existing Teams link." },
            recurringScope: { type: "string", enum: ["series"], description: "Required for recurring events. 'series' rewrites every occurrence past and future. Per-occurrence editing is not supported through this API; use Thunderbird's UI." },
          },
          required: ["eventId", "calendarId"],
        },
      },
      {
        name: "deleteEvent",
        group: "calendar", crud: "delete",
        title: "Delete Event",
        description: "Delete a calendar event. For recurring events, recurringScope must be supplied explicitly: 'series' deletes the entire series. The call FAILS for recurring events when recurringScope is omitted, so the agent cannot accidentally nuke a long-running series.",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event ID (from listEvents results)" },
            calendarId: { type: "string", description: "The calendar ID containing the event (from listEvents results)" },
            recurringScope: { type: "string", enum: ["series"], description: "Required for recurring events. 'series' deletes every occurrence. Per-occurrence deletion is not supported through this API; use Thunderbird's UI." },
          },
          required: ["eventId", "calendarId"],
        },
      },
      {
        name: "createTask",
        group: "calendar", crud: "create",
        title: "Create Task",
        description: "Open a pre-filled task dialog in Thunderbird for user review before saving, or save directly when skipReview is true.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title" },
            dueDate: { type: "string", description: "Due date in ISO 8601 format (optional)" },
            calendarId: { type: "string", description: "Target calendar ID (from listCalendars, must have supportsTasks=true)" },
            description: { type: "string", description: "Task description/body (optional)" },
            priority: { type: "integer", description: "Priority: 1=high, 5=normal, 9=low (optional)" },
            categories: { type: "array", items: { type: "string" }, description: "Category labels (optional). Use listCategories to get exact existing names before setting." },
            skipReview: { type: "boolean", description: "If true, save the task directly without opening a review dialog (default: false)" },
          },
          required: ["title"],
        },
      },
      {
        name: "listCategories",
        group: "calendar", crud: "read",
        title: "List Categories",
        description: "Return all calendar category names defined in Thunderbird preferences. Use this before creating tasks or events to get exact category names (case-sensitive).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "listTasks",
        group: "calendar", crud: "read",
        title: "List Tasks",
        description: "List tasks/to-dos from Thunderbird calendars, optionally filtered by completion status or due date",
        inputSchema: {
          type: "object",
          properties: {
            calendarId: { type: "string", description: "Calendar ID to query (from listCalendars). If omitted, queries all task-capable calendars." },
            completed: { type: "boolean", description: "Filter by completion status. true = completed only, false = outstanding only. Omit for all tasks." },
            dueBefore: { type: "string", description: "Return tasks due before this ISO 8601 date" },
            maxResults: { type: "integer", description: "Maximum number of tasks to return (default: 100, max: 500)" },
          },
          required: [],
        },
      },
      {
        name: "updateTask",
        group: "calendar", crud: "update",
        title: "Update Task",
        description: "Update an existing task/to-do: change title, due date, description, priority, completion status, or percent complete",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Task ID (from listTasks results)" },
            calendarId: { type: "string", description: "Calendar ID containing the task (from listTasks results)" },
            title: { type: "string", description: "New task title (optional)" },
            dueDate: { type: "string", description: "New due date in ISO 8601 format (optional)" },
            description: { type: "string", description: "New task description/body (optional)" },
            completed: { type: "boolean", description: "Set to true to mark the task done (sets percentComplete=100 and records completedDate), false to reopen it (optional)" },
            percentComplete: { type: "integer", description: "Completion percentage 0–100 (optional)" },
            priority: { type: "integer", description: "Priority: 1=high, 5=normal, 9=low (optional)" },
          },
          required: ["taskId", "calendarId"],
        },
      },
      {
        name: "searchContacts",
        group: "contacts", crud: "read",
        title: "Search Contacts",
        description: "Search contacts across all address books by email address or name",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Email address or name to search for" },
            maxResults: { type: "number", description: "Maximum number of results to return (default 50, max 200). If truncated, response includes hasMore: true." },
          },
          required: ["query"],
        },
      },
      {
        name: "createContact",
        group: "contacts", crud: "create",
        title: "Create Contact",
        description: "Create a new contact in an address book",
        inputSchema: {
          type: "object",
          properties: {
            email: { type: "string", description: "Primary email address" },
            displayName: { type: "string", description: "Display name" },
            firstName: { type: "string", description: "First name" },
            lastName: { type: "string", description: "Last name" },
            addressBookId: { type: "string", description: "Address book directory ID (from searchContacts results). Defaults to the first writable address book." },
          },
          required: ["email"],
        },
      },
      {
        name: "updateContact",
        group: "contacts", crud: "update",
        title: "Update Contact",
        description: "Update an existing contact's properties",
        inputSchema: {
          type: "object",
          properties: {
            contactId: { type: "string", description: "Contact UID (from searchContacts results)" },
            email: { type: "string", description: "New primary email address" },
            displayName: { type: "string", description: "New display name" },
            firstName: { type: "string", description: "New first name" },
            lastName: { type: "string", description: "New last name" },
          },
          required: ["contactId"],
        },
      },
      {
        name: "deleteContact",
        group: "contacts", crud: "delete",
        title: "Delete Contact",
        description: "Delete a contact from its address book",
        inputSchema: {
          type: "object",
          properties: {
            contactId: { type: "string", description: "Contact UID (from searchContacts results)" },
          },
          required: ["contactId"],
        },
      },
      {
        name: "replyToMessage",
        group: "messages", crud: "create",
        title: "Reply to Message",
        description: "Reply to a message. By default opens a compose window with quoted original text for review; set skipReview to send directly.",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID to reply to (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            body: { type: "string", description: "Reply body text" },
            replyAll: { type: "boolean", description: "Reply to all recipients (default: false)" },
            isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
            to: { type: "string", description: "Override recipient email (default: original sender)" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
            skipReview: { type: "boolean", description: "If true, send the reply directly without opening a compose window (default: false)" },
            idempotencyKey: { type: "string", description: "Optional dedup key (max 256 chars). See sendMail for semantics." },
            attachments: {
              type: "array",
              description: "Attachments: file paths (strings) or inline objects ({name, contentType, base64})",
              items: {
                oneOf: [
                  { type: "string", description: "Absolute file path to attach" },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "Attachment filename" },
                      contentType: { type: "string", description: "MIME type, e.g. application/pdf" },
                      base64: { type: "string", description: "Base64-encoded file content" },
                    },
                    required: ["name", "base64"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["messageId", "folderPath", "body"],
        },
      },
      {
        name: "forwardMessage",
        group: "messages", crud: "create",
        title: "Forward Message",
        description: "Forward a message. By default opens a compose window with original content for review; set skipReview to send directly.",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID to forward (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            to: { type: "string", description: "Recipient email address" },
            body: { type: "string", description: "Additional text to prepend (optional)" },
            isHtml: { type: "boolean", description: "Set to true if body contains HTML markup (default: false)" },
            cc: { type: "string", description: "CC recipients (comma-separated)" },
            bcc: { type: "string", description: "BCC recipients (comma-separated)" },
            from: { type: "string", description: "Sender identity (email address or identity ID from listAccounts)" },
            skipReview: { type: "boolean", description: "If true, send the forward directly without opening a compose window (default: false)" },
            idempotencyKey: { type: "string", description: "Optional dedup key (max 256 chars). See sendMail for semantics." },
            attachments: {
              type: "array",
              description: "Additional attachments: file paths (strings) or inline objects ({name, contentType, base64})",
              items: {
                oneOf: [
                  { type: "string", description: "Absolute file path to attach" },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "Attachment filename" },
                      contentType: { type: "string", description: "MIME type, e.g. application/pdf" },
                      base64: { type: "string", description: "Base64-encoded file content" },
                    },
                    required: ["name", "base64"],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ["messageId", "folderPath", "to"],
        },
      },
      {
        name: "refreshFolder",
        group: "messages", crud: "read",
        title: "Refresh Folder",
        description: "Force an IMAP fetch on the given folder so the server-side state syncs to Thunderbird's local cache. Without this, IMAP folders only refresh when the user clicks them in the UI, which means recently-arrived mail is invisible to searchMessages / getRecentMessages until then. Call refreshFolder before a query when you know new traffic just arrived. Non-IMAP folders return success without doing anything. Note: very large IMAP folders like Gmail [Gmail]/Todos (All Mail) may not finish within the timeout cap; consider refreshing the specific subfolder where the message landed (INBOX, a label) instead.",
        inputSchema: {
          type: "object",
          properties: {
            folderPath: { type: "string", description: "Folder URI (from listFolders) to refresh" },
            timeoutMs: { type: "integer", description: "Max ms to wait for the fetch to complete (default 15000). Hard-capped at 25000 to stay below the stdio bridge's HTTP request timeout (30000ms); larger values are clamped." },
          },
          required: ["folderPath"],
        },
      },
      {
        name: "getRecentMessages",
        group: "messages", crud: "read",
        title: "Get Recent Messages",
        description: "Get recent messages sorted newest-first from a specific folder or all Inboxes, with date and unread filtering",
        inputSchema: {
          type: "object",
          properties: {
            folderPath: { type: "string", description: "Folder URI (from listFolders) to list messages from. If omitted, returns messages from all Inboxes." },
            daysBack: { type: "number", description: "Only return messages from the last N days (default: 7). Use a larger value like 365 for older messages." },
            maxResults: { type: "number", description: "Maximum number of results (default: 50, max: 200)" },
            offset: { type: "number", description: "Number of results to skip for pagination (default 0). When provided, returns {messages, totalMatches, offset, limit, hasMore} instead of a plain array. Note: totalMatches is capped at 10000." },
            unreadOnly: { type: "boolean", description: "Only return unread messages (default: false)" },
            flaggedOnly: { type: "boolean", description: "Only return flagged/starred messages (default: false)" },
            includeSubfolders: { type: "boolean", description: "If false, only return messages from the specified folder — not its subfolders. Default: true." },
          },
          required: [],
        },
      },
      {
        name: "displayMessage",
        group: "messages", crud: "read",
        title: "Display Message",
        description: "Open or navigate to a message in the Thunderbird GUI. Use '3pane' (default) to select the message in the mail view, 'tab' to open in a new tab, or 'window' to open in a standalone window.",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message ID (from searchMessages results)" },
            folderPath: { type: "string", description: "The folder URI path (from searchMessages results)" },
            displayMode: { type: "string", enum: ["3pane", "tab", "window"], description: "How to display: '3pane' (navigate in mail view, default), 'tab' (new tab), or 'window' (new window)" },
          },
          required: ["messageId", "folderPath"],
        },
      },
      {
        name: "deleteMessages",
        group: "messages", crud: "delete",
        title: "Delete Messages",
        description: "Delete messages from a folder. Drafts are moved to Trash instead of permanently deleted.",
        inputSchema: {
          type: "object",
          properties: {
            messageIds: { type: "array", items: { type: "string" }, description: "Array of message IDs to delete" },
            folderPath: { type: "string", description: "The folder URI containing the messages (from listFolders or searchMessages results)" },
          },
          required: ["messageIds", "folderPath"],
        },
      },
      {
        name: "updateMessage",
        group: "messages", crud: "update",
        title: "Update Message",
        description: "Update one or more messages' read/flagged/tagged state and optionally move them. Supply messageId for a single message or messageIds for bulk operations. Tags are Thunderbird keywords (e.g. '$label1' for Important, '$label2' for Work, or any custom string). Note: combining tags with moveTo/trash on IMAP may not preserve tags on the moved copy — use separate calls if needed.",
        inputSchema: {
          type: "object",
          properties: {
            messageId: { type: "string", description: "A single message ID (from searchMessages results). Required unless messageIds is provided." },
            messageIds: { type: "array", items: { type: "string" }, description: "Array of message IDs for bulk operations. Required unless messageId is provided." },
            folderPath: { type: "string", description: "The folder URI containing the message(s) (from searchMessages results)" },
            read: { type: "boolean", description: "Set to true/false to mark read/unread (optional)" },
            flagged: { type: "boolean", description: "Set to true/false to flag/unflag (optional)" },
            addTags: { type: "array", items: { type: "string" }, description: "Tag keywords to add (e.g. ['$label1', 'project-x']). Thunderbird built-in tags: $label1 (Important), $label2 (Work), $label3 (Personal), $label4 (To Do), $label5 (Later)" },
            removeTags: { type: "array", items: { type: "string" }, description: "Tag keywords to remove from the message(s)" },
            moveTo: { type: "string", description: "Destination folder URI (optional). Cannot be used with trash." },
            trash: { type: "boolean", description: "Set to true to move message to Trash (optional). Cannot be used with moveTo." },
          },
          required: ["folderPath"],
        },
      },
      {
        name: "createFolder",
        group: "folders", crud: "create",
        title: "Create Folder",
        description: "Create a new mail subfolder under an existing folder. Note: on IMAP accounts, server-side completion is asynchronous; verify with listFolders.",
        inputSchema: {
          type: "object",
          properties: {
            parentFolderPath: { type: "string", description: "URI of the parent folder (from listFolders)" },
            name: { type: "string", description: "Name for the new subfolder" },
          },
          required: ["parentFolderPath", "name"],
        },
      },
      {
        name: "renameFolder",
        group: "folders", crud: "update",
        title: "Rename Folder",
        description: "Rename an existing mail folder. Note: on IMAP accounts, server-side completion is asynchronous; verify with listFolders.",
        inputSchema: {
          type: "object",
          properties: {
            folderPath: { type: "string", description: "URI of the folder to rename (from listFolders)" },
            newName: { type: "string", description: "New name for the folder" },
          },
          required: ["folderPath", "newName"],
        },
      },
      {
        name: "deleteFolder",
        group: "folders", crud: "delete",
        title: "Delete Folder",
        description: "Delete a mail folder and all its contents. Moves to Trash, or permanently deletes if already in Trash. Note: permanent deletion may prompt the user for confirmation. On IMAP accounts, server-side completion is asynchronous; verify with listFolders.",
        inputSchema: {
          type: "object",
          properties: {
            folderPath: { type: "string", description: "URI of the folder to delete (from listFolders)" },
          },
          required: ["folderPath"],
        },
      },
      {
        name: "emptyTrash",
        group: "folders", crud: "delete",
        title: "Empty Trash",
        description: "Permanently delete all messages in the Trash folder for an account.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID (from listAccounts). If omitted, empties Trash for all accessible accounts." },
          },
          required: [],
        },
      },
      {
        name: "emptyJunk",
        group: "folders", crud: "delete",
        title: "Empty Junk",
        description: "Permanently delete all messages in the Junk/Spam folder for an account.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID (from listAccounts). If omitted, empties Junk for all accessible accounts." },
          },
          required: [],
        },
      },
      {
        name: "moveFolder",
        group: "folders", crud: "update",
        title: "Move Folder",
        description: "Move a mail folder to a new parent folder within the same account. Note: on IMAP accounts, server-side completion is asynchronous; verify with listFolders.",
        inputSchema: {
          type: "object",
          properties: {
            folderPath: { type: "string", description: "URI of the folder to move (from listFolders)" },
            newParentPath: { type: "string", description: "URI of the destination parent folder (from listFolders)" },
          },
          required: ["folderPath", "newParentPath"],
        },
      },
      {
        name: "listFilters",
        group: "filters", crud: "read",
        title: "List Filters",
        description: "List all mail filters/rules for an account with their conditions and actions",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID from listAccounts (omit for all accounts)" },
          },
          required: [],
        },
      },
      {
        name: "createFilter",
        group: "filters", crud: "create",
        title: "Create Filter",
        description: "Create a new mail filter rule on an account",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID" },
            name: { type: "string", description: "Filter name" },
            enabled: { type: "boolean", description: "Whether filter is active (default: true)" },
            type: { type: "number", description: "Filter type bitmask (default: 17 = inbox + manual). 1=inbox, 16=manual, 32=post-plugin, 64=post-outgoing" },
            conditions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  attrib: { type: "string", description: "Attribute: subject, from, to, cc, toOrCc, body, date, priority, status, size, ageInDays, hasAttachment, junkStatus, tag, otherHeader" },
                  op: { type: "string", description: "Operator: contains, doesntContain, is, isnt, isEmpty, beginsWith, endsWith, isGreaterThan, isLessThan, isBefore, isAfter, matches, doesntMatch" },
                  value: { type: "string", description: "Value to match against" },
                  booleanAnd: { type: "boolean", description: "true=AND with previous, false=OR (default: true)" },
                  header: { type: "string", description: "Custom header name (only when attrib is otherHeader)" },
                },
              },
              description: "Array of filter conditions",
            },
            actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", description: "Action: moveToFolder, copyToFolder, markRead, markUnread, markFlagged, addTag, changePriority, delete, stopExecution, forward, reply" },
                  value: { type: "string", description: "Action parameter (folder URI for move/copy, tag name for addTag, priority for changePriority, email for forward)" },
                },
              },
              description: "Array of actions to perform",
            },
            insertAtIndex: { type: "number", description: "Position to insert (0 = top priority, default: end of list)" },
          },
          required: ["accountId", "name", "conditions", "actions"],
        },
      },
      {
        name: "updateFilter",
        group: "filters", crud: "update",
        title: "Update Filter",
        description: "Modify an existing filter's properties, conditions, or actions",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID" },
            filterIndex: { type: "number", description: "Filter index (from listFilters)" },
            name: { type: "string", description: "New filter name (optional)" },
            enabled: { type: "boolean", description: "Enable/disable (optional)" },
            type: { type: "number", description: "New filter type bitmask (optional)" },
            conditions: {
              type: "array",
              description: "Replace all conditions (optional, same format as createFilter)",
              items: {
                type: "object",
                properties: {
                  attrib: { type: "string", description: "Attribute: subject, from, to, cc, toOrCc, body, date, priority, status, size, ageInDays, hasAttachment, junkStatus, tag, otherHeader" },
                  op: { type: "string", description: "Operator: contains, doesntContain, is, isnt, isEmpty, beginsWith, endsWith, isGreaterThan, isLessThan, isBefore, isAfter, matches, doesntMatch" },
                  value: { type: "string", description: "Value to match against" },
                  booleanAnd: { type: "boolean", description: "true=AND with previous, false=OR (default: true)" },
                  header: { type: "string", description: "Custom header name (only when attrib is otherHeader)" },
                },
              },
            },
            actions: {
              type: "array",
              description: "Replace all actions (optional, same format as createFilter)",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", description: "Action: moveToFolder, copyToFolder, markRead, markUnread, markFlagged, addTag, changePriority, delete, stopExecution, forward, reply" },
                  value: { type: "string", description: "Action parameter (folder URI for move/copy, tag name for addTag, priority for changePriority, email for forward)" },
                },
              },
            },
          },
          required: ["accountId", "filterIndex"],
        },
      },
      {
        name: "deleteFilter",
        group: "filters", crud: "delete",
        title: "Delete Filter",
        description: "Delete a mail filter by index",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID" },
            filterIndex: { type: "number", description: "Filter index to delete (from listFilters)" },
          },
          required: ["accountId", "filterIndex"],
        },
      },
      {
        name: "reorderFilters",
        group: "filters", crud: "update",
        title: "Reorder Filters",
        description: "Move a filter to a different position in the execution order",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID" },
            fromIndex: { type: "number", description: "Current filter index" },
            toIndex: { type: "number", description: "Target index (0 = highest priority)" },
          },
          required: ["accountId", "fromIndex", "toIndex"],
        },
      },
      {
        name: "applyFilters",
        group: "filters", crud: "update",
        title: "Apply Filters",
        description: "Manually run all enabled filters on a folder to organize existing messages",
        inputSchema: {
          type: "object",
          properties: {
            accountId: { type: "string", description: "Account ID (uses its filters)" },
            folderPath: { type: "string", description: "Folder URI to apply filters to (from listFolders)" },
          },
          required: ["accountId", "folderPath"],
        },
      },
      {
        name: "getAccountAccess",
        group: "system", crud: "read",
        title: "Get Account Access",
        description: "Get the current account access control list. Shows which accounts the MCP server can access. Account access is configured by the user in the extension settings page (Tools > Add-ons > Thunderbird MCP > Options) and cannot be changed via MCP tools.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];

    // Validate tool metadata: every tool must have valid group and crud fields.
    // This prevents tools from being silently hidden in the settings UI.
    const toolErrors = [];
    for (const tool of tools) {
      if (!tool.group || !VALID_GROUPS.includes(tool.group)) {
        toolErrors.push(`Tool "${tool.name}" has invalid or missing group: "${tool.group}" (valid: ${VALID_GROUPS.join(", ")})`);
      }
      if (!tool.crud || !VALID_CRUD.includes(tool.crud)) {
        toolErrors.push(`Tool "${tool.name}" has invalid or missing crud: "${tool.crud}" (valid: ${VALID_CRUD.join(", ")})`);
      }
    }
    if (toolErrors.length > 0) {
      console.error("thunderbird-mcp: Tool metadata validation failed:\n  " + toolErrors.join("\n  "));
    }

    // Derive ALL_TOOL_NAMES from the tools array (single source of truth)
    const ALL_TOOL_NAMES = tools.map(t => t.name);

    // Group display order for settings UI
    const GROUP_ORDER = { system: 0, messages: 1, folders: 2, contacts: 3, calendar: 4, filters: 5 };
    // Group display labels
    const GROUP_LABELS = { system: "System", messages: "Messages", folders: "Folders", contacts: "Contacts", calendar: "Calendar", filters: "Filters" };

    /**
     * Generate a cryptographically random auth token (hex string).
     * Used to authenticate bridge requests to the HTTP server.
     */
    function generateAuthToken() {
      const bytes = new Uint8Array(32);
      // crypto.getRandomValues is not available in Thunderbird experiment API scope;
      // use the XPCOM random generator instead.
      const rng = Cc["@mozilla.org/security/random-generator;1"]
        .createInstance(Ci.nsIRandomGenerator);
      const randomBytes = rng.generateRandomBytes(32);
      for (let i = 0; i < 32; i++) bytes[i] = randomBytes[i];
      return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    }

    function getStableAuthTokenPref() {
      try {
        const pref = Services.prefs.getStringPref(PREF_STABLE_AUTH_TOKEN, "");
        const token = pref.trim();
        if (!token) {
          if (pref) {
            console.warn("thunderbird-mcp: stableAuthToken preference is malformed; expected 64 lowercase hex characters, ignoring stored value");
          }
          return "";
        }
        if (!AUTH_TOKEN_PATTERN.test(token)) {
          console.warn("thunderbird-mcp: stableAuthToken preference is malformed; expected 64 lowercase hex characters, ignoring stored value");
          return "";
        }
        return token;
      } catch {
        return "";
      }
    }

    function readConnectionInfo() {
      const tmpDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
      tmpDir.append("thunderbird-mcp");
      const connFile = tmpDir.clone();
      connFile.append("connection.json");
      if (!connFile.exists()) {
        return { path: connFile.path, data: null };
      }
      const fis = Cc["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Ci.nsIFileInputStream);
      fis.init(connFile, 0x01, 0, 0);
      const sis = Cc["@mozilla.org/scriptableinputstream;1"]
        .createInstance(Ci.nsIScriptableInputStream);
      sis.init(fis);
      const text = sis.read(sis.available());
      sis.close();
      return { path: connFile.path, data: JSON.parse(text) };
    }

    return {
      mcpServer: {
        start: async function() {
          // Guard against double-start on extension reload (port conflict)
          if (globalThis.__tbMcpStartPromise) {
            return await globalThis.__tbMcpStartPromise;
          }
          const startPromise = (async () => {
          try {
            // Stop any previously running server (e.g. extension reload)
            if (globalThis.__tbMcpServer) {
              try { globalThis.__tbMcpServer.stop(() => {}); } catch { /* ignore */ }
              globalThis.__tbMcpServer = null;
            }
            // ── DDD layer wiring: build the shared ctx (the "DI container") ──
            //
            // A WebExtension Experiment API loads ONE parent script (this file)
            // and supports neither a multi-script manifest nor ES `import`. The
            // only mechanism is Services.scriptloader.loadSubScript + a single
            // shared object. So `ctx` IS the dependency-injection container and
            // a deterministic load order IS the wiring graph.
            //
            // Load order (dependency order):
            //   infrastructure: services → connection → auth → audit → access → dispatch
            //   domain entities: domain/entities/* (pure; loaded by the layer that needs them)
            //   contacts (reference domain): entity → adapter → service → tools
            //   legacy domains (not yet migrated): mail, compose, calendar, filters
            //
            // Each module exports register(ctx): it destructures what it needs
            // from ctx and Object.assign()s its exports back. After loading we
            // pull the registered functions into local const bindings so the
            // request handler / dispatch below can keep calling them by their
            // original bare names.
            const ctx = {
              // XPCOM globals (file-scope globals, shared down to every layer)
              Cc, Ci, Services, ChromeUtils,
              // File-scope constants the layers consume
              MAX_SEARCH_RESULTS_CAP, DEFAULT_MAX_RESULTS,
              PREF_ALLOWED_ACCOUNTS, PREF_DISABLED_TOOLS, PREF_BLOCK_SKIPREVIEW,
              PREF_BLOCK_FILTER_FORWARD_REPLY, PREF_BLOCK_CONTACT_WRITES,
              PREF_BLOCK_MAILBOX_EXPORT, UNDISABLEABLE_TOOLS, INTERNAL_KEYWORDS,
              // Pure helpers from security_helpers.js (already in scope)
              isSensitiveFilePath, sanitizeHeaderLine, UNTRUSTED_CLOSE,
              wrapUntrustedBody, wrapUntrustedPreview, countRecipients,
              summarizeAttachmentsForAudit, isSafeMarkdownHref, isSafeImageSrc,
              escapeMarkdownLinkText, renderMarkdownLink, isSystemPrincipalFetchAllowed,
              validateAgainstSchema, createRateLimiterState, consumeRateLimit,
              inspectRateLimits, attachmentSaveLooksWrong, parseAttachmentPartsFromRawMime,
              // The tool METADATA registry (single source of truth; a structural
              // test parses this file for it, so it stays defined here).
              tools,
              // Auth-token generators stay in the OUTER getAPI scope (settings
              // API methods call them outside start()); pass them down so
              // infrastructure/auth.js can resolve the active token.
              getStableAuthTokenPref, generateAuthToken,
              // Shared mutable state that the shutdown path (outside start) and
              // the compose/mail domains both touch.
              _attachTimers, _tempAttachFiles, _claimedComposeWindows,
            };

            // Helper: load a register(ctx) sub-script and invoke it. Same
            // { module: { exports: {} } } shim used for security_helpers.js.
            function __loadLayer(relPath) {
              const __scope = { module: { exports: {} } };
              Services.scriptloader.loadSubScript(
                "resource://thunderbird-mcp/mcp_server/" + relPath + "?" + Date.now(),
                __scope
              );
              __scope.module.exports(ctx);
            }

            // 1) Infrastructure (cross-cutting), in dependency order.
            for (const __m of [
              "infrastructure/services.js",
              "infrastructure/connection.js",
              "infrastructure/auth.js",
              "infrastructure/audit.js",
              "infrastructure/access.js",
              "infrastructure/dispatch.js",
            ]) {
              __loadLayer(__m);
            }

            // Pull the infra bindings the rest of start() uses by bare name.
            const {
              HttpServer, NetUtil, MailServices,
              cal, CalEvent, CalTodo, GlodaMsgSearcher,
              readRequestBody, paginate,
              writeConnectionInfo, removeConnectionInfo, timingSafeEqual,
              authToken,
              AUDIT_LOG_SUBDIR, AUDIT_LOG_FILENAME,
              appendComposeAudit, readAuditLog, findIdempotentEntry, clearAuditLog,
              consumeRateLimitFor, inspectRateLimitsState,
              getAllowedAccountIds, isAccountAllowed, isSkipReviewBlocked,
              isFilterForwardReplyBlocked, isContactWritesBlocked, isMailboxExportBlocked,
              getDisabledTools, isToolEnabled, isFolderAccessible, getAccessibleFolder,
              getAccessibleAccounts, listAccounts, getAccountAccess, listFolders,
              getUserTags, stripHtml, extractBodyContent, extractPlainTextBody,
              toolSchemas, validateToolArgs, coerceToolArgs, callTool,
            } = ctx;

            // UNTRUSTED_OPEN/CLOSE + wrapUntrustedBody/Preview live in security_helpers.js.

	            /**
	             * Opens a folder and its message database.
	             * Best-effort refresh for IMAP folders (db may be stale).
	             * Returns { folder, db } or { error }.
	             */
	            function openFolder(folderPath) {
	              try {
	                const result = getAccessibleFolder(folderPath);
	                if (result.error) return result;
	                const folder = result.folder;

	                // Attempt to refresh IMAP folders. This is async and may not
	                // complete before we read, but helps with stale data.
	                if (folder.server && folder.server.type === "imap") {
	                  try {
	                    folder.updateFolder(null);
	                  } catch {
	                    // updateFolder may fail, continue anyway
	                  }
	                }

	                const db = folder.msgDatabase;
	                if (!db) {
	                  return { error: "Could not access folder database" };
	                }

	                return { folder, db };
	              } catch (e) {
	                return { error: e.toString() };
	              }
	            }

	            // Hard cap on the linear-enumeration fallback when
	            // getMsgHdrForMessageID misses. A 200k-message archive walked
	            // header-by-header takes tens of seconds; we'd rather fail
	            // fast and tell the caller to pass a smaller folderPath than
	            // burn an agent's clock on a single lookup.
	            const FIND_MESSAGE_SCAN_CAP = 50000;

	            function findMessage(messageId, folderPath) {
	              const opened = openFolder(folderPath);
	              if (opened.error) return opened;

	              const { folder, db } = opened;
	              let msgHdr = null;

	              const hasDirectLookup = typeof db.getMsgHdrForMessageID === "function";
	              if (hasDirectLookup) {
	                try {
	                  msgHdr = db.getMsgHdrForMessageID(messageId);
	                } catch {
	                  msgHdr = null;
	                }
	              }

	              if (!msgHdr) {
	                let scanned = 0;
	                let capped = false;
	                for (const hdr of db.enumerateMessages()) {
	                  scanned++;
	                  if (scanned > FIND_MESSAGE_SCAN_CAP) { capped = true; break; }
	                  if (hdr.messageId === messageId) {
	                    msgHdr = hdr;
	                    break;
	                  }
	                }
	                if (!msgHdr && capped) {
	                  return {
	                    error: `Message not found after scanning ${FIND_MESSAGE_SCAN_CAP} headers in this folder. Pass a more specific folderPath or use searchMessages first to locate the exact folder.`,
	                  };
	                }
	              }

	              if (!msgHdr) {
	                return { error: `Message not found: ${messageId}` };
	              }

	              return { msgHdr, folder, db };
	            }

            /**
             * Validate compose parameters without sending. Mirrors the
             * argument shape of composeMail and reports what WOULD happen:
             * resolved identity, recipient counts, attachment status per
             * entry (resolved size, sensitive-path verdict, oversize
             * verdict, success/failure), rendered subject after header
             * sanitization, and the skipReview-block pref state.
             *
             * Pure read-only -- nothing is queued, drafted, or sent. Useful
             * for an agent that wants to self-check a compose call before
             * committing to it.
             */

            /**
             * Snapshot of the agent's sandbox: what tools are available, what
             * accounts are reachable, what gates are on, how much rate-limit
             * budget remains. Designed for the LLM to call ONCE at the start
             * of a session to plan around constraints rather than discovering
             * them via failed calls.
             */
            function getServerCapabilities() {
              const allTools = tools.map(t => t.name);
              const enabled = allTools.filter(n => isToolEnabled(n));
              const disabled = allTools.filter(n => !isToolEnabled(n));
              const accessibleAccounts = getAccessibleAccounts().map(a => ({
                id: a.key,
                name: a.incomingServer && a.incomingServer.prettyName ? a.incomingServer.prettyName : a.key,
              }));
              const safeguards = {
                blockSkipReview: isSkipReviewBlocked(),
                blockFilterForwardReply: isFilterForwardReplyBlocked(),
                blockContactWrites: isContactWritesBlocked(),
              };
              return {
                serverVersion: getExtVersion(),
                tools: { enabled, disabled, total: allTools.length },
                accessibleAccounts,
                accessMode: getAllowedAccountIds().length === 0 ? "all" : "restricted",
                safeguards,
                rateLimits: inspectRateLimitsState(),
                auditLogPath: `<ProfD>/${AUDIT_LOG_SUBDIR}/${AUDIT_LOG_FILENAME}`,
              };
            }

            // Shared body/folder/message helpers defined above in start()
            // (openFolder, findMessage, stripHtml, extractBodyContent,
            // extractPlainTextBody) plus the infra helpers and state are now
            // exposed on ctx for the domain modules to consume. The temp-
            // attachment / timer / claimed-window state stays owned here
            // because the shutdown cleanup (outside start) drains it.
            Object.assign(ctx, {
              openFolder, findMessage,
            });

            // ── Domain module wiring ──
            //
            // Every domain is now fully migrated to the deep-DDD 4-layer split:
            // pure entity → infrastructure adapter (XPCOM) → application service
            // (orchestration) → interface tools (thin handlers). Each interface
            // module registers its handlers into the dispatch registry via
            // ctx.registerToolHandler, so callTool() routes them there. The
            // legacyCallTool switch below now serves ONLY the cross-cutting
            // account/system tools (listAccounts, listFolders, getAccountAccess,
            // getServerCapabilities, getAuditLog) that belong to no domain.
            //
            // Load order per domain is dependency order: entity → adapter →
            // service → tools (a service destructures its adapter+entity off ctx
            // at register time, so both must already be loaded).
            for (const __layer of [
              // contacts (reference domain)
              "domain/entities/contact.js",
              "infrastructure/contacts_adapter.js",
              "application/contacts_service.js",
              "interface/contacts_tools.js",
              // mail
              "domain/entities/message.js",
              "infrastructure/mail_adapter.js",
              "application/mail_service.js",
              "interface/mail_tools.js",
              // compose (adapter consumes the shutdown state already on ctx;
              // service consumes findMessage, assigned to ctx above)
              "domain/entities/compose.js",
              "infrastructure/compose_adapter.js",
              "application/compose_service.js",
              "interface/compose_tools.js",
              // calendar
              "domain/entities/calendar.js",
              "infrastructure/calendar_adapter.js",
              "application/calendar_service.js",
              "interface/calendar_tools.js",
              // filters
              "domain/entities/filter.js",
              "infrastructure/filters_adapter.js",
              "application/filters_service.js",
              "interface/filters_tools.js",
            ]) {
              __loadLayer(__layer);
            }

            // validateToolArgs / coerceToolArgs / toolSchemas now live in
            // infrastructure/dispatch.js and were destructured from ctx above.

            // The legacy dispatch switch: serves only the cross-cutting
            // account/system tools that belong to no domain. callTool (from
            // dispatch.js) checks the interface-registered handlers first and
            // falls back to this. Every domain tool (contacts/mail/compose/
            // calendar/filters) is intentionally absent — they route through
            // their registered interface handlers.
            async function legacyCallTool(name, args) {
              switch (name) {
                case "listAccounts":
                  return listAccounts();
                case "listFolders":
                  return listFolders(args.accountId, args.folderPath);
                case "getServerCapabilities":
                  return getServerCapabilities();
                case "getAuditLog": {
                  const filter = {};
                  if (typeof args.tool === "string") filter.tool = args.tool;
                  if (typeof args.since === "string") filter.since = args.since;
                  if (typeof args.until === "string") filter.until = args.until;
                  const max = typeof args.maxEntries === "number" ? args.maxEntries : 200;
                  return readAuditLog(max, filter);
                }
                case "getAccountAccess":
                  return getAccountAccess();
                default:
                  throw new Error(`Unknown tool: ${name}`);
              }
            }
            // Register the legacy switch as the dispatch fallback. callTool
            // (destructured from ctx above) consults the interface-registered
            // handlers first, then this.
            ctx.legacyCallTool = legacyCallTool;

            const server = new HttpServer();

            const mcpHandler = (req, res) => {
              res.processAsync();

              // Verify auth token on ALL requests (including non-POST) to
              // prevent unauthenticated probing of the server.
              let reqToken = "";
              try {
                reqToken = req.getHeader("Authorization") || "";
              } catch {
                // getHeader throws if header is missing in httpd.sys.mjs
              }
              if (!timingSafeEqual(reqToken, `Bearer ${authToken}`)) {
                res.setStatusLine("1.1", 403, "Forbidden");
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: "Invalid or missing auth token" }
                }));
                res.finish();
                return;
              }

              if (req.method !== "POST") {
                res.setStatusLine("1.1", 405, "Method Not Allowed");
                res.setHeader("Allow", "POST", false);
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: "Method not allowed" }
                }));
                res.finish();
                return;
              }

              // Reject oversized request bodies to prevent memory exhaustion
              let contentLength = 0;
              try {
                contentLength = parseInt(req.getHeader("Content-Length"), 10) || 0;
              } catch {
                // Header missing — will be 0
              }
              if (contentLength > MAX_REQUEST_BODY) {
                res.setStatusLine("1.1", 413, "Payload Too Large");
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: "Request body too large" }
                }));
                res.finish();
                return;
              }

              let message;
              try {
                message = JSON.parse(readRequestBody(req));
              } catch {
                res.setStatusLine("1.1", 200, "OK");
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32700, message: "Parse error" }
                }));
                res.finish();
                return;
              }

              if (!message || typeof message !== "object" || Array.isArray(message)) {
                res.setStatusLine("1.1", 200, "OK");
                res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                res.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: "Invalid Request" }
                }));
                res.finish();
                return;
              }

              const { id, method, params } = message;

              // Notifications don't expect a response
              if (typeof method === "string" && method.startsWith("notifications/")) {
                res.setStatusLine("1.1", 204, "No Content");
                res.finish();
                return;
              }

              (async () => {
                try {
                  let result;
                  switch (method) {
                    case "initialize": {
                      // Per MCP lifecycle: respond with the requested version if
                      // we support it, otherwise the latest version we know.
                      // Behavior never depends on the version inside Thunderbird,
                      // so we accept any well-known protocol version.
                      const requested = params?.protocolVersion;
                      if (typeof requested !== "string") {
                        res.setStatusLine("1.1", 200, "OK");
                        res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                        res.write(JSON.stringify({
                          jsonrpc: "2.0",
                          id: id ?? null,
                          error: { code: -32602, message: "Invalid params: protocolVersion must be a string" }
                        }));
                        res.finish();
                        return;
                      }
                      const negotiated = MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)
                        ? requested
                        : MCP_LATEST_PROTOCOL_VERSION;
                      result = {
                        protocolVersion: negotiated,
                        capabilities: { tools: {} },
                        serverInfo: { name: "thunderbird-mcp", version: getExtVersion() }
                      };
                      break;
                    }
                    case "resources/list":
                      result = { resources: [] };
                      break;
                    case "prompts/list":
                      result = { prompts: [] };
                      break;
                    case "tools/list":
                      // Strip internal metadata (group, crud, title) — only expose MCP-spec fields
                      result = { tools: tools.filter(t => isToolEnabled(t.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
                      break;
                    case "tools/call":
                      if (!params?.name) {
                        throw new Error("Missing tool name");
                      }
                      if (!isToolEnabled(params.name)) {
                        throw new Error(`Tool is disabled: ${params.name}`);
                      }
                      // Rate-limit check. Runs BEFORE coerce/validate so an
                      // agent stuck in a tight loop is throttled even if it
                      // is sending malformed arguments.
                      {
                        const rl = consumeRateLimitFor(params.name);
                        if (!rl.allowed) {
                          throw new Error(
                            `Rate limit exceeded for '${params.name}': ` +
                            `${rl.limit} calls per ${Math.round(rl.windowMs / 1000)}s. ` +
                            `Retry in ${Math.ceil(rl.resetAfterMs / 1000)}s.`
                          );
                        }
                      }
                      {
                        const toolArgs = coerceToolArgs(params.name, params.arguments || {});
                        const validationErrors = validateToolArgs(params.name, toolArgs);
                        if (validationErrors.length > 0) {
                          throw new Error(`Invalid parameters for '${params.name}': ${validationErrors.join("; ")}`);
                        }
                        result = {
                          content: [{
                            type: "text",
                            text: JSON.stringify(await callTool(params.name, toolArgs), null, 2)
                          }]
                        };
                      }
                      break;
                    default:
                      res.setStatusLine("1.1", 200, "OK");
                      res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                      res.write(JSON.stringify({
                        jsonrpc: "2.0",
                        id: id ?? null,
                        error: { code: -32601, message: "Method not found" }
                      }));
                      res.finish();
                      return;
                  }
                  res.setStatusLine("1.1", 200, "OK");
                  // charset=utf-8 is critical for proper emoji handling in responses
                  res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                  res.write(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
                } catch (e) {
                  res.setStatusLine("1.1", 200, "OK");
                  res.setHeader("Content-Type", "application/json; charset=utf-8", false);
                  res.write(JSON.stringify({
                    jsonrpc: "2.0",
                    id: id ?? null,
                    error: { code: -32000, message: e.toString() }
                  }));
                }
                res.finish();
              })().catch((e) => {
                console.error("thunderbird-mcp: unhandled dispatch error:", e);
                try { res.finish(); } catch {}
              });
            };
            // Serve the MCP JSON-RPC handler at /mcp (canonical, matches the
            // other MCP servers) and at / (backwards compatibility).
            server.registerPathHandler("/mcp", mcpHandler);
            server.registerPathHandler("/", mcpHandler);

            // Try the default port first, then fall back to nearby ports
            let boundPort = null;
            for (let attempt = 0; attempt < MCP_MAX_PORT_ATTEMPTS; attempt++) {
              const tryPort = MCP_DEFAULT_PORT + attempt;
              try {
                server.start(tryPort);
                boundPort = tryPort;
                break;
              } catch (portErr) {
                if (attempt === MCP_MAX_PORT_ATTEMPTS - 1) {
                  throw new Error(`Could not bind to any port in range ${MCP_DEFAULT_PORT}-${tryPort}: ${portErr}`);
                }
                console.warn(`Port ${tryPort} in use, trying ${tryPort + 1}...`);
              }
            }

            globalThis.__tbMcpServer = server;
            let connFilePath;
            try {
              connFilePath = writeConnectionInfo(boundPort, authToken);
            } catch (writeErr) {
              // Connection file write failed -- stop the orphaned server
              try { server.stop(() => {}); } catch (e) { console.error("thunderbird-mcp: server.stop failed:", e); }
              globalThis.__tbMcpServer = null;
              throw writeErr;
            }
            console.log(`Thunderbird MCP server listening on port ${boundPort}`);
            console.log(`Connection info written to ${connFilePath}`);
            // Clear any prior start error now that we're fully up.
            globalThis.__tbMcpStartError = null;
            return { success: true, port: boundPort };
          } catch (e) {
            console.error("Failed to start MCP server:", e);
            // Persist the error so getServerInfo can surface it in the
            // options page; otherwise the user just sees "Running" forever
            // while the actual error sits in the Error Console.
            const errStr = e && e.toString ? e.toString() : String(e);
            const stack = e && e.stack ? e.stack : "";
            globalThis.__tbMcpStartError = errStr;
            // Also write to <TmpD>/thunderbird-mcp/start-error.log so the
            // error survives a TB restart and can be inspected from the
            // host shell even when the Error Console isn't open. Best-
            // effort; failures here must not mask the original problem.
            try {
              const tmpDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
              tmpDir.append("thunderbird-mcp");
              if (!tmpDir.exists()) tmpDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
              const f = tmpDir.clone();
              f.append("start-error.log");
              const out = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
              out.init(f, 0x02 | 0x08 | 0x20, 0o600, 0);
              const conv = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
              conv.init(out, "UTF-8");
              conv.writeString(new Date().toISOString() + " " + errStr + "\n" + stack + "\n");
              conv.close();
            } catch { /* best-effort */ }
            // Stop server if it was started but something else failed
            if (globalThis.__tbMcpServer) {
              try { globalThis.__tbMcpServer.stop(() => {}); } catch (e) { console.error("thunderbird-mcp: server.stop failed:", e); }
              globalThis.__tbMcpServer = null;
            }
            // Clear cached promise so a retry can attempt to bind again
            globalThis.__tbMcpStartPromise = null;
            removeConnectionInfo();
            return { success: false, error: e.toString() };
          }
          })();
          // Set sentinel BEFORE awaiting to prevent race with concurrent start() calls
          globalThis.__tbMcpStartPromise = startPromise;
          return await startPromise;
        },

        getServerInfo: async function() {
          let port = null;
          let connectionFile = null;
          let buildVersion = null;
          let buildDate = null;

          // Read build info from bundled file via resource: protocol
          try {
            const uri = Services.io.newURI("resource://thunderbird-mcp/buildinfo.json");
            const channel = Services.io.newChannelFromURI(uri, null,
              Services.scriptSecurityManager.getSystemPrincipal(), null,
              Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
              Ci.nsIContentPolicy.TYPE_OTHER);
            const sis = Cc["@mozilla.org/scriptableinputstream;1"]
              .createInstance(Ci.nsIScriptableInputStream);
            sis.init(channel.open());
            const text = sis.read(sis.available());
            sis.close();
            const bi = JSON.parse(text);
            buildVersion = bi.version || bi.commit || null;
            buildDate = bi.builtAt || null;
          } catch (e) {
            // buildinfo.json may legitimately be absent in dev builds; surface anything else.
            if (e?.name !== "NS_ERROR_FILE_NOT_FOUND") {
              console.warn("thunderbird-mcp: read buildinfo failed:", e);
            }
          }

          // Read connection info from temp file using XPCOM file I/O
          try {
            const connInfo = readConnectionInfo();
            connectionFile = connInfo.path;
            if (connInfo.data) {
              port = connInfo.data.port || null;
            }
          } catch (e) {
            // Connection file is absent before the server first binds; log other faults.
            if (e?.name !== "NS_ERROR_FILE_NOT_FOUND") {
              console.warn("thunderbird-mcp: read connection info failed:", e);
            }
          }

          // `running` is true only when the HTTP server has been instantiated
          // and the start promise resolved cleanly. Checking
          // `!!globalThis.__tbMcpStartPromise` alone was misleading because a
          // rejected promise is still truthy -- the page would say "Running"
          // while the server had silently failed to bind. Surface the actual
          // start error so the options page can show it.
          const startError = globalThis.__tbMcpStartError || null;
          const running = !!globalThis.__tbMcpServer && !startError;
          return {
            running,
            port,
            connectionFile,
            buildVersion,
            buildDate,
            startError,
          };
        },

        getCurrentAuthToken: async function() {
          let authToken = "";
          try {
            const connInfo = readConnectionInfo();
            if (connInfo.data && typeof connInfo.data.token === "string") {
              authToken = connInfo.data.token;
            }
          } catch (e) {
            if (e?.name !== "NS_ERROR_FILE_NOT_FOUND") {
              console.warn("thunderbird-mcp: read auth token failed:", e);
            }
          }
          return { authToken };
        },

        getAccountAccessConfig: async function() {
          const { MailServices } = ChromeUtils.importESModule(
            "resource:///modules/MailServices.sys.mjs"
          );
          let allowed = [];
          try {
            const pref = Services.prefs.getStringPref(PREF_ALLOWED_ACCOUNTS, "");
            if (pref) allowed = JSON.parse(pref);
          } catch (e) {
            // Falls back to "all accounts allowed"; surface the corruption.
            console.warn("thunderbird-mcp: account-access pref is not valid JSON:", e.message);
          }

          const accounts = [];
          for (const account of MailServices.accounts.accounts) {
            const server = account.incomingServer;
            accounts.push({
              id: account.key,
              name: server.prettyName,
              type: server.type,
              allowed: allowed.length === 0 || allowed.includes(account.key),
            });
          }
          return {
            mode: allowed.length === 0 ? "all" : "restricted",
            allowedAccountIds: allowed,
            accounts,
          };
        },

        getToolAccessConfig: async function() {
          // Use same fail-closed parsing as getDisabledTools() so the UI
          // accurately reflects the server's actual state on corrupt prefs
          let disabled = [];
          let corrupt = false;
          try {
            const pref = Services.prefs.getStringPref(PREF_DISABLED_TOOLS, "");
            if (pref) {
              const parsed = JSON.parse(pref);
              if (!Array.isArray(parsed)) {
                corrupt = true;
              } else {
                disabled = parsed;
              }
            }
          } catch {
            corrupt = true;
          }

          // Build tool list with group/crud metadata, sorted by group then CRUD order
          const toolList = tools
            .map(t => ({
              name: t.name,
              group: t.group,
              crud: t.crud,
              enabled: corrupt ? UNDISABLEABLE_TOOLS.has(t.name) : !disabled.includes(t.name),
              undisableable: UNDISABLEABLE_TOOLS.has(t.name),
            }))
            .sort((a, b) => {
              const gA = GROUP_ORDER[a.group] ?? 99;
              const gB = GROUP_ORDER[b.group] ?? 99;
              if (gA !== gB) return gA - gB;
              return (CRUD_ORDER[a.crud] ?? 99) - (CRUD_ORDER[b.crud] ?? 99);
            });
          const result = {
            mode: corrupt ? "error" : (disabled.length === 0 ? "all" : "restricted"),
            disabledTools: disabled,
            groups: GROUP_LABELS,
            tools: toolList,
          };
          if (corrupt) {
            result.error = "Disabled tools preference is corrupt. All non-infrastructure tools are blocked. Save to reset.";
          }
          return result;
        },

        setToolAccess: async function(disabledTools) {
          if (!Array.isArray(disabledTools)) {
            return { error: "disabledTools must be an array" };
          }
          // Validate types first, then semantic checks
          if (!disabledTools.every(t => typeof t === "string")) {
            return { error: "All tool names must be strings" };
          }
          // Reject internal sentinel values
          if (disabledTools.includes("__all__")) {
            return { error: "Invalid tool name: __all__" };
          }
          // Validate: can't disable undisableable tools
          const blocked = disabledTools.filter(t => UNDISABLEABLE_TOOLS.has(t));
          if (blocked.length > 0) {
            return { error: `Cannot disable infrastructure tools: ${blocked.join(", ")}` };
          }

          if (disabledTools.length === 0) {
            try { Services.prefs.clearUserPref(PREF_DISABLED_TOOLS); } catch { /* ignore */ }
          } else {
            Services.prefs.setStringPref(PREF_DISABLED_TOOLS, JSON.stringify(disabledTools));
          }
          return {
            success: true,
            mode: disabledTools.length === 0 ? "all" : "restricted",
            disabledTools,
          };
        },

        setAccountAccess: async function(allowedAccountIds) {
          if (!Array.isArray(allowedAccountIds)) {
            return { error: "allowedAccountIds must be an array" };
          }
          const { MailServices } = ChromeUtils.importESModule(
            "resource:///modules/MailServices.sys.mjs"
          );
          const validIds = new Set();
          for (const account of MailServices.accounts.accounts) {
            validIds.add(account.key);
          }
          const invalid = allowedAccountIds.filter(id => !validIds.has(id));
          if (invalid.length > 0) {
            return { error: `Unknown account IDs: ${invalid.join(", ")}` };
          }

          if (allowedAccountIds.length === 0) {
            try { Services.prefs.clearUserPref(PREF_ALLOWED_ACCOUNTS); } catch { /* ignore */ }
          } else {
            Services.prefs.setStringPref(PREF_ALLOWED_ACCOUNTS, JSON.stringify(allowedAccountIds));
          }
          return {
            success: true,
            mode: allowedAccountIds.length === 0 ? "all" : "restricted",
            allowedAccountIds,
          };
        },

        getBlockSkipReview: async function() {
          let blocked = true;
          try {
            blocked = Services.prefs.getBoolPref(PREF_BLOCK_SKIPREVIEW, true);
          } catch { /* ignore */ }
          return { blockSkipReview: blocked };
        },

        setBlockSkipReview: async function(blockSkipReview) {
          if (typeof blockSkipReview !== "boolean") {
            return { error: "blockSkipReview must be a boolean" };
          }
          // Default is true; persist the explicit value either way so the user's
          // choice survives independent of the default we ship.
          Services.prefs.setBoolPref(PREF_BLOCK_SKIPREVIEW, blockSkipReview);
          return { success: true, blockSkipReview };
        },

        getBlockFilterForwardReply: async function() {
          let blocked = true;
          try {
            blocked = Services.prefs.getBoolPref(PREF_BLOCK_FILTER_FORWARD_REPLY, true);
          } catch { /* ignore */ }
          return { blockFilterForwardReply: blocked };
        },

        setBlockFilterForwardReply: async function(blockFilterForwardReply) {
          if (typeof blockFilterForwardReply !== "boolean") {
            return { error: "blockFilterForwardReply must be a boolean" };
          }
          Services.prefs.setBoolPref(PREF_BLOCK_FILTER_FORWARD_REPLY, blockFilterForwardReply);
          return { success: true, blockFilterForwardReply };
        },

        getBlockContactWrites: async function() {
          let blocked = true;
          try {
            blocked = Services.prefs.getBoolPref(PREF_BLOCK_CONTACT_WRITES, true);
          } catch { /* ignore */ }
          return { blockContactWrites: blocked };
        },

        setBlockContactWrites: async function(blockContactWrites) {
          if (typeof blockContactWrites !== "boolean") {
            return { error: "blockContactWrites must be a boolean" };
          }
          Services.prefs.setBoolPref(PREF_BLOCK_CONTACT_WRITES, blockContactWrites);
          return { success: true, blockContactWrites };
        },

        getBlockMailboxExport: async function() {
          let blocked = true;
          try {
            blocked = Services.prefs.getBoolPref(PREF_BLOCK_MAILBOX_EXPORT, true);
          } catch { /* ignore */ }
          return { blockMailboxExport: blocked };
        },

        setBlockMailboxExport: async function(blockMailboxExport) {
          if (typeof blockMailboxExport !== "boolean") {
            return { error: "blockMailboxExport must be a boolean" };
          }
          Services.prefs.setBoolPref(PREF_BLOCK_MAILBOX_EXPORT, blockMailboxExport);
          return { success: true, blockMailboxExport };
        },

        readAuditLog: async function(maxEntries, filter) {
          // Defensive normalization of the filter object so a malformed call
          // from options.html cannot crash the experiment-API scope. Any
          // throw inside readAuditLog is reduced to a structured error so
          // the options page sees a useful message instead of the generic
          // "An unexpected error occurred" that Mozilla wraps thrown
          // experiment-API errors in.
          try {
            const safeFilter = (filter && typeof filter === "object" && !Array.isArray(filter)) ? filter : null;
            return readAuditLog(maxEntries, safeFilter);
          } catch (e) {
            return { entries: [], totalScanned: 0, truncated: false, errors: [{ reason: String(e) }] };
          }
        },

        clearAuditLog: async function() {
          try { return clearAuditLog(); }
          catch (e) { return { error: String(e) }; }
        },

        getStableAuthToken: async function() {
          return { stableAuthToken: getStableAuthTokenPref() };
        },

        setStableAuthToken: async function(stableAuthToken) {
          if (typeof stableAuthToken !== "string") {
            return { error: "stableAuthToken must be a string" };
          }
          stableAuthToken = stableAuthToken.trim();
          if (stableAuthToken && !AUTH_TOKEN_PATTERN.test(stableAuthToken)) {
            return { error: "stableAuthToken must be empty or 64 lowercase hex characters" };
          }
          if (stableAuthToken) {
            Services.prefs.setStringPref(PREF_STABLE_AUTH_TOKEN, stableAuthToken);
          } else {
            try { Services.prefs.clearUserPref(PREF_STABLE_AUTH_TOKEN); } catch { /* ignore */ }
          }
          return { success: true, stableAuthToken };
        },

        generateAuthToken: async function() {
          return { authToken: generateAuthToken() };
        },
      }
    };
  }

  onShutdown(isAppShutdown) {
    // Stop the HTTP server so the port is released
    if (globalThis.__tbMcpServer) {
      try { globalThis.__tbMcpServer.stop(() => {}); } catch { /* ignore */ }
      globalThis.__tbMcpServer = null;
    }
    // Clear the start promise so a fresh start can occur on reload
    globalThis.__tbMcpStartPromise = null;

    // Always clean up the connection info file so stale tokens don't linger
    // (Inlined here because removeConnectionInfo() is scoped inside start())
    try {
      const tmpDir = Services.dirsvc.get("TmpD", Ci.nsIFile);
      tmpDir.append("thunderbird-mcp");
      const connFile = tmpDir.clone();
      connFile.append("connection.json");
      if (connFile.exists()) {
        connFile.remove(false);
      }
    } catch {
      // Best-effort cleanup
    }

    // Always clean up temp attachment files (even on app shutdown) to avoid
    // leaving sensitive decoded attachments on disk.
    for (const tmpPath of _tempAttachFiles) {
      try {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(tmpPath);
        if (f.exists()) f.remove(false);
      } catch {}
    }
    _tempAttachFiles.clear();
    if (isAppShutdown) return;
    resProto.setSubstitution("thunderbird-mcp", null);
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }
};
