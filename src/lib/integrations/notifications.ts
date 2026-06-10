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
 * action. Storage is in-memory (like audit/webhook/search — Redis/table in prod).
 */
import { newId } from "@/lib/core/ids";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { logger } from "@/lib/observability/logger";

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

interface StoredNotification {
  id: string;
  at: string;
  tenantId: string;
  orgId: string;
  /** Target user, or null for an org-wide broadcast. */
  userId: string | null;
  channel: NotificationChannel;
  subject: string;
  body: string;
  eventType: string;
  href?: string;
  /** Notification-preference category — lets the bell hide muted categories. */
  prefKey?: string;
  /** Read flag for personal notifications (userId != null). */
  read: boolean;
  /** Per-user read state for broadcasts (userId == null). */
  readBy: Set<string>;
  /** Per-user dismiss state for broadcasts (userId == null). */
  dismissedBy: Set<string>;
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

export class NotificationService {
  private items: StoredNotification[] = [];

  add(input: AddNotificationInput): void {
    const n: StoredNotification = {
      id: newId("ntf"),
      userId: input.userId ?? null,
      read: false,
      readBy: new Set<string>(),
      dismissedBy: new Set<string>(),
      at: input.at,
      tenantId: input.tenantId,
      orgId: input.orgId,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      eventType: input.eventType,
      href: input.href,
      prefKey: input.prefKey,
    };
    this.items.unshift(n);
    if (this.items.length > 500) this.items.length = 500;
    logger.info("notification", { channel: n.channel, subject: n.subject, tenantId: n.tenantId, userId: n.userId ?? "*" });
  }

  /**
   * Is this notification visible to `userId`? It must be their personal one (or a
   * broadcast they haven't dismissed) AND its category must not be muted for them.
   */
  private visibleTo(n: StoredNotification, userId: string, isMuted?: MuteFilter): boolean {
    if (isMuted && isMuted(n.prefKey)) return false;
    if (n.userId === null) return !n.dismissedBy.has(userId);
    return n.userId === userId;
  }

  private isReadFor(n: StoredNotification, userId: string): boolean {
    return n.userId === null ? n.readBy.has(userId) : n.read;
  }

  private view(n: StoredNotification, userId: string): NotificationView {
    return {
      id: n.id,
      at: n.at,
      channel: n.channel,
      subject: n.subject,
      body: n.body,
      eventType: n.eventType,
      href: n.href,
      read: this.isReadFor(n, userId),
    };
  }

  list(tenantId: string, orgId: string, userId: string, isMuted?: MuteFilter, limit = 30): NotificationView[] {
    return this.items
      .filter((n) => n.tenantId === tenantId && n.orgId === orgId && this.visibleTo(n, userId, isMuted))
      .slice(0, limit)
      .map((n) => this.view(n, userId));
  }

  unreadCount(tenantId: string, orgId: string, userId: string, isMuted?: MuteFilter): number {
    return this.items.filter(
      (n) => n.tenantId === tenantId && n.orgId === orgId && this.visibleTo(n, userId, isMuted) && !this.isReadFor(n, userId),
    ).length;
  }

  markAllRead(tenantId: string, orgId: string, userId: string): void {
    for (const n of this.items) {
      if (n.tenantId !== tenantId || n.orgId !== orgId || !this.visibleTo(n, userId)) continue;
      if (n.userId === null) n.readBy.add(userId);
      else n.read = true;
    }
  }

  /**
   * Remove the caller's notifications by id. Personal ones are deleted; broadcasts
   * are dismissed for this user only (kept for everyone else). Returns how many
   * the caller no longer sees.
   */
  remove(tenantId: string, orgId: string, userId: string, ids: string[]): number {
    const idSet = new Set(ids);
    let affected = 0;
    const keep: StoredNotification[] = [];
    for (const n of this.items) {
      const mine = n.tenantId === tenantId && n.orgId === orgId && idSet.has(n.id) && this.visibleTo(n, userId);
      if (!mine) {
        keep.push(n);
        continue;
      }
      affected++;
      if (n.userId === null) {
        n.dismissedBy.add(userId); // broadcast: hide for this user only
        keep.push(n);
      }
      // personal: drop it entirely (not pushed to `keep`)
    }
    this.items = keep;
    return affected;
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
  notifications.add({
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
  notifications.add({
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
      subject: "Quote sent",
      body: `Quote ${recordNumber(e)} was emailed to the customer.`,
      href: `/quote/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "quote_sent",
    }),
  );
  eventBus.subscribe("invoice.send", (e) =>
    deliver({
      event: e,
      userId: null,
      channel: "email",
      subject: "Invoice sent",
      body: `Invoice ${recordNumber(e)} was emailed to the customer.`,
      href: `/invoice/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "invoice_sent",
    }),
  );
  eventBus.subscribe("deal.win", (e) =>
    deliver({
      event: e,
      userId: null,
      channel: "system",
      subject: "Deal won 🎉",
      body: `A deal was marked won (${String(e.payload.id)}).`,
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
      subject: "Purchase order needs approval",
      body: `PO ${recordNumber(e)} is waiting for your approval.`,
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
      subject: "Purchase order approved",
      body: `PO ${recordNumber(e)} was approved and is ready to receive.`,
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
      subject: "Purchase order rejected",
      body: e.payload.reason
        ? `PO ${recordNumber(e)} was rejected: ${String(e.payload.reason)}`
        : `PO ${recordNumber(e)} was rejected.`,
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
      subject: "Goods received",
      body: `Goods receipt ${recordNumber(e)} was posted${e.payload.poNumber ? ` for PO ${String(e.payload.poNumber)}` : ""}.`,
      href: `/goodsReceipt/${encodeURIComponent(String(e.payload.id ?? ""))}`,
      prefKey: "goods_received",
    }),
  );

  logger.info("notifications registered", { events: 7 });
}
