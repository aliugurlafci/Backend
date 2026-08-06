/**
 * Phase 6 — Role + ABAC policy definitions.
 *
 * RBAC grants per role plus the ABAC rule for ownable entities. `sales_rep` is
 * intentionally least-privileged: read across the tenant, but may only mutate
 * records it owns and cannot read PII or win deals.
 */
import { SELF_SERVICE_SETTINGS_GRANTS } from "@/lib/config/settings-permissions";
import type { RoleDef } from "./types";

const BASE_ROLES: Record<string, RoleDef> = {
  admin: {
    name: "admin",
    label: "Administrator",
    grants: ["*", "pii:read"],
  },
  sales_manager: {
    name: "sales_manager",
    label: "Sales Manager",
    grants: [
      "account:*",
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
      "salesOrder:*",
      "cart:*",
      "cartLine:*",
      "salesReturn:*",
      "salesReturnLine:*",
      "branch:*",
      "dealer:*",
      "warehouse:*",
      "supplier:*",
      "stockMovement:read",
      "purchaseOrder:*",
      "purchaseOrderLine:*",
      "goodsReceipt:*",
      "goodsReceiptLine:*",
      "stockTransfer:*",
      "stockAdjustment:*",
      "labelTemplate:*",
      "posSession:*",
      "pos:checkout",
      "department:*",
      "employee:*",
      "note:*",
      "todo:*",
      "file:*",
      "email:*",
      "emailFolder:*",
      "pii:read",
    ],
  },
  sales_rep: {
    name: "sales_rep",
    label: "Sales Rep",
    grants: [
      "account:read",
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
      "salesOrder:read",
      "salesOrder:create",
      "salesOrder:update",
      // Carts: a rep builds baskets, hands them to the cash desk or rings them
      // up, and can void their own — but does not extend credit (`cart:credit`)
      // or manage the register queue's suspensions.
      "cart:read",
      "cart:create",
      "cart:update",
      "cart:delete",
      "cart:send",
      "cart:checkout",
      "cart:cancel",
      "cartLine:*",
      "salesReturn:read",
      "salesReturn:create",
      "salesReturn:update",
      "salesReturn:post",
      "salesReturnLine:*",
      "branch:read",
      "dealer:read",
      "dealer:create",
      "dealer:update",
      "warehouse:read",
      "stockMovement:read",
      "labelTemplate:read",
      "posSession:*",
      "pos:checkout",
      "department:read",
      "employee:read",
      "note:*",
      "todo:*",
      "file:*",
      "email:*",
      "emailFolder:*",
    ],
  },
  accountant: {
    name: "accountant",
    label: "Accountant",
    grants: [
      "account:read",
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
      "salesOrder:read",
      // Cash-desk side of the cart: works the register queue (take payment, close
      // to account, suspend, reject) but does not build or send baskets.
      "cart:read",
      "cart:update",
      "cart:checkout",
      "cart:credit",
      "cart:suspend",
      "cart:cancel",
      "cartLine:*",
      "salesReturn:read",
      "salesReturnLine:read",
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
      "labelTemplate:read",
      "posSession:read",
      "warehouse:read",
      "department:read",
      "employee:read",
      "note:*",
      "todo:*",
      "file:*",
      "email:*",
      "emailFolder:*",
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
      "labelTemplate:*",
      "branch:read",
      "dealer:read",
      "account:read",
      "note:*",
      "todo:*",
      "file:*",
      "email:*",
      "emailFolder:*",
    ],
  },
  system: {
    name: "system",
    label: "System",
    grants: ["*", "pii:read"],
  },
};

/**
 * The published role presets: every role that isn't a super-user (`*`) also
 * carries the personal Settings grants — profile, security, notifications and
 * appearance. Managing your own account is not an administrative privilege, so
 * it belongs to every base role; the administrative Settings areas (users,
 * positions, mobile, data model…) stay opt-in per position.
 */
export const ROLES: Record<string, RoleDef> = Object.fromEntries(
  Object.entries(BASE_ROLES).map(([name, def]) => [
    name,
    def.grants.includes("*") ? def : { ...def, grants: [...def.grants, ...SELF_SERVICE_SETTINGS_GRANTS] },
  ]),
);

/** Verbs that mutate a record and therefore trigger record-level ABAC. */
export const MUTATING_VERBS = new Set(["update", "delete", "win", "lose", "convert"]);

/**
 * System entities that still belong in the permission matrix.
 *
 * `system: true` normally means "internal, never granted directly" (line items,
 * users, audit rows) and those entities are kept out of the matrix. A cart is
 * different: it is flagged system only because it has a bespoke screen instead of
 * the generic entity browser, while its operations are exactly what an admin needs
 * to hand out — `cart:send` enables "send to register" on mobile, `cart:checkout`
 * enables ringing the basket up, and `cart:credit` / `cart:suspend` / `cart:cancel`
 * are the cash desk's own actions.
 */
export const GRANTABLE_SYSTEM_ENTITIES = new Set(["cart"]);

/** The default grant list for a single role (used to pre-fill the permission matrix). */
export function roleGrants(role: string): string[] {
  return [...(ROLES[role]?.grants ?? [])];
}

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
