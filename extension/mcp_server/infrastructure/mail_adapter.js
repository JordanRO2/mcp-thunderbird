"use strict";

/**
 * infrastructure/mail_adapter.js — the leaf XPCOM/MailServices/gloda helpers the
 * mail domain depends on. These are the pieces that read a live nsIMsgDBHdr,
 * walk a folder tree, hit MailServices.copy, or drive a GlodaMsgSearcher.
 *
 * The big tool orchestration (searchMessages / getMessage / getRecentMessages /
 * exportMailbox / updateMessage / deleteMessages / the folder-CRUD tools) stays
 * in application/mail_service.js because its date/filter/pagination logic is
 * inseparable from the enumeration loop. That service consumes these adapter
 * helpers plus the shared ctx bindings (openFolder/findMessage/paginate/...).
 *
 * Behavior is preserved verbatim from the original domain/mail.js: every helper
 * body is copied byte-for-byte (original indentation kept) so runtime behavior
 * is identical; only the surrounding layer changed.
 *
 * Consumes from ctx:
 *   Ci, Services, MailServices, GlodaMsgSearcher,
 *   AUDIT_LOG_SUBDIR, MAX_SEARCH_RESULTS_CAP, DEFAULT_MAX_RESULTS,
 *   paginate, getUserTags, getAccessibleFolder, isFolderAccessible,
 *   wrapUntrustedPreview, messageEntity
 * Registers onto ctx:
 *   mailAdapter = { EXPORTS_SUBDIR, exportsDir, msgHdrToHeaderObject,
 *                   findTrashFolder, findSpecialFolder,
 *                   deleteAllMessagesRecursive, glodaBodySearch }
 */
