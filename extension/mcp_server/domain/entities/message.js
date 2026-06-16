"use strict";

/**
 * domain/entities/message.js — pure mail body/markdown formatting helpers.
 *
 * NO XPCOM, NO MailServices, NO gloda. These operate on already-extracted
 * strings (raw HTML, already-walked MIME body text) and the structural fields
 * the infrastructure adapter reads off a header. Markdown rendering of
 * sender-controlled HTML lives here because it is a pure string transform that
 * never touches a folder, db, or msgHdr.
 *
 * Unlike the fully self-contained contact entity, the message formatters
 * depend on a handful of shared sanitizers (stripHtml, isSafe*Src/Href,
 * escapeMarkdownLinkText, renderMarkdownLink, wrapUntrustedBody) that live in
 * access.js / security_helpers.js. Following the same register(ctx) factory
 * shape as the adapter, the entity receives those via ctx so the conversion
 * stays behavior-identical to the original domain/mail.js. The factory itself
 * adds no I/O.
 *
 * Consumes from ctx:
 *   stripHtml, extractBodyContent, extractPlainTextBody,
 *   isSafeImageSrc, isSafeMarkdownHref, escapeMarkdownLinkText,
 *   renderMarkdownLink, wrapUntrustedBody
 * Registers onto ctx:
 *   messageEntity = { htmlToMarkdown, extractFormattedBody, buildExportFilename,
 *                     normalizeMessageIdForDedup, dedupeSearchMessageResults }
 *
 * `buildExportFilename` is a pure string builder: it only reads folder.URI (a
 * plain string already in hand) and formats a timestamped filename — no service
 * call — so it sits here with the other formatters.
 */

/**
 * Build a safe destination filename for an export: ISO timestamp
 * with `:` replaced (Windows-hostile) and a sanitized folder
 * component derived from the folder URI's tail. Pure: only consumes
 * folder.URI as a string.
 */
