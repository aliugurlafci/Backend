import type { EntityDef } from "../types";

/**
 * Direct/group chat message. Grouped by `conversationId` (a deterministic key
 * built from the sorted participant user ids). `participants` is a `,id,id,`
 * membership string used for server-side privacy filtering. Backs the bespoke
 * `/chat` screen and the `/chat/*` API (system → off the auto-nav). Normal users
 * never touch this through the generic entity API — see chat/service.ts.
 */
export const chatMessageEntity: EntityDef = {
  name: "chatMessage",
  label: "Message",
  pluralLabel: "Messages",
  icon: "chat",
  group: "crm",
  titleField: "conversationId",
  system: true,
  fields: [
    // NOT searchable on purpose: keeps DM content out of the tenant-wide search
    // index (privacy). The /chat API filters by conversationId/participants.
    { name: "conversationId", label: "Conversation", type: "string", required: true, filterable: true, min: 1, max: 200 },
    { name: "participants", label: "Participants", type: "string", required: true, filterable: true, max: 400 },
    { name: "fromUserId", label: "From", type: "string", filterable: true, max: 40 },
    { name: "author", label: "Author", type: "string", max: 160 },
    { name: "body", label: "Message", type: "text" },
    { name: "attachments", label: "Attachments", type: "text" },
  ],
  listColumns: [
    { field: "conversationId", width: 160 },
    { field: "author", width: 140 },
    { field: "body", width: 360 },
  ],
};