module.exports = function register(ctx) {
  const {
    Ci,
    Services,
    MailServices,
    GlodaMsgSearcher,
    AUDIT_LOG_SUBDIR,
    MAX_SEARCH_RESULTS_CAP,
    DEFAULT_MAX_RESULTS,
    paginate,
    getUserTags,
    getAccessibleFolder,
    isFolderAccessible,
    wrapUntrustedPreview,
    messageEntity,
  } = ctx;

  // Pure dedupe helper (lives on the message entity) used by the gloda body
  // search path so cross-folder duplicates collapse exactly like the header
  // search path in mail_service.js.
  const { dedupeSearchMessageResults } = messageEntity;

  // Export destination subdir under <ProfD>/thunderbird-mcp/. Lives with its
  // only consumers (exportsDir + the export tool) rather than in api.js.
  const EXPORTS_SUBDIR = "exports";
  // Same collection cap the gloda search loop applies before truncating.
  const SEARCH_COLLECTION_CAP = 10000;

            function exportsDir() {
              const profDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
              const d = profDir.clone();
              d.append(AUDIT_LOG_SUBDIR);
              d.append(EXPORTS_SUBDIR);
              return d;
            }

            // Shared shape extraction so getMessageHeaders and
            // batchGetMessageHeaders return identical fields.
            function msgHdrToHeaderObject(msgHdr) {
              return {
                id: msgHdr.messageId,
                subject: msgHdr.mime2DecodedSubject || msgHdr.subject || "",
                author: msgHdr.mime2DecodedAuthor || msgHdr.author || "",
                recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients || "",
                ccList: msgHdr.ccList || "",
                date: msgHdr.date ? new Date(msgHdr.date / 1000).toISOString() : null,
                tags: getUserTags(msgHdr),
                isRead: msgHdr.isRead,
                isFlagged: msgHdr.isFlagged,
                threadId: msgHdr.threadId ? String(msgHdr.threadId) : null,
                references: msgHdr.getStringProperty("references") || "",
                inReplyTo: msgHdr.getStringProperty("in-reply-to") || "",
                size: typeof msgHdr.messageSize === "number" ? msgHdr.messageSize : null,
              };
            }

            function findTrashFolder(folder) {
              const TRASH_FLAG = 0x00000100;
              let account = null;
              try {
                account = MailServices.accounts.findAccountForServer(folder.server);
              } catch {
                return null;
              }
              const root = account?.incomingServer?.rootFolder;
              if (!root) return null;

              let fallback = null;
              const TRASH_NAMES = ["trash", "deleted items"];
              const stack = [root];
              while (stack.length > 0) {
                const current = stack.pop();
                try {
                  if (current && typeof current.getFlag === "function" && current.getFlag(TRASH_FLAG)) {
                    return current;
                  }
                } catch {}
                if (!fallback && current?.prettyName && TRASH_NAMES.includes(current.prettyName.toLowerCase())) {
                  fallback = current;
                }
                try {
                  if (current?.hasSubFolders) {
                    for (const sf of current.subFolders) stack.push(sf);
                  }
                } catch {}
              }
              return fallback;
            }

            /**
             * Find a special folder by flag bit, searching the account's folder tree.
             */
            function findSpecialFolder(root, flagBit) {
              const search = (folder) => {
                try {
                  if (folder.getFlag && folder.getFlag(flagBit)) return folder;
                } catch {}
                if (folder.hasSubFolders) {
                  for (const sub of folder.subFolders) {
                    const found = search(sub);
                    if (found) return found;
                  }
                }
                return null;
              };
              return search(root);
            }

            /**
             * Recursively delete all messages in a folder and its subfolders.
             * Returns total count of messages deleted.
             */
            function deleteAllMessagesRecursive(folder) {
              let count = 0;
              try {
                const db = folder.msgDatabase;
                if (db) {
                  const hdrs = [];
                  for (const hdr of db.enumerateMessages()) hdrs.push(hdr);
                  if (hdrs.length > 0) {
                    folder.deleteMessages(hdrs, null, true, false, null, false);
                    count += hdrs.length;
                  }
                }
              } catch (e) {
                // Continue traversal; log per-folder failures so partial empties are visible.
                console.error("thunderbird-mcp: deleteMessages failed for folder", folder?.URI || folder?.name, ":", e);
              }
              if (folder.hasSubFolders) {
                for (const sub of folder.subFolders) {
                  count += deleteAllMessagesRecursive(sub);
                }
              }
              return count;
            }

            /**
             * Full-text body search using Thunderbird's Gloda index via
             * GlodaMsgSearcher. Searches subject, body, and attachment
             * names. Returns a Promise resolving to the same format as
             * searchMessages. IMAP accounts need offline sync for body
             * indexing; without it only headers are searched.
             */
            function glodaBodySearch(query, folderPath, startDate, endDate, maxResults, offset, sortOrder, unreadOnly, flaggedOnly, tag, countOnly, dedupByMessageId) {
              const requestedLimit = Number(maxResults);
              const effectiveLimit = Math.min(
                Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : DEFAULT_MAX_RESULTS,
                MAX_SEARCH_RESULTS_CAP
              );
              const normalizedSortOrder = sortOrder === "asc" ? "asc" : "desc";
              const parsedStartDate = startDate ? new Date(startDate).getTime() : null;
              const parsedEndDate = endDate ? new Date(endDate).getTime() : null;
              if (parsedStartDate !== null && isNaN(parsedStartDate)) return { error: `Invalid startDate: ${startDate}` };
              if (parsedEndDate !== null && isNaN(parsedEndDate)) return { error: `Invalid endDate: ${endDate}` };
              // Match the regular search path: expand date-only endDate to end of day
              const isDateOnly = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim());
              const endDateOffset = isDateOnly ? 86400000 : 0;
              const endDateTs = parsedEndDate !== null ? (parsedEndDate + endDateOffset) * 1000 : null;
              const startDateTs = parsedStartDate !== null ? parsedStartDate * 1000 : null;

              // Resolve folder filter upfront -- match by URI prefix for subfolder inclusion
              let folderFilterURI = null;
              if (folderPath) {
                const result = getAccessibleFolder(folderPath);
                if (result.error) return result;
                folderFilterURI = result.folder.URI;
              }

              return new Promise((resolve) => {
                try {
                  const listener = {
                    onItemsAdded() {},
                    onItemsModified() {},
                    onItemsRemoved() {},
                    onQueryCompleted(collection) {
                      try {
                        const results = [];
                        for (const glodaMsg of collection.items) {
                          if (results.length >= SEARCH_COLLECTION_CAP) break;
                          // Get the underlying msgHdr
                          let msgHdr;
                          try {
                            msgHdr = glodaMsg.folderMessage;
                          } catch { continue; }
                          if (!msgHdr) continue;

                          // Account access control
                          const folder = msgHdr.folder;
                          if (!folder) continue;
                          if (!isFolderAccessible(folder)) continue;

                          // Folder filter (URI prefix match includes subfolders)
                          if (folderFilterURI && !folder.URI.startsWith(folderFilterURI)) continue;

                          // Date filters (timestamps in microseconds)
                          const msgDateTs = msgHdr.date || 0;
                          if (startDateTs !== null && msgDateTs < startDateTs) continue;
                          if (endDateTs !== null && msgDateTs > endDateTs) continue;

                          // Boolean filters
                          if (unreadOnly && msgHdr.isRead) continue;
                          if (flaggedOnly && !msgHdr.isFlagged) continue;
                          if (tag) {
                            const keywords = (msgHdr.getStringProperty("keywords") || "").split(/\s+/);
                            if (!keywords.includes(tag)) continue;
                          }

                          const msgTags = getUserTags(msgHdr);
                          const preview = msgHdr.getStringProperty("preview") || "";
                          const result = {
                            id: msgHdr.messageId,
                            threadId: msgHdr.threadId,
                            subject: msgHdr.mime2DecodedSubject || msgHdr.subject,
                            author: msgHdr.mime2DecodedAuthor || msgHdr.author,
                            recipients: msgHdr.mime2DecodedRecipients || msgHdr.recipients,
                            ccList: msgHdr.ccList,
                            date: msgHdr.date ? new Date(msgHdr.date / 1000).toISOString() : null,
                            folder: folder.prettyName,
                            folderPath: folder.URI,
                            read: msgHdr.isRead,
                            flagged: msgHdr.isFlagged,
                            tags: msgTags,
                            _dateTs: msgDateTs
                          };
                          if (preview) result.preview = wrapUntrustedPreview(preview);
                          results.push(result);
                        }

                        const finalResults = dedupByMessageId !== false ? dedupeSearchMessageResults(results) : results;

                        if (countOnly) {
                          resolve({ count: finalResults.length });
                          return;
                        }
                        finalResults.sort((a, b) => normalizedSortOrder === "asc" ? a._dateTs - b._dateTs : b._dateTs - a._dateTs);
                        resolve(paginate(finalResults, offset, effectiveLimit));
                      } catch (e) {
                        resolve({ error: e.toString() });
                      }
                    }
                  };
                  const searcher = new GlodaMsgSearcher(listener, query);
                  searcher.getCollection();
                } catch (e) {
                  resolve({ error: e.toString() });
                }
              });
            }

  Object.assign(ctx, {
    mailAdapter: {
      EXPORTS_SUBDIR,
      exportsDir,
      msgHdrToHeaderObject,
      findTrashFolder,
      findSpecialFolder,
      deleteAllMessagesRecursive,
      glodaBodySearch,
    },
  });
};
