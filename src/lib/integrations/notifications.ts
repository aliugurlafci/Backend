/**
 * Notifications — domain events → an in-app inbox (the topbar bell).
 *
 * Notifications are **per-user**: a notification either targets one `userId`
 * (personal — e.g. "your purchase order was approved") or is an org-wide
 * broadcast (`userId: null` — e.g. "a deal was won"). Broadcasts track read /
 * dismissed state per user, so one teammate reading or clearing them never
 * affects anybody else.
 *
 * Delivery honours each recipient's `notificationPrefs` (the Settings →
 * Notifications page): when a user has muted every channel for an event, the
 * in-app notification is suppressed too. We never notify someone of their own
 * action. Stored in the database, so a restart does not clear everyone's bell.
 */
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { systemContext } from "@/lib/context/resolver";
import { pushToUser } from "./push-transport";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { MAX_PAGE_SIZE } from "@/lib/data/query";
import type { EntityRecord } from "@/lib/metadata/types";
import { logger } from "@/lib/observability/logger";
import { orgText } from "@/lib/i18n/texts";

export type NotificationChannel = "email" | "system";

/** A notification as exposed to the client (per-user `read` already resolved). */
export interface NotificationView {
  id: string;
  at: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  eventType: string;
  read: boolean;
  href?: string;
}

export interface AddNotificationInput {
  at: string;
  tenantId: string;
  orgId: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  eventType: string;
  href?: string;
  /** Target a single user; omit/null for an org-wide broadcast. */
  userId?: string | null;
  /** Notification-preference category (e.g. "deal_won"); enables read-time muting. */
  prefKey?: string;
}

/** A sync predicate telling whether a notification category is muted for the viewer. */
export type MuteFilter = (prefKey?: string) => boolean;

const NOTIFICATION = "notification";
const STATE = "notificationState";

const sysCtx = (tenantId: string, orgId: string) => systemContext(tenantId, orgId);
const stateKeyOf = (notificationId: string, userId: string) => `${notificationId}:${userId}`;

/**
 * Database-backed notification inbox.
 *
 * Rows, not process state: the previous version kept the last 500 in an array
 * and lost them on every restart — including, notably, the alerts about whatever
 * had just gone wrong.
 *
 * Read/dismiss state lives in a companion table keyed by (notification, user),
 * because a broadcast has a different answer per viewer. A missing row means
 * unread and undismissed, so the common case costs no writes.
 */
