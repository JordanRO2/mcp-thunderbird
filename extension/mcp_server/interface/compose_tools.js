"use strict";

/**
 * interface/compose_tools.js — the 7 compose / template MCP tool handlers.
 *
 * Thin edge: each handler maps the raw tool-call args to a composeService
 * method (the central validateToolArgs/coerceToolArgs in dispatch.js already
 * ran). Handlers are registered into the dispatch registry via
 * ctx.registerToolHandler(name, fn) so callTool routes compose here instead of
 * the legacy switch in api.js.
 *
 * Tool names/args/behavior are preserved exactly — the registerToolHandler
 * arg unpacking is copied verbatim from the legacy switch cases in api.js:
 *   sendMail(to, subject, body, cc, bcc, isHtml, from, attachments, skipReview, idempotencyKey) -> composeMail
 *   saveDraft(to, subject, body, cc, bcc, isHtml, from, attachments)
 *   replyToMessage(messageId, folderPath, body, replyAll, isHtml, to, cc, bcc, from, attachments, skipReview, idempotencyKey)
 *   forwardMessage(messageId, folderPath, to, body, isHtml, cc, bcc, from, attachments, skipReview, idempotencyKey)
 *   dryRunCompose(to, subject, body, cc, bcc, isHtml, from, attachments)
 *   listTemplates()
 *   renderTemplate(name, vars)
 *
 * NOTE: the public MCP tool name for new-message compose is "sendMail"; it maps
 * to the service's composeMail() (the historical internal name). saveDraft /
 * replyToMessage / forwardMessage are async (return Promises) and the registry
 * awaits them via callTool.
 *
 * The COMPOSE_TOOL_DEFS below mirror the metadata for these tools. The LIVE
 * `tools` array in api.js remains the single source of truth (a structural test
 * parses api.js for the `{ name: "…" }` declarations); these defs exist so a
 * reader can see the compose surface in one place and so a future api.js can
 * assemble its array from per-domain contributions without changing the test.
 *
 * Consumes from ctx: composeService, registerToolHandler
 * Registers onto ctx:
 *   composeMail, saveDraft, replyToMessage, forwardMessage,
 *   dryRunCompose, listTemplates, renderTemplate  (back-compat, so the legacy
 *     api.js destructure still finds them if referenced),
 *   COMPOSE_TOOL_DEFS
 */
// Exact mirror of the compose entries in api.js's `tools` array (the live
// source of truth). Kept in sync for documentation; api.js is authoritative.
const COMPOSE_TOOL_DEFS = [
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
                  content: { type: "string", description: "Alias for base64 (accepted for backwards compatibility); base64 takes precedence when both are set" },
                },
                required: ["name"],
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
                  content: { type: "string", description: "Alias for base64 (accepted for backwards compatibility); base64 takes precedence when both are set" },
                },
                required: ["name"],
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
                  content: { type: "string", description: "Alias for base64 (accepted for backwards compatibility); base64 takes precedence when both are set" },
                },
                required: ["name"],
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
                  content: { type: "string", description: "Alias for base64 (accepted for backwards compatibility); base64 takes precedence when both are set" },
                },
                required: ["name"],
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
                  content: { type: "string", description: "Alias for base64 (accepted for backwards compatibility); base64 takes precedence when both are set" },
                },
                required: ["name"],
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
];

module.exports = function register(ctx) {
  const { composeService, registerToolHandler } = ctx;

  // Bare functions matching the original ctx-exported names. composeMail is the
  // historical internal name behind the public "sendMail" tool.
  function composeMail(to, subject, body, cc, bcc, isHtml, from, attachments, skipReview, idempotencyKey) {
    return composeService.composeMail(to, subject, body, cc, bcc, isHtml, from, attachments, skipReview, idempotencyKey);
  }
  function saveDraft(to, subject, body, cc, bcc, isHtml, from, attachments) {
    return composeService.saveDraft(to, subject, body, cc, bcc, isHtml, from, attachments);
  }
  function replyToMessage(messageId, folderPath, body, replyAll, isHtml, to, cc, bcc, from, attachments, skipReview, idempotencyKey) {
    return composeService.replyToMessage(messageId, folderPath, body, replyAll, isHtml, to, cc, bcc, from, attachments, skipReview, idempotencyKey);
  }
  function forwardMessage(messageId, folderPath, to, body, isHtml, cc, bcc, from, attachments, skipReview, idempotencyKey) {
    return composeService.forwardMessage(messageId, folderPath, to, body, isHtml, cc, bcc, from, attachments, skipReview, idempotencyKey);
  }
  function dryRunCompose(to, subject, body, cc, bcc, isHtml, from, attachments) {
    return composeService.dryRunCompose(to, subject, body, cc, bcc, isHtml, from, attachments);
  }
  function listTemplates() {
    return composeService.listTemplates();
  }
  function renderTemplate(name, vars) {
    return composeService.renderTemplate(name, vars);
  }

  // Wire into the dispatch registry. Each handler receives the raw args object
  // and unpacks it into the original positional signature so behavior matches
  // the old legacyCallTool switch cases exactly.
  registerToolHandler("sendMail", (args) => composeMail(args.to, args.subject, args.body, args.cc, args.bcc, args.isHtml, args.from, args.attachments, args.skipReview, args.idempotencyKey));
  registerToolHandler("saveDraft", (args) => saveDraft(args.to, args.subject, args.body, args.cc, args.bcc, args.isHtml, args.from, args.attachments));
  registerToolHandler("replyToMessage", (args) => replyToMessage(args.messageId, args.folderPath, args.body, args.replyAll, args.isHtml, args.to, args.cc, args.bcc, args.from, args.attachments, args.skipReview, args.idempotencyKey));
  registerToolHandler("forwardMessage", (args) => forwardMessage(args.messageId, args.folderPath, args.to, args.body, args.isHtml, args.cc, args.bcc, args.from, args.attachments, args.skipReview, args.idempotencyKey));
  registerToolHandler("dryRunCompose", (args) => dryRunCompose(args.to, args.subject, args.body, args.cc, args.bcc, args.isHtml, args.from, args.attachments));
  registerToolHandler("listTemplates", () => listTemplates());
  registerToolHandler("renderTemplate", (args) => renderTemplate(args.name, args.vars));

  // Back-compat: also expose the bare functions on ctx (the old api.js
  // destructured these from the domain ctx). Harmless if unused.
  Object.assign(ctx, {
    composeMail, saveDraft, replyToMessage, forwardMessage,
    dryRunCompose, listTemplates, renderTemplate,
    COMPOSE_TOOL_DEFS,
  });
};
module.exports.COMPOSE_TOOL_DEFS = COMPOSE_TOOL_DEFS;
