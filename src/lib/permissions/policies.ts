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
      "calendarEvent:read",
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
      "branch:*",
      "dealer:*",
      "warehouse:*",
      "supplier:*",
      "stockMovement:read",
      "purchaseOrder:*",
      "purchaseOrderLine:*",
      "goodsReceipt:*",
      "goodsReceiptLine:*",
      "department:*",
      "employee:*",
      "note:*",
      "todo:*",
      "call:*",
      "file:*",
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
      "calendarEvent:read",
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
      "branch:read",
      "dealer:read",
      "dealer:create",
      "dealer:update",
      "department:read",
      "employee:read",
      "note:*",
      "todo:*",
      "call:*",
      "file:*",
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
      "calendarEvent:read",
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
      "branch:read",
      "dealer:read",
      "warehouse:read",
      "supplier:read",
      "stockMovement:read",
      "purchaseOrder:read",
      "goodsReceipt:read",
      "ledgerAccount:*",
      "fiscalPeriod:*",
      "journalEntry:*",
      "journalLine:*",
      "vendorBill:*",
      "vendorBillLine:*",
      "billPayment:*",
      "department:read",
      "employee:read",
      "note:*",
      "todo:*",
      "call:*",
      "file:*",
      "email:*",
      "pii:read",
    ],
  },
  warehouse_manager: {
    name: "warehouse_manager",
    label: "Warehouse Manager",
    grants: [
      "product:*",
      "warehouse:*",
      "supplier:*",
      "stockMovement:read",
      "purchaseOrder:*",
      "purchaseOrderLine:*",
      "goodsReceipt:*",
      "goodsReceiptLine:*",
      "stockTransfer:*",
      "stockAdjustment:*",
      "branch:read",
      "dealer:read",
      "account:read",
      "note:*",
      "todo:*",
      "call:*",
      "file:*",
      "email:*",
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
