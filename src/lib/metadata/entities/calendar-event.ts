import type { EntityDef } from "../types";

/**
 * Calendar event — the editable layer behind the bespoke `/calendar` screen.
 * `system: true` keeps it out of the auto-nav (managed via the calendar UI).
 * Viewing is granted to anyone with the calendar screen; only admins create/
 * edit/delete (see permissions/policies.ts).
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
    { name: "notes", label: "Notes", type: "text" },
  ],
};
