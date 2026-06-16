"use strict";

/**
 * infrastructure/access.js — account / tool / folder access control + the
 * read-side adapters that sit directly on MailServices (listAccounts,
 * listFolders, getAccountAccess) + the shared MIME/HTML body helpers used by
 * both the mail and compose domains.
 *
 * Extracted verbatim from api.js's start() scope. All pref reads go through
 * __cachedRead (registered by audit.js) so this module depends on audit.js
 * having loaded first.
 *
 * Consumes from ctx:
 *   Services, MailServices,
 *   PREF_ALLOWED_ACCOUNTS, PREF_DISABLED_TOOLS, PREF_BLOCK_SKIPREVIEW,
 *   PREF_BLOCK_FILTER_FORWARD_REPLY, PREF_BLOCK_CONTACT_WRITES,
 *   PREF_BLOCK_MAILBOX_EXPORT, UNDISABLEABLE_TOOLS, INTERNAL_KEYWORDS,
 *   __cachedRead
 * Registers onto ctx:
 *   getAllowedAccountIds, isAccountAllowed, isSkipReviewBlocked,
 *   isFilterForwardReplyBlocked, isContactWritesBlocked, isMailboxExportBlocked,
 *   getDisabledTools, isToolEnabled, isFolderAccessible, getAccessibleFolder,
 *   getAccessibleAccounts, listAccounts, getAccountAccess, listFolders,
 *   getUserTags, stripHtml, extractBodyContent, extractPlainTextBody
 */
