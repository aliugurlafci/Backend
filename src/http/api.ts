/**
 * Versioned REST API router (`/api/v1`).
 *
 * Mirrors the original Next.js route handlers one-to-one, mounted on Express.
 * Every handler is wrapped by `runApi` (auth + rate limit + CSRF + error
 * serialization) except the intentionally public `health`, `webhooks/echo` and
 * the token-minting `auth/login`.
 */
import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import Busboy from "busboy";

import {
  assertKnownEntity,
  parseIfMatch,
  parseListQuery,
  readJson,
  runApi,
  setApiHeaders,
} from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { getFinanceService, type LineInput, type PaymentInput } from "@/lib/finance/service";
import { getPurchasingService, type GrnLineInput } from "@/lib/purchasing/service";
import { getAccountingService, type JournalLineInput } from "@/lib/accounting/service";
import { getPayablesService } from "@/lib/payables/service";
import { postStockTransfer, postStockAdjustment } from "@/lib/accounting/postings";
import { permissionEngine } from "@/lib/permissions/engine";
import { metadata } from "@/lib/metadata";
import { search } from "@/lib/search/service";
import { cache } from "@/lib/cache/cache";
import { statsKey } from "@/lib/cache/invalidation";
import { notifications } from "@/lib/integrations/notifications";
import { webhookRegistry, testWebhook } from "@/lib/integrations/webhooks";
import { exportCsv, importCsv } from "@/lib/integrations/import-export";
import { exportXlsx, exportPdf } from "@/lib/integrations/export-formats";
import { runAllJobs, jobsStatus } from "@/lib/jobs/scheduler";
import {
  automationStore,
  buildCatalog,
  executeRule,
  runScheduledAutomations,
  INTEGRATION_PROVIDERS,
  SYSTEM_SETTINGS,
  type AssignmentRule,
  type AutomationAction,
  type AutomationStatus,
  type ConditionGroup,
  type IntegrationConfig,
} from "@/lib/automation";
import { publishMetadata } from "@/lib/config/governance";
import { releaseLog } from "@/lib/config/release";
import { MIGRATIONS } from "@/lib/config/migrations";
import { metrics } from "@/lib/observability/metrics";
import { env, isProduction, usingInMemoryBackends } from "@/lib/config/env";
import { BadRequestError, ForbiddenError, NotFoundError, toAppError } from "@/lib/enforcement/errors";
import type { Filter, Measure } from "@/lib/data/query";
import { issuePersonaToken } from "@/lib/security/auth-config";
import { saveBlob, openBlob, blobExists } from "@/lib/integrations/file-storage";
import { listChatUsers, listConversations, listMessages, createMessage as createChatMessage } from "@/lib/chat/service";
import { sendMail, fetchHeaders, fetchBodiesByUid } from "@/lib/integrations/email-transport";
import { login, getPosition, parseScreens, findUserById } from "@/lib/security/auth-service";
import { SESSION_COOKIE } from "@/lib/security/auth";
import { hashPassword, verifyPassword } from "@/lib/security/crypto";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { screenCatalog } from "@/lib/config/screens";
import type { EntityRecord } from "@/lib/metadata/types";

/** Cookie options for the session JWT. */
function sessionCookieOpts(ttlSec: number) {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: ttlSec * 1000, secure: isProduction };
}

/** Best-effort content-type from a filename (used for inline file/image serving). */
function guessFileContentType(name: string): string {
  switch (name.toLowerCase().split(".").pop()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

/** Drop the password hash before returning a user record to a client. */
function stripHash(user: EntityRecord): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...user };
  delete rest.passwordHash;
  return rest;
}

