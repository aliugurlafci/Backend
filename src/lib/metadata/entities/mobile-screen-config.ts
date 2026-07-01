import type { EntityDef } from "../types";

/**
 * Per-scope mobile screen visibility. The companion mobile app renders only the
 * screens enabled here (intersected with the user's own screen permissions), so
 * admins can curate which destinations appear on phones without changing web
 * access. Resolution precedence is user > position > client-default — the most
 * specific active row wins. System entity: managed through the dedicated
 * `/mobile/*` admin endpoints, off the auto-nav and the generic entity CRUD.
 */
export const mobileScreenConfigEntity: EntityDef = {
  name: "mobileScreenConfig",
  label: "Mobile Screen Config",
  pluralLabel: "Mobile Screen Configs",
  icon: "settings",
  group: "admin",
  titleField: "clientId",
  system: true,
  fields: [
    { name: "clientId", label: "Client", type: "string", filterable: true, max: 40, defaultValue: "*", helpText: "Target client: * (all), ios, android." },
    { name: "positionId", label: "Position", type: "string", filterable: true, max: 80, helpText: "Scope to a position (role). Empty = any." },
    { name: "userId", label: "User", type: "string", filterable: true, max: 80, helpText: "Scope to a single user. Empty = any." },
    { name: "screens", label: "Screens", type: "text", helpText: "JSON array of screen keys enabled on mobile." },
    { name: "hiddenFields", label: "Hidden Fields", type: "text", helpText: "JSON object { entity: [field,…] } masked on mobile." },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
};
