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

/**
 * Direct grant for `action`, then walking up the **master-detail parent chain**:
 * a child/line entity (e.g. `purchaseOrderLine`) inherits its parent document's
 * grants, since line entities are never granted independently — they're hidden
 * from the permission matrix and only exist within their parent document.
 */
function rbacDirect(grants: Set<string>, entity: string, action: string): boolean {
  if ([...grants].some((g) => grantMatches(g, action))) return true;
  const verb = action.split(":")[1] ?? "";
  let parent = metadata.findEntity?.(entity)?.parent?.entity;
  const seen = new Set<string>([entity]);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    if ([...grants].some((g) => grantMatches(g, `${parent}:${verb}`))) return true;
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
  return metadata.listEntities().some(
    (def) =>
      def.fields.some((f) => f.type === "reference" && f.referenceEntity === entity) &&
      rbacDirect(grants, def.name, `${def.name}:read`),
  );
}

function ownershipRelation(ctx: RequestContext, req: AccessRequest): string {
  if (req.recordOwnerId === undefined) return "na";
  if (!req.recordOwnerId) return "unowned";
  return req.recordOwnerId === ctx.userId ? "self" : "other";
}

export class PermissionEngine {
  private cache = new DecisionCache<Decision>();

  evaluate(ctx: RequestContext, req: AccessRequest): Decision {
    if (ctx.isSystem) return allow("system context bypasses checks");

    const key = [
      // Effective grant identity: explicit matrix grants (authoritative) take
      // precedence over the role set, so the cache must key on whichever applies.
      ctx.grants ? `g:${[...ctx.grants].sort().join(",")}` : `r:${[...ctx.roles].sort().join(",")}`,
      ctx.userId,
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
    return entity.fields
      .filter((f) =>
        this.can(ctx, {
          action: `${entity.name}:read`,
          entity: entity.name,
          field: f.name,
          fieldPii: f.pii,
        }),
      )
      .map((f) => f.name);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const permissionEngine = new PermissionEngine();
