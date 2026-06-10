import type { EntityDef } from "../types";

/**
 * A job position. Carries the base data-RBAC role plus the set of screens this
 * position may open (stored as a JSON array of screen keys in `screens`).
 * Managed by admins via the Settings → Positions screen.
 */
export const positionEntity: EntityDef = {
  name: "position",
  label: "Position",
  pluralLabel: "Positions",
  icon: "settings",
  group: "admin",
  titleField: "name",
  system: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, unique: true, searchable: true, sortable: true, min: 1, max: 120 },
    {
      name: "role",
      label: "Base Role",
      type: "enum",
      required: true,
      filterable: true,
      defaultValue: "sales_rep",
      helpText: "Data-level permissions (RBAC) this position inherits.",
      options: [
        { value: "admin", label: "Administrator", tone: "danger" },
        { value: "sales_manager", label: "Sales Manager", tone: "info" },
        { value: "sales_rep", label: "Sales Rep", tone: "neutral" },
        { value: "accountant", label: "Accountant", tone: "success" },
        { value: "warehouse_manager", label: "Warehouse Manager", tone: "warning" },
      ],
    },
    { name: "screens", label: "Screens", type: "text", helpText: "JSON array of screen keys this position can access." },
    { name: "permissions", label: "Permissions", type: "text", helpText: "JSON array of operation grants (entity:action). Empty = inherit the base role's defaults." },
    { name: "description", label: "Description", type: "string", max: 240 },
  ],
  listColumns: [
    { field: "name", width: 220 },
    { field: "role", width: 160 },
  ],
};
