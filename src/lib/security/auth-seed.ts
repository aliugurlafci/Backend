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
    "growth-dashboard", "revenue-dashboard", "project-dashboard",
    "lead", "account", "contact", "deal", "task", "pipeline", "activity", "calendar",
    "proposal", "estimation", "contract", "salesOrder", "quote", "invoice",
    "project", "milestone", "timesheet", "campaign", "ticket",
    "reports", "finance", "email", "chat", "calls", "notes", "todo", "social-feed", "file-manager",
  ];
  const repScreens = [
    "home", "sales-dashboard", "leads-dashboard", "deals-dashboard",
    "lead", "account", "contact", "deal", "task", "pipeline", "activity", "calendar",
    "quote", "proposal", "project", "ticket",
    "email", "chat", "calls", "notes", "todo", "social-feed", "file-manager",
  ];
  const accountantScreens = [
    "home", "revenue-dashboard", "executive-dashboard",
    "account", "contact", "activity", "calendar",
    "quote", "invoice", "payment", "product", "recurringPlan", "finance", "reports",
    "notes", "todo", "file-manager",
  ];

  const positions = [
    { id: "position_admin", name: "Administrator", role: "admin", screens: all },
    { id: "position_manager", name: "Sales Manager", role: "sales_manager", screens: has(...managerScreens) },
    { id: "position_rep", name: "Sales Rep", role: "sales_rep", screens: has(...repScreens) },
    { id: "position_accountant", name: "Accountant", role: "accountant", screens: has(...accountantScreens) },
  ];
  for (const p of positions) {
    await repo.insert(rec(p.id, { name: p.name, role: p.role, screens: JSON.stringify(p.screens), description: null }));
  }

  const passwordHash = hashPassword(DEFAULT_PASSWORD);
  const users = [
    { id: "user_admin", email: "avery@acme.test", displayName: "Avery Admin", positionId: "position_admin" },
    { id: "user_manager", email: "morgan@acme.test", displayName: "Morgan Manager", positionId: "position_manager" },
    { id: "user_rep", email: "riley@acme.test", displayName: "Riley Rep", positionId: "position_rep" },
    { id: "user_accountant", email: "casey@acme.test", displayName: "Casey Accountant", positionId: "position_accountant" },
  ];
  for (const u of users) {
    await repo.insert(rec(u.id, { email: u.email, displayName: u.displayName, passwordHash, positionId: u.positionId, active: true }));
  }

  logger.info("auth seed complete", { positions: positions.length, users: users.length });
}
