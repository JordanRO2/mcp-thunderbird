"use strict";

/**
 * interface/calendar_tools.js — the 9 calendar/task MCP tool handlers.
 *
 * Thin edge: each handler maps the raw tool-call args to a calendarService
 * method (the central validateToolArgs/coerceToolArgs in dispatch.js already
 * ran). Handlers are registered into the dispatch registry via
 * ctx.registerToolHandler(name, fn) so callTool routes calendar here instead of
 * the legacy switch in api.js.
 *
 * Tool names/args/behavior are preserved exactly (matching the old legacy
 * switch arg order):
 *   listCalendars()
 *   createEvent(title, startDate, endDate, location, description, calendarId, allDay, skipReview, status, showAs, categories, onlineMeeting)
 *   listEvents(calendarId, startDate, endDate, maxResults)
 *   updateEvent(eventId, calendarId, title, startDate, endDate, location, description, status, showAs, categories, onlineMeeting, recurringScope)
 *   deleteEvent(eventId, calendarId, recurringScope)
 *   listCategories()
 *   createTask(title, dueDate, calendarId, description, priority, categories, skipReview)
 *   listTasks(calendarId, completed, dueBefore, maxResults)
 *   updateTask(taskId, calendarId, title, dueDate, description, completed, percentComplete, priority)
 *
 * The CALENDAR_TOOL_DEFS below mirror the metadata for these tools. The LIVE
 * `tools` array in api.js remains the single source of truth (a structural
 * test parses api.js for the `{ name: "…" }` declarations); these defs exist so
 * a reader can see the calendar surface in one place and so a future api.js can
 * assemble its array from per-domain contributions without changing the test.
 *
 * Consumes from ctx: calendarService, registerToolHandler
 * Registers onto ctx:
 *   listCalendars, createEvent, listEvents, updateEvent, deleteEvent,
 *   listCategories, createTask, listTasks, updateTask  (back-compat, so the
 *     legacy api.js destructure still finds them if referenced),
 *   CALENDAR_TOOL_DEFS
 */
// Exact mirror of the calendar entries in api.js's `tools` array (the live
// source of truth). Kept in sync for documentation; api.js is authoritative.
const CALENDAR_TOOL_DEFS = [
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
        categories: { type: "array", items: { type: "string" }, description: "Category labels (optional). Category names are case-sensitive; use listCategories to get exact existing names before setting." },
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
        categories: { type: "array", items: { type: "string" }, description: "Category labels (optional). Category names are case-sensitive; pass an empty array to clear all categories. Use listCategories to get exact existing names before setting." },
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
];

module.exports = function register(ctx) {
  const { calendarService, registerToolHandler } = ctx;

  function listCalendars() {
    return calendarService.listCalendars();
  }
  function createEvent(title, startDate, endDate, location, description, calendarId, allDay, skipReview, status, showAs, categories, onlineMeeting) {
    return calendarService.createEvent(title, startDate, endDate, location, description, calendarId, allDay, skipReview, status, showAs, categories, onlineMeeting);
  }
  function listEvents(calendarId, startDate, endDate, maxResults) {
    return calendarService.listEvents(calendarId, startDate, endDate, maxResults);
  }
  function updateEvent(eventId, calendarId, title, startDate, endDate, location, description, status, showAs, categories, onlineMeeting, recurringScope) {
    return calendarService.updateEvent(eventId, calendarId, title, startDate, endDate, location, description, status, showAs, categories, onlineMeeting, recurringScope);
  }
  function deleteEvent(eventId, calendarId, recurringScope) {
    return calendarService.deleteEvent(eventId, calendarId, recurringScope);
  }
  function listCategories() {
    return calendarService.listCategories();
  }
  function createTask(title, dueDate, calendarId, description, priority, categories, skipReview) {
    return calendarService.createTask(title, dueDate, calendarId, description, priority, categories, skipReview);
  }
  function listTasks(calendarId, completed, dueBefore, maxResults) {
    return calendarService.listTasks(calendarId, completed, dueBefore, maxResults);
  }
  function updateTask(taskId, calendarId, title, dueDate, description, completed, percentComplete, priority) {
    return calendarService.updateTask(taskId, calendarId, title, dueDate, description, completed, percentComplete, priority);
  }

  // Wire into the dispatch registry. The handler receives the raw args object;
  // we unpack it into the original positional signature so behavior matches the
  // old switch case exactly.
  registerToolHandler("listCalendars", () => listCalendars());
  registerToolHandler("createEvent", (args) => createEvent(args.title, args.startDate, args.endDate, args.location, args.description, args.calendarId, args.allDay, args.skipReview, args.status, args.showAs, args.categories, args.onlineMeeting));
  registerToolHandler("listEvents", (args) => listEvents(args.calendarId, args.startDate, args.endDate, args.maxResults));
  registerToolHandler("updateEvent", (args) => updateEvent(args.eventId, args.calendarId, args.title, args.startDate, args.endDate, args.location, args.description, args.status, args.showAs, args.categories, args.onlineMeeting, args.recurringScope));
  registerToolHandler("deleteEvent", (args) => deleteEvent(args.eventId, args.calendarId, args.recurringScope));
  registerToolHandler("listCategories", () => listCategories());
  registerToolHandler("createTask", (args) => createTask(args.title, args.dueDate, args.calendarId, args.description, args.priority, args.categories, args.skipReview));
  registerToolHandler("listTasks", (args) => listTasks(args.calendarId, args.completed, args.dueBefore, args.maxResults));
  registerToolHandler("updateTask", (args) => updateTask(args.taskId, args.calendarId, args.title, args.dueDate, args.description, args.completed, args.percentComplete, args.priority));

  // Back-compat: also expose the bare functions on ctx (the old api.js
  // destructured these from the domain ctx). Harmless if unused.
  Object.assign(ctx, {
    listCalendars, createEvent, listEvents, updateEvent, deleteEvent,
    listCategories, createTask, listTasks, updateTask,
    CALENDAR_TOOL_DEFS,
  });
};
module.exports.CALENDAR_TOOL_DEFS = CALENDAR_TOOL_DEFS;
