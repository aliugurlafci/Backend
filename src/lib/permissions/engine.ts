/**
 * Phase 6 — Permission evaluation engine.
 *
 * Pure evaluation pipeline: RBAC (object/action) -> field-level -> record-level
 * ABAC. Returns a structured Decision and memoizes the result.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityDef } from "@/lib/metadata/types";
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
      [...ctx.roles].sort().join(","),
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
    const grants = grantsFor(ctx.roles);

    // 1. RBAC — object/action level.
    const rbacOk = [...grants].some((g) => grantMatches(g, req.action));
    if (!rbacOk) {
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
