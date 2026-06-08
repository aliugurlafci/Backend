import type { EntityDef } from "../types";

/** A user-designed barcode/label template. `elements` holds the JSON layout
 *  (absolute mm-positioned barcode / text / field / price / image / line nodes)
 *  rendered by the shared LabelRenderer for both the designer preview and the
 *  print sheet. System entity — managed through the bespoke /label-designer
 *  screen, not the generic nav. */
export const labelTemplateEntity: EntityDef = {
  name: "labelTemplate",
  label: "Label Template",
  pluralLabel: "Label Templates",
  icon: "label",
  group: "inventory",
  titleField: "name",
  system: true,
  fields: [
    { name: "name", label: "Name", type: "string", required: true, searchable: true, sortable: true, min: 1, max: 80 },
    { name: "description", label: "Description", type: "string", max: 200 },
    { name: "widthMm", label: "Width (mm)", type: "number", required: true, defaultValue: 50, min: 5, max: 300 },
    { name: "heightMm", label: "Height (mm)", type: "number", required: true, defaultValue: 30, min: 5, max: 300 },
    { name: "dpi", label: "DPI", type: "number", defaultValue: 300, min: 72, max: 600 },
    { name: "elements", label: "Elements", type: "text", defaultValue: "[]" },
    { name: "branchId", label: "Branch", type: "reference", referenceEntity: "branch", filterable: true },
    { name: "active", label: "Active", type: "boolean", filterable: true, defaultValue: true },
  ],
  listColumns: [
    { field: "name", width: 220 },
    { field: "widthMm", width: 100 },
    { field: "heightMm", width: 100 },
    { field: "active", width: 90 },
  ],
};
