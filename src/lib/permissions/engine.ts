/**
 * Phase 6 — Permission evaluation engine.
 *
 * Pure evaluation pipeline: RBAC (object/action) -> field-level -> record-level
 * ABAC. Returns a structured Decision and memoizes the result.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityDef } from "@/lib/metadata/types";
import { metadata } from "@/lib/metadata";
import { DecisionCache } from "./cache";
import {
  canManageAny,
  grantMatches,
  grantsFor,
  MUTATING_VERBS,
} from "./policies";
import type { AccessRequest, Decision } from "./types";

function allow(reason: string): Decision {
  return { allowed: true, reason, code: "allowed" };
}

/** Shared empty result for the (overwhelmingly common) "nothing denied" case. */
const EMPTY_FIELDS: readonly string[] = Object.freeze<string[]>([]);

/** Does any held grant cover `action`? Iterated in place — this is the engine's
 *  innermost loop, so it must not allocate. */
function anyGrantMatches(grants: Set<string>, action: string): boolean {
  for (const grant of grants) if (grantMatches(grant, action)) return true;
  return false;
}

/**
 * Direct grant for `action`, then walking up the **master-detail parent chain**:
 * a child/line entity (e.g. `purchaseOrderLine`) inherits its parent document's
 * grants, since line entities are never granted independently — they're hidden
 * from the permission matrix and only exist within their parent document.
 */
function rbacDirect(grants: Set<string>, entity: string, action: string): boolean {
  if (anyGrantMatches(grants, action)) return true;
  const verb = action.split(":")[1] ?? "";
  let parent = metadata.findEntity?.(entity)?.parent?.entity;
  const seen = new Set<string>([entity]);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    if (anyGrantMatches(grants, `${parent}:${verb}`)) return true;
    parent = metadata.findEntity?.(parent)?.parent?.entity;
  }
  return false;
}

/**
 * Full RBAC check. Beyond the direct/parent grant (`rbacDirect`), a **read** is
 * also allowed when an entity the caller can already read *references* this one —
 * so a screen can resolve the names of its referenced records (e.g. a role with
 * `purchaseOrder:*` can read the `supplier` / `product` / `warehouse` a PO points
 * at). Bounded to non-system targets so internal entities (users, audit…) are
 * never exposed this way, and one hop deep (uses `rbacDirect`, not recursion).
 */
function rbacAllows(grants: Set<string>, entity: string, action: string): boolean {
  if (rbacDirect(grants, entity, action)) return true;
  if ((action.split(":")[1] ?? "") !== "read") return false;
  const target = metadata.findEntity?.(entity);
  if (!target || target.system) return false;
  return referencingEntities(entity).some((name) => rbacDirect(grants, name, `${name}:read`));
}

/**
 * Names of the entities that reference `entity` — the one-hop set the read
 * fallback above consults. Derived from the metadata field definitions, which
 * only change when a new metadata version is published, so the scan over every
 * entity's every field is done once per version instead of on each denied read.
 */
const referencingCache = new Map<string, string[]>();
let referencingVersion = -1;

function referencingEntities(entity: string): string[] {
  if (referencingVersion !== metadata.version) {
    referencingCache.clear();
    referencingVersion = metadata.version;
  }
  const cached = referencingCache.get(entity);
  if (cached) return cached;
  const names = metadata
    .listEntities()
    .filter((def) => def.fields.some((f) => f.type === "reference" && f.referenceEntity === entity))
    .map((def) => def.name);
  referencingCache.set(entity, names);
  return names;
}

function ownershipRelation(ctx: RequestContext, req: AccessRequest): string {
  if (req.recordOwnerId === undefined) return "na";
  if (!req.recordOwnerId) return "unowned";
  return req.recordOwnerId === ctx.userId ? "self" : "other";
}

export class PermissionEngine {
  private cache = new DecisionCache<Decision>();
  /** Unreadable-field lists, keyed by identity + entity (see `deniedFields`). */
  private fields = new DecisionCache<readonly string[]>();
  /**
   * Identity part of the cache key, memoized per context *object*.
   *
   * The key is derived from the grant set, which means building it costs a sort
   * plus a join over (often dozens of) grants. Every field of every record in a
   * read goes through `evaluate`, so recomputing it per call dominated the read
   * path. A request's context is a frozen, single-request object, so caching on
   * it is safe and the entry dies with the request.
   */
  private identities = new WeakMap<RequestContext, string>();
  /** Per-request denied-field memo (entity name → hidden fields), see `deniedFields`. */
  private deniedByCtx = new WeakMap<RequestContext, Map<string, readonly string[]>>();

