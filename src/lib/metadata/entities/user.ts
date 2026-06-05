import type { EntityDef } from "../types";
import { branchRef, dealerRef } from "./shared";

/**
 * An application user (login). `passwordHash` is `computed` so it can never be
 * set by a client write — it is written server-side by the auth endpoints. The
 * user's data-role + screen access come from their {@link positionEntity}.
 */
export const userEntity: EntityDef = {
  name: "user",
  label: "User",
  pluralLabel: "Users",
  icon: "settings",
  group: "admin",
  titleField: "displayName",
  system: true,
  fields: [
    { name: "email", label: "Email", type: "email", required: true, unique: true, searchable: true, sortable: true, pii: true },
    { name: "displayName", label: "Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 160 },
    { name: "passwordHash", label: "Password", type: "string", computed: true, max: 400 },
    { name: "positionId", label: "Position", type: "reference", referenceEntity: "position", required: true, filterable: true },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
    // Org placement (merkez = headquarters branch, şube = branch, bayi = dealer)
    // — drives the chat user picker's grouping.
    branchRef(),
    dealerRef(),
    // self-service profile fields
    { name: "phone", label: "Phone", type: "phone", pii: true },
    { name: "timezone", label: "Timezone", type: "string", max: 64 },
    { name: "notificationPrefs", label: "Notification Preferences", type: "text" },
  ],
  listColumns: [
    { field: "displayName", width: 200 },
    { field: "email", width: 240 },
    { field: "active", width: 80 },
  ],
};