function normalizeMessageIdForDedup(value) {
  // Compare RFC Message-IDs without surrounding angle brackets / whitespace.
  // Case is preserved on purpose: the local part of a Message-ID is
  // case-sensitive per RFC 5322, so lowercasing could collapse two
  // genuinely-distinct messages and hide one. Showing a duplicate is the
  // safe failure direction; hiding a message is not.
  if (value === undefined || value === null) return "";
  let normalized = String(value).trim();
  if (!normalized) return "";
  if (normalized.startsWith("<") && normalized.endsWith(">")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

/**
 * Collapse search results that share the same RFC Message-ID into a single
 * row, listing the other folder URIs the message was found in under
 * `dupLocations`. Pure: operates on the already-built result objects (each
 * carrying `id` and `folderPath`). Rows without a usable Message-ID are kept
 * as-is (the safe direction: never hide a message).
 */
function dedupeSearchMessageResults(results) {
  const seen = new Map();
  const deduped = [];

  function addDupLocation(survivor, folderPath) {
    if (!folderPath || folderPath === survivor.folderPath) return;
    if (!Array.isArray(survivor.dupLocations)) survivor.dupLocations = [];
    if (!survivor.dupLocations.includes(folderPath)) {
      survivor.dupLocations.push(folderPath);
    }
  }

  function mergeDupLocations(survivor, row) {
    addDupLocation(survivor, row.folderPath);
    if (Array.isArray(row.dupLocations)) {
      for (const folderPath of row.dupLocations) {
        addDupLocation(survivor, folderPath);
      }
    }
  }

  for (const row of results) {
    const normalizedId = normalizeMessageIdForDedup(row?.id);
    if (!normalizedId) {
      deduped.push(row);
      continue;
    }

    const survivor = seen.get(normalizedId);
    if (survivor) {
      mergeDupLocations(survivor, row);
      continue;
    }

    if (Array.isArray(row.dupLocations)) {
      const existingDupLocations = row.dupLocations;
      delete row.dupLocations;
      for (const folderPath of existingDupLocations) {
        addDupLocation(row, folderPath);
      }
    }
    seen.set(normalizedId, row);
    deduped.push(row);
  }

  return deduped;
}

function buildExportFilename(folder) {
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  const tail = folder.URI ? folder.URI.split("/").pop() : "folder";
  const safeTail = String(tail || "folder").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `${ts}-${safeTail || "folder"}.jsonl`;
}

/**
 * Factory: builds the markdown/format helpers bound to the supplied
 * sanitizers. Exported separately so a Node unit test can inject stubs
 * (matching the dual-export pattern in contact.js / security_helpers.js).
 */
function buildMessageEntity(deps) {
  const {
    stripHtml,
    extractBodyContent,
    extractPlainTextBody,
    isSafeImageSrc,
    isSafeMarkdownHref,
    escapeMarkdownLinkText,
    renderMarkdownLink,
    wrapUntrustedBody,
  } = deps;

            /**
             * Converts HTML to markdown using DOMParser for structure-preserving
             * body extraction. Handles headings, links, bold/italic, lists,
             * blockquotes, code blocks, images, and horizontal rules. Email
             * tables (usually layout, not data) are flattened to text.
             * Falls back to stripHtml if DOMParser is unavailable.
             *
             * SECURITY: `<a href>` and `<img src>` values come from sender-
             * controlled HTML, so we strip dangerous schemes (javascript:,
             * data: non-image, etc.) and defang markdown-syntax injection in
             * the link text before emitting the final markdown.
             */
            function htmlToMarkdown(html) {
              if (!html) return "";
              try {
                const doc = new DOMParser().parseFromString(html, "text/html");

                function walkChildren(node) {
                  return Array.from(node.childNodes).map(walk).join("");
                }

                function walk(node) {
                  if (node.nodeType === 3) { // Text
                    return node.textContent.replace(/[ \t]+/g, " ");
                  }
                  if (node.nodeType !== 1) return "";
                  const tag = node.tagName.toLowerCase();
                  const inner = () => walkChildren(node);

                  switch (tag) {
                    case "script": case "style": case "head": return "";
                    case "br": return "\n";
                    case "hr": return "\n\n---\n\n";
                    case "p": case "div": case "section": case "article":
                      return "\n\n" + inner().trim() + "\n\n";
                    case "h1": return "\n\n# " + inner().trim() + "\n\n";
                    case "h2": return "\n\n## " + inner().trim() + "\n\n";
                    case "h3": return "\n\n### " + inner().trim() + "\n\n";
                    case "h4": return "\n\n#### " + inner().trim() + "\n\n";
                    case "h5": return "\n\n##### " + inner().trim() + "\n\n";
                    case "h6": return "\n\n###### " + inner().trim() + "\n\n";
                    case "strong": case "b": {
                      const t = inner().trim();
                      return t ? "**" + t + "**" : "";
                    }
                    case "em": case "i": {
                      const t = inner().trim();
                      return t ? "*" + t + "*" : "";
                    }
                    case "a": {
                      const rawHref = node.getAttribute("href") || "";
                      const text = inner().trim();
                      // Skip empty/anchor-only links
                      if (!text && !rawHref) return "";
                      // Drop unsafe href schemes (javascript:, data: non-image,
                      // vbscript:, file:, chrome:, jar:, blob:, ...). Fall back
                      // to the visible text so the message stays readable.
                      if (rawHref && !isSafeMarkdownHref(rawHref)) {
                        return escapeMarkdownLinkText(text || rawHref);
                      }
                      if (rawHref && text && text !== rawHref) {
                        return renderMarkdownLink(text, rawHref);
                      }
                      return escapeMarkdownLinkText(text || rawHref);
                    }
                    case "img": {
                      const alt = node.getAttribute("alt") || "";
                      const rawSrc = node.getAttribute("src") || "";
                      // Skip tracking pixels (1x1, tiny, or data: without alt)
                      const w = parseInt(node.getAttribute("width")) || 0;
                      const h = parseInt(node.getAttribute("height")) || 0;
                      if ((w > 0 && w <= 3) || (h > 0 && h <= 3)) return "";
                      if (rawSrc.startsWith("data:") && !alt) return "";
                      // Allow http(s):, cid:, mailto: (rare), and data:image/*.
                      // Anything else (javascript:, data: non-image, file:, ...)
                      // is dropped to alt text.
                      if (rawSrc && !isSafeImageSrc(rawSrc)) {
                        return escapeMarkdownLinkText(alt);
                      }
                      if (!rawSrc) return escapeMarkdownLinkText(alt);
                      const safeAlt = escapeMarkdownLinkText(alt);
                      if (rawSrc.includes(">")) return safeAlt;
                      const srcForMd = /[()\s]/.test(rawSrc) ? `<${rawSrc}>` : rawSrc;
                      return `![${safeAlt}](${srcForMd})`;
                    }
                    case "code": return "`" + node.textContent + "`";
                    case "pre": return "\n\n```\n" + node.textContent.trim() + "\n```\n\n";
                    case "blockquote": {
                      const text = inner().trim();
                      return "\n\n" + text.split("\n").map(l => "> " + l).join("\n") + "\n\n";
                    }
                    case "ul": case "ol": return "\n" + inner() + "\n";
                    case "li": {
                      const parent = node.parentElement;
                      const isOl = parent && parent.tagName.toLowerCase() === "ol";
                      return (isOl ? "1. " : "- ") + inner().trim() + "\n";
                    }
                    // Tables: extract text with spacing (email tables are usually layout)
                    case "table": return "\n\n" + inner().trim() + "\n\n";
                    case "tr": return inner().trim() + "\n";
                    case "td": case "th": return inner().trim() + " ";
                    case "thead": case "tbody": case "tfoot": return inner();
                    default: return inner();
                  }
                }

                const body = doc.body || doc.documentElement;
                let result = walk(body);
                // Collapse excessive newlines, trim
                result = result.replace(/\n{3,}/g, "\n\n").trim();
                return result;
              } catch {
                // DOMParser unavailable or parse failure -- fall back to stripHtml
                return stripHtml(html);
              }
            }

            /**
             * Extracts body from a MIME message in the requested format.
             * For "text": uses coerceBodyToPlaintext fast path (original behavior).
             * For "markdown"/"html": walks MIME tree to find raw HTML content.
             */
            function extractFormattedBody(aMimeMsg, bodyFormat) {
              if (bodyFormat === "text") {
                return { body: wrapUntrustedBody(extractPlainTextBody(aMimeMsg)), bodyIsHtml: false };
              }
              // For markdown/html: need raw MIME content, not coerced text
              const { text, isHtml } = extractBodyContent(aMimeMsg);
              if (!text) {
                // MIME tree empty -- try coerce as last resort
                const fallback = extractPlainTextBody(aMimeMsg);
                return { body: wrapUntrustedBody(fallback), bodyIsHtml: false };
              }
              if (!isHtml) return { body: wrapUntrustedBody(text), bodyIsHtml: false };
              if (bodyFormat === "html") return { body: text, bodyIsHtml: true };
              // Default: markdown
              return { body: wrapUntrustedBody(htmlToMarkdown(text)), bodyIsHtml: false };
            }

  return {
    htmlToMarkdown, extractFormattedBody, buildExportFilename,
    normalizeMessageIdForDedup, dedupeSearchMessageResults,
  };
}

module.exports = function register(ctx) {
  const messageEntity = buildMessageEntity(ctx);
  Object.assign(ctx, { messageEntity });
};
// Dual export: a Node unit test can build the entity with injected stubs and
// exercise the pure helpers directly.
module.exports.buildMessageEntity = buildMessageEntity;
module.exports.buildExportFilename = buildExportFilename;
