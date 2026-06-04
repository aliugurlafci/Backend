import type { EntityDef } from "../types";

/** Chat messages, grouped by `peer`. Backs the bespoke `/chat` screen (system → off the auto-nav). */
export const chatMessageEntity: EntityDef = {
  name: "chatMessage",
  label: "Message",
  pluralLabel: "Messages",
  icon: "chat",
  group: "crm",
  titleField: "peer",
  system: true,
  fields: [
    { name: "peer", label: "Peer", type: "string", required: true, searchable: true, sortable: true, filterable: true, min: 1, max: 160 },
    { name: "author", label: "Author", type: "string", searchable: true, max: 120 },
    { name: "body", label: "Message", type: "text", required: true, searchable: true },
    { name: "fromMe", label: "From Me", type: "boolean", defaultValue: true },
  ],
  listColumns: [
    { field: "peer", width: 180 },
    { field: "body", width: 420 },
  ],
};
