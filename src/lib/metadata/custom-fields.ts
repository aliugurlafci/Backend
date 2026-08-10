/**
 * Fields a user adds, without a deploy.
 *
 * The registry already does versioned draft → publish → archive, the schema
 * already heals itself towards whatever the metadata says, and the API, the zod
 * validation and the UI are all generated from an `EntityDef`. The missing piece
 * was somewhere to KEEP a definition between restarts — entities were compiled
 * into the binary, so "add a field" meant editing TypeScript.
 *
 * So this module is deliberately small. It reads the stored definitions, turns
 * them into ordinary `FieldDef`s, and hands them to the same pipeline that
 * built-in fields go through. A custom field is not a second kind of field with
 * its own storage and its own rules; it is the same kind, defined somewhere
 * else.
 *
 * What it does NOT do, on purpose:
 *
 *  - **Shadow a built-in.** Overriding `total` on an invoice with a user-defined
 *    string is not customisation, it is a way to make the ledger stop adding up.
 *  - **Drop a column.** Deactivating a field hides it; the data stays. A
 *    mis-click should not take a year of typing with it.
 */
import type { EntityDef, FieldDef } from "@aula/contracts/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { BadRequestError, ConflictError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";

/** A plain SQL identifier. It reaches DDL, so it is checked before it gets there. */
const NAME_RE = /^[a-z][a-zA-Z0-9_]{0,58}$/;

/**
 * Names a custom field may never take.
 *
 * The system columns every table has, plus the shapes the metadata layer treats
 * specially. A custom `id` or `version` would collide with a column the
 * repository writes itself, and the failure would appear as a corrupted record
 * rather than as a rejected definition.
 */
const RESERVED = new Set([
  "id",
  "tenantId",
  "orgId",
  "ownerId",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "version",
]);

export const fieldKeyOf = (entityName: string, name: string): string => `${entityName}:${name}`;

export interface CustomFieldInput {
  entityName: string;
  name: string;
  label: string;
  type: string;
  referenceEntity?: string | null;
  options?: string | null;
  required?: boolean;
  filterable?: boolean;
  searchable?: boolean;
  sortable?: boolean;
  helpText?: string | null;
  max?: number | null;
  defaultValue?: string | null;
  position?: number;
}

const ALLOWED_TYPES = new Set([
  "string",
  "text",
  "number",
  "currency",
  "percent",
  "boolean",
  "date",
  "datetime",
  "enum",
  "reference",
  "email",
  "phone",
]);

/**
 * Parse the stored choice list.
 *
 * `value|Label` per line, with the value doubling as the label when only one is
 * given — which is what somebody typing a quick list actually wants.
 */
export function parseOptions(raw: string | null | undefined): { value: string; label: string }[] {
  if (!raw) return [];
  return String(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label] = line.split("|");
      const v = (value ?? "").trim();
      return { value: v, label: (label ?? v).trim() };
    })
    .filter((o) => o.value !== "");
}

/** Turn a stored definition into the same `FieldDef` a built-in field is. */
export function toFieldDef(row: Record<string, unknown>): FieldDef {
  const type = String(row.type ?? "string") as FieldDef["type"];
  const field: FieldDef = {
    name: String(row.name),
    label: String(row.label ?? row.name),
    type,
  };
  if (row.required) field.required = true;
  if (row.filterable) field.filterable = true;
  if (row.searchable) field.searchable = true;
  if (row.sortable) field.sortable = true;
  if (row.helpText) field.helpText = String(row.helpText);
  if (row.max !== null && row.max !== undefined && Number(row.max) > 0) field.max = Number(row.max);
  if (type === "reference" && row.referenceEntity) field.referenceEntity = String(row.referenceEntity);
  if (type === "enum") field.options = parseOptions(row.options as string);
  if (row.defaultValue !== null && row.defaultValue !== undefined && String(row.defaultValue) !== "") {
    const raw = String(row.defaultValue);
    // Stored as text because one column has to hold every type's default. Coerced
    // here so a boolean default is a boolean and not the string "true", which
    // would fail validation on the first record created.
    field.defaultValue =
      type === "boolean" ? raw === "true" : type === "number" || type === "currency" || type === "percent" ? Number(raw) : raw;
  }
  return field;
}

/**
 * Check a definition before it can be stored.
 *
 * Everything here is a reason the schema could not be built, or could be built
 * into something harmful. Rejecting at definition time is the only place the
 * message can name what is wrong — a bad definition that reaches boot fails as
 * a migration error with no user in front of it.
 */
