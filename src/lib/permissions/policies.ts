/**
 * Phase 6 — Role + ABAC policy definitions.
 *
 * RBAC grants per role plus the ABAC rule for ownable entities. `sales_rep` is
 * intentionally least-privileged: read across the tenant, but may only mutate
 * records it owns and cannot read PII or win deals.
 */
import type { RoleDef } from "./types";

export const ROLES: Record<string, RoleDef> = {
  admin: {
    name: "admin",
    label: "Administrator",
    grants: ["*", "pii:read"],
  },
  sales_manager: {
    name: "sales_manager",
    label: "Sales Manager",
    grants: [
      "lead:*",
      "account:*",
      "contact:*",
      "deal:*",
      "task:*",
      "product:*",
      "currency:read",
      "taxRate:read",
      "quote:*",
      "quoteLine:*",
      "invoice:*",
      "invoiceLine:*",
      "payment:*",
      "recurringPlan:*",
      "proposal:*",
      "estimation:*",
      "contract:*",
      "salesOrder:*",
      "project:*",
      "milestone:*",
      "timesheet:*",
      "campaign:*",
      "ticket:*",
      "department:*",
      "employee:*",
      "note:*",
      "todo:*",
      "call:*",
      "post:*",
      "file:*",
      "chatMessage:*",
      "email:*",
      "pii:read",
    ],
  },
  sales_rep: {
    name: "sales_rep",
    label: "Sales Rep",
    grants: [
      "lead:read",
      "lead:create",
      "lead:update",
      "lead:convert",
      "account:read",
      "contact:read",
      "contact:create",
      "contact:update",
      "deal:read",
      "deal:create",
      "deal:update", // covers qualify/propose/negotiate/lose transitions
      "task:read",
      "task:create",
      "task:update",
      // Read-only access to sales catalog + quotes (no invoices/payments).
      "product:read",
      "quote:read",
      "quoteLine:read",
      // New modules: rep can work proposals/projects/tickets, read the rest.
      "proposal:read",
      "proposal:create",
      "proposal:update",
      "estimation:read",
      "contract:read",
      "salesOrder:read",
      "salesOrder:create",
      "salesOrder:update",
      "project:read",
      "milestone:read",
      "timesheet:read",
      "timesheet:create",
      "timesheet:update",
      "campaign:read",
      "ticket:read",
      "ticket:create",
      "ticket:update",
      "department:read",
      "employee:read",
      "note:*",
      "todo:*",
      "call:*",
      "post:*",
      "file:*",
      "chatMessage:*",
      "email:*",
    ],
  },
  accountant: {
    name: "accountant",
    label: "Accountant",
    grants: [
      "lead:read",
      "account:read",
      "contact:read",
      "deal:read",
      "task:read",
      "product:*",
      "currency:*",
      "taxRate:*",
      "quote:*",
      "quoteLine:*",
      "invoice:*",
      "invoiceLine:*",
      "payment:*",
      "recurringPlan:*",
      "proposal:read",
      "estimation:read",
      "contract:read",
      "salesOrder:read",
      "project:read",
      "milestone:read",
      "timesheet:read",
      "campaign:read",
      "ticket:read",
      "department:read",
      "employee:read",
      "note:*",
      "todo:*",
      "call:*",
      "post:*",
      "file:*",
      "chatMessage:*",
      "email:*",
      "pii:read",
    ],
  },
  system: {
    name: "system",
    label: "System",
    grants: ["*", "pii:read"],
  },
};

/** Verbs that mutate a record and therefore trigger record-level ABAC. */
export const MUTATING_VERBS = new Set(["update", "delete", "win", "lose", "convert"]);

/** Resolve the union of grants for a set of role names. */
export function grantsFor(roles: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const role of roles) {
    const def = ROLES[role];
    if (def) for (const g of def.grants) set.add(g);
  }
  return set;
}

export function grantMatches(grant: string, action: string): boolean {
  if (grant === "*" || grant === action) return true;
  const [gEntity, gVerb] = grant.split(":");
  const [aEntity, aVerb] = action.split(":");
  if (gVerb === "*" && gEntity === aEntity) return true;
  if (gEntity === "*" && gVerb === aVerb) return true;
  return false;
}

/** True when the grants let the holder act on records they don't own. */
export function canManageAny(grants: Set<string>, entity: string): boolean {
  return grants.has("*") || grants.has(`${entity}:*`);
}
