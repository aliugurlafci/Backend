/**
 * Auth seed — the only data the server provisions by itself.
 *
 * `ensureAdminSeed` runs on every boot and is idempotent: on an empty database
 * it creates the Administrator position (granted every screen) plus the single
 * administrator login user, so a fresh deployment is reachable. Once an
 * admin-role position exists it is a no-op — it never overwrites live data.
 *
 * The bootstrap identity comes from the environment (AULA_ADMIN_EMAIL /
 * AULA_ADMIN_PASSWORD / AULA_ADMIN_NAME) so a deployment is provisioned with
 * its own administrator rather than a shared default. Change the password from
 * Settings → Security after the first sign-in.
 */
import { metadata } from "@/lib/metadata";
import { screenCatalog } from "@/lib/config/screens";
import { adminPassword, adminPasswordIsInsecureDefault, env, ORG_ID, TENANT_ID } from "@/lib/config/env";
import type { Repository } from "@/lib/data/repository";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import { logger } from "@/lib/observability/logger";
import { hashPassword } from "./crypto";

const T0 = "2026-01-15T09:00:00.000Z";
export const ADMIN_EMAIL = env.AULA_ADMIN_EMAIL;
export const ADMIN_NAME = env.AULA_ADMIN_NAME;
const ADMIN_PASSWORD = adminPassword;

function rec(id: string, fields: Record<string, FieldValue>): EntityRecord {
  return {
    id,
    tenantId: TENANT_ID,
    orgId: ORG_ID,
    ownerId: null,
    createdAt: T0,
    updatedAt: T0,
    createdBy: "system",
    updatedBy: "system",
    version: 1,
    ...fields,
  };
}

/**
 * Ensure the Administrator position + administrator login user exist so a fresh
 * database is usable. Idempotent — a no-op once an admin-role position is present.
 */
export async function ensureAdminSeed(repo: Repository): Promise<void> {
  const positions = await repo.list(
    { tenantId: TENANT_ID, orgId: ORG_ID },
    "position",
    { filters: [], sort: [], page: 1, pageSize: 50 },
  );
  if (positions.items.some((p) => String(p.role) === "admin")) return; // already provisioned

  const allScreens = screenCatalog(metadata).map((s) => s.key);
  await repo.insert("position", rec("1", { name: "Administrator", role: "admin", screens: JSON.stringify(allScreens), description: null }));
  await repo.insert(
    "user",
    rec("1", {
      email: ADMIN_EMAIL,
      displayName: ADMIN_NAME,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      positionId: "1",
      active: true,
      branchId: null,
      dealerId: null,
      managerId: null,
    }),
  );
  logger.info("admin seed complete", { email: ADMIN_EMAIL });
  if (adminPasswordIsInsecureDefault) {
    // Only reachable outside production — `load()` refuses to start otherwise.
    // Say it plainly on the one boot that creates the account, rather than
    // leaving a well-known password in place unnoticed.
    logger.warn(
      "administrator created with the INSECURE DEV PASSWORD — set AULA_ADMIN_PASSWORD, or change it from Settings → Security",
      { email: ADMIN_EMAIL },
    );
  }
}
