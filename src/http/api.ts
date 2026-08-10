/**
 * Versioned REST API router (`/api/v1`).
 *
 * A composition root and nothing else: each domain registers its own routes on
 * the shared router. It was one 3,640-line file with 140 handlers, where finding
 * the invoice routes meant scrolling past the mailbox and the automation engine,
 * and every change to any endpoint touched the same file.
 *
 * Registration order is preserved from that file. It does not currently matter —
 * no two modules register paths that could shadow one another, since each owns a
 * distinct literal prefix and the only `:param` segments sit under a prefix its
 * own module owns — but Express resolves by registration order, so keeping it
 * means the split provably changed no behaviour.
 *
 * Every handler is wrapped by `runApi` (auth + rate limit + CSRF + error
 * serialization) except the intentionally public `health`, `webhooks/echo` and
 * the token-minting `auth/login`.
 */
import { Router } from "express";

import { registerAuthRoutes } from "./routes/auth";
import { registerAdminRoutes } from "./routes/admin";
import { registerEntityRoutes } from "./routes/entities";
import { registerImportExportRoutes } from "./routes/import-export";
import { registerSalesRoutes } from "./routes/sales";
import { registerPurchasingRoutes } from "./routes/purchasing";
import { registerAccountingRoutes } from "./routes/accounting";
import { registerInventoryRoutes } from "./routes/inventory";
import { registerPosRoutes } from "./routes/pos";
import { registerAutomationRoutes } from "./routes/automation";
import { registerIntegrationRoutes } from "./routes/integrations";
import { registerErpRoutes } from "./routes/erp";
import { registerFileRoutes } from "./routes/files";
import { registerEmailRoutes } from "./routes/email";
import { registerSystemRoutes } from "./routes/system";

export function buildApiRouter(): Router {
  const r = Router();

  registerAuthRoutes(r);
  registerAdminRoutes(r);
  registerEntityRoutes(r);
  registerImportExportRoutes(r);
  registerSalesRoutes(r);
  registerPurchasingRoutes(r);
  registerAccountingRoutes(r);
  registerInventoryRoutes(r);
  registerPosRoutes(r);
  registerAutomationRoutes(r);
  registerIntegrationRoutes(r);
  registerErpRoutes(r);
  registerFileRoutes(r);
  registerEmailRoutes(r);
  registerSystemRoutes(r);

  return r;
}