  /** `<grants|roles>|<userId>` — the identity every decision is cached against. */
  private identityKey(ctx: RequestContext): string {
    const cached = this.identities.get(ctx);
    if (cached !== undefined) return cached;
    // Explicit matrix grants (authoritative) take precedence over the role set,
    // so the key reflects whichever applies.
    const identity = ctx.grants
      ? `g:${[...ctx.grants].sort().join(",")}`
      : `r:${[...ctx.roles].sort().join(",")}`;
    const key = `${identity}|${ctx.userId}`;
    this.identities.set(ctx, key);
    return key;
  }

  evaluate(ctx: RequestContext, req: AccessRequest): Decision {
    if (ctx.isSystem) return allow("system context bypasses checks");

    const key = [
      this.identityKey(ctx),
      req.action,
      req.field ?? "",
      req.fieldPii ? "pii" : "",
      ownershipRelation(ctx, req),
    ].join("|");

    const cached = this.cache.get(key);
    if (cached) return cached;

    const decision = this.compute(ctx, req);
    this.cache.set(key, decision);
    return decision;
  }

  private compute(ctx: RequestContext, req: AccessRequest): Decision {
    // A position's explicit permission matrix is authoritative; only fall back to
    // the base role's defaults when no matrix is set (legacy positions / dev personas).
    const grants = ctx.grants ? new Set(ctx.grants) : grantsFor(ctx.roles);

    // 1. RBAC — object/action level (with master-detail + reference inheritance).
    if (!rbacAllows(grants, req.entity, req.action)) {
      return {
        allowed: false,
        code: "rbac_denied",
        reason: `role(s) [${ctx.roles.join(", ")}] are not granted "${req.action}"`,
      };
    }

    // 2. Field-level — PII read restriction.
    if (req.field && req.fieldPii && !(grants.has("pii:read") || grants.has("*"))) {
      return {
        allowed: false,
        code: "field_denied",
        reason: `field "${req.entity}.${req.field}" contains PII and requires the "pii:read" grant`,
      };
    }

    // 3. Record-level ABAC — owners only for mutations on ownable records.
    const verb = req.action.split(":")[1] ?? "";
    if (
      MUTATING_VERBS.has(verb) &&
      req.recordOwnerId !== undefined &&
      req.recordOwnerId !== null &&
      req.recordOwnerId !== ctx.userId &&
      !canManageAny(grants, req.entity)
    ) {
      return {
        allowed: false,
        code: "abac_denied",
        reason: `only the record owner or a manager can ${verb} this ${req.entity}`,
      };
    }

    return allow("all checks passed");
  }

  can(ctx: RequestContext, req: AccessRequest): boolean {
    return this.evaluate(ctx, req).allowed;
  }

  /** Fields of an entity the context may read (drops disallowed PII fields). */
  readableFields(ctx: RequestContext, entity: EntityDef): string[] {
    const denied = new Set(this.deniedFields(ctx, entity));
    return denied.size === 0
      ? entity.fields.map((f) => f.name)
      : entity.fields.filter((f) => !denied.has(f.name)).map((f) => f.name);
  }

  /**
   * Fields of an entity the context may **not** read — almost always empty, and
   * the same answer for every record of a given (identity, entity). Cached on
   * both, so projecting a page of records costs one field sweep rather than one
   * per record; the metadata version is part of the key so republishing a
   * changed field set invalidates it.
   */
  deniedFields(ctx: RequestContext, entity: EntityDef): readonly string[] {
    if (ctx.isSystem) return EMPTY_FIELDS;
    // Per-request memo first: projecting a page asks the same question once per
    // record, and this answers it without building a cache key at all.
    let perCtx = this.deniedByCtx.get(ctx);
    const local = perCtx?.get(entity.name);
    if (local) return local;

    const key = `${this.identityKey(ctx)}|f:${metadata.version}|${entity.name}`;
    const cached = this.fields.get(key);
    if (cached) {
      if (!perCtx) this.deniedByCtx.set(ctx, (perCtx = new Map()));
      perCtx.set(entity.name, cached);
      return cached;
    }

    const denied: string[] = [];
    for (const field of entity.fields) {
      const ok = this.can(ctx, {
        action: `${entity.name}:read`,
        entity: entity.name,
        field: field.name,
        fieldPii: field.pii,
      });
      if (!ok) denied.push(field.name);
    }
    const result: readonly string[] = denied.length === 0 ? EMPTY_FIELDS : denied;
    this.fields.set(key, result);
    if (!perCtx) this.deniedByCtx.set(ctx, (perCtx = new Map()));
    perCtx.set(entity.name, result);
    return result;
  }

  clearCache(): void {
    this.cache.clear();
    this.fields.clear();
  }
}

export const permissionEngine = new PermissionEngine();
