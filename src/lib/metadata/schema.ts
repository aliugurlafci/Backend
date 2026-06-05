/**
 * Phase 2 — Metadata validation (Zod).
 *
 * Zod schemas that validate metadata *definitions* themselves (the shape of an
 * EntityDef), so a malformed entity can never be published into the registry.
 * Record-value validation derived from metadata lives in `validation.ts`.
 */
import { z } from "zod";

export const fieldTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "currency",
  "percent",
  "boolean",
  "date",
  "datetime",
  "email",
  "phone",
  "url",
  "enum",
  "reference",
]);

export const enumOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  tone: z
    .enum(["neutral", "info", "success", "warning", "danger"])
    .optional(),
});

export const fieldDefSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]*$/, "field name must be camelCase"),
    label: z.string().min(1),
    type: fieldTypeSchema,
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    pii: z.boolean().optional(),
    searchable: z.boolean().optional(),
    sortable: z.boolean().optional(),
    filterable: z.boolean().optional(),
    helpText: z.string().optional(),
    options: z.array(enumOptionSchema).optional(),
    referenceEntity: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    defaultValue: z.unknown().optional(),
    computed: z.boolean().optional(),
    suggest: z.boolean().optional(),
  })
  .refine((f) => f.type !== "enum" || (f.options?.length ?? 0) > 0, {
    message: "enum fields require at least one option",
  })
  .refine((f) => f.type !== "reference" || !!f.referenceEntity, {
    message: "reference fields require referenceEntity",
  });

export const lifecycleTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  action: z.string().min(1),
  requires: z.string().optional(),
  guards: z.array(z.string()).optional(),
});

export const lifecycleSchema = z.object({
  field: z.string().min(1),
  initial: z.string().min(1),
  states: z.array(z.string().min(1)).min(1),
  finalStates: z.array(z.string()).optional(),
  transitions: z.array(lifecycleTransitionSchema),
});

export const listColumnSchema = z.object({
  field: z.string().min(1),
  width: z.number().optional(),
});

export const entityDefSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "entity name must be camelCase"),
    label: z.string().min(1),
    pluralLabel: z.string().min(1),
    icon: z.string().optional(),
    titleField: z.string().min(1),
    fields: z.array(fieldDefSchema).min(1),
    lifecycle: lifecycleSchema.optional(),
    listColumns: z.array(listColumnSchema).optional(),
    ownable: z.boolean().optional(),
    group: z
      .enum([
        "crm", "sales", "inventory", "purchasing", "accounting",
        "projects", "marketing", "support", "people", "finance", "branches", "admin",
      ])
      .optional(),
    viewType: z.enum(["table", "board", "calendar"]).optional(),
    board: z.object({ groupByField: z.string().min(1) }).optional(),
    calendar: z.object({ dateField: z.string().min(1) }).optional(),
    parent: z.object({ entity: z.string().min(1), field: z.string().min(1) }).optional(),
    system: z.boolean().optional(),
  })
  .superRefine((entity, ctx) => {
    const names = new Set(entity.fields.map((f) => f.name));
    if (!names.has(entity.titleField)) {
      ctx.addIssue({
        code: "custom",
        message: `titleField "${entity.titleField}" is not a defined field`,
      });
    }
    if (entity.lifecycle && !names.has(entity.lifecycle.field)) {
      ctx.addIssue({
        code: "custom",
        message: `lifecycle.field "${entity.lifecycle.field}" is not a defined field`,
      });
    }
    if (entity.lifecycle) {
      const valid = new Set(entity.lifecycle.states);
      for (const t of entity.lifecycle.transitions) {
        if (!valid.has(t.from) || !valid.has(t.to)) {
          ctx.addIssue({
            code: "custom",
            message: `transition ${t.from}->${t.to} references unknown state`,
          });
        }
      }
    }
  });

export type EntityDefInput = z.infer<typeof entityDefSchema>;
