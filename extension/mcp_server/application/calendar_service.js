"use strict";

/**
 * application/calendar_service.js — calendar/task use-case orchestration.
 *
 * This is the body logic that used to sit inside the tool handlers in
 * domain/calendar.js, MINUS the XPCOM (now in
 * infrastructure/calendar_adapter.js) and MINUS the pure record-shaping /
 * string transforms (now in domain/entities/calendar.js).
 *
 * Responsibilities: the skipReview write-guard, input validation, date parsing,
 * the all-day vs timed branching, change-tracking, the two-phase recurring
 * query orchestration, the recurring-scope safety gates, error envelopes, and
 * calling the adapter. Behavior — including exact error strings, the
 * DTEND-exclusive handling, the OCCURRENCE_EXPANSION_CAP/TASK_COLLECTION_CAP
 * arithmetic, and the sort orders — is preserved verbatim from the original
 * domain/calendar.js.
 *
 * Consumes from ctx:
 *   calendarAdapter, calendarEntity, isSkipReviewBlocked
 * Registers onto ctx:
 *   calendarService = { listCalendars, createEvent, listEvents, updateEvent,
 *                       deleteEvent, listCategories, createTask, listTasks,
 *                       updateTask }
 */
module.exports = function register(ctx) {
  const { calendarAdapter, calendarEntity, isSkipReviewBlocked } = ctx;
  const { normalizeEventStatus, formatEvent, formatTask, descriptionToHTML } = calendarEntity;

  function listCalendars() {
    if (!calendarAdapter.available()) {
      return { error: "Calendar not available" };
    }
    try {
      return calendarAdapter.getCalendars().map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        readOnly: c.readOnly,
        supportsEvents: c.getProperty("capabilities.events.supported") !== false,
        supportsTasks: c.getProperty("capabilities.tasks.supported") !== false,
      }));
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function createEvent(title, startDate, endDate, location, description, calendarId, allDay, skipReview, status, showAs, categories, onlineMeeting) {
    if (!calendarAdapter.eventsAvailable()) {
      return { error: "Calendar module not available" };
    }
    if (skipReview && isSkipReviewBlocked()) {
      return { error: "User preference blocks skipReview. Retry with skipReview: false (or omitted) to open the review dialog instead." };
    }
    try {
      const win = calendarAdapter.getMostRecentMailWindow();
      if (!win && !skipReview) {
        return { error: "No Thunderbird window found" };
      }

      const startJs = new Date(startDate);
      if (isNaN(startJs.getTime())) {
        return { error: `Invalid startDate: ${startDate}` };
      }

      let endJs = endDate ? new Date(endDate) : null;
      if (endDate && (!endJs || isNaN(endJs.getTime()))) {
        return { error: `Invalid endDate: ${endDate}` };
      }

      if (endJs) {
        if (allDay) {
          const startDay = new Date(startJs.getFullYear(), startJs.getMonth(), startJs.getDate());
          const endDay = new Date(endJs.getFullYear(), endJs.getMonth(), endJs.getDate());
          if (endDay.getTime() < startDay.getTime()) {
            return { error: "endDate must not be before startDate" };
          }
        } else if (endJs.getTime() <= startJs.getTime()) {
          return { error: "endDate must be after startDate" };
        }
      }

      const event = calendarAdapter.newEvent();
      event.title = title;

      if (allDay) {
        const startDt = calendarAdapter.makeAllDayDateTime(startJs.getFullYear(), startJs.getMonth(), startJs.getDate());
        event.startDate = startDt;

        let endDt;
        if (endJs) {
          endDt = calendarAdapter.makeAllDayDateTime(endJs.getFullYear(), endJs.getMonth(), endJs.getDate());
          // iCal DTEND is exclusive — bump if same as start
          if (calendarAdapter.compareDateTimes(endDt, startDt) <= 0) {
            const bumpedEnd = new Date(endJs.getFullYear(), endJs.getMonth(), endJs.getDate());
            bumpedEnd.setDate(bumpedEnd.getDate() + 1);
            endDt = calendarAdapter.makeAllDayDateTime(
              bumpedEnd.getFullYear(),
              bumpedEnd.getMonth(),
              bumpedEnd.getDate()
            );
          }
        } else {
          const defaultEnd = new Date(startJs.getTime());
          defaultEnd.setDate(defaultEnd.getDate() + 1);
          endDt = calendarAdapter.makeAllDayDateTime(
            defaultEnd.getFullYear(),
            defaultEnd.getMonth(),
            defaultEnd.getDate()
          );
        }
        event.endDate = endDt;
      } else {
        event.startDate = calendarAdapter.makeTimedDateTime(startJs);
        if (endJs) {
          event.endDate = calendarAdapter.makeTimedDateTime(endJs);
        } else {
          const defaultEnd = new Date(startJs.getTime() + 3600000);
          event.endDate = calendarAdapter.makeTimedDateTime(defaultEnd);
        }
      }

      if (location) calendarAdapter.setProp(event, "LOCATION", location);
      if (description) calendarAdapter.setProp(event, "DESCRIPTION", description);
      if (showAs !== undefined && showAs !== null && showAs !== "busy" && showAs !== "free") {
        return { error: `Invalid showAs: "${showAs}". Expected "busy" or "free".` };
      }
      // STATUS: explicit param wins; otherwise derive from showAs so Thunderbird renders busy=solid, free=hatched
      const effectiveStatus = (status !== undefined && status !== null && status !== "")
        ? status
        : (showAs === "free" ? "tentative" : "confirmed");
      const normalizedStatus = normalizeEventStatus(effectiveStatus);
      if (!normalizedStatus) {
        return { error: `Invalid status: "${effectiveStatus}". Expected tentative, confirmed, or cancelled.` };
      }
      calendarAdapter.setProp(event, "STATUS", normalizedStatus);
      calendarAdapter.setProp(event, "TRANSP", showAs === "free" ? "TRANSPARENT" : "OPAQUE");
      if (categories && categories.length > 0) event.setCategories(categories);
      if (onlineMeeting) calendarAdapter.setProp(event, "X-ONLINE-MEETING-PROVIDER", "TeamsForBusiness");

      // Find target calendar
      let targetCalendar = null;
      if (calendarId) {
        targetCalendar = calendarAdapter.findCalendar(calendarId);
        if (!targetCalendar) {
          return { error: `Calendar not found: ${calendarId}` };
        }
        if (targetCalendar.readOnly) {
          return { error: `Calendar is read-only: ${targetCalendar.name}` };
        }
      } else {
        targetCalendar = calendarAdapter.findWritableCalendar();
        if (!targetCalendar) {
          return { error: "No writable calendar found" };
        }
      }

      event.calendar = targetCalendar;

      if (skipReview) {
        await calendarAdapter.addItem(targetCalendar, event);
        return { success: true, message: `Event "${title}" added to calendar "${targetCalendar.name}"` };
      }

      calendarAdapter.openEventDialog(win, event, targetCalendar);

      return { success: true, message: `Event dialog opened for "${title}" on calendar "${targetCalendar.name}"` };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function listEvents(calendarId, startDate, endDate, maxResults) {
    if (!calendarAdapter.available()) {
      return { error: "Calendar not available" };
    }
    try {
      let targets = calendarAdapter.getCalendars();
      if (calendarId) {
        const found = calendarAdapter.findCalendar(calendarId);
        if (!found) return { error: `Calendar not found: ${calendarId}` };
        targets = [found];
      }

      const startJs = startDate ? new Date(startDate) : new Date();
      if (isNaN(startJs.getTime())) return { error: `Invalid startDate: ${startDate}` };
      const endJs = endDate ? new Date(endDate) : new Date(startJs.getTime() + 30 * 86400000);
      if (isNaN(endJs.getTime())) return { error: `Invalid endDate: ${endDate}` };

      const rangeStart = calendarAdapter.makeTimedDateTime(startJs);
      const rangeEnd = calendarAdapter.makeTimedDateTime(endJs);
      const limit = Math.min(Math.max(maxResults || 100, 1), 500);

      // Two-phase query to correctly handle recurring events.
      //
      // The FILTER_OCCURRENCES flag is intended to make the storage layer
      // expand recurring masters and return individual occurrences within the
      // date range. In practice this does not work for offline-backed calendars
      // (e.g. OWL/Exchange): recurring masters are stored with event_start set
      // to their original first occurrence date, which is typically outside the
      // queried range, so a date-range query never returns them and the manual
      // expansion at the call site never runs.
      //
      // Fix — Phase 1: fetch non-recurring events and modified-occurrence
      // exceptions within the date range (their event_start is inside the
      // range). Phase 2: fetch ALL recurring masters without a date filter,
      // then expand each with recurrenceInfo.getOccurrences() and keep only
      // occurrences that fall within the queried range.
      const results = [];
      for (const calendar of targets) {
        // Phase 1: non-recurring events + modified-occurrence exceptions.
        // Bounded by the date range so no expansion cap is needed here --
        // applying one would risk starving Phase 2 on wide ranges.
        const rangeItems = await calendarAdapter.getCalendarItems(calendar, rangeStart, rangeEnd);
        for (const item of rangeItems) {
          if (!item.recurrenceInfo) results.push(formatEvent(item, calendar));
        }

        // Phase 2: all recurring masters (no date filter) → manual expansion.
        let allItems = [];
        try {
          allItems = await calendarAdapter.getAllEvents(calendar);
        } catch {
          allItems = rangeItems;
        }

        // Cap recurring expansion to prevent a malformed daily-over-decades
        // master from blowing up the result. Tracked independently of Phase 1
        // so a busy date range cannot starve recurring expansion.
        const OCCURRENCE_EXPANSION_CAP = limit * 10;
        let expanded = 0;
        for (const item of allItems) {
          if (expanded >= OCCURRENCE_EXPANSION_CAP) break;
          if (!item.recurrenceInfo) continue;
          try {
            const occurrences = calendarAdapter.getOccurrences(item, rangeStart, rangeEnd);
            for (const occ of occurrences) {
              if (expanded >= OCCURRENCE_EXPANSION_CAP) break;
              results.push(formatEvent(occ, calendar));
              expanded++;
            }
          } catch (e) {
            // Don't push the master on failure -- its event_start is the original
            // first-occurrence date and is almost certainly outside the queried
            // range, which would pollute results with stale events.
            console.warn("thunderbird-mcp: recurrence expansion failed for", item.id || item.title, e);
          }
        }
      }

      results.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
      return results.slice(0, limit);
    } catch (e) {
      return { error: e.toString() };
    }
  }

  function listCategories() {
    try {
      return calendarAdapter.listCategories();
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function updateEvent(eventId, calendarId, title, startDate, endDate, location, description, status, showAs, categories, onlineMeeting, recurringScope) {
    if (!calendarAdapter.available()) return { error: "Calendar not available" };
    try {
      if (!eventId) return { error: "eventId is required" };
      if (!calendarId) return { error: "calendarId is required" };

      const calendar = calendarAdapter.findCalendar(calendarId);
      if (!calendar) return { error: `Calendar not found: ${calendarId}` };
      if (calendar.readOnly) return { error: `Calendar is read-only: ${calendar.name}` };

      // Use getItem API if available, else scan
      const oldItem = await calendarAdapter.findItemById(calendar, eventId, null);
      if (!oldItem) return { error: `Event not found: ${eventId}` };

      // SAFETY: refuse to silently rewrite an entire recurring
      // series. updateItem on a recurring master applies the
      // change to every past and future occurrence, which is
      // surprising and rarely what an agent intended. Require
      // the caller to explicitly opt in via recurringScope.
      if (oldItem.recurrenceInfo && recurringScope !== "series") {
        return {
          error: "Refusing to update a recurring event without an explicit recurringScope. Pass recurringScope: 'series' to rewrite the entire series. Per-occurrence updates are not supported via this API; use Thunderbird's UI.",
        };
      }

      const newItem = calendarAdapter.cloneItem(oldItem);
      const changes = [];

      if (title !== undefined) { newItem.title = title; changes.push("title"); }

      if (startDate !== undefined) {
        const js = new Date(startDate);
        if (isNaN(js.getTime())) return { error: `Invalid startDate: ${startDate}` };
        if (calendarAdapter.isAllDayItem(newItem.startDate)) {
          newItem.startDate = calendarAdapter.makeAllDayDateTime(js.getFullYear(), js.getMonth(), js.getDate());
        } else {
          newItem.startDate = calendarAdapter.makeTimedDateTime(js);
        }
        changes.push("startDate");
      }

      if (endDate !== undefined) {
        const js = new Date(endDate);
        if (isNaN(js.getTime())) return { error: `Invalid endDate: ${endDate}` };
        if (calendarAdapter.isAllDayItem(newItem.endDate)) {
          // iCal DTEND is exclusive for all-day -- bump by 1 day
          const next = new Date(js.getFullYear(), js.getMonth(), js.getDate());
          next.setDate(next.getDate() + 1);
          newItem.endDate = calendarAdapter.makeAllDayDateTime(next.getFullYear(), next.getMonth(), next.getDate());
        } else {
          newItem.endDate = calendarAdapter.makeTimedDateTime(js);
        }
        changes.push("endDate");
      }

      if (location !== undefined) { calendarAdapter.setProp(newItem, "LOCATION", location); changes.push("location"); }
      if (description !== undefined) { calendarAdapter.setProp(newItem, "DESCRIPTION", description); changes.push("description"); }
      if (status !== undefined) {
        if (status === null || status === "") {
          calendarAdapter.deleteProp(newItem, "STATUS");
        } else {
          const normalized = normalizeEventStatus(status);
          if (!normalized) {
            return { error: `Invalid status: "${status}". Expected tentative, confirmed, or cancelled.` };
          }
          calendarAdapter.setProp(newItem, "STATUS", normalized);
        }
        changes.push("status");
      }
      if (showAs !== undefined) {
        if (showAs === null || showAs === "") {
          calendarAdapter.deleteProp(newItem, "TRANSP");
        } else if (showAs === "free") {
          calendarAdapter.setProp(newItem, "TRANSP", "TRANSPARENT");
          // Also set STATUS:TENTATIVE for Thunderbird visual display unless caller overrides
          if (status === undefined) { calendarAdapter.setProp(newItem, "STATUS", "TENTATIVE"); changes.push("status"); }
        } else if (showAs === "busy") {
          calendarAdapter.setProp(newItem, "TRANSP", "OPAQUE");
          // Also set STATUS:CONFIRMED for Thunderbird visual display unless caller overrides
          if (status === undefined) { calendarAdapter.setProp(newItem, "STATUS", "CONFIRMED"); changes.push("status"); }
        } else {
          return { error: `Invalid showAs: "${showAs}". Expected "busy" or "free".` };
        }
        changes.push("showAs");
      }
      // null/undefined preserves existing categories; empty array clears them.
      if (Array.isArray(categories)) {
        newItem.setCategories(categories);
        changes.push("categories");
      }
      if (onlineMeeting !== undefined) {
        if (onlineMeeting) {
          calendarAdapter.setProp(newItem, "X-ONLINE-MEETING-PROVIDER", "TeamsForBusiness");
        } else {
          calendarAdapter.deleteProp(newItem, "X-ONLINE-MEETING-PROVIDER");
          calendarAdapter.deleteProp(newItem, "X-MICROSOFT-SKYPETEAMSMEETINGURL");
        }
        changes.push("onlineMeeting");
      }

      if (changes.length === 0) return { error: "No changes specified" };

      // Validate end > start after all changes
      if (newItem.startDate && newItem.endDate && calendarAdapter.compareDateTimes(newItem.endDate, newItem.startDate) <= 0) {
        return { error: "endDate must be after startDate" };
      }

      await calendarAdapter.modifyItem(calendar, newItem, oldItem);
      const result = { success: true, updated: changes };
      if (oldItem.recurrenceInfo) {
        result.warning = "This is a recurring event -- changes apply to the entire series.";
      }
      return result;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function deleteEvent(eventId, calendarId, recurringScope) {
    if (!calendarAdapter.available()) return { error: "Calendar not available" };
    try {
      if (!eventId) return { error: "eventId is required" };
      if (!calendarId) return { error: "calendarId is required" };

      const calendar = calendarAdapter.findCalendar(calendarId);
      if (!calendar) return { error: `Calendar not found: ${calendarId}` };
      if (calendar.readOnly) return { error: `Calendar is read-only: ${calendar.name}` };

      const item = await calendarAdapter.findItemById(calendar, eventId, null);
      if (!item) return { error: `Event not found: ${eventId}` };

      const isRecurring = !!item.recurrenceInfo;
      if (isRecurring && recurringScope !== "series") {
        return {
          error: "Refusing to delete a recurring event without an explicit recurringScope. Pass recurringScope: 'series' to delete every occurrence. Per-occurrence deletion is not supported via this API; use Thunderbird's UI.",
        };
      }

      await calendarAdapter.deleteItem(calendar, item);
      const result = { success: true, deleted: eventId };
      if (isRecurring) {
        result.warning = "The entire series was deleted.";
      }
      return result;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function createTask(title, dueDate, calendarId, description, priority, categories, skipReview) {
    if (!calendarAdapter.tasksAvailable()) return { error: "Calendar module not available" };
    if (skipReview && isSkipReviewBlocked()) {
      return { error: "User preference blocks skipReview. Retry with skipReview: false (or omitted) to open the review dialog instead." };
    }
    try {
      let dueDt = null;
      if (dueDate) {
        const js = new Date(dueDate);
        if (isNaN(js.getTime())) return { error: `Invalid dueDate: ${dueDate}` };
        // Date-only string (YYYY-MM-DD) means all-day
        dueDt = calendarAdapter.dateTimeFromInput(js, /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim()));
      }

      // Find target calendar (must support tasks)
      let targetCalendar = null;
      if (calendarId) {
        targetCalendar = calendarAdapter.findCalendar(calendarId);
        if (!targetCalendar) return { error: `Calendar not found: ${calendarId}` };
        if (targetCalendar.readOnly) return { error: `Calendar is read-only: ${targetCalendar.name}` };
        if (targetCalendar.getProperty("capabilities.tasks.supported") === false) {
          return { error: `Calendar "${targetCalendar.name}" does not support tasks. Use listCalendars to find one with supportsTasks=true.` };
        }
      }

      // Build a fully-populated CalTodo. The extension runs in addon_parent
      // (main-process privileged context) and imports CalTodo from the same
      // resource:/// ESModule singleton as the chrome, so the object is fully
      // interoperable with createTodoWithDialog and the task edit dialog.
      if (priority !== undefined && priority !== null) {
        if (!Number.isInteger(priority) || priority < 0 || priority > 9) {
          return { error: "priority must be an integer between 0 and 9 (0=unset, 1=high, 5=normal, 9=low)" };
        }
      }

      const todo = calendarAdapter.newTodo();
      todo.title = title;
      if (dueDt) todo.dueDate = dueDt;
      if (description) todo.descriptionHTML = descriptionToHTML(description);
      if (priority !== undefined && priority !== null) todo.priority = priority;
      if (categories && categories.length > 0) todo.setCategories(categories);
      if (targetCalendar) todo.calendar = targetCalendar;

      if (skipReview) {
        if (!targetCalendar) {
          targetCalendar = calendarAdapter.findWritableTaskCalendar();
          if (!targetCalendar) return { error: "No writable task-capable calendar found" };
          todo.calendar = targetCalendar;
        }
        await calendarAdapter.addItem(targetCalendar, todo);
        return { success: true, message: `Task "${title}" created in calendar "${targetCalendar.name}"` };
      }

      const win = calendarAdapter.getMostRecentMailWindow();
      if (!win) return { error: "No Thunderbird window found" };

      // Pass the pre-populated CalTodo to the dialog. createTodoWithDialog
      // clones it (clearing the id) before opening, so all fields are
      // pre-filled and the user can review or cancel without side effects.
      calendarAdapter.openTodoDialog(win, targetCalendar, dueDt, todo);

      return { success: true, message: `Task dialog opened for "${title}"` };
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function listTasks(calendarId, completed, dueBefore, maxResults) {
    if (!calendarAdapter.available()) return { error: "Calendar not available" };
    try {
      const calendars = calendarAdapter.getCalendars();
      let targets = calendars.filter(c =>
        c.getProperty("capabilities.tasks.supported") !== false
      );
      if (calendarId) {
        const found = calendars.find(c => c.id === calendarId);
        if (!found) return { error: `Calendar not found: ${calendarId}` };
        if (found.getProperty("capabilities.tasks.supported") === false) {
          return { error: `Calendar "${found.name}" does not support tasks` };
        }
        targets = [found];
      }

      let dueBeforeDt = null;
      if (dueBefore) {
        const js = new Date(dueBefore);
        if (isNaN(js.getTime())) return { error: `Invalid dueBefore: ${dueBefore}` };
        dueBeforeDt = js;
      }

      const limit = Math.min(Math.max(maxResults || 100, 1), 500);
      // Thunderbird calICalendar filter bits:
      // TYPE_TODO = 1<<2, COMPLETED_YES = 1<<0, COMPLETED_NO = 1<<1
      const FILTER_TODO = 1 << 2;
      const COMPLETED_YES = 1 << 0;
      const COMPLETED_NO = 1 << 1;
      let itemFilter = FILTER_TODO;
      if (completed === true) {
        itemFilter |= COMPLETED_YES;
      } else if (completed === false) {
        itemFilter |= COMPLETED_NO;
      } else {
        itemFilter |= COMPLETED_YES | COMPLETED_NO;
      }
      const TASK_COLLECTION_CAP = limit * 10;
      const results = [];

      for (const calendar of targets) {
        let items;
        try {
          items = await calendarAdapter.getTaskItems(calendar, itemFilter);
        } catch {
          continue; // Skip calendars that fail to query
        }

        for (const item of items) {
          if (results.length >= TASK_COLLECTION_CAP) break;
          // Filter by due date -- exclude undated tasks when dueBefore is set
          if (dueBeforeDt) {
            if (!item.dueDate) continue;
            try {
              const due = new Date(item.dueDate.nativeTime / 1000);
              if (due >= dueBeforeDt) continue;
            } catch { /* include if we can't parse */ }
          }
          results.push(formatTask(item, calendar));
        }
      }

      // Sort by dueDate (nulls last), then title
      results.sort((a, b) => {
        if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return (a.title || "").localeCompare(b.title || "");
      });
      return results.slice(0, limit);
    } catch (e) {
      return { error: e.toString() };
    }
  }

  async function updateTask(taskId, calendarId, title, dueDate, description, completed, percentComplete, priority) {
    if (!calendarAdapter.available()) return { error: "Calendar not available" };
    try {
      if (!taskId) return { error: "taskId is required" };
      if (!calendarId) return { error: "calendarId is required" };

      const calendar = calendarAdapter.findCalendar(calendarId);
      if (!calendar) return { error: `Calendar not found: ${calendarId}` };
      if (calendar.readOnly) return { error: `Calendar is read-only: ${calendar.name}` };
      if (calendar.getProperty("capabilities.tasks.supported") === false) {
        return { error: `Calendar "${calendar.name}" does not support tasks. Use listCalendars to find one with supportsTasks=true.` };
      }

      // Try direct lookup first, then fall back to scanning all tasks
      const FILTER_TODO = 1 << 2;
      const COMPLETED_YES = 1 << 0;
      const COMPLETED_NO = 1 << 1;
      const oldItem = await calendarAdapter.findItemById(calendar, taskId, FILTER_TODO | COMPLETED_YES | COMPLETED_NO);
      if (!oldItem) return { error: `Task not found: ${taskId}` };

      const newItem = calendarAdapter.cloneItem(oldItem);
      const changes = [];

      if (title !== undefined) { newItem.title = title; changes.push("title"); }
      if (description !== undefined) { newItem.descriptionHTML = descriptionToHTML(description); changes.push("description"); }
      if (priority !== undefined) {
        if (priority !== null && (!Number.isInteger(priority) || priority < 0 || priority > 9)) {
          return { error: "priority must be an integer between 0 and 9 (0=unset, 1=high, 5=normal, 9=low)" };
        }
        newItem.priority = priority ?? 0;
        changes.push("priority");
      }

      if (dueDate !== undefined) {
        // Explicit null or empty string clears the due date.
        // Without this, `new Date(null).getTime() === 0` would
        // silently write Unix epoch (1970-01-01) instead.
        if (dueDate === null || dueDate === "") {
          newItem.dueDate = null;
        } else {
          const js = new Date(dueDate);
          if (isNaN(js.getTime())) return { error: `Invalid dueDate: ${dueDate}` };
          newItem.dueDate = calendarAdapter.dateTimeFromInput(js, /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim()));
        }
        changes.push("dueDate");
      }

      // 'completed' and 'percentComplete' both control completion state.
      // Reject ambiguous input rather than guessing precedence.
      if (completed !== undefined && percentComplete !== undefined) {
        return { error: "Specify either 'completed' or 'percentComplete', not both" };
      }

      if (percentComplete !== undefined) {
        calendarAdapter.setTaskCompletionState(newItem, percentComplete);
        changes.push("percentComplete");
      }

      if (completed !== undefined) {
        calendarAdapter.setTaskCompletionState(newItem, completed ? 100 : 0);
        changes.push("completed");
      }

      if (changes.length === 0) return { error: "No changes specified" };

      await calendarAdapter.modifyItem(calendar, newItem, oldItem);
      const result = { success: true, updated: changes, task: formatTask(newItem, calendar) };
      if (newItem.recurrenceInfo) {
        result.warning = "This is a recurring task -- changes apply to the entire series.";
      }
      return result;
    } catch (e) {
      return { error: e.toString() };
    }
  }

  Object.assign(ctx, {
    calendarService: {
      listCalendars, createEvent, listEvents, updateEvent, deleteEvent,
      listCategories, createTask, listTasks, updateTask,
    },
  });
};
