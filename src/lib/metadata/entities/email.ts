import type { EntityDef } from "../types";

/** Mailbox messages. Backs the bespoke `/email` screen (system → off the auto-nav). */
export const emailEntity: EntityDef = {
  name: "email",
  label: "Email",
  pluralLabel: "Emails",
  icon: "email",
  group: "crm",
  titleField: "subject",
  system: true,
  fields: [
    {
      name: "folder",
      label: "Folder",
      type: "enum",
      required: true,
      filterable: true,
      defaultValue: "inbox",
      options: [
        { value: "inbox", label: "Inbox" },
        { value: "sent", label: "Sent" },
        { value: "drafts", label: "Drafts" },
        { value: "spam", label: "Spam" },
        { value: "trash", label: "Trash" },
      ],
    },
    { name: "sender", label: "From / To", type: "string", required: true, searchable: true, max: 160 },
    { name: "subject", label: "Subject", type: "string", searchable: true, sortable: true, max: 200 },
    { name: "body", label: "Body", type: "text", searchable: true },
    { name: "unread", label: "Unread", type: "boolean", filterable: true, defaultValue: true },
    { name: "starred", label: "Starred", type: "boolean", filterable: true, defaultValue: false },
    // Custom-folder membership (→ emailFolder). Empty = lives in its base `folder`.
    { name: "folderId", label: "Folder", type: "reference", referenceEntity: "emailFolder", filterable: true },
    // RFC Message-ID — used to dedupe synced mail precisely (one row per real email).
    { name: "messageId", label: "Message ID", type: "text" },
  ],
  listColumns: [
    { field: "sender", width: 180 },
    { field: "subject", width: 280 },
    { field: "folder", width: 100 },
  ],
};
