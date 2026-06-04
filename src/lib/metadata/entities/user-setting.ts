import type { EntityDef } from "../types";

/**
 * Per-user configuration store (key/value). Backs the Settings screens —
 * appearance (theme/accent/density) and the mail-sync cadence are written here
 * via `/auth/settings`, scoped to the signed-in user. System entity: off the
 * auto-nav and not exposed through the generic entity CRUD UI.
 */
export const userSettingEntity: EntityDef = {
  name: "userSetting",
  label: "User Setting",
  pluralLabel: "User Settings",
  icon: "settings",
  group: "admin",
  titleField: "key",
  system: true,
  fields: [
    { name: "userId", label: "User", type: "string", required: true, filterable: true, max: 80 },
    { name: "key", label: "Key", type: "string", required: true, filterable: true, max: 80 },
    { name: "value", label: "Value", type: "text" },
  ],
};
