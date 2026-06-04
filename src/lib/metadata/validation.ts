/**
 * Phase 2 — derive runtime record validators from metadata.
 *
 * Given an EntityDef, build Zod schemas for create/update payloads so the data
 * layer (Phase 5) validates writes against the published metadata contract.
 * Returns plain issues rather than throwing so the caller (enforcement layer)
 * owns the structured error shape.
 */
import { z } from "zod";
import type { EntityDef, FieldDef } from "./types";

export interface FieldIssue {
  field: string;
  message: string;
}

function fieldSchema(field: FieldDef): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (field.type) {
    case "number":
    case "currency":
    case "percent": {
      let n = z.number();
      if (typeof field.min === "number") n = n.min(field.min);
      if (typeof field.max === "number") n = n.max(field.max);
      base = n;
      break;
    }
    case "boolean":
      base = z.boolean();
      break;
    case "email":
      base = z.string().email();
      break;
    case "url":
      base = z.string().url();
      break;
    case "enum":
      base = z.enum(
        (field.options ?? []).map((o) => o.value) as [string, ...string[]],
      );
      break;
    case "date":
    case "datetime":
      base = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
        message: "invalid date",
      });
      break;
    case "string":
    case "text":
    case "phone":
    case "reference":
    default: {
      let s = z.string();
      if (field.type !== "reference") {
        if (typeof field.min === "number") s = s.min(field.min);
        if (typeof field.max === "number") s = s.max(field.max);
      }
      base = s;
      break;
    }
  }
  return base;
}

/** Build a create-payload schema (required fields enforced, system fields excluded). */
export function buildCreateSchema(entity: EntityDef): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of entity.fields) {
    if (field.readOnly || field.computed) continue;
    const s = fieldSchema(field);
    // A required field that carries a default may be omitted; defaults are
    // applied by the query engine after validation.
    const mustProvide = field.required && field.defaultValue === undefined;
    shape[field.name] = mustProvide ? s : s.nullish();
  }
  return z.object(shape).strip() as z.ZodType<Record<string, unknown>>;
}

/** Build an update-payload schema (everything optional). */
export function buildUpdateSchema(entity: EntityDef): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of entity.fields) {
    if (field.readOnly || field.computed) continue;
    shape[field.name] = fieldSchema(field).nullish();
  }
  return z.object(shape).strip() as z.ZodType<Record<string, unknown>>;
}

export interface ValidationOutcome {
  success: boolean;
  data?: Record<string, unknown>;
  issues?: FieldIssue[];
}

export function validateRecord(
  schema: z.ZodType<Record<string, unknown>>,
  payload: unknown,
): ValidationOutcome {
  const result = schema.safeParse(payload);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((i) => ({
      field: i.path.join(".") || "(root)",
      message: i.message,
    })),
  };
}
