/**
 * Shared pure helpers used by both the extension (api.js) and the Node test
 * suite. No Mozilla XPCOM dependencies, no Thunderbird globals; everything in
 * this file must be evaluable from a plain Node.js context so the tests can
 * exercise the same code that ships in production instead of maintaining
 * parallel re-implementations that drift.
 *
 * Loading
 * -------
 * Inside the extension, api.js loads this file with
 *
 *     const helperScope = { module: { exports: {} } };
 *     Services.scriptloader.loadSubScript(
 *       "resource://thunderbird-mcp/mcp_server/security_helpers.js",
 *       helperScope
 *     );
 *     const helpers = helperScope.module.exports;
 *
 * In the test suite this file is `require()`-d directly because the
 * `module.exports = { ... }` at the bottom is standard CommonJS.
 */
'use strict';

// ─── Attachment deny-list (S1b) ──────────────────────────────────────────────

const SENSITIVE_ATTACHMENT_PATTERNS = [
  /\/\.ssh(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.azure(\/|$)/,
  /\/\.config\/gcloud(\/|$)/,
  /\/\.kube(\/|$)/,
  /\/\.docker(\/|$)/,
  /\/\.netrc$/,
  /\/\.npmrc$/,
  /\/\.pypirc$/,
  /\/id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.pem$/,
  /\.pfx$/,
  /\.p12$/,
  /\.kdbx$/,
  /\.key$/,
  /\.asc$/,
  /\.gpg$/,
  /^\/etc\//,
  /^\/proc\//,
  /^\/sys\//,
  /^\/root\//,
  /^\/var\/log\//,
  /^\/var\/lib\/sudo\//,
  /\/library\/keychains\//,
  /^[a-z]:\/windows\//,
  /^[a-z]:\/programdata\/microsoft\/(crypto|protect)\//,
  /\/appdata\/(local|roaming)\/microsoft\/(credentials|crypto|protect|vault)(\/|$)/,
  /\/(logins\.json|key3\.db|key4\.db|cookies(\.sqlite)?|login data)$/,
  /\/\.?thunderbird\/profiles?(\/|$)/,
  /\/library\/thunderbird(\/|$)/,
  /\/appdata\/roaming\/thunderbird(\/|$)/,
];

function isSensitiveFilePath(attachmentPath) {
  if (typeof attachmentPath !== 'string' || !attachmentPath) return false;
  const normalized = attachmentPath.replace(/\\/g, '/').toLowerCase();
  return SENSITIVE_ATTACHMENT_PATTERNS.some(re => re.test(normalized));
}

// ─── Single-line header sanitization (F2) ────────────────────────────────────

function sanitizeHeaderLine(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/[\r\n\0]+/g, ' ');
}

// ─── Untrusted-content delimiters for email bodies / previews ────────────────

const UNTRUSTED_OPEN = '<untrusted_email_body>';
const UNTRUSTED_CLOSE = '</untrusted_email_body>';
// Zero-width-space inserted into a defanged close marker so a sender-embedded
// `</untrusted_email_body>` cannot terminate our wrap and escape into the
// instruction layer of the consuming LLM.
const UNTRUSTED_CLOSE_DEFANGED = '</untrusted_email_body​>';

function wrapUntrustedBody(text) {
  if (typeof text !== 'string' || !text) return text;
  const safe = text.split(UNTRUSTED_CLOSE).join(UNTRUSTED_CLOSE_DEFANGED);
  return `${UNTRUSTED_OPEN}\n${safe}\n${UNTRUSTED_CLOSE}`;
}

function wrapUntrustedPreview(text) {
  if (typeof text !== 'string' || !text) return text;
  const safe = text.split(UNTRUSTED_CLOSE).join(UNTRUSTED_CLOSE_DEFANGED);
  return `${UNTRUSTED_OPEN} ${safe} ${UNTRUSTED_CLOSE}`;
}

// ─── Audit-log helpers ───────────────────────────────────────────────────────

function countRecipients(s) {
  if (typeof s !== 'string' || !s.trim()) return 0;
  return s.split(',').map(p => p.trim()).filter(Boolean).length;
}

function summarizeAttachmentsForAudit(descs) {
  if (!Array.isArray(descs)) return { count: 0, names: [], totalBytes: 0 };
  let total = 0;
  const names = [];
  for (const d of descs) {
    if (d && typeof d.size === 'number') total += d.size;
    if (d && d.name) names.push(String(d.name).slice(0, 200));
  }
  return { count: descs.length, names, totalBytes: total };
}

// ─── Markdown URL allow-list + injection escape (F4 / F5) ────────────────────

