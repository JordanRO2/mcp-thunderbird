"use strict";

/**
 * infrastructure/services.js — shared Thunderbird/XPCOM service imports.
 *
 * This is the FIRST infrastructure module loaded by api.js (inside start()).
 * It performs every ChromeUtils.importESModule() the server needs and assigns
 * the resulting bindings onto the shared ctx, so no later layer has to import
 * them again. It also carries two low-level stream helpers (readRequestBody,
 * paginate) that are pure-ish glue around NetUtil.
 *
 * Consumes from ctx (provided by api.js before load):
 *   Cc, Ci, Services  — XPCOM globals (file-scope globals in api.js, passed via ctx)
 *
 * Registers onto ctx:
 *   HttpServer, NetUtil, MailServices, cal, CalEvent, CalTodo, GlodaMsgSearcher,
 *   readRequestBody, paginate
 *
 * cal/CalEvent/CalTodo and GlodaMsgSearcher may be null when those subsystems
 * are unavailable — exactly as the original inline code behaved.
 */
module.exports = function register(ctx) {
  const { HttpServer } = ChromeUtils.importESModule(
    "resource://thunderbird-mcp/httpd.sys.mjs?" + Date.now()
  );
  const { NetUtil } = ChromeUtils.importESModule(
    "resource://gre/modules/NetUtil.sys.mjs"
  );
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );

  let cal = null;
  let CalEvent = null;
  let CalTodo = null;
  try {
    const calModule = ChromeUtils.importESModule(
      "resource:///modules/calendar/calUtils.sys.mjs"
    );
    cal = calModule.cal;
    const { CalEvent: CE } = ChromeUtils.importESModule(
      "resource:///modules/CalEvent.sys.mjs"
    );
    CalEvent = CE;
    const { CalTodo: CT } = ChromeUtils.importESModule(
      "resource:///modules/CalTodo.sys.mjs"
    );
    CalTodo = CT;
  } catch {
    // Calendar not available
  }

  let GlodaMsgSearcher = null;
  try {
    const glodaModule = ChromeUtils.importESModule(
      "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs"
    );
    GlodaMsgSearcher = glodaModule.GlodaMsgSearcher;
  } catch {
    // Gloda not available
  }

  /**
   * CRITICAL: Must specify { charset: "UTF-8" } or emojis/special chars
   * will be corrupted. NetUtil defaults to Latin-1.
   */
  function readRequestBody(request) {
    const stream = request.bodyInputStream;
    return NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" });
  }

  /**
   * Apply offset-based pagination to a sorted results array.
   * Removes the internal _dateTs property from each result.
   *
   * Backward-compatible: when offset is undefined/null (not provided),
   * returns a plain array. When offset is explicitly provided (even 0),
   * returns structured { messages, totalMatches, offset, limit, hasMore }.
   * Note: totalMatches is capped at SEARCH_COLLECTION_CAP and may underreport.
   */
  function paginate(results, offset, effectiveLimit) {
    const offsetProvided = offset !== undefined && offset !== null;
    const effectiveOffset = (offset > 0) ? Math.floor(offset) : 0;
    const page = results.slice(effectiveOffset, effectiveOffset + effectiveLimit).map(r => {
      delete r._dateTs;
      return r;
    });
    if (!offsetProvided) {
      return page;
    }
    return {
      messages: page,
      totalMatches: results.length,
      offset: effectiveOffset,
      limit: effectiveLimit,
      hasMore: effectiveOffset + effectiveLimit < results.length
    };
  }

  Object.assign(ctx, {
    HttpServer, NetUtil, MailServices,
    cal, CalEvent, CalTodo, GlodaMsgSearcher,
    readRequestBody, paginate,
  });
};