export function buildApiRouter(): Router {
  const r = Router();

  // ---- auth -------------------------------------------------------------
  // Credential login (email + password). Sets an httpOnly session cookie.
  // Dev-only fallback: `{ actor }` mints a persona token when AULA_DEV_AUTH.
  r.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { email?: string; password?: string; actor?: string };
      if (body.email && body.password) {
        const result = await login(body.email, body.password);
        if (!result) {
          res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "invalid email or password" } });
          return;
        }
        res.cookie(SESSION_COOKIE, result.token, sessionCookieOpts(result.expiresIn));
        setApiHeaders(res);
        res.json({ user: result.user, position: result.position, screens: result.screens });
        return;
      }
      if (env.AULA_DEV_AUTH && body.actor) {
        const issued = issuePersonaToken(body.actor);
        if (!issued) {
          res.status(400).json({ error: { code: "BAD_REQUEST", message: `unknown actor "${body.actor}"` } });
          return;
        }
        res.cookie(SESSION_COOKIE, issued.token, sessionCookieOpts(issued.expiresIn));
        setApiHeaders(res);
        res.json(issued);
        return;
      }
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "email and password are required" } });
    } catch (error) {
      const appError = toAppError(error);
      setApiHeaders(res);
      res.status(appError.httpStatus).json(appError.serialize());
    }
  });

  // Clear the session (and any dev persona cookie).
  r.post("/auth/logout", (_req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.clearCookie("aula_actor", { path: "/" });
    setApiHeaders(res);
    res.json({ ok: true });
  });

  r.get("/auth/me", runApi(async (rc) => {
    const [position, userRec] = await Promise.all([
      rc.positionId ? getPosition(rc.positionId) : Promise.resolve(null),
      findUserById(rc.userId),
    ]);
    // Dev personas / bearer tokens without a position can see every screen.
    const screens = position ? parseScreens(position) : screenCatalog(metadata).map((s) => s.key);
    let notificationPrefs: unknown = null;
    try {
      notificationPrefs = userRec?.notificationPrefs ? JSON.parse(String(userRec.notificationPrefs)) : null;
    } catch {
      notificationPrefs = null;
    }
    // Per-user config (theme/accent/density/mailSyncInterval…) from the userSetting table.
    const domain = await getDomainService();
    const settingsRows = await domain.list(systemContext(rc.tenantId, rc.orgId), "userSetting", {
      filters: [{ field: "userId", op: "eq", value: rc.userId }],
      pageSize: 200,
    });
    const settings: Record<string, string> = {};
    for (const row of settingsRows.items) settings[String(row.key)] = String(row.value ?? "");
    return {
      userId: rc.userId,
      // Prefer the live DB record (reflects self-service profile edits) over the JWT claims.
      displayName: String(userRec?.displayName ?? rc.displayName),
      email: String(userRec?.email ?? rc.email),
      roles: rc.roles,
      tenantId: rc.tenantId,
      orgId: rc.orgId,
      locale: rc.locale,
      featureFlags: rc.featureFlags,
      positionId: rc.positionId ?? null,
      position: position ? { id: position.id, name: String(position.name), role: String(position.role) } : null,
      screens,
      phone: (userRec?.phone as string | null) ?? null,
      timezone: (userRec?.timezone as string | null) ?? null,
      notificationPrefs,
      settings,
    };
  }));

  // Self-service profile update (the caller's own user record only).
  r.patch(
    "/auth/profile",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          displayName?: string;
          email?: string;
          phone?: string;
          timezone?: string;
          notificationPrefs?: unknown;
        };
        const user = await findUserById(rc.userId);
        if (!user) throw new BadRequestError("no editable profile for this account");
        const patch: Record<string, unknown> = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.email !== undefined) patch.email = String(body.email).toLowerCase();
        if (body.phone !== undefined) patch.phone = body.phone;
        if (body.timezone !== undefined) patch.timezone = body.timezone;
        if (body.notificationPrefs !== undefined) patch.notificationPrefs = JSON.stringify(body.notificationPrefs);
        const domain = await getDomainService();
        const updated = await domain.update(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, patch);
        return stripHash(updated);
      },
      { mutating: true },
    ),
  );

  // Self-service per-user settings (theme/accent/density/mailSyncInterval…).
  // Upserts key/value rows in the `userSetting` table scoped to the caller.
  r.patch(
    "/auth/settings",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { settings?: Record<string, unknown> };
        const entries = Object.entries(body.settings ?? {});
        const domain = await getDomainService();
        const sys = systemContext(rc.tenantId, rc.orgId);
        const existing = await domain.list(sys, "userSetting", {
          filters: [{ field: "userId", op: "eq", value: rc.userId }],
          pageSize: 200,
        });
        const byKey = new Map(existing.items.map((r) => [String(r.key), r]));
        for (const [key, raw] of entries) {
          const value = raw === null || raw === undefined ? "" : String(raw);
          const found = byKey.get(key);
          if (found) await domain.update(sys, "userSetting", String(found.id), { value });
          else await domain.create(sys, "userSetting", { userId: rc.userId, key, value });
        }
        const after = await domain.list(sys, "userSetting", {
          filters: [{ field: "userId", op: "eq", value: rc.userId }],
          pageSize: 200,
        });
        const settings: Record<string, string> = {};
        for (const row of after.items) settings[String(row.key)] = String(row.value ?? "");
        return { settings };
      },
      { mutating: true },
    ),
  );

  // Self-service password change (verifies the current password).
  r.patch(
    "/auth/password",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { currentPassword?: string; newPassword?: string };
        if (!body.currentPassword || !body.newPassword) {
          throw new BadRequestError("currentPassword and newPassword are required");
        }
        if (body.newPassword.length < 6) throw new BadRequestError("new password must be at least 6 characters");
        const user = await findUserById(rc.userId);
        if (!user) throw new BadRequestError("no editable profile for this account");
        if (!verifyPassword(body.currentPassword, String(user.passwordHash ?? ""))) {
          throw new ForbiddenError("current password is incorrect");
        }
        const qe = await getQueryEngine();
        await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, {
          passwordHash: hashPassword(body.newPassword),
        });
        return { ok: true };
      },
      { mutating: true },
    ),
  );

  // Screen catalog (for nav + the admin position editor).
  r.get("/screens", runApi(async () => ({ screens: screenCatalog(metadata) })));

  // ---- user administration (admin only) --------------------------------
  r.get("/admin/users", runApi(async (rc) => {
    if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
    const domain = await getDomainService();
    const page = await domain.list(rc, "user", { pageSize: 500, sort: [{ field: "displayName", dir: "asc" }] });
    return { users: page.items.map(stripHash) };
  }));

  r.post(
    "/admin/users",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const body = readJson(req) as { email?: string; displayName?: string; password?: string; positionId?: string; active?: boolean };
        if (!body.email || !body.password || !body.positionId) {
          throw new BadRequestError("email, password and positionId are required");
        }
        const qe = await getQueryEngine();
        const record = await qe.createWithComputed(
          rc,
          "user",
          {
            email: body.email.toLowerCase(),
            displayName: body.displayName || body.email,
            positionId: body.positionId,
            active: body.active ?? true,
          },
          { passwordHash: hashPassword(body.password) },
        );
        return stripHash(record);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.patch(
    "/admin/users/:id",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const body = readJson(req) as { displayName?: string; positionId?: string; active?: boolean; password?: string };
        const domain = await getDomainService();
        const patch: Record<string, unknown> = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.positionId !== undefined) patch.positionId = body.positionId;
        if (body.active !== undefined) patch.active = body.active;
        let record = Object.keys(patch).length
          ? await domain.update(rc, "user", req.params.id, patch)
          : await domain.get(rc, "user", req.params.id);
        if (body.password) {
          const qe = await getQueryEngine();
          record = await qe.patchComputed(rc, "user", req.params.id, { passwordHash: hashPassword(body.password) });
        }
        return stripHash(record);
      },
      { mutating: true },
    ),
  );

  // ---- metadata ---------------------------------------------------------
  r.get("/meta", runApi(async () => ({ version: metadata.version, entities: metadata.listEntities() })));

  r.get("/meta/:entity", runApi(async (_rc, req) => {
    assertKnownEntity(req.params.entity);
    return metadata.getEntity(req.params.entity);
  }));

  // ---- generic entity CRUD ---------------------------------------------
  r.get("/entities/:entity", runApi(async (rc, req) => {
    assertKnownEntity(req.params.entity);
    const domain = await getDomainService();
    return domain.list(rc, req.params.entity, parseListQuery(req, req.params.entity));
  }));

  r.post(
    "/entities/:entity",
    runApi(
      async (rc, req) => {
        assertKnownEntity(req.params.entity);
        const domain = await getDomainService();
        return domain.create(rc, req.params.entity, readJson(req));
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/entities/:entity/:id", runApi(async (rc, req) => {
    assertKnownEntity(req.params.entity);
    const domain = await getDomainService();
    return domain.get(rc, req.params.entity, req.params.id);
  }));

  r.patch(
    "/entities/:entity/:id",
    runApi(
      async (rc, req) => {
        assertKnownEntity(req.params.entity);
        const domain = await getDomainService();
        return domain.update(rc, req.params.entity, req.params.id, readJson(req), parseIfMatch(req));
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/entities/:entity/:id",
    runApi(
      async (rc, req) => {
        assertKnownEntity(req.params.entity);
        const domain = await getDomainService();
        await domain.remove(rc, req.params.entity, req.params.id, parseIfMatch(req));
        return { deleted: true, id: req.params.id };
      },
      { mutating: true },
    ),
  );

  r.get("/entities/:entity/:id/audit", runApi(async (rc, req) => {
    assertKnownEntity(req.params.entity);
    const domain = await getDomainService();
    await domain.get(rc, req.params.entity, req.params.id); // enforce read + scope
    return { entries: domain.auditTrail(rc, req.params.entity, req.params.id) };
  }));

  r.get("/entities/:entity/:id/transitions", runApi(async (rc, req) => {
    assertKnownEntity(req.params.entity);
    const domain = await getDomainService();
    return { actions: await domain.availableActions(rc, req.params.entity, req.params.id) };
  }));

  r.post(
    "/entities/:entity/:id/transitions",
    runApi(
      async (rc, req) => {
        assertKnownEntity(req.params.entity);
        const body = readJson(req) as { action?: string };
        if (!body.action) throw new BadRequestError("`action` is required");
        const domain = await getDomainService();
        return domain.transition(rc, req.params.entity, req.params.id, body.action, parseIfMatch(req));
      },
      { mutating: true },
    ),
  );

  // ---- aggregation / stats / activity / search -------------------------
  r.post(
    "/aggregate",
    runApi(async (rc, req) => {
      const body = readJson(req) as { entity: string; groupBy?: string; measures?: Measure[]; filters?: Filter[] };
      assertKnownEntity(body.entity);
      const domain = await getDomainService();
      const rows = await domain.aggregate(rc, body.entity, {
        groupBy: body.groupBy,
        measures: body.measures ?? [],
        filters: body.filters,
      });
      return { rows };
    }),
  );

  r.get("/stats", runApi(async (rc) => {
    return cache.wrap(statsKey(rc.tenantId, rc.orgId), 30_000, async () => {
      const domain = await getDomainService();
      const [accounts, contacts, deals, tasks] = await Promise.all([
        domain.list(rc, "account", { pageSize: 1 }),
        domain.list(rc, "contact", { pageSize: 1 }),
        domain.list(rc, "deal", { pageSize: 1000 }),
        domain.list(rc, "task", { pageSize: 1 }),
      ]);

      const pipelineByStage: Record<string, { count: number; value: number }> = {};
      let openPipeline = 0;
      let won = 0;
      for (const deal of deals.items) {
        const stage = String(deal.stage ?? "lead");
        const amount = typeof deal.amount === "number" ? deal.amount : 0;
        pipelineByStage[stage] ??= { count: 0, value: 0 };
        pipelineByStage[stage].count += 1;
        pipelineByStage[stage].value += amount;
        if (stage === "won") won += amount;
        else if (stage !== "lost") openPipeline += amount;
      }

      return {
        counts: { account: accounts.total, contact: contacts.total, deal: deals.total, task: tasks.total },
        pipelineByStage,
        openPipeline,
        wonValue: won,
        cachedAt: rc.at,
      };
    });
  }));

  r.get("/activity", runApi(async (rc, req) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.floor(raw))) : 12;
    const domain = await getDomainService();
    return { entries: domain.recentActivity(rc, limit) };
  }));

  r.get("/search", runApi(async (rc, req) => {
    const term = (req.query.q as string) ?? "";
    const entitiesParam = req.query.entity;
    const entities = Array.isArray(entitiesParam)
      ? (entitiesParam as string[])
      : entitiesParam
        ? [entitiesParam as string]
        : undefined;
    return { query: term, hits: search(rc, term, { entities, limit: 20 }) };
  }));

  // ---- import / export (CSV · Excel · PDF) -----------------------------
  r.get("/export/:entity", runApi(async (rc, req, res) => {
    assertKnownEntity(req.params.entity);
    const entity = req.params.entity;
    const format = String(req.query.format ?? "csv").toLowerCase();
    const domain = await getDomainService();
    setApiHeaders(res, rc.correlationId);

    if (format === "xlsx" || format === "excel") {
      const buf = await exportXlsx(rc, entity, metadata, domain);
      res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("content-disposition", `attachment; filename="${entity}.xlsx"`);
      res.status(200).send(buf);
      return;
    }
    if (format === "pdf") {
      const buf = await exportPdf(rc, entity, metadata, domain);
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `attachment; filename="${entity}.pdf"`);
      res.status(200).send(buf);
      return;
    }
    const csv = await exportCsv(rc, entity, metadata, domain);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${entity}.csv"`);
    res.status(200).send(csv);
  }));

  r.post(
    "/import/:entity",
    runApi(
      async (rc, req) => {
        assertKnownEntity(req.params.entity);
        const body = readJson(req) as { csv?: string };
        const domain = await getDomainService();
        return importCsv(rc, req.params.entity, body.csv ?? "", metadata, domain);
      },
      { mutating: true },
    ),
  );

  // ---- leads ------------------------------------------------------------
  r.post(
    "/leads/:id/convert",
    runApi(
      async (rc, req) => {
        const domain = await getDomainService();
        return domain.convertLead(rc, req.params.id);
      },
      { mutating: true },
    ),
  );

  // ---- quotes -----------------------------------------------------------
  r.post(
    "/quotes",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          accountId: string;
          currencyCode?: string;
          validUntil?: string | null;
          notes?: string | null;
          lines?: LineInput[];
        };
        const fin = await getFinanceService();
        const doc = await fin.createDocument(rc, "quote", "Q", {
          accountId: body.accountId,
          currencyCode: body.currencyCode ?? "USD",
          validUntil: body.validUntil ?? null,
          notes: body.notes ?? null,
          status: "draft",
        });
        if (body.lines?.length) {
          await fin.replaceLines(rc, "quote", "quoteLine", "quoteId", doc.id, body.lines);
        }
        return fin.getDocument(rc, "quote", "quoteLine", "quoteId", doc.id);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/quotes/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "quote", "quoteLine", "quoteId", req.params.id);
  }));

  r.put(
    "/quotes/:id",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { header?: Record<string, unknown>; lines?: LineInput[] };
        const fin = await getFinanceService();
        return fin.saveDocument(rc, "quote", "quoteLine", "quoteId", req.params.id, body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.post(
    "/quotes/:id/convert",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const invoiceId = await fin.convertQuoteToInvoice(rc, req.params.id);
        return { invoiceId };
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- invoices ---------------------------------------------------------
  r.post(
    "/invoices",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          accountId: string;
          currencyCode?: string;
          issueDate?: string | null;
          dueDate?: string | null;
          notes?: string | null;
          lines?: LineInput[];
        };
        const fin = await getFinanceService();
        const doc = await fin.createDocument(rc, "invoice", "INV", {
          accountId: body.accountId,
          currencyCode: body.currencyCode ?? "USD",
          issueDate: body.issueDate ?? null,
          dueDate: body.dueDate ?? null,
          notes: body.notes ?? null,
          status: "draft",
        });
        if (body.lines?.length) {
          await fin.replaceLines(rc, "invoice", "invoiceLine", "invoiceId", doc.id, body.lines);
        }
        return fin.getDocument(rc, "invoice", "invoiceLine", "invoiceId", doc.id);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/invoices/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "invoice", "invoiceLine", "invoiceId", req.params.id);
  }));

  r.put(
    "/invoices/:id",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { header?: Record<string, unknown>; lines?: LineInput[] };
        const fin = await getFinanceService();
        return fin.saveDocument(rc, "invoice", "invoiceLine", "invoiceId", req.params.id, body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.get("/invoices/:id/payments", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    const [doc, payments] = await Promise.all([
      fin.getDocument(rc, "invoice", "invoiceLine", "invoiceId", req.params.id),
      fin.listPayments(rc, req.params.id),
    ]);
    return { invoice: doc.doc, payments };
  }));

  r.post(
    "/invoices/:id/payments",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as Partial<PaymentInput>;
        if (typeof body.amount !== "number" || body.amount <= 0) throw new BadRequestError("amount must be positive");
        if (!body.paidAt) throw new BadRequestError("paidAt is required");
        const fin = await getFinanceService();
        const invoice = await fin.applyPayment(rc, req.params.id, {
          amount: body.amount,
          method: body.method ?? "bank",
          paidAt: body.paidAt,
          notes: body.notes ?? null,
        });
        const payments = await fin.listPayments(rc, req.params.id);
        return { invoice, payments };
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- purchasing: purchase orders + goods receipts --------------------
  r.post(
    "/purchase-orders",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          supplierId: string; warehouseId: string; currencyCode?: string;
          orderDate?: string | null; expectedDate?: string | null; branchId?: string | null;
          notes?: string | null; lines?: LineInput[];
        };
        const pur = await getPurchasingService();
        return pur.createPO(
          rc,
          {
            supplierId: body.supplierId,
            warehouseId: body.warehouseId,
            currencyCode: body.currencyCode ?? "USD",
            orderDate: body.orderDate ?? null,
            expectedDate: body.expectedDate ?? null,
            branchId: body.branchId ?? null,
            notes: body.notes ?? null,
            status: "draft",
          },
          body.lines ?? [],
        );
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/purchase-orders/:id", runApi(async (rc, req) => {
    const pur = await getPurchasingService();
    return pur.getPO(rc, req.params.id);
  }));

  r.put(
    "/purchase-orders/:id",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { header?: Record<string, unknown>; lines?: LineInput[] };
        const pur = await getPurchasingService();
        return pur.savePO(rc, req.params.id, body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.post(
    "/goods-receipts",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          poId?: string | null; supplierId?: string | null; warehouseId: string;
          receiptDate?: string | null; branchId?: string | null; notes?: string | null;
          lines?: GrnLineInput[];
        };
        const pur = await getPurchasingService();
        return pur.createGRN(
          rc,
          {
            poId: body.poId ?? null,
            supplierId: body.supplierId ?? null,
            warehouseId: body.warehouseId,
            receiptDate: body.receiptDate ?? null,
            branchId: body.branchId ?? null,
            notes: body.notes ?? null,
          },
          body.lines ?? [],
        );
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/goods-receipts/:id", runApi(async (rc, req) => {
    const pur = await getPurchasingService();
    return pur.getGRN(rc, req.params.id);
  }));

  r.post(
    "/goods-receipts/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "goodsReceipt", action: "goodsReceipt:post" })) {
          throw new ForbiddenError("not allowed to post goods receipts");
        }
        const pur = await getPurchasingService();
        const goodsReceipt = await pur.postGRN(rc, req.params.id);
        return { goodsReceipt };
      },
      { mutating: true },
    ),
  );

  // ---- accounting: journal entries -------------------------------------
  r.post(
    "/journal-entries",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          date: string; memo?: string | null; branchId?: string | null;
          lines: JournalLineInput[]; post?: boolean;
        };
        const acc = await getAccountingService();
        const { entry } = await acc.createEntry(rc, { date: body.date, memo: body.memo ?? null, source: "manual", branchId: body.branchId ?? null }, body.lines ?? []);
        if (body.post) {
          if (!permissionEngine.can(rc, { entity: "journalEntry", action: "journalEntry:post" })) {
            throw new ForbiddenError("not allowed to post journal entries");
          }
          const posted = await acc.postEntry(rc, entry.id);
          return { entry: posted };
        }
        return { entry };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/journal-entries/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "journalEntry", action: "journalEntry:post" })) {
          throw new ForbiddenError("not allowed to post journal entries");
        }
        const acc = await getAccountingService();
        return { entry: await acc.postEntry(rc, req.params.id) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/journal-entries/:id/void",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "journalEntry", action: "journalEntry:post" })) {
          throw new ForbiddenError("not allowed to void journal entries");
        }
        const acc = await getAccountingService();
        return { entry: await acc.voidEntry(rc, req.params.id) };
      },
      { mutating: true },
    ),
  );

  r.get("/accounting/trial-balance", runApi(async (rc, req) => {
    const acc = await getAccountingService();
    const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
    return { rows: await acc.trialBalance(rc, branchId) };
  }));

  // ---- accounts payable: vendor bills + bill payments ------------------
  r.post(
    "/vendor-bills",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          supplierId: string; goodsReceiptId?: string | null; currencyCode?: string;
          billDate?: string | null; dueDate?: string | null; branchId?: string | null;
          notes?: string | null; lines?: LineInput[];
        };
        const ap = await getPayablesService();
        return ap.createBill(
          rc,
          {
            supplierId: body.supplierId,
            goodsReceiptId: body.goodsReceiptId ?? null,
            currencyCode: body.currencyCode ?? "USD",
            billDate: body.billDate ?? null,
            dueDate: body.dueDate ?? null,
            branchId: body.branchId ?? null,
            notes: body.notes ?? null,
          },
          body.lines ?? [],
        );
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/vendor-bills/:id", runApi(async (rc, req) => {
    const ap = await getPayablesService();
    const [doc, payments] = await Promise.all([ap.getBill(rc, req.params.id), ap.listBillPayments(rc, req.params.id)]);
    return { ...doc, payments };
  }));

  r.put(
    "/vendor-bills/:id",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { header?: Record<string, unknown>; lines?: LineInput[] };
        const ap = await getPayablesService();
        return ap.saveBill(rc, req.params.id, body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.post(
    "/vendor-bills/:id/receive",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "vendorBill", action: "vendorBill:receive" })) {
          throw new ForbiddenError("not allowed to receive vendor bills");
        }
        const ap = await getPayablesService();
        return { vendorBill: await ap.receiveBill(rc, req.params.id) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/vendor-bills/:id/payments",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { amount?: number; method?: string; paidAt?: string; notes?: string | null };
        if (typeof body.amount !== "number" || body.amount <= 0) throw new BadRequestError("amount must be positive");
        if (!body.paidAt) throw new BadRequestError("paidAt is required");
        const ap = await getPayablesService();
        const vendorBill = await ap.payBill(rc, req.params.id, { amount: body.amount, method: body.method ?? "bank", paidAt: body.paidAt, notes: body.notes ?? null });
        const payments = await ap.listBillPayments(rc, req.params.id);
        return { vendorBill, payments };
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- inventory: stock transfer / adjustment posting ------------------
  r.post(
    "/stock-transfers/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "stockTransfer", action: "stockTransfer:post" })) {
          throw new ForbiddenError("not allowed to post stock transfers");
        }
        return { stockTransfer: await postStockTransfer(rc, req.params.id) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/stock-adjustments/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "stockAdjustment", action: "stockAdjustment:post" })) {
          throw new ForbiddenError("not allowed to post stock adjustments");
        }
        return { stockAdjustment: await postStockAdjustment(rc, req.params.id) };
      },
      { mutating: true },
    ),
  );

  // ---- recurring billing + cron ----------------------------------------
  r.post(
    "/recurring/run",
    runApi(
      async (rc) => {
        const fin = await getFinanceService();
        const generated = await fin.generateDueInvoices(rc);
        return { generated, count: generated.length };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/cron/tick",
    runApi(
      async (rc) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const results = await runAllJobs(rc);
        // Also fire any active schedule-triggered automations.
        const automations = await runScheduledAutomations(systemContext(rc.tenantId, rc.orgId));
        if (automations.length) {
          const ok = automations.filter((a) => a.status === "success").length;
          results.push({ name: "automations", at: rc.at, summary: `${ok}/${automations.length} scheduled automation(s) ran` });
        }
        return { results };
      },
      { mutating: true },
    ),
  );

  // Scheduled-job registry + last-run status (for the Automation screen).
  r.get("/jobs", runApi(async () => ({ jobs: jobsStatus() })));

  // ---- automation platform (admin only) --------------------------------
  // User-defined Trigger → Condition → Action rules, their run logs, processing
  // queue, assignment rules, settings and the builder catalog.
  const adminOnly = (rc: { roles: readonly string[] }) => {
    if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
  };

  // Builder catalog (entities, fields, operators, action types) + assignable users.
  r.get("/automation/catalog", runApi(async (rc) => {
    adminOnly(rc);
    const domain = await getDomainService();
    const users = await domain.list(rc, "user", { pageSize: 200, sort: [{ field: "displayName", dir: "asc" }] });
    return {
      catalog: buildCatalog(),
      users: users.items.map((u) => ({ id: String(u.id), displayName: String(u.displayName ?? u.email ?? u.id) })),
    };
  }));

  // Dashboard stats (aggregated across the tenant's rules + recent runs).
  r.get("/automation/stats", runApi(async (rc) => {
    adminOnly(rc);
    const rules = await automationStore.listRules(rc.tenantId, rc.orgId);
    const runs = await automationStore.listRuns(rc.tenantId, rc.orgId, { limit: 500 });
    const totals = rules.reduce(
      (acc, r) => {
        acc.runs += r.stats.runs;
        acc.success += r.stats.success;
        acc.failure += r.stats.failure;
        acc.impact += r.stats.impact;
        acc.avgMsSum += r.stats.avgMs * Math.max(1, r.stats.runs);
        acc.avgMsCount += Math.max(1, r.stats.runs);
        return acc;
      },
      { runs: 0, success: 0, failure: 0, impact: 0, avgMsSum: 0, avgMsCount: 0 },
    );
    const queue = await automationStore.listQueue(rc.tenantId, rc.orgId);
    return {
      active: rules.filter((r) => r.status === "active").length,
      paused: rules.filter((r) => r.status === "paused").length,
      draft: rules.filter((r) => r.status === "draft").length,
      total: rules.length,
      runs: totals.runs,
      success: totals.success,
      failure: totals.failure,
      successRate: totals.runs ? Math.round((totals.success / totals.runs) * 100) : 0,
      avgMs: totals.avgMsCount ? Math.round(totals.avgMsSum / totals.avgMsCount) : 0,
      impact: totals.impact,
      queue: {
        pending: queue.filter((q) => q.state === "pending").length,
        retry: queue.filter((q) => q.state === "retry").length,
        dead: queue.filter((q) => q.state === "dead").length,
      },
      recentRuns: runs.slice(0, 8),
      topRules: [...rules].sort((a, b) => b.stats.runs - a.stats.runs).slice(0, 5).map((r) => ({
        id: r.id,
        name: r.name,
        runs: r.stats.runs,
        successRate: r.stats.runs ? Math.round((r.stats.success / r.stats.runs) * 100) : 0,
        status: r.status,
      })),
    };
  }));

  // List + create rules.
  r.get("/automations", runApi(async (rc) => {
    adminOnly(rc);
    return { rules: await automationStore.listRules(rc.tenantId, rc.orgId) };
  }));

  r.post(
    "/automations",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = readJson(req) as {
          name?: string;
          description?: string;
          status?: AutomationStatus;
          trigger?: unknown;
          conditions?: ConditionGroup;
          actions?: AutomationAction[];
          tags?: string[];
          requiresApproval?: boolean;
        };
        if (!body.name) throw new BadRequestError("name is required");
        if (!body.trigger) throw new BadRequestError("trigger is required");
        const conditions: ConditionGroup = body.conditions ?? { type: "group", logic: "AND", children: [] };
        return await automationStore.createRule({
          tenantId: rc.tenantId,
          orgId: rc.orgId,
          name: body.name,
          description: body.description,
          status: body.status,
          trigger: body.trigger as never,
          conditions,
          actions: body.actions ?? [],
          tags: body.tags,
          requiresApproval: body.requiresApproval,
          by: rc.userId,
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/automations/:id", runApi(async (rc, req) => {
    adminOnly(rc);
    const rule = await automationStore.getRule(rc.tenantId, rc.orgId, req.params.id);
    if (!rule) throw new NotFoundError("automation", req.params.id);
    return rule;
  }));

  r.patch(
    "/automations/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = readJson(req) as Record<string, unknown>;
        const updated = await automationStore.updateRule(rc.tenantId, rc.orgId, req.params.id, body, rc.userId);
        if (!updated) throw new NotFoundError("automation", req.params.id);
        return updated;
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/automations/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        if (!(await automationStore.removeRule(rc.tenantId, rc.orgId, req.params.id))) {
          throw new NotFoundError("automation", req.params.id);
        }
        return { deleted: true, id: req.params.id };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/automations/:id/status",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = readJson(req) as { status?: AutomationStatus };
        if (!body.status) throw new BadRequestError("status is required");
        const updated = await automationStore.setStatus(rc.tenantId, rc.orgId, req.params.id, body.status, rc.userId);
        if (!updated) throw new NotFoundError("automation", req.params.id);
        return updated;
      },
      { mutating: true },
    ),
  );

  r.post(
    "/automations/:id/rollback",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = readJson(req) as { version?: number };
        if (typeof body.version !== "number") throw new BadRequestError("version is required");
        const updated = await automationStore.rollback(rc.tenantId, rc.orgId, req.params.id, body.version, rc.userId);
        if (!updated) throw new NotFoundError("automation version", String(body.version));
        return updated;
      },
      { mutating: true },
    ),
  );

  // Dry-run a rule against a real or sample record (no side effects).
  r.post(
    "/automations/:id/run",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const rule = await automationStore.getRule(rc.tenantId, rc.orgId, req.params.id);
        if (!rule) throw new NotFoundError("automation", req.params.id);
        const body = readJson(req) as { recordId?: string; sample?: Record<string, unknown> };
        let record: Record<string, unknown> = body.sample ?? {};
        if (body.recordId && rule.trigger.entity) {
          const domain = await getDomainService();
          try {
            record = await domain.get(rc, rule.trigger.entity, body.recordId);
          } catch {
            /* fall back to whatever sample was provided */
          }
        }
        if (Object.keys(record).length === 0) record = { id: "sample", name: "Sample record" };
        const run = await executeRule(rule, systemContext(rc.tenantId, rc.orgId), record, {
          test: true,
          trigger: "manual test",
        });
        return run;
      },
      { mutating: true },
    ),
  );

  // Execution logs.
  r.get("/automation/runs", runApi(async (rc, req) => {
    adminOnly(rc);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    return {
      runs: await automationStore.listRuns(rc.tenantId, rc.orgId, {
        ruleId: req.query.ruleId ? String(req.query.ruleId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        limit,
      }),
    };
  }));

  r.get("/automation/runs/:id", runApi(async (rc, req) => {
    adminOnly(rc);
    const run = await automationStore.getRun(rc.tenantId, rc.orgId, req.params.id);
    if (!run) throw new NotFoundError("run", req.params.id);
    return run;
  }));

  // Re-run a past execution live, replaying its captured input.
  r.post(
    "/automation/runs/:id/retry",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const run = await automationStore.getRun(rc.tenantId, rc.orgId, req.params.id);
        if (!run) throw new NotFoundError("run", req.params.id);
        const rule = await automationStore.getRule(rc.tenantId, rc.orgId, run.ruleId);
        if (!rule) throw new NotFoundError("automation", run.ruleId);
        const fresh = await executeRule(rule, systemContext(rc.tenantId, rc.orgId), run.input, {
          test: false,
          trigger: "manual re-run",
        });
        return fresh;
      },
      { mutating: true },
    ),
  );

  // Processing queue (pending / retry / dead-letter).
  r.get("/automation/queue", runApi(async (rc) => {
    adminOnly(rc);
    return { items: await automationStore.listQueue(rc.tenantId, rc.orgId) };
  }));

  r.post(
    "/automation/queue/:id/retry",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const item = await automationStore.getQueueItem(rc.tenantId, rc.orgId, req.params.id);
        if (!item) throw new NotFoundError("queue item", req.params.id);
        const rule = await automationStore.getRule(rc.tenantId, rc.orgId, item.ruleId);
        if (!rule) throw new NotFoundError("automation", item.ruleId);
        const run = await executeRule(rule, systemContext(rc.tenantId, rc.orgId), item.input, {
          test: false,
          trigger: "queue retry",
        });
        if (run.status === "success") {
          await automationStore.removeQueueItem(rc.tenantId, rc.orgId, item.id);
        } else {
          item.attempts += 1;
          item.lastError = run.error;
          item.state = item.attempts >= item.maxAttempts ? "dead" : "retry";
          await automationStore.updateQueueItem(rc.tenantId, rc.orgId, item.id, {
            attempts: item.attempts,
            lastError: item.lastError,
            state: item.state,
          });
        }
        return { run, item };
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/automation/queue/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        if (!(await automationStore.removeQueueItem(rc.tenantId, rc.orgId, req.params.id))) {
          throw new NotFoundError("queue item", req.params.id);
        }
        return { deleted: true, id: req.params.id };
      },
      { mutating: true },
    ),
  );

  // Assignment rules.
  r.get("/automation/assignment", runApi(async (rc) => {
    adminOnly(rc);
    return { rules: await automationStore.listAssignment(rc.tenantId, rc.orgId) };
  }));

  r.post(
    "/automation/assignment",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = readJson(req) as Partial<AssignmentRule>;
        if (!body.name || !body.entity || !body.strategy) {
          throw new BadRequestError("name, entity and strategy are required");
        }
        return await automationStore.upsertAssignment({
          tenantId: rc.tenantId,
          orgId: rc.orgId,
          id: body.id,
          name: body.name,
          entity: body.entity,
          strategy: body.strategy,
          pool: body.pool ?? [],
          territoryMap: body.territoryMap,
          enabled: body.enabled ?? true,
        });
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/automation/assignment/:id",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        if (!(await automationStore.removeAssignment(rc.tenantId, rc.orgId, req.params.id))) {
          throw new NotFoundError("assignment rule", req.params.id);
        }
        return { deleted: true, id: req.params.id };
      },
      { mutating: true },
    ),
  );

  // Settings / governance.
  r.get("/automation/settings", runApi(async (rc) => {
    adminOnly(rc);
    return await automationStore.getSettings(rc.tenantId, rc.orgId);
  }));

  r.patch(
    "/automation/settings",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = readJson(req) as Record<string, unknown>;
        return await automationStore.updateSettings(rc.tenantId, rc.orgId, body);
      },
      { mutating: true },
    ),
  );

  // ---- integration hub (admin only; values stored in the DB) -----------
  r.get("/automation/integrations", runApi(async (rc) => {
    adminOnly(rc);
    return {
      providers: INTEGRATION_PROVIDERS,
      integrations: await automationStore.listIntegrations(rc.tenantId, rc.orgId),
    };
  }));

  r.patch(
    "/automation/integrations/:provider",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const provider = req.params.provider;
        if (!INTEGRATION_PROVIDERS.some((p) => p.key === provider)) {
          throw new NotFoundError("integration", provider);
        }
        const body = readJson(req) as { enabled?: boolean; config?: IntegrationConfig };
        return await automationStore.upsertIntegration(rc.tenantId, rc.orgId, provider, {
          enabled: body.enabled,
          config: body.config,
        });
      },
      { mutating: true },
    ),
  );

  // Lightweight connection check: confirms required variables are present.
  r.post(
    "/automation/integrations/:provider/test",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const provider = req.params.provider;
        const def = INTEGRATION_PROVIDERS.find((p) => p.key === provider);
        if (!def) throw new NotFoundError("integration", provider);
        const state = await automationStore.getIntegration(rc.tenantId, rc.orgId, provider);
        if (provider === "email") {
          const cfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
          return {
            ok: cfg.smtpConfigured || cfg.imapConfigured,
            message: `SMTP ${cfg.smtpConfigured ? "ready" : "not configured"} · IMAP ${cfg.imapConfigured ? "ready" : "not configured"}`,
          };
        }
        const filled = def.fields.filter((f) => {
          const v = state.config[f.key];
          return v !== undefined && v !== null && String(v) !== "";
        }).length;
        const ok = state.enabled && filled > 0;
        return {
          ok,
          message: ok
            ? `${filled} setting(s) configured — connection looks ready`
            : state.enabled
              ? "No connection details configured yet"
              : "Integration is disabled",
        };
      },
      { mutating: true },
    ),
  );

  // ---- system / environment settings (admin only; stored in the DB) ----
  r.get("/system/settings", runApi(async (rc) => {
    adminOnly(rc);
    return {
      groups: [...new Set(SYSTEM_SETTINGS.map((s) => s.group))],
      settings: await automationStore.getSystemSettings(rc.tenantId, rc.orgId),
    };
  }));

  r.patch(
    "/system/settings",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = readJson(req) as Record<string, unknown>;
        return { settings: await automationStore.updateSystemSettings(rc.tenantId, rc.orgId, body) };
      },
      { mutating: true },
    ),
  );

  // ---- webhooks ---------------------------------------------------------
  r.get("/webhooks", runApi(async (rc) => {
    if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
    return {
      endpoints: webhookRegistry.list(rc.tenantId, rc.orgId),
      deliveries: webhookRegistry.listDeliveries(rc.tenantId, rc.orgId),
    };
  }));

  r.post(
    "/webhooks",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const body = readJson(req) as { url?: string; events?: string[]; secret?: string };
        if (!body.url) throw new BadRequestError("url is required");
        return webhookRegistry.register({
          tenantId: rc.tenantId,
          orgId: rc.orgId,
          url: body.url,
          secret: body.secret || randomBytes(16).toString("hex"),
          events: body.events?.length ? body.events : ["*"],
          createdAt: rc.at,
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.delete(
    "/webhooks/:id",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        if (!webhookRegistry.remove(rc.tenantId, rc.orgId, req.params.id)) {
          throw new NotFoundError("webhook", req.params.id);
        }
        return { deleted: true, id: req.params.id };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/webhooks/:id/test",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const endpoint = webhookRegistry.get(rc.tenantId, rc.orgId, req.params.id);
        if (!endpoint) throw new NotFoundError("webhook", req.params.id);
        await testWebhook(endpoint, rc.at);
        return { ok: true, deliveries: webhookRegistry.listDeliveries(rc.tenantId, rc.orgId) };
      },
      { mutating: true },
    ),
  );

  // Local webhook receiver (intentionally unauthenticated; echoes signature).
  r.post("/webhooks/echo", (req: Request, res: Response) => {
    res.json({ received: true, signature: req.get("x-aula-signature") ?? "" });
  });

  // ---- notifications ----------------------------------------------------
  r.get("/notifications", runApi(async (rc) => ({
    items: notifications.list(rc.tenantId, rc.orgId),
    unread: notifications.unreadCount(rc.tenantId, rc.orgId),
  })));

  r.post(
    "/notifications",
    runApi(
      async (rc) => {
        notifications.markAllRead(rc.tenantId, rc.orgId);
        return { ok: true };
      },
      { mutating: true },
    ),
  );

  // Delete notifications (single or bulk) — body: { ids: string[] }.
  r.post(
    "/notifications/delete",
    runApi(
      async (rc, req) => {
        const body = (req.body ?? {}) as { ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const removed = notifications.remove(rc.tenantId, rc.orgId, ids);
        return { removed };
      },
      { mutating: true },
    ),
  );

  // ---- admin governance / releases -------------------------------------
  r.post(
    "/admin/metadata/republish",
    runApi(
      async (rc) => {
        const published = publishMetadata(rc, metadata.version, "re-published from settings");
        return { version: published.version, publishedAt: published.publishedAt, publishedBy: published.publishedBy };
      },
      { mutating: true },
    ),
  );

  r.get("/admin/releases", runApi(async (rc) => {
    if (!rc.roles.includes("admin")) throw new ForbiddenError("only administrators may view the release trail");
    return { releases: releaseLog.list(), migrations: MIGRATIONS };
  }));

  // ---- files: real upload / download (local-disk storage) ----------------
  r.post(
    "/files/upload",
    runApi(
      async (rc, req) => {
        const { buffer, filename, folder } = await new Promise<{ buffer: Buffer; filename: string; folder: string }>(
          (resolve, reject) => {
            const chunks: Buffer[] = [];
            let filename = "upload";
            let folder = "documents";
            let tooBig = false;
            const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
            bb.on("file", (_name, stream, info) => {
              if (info.filename) filename = info.filename;
              stream.on("data", (d: Buffer) => chunks.push(d));
              stream.on("limit", () => {
                tooBig = true;
              });
            });
            bb.on("field", (name, value) => {
              if (name === "folder" && value) folder = value;
            });
            bb.on("close", () =>
              tooBig
                ? reject(new BadRequestError("file exceeds the 100 MB limit"))
                : resolve({ buffer: Buffer.concat(chunks), filename, folder }),
            );
            bb.on("error", reject);
            req.pipe(bb);
          },
        );

        if (!buffer.length) throw new BadRequestError("no file uploaded");
        const domain = await getDomainService();
        const record = await domain.create(rc, "file", {
          name: filename,
          folder,
          sizeKb: Math.max(1, Math.round(buffer.length / 1024)),
          owner: rc.displayName,
        });
        await saveBlob(record.id, buffer); // blob keyed by the record id
        return record;
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/files/:id/download", runApi(async (rc, req, res) => {
    const domain = await getDomainService();
    const record = await domain.get(rc, "file", req.params.id); // enforces read + tenant scope
    if (!(await blobExists(req.params.id))) throw new NotFoundError("file", req.params.id);
    const name = String(record.name);
    // `?inline=1` serves with a guessed content-type + inline disposition so chat
    // image attachments render in <img>; the default stays a forced download.
    const inline = req.query.inline === "1" || req.query.inline === "true";
    setApiHeaders(res, rc.correlationId);
    res.setHeader("content-type", inline ? guessFileContentType(name) : "application/octet-stream");
    res.setHeader("content-disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`);
    await new Promise<void>((resolve, reject) => {
      const stream = openBlob(req.params.id);
      stream.on("error", reject);
      res.on("finish", resolve);
      stream.pipe(res);
    });
  }));

  // ---- chat: user picker + conversations + messages (privacy via chat/service) -
  r.get("/chat/users", runApi(async (rc) => ({ users: await listChatUsers(rc) })));
  r.get("/chat/conversations", runApi(async (rc) => ({ conversations: await listConversations(rc) })));
  r.get(
    "/chat/messages",
    runApi(async (rc, req) => ({ items: await listMessages(rc, String(req.query.conversationId ?? "")) })),
  );
  r.post(
    "/chat/messages",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          participants?: Array<string | number>;
          conversationId?: string;
          body?: string | null;
          attachments?: { fileId: string; name: string; kind: "image" | "file"; sizeKb?: number }[] | null;
        };
        return createChatMessage(rc, body);
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- email: SMTP send + IMAP sync (env-driven; DB-only when unconfigured) -
  r.post(
    "/email/send",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { to?: string | string[]; subject?: string; body?: string };
        // `to` may be a single address or a list (single / bulk send to many recipients).
        const recipients = (Array.isArray(body.to) ? body.to : body.to ? [body.to] : [])
          .map((t) => String(t).trim())
          .filter(Boolean);
        if (recipients.length === 0) throw new BadRequestError("`to` is required");
        const domain = await getDomainService();
        const scope = { tenantId: rc.tenantId, orgId: rc.orgId };
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const records = [];
        let sentCount = 0;
        // One real message + one Sent record per recipient (individual delivery, no shared To).
        for (const to of recipients) {
          const messageId = await sendMail({ to, subject: body.subject ?? "", text: body.body ?? "" }, scope);
          if (messageId !== null) sentCount++;
          records.push(
            await domain.create(rc, "email", {
              folder: "sent",
              sender: to,
              subject: body.subject ?? "",
              body: body.body ?? "",
              unread: false,
            }),
          );
        }
        return { records, record: records[0], sent: sentCount > 0, count: records.length, smtpConfigured: emailCfg.smtpConfigured };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/email/sync",
    runApi(
      async (rc) => {
        const scope = { tenantId: rc.tenantId, orgId: rc.orgId };
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        if (!emailCfg.imapConfigured) return { configured: false, synced: 0 };
        const domain = await getDomainService();
        const norm = (id: unknown) => String(id ?? "").replace(/[<>]/g, "").trim().toLowerCase();
        // Dedup precisely by Message-ID (one row per real email); fall back to
        // sender|subject only for mail with no Message-ID header.
        const keyOf = (messageId: unknown, sender: unknown, subject: unknown) => {
          const k = norm(messageId);
          return k ? `mid:${k}` : `ss:${String(sender)}|${String(subject)}`;
        };
        // Message-IDs already stored — page through the whole inbox (pageSize is capped).
        const seen = new Set<string>();
        for (let page = 1; ; page++) {
          const existing = await domain.list(rc, "email", {
            filters: [{ field: "folder", op: "eq", value: "inbox" }],
            pageSize: 200,
            page,
          });
          for (const e of existing.items) seen.add(keyOf(e.messageId, e.sender, e.subject));
          if (existing.items.length === 0 || page >= existing.pageCount) break;
        }
        // Cheap envelope scan of the whole mailbox (no bodies) → only the UIDs
        // whose Message-ID is new. We then download bodies ONLY for new mail,
        // capped per run so a large mailbox never times out the request.
        const headers = await fetchHeaders(scope);
        const freshUids = headers.filter((h) => !seen.has(`mid:${norm(h.messageId)}`)).map((h) => h.uid);
        if (freshUids.length === 0) return { configured: true, synced: 0, remaining: 0 };
        const BATCH = 100;
        const messages = await fetchBodiesByUid(freshUids.slice(0, BATCH), scope);
        let synced = 0;
        for (const m of messages) {
          const key = keyOf(m.messageId, m.sender, m.subject);
          if (seen.has(key)) continue; // post-check: envelope vs parsed Message-ID may differ
          seen.add(key);
          const created = await domain.create(rc, "email", {
            folder: "inbox",
            sender: m.sender,
            subject: m.subject,
            body: m.body,
            unread: true,
            messageId: m.messageId,
          });
          notifications.add({
            at: new Date().toISOString(),
            tenantId: rc.tenantId,
            orgId: rc.orgId,
            channel: "email",
            subject: m.subject || "(no subject)",
            body: `New email from ${m.sender}`,
            eventType: "email.received",
            // Deep link straight to this message so the bell opens it in the mailbox.
            href: `/email?open=${encodeURIComponent(String(created.id))}`,
          });
          synced++;
        }
        return { configured: true, synced, remaining: Math.max(0, freshUids.length - BATCH) };
      },
      { mutating: true },
    ),
  );

  // Lightweight mailbox listing: full records minus the heavy `body` — just a
  // short preview. The mailbox UI loads this (paged) and fetches the full body
  // lazily via GET /entities/email/:id when a message is opened.
  r.get(
    "/email/list",
    runApi(async (rc, req) => {
      const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
      const domain = await getDomainService();
      const res = await domain.list(rc, "email", { page, pageSize: 200 });
      const items = res.items.map((e) => ({
        id: e.id,
        folder: e.folder,
        sender: e.sender,
        subject: e.subject,
        preview: String(e.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
        unread: e.unread,
        createdAt: e.createdAt,
        version: e.version,
      }));
      return { items, total: res.total, page: res.page, pageSize: res.pageSize, pageCount: res.pageCount };
    }),
  );

  // ---- health (public, no auth) ----------------------------------------
  r.get("/health", (_req: Request, res: Response) => {
    setApiHeaders(res);
    res.json({
      status: "ok",
      metadataVersion: metadata.version,
      backends: usingInMemoryBackends ? "in-memory" : "external",
      metrics: metrics.snapshot(),
    });
  });

  return r;
}
