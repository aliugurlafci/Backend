/**
 * Idempotent auth seed: positions + login users.
 *
 * Runs on store init (after the demo seed) and only inserts when the `position`
 * table is empty, so it's safe on an already-populated database. Records are
 * written directly through the repository (trusted) with stable ids that match
 * the demo ownership ids. Default password for every seeded user: `Passw0rd!`.
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

export async function ensureAuthSeed(repo: Repository): Promise<void> {
  const scope = { tenantId: DEMO_TENANT, orgId: DEMO_ORG };
  const existing = await repo.list(scope, "position", { filters: [], sort: [], page: 1, pageSize: 1 });
  if (existing.total > 0) return; // already provisioned

  const all = screenCatalog(metadata).map((s) => s.key);
  const has = (...keys: string[]) => all.filter((k) => keys.includes(k));

  const managerScreens = [
    "home", "sales-dashboard", "leads-dashboard", "deals-dashboard", "executive-dashboard",
    "growth-dashboard", "revenue-dashboard", "branch-dashboard", "inventory-dashboard", "accounting-dashboard",
    "lead", "account", "contact", "deal", "task", "pipeline", "activity", "calendar",
    "proposal", "estimation", "contract", "salesOrder", "quote", "invoice",
    "branch", "dealer", "warehouse", "supplier", "product",
    "reports", "finance", "email", "chat", "calls", "notes", "todo", "file-manager",
  ];
  const repScreens = [
    "home", "sales-dashboard", "leads-dashboard", "deals-dashboard",
    "lead", "account", "contact", "deal", "task", "pipeline", "activity", "calendar",
    "quote", "proposal", "dealer",
    "email", "chat", "calls", "notes", "todo", "file-manager",
  ];
  const accountantScreens = [
    "home", "revenue-dashboard", "executive-dashboard", "accounting-dashboard", "branch-dashboard",
    "account", "contact", "activity", "calendar", "branch", "dealer",
    "quote", "invoice", "payment", "product", "recurringPlan", "finance", "reports",
    "notes", "todo", "file-manager", "chat",
  ];

  // Explicit sequential int ids (as strings) for each table, matching the
  // DEMO_USERS ids the demo seed uses as record owners (see context/dev.ts).
  const positions = [
    { id: "1", name: "Administrator", role: "admin", screens: all },
    { id: "2", name: "Sales Manager", role: "sales_manager", screens: has(...managerScreens) },
    { id: "3", name: "Sales Rep", role: "sales_rep", screens: has(...repScreens) },
    { id: "4", name: "Accountant", role: "accountant", screens: has(...accountantScreens) },
  ];
  for (const p of positions) {
    await repo.insert("position", rec(p.id, { name: p.name, role: p.role, screens: JSON.stringify(p.screens), description: null }));
  }

  // Place each login user under a branch (merkez/şube) so the chat picker groups
  // them. Runs after the demo seed, so branches exist; look them up by code.
  const branchPage = await repo.list(scope, "branch", { filters: [], sort: [], page: 1, pageSize: 50 });
  const branchByCode = new Map(branchPage.items.map((b) => [String(b.code), String(b.id)]));
  const hqId = branchByCode.get("HQ") ?? null;
  const eastId = branchByCode.get("BR-E") ?? null;

  const passwordHash = hashPassword(DEFAULT_PASSWORD);
  const users = [
    { id: "1", email: "avery@acme.test", displayName: "Avery Admin", positionId: "1", branchId: hqId },
    { id: "2", email: "morgan@acme.test", displayName: "Morgan Manager", positionId: "2", branchId: hqId },
    { id: "3", email: "riley@acme.test", displayName: "Riley Rep", positionId: "3", branchId: eastId },
    { id: "4", email: "casey@acme.test", displayName: "Casey Accountant", positionId: "4", branchId: hqId },
  ];
  for (const u of users) {
    await repo.insert(
      "user",
      rec(u.id, { email: u.email, displayName: u.displayName, passwordHash, positionId: u.positionId, active: true, branchId: u.branchId, dealerId: null }),
    );
  }

  logger.info("auth seed complete", { positions: positions.length, users: users.length });
}
