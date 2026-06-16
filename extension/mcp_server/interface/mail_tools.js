"use strict";

/**
 * interface/mail_tools.js — the 19 mail/folder MCP tool handlers.
 *
 * Thin edge: each handler maps the raw tool-call args to a mailService method
 * (the central validateToolArgs/coerceToolArgs in dispatch.js already ran).
 * Handlers are registered into the dispatch registry via
 * ctx.registerToolHandler(name, fn) so callTool routes mail here instead of the
 * legacy switch in api.js.
 *
 * Tool names/args/behavior are preserved exactly -- the registered closures
 * unpack the args object into the SAME positional signatures the legacy switch
 * used in api.js, so dispatch is byte-for-byte equivalent.
 *
 * The MAIL_TOOL_DEFS below mirror the metadata for these tools. The LIVE
 * `tools` array in api.js remains the single source of truth (a structural test
 * parses api.js for the `{ name: "…" }` declarations); these defs exist so a
 * reader can see the mail surface in one place.
 *
 * Consumes from ctx: mailService, registerToolHandler
 * Registers onto ctx:
 *   searchMessages, getMessage, getMessages, getMessageHeaders, getRecentMessages,
 *   batchGetMessageHeaders, searchByThread, searchAttachments, getSenderHistory,
 *   displayMessage, updateMessage, deleteMessages, createFolder, renameFolder,
 *   deleteFolder, moveFolder, emptyTrash, emptyJunk, refreshFolder,
 *   exportMailbox  (back-compat bare functions), MAIL_TOOL_DEFS
 */
// Exact mirror of the mail/folder entries in api.js's `tools` array (the live
// source of truth). Kept in sync for documentation; api.js is authoritative.
const MAIL_TOOL_DEFS = [
  { name: "searchMessages", group: "messages", crud: "read", title: "Search Mail" },
  { name: "getMessage", group: "messages", crud: "read", title: "Get Message" },
  { name: "getMessages", group: "messages", crud: "read", title: "Get Messages" },
  { name: "getMessageHeaders", group: "messages", crud: "read", title: "Get Message Headers" },
  { name: "exportMailbox", group: "messages", crud: "read", title: "Export Mailbox" },
  { name: "getSenderHistory", group: "messages", crud: "read", title: "Get Sender History" },
  { name: "searchAttachments", group: "messages", crud: "read", title: "Search Attachments" },
  { name: "searchByThread", group: "messages", crud: "read", title: "Search By Thread" },
  { name: "batchGetMessageHeaders", group: "messages", crud: "read", title: "Batch Get Message Headers" },
  { name: "refreshFolder", group: "messages", crud: "read", title: "Refresh Folder" },
  { name: "getRecentMessages", group: "messages", crud: "read", title: "Get Recent Messages" },
  { name: "displayMessage", group: "messages", crud: "read", title: "Display Message" },
  { name: "deleteMessages", group: "messages", crud: "delete", title: "Delete Messages" },
  { name: "updateMessage", group: "messages", crud: "update", title: "Update Message" },
  { name: "createFolder", group: "folders", crud: "create", title: "Create Folder" },
  { name: "renameFolder", group: "folders", crud: "update", title: "Rename Folder" },
  { name: "deleteFolder", group: "folders", crud: "delete", title: "Delete Folder" },
  { name: "emptyTrash", group: "folders", crud: "delete", title: "Empty Trash" },
  { name: "emptyJunk", group: "folders", crud: "delete", title: "Empty Junk" },
  { name: "moveFolder", group: "folders", crud: "update", title: "Move Folder" },
];

