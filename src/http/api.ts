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
import { getInventoryService } from "@/lib/inventory/service";
import { getPosService, type PosCheckoutInput } from "@/lib/pos/service";
import { postStockTransfer, postStockAdjustment } from "@/lib/accounting/postings";
import { permissionEngine } from "@/lib/permissions/engine";
import { grantsFor, roleGrants } from "@/lib/permissions/policies";
import { metadata } from "@/lib/metadata";
import { search } from "@/lib/search/service";
import { cache } from "@/lib/cache/cache";
import { statsKey } from "@/lib/cache/invalidation";
import { notifications, notifyUser, buildInAppMuteFilter } from "@/lib/integrations/notifications";
import { webhookRegistry, testWebhook } from "@/lib/integrations/webhooks";
import { exportCsv, importCsv, importXlsx, buildImportTemplate, parseImportFile } from "@/lib/integrations/import-export";
import { startImportJob, getImportJob, toView } from "@/lib/integrations/import-jobs";
import { exportXlsx, exportPdf } from "@/lib/integrations/export-formats";
import { renderReportXlsx, type ReportPayload } from "@/lib/integrations/report-export";
import { runAllJobs, jobsStatus } from "@/lib/jobs/scheduler";
import { retryFailedPostings } from "@/lib/accounting/postings";
import { withIdempotency } from "@/lib/http/idempotency-cache";
import {
  automationStore,
  buildCatalog,
  executeRule,
  runScheduledAutomations,
  enqueueScheduled,
  processQueue,
  getLiveActivity,
  INTEGRATION_PROVIDERS,
  fieldApplies,
  SYSTEM_SETTINGS,
  type AssignmentRule,
  type AutomationAction,
  type AutomationStatus,
  type ConditionGroup,
  type IntegrationConfig,
} from "@/lib/automation";
import { publishMetadata } from "@/lib/config/governance";
import { releaseLog } from "@/lib/config/release";
import { schemaStatus } from "@/lib/data/sql/migrate";
import { metrics } from "@/lib/observability/metrics";
import { getInflight } from "@/lib/http/resilience";
import { env, isProduction, usingInMemoryBackends } from "@/lib/config/env";
import { BadRequestError, ForbiddenError, NotFoundError, toAppError } from "@/lib/enforcement/errors";
import type { Filter, Measure } from "@/lib/data/query";
import { issuePersonaToken } from "@/lib/security/auth-config";
import { saveBlob, readBlob } from "@/lib/integrations/file-storage";
import { sendMail, fetchHeaders, fetchBodiesByUid, deleteOnServer, restoreOnServer } from "@/lib/integrations/email-transport";
import { sendSms } from "@/lib/integrations/sms-transport";
import { sendWhatsApp } from "@/lib/integrations/whatsapp-transport";
import { sendSlack } from "@/lib/integrations/slack-transport";
import { restTestConnection } from "@/lib/integrations/rest-transport";
import { erpTestConnection } from "@/lib/integrations/erp-transport";
import { login, getPosition, parseScreens, findUserById, recordSecurityEvent } from "@/lib/security/auth-service";
import { randomBase32Secret, totpUri, totpVerify, encrypt, decrypt, hashPassword, verifyPassword } from "@/lib/security/crypto";
import { SESSION_COOKIE } from "@/lib/security/auth";
import { rateLimit, peekRateLimit, clearRateLimit } from "@/lib/security/rate-limit";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { screenCatalog } from "@/lib/config/screens";
import { SETTINGS_AREAS, canSettings, areaForUserSettingKey } from "@/lib/config/settings-permissions";
import { resolveMobileConfig, mobileScreenCatalog } from "@/lib/mobile/service";
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";

/** Minimum length for any password set through the API. */
const MIN_PASSWORD_LEN = 8;

/** Fields referenced as `{{record.X}}` in a rule's message recipients (email / SMS
 *  / WhatsApp / notify) — so a manual run can pick a record that actually yields a
 *  deliverable recipient. */
const MESSAGING_ACTIONS = new Set(["send_email", "send_sms", "send_whatsapp", "notify"]);
function emailRecipientFields(rule: { actions?: Array<{ type: string; to?: unknown }> }): string[] {
  const out = new Set<string>();
  for (const a of rule.actions ?? []) {
    if (MESSAGING_ACTIONS.has(a.type) && typeof a.to === "string") {
      for (const m of a.to.matchAll(/\{\{\s*record\.(\w+)\s*\}\}/g)) out.add(m[1]);
    }
  }
  return [...out];
}

/** Reject weak passwords (applied to self-service change + admin create/reset). */
function assertPasswordStrength(pw: string): void {
  if (!pw || pw.length < MIN_PASSWORD_LEN) {
    throw new BadRequestError(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
}

/** Cookie options for the session JWT. `strict` blocks the cookie on cross-site
 *  requests (CSRF defence-in-depth alongside the double-submit token). */
function sessionCookieOpts(ttlSec: number) {
  return { httpOnly: true, sameSite: "strict" as const, path: "/", maxAge: ttlSec * 1000, secure: isProduction };
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

/** MIME types that are unsafe to store/serve (script/markup the browser may
 *  execute when served inline → stored-XSS). Rejected at upload time. */
const BLOCKED_UPLOAD_MIME = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/x-msdownload",
  "application/x-sh",
]);

/** Content-types we allow to render inline on download; everything else is forced
 *  to download as an attachment so it can never execute in the browsing context. */
const INLINE_SAFE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** Drop the password hash + 2FA secret before returning a user record to a client. */
function stripHash(user: EntityRecord): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...user };
  delete rest.passwordHash;
  delete rest.twoFactorSecret;
  return rest;
}

/** The caller's effective grants — the position's matrix, else its role defaults. */
function effectiveGrants(rc: RequestContext): string[] {
  return rc.grants ? [...rc.grants] : [...grantsFor(rc.roles)];
}

/**
 * Gate one Settings-screen operation (see lib/config/settings-permissions).
 * Administrators hold `*` and pass everything; every other position needs the
 * area grant the admin ticked in the permission matrix.
 */
function assertSettings(rc: RequestContext, area: string, action: string): void {
  if (!canSettings(effectiveGrants(rc), area, action)) {
    throw new ForbiddenError(`this position is not granted "${area}:${action}"`);
  }
}

/** Best-effort client IP for the security activity log. */
function clientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd ?? "").split(",")[0];
  return (first || req.ip || req.socket?.remoteAddress || "").trim() || null;
}

