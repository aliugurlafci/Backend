/**
 * The API's contract, as an OpenAPI 3.1 document.
 *
 * Until now the only description of 161 endpoints was the handler code itself:
 * to learn what `POST /invoices` accepts you read the handler, and a client in
 * another language had no description at all. This generates the document from
 * the two places that already hold the answer — entity metadata for the generic
 * CRUD surface, and the zod schemas the handlers validate with for everything
 * else — so it cannot describe an endpoint that does not behave that way.
 *
 * Generated, never written by hand. A hand-written spec is a second source of
 * truth that drifts the first time someone adds a field, and a contract that
 * lies is worse than none: a client generated from it fails at runtime with the
 * spec insisting it should have worked.
 */
import { z, type ZodType } from "zod";
import { metadata } from "@/lib/metadata";
import { API_VERSION } from "@/lib/http/handler";
import { MAX_PAGE_SIZE } from "@/lib/data/query";
import { SESSION_COOKIE } from "@/lib/security/auth";
import { ROUTE_DOCS } from "./route-docs";
import type { EntityDef, FieldDef } from "@/lib/metadata/types";

type Json = Record<string, unknown>;

/**
 * Columns every table carries. They are not in `EntityDef.fields` — the data
 * layer adds them — so a document built from the fields alone would describe
 * records without an `id`, which is most of what a client needs.
 */
const SYSTEM_PROPERTIES: Json = {
  id: { type: "string", description: "Record id. Numeric in storage, a string everywhere in the API." },
  tenantId: { type: "string" },
  orgId: { type: "string" },
  ownerId: { type: ["string", "null"] },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
  createdBy: { type: "string" },
  updatedBy: { type: "string" },
  version: { type: "integer", description: "Optimistic concurrency token; send it back as If-Match on a write." },
};

/** A metadata field as JSON Schema. */
function fieldSchema(field: FieldDef): Json {
  const base: Json = { title: field.label };
  if (field.helpText) base.description = field.helpText;

  switch (field.type) {
    case "number":
    case "percent":
      return { ...base, type: "number", ...(field.min !== undefined ? { minimum: field.min } : {}), ...(field.max !== undefined ? { maximum: field.max } : {}) };
    case "currency":
      // DECIMAL(18,2) in storage. Described as a number rather than a string
      // because that is what the API actually sends and accepts.
      return { ...base, type: "number", format: "double" };
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
      return { ...base, type: "string", enum: (field.options ?? []).map((o) => o.value) };
    case "reference":
      return { ...base, type: "string", description: `${field.helpText ? field.helpText + " " : ""}Id of a \`${field.referenceEntity}\` record.` };
    case "date":
      return { ...base, type: "string", format: "date" };
    case "datetime":
      return { ...base, type: "string", format: "date-time" };
    case "email":
      return { ...base, type: "string", format: "email" };
    case "url":
      return { ...base, type: "string", format: "uri" };
    case "text":
      return { ...base, type: "string" };
    case "phone":
    case "string":
    default:
      return { ...base, type: "string", ...(field.max ? { maxLength: field.max } : {}) };
  }
}

/** The record as read back: system columns + every field. */
function recordSchema(entity: EntityDef): Json {
  const properties: Json = { ...SYSTEM_PROPERTIES };
  for (const f of entity.fields) properties[f.name] = fieldSchema(f);
  return {
    type: "object",
    title: entity.label,
    description: `A \`${entity.name}\` record.`,
    properties,
  };
}

/**
 * The record as written.
 *
 * Computed and read-only fields are omitted rather than marked read-only: a
 * generated client that sends `invoice.total` gets it silently ignored, and a
 * field the server refuses to accept has no business appearing in a request
 * type at all.
 */
