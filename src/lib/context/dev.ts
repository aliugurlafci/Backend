/**
 * Phase 4 — Demo identities.
 *
 * Shared constants used by the dev authenticator (this phase) and the seed data
 * (Phase 5) so the in-memory app is populated and logged-in out of the box.
 * Two tenants exist specifically to exercise isolation.
 */
import type { Principal } from "./types";

export const DEMO_TENANT = "t_acme";
export const DEMO_ORG = "o_acme_eu";

export const DEMO_USERS: Record<string, Principal> = {
  admin: { userId: "u_admin", displayName: "Avery Admin", email: "avery@acme.test", roles: ["admin"] },
  manager: { userId: "u_manager", displayName: "Morgan Manager", email: "morgan@acme.test", roles: ["sales_manager"] },
  rep: { userId: "u_rep", displayName: "Riley Rep", email: "riley@acme.test", roles: ["sales_rep"] },
  accountant: { userId: "u_accountant", displayName: "Casey Accountant", email: "casey@acme.test", roles: ["accountant"] },
};

// A second tenant, used to prove cross-tenant isolation.
export const OTHER_TENANT = "t_globex";
export const OTHER_ORG = "o_globex";
export const OTHER_USER: Principal = {
  userId: "u_globex_admin",
  displayName: "Glen Globex",
  email: "glen@globex.test",
  roles: ["admin"],
};
