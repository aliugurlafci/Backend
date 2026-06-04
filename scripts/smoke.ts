/**
 * Offline smoke test — validates everything that does NOT require a live DB:
 * metadata bootstrap + validation, DDL generation, Express app construction,
 * auth wiring and JWT signing. Run with `tsx scripts/smoke.ts`.
 */
import { metadata } from "@/lib/metadata";
import { allStatements, entityStatements } from "@/lib/data/mssql/ddl";
import { createApp } from "@/http/server";
import { configureAuth, issuePersonaToken } from "@/lib/security/auth-config";
import { verifyJwt } from "@/lib/security/auth";
import { jwtSecret } from "@/lib/config/env";

configureAuth();

const entities = metadata.listEntities();
const stmts = allStatements(entities);
const app = createApp();
const issued = issuePersonaToken("admin");
const claims = issued ? verifyJwt(issued.token, jwtSecret) : null;

console.log(
  JSON.stringify(
    {
      metadataVersion: metadata.version,
      entityCount: entities.length,
      ddlStatementCount: stmts.length,
      appConstructed: typeof app === "function",
      tokenIssued: Boolean(issued?.token),
      tokenClaims: claims && { sub: claims.sub, roles: claims.roles, tenantId: claims.tenantId, orgId: claims.orgId },
    },
    null,
    2,
  ),
);

console.log("\n--- sample DDL (lead) ---");
console.log(entityStatements(metadata.getEntity("lead")).join("\n\n"));

process.exit(0);