function writeSchema(entity: EntityDef, forCreate: boolean): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const f of entity.fields) {
    if (f.computed || f.readOnly) continue;
    properties[f.name] = fieldSchema(f);
    if (forCreate && f.required) required.push(f.name);
  }
  return {
    type: "object",
    title: `${entity.label} (${forCreate ? "create" : "update"})`,
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** A zod schema as JSON Schema, in the dialect OpenAPI 3.1 components expect. */
function fromZod(schema: ZodType): Json {
  // `io: "input"` matters wherever a schema has a default or a transform: the
  // request body is what the client SENDS, so a field with a default is
  // optional in a request even though it is always present after parsing.
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", unrepresentable: "any" }) as Json;
  // A component schema inherits the document's dialect; repeating $schema on
  // every one of them is noise some validators reject outright.
  delete json.$schema;
  return json;
}

const ERROR_REF = { $ref: "#/components/schemas/Error" };

/**
 * The failure responses shared by every authenticated endpoint, as reusable
 * components.
 *
 * Emitted as `$ref`s rather than inline copies. Inlining them was correct and
 * unreadable: the same five blocks repeated across 459 operations made a 1.6 MB
 * document, most of it the word "Unauthorized", and a spec that large is slow to
 * serve and impossible to review as a diff.
 */
const COMMON_RESPONSES: Json = {
  BadRequest: { description: "Malformed request", content: { "application/json": { schema: ERROR_REF } } },
  Unauthenticated: { description: "Not authenticated", content: { "application/json": { schema: ERROR_REF } } },
  Forbidden: { description: "Not permitted", content: { "application/json": { schema: ERROR_REF } } },
  NotFound: { description: "No such record", content: { "application/json": { schema: ERROR_REF } } },
  ValidationFailed: { description: "Validation failed", content: { "application/json": { schema: ERROR_REF } } },
  RateLimited: { description: "Rate limited", content: { "application/json": { schema: ERROR_REF } } },
  Conflict: {
    description: "Conflict — a stale `version`, an illegal lifecycle transition, or a business rule refusing the write",
    content: { "application/json": { schema: ERROR_REF } },
  },
};

const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });

function commonResponses(extra: Json = {}): Json {
  return {
    400: resp("BadRequest"),
    401: resp("Unauthenticated"),
    403: resp("Forbidden"),
    422: resp("ValidationFailed"),
    429: resp("RateLimited"),
    ...extra,
  };
}

