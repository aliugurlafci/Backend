import type { EntityDef } from "../types";

/** Social-feed posts. Backs the bespoke `/social-feed` screen (system → off the auto-nav). */
export const postEntity: EntityDef = {
  name: "post",
  label: "Post",
  pluralLabel: "Social Feed",
  icon: "social",
  group: "crm",
  titleField: "author",
  system: true,
  fields: [
    { name: "author", label: "Author", type: "string", required: true, searchable: true, max: 120 },
    { name: "body", label: "Body", type: "text", required: true, searchable: true },
    { name: "likes", label: "Likes", type: "number", defaultValue: 0, min: 0 },
    { name: "liked", label: "Liked", type: "boolean", defaultValue: false },
    { name: "comments", label: "Comments", type: "number", defaultValue: 0, min: 0 },
    { name: "shares", label: "Shares", type: "number", defaultValue: 0, min: 0 },
  ],
  listColumns: [
    { field: "author", width: 160 },
    { field: "body", width: 400 },
  ],
};