module.exports = function register(ctx) {
  const { mailService, registerToolHandler } = ctx;

  // Thin pass-through functions preserving the original positional signatures.
  function searchMessages(query, folderPath, startDate, endDate, maxResults, offset, sortOrder, unreadOnly, flaggedOnly, tag, includeSubfolders, countOnly, searchBody, dedupByMessageId) {
    return mailService.searchMessages(query, folderPath, startDate, endDate, maxResults, offset, sortOrder, unreadOnly, flaggedOnly, tag, includeSubfolders, countOnly, searchBody, dedupByMessageId);
  }
  function getMessage(messageId, folderPath, saveAttachments, bodyFormat, rawSource) {
    return mailService.getMessage(messageId, folderPath, saveAttachments, bodyFormat, rawSource);
  }
  function getMessages(messages, saveAttachments, bodyFormat, rawSource) {
    return mailService.getMessages(messages, saveAttachments, bodyFormat, rawSource);
  }
  function getMessageHeaders(messageId, folderPath) {
    return mailService.getMessageHeaders(messageId, folderPath);
  }
  function getRecentMessages(folderPath, daysBack, maxResults, offset, unreadOnly, flaggedOnly, includeSubfolders) {
    return mailService.getRecentMessages(folderPath, daysBack, maxResults, offset, unreadOnly, flaggedOnly, includeSubfolders);
  }
  function batchGetMessageHeaders(messageIds, folderPath) {
    return mailService.batchGetMessageHeaders(messageIds, folderPath);
  }
  function searchByThread(messageId, folderPath, maxResults) {
    return mailService.searchByThread(messageId, folderPath, maxResults);
  }
  function searchAttachments(nameContains, contentType, folderPath, maxResults, scanCap) {
    return mailService.searchAttachments(nameContains, contentType, folderPath, maxResults, scanCap);
  }
  function getSenderHistory(email, maxResults, scanCap, sinceDays) {
    return mailService.getSenderHistory(email, maxResults, scanCap, sinceDays);
  }
  function displayMessage(messageId, folderPath, displayMode) {
    return mailService.displayMessage(messageId, folderPath, displayMode);
  }
  function updateMessage(messageId, messageIds, folderPath, read, flagged, addTags, removeTags, moveTo, trash) {
    return mailService.updateMessage(messageId, messageIds, folderPath, read, flagged, addTags, removeTags, moveTo, trash);
  }
  function deleteMessages(messageIds, folderPath) {
    return mailService.deleteMessages(messageIds, folderPath);
  }
  function createFolder(parentFolderPath, name) {
    return mailService.createFolder(parentFolderPath, name);
  }
  function renameFolder(folderPath, newName) {
    return mailService.renameFolder(folderPath, newName);
  }
  function deleteFolder(folderPath) {
    return mailService.deleteFolder(folderPath);
  }
  function moveFolder(folderPath, newParentPath) {
    return mailService.moveFolder(folderPath, newParentPath);
  }
  function emptyTrash(accountId) {
    return mailService.emptyTrash(accountId);
  }
  function emptyJunk(accountId) {
    return mailService.emptyJunk(accountId);
  }
  function refreshFolder(folderPath, timeoutMs) {
    return mailService.refreshFolder(folderPath, timeoutMs);
  }
  function exportMailbox(folderPath, maxMessages, includeBody, includeAttachmentMeta, scanCap, sortOrder) {
    return mailService.exportMailbox(folderPath, maxMessages, includeBody, includeAttachmentMeta, scanCap, sortOrder);
  }

  // Wire into the dispatch registry. Each closure unpacks the raw args object
  // into the original positional signature so behavior matches the old switch
  // case exactly (including the `args.query || ""` default).
  registerToolHandler("searchMessages", (args) => searchMessages(args.query || "", args.folderPath, args.startDate, args.endDate, args.maxResults, args.offset, args.sortOrder, args.unreadOnly, args.flaggedOnly, args.tag, args.includeSubfolders, args.countOnly, args.searchBody, args.dedupByMessageId));
  registerToolHandler("getMessage", (args) => getMessage(args.messageId, args.folderPath, args.saveAttachments, args.bodyFormat, args.rawSource));
  registerToolHandler("getMessages", (args) => getMessages(args.messages, args.saveAttachments, args.bodyFormat, args.rawSource));
  registerToolHandler("getMessageHeaders", (args) => getMessageHeaders(args.messageId, args.folderPath));
  registerToolHandler("batchGetMessageHeaders", (args) => batchGetMessageHeaders(args.messageIds, args.folderPath));
  registerToolHandler("searchByThread", (args) => searchByThread(args.messageId, args.folderPath, args.maxResults));
  registerToolHandler("searchAttachments", (args) => searchAttachments(args.nameContains, args.contentType, args.folderPath, args.maxResults, args.scanCap));
  registerToolHandler("getSenderHistory", (args) => getSenderHistory(args.email, args.maxResults, args.scanCap, args.sinceDays));
  registerToolHandler("exportMailbox", (args) => exportMailbox(args.folderPath, args.maxMessages, args.includeBody, args.includeAttachmentMeta, args.scanCap, args.sortOrder));
  registerToolHandler("getRecentMessages", (args) => getRecentMessages(args.folderPath, args.daysBack, args.maxResults, args.offset, args.unreadOnly, args.flaggedOnly, args.includeSubfolders));
  registerToolHandler("refreshFolder", (args) => refreshFolder(args.folderPath, args.timeoutMs));
  registerToolHandler("displayMessage", (args) => displayMessage(args.messageId, args.folderPath, args.displayMode));
  registerToolHandler("deleteMessages", (args) => deleteMessages(args.messageIds, args.folderPath));
  registerToolHandler("updateMessage", (args) => updateMessage(args.messageId, args.messageIds, args.folderPath, args.read, args.flagged, args.addTags, args.removeTags, args.moveTo, args.trash));
  registerToolHandler("createFolder", (args) => createFolder(args.parentFolderPath, args.name));
  registerToolHandler("renameFolder", (args) => renameFolder(args.folderPath, args.newName));
  registerToolHandler("deleteFolder", (args) => deleteFolder(args.folderPath));
  registerToolHandler("emptyTrash", (args) => emptyTrash(args.accountId));
  registerToolHandler("emptyJunk", (args) => emptyJunk(args.accountId));
  registerToolHandler("moveFolder", (args) => moveFolder(args.folderPath, args.newParentPath));

  // Back-compat: also expose the bare functions on ctx (harmless if unused).
  Object.assign(ctx, {
    searchMessages, getMessage, getMessages, getMessageHeaders, getRecentMessages,
    batchGetMessageHeaders, searchByThread, searchAttachments, getSenderHistory,
    displayMessage, updateMessage, deleteMessages, createFolder, renameFolder,
    deleteFolder, moveFolder, emptyTrash, emptyJunk, refreshFolder, exportMailbox,
    MAIL_TOOL_DEFS,
  });
};
module.exports.MAIL_TOOL_DEFS = MAIL_TOOL_DEFS;
