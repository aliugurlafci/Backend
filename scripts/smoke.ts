/**
 * Offline smoke test — validates everything that does NOT require a live DB:
 * metadata bootstrap + validation, DDL generation, Express app construction,
 * auth wiring and JWT signing. Run with `tsx scripts/smoke.ts`.
 */
import { metadata } from "@/lib/metadata";
import { allStatements, entityStatements } from "@/lib/data/sql/ddl";
import { getDialect } from "@/lib/data/sql/dialect";
import { createApp } from "@/http/server";
import { configureAuth } from "@/lib/security/auth-config";
import { signJwt, verifyJwt } from "@/lib/security/auth";
import { jwtSecret, ORG_ID, TENANT_ID } from "@/lib/config/env";

configureAuth();

// Offline DDL generation for the active dialect (no DB connection needed).
const dialect = await getDialect();
const entities = metadata.listEntities();
const stmts = allStatements(entities, dialect);
const app = createApp();
// Round-trip a token through the real signer/verifier (no DB, no login needed).
const token = signJwt(
  { sub: "1", name: "Administrator", email: "admin@example.test", roles: ["admin"], tenantId: TENANT_ID, orgId: ORG_ID },
  jwtSecret,
  60,
);
const claims = verifyJwt(token, jwtSecret);

console.log(
  JSON.stringify(
    {
      metadataVersion: metadata.version,
      entityCount: entities.length,
      ddlStatementCount: stmts.length,
      appConstructed: typeof app === "function",
      tokenIssued: Boolean(token),
      tokenClaims: claims && { sub: claims.sub, roles: claims.roles, tenantId: claims.tenantId, orgId: claims.orgId },
    },
    null,
    2,
  ),
);

console.log(`\n--- sample DDL (deal) — ${dialect.client} ---`);
console.log(entityStatements(metadata.getEntity("deal"), dialect).join("\n\n"));

process.exit(0);
