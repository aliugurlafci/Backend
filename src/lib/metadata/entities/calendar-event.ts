import type { EntityDef } from "../types";

/**
 * Calendar event — the editable layer behind the bespoke `/calendar` screen.
 * `system: true` keeps it out of the auto-nav (managed via the calendar UI).
 * Viewing is granted to anyone with the calendar screen; only admins create/
 * edit/delete (see permissions/policies.ts).
 *
 * A day holds as many events as you like; `startTime`/`endTime` order them
 * within the day and `allDay` marks the ones without a clock time.
 */
export const calendarEventEntity: EntityDef = {
  name: "calendarEvent",
  label: "Event",
  pluralLabel: "Events",
  icon: "calendar",
  group: "crm",
  system: true,
  titleField: "title",
  fields: [
    { name: "title", label: "Title", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 200 },
    { name: "date", label: "Date", type: "date", required: true, sortable: true, filterable: true },
    { name: "endDate", label: "End Date", type: "date", sortable: true, helpText: "For events spanning several days." },
    { name: "allDay", label: "All Day", type: "boolean", filterable: true, defaultValue: true },
    { name: "startTime", label: "Start Time", type: "string", max: 5, helpText: "HH:MM (24h)." },
    { name: "endTime", label: "End Time", type: "string", max: 5, helpText: "HH:MM (24h)." },
    {
      name: "type",
      label: "Type",
      type: "enum",
      filterable: true,
      defaultValue: "event",
      options: [
        { value: "event", label: "Event", tone: "info" },
        { value: "meeting", label: "Meeting", tone: "success" },
        { value: "reminder", label: "Reminder", tone: "warning" },
        { value: "deadline", label: "Deadline", tone: "danger" },
      ],
    },
    {
      name: "status",
      label: "Status",
      type: "enum",
      filterable: true,
      defaultValue: "planned",
      options: [
        { value: "planned", label: "Planned", tone: "info" },
        { value: "done", label: "Completed", tone: "success" },
        { value: "cancelled", label: "Cancelled", tone: "neutral" },
      ],
    },
    {
      name: "priority",
      label: "Priority",
      type: "enum",
      filterable: true,
      defaultValue: "normal",
      options: [
        { value: "low", label: "Low", tone: "neutral" },
        { value: "normal", label: "Normal", tone: "info" },
        { value: "high", label: "High", tone: "warning" },
        { value: "urgent", label: "Urgent", tone: "danger" },
      ],
    },
    { name: "location", label: "Location", type: "string", max: 200 },
    // Attendees are stored as a JSON array of user ids (the calendar UI edits it
    // with a multi-select); a join entity would be overkill for a per-event list.
    { name: "attendees", label: "Attendees", type: "text", helpText: "JSON array of user ids." },
    { name: "ownerUserId", label: "Owner", type: "reference", referenceEntity: "user", filterable: true },
    // Free-form link to the record the event is about (account, deal, task…).
    { name: "relatedEntity", label: "Related To", type: "string", max: 60 },
    { name: "relatedId", label: "Related Record", type: "string", max: 60 },
    { name: "reminderMinutes", label: "Reminder (minutes before)", type: "number" },
    { name: "notes", label: "Notes", type: "text" },
  ],
};