export function assertValidField(input: CustomFieldInput, entity: EntityDef): void {
  if (!NAME_RE.test(input.name)) {
    throw new BadRequestError(
      "a field name must start with a letter and contain only letters, digits and underscores",
    );
  }
  if (RESERVED.has(input.name)) {
    throw new BadRequestError(`"${input.name}" is a system column and cannot be redefined`).withKey("err.systemColumn", { name: input.name });
  }
  if (entity.fields.some((f) => f.name === input.name)) {
    // The built-in wins, always. Shadowing `total` on an invoice with a
    // user-defined string is not customisation.
    throw new ConflictError(`${entity.label} already has a field called "${input.name}"`).withKey("err.fieldExists", { entity: entity.name, name: input.name });
  }
  if (!ALLOWED_TYPES.has(input.type)) {
    throw new BadRequestError(`"${input.type}" is not a field type that can be added at runtime`).withKey("err.badRuntimeFieldType", { type: input.type });
  }
  if (input.type === "reference" && !input.referenceEntity) {
    throw new BadRequestError("a link field must say which entity it links to");
  }
  if (input.type === "enum" && parseOptions(input.options).length === 0) {
    throw new BadRequestError("a choice field needs at least one choice");
  }
  if (input.required && !input.defaultValue) {
    // A required column added to a table that already has rows has nothing to
    // put in them. The migration would either fail or silently write a value
    // nobody chose; asking for a default is the honest way out.
    throw new BadRequestError(
      "a required field needs a default value — existing records have nothing to put in it",
    );
  }
}

/**
 * Merge stored custom fields into the compiled entity definitions.
 *
 * Applied at boot and again whenever the definitions change. Inactive fields are
 * still merged: the column exists and rows still hold data, and dropping it from
 * the metadata would make the repository stop selecting a column that is
 * physically there — the data would look deleted without being deleted, which is
 * the worst of both.
 */
export function mergeCustomFields(
  entities: readonly EntityDef[],
  rows: readonly Record<string, unknown>[],
): EntityDef[] {
  if (rows.length === 0) return [...entities];

  const byEntity = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row.entityName ?? "");
    if (!key) continue;
    const list = byEntity.get(key) ?? [];
    list.push(row);
    byEntity.set(key, list);
  }

  return entities.map((entity) => {
    const extras = byEntity.get(entity.name);
    if (!extras?.length) return entity;

    const known = new Set(entity.fields.map((f) => f.name));
    const added: FieldDef[] = [];
    for (const row of [...extras].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))) {
      const name = String(row.name ?? "");
      // A definition that collides with a built-in added since is dropped rather
      // than allowed to shadow it. The built-in is the one the code reads.
      if (!name || known.has(name)) {
        if (name) {
          logger.warn("custom field ignored — the entity now defines it itself", {
            entity: entity.name,
            field: name,
          });
        }
        continue;
      }
      known.add(name);
      added.push(toFieldDef(row));
    }
    return added.length ? { ...entity, fields: [...entity.fields, ...added] } : entity;
  });
}

/**
 * Read the stored definitions.
 *
 * Returns an empty list rather than throwing when the table is not there yet:
 * this runs during boot, and the very first boot of a fresh database has not
 * created it. A system that cannot start because it has no customisations is
 * worse than one that starts with none.
 */
export async function loadCustomFields(ctx: RequestContext): Promise<Record<string, unknown>[]> {
  try {
    const { getQueryEngine } = await import("@/lib/data/store");
    const qe = await getQueryEngine();
    return await qe.listComplete(ctx, "customField", {});
  } catch (error) {
    logger.warn("custom fields could not be read; continuing with the built-in model", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Rebuild the live data model from the built-in entities plus the stored
 * custom fields, and bring the schema up to it.
 *
 * Called at boot, and again whenever a definition changes. Three steps, in this
 * order and no other:
 *
 *  1. read the stored definitions,
 *  2. publish a new metadata version with them merged in,
 *  3. reconcile the schema, which adds the columns.
 *
 * Publishing before migrating is what makes the migration know what to build:
 * the reconcile pass reads `metadata.listEntities()`, so a field that is not yet
 * in the published model is a column that is not yet created — and the first
 * write to it fails on a column that does not exist.
 */
export async function applyCustomFields(ctx: RequestContext): Promise<{ fields: number; version: number }> {
  const { crmEntities, metadataRegistry } = await import("@/lib/metadata");
  const { systemClock } = await import("@/lib/core/clock");

  const rows = await loadCustomFields(ctx);
  const merged = mergeCustomFields(crmEntities, rows);

  const draft = metadataRegistry.createDraft(merged);
  metadataRegistry.publish(draft.version, ctx.userId || "system", systemClock.isoNow());

  // In-memory mode has no physical schema to reconcile — the repository stores
  // whatever the metadata describes.
  const { usingInMemoryBackends } = await import("@/lib/config/env");
  if (!usingInMemoryBackends) {
    const { runMigrations } = await import("@/lib/data/sql/migrate");
    await runMigrations();

    // Then make the repository forget its column shapes.
    //
    // They are derived from the metadata and memoised for the life of the
    // process — correct while the model is compiled in, wrong the moment a
    // field can be added at runtime. Without this the field exists in the
    // metadata, exists as a column in the database, and is still absent from
    // every SELECT and INSERT: the value is accepted, silently dropped, and
    // reads back empty.
    const { getRepository } = await import("@/lib/data/store");
    const repo = getRepository();
    if ("refreshSchema" in repo && typeof repo.refreshSchema === "function") repo.refreshSchema();
  }

  if (rows.length > 0) {
    logger.info("custom fields applied", { fields: rows.length, version: draft.version });
  }
  return { fields: rows.length, version: draft.version };
}
