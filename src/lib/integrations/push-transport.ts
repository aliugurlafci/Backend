/**
 * Push notifications to the mobile app.
 *
 * Delivered through Expo's push service rather than to FCM and APNs directly.
 * The app is Expo-managed, so the token the SDK hands us is an Expo token that
 * only that service can route; going direct would mean managing an Android
 * service account and an Apple key, keeping both in sync with the build
 * pipeline, and writing two different payload shapes — for a delivery path that
 * would behave identically. If the app ever ejects, this module is the only
 * thing that changes.
 *
 * What matters more than the transport is what happens to a token that fails.
 * A device whose app was uninstalled reports `DeviceNotRegistered` for ever, and
 * a queue that keeps retrying it fills with deliveries that can never succeed —
 * burying the ones that could. So a permanently rejected token is deactivated,
 * with the reason recorded, and the device stops being tried.
 */
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { getQueryEngine } from "@/lib/data/store";
import { systemContext } from "@/lib/context/resolver";
import { logger } from "@/lib/observability/logger";
import { httpRequest } from "./transport-util";

const DEVICE = "deviceToken";
/**
 * Where pushes go.
 *
 * Overridable so a test can point it somewhere unreachable and exercise the
 * failure path deliberately. Without that the "never throws" test reached the
 * real service — slow, dependent on the internet in CI, and not actually
 * testing the thing it claimed to.
 */
const EXPO_PUSH_URL = process.env.AULA_EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send";
/** Expo accepts up to 100 messages per request. */
const CHUNK = 100;
const TIMEOUT_MS = 15_000;

export interface PushMessage {
  title: string;
  body: string;
  /** Delivered to the app so a tap can open the right screen. */
  data?: Record<string, string>;
  /** Badge count for iOS; omitted leaves it unchanged. */
  badge?: number;
}

export interface PushResult {
  sent: number;
  failed: number;
  /** Tokens deactivated because the device will never accept another push. */
  deactivated: number;
  /** No devices registered — not a failure, just nothing to do. */
  skipped: boolean;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Errors that mean "never try this token again".
 *
 * Distinguished from a transient failure on purpose: a network blip should be
 * retried, an uninstalled app should not. Treating them alike either loses
 * notifications or accumulates dead tokens, and both are silent.
 */
const PERMANENT = new Set(["DeviceNotRegistered", "InvalidCredentials"]);

/** Every device a user can be reached on. */
export async function devicesFor(ctx: RequestContext, userId: string): Promise<EntityRecord[]> {
  const qe = await getQueryEngine();
  return qe.listComplete(ctx, DEVICE, {
    filters: [
      { field: "userId", op: "eq", value: userId },
      { field: "active", op: "eq", value: true },
    ],
  });
}

/**
 * Register (or refresh) a device.
 *
 * Keyed on the token, so re-registering UPDATES rather than inserts. Without
 * that, every app launch adds a row and the user receives each notification as
 * many times as they have opened the app.
 *
 * A token that moves to a different user is reassigned rather than duplicated —
 * that is a shared till, which is ordinary, and the notification must follow
 * whoever is signed in now.
 */
export async function registerDevice(
  ctx: RequestContext,
  input: { token: string; platform: string; deviceName?: string | null; appVersion?: string | null },
): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const existing = await qe.list(ctx, DEVICE, {
    filters: [{ field: "token", op: "eq", value: input.token }],
    pageSize: 1,
  });
  const values = {
    userId: ctx.userId,
    platform: input.platform,
    deviceName: input.deviceName ?? null,
    appVersion: input.appVersion ?? null,
    active: true,
    lastSeenAt: ctx.at,
    lastError: null,
  };
  const row = existing.items[0];
  if (row) return qe.patchComputed(ctx, DEVICE, String(row.id), values);
  return qe.createWithComputed(ctx, DEVICE, { token: input.token, ...values }, {});
}

/** Stop pushing to a device — a sign-out, or the user turning notifications off. */
export async function unregisterDevice(ctx: RequestContext, token: string): Promise<boolean> {
  const qe = await getQueryEngine();
  const existing = await qe.list(ctx, DEVICE, {
    filters: [{ field: "token", op: "eq", value: token }],
    pageSize: 1,
  });
  const row = existing.items[0];
  if (!row) return false;
  // Deactivated rather than deleted: the row is also the record of which devices
  // a person has used, which is the first thing looked at when one of them stops
  // receiving anything.
  await qe.patchComputed(ctx, DEVICE, String(row.id), { active: false, lastError: "unregistered" });
  return true;
}

/**
 * Push to every device a user has.
 *
 * Never throws. A push is a convenience over a notification that is already
 * recorded in the inbox — failing the operation that triggered it because a
 * phone was unreachable would be the wrong trade entirely.
 */
export async function pushToUser(ctx: RequestContext, userId: string, message: PushMessage): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, deactivated: 0, skipped: false };
  try {
    const devices = await devicesFor(ctx, userId);
    if (devices.length === 0) {
      result.skipped = true;
      return result;
    }
    return await pushToDevices(ctx, devices, message);
  } catch (e) {
    logger.warn("push failed", { userId, error: e instanceof Error ? e.message : String(e) });
    result.failed += 1;
    return result;
  }
}

/** Push to a specific set of devices, chunked to the service's limit. */
export async function pushToDevices(
  ctx: RequestContext,
  devices: EntityRecord[],
  message: PushMessage,
): Promise<PushResult> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId);
  const result: PushResult = { sent: 0, failed: 0, deactivated: 0, skipped: devices.length === 0 };

  for (let i = 0; i < devices.length; i += CHUNK) {
    const batch = devices.slice(i, i + CHUNK);
    const payload = batch.map((d) => ({
      to: String(d.token),
      title: message.title,
      body: message.body,
      ...(message.data ? { data: message.data } : {}),
      ...(message.badge !== undefined ? { badge: message.badge } : {}),
      sound: "default",
    }));

    let tickets: ExpoTicket[] = [];
    try {
      const res = await httpRequest(
        EXPO_PUSH_URL,
        { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) },
        TIMEOUT_MS,
      );
      const json = (await res.json().catch(() => ({}))) as { data?: ExpoTicket[] };
      tickets = json.data ?? [];
    } catch (e) {
      // The whole batch failed to reach the service. Transient by assumption —
      // nothing about the tokens is implied, so none is deactivated.
      result.failed += batch.length;
      logger.warn("push batch failed", { count: batch.length, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const device = batch[j];
      const ticket = tickets[j];
      if (!device) continue;
      if (!ticket || ticket.status === "ok") {
        result.sent += 1;
        await qe.patchComputed(sys, DEVICE, String(device.id), { lastPushAt: ctx.at, lastError: null }).catch(() => {});
        continue;
      }
      result.failed += 1;
      const code = ticket.details?.error ?? "";
      if (PERMANENT.has(code)) {
        // The app was uninstalled or the token rotated. Retrying for ever fills
        // the queue with deliveries that cannot succeed and buries the ones that
        // can.
        result.deactivated += 1;
        await qe
          .patchComputed(sys, DEVICE, String(device.id), { active: false, lastError: `${code}: ${ticket.message ?? ""}`.slice(0, 300) })
          .catch(() => {});
      } else {
        await qe
          .patchComputed(sys, DEVICE, String(device.id), { lastError: (ticket.message ?? code).slice(0, 300) })
          .catch(() => {});
      }
    }
  }

  if (result.sent || result.failed) logger.info("push delivered", { ...result });
  return result;
}
