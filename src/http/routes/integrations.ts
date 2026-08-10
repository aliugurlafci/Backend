/**
 * Outbound webhooks and the per-user notification inbox.
 */

import { type Router } from "express";
import { type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { runApi, pathParam } from "@/lib/http/handler";
import { notifications, buildInAppMuteFilter } from "@/lib/integrations/notifications";
import { getDomainService } from "@/lib/domain";
import { webhookRegistry, testWebhook } from "@/lib/integrations/webhooks";
import { clientErrorsSchema, parseBody, registerDeviceSchema, unregisterDeviceSchema, webhookSchema } from "@/lib/http/body";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/enforcement/errors";

export function registerIntegrationRoutes(r: Router): void {
  // ---- webhooks ---------------------------------------------------------
  r.get("/webhooks", runApi(async (rc) => {
    if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
    const [endpoints, deliveries] = await Promise.all([
      webhookRegistry.list(rc.tenantId, rc.orgId),
      webhookRegistry.listDeliveries(rc.tenantId, rc.orgId),
    ]);
    // The signing secret never leaves the server: a client that could read it
    // could forge a payload the receiver would accept as ours.
    return { endpoints: endpoints.map(({ secret: _secret, ...e }) => e), deliveries };
  }));

  r.post(
    "/webhooks",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const body = parseBody(req, webhookSchema);
        if (!body.url) throw new BadRequestError("url is required");
        const created = await webhookRegistry.register({
          tenantId: rc.tenantId,
          orgId: rc.orgId,
          url: body.url,
          secret: body.secret || randomBytes(16).toString("hex"),
          events: body.events?.length ? body.events : ["*"],
          createdAt: rc.at,
        });
        // Returned once, on creation, so the operator can configure the receiver;
        // never again on read.
        return created;
      },
      { mutating: true, status: 201 },
    ),
  );

  r.delete(
    "/webhooks/:id",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        if (!(await webhookRegistry.remove(rc.tenantId, rc.orgId, pathParam(req, "id")))) {
          throw new NotFoundError("webhook", pathParam(req, "id"));
        }
        return { deleted: true, id: pathParam(req, "id") };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/webhooks/:id/test",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const endpoint = await webhookRegistry.get(rc.tenantId, rc.orgId, pathParam(req, "id"));
        if (!endpoint) throw new NotFoundError("webhook", pathParam(req, "id"));
        await testWebhook(endpoint, rc.at);
        return { ok: true, deliveries: await webhookRegistry.listDeliveries(rc.tenantId, rc.orgId) };
      },
      { mutating: true },
    ),
  );

  // Local webhook receiver (intentionally unauthenticated; echoes signature).
  r.post("/webhooks/echo", (req: Request, res: Response) => {
    res.json({ received: true, signature: req.get("x-aula-signature") ?? "" });
  });

  // ---- devices (push notifications) --------------------------------------
  /**
   * Register this device for push.
   *
   * Called on every app launch, not only the first: a push token rotates, and a
   * device that stops re-registering silently stops receiving anything. The
   * write is keyed on the token so repeating it refreshes rather than
   * duplicates.
   */
  r.post(
    "/devices",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, registerDeviceSchema);
        const { registerDevice } = await import("@/lib/integrations/push-transport");
        const device = await registerDevice(rc, {
          token: body.token,
          platform: body.platform,
          deviceName: body.deviceName ?? null,
          appVersion: body.appVersion ?? null,
        });
        return { id: device.id, active: device.active };
      },
      { mutating: true, status: 201 },
    ),
  );

  /** Stop pushing to this device — a sign-out, or notifications turned off. */
  r.post(
    "/devices/unregister",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, unregisterDeviceSchema);
        const { unregisterDevice } = await import("@/lib/integrations/push-transport");
        return { unregistered: await unregisterDevice(rc, body.token) };
      },
      { mutating: true },
    ),
  );

  /**
   * Send a test push to the caller's own devices.
   *
   * A real diagnostic, not test scaffolding: "my phone is not getting anything"
   * is otherwise unanswerable without reading logs. This exercises the entire
   * path — token, service, delivery — and records the outcome on the device row,
   * so a dead token is both explained and deactivated by the act of checking.
   *
   * Scoped to the caller's own devices, so it cannot be used to push to anyone
   * else.
   */
  r.post(
    "/devices/test",
    runApi(
      async (rc) => {
        const { devicesFor, pushToDevices } = await import("@/lib/integrations/push-transport");
        const devices = await devicesFor(rc, rc.userId);
        if (devices.length === 0) return { sent: 0, failed: 0, deactivated: 0, skipped: true };
        return pushToDevices(rc, devices, {
          title: "AULA",
          body: "Bildirimler çalışıyor.",
          data: { eventType: "test" },
        });
      },
      { mutating: true },
    ),
  );

  /** The caller's own devices — so somebody can see why a phone is silent. */
  r.get("/devices", runApi(async (rc) => {
    const { devicesFor } = await import("@/lib/integrations/push-transport");
    return { items: await devicesFor(rc, rc.userId) };
  }));

  // ---- client errors ------------------------------------------------------
  /**
   * A crash or handled failure, reported by the app.
   *
   * Accepts a BATCH, because a fatal crash is reported on the next launch along
   * with whatever else was queued behind it — one request per error would mean
   * an app that just crashed opening a dozen connections at start-up.
   *
   * Rate-limited harder than the default: an app stuck in a render loop can
   * report thousands of times a minute, and the crash-reporting endpoint is the
   * last one that should be able to take the server down.
   */
  r.post(
    "/client-errors",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, clientErrorsSchema);
        const domain = await getDomainService();
        let stored = 0;
        for (const e of body.errors) {
          // Fingerprint here rather than on the device: the grouping must be
          // consistent across app versions, and a client that computes it
          // differently would split one problem into two.
          const top = (e.stack ?? "").split("\n").slice(0, 2).join(" ").slice(0, 200);
          const fingerprint = createHash("sha256").update(`${e.message}|${top}`).digest("hex").slice(0, 32);
          await domain.create(rc, "clientError", {
            fingerprint,
            message: e.message.slice(0, 500),
            severity: e.severity,
            stack: e.stack ?? null,
            context: e.context ?? null,
            platform: e.platform ?? null,
            appVersion: e.appVersion ?? null,
            deviceName: e.deviceName ?? null,
            occurredAt: e.occurredAt,
          });
          stored += 1;
        }
        return { stored };
      },
      { mutating: true, status: 201, rateLimit: { limit: 60, windowMs: 60_000 } },
    ),
  );

  // ---- notifications (per-user inbox) -----------------------------------
  r.get("/notifications", runApi(async (rc) => {
    // Hide categories the user muted (also covers broadcasts, which can't be gated at delivery).
    const isMuted = await buildInAppMuteFilter(rc.tenantId, rc.orgId, rc.userId);
    return {
      items: await notifications.list(rc.tenantId, rc.orgId, rc.userId, isMuted),
      unread: await notifications.unreadCount(rc.tenantId, rc.orgId, rc.userId, isMuted),
    };
  }));

  r.post(
    "/notifications",
    runApi(
      async (rc) => {
        await notifications.markAllRead(rc.tenantId, rc.orgId, rc.userId);
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
        const removed = await notifications.remove(rc.tenantId, rc.orgId, rc.userId, ids);
        return { removed };
      },
      { mutating: true },
    ),
  );

}
