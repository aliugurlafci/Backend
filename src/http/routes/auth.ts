/**
 * Authentication, the caller's own profile/settings/password, and two-factor enrolment.
 */

import { type Router } from "express";
import { type Request, type Response } from "express";
import { runApi, setApiHeaders, toHeaders } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { grantsFor } from "@/lib/permissions/policies";
import { metadata } from "@/lib/metadata";
import {
  changePasswordSchema,
  parseBody,
  passwordConfirmSchema,
  profileSchema,
  totpCodeSchema,
  userSettingsSchema,
} from "@/lib/http/body";
import { isProduction, env } from "@/lib/config/env";
import { bumpTokenEpoch, claimTokenForRotation, revokeToken } from "@/lib/security/revocation";
import { BadRequestError, ForbiddenError, UnauthenticatedError, toAppError } from "@/lib/enforcement/errors";
import { localizeAppError, localizedErrorBody } from "@/lib/i18n/errors";
import {
  login,
  getPosition,
  parseScreens,
  findUserById,
  mintSession,
  recordSecurityEvent,
} from "@/lib/security/auth-service";
import {
  randomBase32Secret,
  totpUri,
  totpVerify,
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/security/crypto";
import { SESSION_COOKIE } from "@/lib/security/auth";
import { rateLimit, peekRateLimit, clearRateLimit } from "@/lib/security/rate-limit";
import { resolveContext, systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { screenCatalog } from "@/lib/config/screens";
import { areaForUserSettingKey } from "@/lib/config/settings-permissions";
import { resolveMobileConfig } from "@/lib/mobile/service";
import { assertPasswordStrength, assertSettings, stripHash } from "./shared";

/** Cookie options for the session JWT. `strict` blocks the cookie on cross-site
 *  requests (CSRF defence-in-depth alongside the double-submit token). */
function sessionCookieOpts(ttlSec: number) {
  return { httpOnly: true, sameSite: "strict" as const, path: "/", maxAge: ttlSec * 1000, secure: isProduction };
}

/**
 * Client IP, for the security activity log and the login throttle.
 *
 * Reads `req.ip` and NOT the raw `X-Forwarded-For` header. Express derives
 * `req.ip` under the configured `trust proxy` policy, so it stops at the last
 * hop we actually trust. Parsing the header directly — which this used to do,
 * preferring it over `req.ip` — took whatever the caller wrote, so rotating one
 * header value produced a fresh `login:ip:` bucket on every attempt and the
 * brute-force cap counted to one forever.
 */
function clientIp(req: Request): string | null {
  return (req.ip || req.socket?.remoteAddress || "").trim() || null;
}

export function registerAuthRoutes(r: Router): void {
  // ---- auth -------------------------------------------------------------
  // Credential login (email + password). Sets an httpOnly session cookie.
  r.post("/auth/login", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { email?: string; password?: string; code?: string };
      // Throttle brute-force: cap attempts per source IP (per minute) and lock an
      // email after repeated failures (15-min window). Cleared on a successful login.
      const ip = clientIp(req) ?? "unknown";
      const ipRl = rateLimit(`login:ip:${ip}`, 30, 60_000);
      if (!ipRl.allowed) {
        res.set("Retry-After", String(ipRl.retryAfter));
        res.status(429).json(localizedErrorBody(req, "RATE_LIMITED", "too many login attempts; try again later"));
        return;
      }
      const emailKey = `login:fail:${(body.email ?? "").toLowerCase()}`;
      if (body.email) {
        const lock = peekRateLimit(emailKey, 8);
        if (!lock.allowed) {
          res.set("Retry-After", String(lock.retryAfter));
          res.status(429).json(localizedErrorBody(req, "RATE_LIMITED", "account temporarily locked after too many failed attempts"));
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
          res.status(401).json(localizedErrorBody(req, "UNAUTHENTICATED", "invalid authentication code"));
          return;
        }
        if (outcome.status === "invalid") {
          rateLimit(emailKey, 8, 15 * 60_000); // count the failed credential attempt
          res.status(401).json(localizedErrorBody(req, "UNAUTHENTICATED", "invalid email or password"));
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
      res.status(400).json(localizedErrorBody(req, "BAD_REQUEST", "email and password are required"));
    } catch (error) {
      const appError = toAppError(error);
      setApiHeaders(res);
      res.status(appError.httpStatus).json(localizeAppError(appError, req));
    }
  });

  // Clear the session.
  /**
   * Sign out of THIS session.
   *
   * Clearing the cookie is not signing out: a bearer token taken from the same
   * login keeps working for its full lifetime, and clearing a cookie the caller
   * already has does nothing about that. The token is added to the denylist so
   * it stops being accepted — which is what a person pressing "sign out"
   * believes is happening.
   *
   * Not wrapped in `runApi`: a caller whose token is ALREADY revoked must still
   * get a clean sign-out rather than a 401, and the revocation check in `runApi`
   * would refuse them.
   */
  r.post("/auth/logout", async (req: Request, res: Response) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    try {
      const ctx = resolveContext(toHeaders(req));
      if (ctx.jti) {
        // Remember it only until it would have expired anyway — after that its
        // own `exp` refuses it and the row is pure cost.
        const expiresAt = new Date(Date.now() + env.AULA_JWT_TTL * 1000).toISOString();
        await revokeToken(ctx, ctx.jti, expiresAt, "logout");
      }
    } catch {
      // No usable token — there is nothing to withdraw, and "sign out" should
      // still succeed. Signing out must never be the request that fails.
    }
    setApiHeaders(res);
    res.json({ ok: true });
  });

  /**
   * Exchange a valid session for a fresh one.
   *
   * Without this, a token simply stopped working mid-shift. The mobile till
   * read `expiresIn` at login and did nothing with it, so the first request
   * after the deadline came back 401 and surfaced as a generic error — a
   * cashier halfway through a basket, with no prompt explaining what happened
   * and no way back except finding the sign-in screen.
   *
   * ROTATES rather than extends. The old `jti` goes on the denylist and a new
   * token is minted with a new one, so a token captured earlier stops working
   * the moment its session moves on. Extending an existing token's lifetime
   * would mean one stolen string stays valid for as long as the session does.
   *
   * Claims are rebuilt from the user's CURRENT position, not copied from the
   * expiring token — which is what makes this the answer to permissions being
   * baked in at login. A role change now takes effect at the next refresh
   * instead of waiting out the token's full lifetime.
   *
   * `runApi` guards it, so a revoked or epoch-stale token is refused here just
   * as it is everywhere else: refresh is a way to stay signed in, never a way
   * back in.
   */
  r.post(
    "/auth/refresh",
    runApi(
      async (rc, _req, res) => {
        // Claimed BEFORE the first await, so concurrent renewals of one token
        // cannot each mint a session — see `claimTokenForRotation`. A phone
        // foregrounding fires several requests at once, and without this the
        // last to finish held the only usable token while the others were
        // handed one that had just been revoked.
        if (!rc.jti || !claimTokenForRotation(rc.jti)) {
          throw new UnauthenticatedError("this session has already been renewed");
        }

        const user = await findUserById(rc.userId);
        // Deactivated between issue and refresh — the session ends here rather
        // than being renewed for someone who has been switched off.
        if (!user || user.active === false) {
          throw new ForbiddenError("this account can no longer sign in");
        }

        const session = await mintSession(user);

        // Persist the claim taken above. The in-memory entry already stopped
        // the old token; this is what stops a restart from resurrecting it.
        const expiresAt = new Date(Date.now() + env.AULA_JWT_TTL * 1000).toISOString();
        await revokeToken(rc, rc.jti, expiresAt, "refresh");

        res.cookie(SESSION_COOKIE, session.token, sessionCookieOpts(session.expiresIn));
        // The token is in the BODY as well as the cookie, because the mobile app
        // authenticates with a bearer header and cannot read an httpOnly cookie.
        return {
          token: session.token,
          tokenType: "Bearer",
          expiresIn: session.expiresIn,
          user: session.user,
          position: session.position,
          screens: session.screens,
        };
      },
      { mutating: true },
    ),
  );

  /**
   * Sign out everywhere — every device, immediately.
   *
   * Bumps the user's epoch rather than enumerating tokens, because nothing
   * recorded which tokens exist. This is also the button to press after a
   * suspected credential leak.
   */
  r.post(
    "/auth/logout-all",
    runApi(
      async (rc, _req, res) => {
        const epoch = await bumpTokenEpoch(rc.userId, "logout-all");
        res.clearCookie(SESSION_COOKIE, { path: "/" });
        return { ok: true, epoch };
      },
      { mutating: true },
    ),
  );

  r.get("/auth/me", runApi(async (rc) => {
    // Every screen calls this on load, so the four reads it needs run together
    // rather than one after another. None depends on another's result — they
    // were sequential only by how the handler grew — so this is four round trips
    // collapsed into one wait.
    const domain = await getDomainService();
    const [position, userRec, settingsRows, mobile] = await Promise.all([
      rc.positionId ? getPosition(rc.positionId) : Promise.resolve(null),
      findUserById(rc.userId),
      // Per-user config (theme/accent/density/mailSyncInterval…).
      domain.listComplete(systemContext(rc.tenantId, rc.orgId), "userSetting", {
        filters: [{ field: "userId", op: "eq", value: rc.userId }],
      }),
      // Effective mobile screen set (admin config ∩ this user's permitted screens),
      // so the companion app can gate its navigation straight from the login call.
      resolveMobileConfig(rc),
    ]);

    // A principal whose user row carries no position (service tokens) sees every screen.
    const screens = position ? parseScreens(position) : screenCatalog(metadata).map((s) => s.key);
    let notificationPrefs: unknown = null;
    try {
      notificationPrefs = userRec?.notificationPrefs ? JSON.parse(String(userRec.notificationPrefs)) : null;
    } catch {
      notificationPrefs = null;
    }
    const settings: Record<string, string> = {};
    for (const row of settingsRows) settings[String(row.key)] = String(row.value ?? "");
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
      // The company this user belongs to (shown on the Settings → Account card).
      companyId: (userRec?.companyId as string | null) ?? null,
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
        const body = parseBody(req, profileSchema);
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
        const body = parseBody(req, userSettingsSchema);
        const entries = Object.entries(body.settings ?? {});
        // Each key belongs to a settings area (theme/density → appearance,
        // mailSyncInterval → notifications), so both are gated independently.
        for (const [key] of entries) {
          const { area, action } = areaForUserSettingKey(key);
          assertSettings(rc, area, action);
        }
        const domain = await getDomainService();
        const sys = systemContext(rc.tenantId, rc.orgId);
        const existing = await domain.listComplete(sys, "userSetting", {
          filters: [{ field: "userId", op: "eq", value: rc.userId }],
        });
        const byKey = new Map(existing.map((r) => [String(r.key), r]));
        // Build the response from what we started with plus what we just wrote,
        // rather than re-reading the table. The second round trip told us nothing
        // the first one plus the patch did not already.
        const settings: Record<string, string> = {};
        for (const row of existing) settings[String(row.key)] = String(row.value ?? "");

        for (const [key, raw] of entries) {
          const value = raw === null || raw === undefined ? "" : String(raw);
          const found = byKey.get(key);
          if (found) await domain.update(sys, "userSetting", String(found.id), { value });
          else await domain.create(sys, "userSetting", { userId: rc.userId, key, value });
          settings[key] = value;
        }
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
        const body = parseBody(req, changePasswordSchema);
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
        // Every existing session ends. Someone who changes their password
        // usually believes it was compromised, and leaving the attacker's
        // already-issued token working for the rest of its hour makes the
        // change close to pointless.
        await bumpTokenEpoch(rc.userId, "password-changed");
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
      const body = parseBody(req, totpCodeSchema);
      const user = await findUserById(rc.userId);
      if (!user?.twoFactorSecret) throw new BadRequestError("start 2FA setup first");
      let secret = "";
      try { secret = await decrypt(String(user.twoFactorSecret)); } catch { secret = ""; }
      if (!secret || !totpVerify(secret, String(body.code ?? ""))) {
        throw new ForbiddenError("invalid authentication code");
      }
      // Recovery codes are issued HERE, at the moment enrolment succeeds, and
      // returned exactly once. Enabling a second factor without them means the
      // next lost phone is an administrator ticket — and an account nobody can
      // reach is its own kind of outage.
      const recoveryCodes = generateRecoveryCodes();
      const qe = await getQueryEngine();
      await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, {
        twoFactorEnabled: true,
        twoFactorRecoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
        // A fresh enrolment starts a fresh replay window.
        twoFactorLastCounter: null,
      });
      await recordSecurityEvent({ tenantId: rc.tenantId, orgId: rc.orgId }, rc.userId, "twofactor_enabled", {
        ip: clientIp(req),
        userAgent: req.headers["user-agent"] ?? null,
      });
      // The plaintext exists only in this response — only hashes are stored, so
      // there is no second chance to show them and the client must say so.
      return { twoFactorEnabled: true, recoveryCodes };
    }, { mutating: true }),
  );

  /**
   * Replace the recovery codes.
   *
   * Requires the account password, like disabling does: someone who walks up to
   * an unlocked screen must not be able to mint themselves a working second
   * factor. The old codes stop working immediately — half-replacing a set would
   * leave the user unsure which paper is current.
   */
  r.post(
    "/auth/2fa/recovery-codes",
    runApi(async (rc, req) => {
      assertSettings(rc, "settings.security", "twoFactor");
      const body = parseBody(req, passwordConfirmSchema);
      const user = await findUserById(rc.userId);
      if (!user) throw new BadRequestError("no editable profile for this account");
      if (!user.twoFactorEnabled) throw new BadRequestError("two-factor authentication is not enabled");
      if (!body.password || !(await verifyPassword(body.password, String(user.passwordHash ?? "")))) {
        throw new ForbiddenError("password is incorrect");
      }
      const recoveryCodes = generateRecoveryCodes();
      const qe = await getQueryEngine();
      await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, {
        twoFactorRecoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)),
      });
      await recordSecurityEvent({ tenantId: rc.tenantId, orgId: rc.orgId }, rc.userId, "twofactor_enabled", {
        ip: clientIp(req),
        userAgent: req.headers["user-agent"] ?? null,
      });
      return { recoveryCodes };
    }, { mutating: true }),
  );

  // Disable 2FA — requires the account password to confirm.
  r.post(
    "/auth/2fa/disable",
    runApi(async (rc, req) => {
      assertSettings(rc, "settings.security", "twoFactor");
      const body = parseBody(req, passwordConfirmSchema);
      const user = await findUserById(rc.userId);
      if (!user) throw new BadRequestError("no editable profile for this account");
      if (!body.password || !(await verifyPassword(body.password, String(user.passwordHash ?? "")))) {
        throw new ForbiddenError("password is incorrect");
      }
      const qe = await getQueryEngine();
      await qe.patchComputed(systemContext(rc.tenantId, rc.orgId), "user", rc.userId, {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        // Recovery codes belong to the enrolment that issued them. Leaving them
        // behind would mean a re-enrolment silently inherited codes printed for
        // a secret that no longer exists.
        twoFactorRecoveryCodes: null,
        twoFactorLastCounter: null,
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
}