module.exports = function register(ctx) {
  const {
    Services, MailServices,
    PREF_ALLOWED_ACCOUNTS, PREF_DISABLED_TOOLS, PREF_BLOCK_SKIPREVIEW,
    PREF_BLOCK_FILTER_FORWARD_REPLY, PREF_BLOCK_CONTACT_WRITES,
    PREF_BLOCK_MAILBOX_EXPORT, UNDISABLEABLE_TOOLS, INTERNAL_KEYWORDS,
    __cachedRead,
  } = ctx;

  /**
   * Get the list of allowed account IDs from preferences.
   * Returns an empty array if no restriction is set (all accounts allowed).
   */
  function getAllowedAccountIds() {
    return __cachedRead(PREF_ALLOWED_ACCOUNTS, () => {
      try {
        const pref = Services.prefs.getStringPref(PREF_ALLOWED_ACCOUNTS, "");
        if (!pref) return [];
        const parsed = JSON.parse(pref);
        if (!Array.isArray(parsed)) {
          console.error("thunderbird-mcp: allowed accounts pref is not an array, blocking all accounts");
          return ["__invalid__"];
        }
        return parsed;
      } catch (e) {
        // Fail closed: corrupt pref means block all accounts, not allow all
        console.error("thunderbird-mcp: failed to parse allowed accounts pref, blocking all accounts:", e);
        return ["__invalid__"];
      }
    });
  }

  /**
   * Check if an account is accessible based on the allowed accounts list.
   * When the list is empty, all accounts are accessible (default).
   */
  function isAccountAllowed(accountKey) {
    const allowed = getAllowedAccountIds();
    if (allowed.length === 0) return true;
    return allowed.includes(accountKey);
  }

  /**
   * Check if the user has disabled the skipReview shortcut.
   * When true, send/reply/forward/createEvent/createTask tools must open
   * the review window/dialog even if the caller passed skipReview: true.
   *
   * Default is true: an LLM that reads attacker-controlled email content
   * can be prompt-injected into invoking sendMail with skipReview, so the
   * safe default is to require human review. Users can explicitly opt
   * into silent sends from the options page.
   */
  function isSkipReviewBlocked() {
    return __cachedRead(PREF_BLOCK_SKIPREVIEW, () => {
      try { return Services.prefs.getBoolPref(PREF_BLOCK_SKIPREVIEW, true); }
      catch { return true; }
    });
  }

  /**
   * Check if the user has blocked `forward` and `reply` filter actions
   * from the MCP API. Filters execute on every incoming message with
   * no UI, so allowing an MCP caller to create one is equivalent to
   * giving the LLM write access to a persistent silent-exfil channel.
   * Default true.
   */
  function isFilterForwardReplyBlocked() {
    return __cachedRead(PREF_BLOCK_FILTER_FORWARD_REPLY, () => {
      try { return Services.prefs.getBoolPref(PREF_BLOCK_FILTER_FORWARD_REPLY, true); }
      catch { return true; }
    });
  }

  /**
   * Check if the user has blocked address-book write operations from
   * the MCP API (createContact / updateContact / deleteContact).
   * Contact writes are persistent, cross every configured address
   * book, and have no UI confirmation -- enabling a "spoof a known
   * sender" attack where the LLM edits Boss's email to attacker's.
   * Default true.
   */
  function isContactWritesBlocked() {
    return __cachedRead(PREF_BLOCK_CONTACT_WRITES, () => {
      try { return Services.prefs.getBoolPref(PREF_BLOCK_CONTACT_WRITES, true); }
      catch { return true; }
    });
  }

  /**
   * Check if bulk mailbox export is blocked. Default true:
   * exportMailbox writes the user's mail content to disk in a
   * machine-readable format, which is an attractive primitive for
   * an LLM that has been prompt-injected into "back up everything
   * I have". Off-by-pref keeps it from being a one-call data
   * exfil channel.
   */
  function isMailboxExportBlocked() {
    return __cachedRead(PREF_BLOCK_MAILBOX_EXPORT, () => {
      try { return Services.prefs.getBoolPref(PREF_BLOCK_MAILBOX_EXPORT, true); }
      catch { return true; }
    });
  }

  /**
   * Get the list of disabled tool names from preferences.
   * Returns an empty array if no tools are disabled (all enabled).
   * Fails closed: corrupt pref disables all tools.
   */
  function getDisabledTools() {
    return __cachedRead(PREF_DISABLED_TOOLS, () => {
      try {
        const pref = Services.prefs.getStringPref(PREF_DISABLED_TOOLS, "");
        if (!pref) return [];
        const parsed = JSON.parse(pref);
        if (!Array.isArray(parsed) || !parsed.every(v => typeof v === "string")) {
          console.error("thunderbird-mcp: disabled tools pref is invalid, disabling all tools");
          return ["__all__"];
        }
        return parsed;
      } catch (e) {
        console.error("thunderbird-mcp: failed to parse disabled tools pref, disabling all tools:", e);
        return ["__all__"];
      }
    });
  }

  /**
   * Check if a tool is enabled.
   * Undisableable tools (listAccounts, listFolders, getAccountAccess) always return true.
   */
  function isToolEnabled(toolName) {
    if (UNDISABLEABLE_TOOLS.has(toolName)) return true;
    const disabled = getDisabledTools();
    if (disabled.includes("__all__")) return false;
    return !disabled.includes(toolName);
  }

  /**
   * Check if a resolved folder belongs to an allowed account.
   * Returns true if the folder's account is accessible, false otherwise.
   */
  function isFolderAccessible(folder) {
    if (!folder || !folder.server) return false;
    const account = MailServices.accounts.findAccountForServer(folder.server);
    return account ? isAccountAllowed(account.key) : false;
  }

  /**
   * Lookup a folder by URI and verify it exists and is accessible.
   * Returns { folder } on success, or { error } if not found or restricted.
   */
  function getAccessibleFolder(folderPath) {
    const folder = MailServices.folderLookup.getFolderForURL(folderPath);
    if (!folder) return { error: `Folder not found: ${folderPath}` };
    if (!isFolderAccessible(folder)) return { error: `Account not accessible for folder: ${folderPath}` };
    return { folder };
  }

  /**
   * Get all accessible Thunderbird accounts, filtered by allowed list.
   */
  function getAccessibleAccounts() {
    const result = [];
    for (const account of MailServices.accounts.accounts) {
      if (isAccountAllowed(account.key)) {
        result.push(account);
      }
    }
    return result;
  }

  function listAccounts() {
    const accounts = [];
    for (const account of getAccessibleAccounts()) {
      const server = account.incomingServer;
      const identities = [];
      for (const identity of account.identities) {
        identities.push({
          id: identity.key,
          email: identity.email,
          name: identity.fullName,
          isDefault: identity === account.defaultIdentity
        });
      }
      accounts.push({
        id: account.key,
        name: server.prettyName,
        type: server.type,
        identities
      });
    }
    return accounts;
  }

  /**
   * Get the current account access control list.
   */
  function getAccountAccess() {
    const allowed = getAllowedAccountIds();
    // Only return accessible accounts — restricted accounts are hidden
    const accessibleAccounts = [];
    for (const account of MailServices.accounts.accounts) {
      if (!isAccountAllowed(account.key)) continue;
      const server = account.incomingServer;
      accessibleAccounts.push({
        id: account.key,
        name: server.prettyName,
        type: server.type,
      });
    }
    return {
      mode: allowed.length === 0 ? "all" : "restricted",
      accounts: accessibleAccounts,
    };
  }

  /**
   * Lists all folders (optionally limited to a single account).
   * Depth is 0 for root children, increasing for subfolders.
   */
  function listFolders(accountId, folderPath) {
    const results = [];

    function folderType(flags) {
      if (flags & 0x00001000) return "inbox";
      if (flags & 0x00000200) return "sent";
      if (flags & 0x00000400) return "drafts";
      if (flags & 0x00000100) return "trash";
      if (flags & 0x00400000) return "templates";
      if (flags & 0x00000800) return "queue";
      if (flags & 0x40000000) return "junk";
      if (flags & 0x00004000) return "archive";
      return "folder";
    }

    function walkFolder(folder, accountKey, depth) {
      try {
        // Skip virtual/search folders to avoid duplicates
        if (folder.flags & 0x00000020) return;

        const prettyName = folder.prettyName;
        results.push({
          name: prettyName || folder.name || "(unnamed)",
          path: folder.URI,
          type: folderType(folder.flags),
          accountId: accountKey,
          totalMessages: folder.getTotalMessages(false),
          unreadMessages: folder.getNumUnread(false),
          depth
        });
      } catch {
        // Skip inaccessible folders
      }

      try {
        if (folder.hasSubFolders) {
          for (const subfolder of folder.subFolders) {
            walkFolder(subfolder, accountKey, depth + 1);
          }
        }
      } catch {
        // Skip subfolder traversal errors
      }
    }

    // folderPath filter: list that folder and its subtree
    if (folderPath) {
      const result = getAccessibleFolder(folderPath);
      if (result.error) return result;
      const folder = result.folder;
      const accountKey = folder.server
        ? (MailServices.accounts.findAccountForServer(folder.server)?.key || "unknown")
        : "unknown";
      walkFolder(folder, accountKey, 0);
      return results;
    }

    if (accountId) {
      if (!isAccountAllowed(accountId)) {
        return { error: `Account not accessible: "${accountId}". Call listAccounts to see which account IDs are available.` };
      }
      let target = null;
      for (const account of MailServices.accounts.accounts) {
        if (account.key === accountId) {
          target = account;
          break;
        }
      }
      if (!target) {
        return { error: `Account not found: "${accountId}". Account IDs come from listAccounts (internal keys like "account1"), not email addresses. Omit accountId to list folders across all accounts.` };
      }
      try {
        const root = target.incomingServer.rootFolder;
        if (root && root.hasSubFolders) {
          for (const subfolder of root.subFolders) {
            walkFolder(subfolder, target.key, 0);
          }
        }
      } catch {
        // Skip inaccessible account
      }
      return results;
    }

    for (const account of getAccessibleAccounts()) {
      try {
        const root = account.incomingServer.rootFolder;
        if (!root) continue;
        if (root.hasSubFolders) {
          for (const subfolder of root.subFolders) {
            walkFolder(subfolder, account.key, 0);
          }
        }
      } catch {
        // Skip inaccessible accounts/folders
      }
    }

    return results;
  }

  /** Returns user-visible tag keywords from a message header, filtering out internal IMAP flags. */
  function getUserTags(msgHdr) {
    return (msgHdr.getStringProperty("keywords") || "").split(/\s+/).filter(k => k && !INTERNAL_KEYWORDS.has(k.toLowerCase()));
  }

  function stripHtml(html) {
    if (!html) return "";
    let text = String(html);

    // Remove style/script blocks
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
    text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");

    // Convert block-level tags to newlines before stripping
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, "\n");
    text = text.replace(/<(p|div|li|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n");

    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, " ");

    // Decode entities in a single pass
    const NAMED_ENTITIES = {
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
      "#39": "'",
      mdash: "—", ndash: "–", hellip: "…",
      lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
      bull: "•", middot: "·", ensp: " ", emsp: " ",
      thinsp: " ", zwnj: "‌", zwj: "‍",
      laquo: "«", raquo: "»",
      copy: "©", reg: "®", trade: "™", deg: "°",
      plusmn: "±", times: "×", divide: "÷",
      micro: "µ", para: "¶", sect: "§",
      euro: "€", pound: "£", yen: "¥", cent: "¢",
    };
    text = text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gi, (match, entity) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const cp = parseInt(entity.slice(2), 16);
        if (!cp || cp > 0x10FFFF) return match;
        try { return String.fromCodePoint(cp); } catch { return match; }
      }
      if (entity.startsWith("#")) {
        const cp = parseInt(entity.slice(1), 10);
        if (!cp || cp > 0x10FFFF) return match;
        try { return String.fromCodePoint(cp); } catch { return match; }
      }
      return NAMED_ENTITIES[entity.toLowerCase()] || match;
    });

    // Normalize newlines/spaces
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.replace(/[ \t\f\v]+/g, " ");
    text = text.replace(/ *\n */g, "\n");
    text = text.trim();
    return text;
  }

  /**
   * Walks the MIME tree to find the raw body content.
   * Returns { text, isHtml } without any format conversion.
   * Does NOT use coerceBodyToPlaintext -- callers that want
   * the raw HTML (for markdown/html output) need this.
   */
  function extractBodyContent(aMimeMsg) {
    if (!aMimeMsg) return { text: "", isHtml: false };
    try {
      function findBody(part, isRoot = false) {
        const ct = ((part.contentType || "").split(";")[0] || "").trim().toLowerCase();
        if (ct === "message/rfc822" && !isRoot) return null;
        if (ct !== "message/rfc822") {
          if (ct === "text/plain" && part.body) return { text: part.body, isHtml: false };
          if (ct === "text/html" && part.body) return { text: part.body, isHtml: true };
        }
        if (part.parts) {
          let htmlFallback = null;
          for (const sub of part.parts) {
            const r = findBody(sub);
            if (r && !r.isHtml) return r;
            if (r && r.isHtml && !htmlFallback) htmlFallback = r;
          }
          if (htmlFallback) return htmlFallback;
        }
        return null;
      }
      const found = findBody(aMimeMsg, true);
      if (found) return found;
    } catch { /* give up */ }
    return { text: "", isHtml: false };
  }

  /**
   * Extracts plain text body from a MIME message.
   * Uses coerceBodyToPlaintext as fast path, then MIME tree fallback.
   * Used by reply/forward quoting where plain text is appropriate.
   */
  function extractPlainTextBody(aMimeMsg) {
    if (!aMimeMsg) return "";
    try {
      const text = aMimeMsg.coerceBodyToPlaintext();
      if (text) return text;
    } catch { /* fall through */ }
    const { text, isHtml } = extractBodyContent(aMimeMsg);
    return isHtml ? stripHtml(text) : text;
  }

  Object.assign(ctx, {
    getAllowedAccountIds, isAccountAllowed, isSkipReviewBlocked,
    isFilterForwardReplyBlocked, isContactWritesBlocked, isMailboxExportBlocked,
    getDisabledTools, isToolEnabled, isFolderAccessible, getAccessibleFolder,
    getAccessibleAccounts, listAccounts, getAccountAccess, listFolders,
    getUserTags, stripHtml, extractBodyContent, extractPlainTextBody,
  });
};
