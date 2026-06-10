import type { EntityDef } from "../types";

/**
 * Security activity log — an append-only record of sign-ins and security changes
 * (password change, 2FA enable/disable). Surfaced on Settings → Security so a
 * user can review recent account activity. System entity (no auto-nav).
 */
export const securityEventEntity: EntityDef = {
  name: "securityEvent",
  label: "Security Event",
  pluralLabel: "Security Activity",
  icon: "shield",
  group: "admin",
  titleField: "type",
  system: true,
  fields: [
    { name: "userId", label: "User", type: "reference", referenceEntity: "user", required: true, filterable: true },
    {
      name: "type",
      label: "Event",
      type: "enum",
      required: true,
      filterable: true,
      options: [
        { value: "sign_in", label: "Sign in", tone: "info" },
        { value: "password_changed", label: "Password changed", tone: "warning" },
        { value: "twofactor_enabled", label: "Two-factor enabled", tone: "success" },
        { value: "twofactor_disabled", label: "Two-factor disabled", tone: "danger" },
      ],
    },
    { name: "ip", label: "IP Address", type: "string", max: 64 },
    { name: "userAgent", label: "Device", type: "string", max: 400 },
    { name: "at", label: "When", type: "datetime", sortable: true },
  ],
  listColumns: [
    { field: "type", width: 160 },
    { field: "ip", width: 140 },
    { field: "at", width: 180 },
  ],
};