const SAFE_HREF_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'cid', 'ftp', 'ftps']);

function isSafeMarkdownHref(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  const cleaned = trimmed.replace(/^[\s -]+/, '');
  const colon = cleaned.indexOf(':');
  const slash = cleaned.indexOf('/');
  const question = cleaned.indexOf('?');
  const hash = cleaned.indexOf('#');
  if (colon === -1) return true;
  if (slash !== -1 && slash < colon) return true;
  if (question !== -1 && question < colon) return true;
  if (hash !== -1 && hash < colon) return true;
  const scheme = cleaned.slice(0, colon).toLowerCase();
  return SAFE_HREF_SCHEMES.has(scheme);
}

function isSafeImageSrc(url) {
  if (isSafeMarkdownHref(url)) return true;
  if (typeof url !== 'string') return false;
  const cleaned = url.trim().replace(/^[\s -]+/, '').toLowerCase();
  return cleaned.startsWith('data:image/');
}

function escapeMarkdownLinkText(s) {
  return String(s).replace(/[[\]]/g, m => (m === '[' ? '\\[' : '\\]'));
}

function renderMarkdownLink(text, url) {
  const safeText = escapeMarkdownLinkText(text);
  if (url.includes('>')) return safeText;
  if (/[()\s]/.test(url)) return `[${safeText}](<${url}>)`;
  return `[${safeText}](${url})`;
}

// ─── System-principal fetch scheme allow-list ────────────────────────────────

const SYSTEM_PRINCIPAL_FETCH_SCHEMES = new Set([
  'mailbox',
  'mailbox-message',
  'imap',
  'imap-message',
  'news',
  'news-message',
]);

function isSystemPrincipalFetchAllowed(url) {
  if (typeof url !== 'string' || !url) return false;
  const colon = url.indexOf(':');
  if (colon <= 0) return false;
  const scheme = url.slice(0, colon).toLowerCase();
  return SYSTEM_PRINCIPAL_FETCH_SCHEMES.has(scheme);
}

// ─── Recursive schema walker (S4) ────────────────────────────────────────────

function validateAgainstSchema(value, schema, path, errors) {
  if (!schema || value === undefined || value === null) return;

  const expectedType = schema.type;
  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`Parameter '${path}' must be an array, got ${typeof value}`);
      return;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        // Array items are never nullable: validateAgainstSchema returns early
        // on null/undefined, so a null item would otherwise skip the item
        // schema entirely. Reject explicitly.
        if (value[i] === null || value[i] === undefined) {
          errors.push(`Parameter '${path}[${i}]' must not be null`);
          continue;
        }
        validateAgainstSchema(value[i], schema.items, `${path}[${i}]`, errors);
      }
    }
  } else if (expectedType === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`Parameter '${path}' must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
    const nestedProps = schema.properties || {};
    const nestedRequired = schema.required || [];
    for (const r of nestedRequired) {
      if (value[r] === undefined || value[r] === null) {
        errors.push(`Missing required parameter: ${path}.${r}`);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      const has = Object.prototype.hasOwnProperty.call(nestedProps, k);
      if (!has) {
        if (schema.additionalProperties === false) {
          errors.push(`Unknown parameter: ${path}.${k}`);
        }
        continue;
      }
      validateAgainstSchema(v, nestedProps[k], `${path}.${k}`, errors);
    }
  } else if (expectedType === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`Parameter '${path}' must be an integer, got ${typeof value === 'number' ? 'non-integer number' : typeof value}`);
      return;
    }
  } else if (expectedType && typeof value !== expectedType) {
    errors.push(`Parameter '${path}' must be ${expectedType}, got ${typeof value}`);
    return;
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    let matched = 0;
    for (const branch of schema.oneOf) {
      const branchErrors = [];
      validateAgainstSchema(value, branch, path, branchErrors);
      if (branchErrors.length === 0) matched++;
    }
    if (matched === 0) {
      errors.push(`Parameter '${path}' did not match any allowed schema variant`);
    } else if (matched > 1) {
      errors.push(`Parameter '${path}' matched more than one schema variant`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`Parameter '${path}' must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
}

// ─── Rate limiter (sliding window per tool name) ─────────────────────────────

/**
 * Defaults are conservative: outbound mail / contact writes / filter create
 * are the operations a confused LLM agent could do real harm with. Read tools
 * are not rate-limited here -- the HTTP body cap + per-request validation
 * already bound them, and the agent legitimately fans out many reads.
 *
 * Format: tool name -> { limit, windowMs }
 */