export function buildApiRouter(): Router {
  const r = Router();

  // ---- auth -------------------------------------------------------------
  // Credential login (email + password). Sets an httpOnly session cookie.
  // Dev-only fallback: `{ actor }` mints a persona token when AULA_DEV_AUTH.
  r.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { email?: string; password?: string; code?: string; actor?: string };
      // Throttle brute-force: cap attempts per source IP (per minute) and lock an
      // email after repeated failures (15-min window). Cleared on a successful login.
      const ip = clientIp(req) ?? "unknown";
      const ipRl = rateLimit(`login:ip:${ip}`, 30, 60_000);
      if (!ipRl.allowed) {
        res.set("Retry-After", String(ipRl.retryAfter));
        res.status(429).json({ error: { code: "RATE_LIMITED", message: "too many login attempts; try again later" } });
        return;
      }
      const emailKey = `login:fail:${(body.email ?? "").toLowerCase()}`;
      if (body.email) {
        const lock = peekRateLimit(emailKey, 8);
        if (!lock.allowed) {
          res.set("Retry-After", String(lock.retryAfter));
          res.status(429).json({ error: { code: "RATE_LIMITED", message: "account temporarily locked after too many failed attempts" } });
          return;
        }
      }
      if (body.email && body.password) {
        const outcome = await login(body.email, body.password, body.code);
        if (outcome.status === "2fa_required") {
          // Password was correct — ask the client for the authenticator code.
          setApiHeaders(res);
          res.json({ twoFactorRequired: true });
          return;
        }
        if (outcome.status === "invalid_code") {
          rateLimit(emailKey, 8, 15 * 60_000); // count the failed code attempt
          res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "invalid authentication code" } });
          return;
        }
        if (outcome.status === "invalid") {
          rateLimit(emailKey, 8, 15 * 60_000); // count the failed credential attempt
          res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "invalid email or password" } });
          return;
        }
        clearRateLimit(emailKey); // success resets the lockout counter
        await recordSecurityEvent({ tenantId: outcome.tenantId, orgId: outcome.orgId }, outcome.userId, "sign_in", {
          ip: clientIp(req),
          userAgent: req.headers["user-agent"] ?? null,
        });
        res.cookie(SESSION_COOKIE, outcome.result.token, sessionCookieOpts(outcome.result.expiresIn));
        setApiHeaders(res);
        res.json({ user: outcome.result.user, position: outcome.result.position, screens: outcome.result.screens });
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
    // Effective mobile screen set (admin config ∩ this user's permitted screens),
    // so the companion app can gate its navigation straight from the login call.
    const mobile = await resolveMobileConfig(rc);
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
      // Screens the companion mobile app may show (a subset of `screens`), plus a
      // version stamp the app polls to pick up admin changes without a full reload.
      mobileScreens: mobile.screens,
      mobileScreensVersion: mobile.version,
      mobileHiddenFields: mobile.hiddenFields,
      // The caller's effective operation grants (matrix-authoritative, else role defaults).
      grants: rc.grants ? [...rc.grants] : [...grantsFor(rc.roles)],
      phone: (userRec?.phone as string | null) ?? null,
      timezone: (userRec?.timezone as string | null) ?? null,
      avatarId: (userRec?.avatarId as string | null) ?? null,
      jobTitle: (userRec?.jobTitle as string | null) ?? null,
      location: (userRec?.location as string | null) ?? null,
      bio: (userRec?.bio as string | null) ?? null,
      twoFactorEnabled: Boolean(userRec?.twoFactorEnabled),
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
          avatarId?: string | null;
          jobTitle?: string | null;
          location?: string | null;
          bio?: string | null;
          notificationPrefs?: unknown;
        };
        // Profile fields and notification preferences are separately grantable.
        const profileKeys = ["displayName", "email", "phone", "timezone", "jobTitle", "location", "bio"] as const;
        if (profileKeys.some((k) => body[k] !== undefined)) assertSettings(rc, "settings.profile", "update");
        if (body.avatarId !== undefined) assertSettings(rc, "settings.profile", "avatar");
        if (body.notificationPrefs !== undefined) assertSettings(rc, "settings.notifications", "update");
        const user = await findUserById(rc.userId);
        if (!user) throw new BadRequestError("no editable profile for this account");
        const patch: Record<string, unknown> = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.email !== undefined) patch.email = String(body.email).toLowerCase();
        if (body.phone !== undefined) patch.phone = body.phone;
        if (body.timezone !== undefined) patch.timezone = body.timezone;
        if (body.avatarId !== undefined) patch.avatarId = body.avatarId || null;
        if (body.jobTitle !== undefined) patch.jobTitle = body.jobTitle || null;
        if (body.location !== undefined) patch.location = body.location || null;
        if (body.bio !== undefined) patch.bio = body.bio || null;
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
        // Each key belongs to a settings area (theme/density → appearance,
        // mailSyncInterval → notifications), so both are gated independently.
        for (const [key] of entries) {
          const { area, action } = areaForUserSettingKey(key);
          assertSettings(rc, area, action);
        }
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
        assertSettings(rc, "settings.security", "password");
        const body = readJson(req) as { currentPassword?: string; newPassword?: string };
        if (!body.currentPassword || !body.newPassword) {
          throw new BadRequestError("currentPassword and newPassword are required");
        }
        assertPasswordStrength(body.newPassword);
        const user = await findUserById(rc.userId);
        if (!user) throw new BadRequestError("no editable profile for this account");
        if (!(await verifyPassword(body.currentPassword, String(user.passwordHash ?? "")))) {
          throw new ForbiddenError("current password is incorrect");
        }
        const qe = await getQueryEngine();
        await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, {
          passwordHash: await hashPassword(body.newPassword),
        });
        await recordSecurityEvent({ tenantId: rc.tenantId, orgId: rc.orgId }, rc.userId, "password_changed", {
          ip: clientIp(req),
          userAgent: req.headers["user-agent"] ?? null,
        });
        return { ok: true };
      },
      { mutating: true },
    ),
  );

  // ---- two-factor authentication (TOTP) --------------------------------
  // Begin enrollment: generate a fresh secret (stored encrypted, not yet enabled)
  // and return the otpauth URI + manual key for the authenticator app.
  r.post(
    "/auth/2fa/setup",
    runApi(async (rc) => {
      assertSettings(rc, "settings.security", "twoFactor");
      const user = await findUserById(rc.userId);
      if (!user) throw new BadRequestError("no editable profile for this account");
      const secret = randomBase32Secret();
      const qe = await getQueryEngine();
      await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, {
        twoFactorSecret: await encrypt(secret),
        twoFactorEnabled: false,
      });
      return { secret, otpauth: totpUri(secret, String(user.email ?? rc.email ?? rc.userId)) };
    }, { mutating: true }),
  );

  // Confirm enrollment: verify a code against the pending secret, then enable 2FA.
  r.post(
    "/auth/2fa/enable",
    runApi(async (rc, req) => {
      assertSettings(rc, "settings.security", "twoFactor");
      const body = readJson(req) as { code?: string };
      const user = await findUserById(rc.userId);
      if (!user?.twoFactorSecret) throw new BadRequestError("start 2FA setup first");
      let secret = "";
      try { secret = await decrypt(String(user.twoFactorSecret)); } catch { secret = ""; }
      if (!secret || !totpVerify(secret, String(body.code ?? ""))) {
        throw new ForbiddenError("invalid authentication code");
      }
      const qe = await getQueryEngine();
      await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, { twoFactorEnabled: true });
      await recordSecurityEvent({ tenantId: rc.tenantId, orgId: rc.orgId }, rc.userId, "twofactor_enabled", {
        ip: clientIp(req),
        userAgent: req.headers["user-agent"] ?? null,
      });
      return { twoFactorEnabled: true };
    }, { mutating: true }),
  );

  // Disable 2FA — requires the account password to confirm.
  r.post(
    "/auth/2fa/disable",
    runApi(async (rc, req) => {
      assertSettings(rc, "settings.security", "twoFactor");
      const body = readJson(req) as { password?: string };
      const user = await findUserById(rc.userId);
      if (!user) throw new BadRequestError("no editable profile for this account");
      if (!body.password || !(await verifyPassword(body.password, String(user.passwordHash ?? "")))) {
        throw new ForbiddenError("password is incorrect");
      }
      const qe = await getQueryEngine();
      await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, {
        twoFactorEnabled: false,
        twoFactorSecret: null,
      });
      await recordSecurityEvent({ tenantId: rc.tenantId, orgId: rc.orgId }, rc.userId, "twofactor_disabled", {
        ip: clientIp(req),
        userAgent: req.headers["user-agent"] ?? null,
      });
      return { twoFactorEnabled: false };
    }, { mutating: true }),
  );

  // Recent security activity for the signed-in user (sign-ins + security changes).
  r.get("/auth/security/activity", runApi(async (rc) => {
    assertSettings(rc, "settings.security", "activity");
    const qe = await getQueryEngine();
    const page = await qe.list(systemContext(rc.tenantId, rc.orgId), "securityEvent", {
      filters: [{ field: "userId", op: "eq", value: rc.userId }],
      sort: [{ field: "at", dir: "desc" }],
      pageSize: 20,
    });
    return {
      events: page.items.map((e) => ({
        id: String(e.id),
        type: String(e.type),
        ip: (e.ip as string | null) ?? null,
        userAgent: (e.userAgent as string | null) ?? null,
        at: String(e.at ?? ""),
      })),
    };
  }));

  // Screen catalog (for nav + the admin position editor).
  r.get("/screens", runApi(async () => ({ screens: screenCatalog(metadata) })));

  // ---- mobile screen configuration -------------------------------------
  // The companion app's screen visibility is curated here. `GET /mobile/config`
  // is the per-user resolved view the app polls; the rest are admin tools.

  // Resolved config for the signed-in user (app foreground/login + ~60s poll).
  r.get("/mobile/config", runApi(async (rc, req) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "*";
    return resolveMobileConfig(rc, clientId);
  }));

  // Toggleable screen catalog (full web catalog, flagged with mobile support).
  r.get("/mobile/screens", runApi(async (rc) => {
    assertSettings(rc, "settings.mobile", "read");
    return { screens: mobileScreenCatalog() };
  }));

  // Admin CRUD over the raw config rows. `screens`/`hiddenFields` are persisted
  // as JSON text; accept either the parsed shape or a pre-stringified value.
  const asJsonText = (value: unknown, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  };

  r.get("/mobile/configs", runApi(async (rc) => {
    assertSettings(rc, "settings.mobile", "read");
    const domain = await getDomainService();
    const page = await domain.list(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", {
      pageSize: 500,
      sort: [{ field: "updatedAt", dir: "desc" }],
    });
    const configs = page.items.map((row) => ({
      id: String(row.id),
      clientId: String(row.clientId ?? "*"),
      positionId: (row.positionId as string | null) || null,
      userId: (row.userId as string | null) || null,
      screens: JSON.parse(String(row.screens ?? "[]")) as string[],
      hiddenFields: JSON.parse(String(row.hiddenFields ?? "{}")) as Record<string, string[]>,
      active: row.active !== false,
      version: Number(row.version ?? 0),
      updatedAt: String(row.updatedAt ?? ""),
    }));
    return { configs };
  }));

  r.post(
    "/mobile/configs",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.mobile", "create");
        const body = readJson(req) as Record<string, unknown>;
        const domain = await getDomainService();
        const created = await domain.create(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", {
          clientId: String(body.clientId ?? "*") || "*",
          positionId: body.positionId ? String(body.positionId) : null,
          userId: body.userId ? String(body.userId) : null,
          screens: asJsonText(body.screens, "[]"),
          hiddenFields: asJsonText(body.hiddenFields, "{}"),
          active: body.active === undefined ? true : Boolean(body.active),
        });
        return { id: String(created.id) };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.patch(
    "/mobile/configs/:id",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.mobile", "update");
        const body = readJson(req) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (body.clientId !== undefined) patch.clientId = String(body.clientId) || "*";
        if (body.positionId !== undefined) patch.positionId = body.positionId ? String(body.positionId) : null;
        if (body.userId !== undefined) patch.userId = body.userId ? String(body.userId) : null;
        if (body.screens !== undefined) patch.screens = asJsonText(body.screens, "[]");
        if (body.hiddenFields !== undefined) patch.hiddenFields = asJsonText(body.hiddenFields, "{}");
        if (body.active !== undefined) patch.active = Boolean(body.active);
        const domain = await getDomainService();
        const updated = await domain.update(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", req.params.id, patch);
        return { id: String(updated.id) };
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/mobile/configs/:id",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.mobile", "delete");
        const domain = await getDomainService();
        await domain.remove(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", req.params.id);
        return { deleted: true, id: req.params.id };
      },
      { mutating: true },
    ),
  );

  // Permission catalog — every entity's grantable operations, the Settings-screen
  // areas + their operations, the special (non-entity) grants, and each base
  // role's default grants (matrix presets).
  r.get("/permissions/catalog", runApi(async (rc) => {
    assertSettings(rc, "settings.roles", "read");
    const CRUD = ["read", "create", "update", "delete"];
    const entities = metadata
      .listEntities()
      .filter((e) => !e.system)
      .map((e) => {
        // Operations = CRUD + the entity's own lifecycle actions (post/approve/win…).
        const extra = new Set<string>();
        for (const tr of e.lifecycle?.transitions ?? []) {
          if (!tr.requires) continue;
          const [ent, verb] = tr.requires.split(":");
          if (ent === e.name && verb && !CRUD.includes(verb)) extra.add(verb);
        }
        return { name: e.name, group: e.group ?? "crm", actions: [...CRUD, ...extra] };
      });
    // Non-entity grants that gate bespoke operations.
    const special = ["pos:checkout", "pii:read"];
    const roles = ["admin", "sales_manager", "sales_rep", "accountant", "warehouse_manager"].map((role) => ({
      value: role,
      grants: roleGrants(role),
    }));
    // The Settings screen, area by area — the fine-grained layer on top of the
    // coarse `settings` screen key.
    return { entities, special, roles, settings: SETTINGS_AREAS };
  }));

  // ---- user administration ----------------------------------------------
  // Administrators always pass; other positions need the `settings.users` grants
  // an admin ticked in the permission matrix (read / create / update / password
  // / twoFactor / activate are separately grantable).
  r.get("/admin/users", runApi(async (rc) => {
    assertSettings(rc, "settings.users", "read");
    const domain = await getDomainService();
    const page = await domain.list(rc, "user", { pageSize: 500, sort: [{ field: "displayName", dir: "asc" }] });
    return { users: page.items.map(stripHash) };
  }));

  r.post(
    "/admin/users",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.users", "create");
        const body = readJson(req) as {
          email?: string; displayName?: string; password?: string; positionId?: string; active?: boolean;
          managerId?: string | null; phone?: string | null; jobTitle?: string | null;
        };
        if (!body.email || !body.password || !body.positionId) {
          throw new BadRequestError("email, password and positionId are required");
        }
        assertPasswordStrength(body.password);
        const domain = await getDomainService();
        // Go through the domain service (not the raw query engine) so a
        // `user.created` event is emitted — letting automations/webhooks fire
        // when an admin adds a user (e.g. "email the newly-added user").
        const record = await domain.createWithComputed(
          rc,
          "user",
          {
            email: body.email.toLowerCase(),
            displayName: body.displayName || body.email,
            positionId: body.positionId,
            active: body.active ?? true,
            managerId: body.managerId || null,
            phone: body.phone || null,
            jobTitle: body.jobTitle || null,
          },
          { passwordHash: await hashPassword(body.password) },
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
        const body = readJson(req) as {
          displayName?: string; positionId?: string; active?: boolean; password?: string;
          email?: string; managerId?: string | null; phone?: string | null; jobTitle?: string | null;
          resetTwoFactor?: boolean;
        };
        // Editing a user, resetting their password, clearing their second factor
        // and enabling/disabling the account are separate privileges.
        const editKeys = ["displayName", "email", "positionId", "managerId", "phone", "jobTitle"] as const;
        if (editKeys.some((k) => body[k] !== undefined)) assertSettings(rc, "settings.users", "update");
        if (body.password !== undefined) assertSettings(rc, "settings.users", "password");
        if (body.resetTwoFactor) assertSettings(rc, "settings.users", "twoFactor");
        if (body.active !== undefined) assertSettings(rc, "settings.users", "activate");
        // A manager can't be their own supervisor.
        if (body.managerId && String(body.managerId) === req.params.id) {
          throw new BadRequestError("a user cannot be their own manager");
        }
        const domain = await getDomainService();
        const patch: Record<string, unknown> = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.email !== undefined) patch.email = String(body.email).toLowerCase();
        if (body.positionId !== undefined) patch.positionId = body.positionId;
        if (body.active !== undefined) patch.active = body.active;
        if (body.managerId !== undefined) patch.managerId = body.managerId || null;
        if (body.phone !== undefined) patch.phone = body.phone || null;
        if (body.jobTitle !== undefined) patch.jobTitle = body.jobTitle || null;
        let record = Object.keys(patch).length
          ? await domain.update(rc, "user", req.params.id, patch)
          : await domain.get(rc, "user", req.params.id);
        const qe = await getQueryEngine();
        if (body.password) {
          assertPasswordStrength(body.password);
          record = await qe.patchComputed(rc, "user", req.params.id, { passwordHash: await hashPassword(body.password) });
        }
        // Admin recovery: clear a user's two-factor enrollment (e.g. lost device).
        if (body.resetTwoFactor) {
          record = await qe.patchComputed(rc, "user", req.params.id, { twoFactorEnabled: false, twoFactorSecret: null });
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
      const [accounts, deals, tasks] = await Promise.all([
        domain.list(rc, "account", { pageSize: 1 }),
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
        counts: { account: accounts.total, deal: deals.total, task: tasks.total },
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
    const entries = domain.recentActivity(rc, limit);
    // Resolve actor ids → display names. The user table is admin-scoped, so read
    // it through a system context; "system" is the platform/automation actor.
    const nameById = new Map<string, string>();
    try {
      const users = await domain.list(systemContext(rc.tenantId, rc.orgId), "user", { pageSize: 500 });
      for (const u of users.items) nameById.set(String(u.id), String(u.displayName ?? u.email ?? u.id));
    } catch {
      /* user read unavailable — fall back to raw id */
    }
    const enriched = entries.map((e) => ({
      ...e,
      actorName: e.actorId === "system" ? "System" : nameById.get(String(e.actorId)) ?? String(e.actorId),
    }));
    return { entries: enriched };
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

  // Empty import template (one header row of the entity's writable fields), as a
  // real .xlsx workbook (default) or CSV — the file users fill and re-import.
  r.get("/import/:entity/template", runApi(async (rc, req, res) => {
    assertSettings(rc, "settings.import", "execute");
    assertKnownEntity(req.params.entity);
    const format = String(req.query.format ?? "xlsx").toLowerCase() === "csv" ? "csv" : "xlsx";
    const { buffer, contentType, ext } = await buildImportTemplate(req.params.entity, metadata, format);
    setApiHeaders(res, rc.correlationId);
    res.setHeader("content-type", contentType);
    res.setHeader("content-disposition", `attachment; filename="${req.params.entity}-template.${ext}"`);
    res.status(200).send(buffer);
  }));

  // Render a report (sent pre-localized by the client) to a styled Excel workbook.
  // PDF export is the browser's print-to-PDF on the client (full Unicode + theme).
  r.post(
    "/reports/export",
    runApi(async (rc, req, res) => {
      const body = readJson(req) as { payload?: ReportPayload; fileName?: string };
      if (!body.payload || !Array.isArray(body.payload.sections)) throw new BadRequestError("payload is required");
      const fileName = String(body.fileName || "report").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "report";
      const buf = await renderReportXlsx(body.payload);
      setApiHeaders(res, rc.correlationId);
      res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("content-disposition", `attachment; filename="${fileName}.xlsx"`);
      res.status(200).send(buf);
    }),
  );

  r.post(
    "/import/:entity",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.import", "execute");
        assertKnownEntity(req.params.entity);
        const body = readJson(req) as { csv?: string; xlsx?: string; aliases?: Record<string, string> };
        const domain = await getDomainService();
        // Accept either a CSV string or a base64 .xlsx workbook; `aliases` maps the
        // user's (localized) column headers back to field names.
        if (body.xlsx) return importXlsx(rc, req.params.entity, body.xlsx, metadata, domain, body.aliases);
        return importCsv(rc, req.params.entity, body.csv ?? "", metadata, domain, body.aliases);
      },
      { mutating: true },
    ),
  );

  // Background import: parse the file (fail fast on corrupt uploads), register a
  // job and return its id immediately. Large imports (20k+ rows) must not block
  // the request/response — a proxy/DB timeout would abort them mid-write — so the
  // rows are processed in the background and the client polls the GET below.
  r.post(
    "/import/:entity/job",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.import", "execute");
        assertKnownEntity(req.params.entity);
        const body = readJson(req) as { csv?: string; xlsx?: string; aliases?: Record<string, string> };
        const domain = await getDomainService();
        const rows = await parseImportFile(body);
        const job = startImportJob(rc, req.params.entity, rows, metadata, domain, body.aliases);
        return toView(job);
      },
      { mutating: true, status: 202 },
    ),
  );

  // Poll an import job's progress / final result (scoped to the caller's tenant).
  r.get(
    "/import/:entity/job/:id",
    runApi(async (rc, req) => {
      assertKnownEntity(req.params.entity);
      const job = getImportJob(rc, req.params.id);
      if (!job) throw new NotFoundError("import job", req.params.id);
      return toView(job);
    }),
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
    const res = await pur.getPO(rc, req.params.id);
    // Resolve the approver's name server-side (the user table isn't readable by
    // non-admins, but the approver/manager must see who a PO is routed to).
    let approverName: string | null = null;
    if (res.doc.approverId) {
      try {
        const u = await (await getDomainService()).get(systemContext(rc.tenantId, rc.orgId), "user", String(res.doc.approverId));
        approverName = String(u.displayName ?? u.email ?? res.doc.approverId);
      } catch {
        approverName = null;
      }
    }
    return { ...res, approverName };
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

  // Submit a PO for approval (routes to the creator's supervisor; auto-approves
  // when the creator has none). Needs update rights on the PO.
  r.post(
    "/purchase-orders/:id/submit",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "purchaseOrder", action: "purchaseOrder:update" })) {
          throw new ForbiddenError("not allowed to submit purchase orders");
        }
        const pur = await getPurchasingService();
        return { purchaseOrder: await pur.submitPO(rc, req.params.id) };
      },
      { mutating: true },
    ),
  );

  // Approve / reject a pending PO — the service enforces that only the routed
  // approver (or an admin) may decide.
  r.post(
    "/purchase-orders/:id/approve",
    runApi(
      async (rc, req) => {
        const pur = await getPurchasingService();
        return { purchaseOrder: await pur.decidePO(rc, req.params.id, "approve") };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/purchase-orders/:id/reject",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { reason?: string | null };
        const pur = await getPurchasingService();
        return { purchaseOrder: await pur.decidePO(rc, req.params.id, "reject", body.reason ?? null) };
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

  // ---- inventory: per-location on-hand levels (stock-levels screen) -----
  // Joins the derived on-hand/value (by product+warehouse) with product,
  // warehouse and branch names + reorder thresholds. Optional filters:
  // ?branchId= ?warehouseId= ?lowStock=true.
  r.get("/inventory/on-hand", runApi(async (rc, req) => {
    const inventory = await getInventoryService();
    const domain = await getDomainService();
    const [rows, products, warehouses, branches] = await Promise.all([
      inventory.onHandByKey(rc),
      domain.list(rc, "product", { pageSize: 1000 }),
      domain.list(rc, "warehouse", { pageSize: 500 }),
      domain.list(rc, "branch", { pageSize: 500 }),
    ]);
    const pById = new Map(products.items.map((p) => [String(p.id), p]));
    const wById = new Map(warehouses.items.map((w) => [String(w.id), w]));
    const bById = new Map(branches.items.map((b) => [String(b.id), b]));

    const branchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;
    const warehouseId = typeof req.query.warehouseId === "string" ? req.query.warehouseId : undefined;
    const lowOnly = req.query.lowStock === "true" || req.query.lowStock === "1";

    const out = rows
      .map((row) => {
        const product = pById.get(row.productId);
        const warehouse = wById.get(row.warehouseId);
        const wBranchId = warehouse ? String(warehouse.branchId ?? "") : "";
        const reorderLevel = Number(product?.reorderLevel ?? 0);
        return {
          productId: row.productId,
          productName: product ? String(product.name) : row.productId,
          sku: product ? String(product.sku ?? "") : "",
          barcode: product ? String(product.barcode ?? "") : "",
          warehouseId: row.warehouseId,
          warehouseName: warehouse ? String(warehouse.name) : row.warehouseId,
          branchId: wBranchId || null,
          branchName: wBranchId ? String(bById.get(wBranchId)?.name ?? "") : "",
          onHand: row.onHand,
          value: row.value,
          reorderLevel,
          low: reorderLevel > 0 && row.onHand <= reorderLevel,
        };
      })
      .filter((row) => {
        if (warehouseId && row.warehouseId !== warehouseId) return false;
        if (branchId && row.branchId !== branchId) return false;
        if (lowOnly && !row.low) return false;
        return true;
      });
    return { rows: out };
  }));

  // ---- point of sale ---------------------------------------------------
  // Barcode/SKU lookup, till sessions, and the checkout that rings a sale
  // through the invoice → send → pay pipeline (stock issued from warehouseId).
  r.get("/pos/lookup", runApi(async (rc, req) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) throw new BadRequestError("code is required");
    const pos = await getPosService();
    const product = await pos.lookup(rc, code);
    if (!product) throw new NotFoundError(`no product for code "${code}"`);
    return { product };
  }));

  r.get("/pos/session", runApi(async (rc) => {
    const pos = await getPosService();
    return { session: await pos.currentSession(rc) };
  }));

  r.post(
    "/pos/session/open",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { branchId?: string | null; warehouseId?: string | null; openingFloat?: number };
        const pos = await getPosService();
        return { session: await pos.openSession(rc, body) };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/pos/session/close",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { sessionId?: string; countedCash?: number };
        if (!body.sessionId) throw new BadRequestError("sessionId is required");
        const pos = await getPosService();
        return { session: await pos.closeSession(rc, body.sessionId, Number(body.countedCash ?? 0)) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/pos/checkout",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "pos", action: "pos:checkout" })) {
          throw new ForbiddenError("not allowed to check out POS sales");
        }
        const body = readJson(req) as PosCheckoutInput;
        const idempotencyKey = req.get("Idempotency-Key") || body.idempotencyKey || null;
        const pos = await getPosService();
        return pos.checkout(rc, { ...body, idempotencyKey });
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- sales cart (Sepet) ----------------------------------------------
  // A persisted basket (cart + cartLine). Checkout rings it through the POS
  // pipeline (invoice → send: posts AR/Revenue/COGS + issues stock), so the cart
  // never duplicates GL/stock logic. Drafts can be saved and resumed.
  r.get("/carts", runApi(async (rc) => {
    const domain = await getDomainService();
    const page = await domain.list(rc, "cart", {
      filters: [{ field: "status", op: "eq", value: "open" }],
      sort: [{ field: "createdAt", dir: "desc" }],
      pageSize: 50,
    });
    return { items: page.items };
  }));

  r.get("/carts/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "cart", "cartLine", "cartId", req.params.id);
  }));

  r.post(
    "/carts",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const body = readJson(req) as {
          accountId?: string | null;
          branchId?: string | null;
          warehouseId?: string | null;
          currencyCode?: string;
          notes?: string | null;
          lines?: LineInput[];
        };
        const doc = await fin.createDocument(rc, "cart", "CART", {
          accountId: body.accountId ?? null,
          branchId: body.branchId ?? null,
          warehouseId: body.warehouseId ?? null,
          currencyCode: body.currencyCode ?? "USD",
          status: "open",
          notes: body.notes ?? null,
        });
        if (body.lines?.length) await fin.replaceLines(rc, "cart", "cartLine", "cartId", doc.id, body.lines);
        return fin.getDocument(rc, "cart", "cartLine", "cartId", doc.id);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.put(
    "/carts/:id",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const body = readJson(req) as { header?: Record<string, unknown>; lines?: LineInput[] };
        return fin.saveDocument(rc, "cart", "cartLine", "cartId", req.params.id, body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/carts/:id",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const domain = await getDomainService();
        const { lines } = await fin.getDocument(rc, "cart", "cartLine", "cartId", req.params.id);
        for (const l of lines) await domain.remove(rc, "cartLine", String(l.id));
        await domain.remove(rc, "cart", req.params.id);
        return { ok: true };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/carts/:id/checkout",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "pos", action: "pos:checkout" })) {
          throw new ForbiddenError("not allowed to check out sales");
        }
        const fin = await getFinanceService();
        const pos = await getPosService();
        const domain = await getDomainService();
        const body = readJson(req) as { payments?: { method: string; amount: number }[] };
        const { doc: cart, lines } = await fin.getDocument(rc, "cart", "cartLine", "cartId", req.params.id);
        if (cart.status === "converted") throw new BadRequestError("cart already checked out");
        if (!lines.length) throw new BadRequestError("cart is empty");
        const result = await pos.checkout(rc, {
          idempotencyKey: req.get("Idempotency-Key") || `cart:${req.params.id}`,
          branchId: (cart.branchId as string) ?? null,
          warehouseId: (cart.warehouseId as string) ?? null,
          accountId: (cart.accountId as string) ?? null,
          currencyCode: String(cart.currencyCode ?? "USD"),
          lines: lines.map((l) => ({
            productId: (l.productId as string) ?? null,
            description: String(l.description ?? ""),
            qty: Number(l.qty ?? 0),
            unitPrice: Number(l.unitPrice ?? 0),
            taxRate: Number(l.taxRate ?? 0),
          })),
          payments: body.payments ?? [],
        });
        await domain.update(rc, "cart", req.params.id, { status: "converted", convertedInvoiceId: result.invoice.id });
        return { invoice: result.invoice, total: result.total, change: result.change };
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- sales returns (İadeler) -----------------------------------------
  // A return document (salesReturn + salesReturnLine). Posting restocks the
  // returned goods (a receipt movement per line, refType `salesReturn`).
  r.get("/sales-returns", runApi(async (rc) => {
    const domain = await getDomainService();
    const page = await domain.list(rc, "salesReturn", { sort: [{ field: "createdAt", dir: "desc" }], pageSize: 100 });
    return { items: page.items };
  }));

  r.get("/sales-returns/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "salesReturn", "salesReturnLine", "salesReturnId", req.params.id);
  }));

  r.post(
    "/sales-returns",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const body = readJson(req) as {
          accountId?: string | null;
          invoiceId?: string | null;
          warehouseId?: string | null;
          branchId?: string | null;
          currencyCode?: string;
          returnDate?: string | null;
          reason?: string | null;
          notes?: string | null;
          lines?: LineInput[];
        };
        // Idempotent: a double-submit with the same key won't create two returns.
        return withIdempotency(req.get("Idempotency-Key"), async () => {
          const doc = await fin.createDocument(rc, "salesReturn", "RET", {
            accountId: body.accountId ?? null,
            invoiceId: body.invoiceId ?? null,
            warehouseId: body.warehouseId ?? null,
            branchId: body.branchId ?? null,
            currencyCode: body.currencyCode ?? "USD",
            returnDate: body.returnDate ?? rc.at.slice(0, 10),
            reason: body.reason ?? null,
            status: "draft",
            notes: body.notes ?? null,
          });
          if (body.lines?.length) await fin.replaceLines(rc, "salesReturn", "salesReturnLine", "salesReturnId", doc.id, body.lines);
          return fin.getDocument(rc, "salesReturn", "salesReturnLine", "salesReturnId", doc.id);
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/sales-returns/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "salesReturn", action: "salesReturn:post" })) {
          throw new ForbiddenError("not allowed to post sales returns");
        }
        const fin = await getFinanceService();
        const inventory = await getInventoryService();
        const domain = await getDomainService();
        const { doc, lines } = await fin.getDocument(rc, "salesReturn", "salesReturnLine", "salesReturnId", req.params.id);
        if (doc.status === "posted") return { salesReturn: doc };
        const warehouseId = (doc.warehouseId as string) ?? null;
        if (!warehouseId) throw new BadRequestError("a warehouse is required to restock a return");
        for (const l of lines) {
          const qty = Number(l.qty ?? 0);
          if (!l.productId || qty <= 0) continue;
          await inventory.writeMovement(rc, {
            productId: String(l.productId),
            warehouseId,
            qty,
            type: "receipt",
            unitCost: Number(l.unitPrice ?? 0),
            ref: req.params.id,
            refType: "salesReturn",
            branchId: (doc.branchId as string) ?? null,
          });
        }
        const updated = await domain.update(rc, "salesReturn", req.params.id, { status: "posted" });
        return { salesReturn: updated };
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
        // Re-attempt any GL/stock postings that previously failed (idempotent).
        const postings = await retryFailedPostings();
        if (postings.retried > 0) {
          results.push({ name: "posting-retry", at: rc.at, ok: postings.dead === 0, summary: `${postings.recovered} recovered, ${postings.remaining} pending, ${postings.dead} dead` });
        }
        // Also fire any active schedule-triggered automations (force: a manual /
        // external tick runs them all now, regardless of per-rule cadence).
        const automations = await runScheduledAutomations(systemContext(rc.tenantId, rc.orgId), { force: true });
        if (automations.length) {
          const ok = automations.filter((a) => a.status === "success").length;
          results.push({ name: "automations", at: rc.at, ok: true, summary: `${ok}/${automations.length} scheduled automation(s) ran` });
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

  // Run a rule on demand. Default is a REAL run (performs the actions) against
  // the most recent record of the trigger entity (so {{record.field}} resolves to
  // real data); pass `{ test: true }` for a side-effect-free dry run, or
  // `{ recordId }` / `{ sample }` to target a specific/synthetic record.
  r.post(
    "/automations/:id/run",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const rule = await automationStore.getRule(rc.tenantId, rc.orgId, req.params.id);
        if (!rule) throw new NotFoundError("automation", req.params.id);
        const body = readJson(req) as { recordId?: string; sample?: Record<string, unknown>; test?: boolean };
        const isTest = body.test === true;
        const domain = await getDomainService();
        let record: Record<string, unknown> = body.sample ?? {};
        if (body.recordId && rule.trigger.entity) {
          try {
            record = await domain.get(rc, rule.trigger.entity, body.recordId);
          } catch {
            /* fall back to whatever sample was provided */
          }
        } else if (rule.trigger.entity && Object.keys(record).length === 0) {
          // No explicit record → run against a recent record of the trigger
          // entity so the rule executes with real data. Prefer the newest record
          // that actually populates the message-recipient field(s) (so a
          // {{record.email}} send has a deliverable address), else the newest.
          // `createdAt` isn't a declared sortable field, so order in JS rather
          // than relying on the query engine's sort.
          try {
            const page = await domain.list(rc, rule.trigger.entity, { pageSize: 50 });
            const items = [...page.items].sort((a, b) =>
              String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
            const refs = emailRecipientFields(rule);
            const usable = refs.length
              ? items.find((r) => refs.every((f) => r[f] != null && String(r[f]).trim() !== ""))
              : undefined;
            const chosen = usable ?? items[0];
            if (chosen) record = chosen;
          } catch {
            /* entity not readable / empty — fall through to the placeholder */
          }
        }
        // No fabricated placeholder. When nothing resolved, run with an explicit
        // empty record so the engine reports hasRecord=false and SKIPS
        // record-dependent actions with a clear reason — instead of interpolating
        // a fake {id:"manual", name:"Manual run"} into a notify/email.
        const run = await executeRule(rule, systemContext(rc.tenantId, rc.orgId), record, {
          test: isTest,
          trigger: isTest ? "manual test" : "manual run",
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

  // Live activity: which rules are running right now + the most recent completed
  // runs — polled by the Automations screen for "what's running" indicators.
  r.get("/automation/live", runApi(async (rc) => {
    adminOnly(rc);
    return getLiveActivity(rc.tenantId, rc.orgId);
  }));

  // Run now: queue every active schedule-triggered automation, then drain the
  // whole queue to completion (so multiple automations are processed in order).
  r.post(
    "/automation/run-now",
    runApi(
      async (rc) => {
        adminOnly(rc);
        const ctx = systemContext(rc.tenantId, rc.orgId);
        const queued = await enqueueScheduled(ctx, { force: true });
        const result = await processQueue(ctx);
        return { queued: queued.length, ...result };
      },
      { mutating: true },
    ),
  );

  // Processing queue (pending / retry / dead-letter).
  r.get("/automation/queue", runApi(async (rc) => {
    adminOnly(rc);
    return { items: await automationStore.listQueue(rc.tenantId, rc.orgId) };
  }));

  // Drain the queue to completion (pending + due-retry items run until clear).
  r.post(
    "/automation/queue/process",
    runApi(
      async (rc) => {
        adminOnly(rc);
        return processQueue(systemContext(rc.tenantId, rc.orgId));
      },
      { mutating: true },
    ),
  );

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
          fromQueue: true,
        });
        if (run.status === "success" || run.status === "skipped") {
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
        const isBlank = (key: string) => {
          const v = state.config[key];
          return v === undefined || v === null || String(v).trim() === "";
        };
        if (!state.enabled) {
          return { ok: false, message: "Integration is disabled — enable it to connect." };
        }
        // Only validate the fields the chosen provider actually uses (each field's
        // `showWhen` is evaluated against the saved config).
        const activeFields = def.fields.filter((f) => fieldApplies(f, state.config));
        // Every active field flagged `required` must be present…
        const missing = activeFields.filter((f) => f.required && isBlank(f.key)).map((f) => f.label);
        // …and each `requireOneOf` group needs at least one of its active fields.
        const oneOfMissing = (def.requireOneOf ?? [])
          .map((grp) => grp.filter((k) => activeFields.some((f) => f.key === k)))
          .filter((grp) => grp.length > 0 && grp.every(isBlank))
          .map((grp) => grp.map((k) => def.fields.find((f) => f.key === k)?.label ?? k).join(" / "));
        if (missing.length || oneOfMissing.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`Missing required: ${missing.join(", ")}`);
          if (oneOfMissing.length) parts.push(`Provide at least one of: ${oneOfMissing.join("; ")}`);
          return { ok: false, message: parts.join(" · ") };
        }
        // Live check: actually exercise the connection so the admin gets real
        // confirmation, not just "settings look complete".
        const scope = { tenantId: rc.tenantId, orgId: rc.orgId };
        const testTo = String((readJson(req) as { to?: string }).to ?? "").trim();
        if (provider === "sms" && testTo) {
          const res = await sendSms(scope, testTo, "Aula CRM — SMS gateway test ✓");
          return res.ok
            ? { ok: true, message: `Test SMS sent to ${testTo}${res.id ? ` (${res.id})` : ""}` }
            : { ok: false, message: `Test SMS failed: ${res.error ?? "unknown error"}` };
        }
        if (provider === "whatsapp" && testTo) {
          const res = await sendWhatsApp(scope, testTo, "Aula CRM — WhatsApp test ✓");
          return res.ok
            ? { ok: true, message: `Test WhatsApp sent to ${testTo}${res.id ? ` (${res.id})` : ""}` }
            : { ok: false, message: `Test WhatsApp failed: ${res.error ?? "unknown error"}` };
        }
        if (provider === "slack") {
          const res = await sendSlack(scope, "Aula CRM — Slack integration test ✓");
          return res.ok
            ? { ok: true, message: "Test message posted to Slack" }
            : { ok: false, message: `Slack test failed: ${res.error ?? "unknown error"}` };
        }
        if (provider === "rest") {
          const res = await restTestConnection(scope);
          return res.ok
            ? { ok: true, message: `REST endpoint reachable (HTTP ${res.status ?? "200"})` }
            : { ok: false, message: `REST test failed: ${res.error ?? "unknown error"}${res.status ? ` (HTTP ${res.status})` : ""}` };
        }
        if (provider === "erp") {
          const res = await erpTestConnection(scope);
          return res.ok
            ? { ok: true, message: `ERP reachable${res.status ? ` (HTTP ${res.status})` : ""}${res.error ? ` — ${res.error}` : ""}` }
            : { ok: false, message: `ERP test failed: ${res.error ?? "unknown error"}` };
        }
        const filled = activeFields.filter((f) => !isBlank(f.key)).length;
        return {
          ok: true,
          message: `All required settings present — ${filled} field(s) configured, connection looks ready.`,
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

  // ---- notifications (per-user inbox) -----------------------------------
  r.get("/notifications", runApi(async (rc) => {
    // Hide categories the user muted (also covers broadcasts, which can't be gated at delivery).
    const isMuted = await buildInAppMuteFilter(rc.tenantId, rc.orgId, rc.userId);
    return {
      items: notifications.list(rc.tenantId, rc.orgId, rc.userId, isMuted),
      unread: notifications.unreadCount(rc.tenantId, rc.orgId, rc.userId, isMuted),
    };
  }));

  r.post(
    "/notifications",
    runApi(
      async (rc) => {
        notifications.markAllRead(rc.tenantId, rc.orgId, rc.userId);
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
        const removed = notifications.remove(rc.tenantId, rc.orgId, rc.userId, ids);
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
        assertSettings(rc, "settings.metadata", "publish");
        const published = publishMetadata(rc, metadata.version, "re-published from settings");
        return { version: published.version, publishedAt: published.publishedAt, publishedBy: published.publishedBy };
      },
      { mutating: true },
    ),
  );

  r.get("/admin/releases", runApi(async (rc) => {
    assertSettings(rc, "settings.releases", "read");
    // Real applied schema versions from the `_schema_migrations` ledger (empty in
    // memory mode, which has no physical schema).
    const migrations = usingInMemoryBackends ? [] : await schemaStatus().catch(() => []);
    return { releases: releaseLog.list(), migrations };
  }));

  // ---- files: real upload / download (local-disk storage) ----------------
  r.post(
    "/files/upload",
    runApi(
      async (rc, req) => {
        const { buffer, filename, folder, mimeType } = await new Promise<{
          buffer: Buffer;
          filename: string;
          folder: string;
          mimeType: string;
        }>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let filename = "upload";
          let folder = "documents";
          let mimeType = "";
          let tooBig = false;
          const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
          bb.on("file", (_name, stream, info) => {
            if (info.filename) filename = info.filename;
            if (info.mimeType) mimeType = info.mimeType;
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
              : resolve({ buffer: Buffer.concat(chunks), filename, folder, mimeType }),
          );
          bb.on("error", reject);
          req.pipe(bb);
        });

        if (!buffer.length) throw new BadRequestError("no file uploaded");
        const domain = await getDomainService();
        // Captured content-type → served verbatim on download (no guessing); fall
        // back to the filename guess so older clients without a type still work.
        const resolvedMime = mimeType.trim() || guessFileContentType(filename);
        // Reject script/markup uploads that could execute as stored-XSS if served.
        if (BLOCKED_UPLOAD_MIME.has(resolvedMime.toLowerCase().split(";")[0].trim())) {
          throw new BadRequestError(`file type "${resolvedMime}" is not allowed`);
        }
        const record = await domain.create(rc, "file", {
          name: filename,
          folder,
          sizeKb: Math.max(1, Math.round(buffer.length / 1024)),
          mimeType: resolvedMime,
          owner: rc.displayName,
        });
        try {
          await saveBlob(record.id, buffer, resolvedMime); // bytes keyed by the record id (durable store)
        } catch (e) {
          // Atomicity: never leave a metadata row whose bytes failed to persist.
          await domain.remove(rc, "file", record.id).catch(() => {});
          throw e;
        }
        // Make the blob↔record link explicit + portable (was implicit id==filename).
        return domain.update(rc, "file", record.id, { storageKey: `db:${record.id}` });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/files/:id/download", runApi(async (rc, req, res) => {
    const domain = await getDomainService();
    const record = await domain.get(rc, "file", req.params.id); // enforces read + tenant scope
    const blob = await readBlob(req.params.id);
    if (!blob) throw new NotFoundError("file", req.params.id);
    const name = String(record.name);
    // `?inline=1` serves with the real content-type + inline disposition so chat
    // image attachments render in <img>; the default stays a forced download.
    // Prefer the stored mimeType (row → blob), falling back to a filename guess.
    const contentType =
      (typeof record.mimeType === "string" && record.mimeType.trim()) || blob.mimeType || guessFileContentType(name);
    // Only render inline when both requested AND the type is on the safe list;
    // anything else is forced to download so it can't execute in the page context.
    const inline =
      (req.query.inline === "1" || req.query.inline === "true") &&
      INLINE_SAFE_MIME.has(contentType.toLowerCase().split(";")[0].trim());
    setApiHeaders(res, rc.correlationId);
    res.setHeader("content-type", inline ? contentType : "application/octet-stream");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-length", blob.data.length);
    res.setHeader("content-disposition", `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(name)}"`);
    res.end(blob.data);
  }));

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
        if (recipients.length > 100) throw new BadRequestError("too many recipients (max 100)");
        if ((body.subject ?? "").length > 512) throw new BadRequestError("subject too long (max 512)");
        if ((body.body ?? "").length > 100_000) throw new BadRequestError("body too long (max 100KB)");
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
          // A synced mailbox is personal to its owner; honour the `new_email` pref.
          await notifyUser({
            at: new Date().toISOString(),
            tenantId: rc.tenantId,
            orgId: rc.orgId,
            userId: rc.userId,
            channel: "email",
            subject: m.subject || "(no subject)",
            body: `New email from ${m.sender}`,
            eventType: "email.received",
            prefKey: "new_email",
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
        folderId: e.folderId ?? null,
        starred: Boolean(e.starred),
        // Needed so the client can target IMAP deletes for synced inbox messages.
        messageId: e.messageId ?? "",
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

  // Delete a custom mail folder. Its messages are first reassigned back to their
  // base system folder (folderId cleared) so nothing is orphaned, then the folder
  // row is removed. (Folder create/rename/list use generic /entities/emailFolder.)
  r.delete(
    "/email/folders/:id",
    runApi(
      async (rc, req) => {
        const id = String(req.params.id);
        const domain = await getDomainService();
        let reassigned = 0;
        // Clear folderId on this folder's messages in bulk (one UPDATE per page);
        // reassigned rows drop out of the filter, so always re-read the first page.
        for (;;) {
          const msgs = await domain.list(rc, "email", {
            filters: [{ field: "folderId", op: "eq", value: id }],
            pageSize: 250,
            page: 1,
          });
          if (msgs.items.length === 0) break;
          reassigned += await domain.updateMany(rc, "email", msgs.items.map((m) => String(m.id)), { folderId: null });
        }
        await domain.remove(rc, "emailFolder", id);
        return { ok: true, reassigned };
      },
      { mutating: true },
    ),
  );

  // ---- bulk mailbox ops (one request for the whole selection; the UI chunks at
  //      250 so 1000s of messages move/delete without 1000s of round trips) -----

  // Move many messages to a system folder (folder + clear folderId) or a custom
  // folder (set folderId) — ONE bulk UPDATE. Organizational only (no IMAP).
  r.post(
    "/email/move",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { ids?: string[]; folder?: string; folderId?: string | null };
        const ids = (body.ids ?? []).map(String);
        const patch: Record<string, unknown> = {};
        if (typeof body.folder === "string") patch.folder = body.folder;
        if ("folderId" in body) patch.folderId = body.folderId ?? null;
        const domain = await getDomainService();
        const updated = await domain.updateMany(rc, "email", ids, patch);
        return { updated };
      },
      { mutating: true },
    ),
  );

  // Move many messages to Trash (folder → "trash", folderId cleared) in ONE bulk
  // UPDATE, then remove them from the IMAP server (Gmail) by the client-supplied
  // message-ids when configured.
  r.post(
    "/email/trash",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { ids?: string[]; messageIds?: string[] };
        const ids = (body.ids ?? []).map(String);
        const domain = await getDomainService();
        const updated = await domain.updateMany(rc, "email", ids, { folder: "trash", folderId: null });
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const serverDeleted = emailCfg.imapConfigured
          ? await deleteOnServer(body.messageIds ?? [], { tenantId: rc.tenantId, orgId: rc.orgId })
          : 0;
        return { updated, serverDeleted, configured: emailCfg.imapConfigured };
      },
      { mutating: true },
    ),
  );

  // Permanently delete many messages — ONE bulk DELETE + IMAP delete.
  r.post(
    "/email/purge",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as { ids?: string[]; messageIds?: string[] };
        const ids = (body.ids ?? []).map(String);
        const domain = await getDomainService();
        const deleted = await domain.removeMany(rc, "email", ids);
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const serverDeleted = emailCfg.imapConfigured
          ? await deleteOnServer(body.messageIds ?? [], { tenantId: rc.tenantId, orgId: rc.orgId })
          : 0;
        return { deleted, serverDeleted, configured: emailCfg.imapConfigured };
      },
      { mutating: true },
    ),
  );

  // Restore many messages from Trash to their original folder (grouped bulk
  // UPDATEs, since targets may differ) + move them back on the IMAP server.
  r.post(
    "/email/restore",
    runApi(
      async (rc, req) => {
        const body = readJson(req) as {
          items?: { id: string; folder?: string; folderId?: string | null }[];
          messageIds?: string[];
        };
        const incoming = body.items ?? [];
        const domain = await getDomainService();
        // Group ids by identical (folder, folderId) target so each group is one UPDATE.
        const groups = new Map<string, { folder?: string; folderId: string | null; ids: string[] }>();
        for (const it of incoming) {
          const folder = typeof it.folder === "string" ? it.folder : undefined;
          const folderId = it.folderId ?? null;
          const key = `${folder ?? ""}|${folderId ?? ""}`;
          const g = groups.get(key) ?? { folder, folderId, ids: [] };
          g.ids.push(String(it.id));
          groups.set(key, g);
        }
        let updated = 0;
        for (const g of groups.values()) {
          const patch: Record<string, unknown> = { folderId: g.folderId };
          if (g.folder) patch.folder = g.folder;
          updated += await domain.updateMany(rc, "email", g.ids, patch);
        }
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const serverRestored = emailCfg.imapConfigured
          ? await restoreOnServer(body.messageIds ?? [], { tenantId: rc.tenantId, orgId: rc.orgId })
          : 0;
        return { updated, serverRestored };
      },
      { mutating: true },
    ),
  );

  // ---- health (public, no auth) ----------------------------------------
  r.get("/health", (_req: Request, res: Response) => {
    setApiHeaders(res);
    res.json({
      status: "ok",
      metadataVersion: metadata.version,
      backends: usingInMemoryBackends ? "in-memory" : "external",
      inflight: getInflight(),
      metrics: metrics.snapshot(),
    });
  });

  return r;
}
