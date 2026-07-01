/**
 * Auth seed.
 *
 * `ensureAdminSeed` is the ONLY seed that runs on server startup: it provisions
 * the Administrator position + the single admin login user, idempotently. Demo
 * users (manager/rep/accountant) and demo business data are NOT seeded on boot —
 * they live in `ensureDemoUsers` here + `seedInto` (data/seed.ts) and are opt-in
 * via `npm run seed` (and the test harness). Default password: `Passw0rd!`.
 */
import { metadata } from "@/lib/metadata";
import { screenCatalog } from "@/lib/config/screens";
import { DEMO_ORG, DEMO_TENANT } from "@/lib/context/dev";
import type { Repository } from "@/lib/data/repository";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import { logger } from "@/lib/observability/logger";
import { hashPassword } from "./crypto";

const T0 = "2026-01-15T09:00:00.000Z";
export const DEFAULT_PASSWORD = "Passw0rd!";
export const ADMIN_EMAIL = "avery@acme.test";

function rec(id: string, fields: Record<string, FieldValue>): EntityRecord {
  return {
    id,
    tenantId: DEMO_TENANT,
    orgId: DEMO_ORG,
    ownerId: null,
    createdAt: T0,
    updatedAt: T0,
    createdBy: "system",
    updatedBy: "system",
    version: 1,
    ...fields,
  };
}

async function listPositions(repo: Repository) {
  return repo.list({ tenantId: DEMO_TENANT, orgId: DEMO_ORG }, "position", { filters: [], sort: [], page: 1, pageSize: 50 });
}

/**
 * The single seed that runs on every boot: ensures the Administrator position +
 * admin login user exist so the app is usable on a fresh database. Idempotent —
 * a no-op once an admin-role position is present.
 */
export async function ensureAdminSeed(repo: Repository): Promise<void> {
  const positions = await listPositions(repo);
  if (positions.items.some((p) => String(p.role) === "admin")) return; // already provisioned

  const allScreens = screenCatalog(metadata).map((s) => s.key);
  await repo.insert("position", rec("1", { name: "Administrator", role: "admin", screens: JSON.stringify(allScreens), description: null }));
  await repo.insert(
    "user",
    rec("1", {
      email: ADMIN_EMAIL,
      displayName: "Avery Admin",
      passwordHash: await hashPassword(DEFAULT_PASSWORD),
      positionId: "1",
      active: true,
      branchId: null,
      dealerId: null,
      managerId: null,
    }),
  );
  logger.info("admin seed complete", { email: ADMIN_EMAIL });
}

/**
 * Opt-in demo users (Sales Manager / Sales Rep / Accountant) with a supervisor
 * chain for PO-approval routing. NOT run on boot — invoked by `npm run seed` and
 * the test harness, after the demo business data (so branch lookups resolve).
 * Idempotent — a no-op once a sales_manager position exists.
 */
export async function ensureDemoUsers(repo: Repository): Promise<void> {
  const scope = { tenantId: DEMO_TENANT, orgId: DEMO_ORG };
  const positions = await listPositions(repo);
  if (positions.items.some((p) => String(p.role) === "sales_manager")) return; // already provisioned

  const all = screenCatalog(metadata).map((s) => s.key);
  const has = (...keys: string[]) => all.filter((k) => keys.includes(k));

  const managerScreens = [
    "home", "sales-dashboard", "deals-dashboard", "executive-dashboard",
    "growth-dashboard", "revenue-dashboard", "branch-dashboard", "inventory-dashboard", "accounting-dashboard",
    "account", "deal", "task", "pipeline", "activity", "calendar",
    "cart", "salesOrder", "salesReturn",
    "quote", "invoice",
    "branch", "dealer", "warehouse", "supplier", "product",
    "purchaseOrder", "goodsReceipt",
    "pos", "stock-levels", "label-designer", "labels",
    "reports", "finance", "email", "notes", "todo", "file-manager",
  ];
  const repScreens = [
    "home", "sales-dashboard", "deals-dashboard",
    "account", "deal", "task", "pipeline", "activity", "calendar",
    "cart", "salesOrder", "salesReturn",
    "quote", "dealer",
    "pos", "stock-levels", "labels",
    "email", "notes", "todo", "file-manager",
  ];
  const accountantScreens = [
    "home", "revenue-dashboard", "executive-dashboard", "accounting-dashboard", "branch-dashboard",
    "account", "activity", "calendar", "branch", "dealer",
    "salesOrder", "salesReturn",
    "quote", "invoice", "payment", "product", "recurringPlan", "finance", "reports",
    "purchaseOrder", "vendorBill", "goodsReceipt", "journalEntry",
    "stock-levels",
    "notes", "todo", "file-manager",
  ];

  const demoPositions = [
    { id: "2", name: "Sales Manager", role: "sales_manager", screens: has(...managerScreens) },
    { id: "3", name: "Sales Rep", role: "sales_rep", screens: has(...repScreens) },
    { id: "4", name: "Accountant", role: "accountant", screens: has(...accountantScreens) },
  ];
  for (const p of demoPositions) {
    await repo.insert("position", rec(p.id, { name: p.name, role: p.role, screens: JSON.stringify(p.screens), description: null }));
  }

  // Look up branches (seeded by the demo business data) for chat grouping.
  const branchPage = await repo.list(scope, "branch", { filters: [], sort: [], page: 1, pageSize: 50 });
  const branchByCode = new Map(branchPage.items.map((b) => [String(b.code), String(b.id)]));
  const hqId = branchByCode.get("HQ") ?? null;
  const eastId = branchByCode.get("BR-E") ?? null;

  const passwordHash = await hashPassword(DEFAULT_PASSWORD);
  // Supervisor chain (managerId): rep + accountant → manager → admin (id "1").
  const users = [
    { id: "2", email: "morgan@acme.test", displayName: "Morgan Manager", positionId: "2", branchId: hqId, managerId: "1" },
    { id: "3", email: "riley@acme.test", displayName: "Riley Rep", positionId: "3", branchId: eastId, managerId: "2" },
    { id: "4", email: "casey@acme.test", displayName: "Casey Accountant", positionId: "4", branchId: hqId, managerId: "2" },
  ];
  for (const u of users) {
    await repo.insert(
      "user",
      rec(u.id, { email: u.email, displayName: u.displayName, passwordHash, positionId: u.positionId, active: true, branchId: u.branchId, dealerId: null, managerId: u.managerId }),
    );
  }

  logger.info("demo users seed complete", { positions: demoPositions.length, users: users.length });
}