const RATE_LIMIT_DEFAULTS = {
  sendMail:         { limit: 10, windowMs: 5 * 60 * 1000 },
  replyToMessage:   { limit: 10, windowMs: 5 * 60 * 1000 },
  forwardMessage:   { limit: 10, windowMs: 5 * 60 * 1000 },
  saveDraft:        { limit: 30, windowMs: 5 * 60 * 1000 },
  createContact:    { limit:  5, windowMs: 60 * 1000 },
  updateContact:    { limit:  5, windowMs: 60 * 1000 },
  deleteContact:    { limit:  5, windowMs: 60 * 1000 },
  createFilter:     { limit:  5, windowMs: 5 * 60 * 1000 },
  updateFilter:     { limit:  5, windowMs: 5 * 60 * 1000 },
  deleteFilter:     { limit: 10, windowMs: 5 * 60 * 1000 },
};

/**
 * Sliding-window rate limiter. Each tool keeps a ring of recent call
 * timestamps; on consume(), we drop timestamps outside the window and check
 * the remaining count against `limit`.
 *
 * Stateless from the caller's view -- pass `now()` so tests can advance time.
 * Lives in security_helpers so tests exercise the same code; production
 * passes Date.now and a singleton state object created at extension startup.
 */
function createRateLimiterState(limits) {
  const config = { ...RATE_LIMIT_DEFAULTS, ...(limits || {}) };
  return { config, hits: Object.create(null) };
}

/**
 * Try to consume one rate-limit slot for `tool`. Returns:
 *   { allowed: true,  remaining, resetAfterMs }  - call is permitted
 *   { allowed: false, remaining: 0, resetAfterMs, limit, windowMs } - blocked
 *
 * If `tool` is not in the config map the call is always allowed (no limit
 * defined means no limit enforced).
 */
function consumeRateLimit(state, tool, nowMs) {
  if (!state || !state.config) return { allowed: true, remaining: Infinity, resetAfterMs: 0 };
  const cfg = state.config[tool];
  if (!cfg) return { allowed: true, remaining: Infinity, resetAfterMs: 0 };
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const cutoff = now - cfg.windowMs;
  const ring = state.hits[tool] || [];
  // Drop expired timestamps from the front.
  let firstAlive = 0;
  while (firstAlive < ring.length && ring[firstAlive] <= cutoff) firstAlive++;
  const fresh = firstAlive === 0 ? ring : ring.slice(firstAlive);
  if (fresh.length >= cfg.limit) {
    // Earliest fresh hit is the one whose expiry resets a slot.
    const resetAfterMs = (fresh[0] + cfg.windowMs) - now;
    state.hits[tool] = fresh;
    return {
      allowed: false,
      remaining: 0,
      resetAfterMs: Math.max(0, resetAfterMs),
      limit: cfg.limit,
      windowMs: cfg.windowMs,
    };
  }
  fresh.push(now);
  state.hits[tool] = fresh;
  return {
    allowed: true,
    remaining: cfg.limit - fresh.length,
    resetAfterMs: cfg.windowMs,
  };
}

/**
 * Snapshot the current bucket state without mutating it. Used by
 * getServerCapabilities so the LLM can plan around how many slots it has
 * left before the next call.
 */
function inspectRateLimits(state, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const result = {};
  if (!state || !state.config) return result;
  for (const tool of Object.keys(state.config)) {
    const cfg = state.config[tool];
    const ring = state.hits[tool] || [];
    const cutoff = now - cfg.windowMs;
    const fresh = ring.filter(t => t > cutoff);
    result[tool] = {
      limit: cfg.limit,
      windowMs: cfg.windowMs,
      used: fresh.length,
      remaining: Math.max(0, cfg.limit - fresh.length),
    };
  }
  return result;
}

// ─── Raw-MIME attachment recovery (multipart/alternative size-mismatch) ──────
// Pure parser + size heuristic. getMessage's saveAttachments path uses these to
// recover attachments whose URL-based save streams 0/short bytes (TB exposes the
// metadata via allUserAttachments but the part URL yields nothing).

function attachmentSaveLooksWrong(declaredSize, actualSize) {
  if (typeof actualSize !== "number" || actualSize < 0) return true;
  if (actualSize === 0 && declaredSize !== 0) return true;
  if (typeof declaredSize !== "number" || declaredSize <= 0) return false;
  return Math.abs(actualSize - declaredSize) > Math.max(8, declaredSize * 0.05);
}

