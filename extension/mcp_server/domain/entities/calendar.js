"use strict";

/**
 * domain/entities/calendar.js — pure calendar value-objects + helpers.
 *
 * NO XPCOM, NO `cal`/CalEvent/CalTodo. These take an already-fetched calendar
 * ITEM (calIItemBase / calIEvent / calITodo) plus its owning calendar and shape
 * a plain record, or answer pure predicates / string transforms. The
 * infrastructure adapter (infrastructure/calendar_adapter.js) performs the
 * XPCOM reads/writes and hands these the items; the application service
 * (application/calendar_service.js) decides what to do with the results.
 *
 * Note: `formatEvent`/`formatTask` read item.getProperty(...) and
 * item.startDate.nativeTime — these are property reads on an already-fetched
 * item, not service calls (no cal.manager / cal.dtz). They moved here verbatim
 * because they are the pure record-shaping layer, exactly as the original
 * monolith defined them.
 *
 * Registered as a register(ctx) factory so the adapter/service can load it via
 * loadSubScript, but every function is pure.
 *
 * Registers onto ctx (namespaced to avoid collisions):
 *   calendarEntity = { VEVENT_STATUS_MAP, calDateToISO, normalizeEventStatus,
 *                      formatEvent, formatTask, descriptionToHTML }
 */
function calDateToISO(dt) {
  if (!dt) return null;
  try { return new Date(dt.nativeTime / 1000).toISOString(); }
  catch { return dt.icalString || null; }
}

// VEVENT STATUS values per iCal RFC 5545 § 3.8.1.11.
const VEVENT_STATUS_MAP = {
  tentative: "TENTATIVE",
  confirmed: "CONFIRMED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
};
function normalizeEventStatus(status) {
  if (status === undefined || status === null) return null;
  return VEVENT_STATUS_MAP[String(status).trim().toLowerCase()] || null;
}

function formatEvent(item, calendar) {
  const allDay = item.startDate ? item.startDate.isDate : false;
  // For all-day events, iCal DTEND is exclusive. Convert to inclusive
  // (last day of event) so the API is intuitive and round-trips correctly.
  let endDateISO = calDateToISO(item.endDate);
  if (allDay && item.endDate) {
    try {
      const raw = new Date(item.endDate.nativeTime / 1000);
      raw.setDate(raw.getDate() - 1);
      endDateISO = raw.toISOString();
    } catch { /* keep raw value */ }
  }
  const result = {
    id: item.id,
    calendarId: calendar.id,
    calendarName: calendar.name,
    title: item.title || "",
    startDate: calDateToISO(item.startDate),
    endDate: endDateISO,
    location: item.getProperty("LOCATION") || "",
    description: item.getProperty("DESCRIPTION") || "",
    // VEVENT STATUS (tentative/confirmed/cancelled). Empty string
    // when the event has no explicit status (iCal spec treats this
    // as implicit -- Thunderbird renders it like confirmed).
    status: (item.getProperty("STATUS") || "").toLowerCase(),
    categories: item.getCategories(),
    onlineMeetingURL: item.getProperty("X-MICROSOFT-SKYPETEAMSMEETINGURL") || null,
    allDay,
    isRecurring: !!item.recurrenceInfo,
  };
  // Occurrences of recurring events share the parent's id.
  // Include recurrenceId so callers can distinguish them.
  if (item.recurrenceId) {
    result.recurrenceId = calDateToISO(item.recurrenceId);
  }
  return result;
}

function formatTask(item, calendar) {
  const completed = item.isCompleted || (item.percentComplete === 100);
  const priority = item.priority || 0; // 0=undefined, 1=high, 5=normal, 9=low per iCal
  return {
    id: item.id,
    calendarId: calendar.id,
    calendarName: calendar.name,
    title: item.title || "",
    dueDate: calDateToISO(item.dueDate),
    startDate: calDateToISO(item.entryDate),
    completedDate: calDateToISO(item.completedDate),
    completed,
    percentComplete: item.percentComplete || 0,
    priority,
    description: item.getProperty("DESCRIPTION") || "",
  };
}

function descriptionToHTML(text) {
  if (text == null || text === "") return "";
  // Strip null bytes so the sentinel below can't collide with user input.
  const input = String(text).replace(/\x00/g, "");
  const escapeText = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapeAttr = s => escapeText(s).replace(/"/g, "&quot;");
  const SAFE_HREF = /^(?:https?:|mailto:)/i;

  // Stash sanitized anchors so the global HTML-escape doesn't double-escape
  // them. Anchors with unsafe (e.g. javascript:, data:) or missing href are
  // dropped to plain text -- TB's task UI sanitizes on render but the raw
  // markup is persisted in ALTREP and may be consumed by other clients.
  const anchors = [];
  let processed = input.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (whole, inner) => {
    const hrefMatch = whole.match(/href\s*=\s*(['"])([^'"]*)\1/i);
    const innerText = escapeText(inner.replace(/<[^>]+>/g, ""));
    if (!hrefMatch || !SAFE_HREF.test(hrefMatch[2].trim())) {
      return innerText;
    }
    anchors.push(`<a href="${escapeAttr(hrefMatch[2].trim())}">${innerText}</a>`);
    return `\x00ANCHOR${anchors.length - 1}\x00`;
  });

  // Escape remaining plain text, then auto-link bare URLs.
  processed = escapeText(processed).replace(
    /https?:\/\/[^\s<>"]+/g,
    url => `<a href="${escapeAttr(url)}">${url}</a>`
  );

  // Restore sanitized anchors and convert newlines.
  processed = processed.replace(/\x00ANCHOR(\d+)\x00/g, (_, i) => anchors[i]);
  return `<html><body><div>${processed.replace(/\n/g, "<br>")}</div></body></html>`;
}

const calendarEntity = {
  VEVENT_STATUS_MAP, calDateToISO, normalizeEventStatus,
  formatEvent, formatTask, descriptionToHTML,
};

// Dual export: usable both as a register(ctx) sub-script (production) and a
// plain CommonJS require() (so a future Node unit test can exercise the pure
// helpers directly, matching the security_helpers.js / contact.js pattern).
module.exports = function register(ctx) {
  Object.assign(ctx, { calendarEntity });
};
module.exports.calendarEntity = calendarEntity;