const LIST_PARAMS = [
  { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
  {
    name: "pageSize",
    in: "query",
    description: `Rows per page. A larger value is REJECTED rather than clamped — a silently truncated page is a wrong answer that looks right.`,
    schema: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  },
  { name: "sort", in: "query", schema: { type: "string" }, description: "Field name to sort by." },
  { name: "dir", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
  { name: "q", in: "query", schema: { type: "string" }, description: "Free-text search over the entity's searchable fields." },
  {
    name: "cursor",
    in: "query",
    description:
      "Switch to keyset paging. Send `first` to begin, then the `nextCursor` from each response. " +
      "The reply carries `nextCursor` instead of `total`/`page`/`pageCount`, because producing a total means " +
      "scanning the whole filtered set. Prefer this over `page` when walking an entire entity: offset paging " +
      "over a table that is being written to repeats and skips rows. A cursor is only valid for the `sort` it " +
      "was issued under; changing the sort mid-walk is rejected rather than silently restarting.",
    schema: { type: "string" },
  },
];

const ID_PARAM = { name: "id", in: "path", required: true, schema: { type: "string" } };

/** Express `:param` → OpenAPI `{param}`, and the parameter list that implies. */
function toOpenApiPath(path: string): { path: string; params: Json[] } {
  const params: Json[] = [];
  const converted = path.replace(/:([A-Za-z_]\w*)/g, (_m, name: string) => {
    params.push({ name, in: "path", required: true, schema: { type: "string" } });
    return `{${name}}`;
  });
  return { path: converted, params };
}

/** Build the whole document. */
export function buildOpenApiDocument(): Json {
  const entities = [...metadata.listEntities()].sort((a, b) => a.name.localeCompare(b.name));

  const schemas: Json = {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: {
              type: "string",
              enum: ["VALIDATION", "NOT_FOUND", "CONFLICT", "FORBIDDEN", "UNAUTHENTICATED", "BAD_REQUEST", "EINVOICE", "INTERNAL"],
            },
            message: { type: "string" },
            details: {
              type: "array",
              items: { type: "object", properties: { field: { type: "string" }, message: { type: "string" } }, required: ["message"] },
            },
            correlationId: { type: "string", description: "Also returned as the x-correlation-id header. Quote it in a bug report." },
          },
        },
      },
    },
  };

  const paths: Json = {};
  /**
   * Every operationId, so a duplicate is caught here rather than by whoever
   * generates a client and finds two methods with one name. Entity `posSession`
   * and the bespoke `GET /pos/session` both produced `getPosSession`, which is
   * why the single-record read is `get{Name}ById`: a path would have to be
   * literally `/x/by/id` to collide with that.
   */
  const operationIds = new Set<string>();
  const claim = (id: string, where: string): string => {
    if (operationIds.has(id)) throw new Error(`duplicate operationId "${id}" at ${where}`);
    operationIds.add(id);
    return id;
  };

  // ---- generic entity CRUD, one path group per entity ---------------------
  // Expanded per entity rather than documented once as `/entities/{entity}`,
  // because the point of the document is the shape of each entity's body. A
  // single generic path would describe 61 different request bodies as
  // "object", which is the same as describing nothing.
  for (const e of entities) {
    const Name = e.name.charAt(0).toUpperCase() + e.name.slice(1);
    schemas[Name] = recordSchema(e);
    schemas[`${Name}Create`] = writeSchema(e, true);
    schemas[`${Name}Update`] = writeSchema(e, false);
    schemas[`${Name}CursorPage`] = {
      type: "object",
      required: ["items", "pageSize"],
      properties: {
        items: { type: "array", items: { $ref: `#/components/schemas/${Name}` } },
        nextCursor: { type: "string", description: "Send back as `?cursor=`. Absent on the last page." },
        pageSize: { type: "integer" },
      },
    };
    schemas[`${Name}Page`] = {
      type: "object",
      required: ["items", "total", "page", "pageSize", "pageCount"],
      properties: {
        items: { type: "array", items: { $ref: `#/components/schemas/${Name}` } },
        total: { type: "integer" },
        page: { type: "integer" },
        pageSize: { type: "integer" },
        pageCount: { type: "integer" },
      },
    };

    const tag = e.group ?? "crm";
    const ref = (s: string) => ({ $ref: `#/components/schemas/${s}` });

    paths[`/entities/${e.name}`] = {
      get: {
        tags: [tag],
        operationId: claim(`list${Name}`, `${e.name}`),
        summary: `List ${e.pluralLabel}`,
        parameters: LIST_PARAMS,
        responses: {
          200: {
            description: "A page of records — offset-paged, or keyset-paged when `cursor` is sent",
            content: { "application/json": { schema: { oneOf: [ref(`${Name}Page`), ref(`${Name}CursorPage`)] } } },
          },
          ...commonResponses(),
        },
      },
      post: {
        tags: [tag],
        operationId: claim(`create${Name}`, `${e.name}`),
        summary: `Create a ${e.label}`,
        requestBody: { required: true, content: { "application/json": { schema: ref(`${Name}Create`) } } },
        responses: { 201: { description: "Created", content: { "application/json": { schema: ref(Name) } } }, ...commonResponses({ 409: resp("Conflict") }) },
      },
    };

    paths[`/entities/${e.name}/{id}`] = {
      get: {
        tags: [tag],
        operationId: claim(`get${Name}ById`, `${e.name}`),
        summary: `Read one ${e.label}`,
        parameters: [ID_PARAM],
        responses: { 200: { description: "The record", content: { "application/json": { schema: ref(Name) } } }, 404: resp("NotFound"), ...commonResponses() },
      },
      patch: {
        tags: [tag],
        operationId: claim(`update${Name}`, `${e.name}`),
        summary: `Update a ${e.label}`,
        parameters: [
          ID_PARAM,
          {
            name: "If-Match",
            in: "header",
            description: "The `version` read with the record. Omitting it means last-write-wins; sending a stale one is a 409.",
            schema: { type: "string" },
          },
        ],
        requestBody: { required: true, content: { "application/json": { schema: ref(`${Name}Update`) } } },
        responses: { 200: { description: "The updated record", content: { "application/json": { schema: ref(Name) } } }, 409: resp("Conflict"), ...commonResponses() },
      },
      delete: {
        tags: [tag],
        operationId: claim(`delete${Name}`, `${e.name}`),
        summary: `Delete a ${e.label}`,
        parameters: [ID_PARAM],
        responses: { 200: { description: "Deleted" }, 409: resp("Conflict"), ...commonResponses() },
      },
    };

    if (e.lifecycle) {
      paths[`/entities/${e.name}/{id}/transitions`] = {
        get: {
          tags: [tag],
          operationId: claim(`list${Name}Transitions`, `${e.name}`),
          summary: `Which lifecycle actions are available on this ${e.label} right now`,
          parameters: [ID_PARAM],
          responses: { 200: { description: "Available actions" }, ...commonResponses() },
        },
        post: {
          tags: [tag],
          operationId: claim(`transition${Name}`, `${e.name}`),
          summary: `Apply a lifecycle action to a ${e.label}`,
          description: `States: ${e.lifecycle.states.join(", ")}.`,
          parameters: [ID_PARAM],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["action"],
                  properties: { action: { type: "string", enum: [...new Set(e.lifecycle.transitions.map((t) => t.action))] } },
                },
              },
            },
          },
          responses: { 200: { description: "The record after the transition", content: { "application/json": { schema: ref(Name) } } }, 409: resp("Conflict"), ...commonResponses() },
        },
      };
    }
  }

  // ---- bespoke routes ------------------------------------------------------
  for (const [key, route] of Object.entries(ROUTE_DOCS)) {
    const [method, rawPath] = key.split(" ", 2);
    if (!method || !rawPath) throw new Error(`malformed route key "${key}" — expected "METHOD /path"`);
    const { path, params } = toOpenApiPath(rawPath);
    const segment = rawPath.split("/")[1] ?? "misc";
    const op: Json = {
      tags: [segment],
      operationId: claim(`${method.toLowerCase()}${path.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))}`, key),
      summary: route.summary,
      ...(params.length ? { parameters: params } : {}),
      // Only routes that actually parse a body declare one. Describing a GET as
      // taking a request body is not a harmless extra: a generated client will
      // offer the argument, and sending it does nothing.
      ...(route.schema ? { requestBody: { required: true, content: { "application/json": { schema: fromZod(route.schema) } } } } : {}),
      responses: {
        200: { description: "Success" },
        ...commonResponses({ 409: resp("Conflict") }),
      },
    };
    const existing = (paths[path] as Json | undefined) ?? {};
    paths[path] = { ...existing, [method.toLowerCase()]: op };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "AULA — stock, sales and financial reporting API",
      version: `${API_VERSION}.0.0`,
      description:
        "Generated from entity metadata and the request schemas the handlers validate with. " +
        "Do not edit by hand; regenerate with `npm run openapi`.",
      // Stated rather than omitted: a spec with no licence reads as unclaimed,
      // and this one describes an internal system that is not open to anyone.
      license: { name: "Proprietary — internal use only", identifier: "LicenseRef-Proprietary" },
    },
    servers: [{ url: "/api/v1" }],
    // Both are real. The browser uses the httpOnly cookie set by POST
    // /auth/login; a service caller sends the same JWT as a bearer token.
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: SESSION_COOKIE },
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas,
      responses: COMMON_RESPONSES,
    },
    paths,
  };
}