function parseAttachmentPartsFromRawMime(rawBytes) {
  function toByteString(input) {
    if (typeof input === "string") return input;
    if (input instanceof Uint8Array) {
      let out = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < input.length; i += chunkSize) {
        out += String.fromCharCode(...input.subarray(i, i + chunkSize));
      }
      return out;
    }
    return "";
  }

  function bytesFromByteString(s) {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xFF;
    return bytes;
  }

  function findHeaderBodySplit(s) {
    const matches = [
      { idx: s.indexOf("\r\n\r\n"), len: 4 },
      { idx: s.indexOf("\n\n"), len: 2 },
      { idx: s.indexOf("\r\r"), len: 2 },
    ].filter(m => m.idx >= 0).sort((a, b) => a.idx - b.idx);
    if (matches.length === 0) return null;
    return { header: s.slice(0, matches[0].idx), body: s.slice(matches[0].idx + matches[0].len) };
  }

  function parseHeaders(headerBlock) {
    const headers = Object.create(null);
    const unfolded = String(headerBlock || "").replace(/(?:\r\n|\r|\n)[ \t]+/g, " ");
    for (const line of unfolded.split(/\r\n|\r|\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const name = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (!name) continue;
      if (!headers[name]) headers[name] = [];
      headers[name].push(value);
    }
    return headers;
  }

  function splitHeaderParameters(value) {
    const parts = [];
    let current = "";
    let quote = "";
    let escaped = false;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (quote && ch === "\\") {
        current += ch;
        escaped = true;
        continue;
      }
      if (quote) {
        current += ch;
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "\"" || ch === "'") {
        current += ch;
        quote = ch;
        continue;
      }
      if (ch === ";") {
        parts.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push(current.trim());
    return parts;
  }

  function unquoteParameter(value) {
    let v = String(value || "").trim();
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    }
    return v;
  }

  function decodePercentBytes(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "%" && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(s.charCodeAt(i) & 0xFF);
      }
    }
    return new Uint8Array(bytes);
  }

  function decodeExtendedParameter(value) {
    const raw = unquoteParameter(value);
    const match = raw.match(/^([^']*)'[^']*'(.*)$/);
    if (!match) return raw;
    const charset = (match[1] || "utf-8").trim() || "utf-8";
    const encoded = match[2] || "";
    try {
      return new TextDecoder(charset, { fatal: false }).decode(decodePercentBytes(encoded));
    } catch {
      try {
        return new TextDecoder("utf-8", { fatal: false }).decode(decodePercentBytes(encoded));
      } catch {
        return raw;
      }
    }
  }

  function parseHeaderValue(value) {
    const pieces = splitHeaderParameters(String(value || ""));
    const main = (pieces.shift() || "").trim().toLowerCase();
    const params = Object.create(null);
    for (const piece of pieces) {
      const eqIdx = piece.indexOf("=");
      if (eqIdx < 0) continue;
      const key = piece.slice(0, eqIdx).trim().toLowerCase();
      const val = piece.slice(eqIdx + 1).trim();
      if (!key) continue;
      params[key] = key.endsWith("*") ? decodeExtendedParameter(val) : unquoteParameter(val);
    }
    return { value: main, params };
  }

  function getHeader(headers, name) {
    return headers[name]?.[0] || "";
  }

  function getFilename(contentDisposition, contentType) {
    return contentDisposition.params["filename*"] ||
      contentDisposition.params.filename ||
      contentType.params["name*"] ||
      contentType.params.name ||
      "";
  }

  function normalizeContentId(value) {
    return String(value || "").trim().replace(/^<|>$/g, "");
  }

  function decodeBase64ToBytes(body) {
    const clean = String(body || "").replace(/[^A-Za-z0-9+/=]/g, "");
    if (!clean) return new Uint8Array(0);
    if (typeof atob === "function") {
      const binary = atob(clean);
      return bytesFromByteString(binary);
    }
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = new Uint8Array(256);
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const a = clean[i];
      const b = clean[i + 1];
      const c = clean[i + 2];
      const d = clean[i + 3];
      if (!a || !b || a === "=" || b === "=") break;
      const av = lookup[a.charCodeAt(0)];
      const bv = lookup[b.charCodeAt(0)];
      out.push((av << 2) | (bv >> 4));
      if (c && c !== "=") {
        const cv = lookup[c.charCodeAt(0)];
        out.push(((bv & 15) << 4) | (cv >> 2));
        if (d && d !== "=") {
          const dv = lookup[d.charCodeAt(0)];
          out.push(((cv & 3) << 6) | dv);
        }
      }
    }
    return new Uint8Array(out);
  }

  function decodeQuotedPrintableToBytes(body) {
    const qpBody = String(body || "").replace(/=(?:\r\n|\r|\n)/g, "");
    const decodedBytes = [];
    for (let i = 0; i < qpBody.length; i++) {
      if (qpBody[i] === "=" && i + 2 < qpBody.length) {
        const hex = qpBody.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          decodedBytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      decodedBytes.push(qpBody.charCodeAt(i) & 0xFF);
    }
    return new Uint8Array(decodedBytes);
  }

  function decodeTransferBody(body, transferEncoding) {
    const cte = (transferEncoding || "7bit").split(";")[0].trim().toLowerCase() || "7bit";
    if (cte === "base64") return decodeBase64ToBytes(body);
    if (cte === "quoted-printable") return decodeQuotedPrintableToBytes(body);
    if (cte === "7bit" || cte === "8bit" || cte === "binary") return bytesFromByteString(body || "");
    return null;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function splitMultipartBody(body, boundary) {
    if (!boundary) return [];
    const markerRe = new RegExp("(^|\\r\\n|\\n|\\r)--" + escapeRegExp(boundary) + "(--)?[ \\t]*(?:\\r\\n|\\n|\\r|$)", "g");
    const parts = [];
    let partStart = null;
    let match;
    while ((match = markerRe.exec(body)) !== null) {
      if (partStart !== null) {
        parts.push(body.slice(partStart, match.index));
      }
      if (match[2]) {
        partStart = null;
        break;
      }
      partStart = markerRe.lastIndex;
      if (match[0].length === 0) markerRe.lastIndex++;
    }
    if (partStart !== null && partStart < body.length) {
      parts.push(body.slice(partStart));
    }
    return parts;
  }

  const raw = toByteString(rawBytes);
  const top = findHeaderBodySplit(raw);
  if (!top) return [];
  const topHeaders = parseHeaders(top.header);
  const topContentType = parseHeaderValue(getHeader(topHeaders, "content-type") || "text/plain");
  if (!topContentType.value.startsWith("multipart/")) return [];

  const results = [];
  function walkPart(partRaw, isRoot, depth = 0) {
    if (depth > 32) return;
    const split = findHeaderBodySplit(partRaw);
    if (!split) return;
    const headers = parseHeaders(split.header);
    const contentType = parseHeaderValue(getHeader(headers, "content-type") || "text/plain");
    const contentDisposition = parseHeaderValue(getHeader(headers, "content-disposition") || "");
    const ct = contentType.value || "text/plain";
    const disposition = contentDisposition.value || "";
    if (ct === "message/rfc822" && !isRoot) return;
    if (ct.startsWith("multipart/")) {
      for (const child of splitMultipartBody(split.body, contentType.params.boundary || "")) {
        walkPart(child, false, depth + 1);
      }
      return;
    }

    const filename = getFilename(contentDisposition, contentType);
    const contentId = normalizeContentId(getHeader(headers, "content-id"));
    const hasAttachmentDisposition = disposition === "attachment";
    const hasInlineFilename = disposition === "inline" && !!filename;
    const hasNonTextFilename = !!filename && !ct.startsWith("text/");
    if (!hasAttachmentDisposition && !hasInlineFilename && !hasNonTextFilename) return;

    let bytes = null;
    try {
      bytes = decodeTransferBody(split.body, getHeader(headers, "content-transfer-encoding"));
    } catch {
      bytes = null;
    }
    if (!bytes) return;
    results.push({
      filename,
      contentType: ct,
      contentId,
      disposition,
      bytes,
    });
  }

  for (const child of splitMultipartBody(top.body, topContentType.params.boundary || "")) {
    walkPart(child, false, 0);
  }
  return results;
}

module.exports = {
  attachmentSaveLooksWrong,
  parseAttachmentPartsFromRawMime,
  SENSITIVE_ATTACHMENT_PATTERNS,
  isSensitiveFilePath,
  sanitizeHeaderLine,
  UNTRUSTED_OPEN,
  UNTRUSTED_CLOSE,
  UNTRUSTED_CLOSE_DEFANGED,
  wrapUntrustedBody,
  wrapUntrustedPreview,
  countRecipients,
  summarizeAttachmentsForAudit,
  SAFE_HREF_SCHEMES,
  isSafeMarkdownHref,
  isSafeImageSrc,
  escapeMarkdownLinkText,
  renderMarkdownLink,
  SYSTEM_PRINCIPAL_FETCH_SCHEMES,
  isSystemPrincipalFetchAllowed,
  validateAgainstSchema,
  RATE_LIMIT_DEFAULTS,
  createRateLimiterState,
  consumeRateLimit,
  inspectRateLimits,
};