export class NotificationService {
  async add(input: AddNotificationInput): Promise<void> {
    try {
      const qe = await getQueryEngine();
      await qe.create(sysCtx(input.tenantId, input.orgId), NOTIFICATION, {
        at: input.at,
        userId: input.userId ?? null,
        channel: input.channel,
        subject: input.subject,
        body: input.body,
        eventType: input.eventType,
        href: input.href ?? null,
        prefKey: input.prefKey ?? null,
      });
      logger.info("notification", {
        channel: input.channel,
        subject: input.subject,
        tenantId: input.tenantId,
        userId: input.userId ?? "*",
      });
    } catch (error) {
      // A notification is a courtesy on top of an operation that already
      // succeeded; failing to store one must not fail the operation.
      logger.warn("notification not stored", {
        subject: input.subject,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Notifications visible to `userId`: their personal ones plus undismissed
   * broadcasts, minus muted categories.
   *
   * Read as one window over the tenant's recent notifications rather than a
   * per-user query, because a broadcast belongs to everyone — the visibility
   * rules are applied here, over a bounded page.
   */
  private async load(
    tenantId: string,
    orgId: string,
    userId: string,
    isMuted?: MuteFilter,
    limit = 30,
  ): Promise<{ row: EntityRecord; read: boolean }[]> {
    const qe = await getQueryEngine();
    const ctx = sysCtx(tenantId, orgId);
    // Over-read a little: broadcasts this user dismissed are filtered out below,
    // so a straight `limit` could return fewer than asked for.
    const window = Math.min(limit * 3, MAX_PAGE_SIZE);
    const page = await qe.list(ctx, NOTIFICATION, {
      sort: [{ field: "at", dir: "desc" }],
      pageSize: window,
    });
    const candidates = page.items.filter((n) => {
      if (isMuted && isMuted(n.prefKey ? String(n.prefKey) : undefined)) return false;
      const target = n.userId ? String(n.userId) : null;
      return target === null || target === userId;
    });
    if (candidates.length === 0) return [];

    const states = await qe.listComplete(ctx, STATE, {
      filters: [
        { field: "userId", op: "eq", value: userId },
        { field: "notificationId", op: "in", value: candidates.map((n) => String(n.id)) },
      ],
    });
    const byNotification = new Map(states.map((s) => [String(s.notificationId), s]));

    const out: { row: EntityRecord; read: boolean }[] = [];
    for (const row of candidates) {
      const state = byNotification.get(String(row.id));
      if (state?.dismissed) continue;
      out.push({ row, read: Boolean(state?.read) });
      if (out.length >= limit) break;
    }
    return out;
  }

  async list(
    tenantId: string,
    orgId: string,
    userId: string,
    isMuted?: MuteFilter,
    limit = 30,
  ): Promise<NotificationView[]> {
    const rows = await this.load(tenantId, orgId, userId, isMuted, limit);
    return rows.map(({ row, read }) => ({
      id: String(row.id),
      at: String(row.at),
      channel: String(row.channel) as NotificationChannel,
      subject: String(row.subject ?? ""),
      body: String(row.body ?? ""),
      eventType: String(row.eventType ?? ""),
      href: row.href ? String(row.href) : undefined,
      read,
    }));
  }

  async unreadCount(tenantId: string, orgId: string, userId: string, isMuted?: MuteFilter): Promise<number> {
    const rows = await this.load(tenantId, orgId, userId, isMuted, MAX_PAGE_SIZE);
    return rows.filter((r) => !r.read).length;
  }

  async markAllRead(tenantId: string, orgId: string, userId: string): Promise<void> {
    const rows = await this.load(tenantId, orgId, userId, undefined, MAX_PAGE_SIZE);
    for (const { row, read } of rows) {
      if (read) continue;
      await this.setState(tenantId, orgId, String(row.id), userId, { read: true });
    }
  }

  /**
   * Hide notifications by id for this user.
   *
   * A personal notification is deleted outright; a broadcast is marked dismissed
   * for this user only, since everyone else still has it in their bell.
   */
  async remove(tenantId: string, orgId: string, userId: string, ids: string[]): Promise<number> {
    const qe = await getQueryEngine();
    const ctx = sysCtx(tenantId, orgId);
    let affected = 0;
    for (const id of ids) {
      const row = await qe.get(ctx, NOTIFICATION, id).catch(() => null);
      if (!row) continue;
      const target = row.userId ? String(row.userId) : null;
      if (target !== null && target !== userId) continue; // not theirs to clear
      if (target === null) {
        await this.setState(tenantId, orgId, id, userId, { dismissed: true });
      } else {
        await this.clearStates(ctx, id);
        await qe.remove(ctx, NOTIFICATION, id);
      }
      affected++;
    }
    return affected;
  }

  /** Upsert this user's state for one notification. */
  private async setState(
    tenantId: string,
    orgId: string,
    notificationId: string,
    userId: string,
    patch: { read?: boolean; dismissed?: boolean },
  ): Promise<void> {
    const qe = await getQueryEngine();
    const ctx = sysCtx(tenantId, orgId);
    const stateKey = stateKeyOf(notificationId, userId);
    const existing = await qe.list(ctx, STATE, {
      filters: [{ field: "stateKey", op: "eq", value: stateKey }],
      pageSize: 1,
    });
    const current = existing.items[0];
    if (current) {
      await qe.patchComputed(ctx, STATE, current.id, patch);
      return;
    }
    await qe.createWithComputed(
      ctx,
      STATE,
      {
        notificationId,
        userId,
        read: patch.read ?? false,
        dismissed: patch.dismissed ?? false,
      },
      { stateKey },
    );
  }

  /** Drop the per-user state rows for a notification about to be deleted. */
  private async clearStates(ctx: RequestContext, notificationId: string): Promise<void> {
    const qe = await getQueryEngine();
    const states = await qe.listComplete(ctx, STATE, {
      filters: [{ field: "notificationId", op: "eq", value: notificationId }],
    });
    if (states.length) await qe.removeMany(ctx, STATE, states.map((s) => String(s.id)));
  }

  /**
   * Delete notifications older than `days`, with their state rows.
   *
   * Nothing reads a month-old bell entry, and the table grows with every event
   * delivered to every user. Called by the retention job.
   */
  async prune(tenantId: string, orgId: string, days = 30): Promise<number> {
    const qe = await getQueryEngine();
    const ctx = sysCtx(tenantId, orgId);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let removed = 0;
    for (;;) {
      const page = await qe.list(ctx, NOTIFICATION, {
        filters: [{ field: "at", op: "lt", value: cutoff }],
        pageSize: MAX_PAGE_SIZE,
      });
      if (page.items.length === 0) return removed;
      for (const row of page.items) await this.clearStates(ctx, String(row.id));
      removed += await qe.removeMany(ctx, NOTIFICATION, page.items.map((r) => String(r.id)));
    }
  }
}

export const notifications = new NotificationService();

// ---- delivery (targeting + preference gating) --------------------------------

function recordNumber(e: DomainEvent): string {
  const record = e.payload.record as { number?: string } | undefined;
  return record?.number ?? String(e.payload.number ?? e.payload.id ?? "");
}

interface ChannelPrefs {
  inapp?: boolean;
  email?: boolean;
  push?: boolean;
  sms?: boolean;
}
interface NotificationPrefs {
  paused?: boolean;
  channels?: ChannelPrefs;
  quiet?: { enabled?: boolean; start?: string; end?: string };
  events: Record<string, ChannelPrefs>;
}

/** Read the user's prefs in either the new structured shape or the legacy flat map. */
function normalizePrefs(raw: unknown): NotificationPrefs {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.events && typeof obj.events === "object") {
      return {
        paused: Boolean(obj.paused),
        channels: (obj.channels as ChannelPrefs) ?? undefined,
        quiet: (obj.quiet as NotificationPrefs["quiet"]) ?? undefined,
        events: obj.events as Record<string, ChannelPrefs>,
      };
    }
    // Legacy: the whole object is the event→channels map.
    return { events: obj as Record<string, ChannelPrefs> };
  }
  return { events: {} };
}

/**
 * True when `atIso` falls inside the [start, end) quiet window (HH:MM, in `tz`),
 * supporting overnight windows (e.g. 22:00 → 07:00). Best-effort; never throws.
 */
export function inQuietHours(start: string | undefined, end: string | undefined, atIso: string, tz?: string | null): boolean {
  if (!start || !end || start === end) return false;
  let now: string;
  try {
    now = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz || "UTC" }).format(new Date(atIso));
  } catch {
    return false;
  }
  if (now === "24:00") now = "00:00";
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Load + normalize a user's notification prefs (+ their timezone for quiet hours). */
async function loadUserPrefs(tenantId: string, orgId: string, userId: string): Promise<{ prefs: NotificationPrefs | null; timezone?: string }> {
  try {
    const qe = await getQueryEngine();
    const user = await qe.get(systemContext(tenantId, orgId), "user", userId);
    const timezone = (user?.timezone as string | undefined) ?? undefined;
    if (!user?.notificationPrefs) return { prefs: null, timezone };
    return { prefs: normalizePrefs(JSON.parse(String(user.notificationPrefs))), timezone };
  } catch {
    return { prefs: null };
  }
}

/**
 * Whether a category is muted for the in-app bell — the persistent preference:
 * the master pause, the in-app channel master, or the per-event in-app toggle.
 * (Quiet hours is transient and applied only at delivery time, not here.)
 */
function inAppMuted(prefs: NotificationPrefs, prefKey?: string): boolean {
  if (prefs.paused) return true;
  if (prefs.channels?.inapp === false) return true;
  if (!prefKey) return false;
  const ev = prefs.events?.[prefKey];
  if (!ev) return false;
  // Legacy rows lack an explicit `inapp`; treat "all simulated channels off" as muted.
  if (ev.inapp === undefined) return !(ev.email || ev.push || ev.sms);
  return ev.inapp === false;
}

/**
 * A sync mute predicate for the bell, loaded once per request. Broadcasts (which
 * can't be gated at delivery time) are filtered here so a user never sees a
 * category they muted; defaults to "nothing muted" when prefs can't be read.
 */
export async function buildInAppMuteFilter(tenantId: string, orgId: string, userId: string): Promise<MuteFilter> {
  const { prefs } = await loadUserPrefs(tenantId, orgId, userId);
  if (!prefs) return () => false;
  return (prefKey) => inAppMuted(prefs, prefKey);
}

/** Delivery-time gate for personal notifications (category mute + quiet hours). */
async function prefsAllowFor(tenantId: string, orgId: string, userId: string, prefKey: string, at: string): Promise<boolean> {
  const { prefs, timezone } = await loadUserPrefs(tenantId, orgId, userId);
  if (!prefs) return true;
  if (inAppMuted(prefs, prefKey)) return false;
  if (prefs.quiet?.enabled && inQuietHours(prefs.quiet.start, prefs.quiet.end, at, timezone)) return false;
  return true;
}

export interface NotifyUserInput {
  tenantId: string;
  orgId: string;
  userId: string;
  at: string;
  /** The actor who triggered it — skipped so users aren't notified of their own actions. */
  actorId?: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  href?: string;
  eventType: string;
  prefKey?: string;
}

/** Deliver a personal notification, applying self-skip + preference gating. */
export async function notifyUser(opts: NotifyUserInput): Promise<void> {
  if (opts.actorId && opts.userId === opts.actorId) return;
  if (opts.prefKey && !(await prefsAllowFor(opts.tenantId, opts.orgId, opts.userId, opts.prefKey, opts.at))) return;
  await notifications.add({
    tenantId: opts.tenantId,
    orgId: opts.orgId,
    userId: opts.userId,
    at: opts.at,
    channel: opts.channel,
    subject: opts.subject,
    body: opts.body,
    eventType: opts.eventType,
    href: opts.href,
    prefKey: opts.prefKey,
  });

  // …and reach the phone. The inbox row above requires the app to be open to be
  // seen, which is the one state a notification exists for — "the basket is at
  // the till" is useless to a cashier who is looking at the till.
  //
  // Deliberately not awaited into the caller's failure path: `pushToUser` never
  // throws, and a push is a convenience over a notification that is already
  // recorded. Failing the operation that triggered it because a phone was
  // unreachable would be the wrong trade entirely.
  void pushToUser(
    systemContext(opts.tenantId, opts.orgId, { userId: opts.userId }),
    opts.userId,
    {
      title: opts.subject,
      body: opts.body,
      // Enough for the app to open the right screen from the notification.
      ...(opts.href || opts.eventType
        ? { data: { ...(opts.href ? { href: opts.href } : {}), ...(opts.eventType ? { eventType: opts.eventType } : {}) } }
        : {}),
    },
  ).catch(() => {});
}

interface DeliverOptions {
  event: DomainEvent;
  /** Target user; null = org-wide broadcast. */
  userId: string | null;
  channel: NotificationChannel;
  subject: string;
  body: string;
  href?: string;
  /** Notification-preference category. Personal: gated at delivery. Broadcast: gated at read time. */
  prefKey?: string;
}

/** Deliver one event-driven notification (personal → gated now; broadcast → stored + gated on read). */
async function deliver(opts: DeliverOptions): Promise<void> {
  const { event, userId } = opts;
  if (userId) {
    await notifyUser({
      tenantId: event.tenantId,
      orgId: event.orgId,
      userId,
      at: event.at,
      actorId: event.actorId,
      channel: opts.channel,
      subject: opts.subject,
      body: opts.body,
      href: opts.href,
      eventType: event.type,
      prefKey: opts.prefKey,
    });
    return;
  }
  await notifications.add({
    at: event.at,
    tenantId: event.tenantId,
    orgId: event.orgId,
    userId: null,
    channel: opts.channel,
    subject: opts.subject,
    body: opts.body,
    eventType: event.type,
    href: opts.href,
    prefKey: opts.prefKey,
  });
}

let registered = false;

export function registerNotifications(): void {
  if (registered) return;
  registered = true;

  // --- Sales: team-wide broadcasts (informational) ---
  eventBus.subscribe("quote.send", (e) =>
    deliver({
      event: e,
      userId: null,
      channel: "email",
      subject: orgText("notif.quoteSent.subject"),
      body: orgText("notif.quoteSent.body", { number: recordNumber(e) }),
      href: `/quote/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "quote_sent",
    }),
  );
  eventBus.subscribe("invoice.send", (e) =>
    deliver({
      event: e,
      userId: null,
      channel: "email",
      subject: orgText("notif.invoiceSent.subject"),
      body: orgText("notif.invoiceSent.body", { number: recordNumber(e) }),
      href: `/invoice/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "invoice_sent",
    }),
  );
  eventBus.subscribe("deal.win", (e) =>
    deliver({
      event: e,
      userId: null,
      channel: "system",
      subject: orgText("notif.dealWon.subject"),
      body: orgText("notif.dealWon.body", { id: String(e.payload.id) }),
      href: `/deal?focus=${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "deal_won",
    }),
  );

  // --- Purchasing: targeted approval routing ---
  // Submitted → the routed approver is asked to approve.
  eventBus.subscribe("purchaseOrder.submitted", (e) =>
    deliver({
      event: e,
      userId: e.payload.approverId ? String(e.payload.approverId) : null,
      channel: "system",
      subject: orgText("notif.poSubmitted.subject"),
      body: orgText("notif.poSubmitted.body", { number: recordNumber(e) }),
      href: `/purchaseOrder/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "po_approval",
    }),
  );
  // Approved → the creator is told their PO is cleared.
  eventBus.subscribe("purchaseOrder.approved", (e) =>
    deliver({
      event: e,
      userId: e.payload.ownerId ? String(e.payload.ownerId) : null,
      channel: "system",
      subject: orgText("notif.poApproved.subject"),
      body: orgText("notif.poApproved.body", { number: recordNumber(e) }),
      href: `/purchaseOrder/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "po_approval",
    }),
  );
  // Rejected → the creator sees the reason.
  eventBus.subscribe("purchaseOrder.rejected", (e) =>
    deliver({
      event: e,
      userId: e.payload.ownerId ? String(e.payload.ownerId) : null,
      channel: "system",
      subject: orgText("notif.poRejected.subject"),
      body: e.payload.reason
        ? orgText("notif.poRejectedReason.body", { number: recordNumber(e), reason: String(e.payload.reason) })
        : orgText("notif.poRejected.body", { number: recordNumber(e) }),
      href: `/purchaseOrder/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "po_approval",
    }),
  );
  // Goods received → the PO owner learns their order arrived.
  eventBus.subscribe("goodsReceipt.posted", (e) =>
    deliver({
      event: e,
      userId: e.payload.poOwnerId ? String(e.payload.poOwnerId) : null,
      channel: "system",
      subject: orgText("notif.goodsReceived.subject"),
      body: e.payload.poNumber
        ? orgText("notif.goodsReceivedForPo.body", { number: recordNumber(e), po: String(e.payload.poNumber) })
        : orgText("notif.goodsReceived.body", { number: recordNumber(e) }),
      href: `/goodsReceipt/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "goods_received",
    }),
  );

  logger.info("notifications registered", { events: 7 });
}
