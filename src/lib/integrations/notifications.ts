/**
 * Automation — notification simulation.
 *
 * Subscribes to domain events and "sends" notifications into an in-memory inbox
 * (emails to customers, system alerts to the team). In production these handlers
 * would call a real email/push provider; here they populate the topbar bell.
 */
import { newId } from "@/lib/core/ids";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { logger } from "@/lib/observability/logger";

export type NotificationChannel = "email" | "system";

export interface Notification {
  id: string;
  at: string;
  tenantId: string;
  orgId: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  eventType: string;
  read: boolean;
  /** Deep link the topbar bell navigates to when the notification is clicked. */
  href?: string;
}

export class NotificationService {
  private items: Notification[] = [];

  add(input: Omit<Notification, "id" | "read">): Notification {
    const n: Notification = { id: newId("ntf"), read: false, ...input };
    this.items.unshift(n);
    if (this.items.length > 300) this.items.length = 300;
    logger.info("notification", { channel: n.channel, subject: n.subject, tenantId: n.tenantId });
    return n;
  }

  list(tenantId: string, orgId: string, limit = 20): Notification[] {
    return this.items.filter((n) => n.tenantId === tenantId && n.orgId === orgId).slice(0, limit);
  }

  unreadCount(tenantId: string, orgId: string): number {
    return this.items.filter((n) => n.tenantId === tenantId && n.orgId === orgId && !n.read).length;
  }

  markAllRead(tenantId: string, orgId: string): void {
    for (const n of this.items) {
      if (n.tenantId === tenantId && n.orgId === orgId) n.read = true;
    }
  }

  /** Remove the caller's notifications by id (single or bulk). Returns how many were removed. */
  remove(tenantId: string, orgId: string, ids: string[]): number {
    const idSet = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter(
      (n) => !(n.tenantId === tenantId && n.orgId === orgId && idSet.has(n.id)),
    );
    return before - this.items.length;
  }
}

export const notifications = new NotificationService();

function recordNumber(e: DomainEvent): string {
  const record = e.payload.record as { number?: string } | undefined;
  return record?.number ?? String(e.payload.id ?? "");
}

let registered = false;

export function registerNotifications(): void {
  if (registered) return;
  registered = true;

  const base = (e: DomainEvent, channel: NotificationChannel, subject: string, body: string) => ({
    at: e.at,
    tenantId: e.tenantId,
    orgId: e.orgId,
    channel,
    subject,
    body,
    eventType: e.type,
  });

  const focusLink = (entity: string, id: unknown) => `/${entity}?focus=${encodeURIComponent(String(id ?? ""))}`;

  eventBus.subscribe("quote.send", (e) => {
    notifications.add({
      ...base(e, "email", "Quote sent", `Quote ${recordNumber(e)} was emailed to the customer.`),
      href: `/quote/${encodeURIComponent(String(e.payload.id ?? ""))}`,
    });
  });
  eventBus.subscribe("invoice.send", (e) => {
    notifications.add({
      ...base(e, "email", "Invoice sent", `Invoice ${recordNumber(e)} was emailed to the customer.`),
      href: `/invoice/${encodeURIComponent(String(e.payload.id ?? ""))}`,
    });
  });
  eventBus.subscribe("deal.win", (e) => {
    notifications.add({
      ...base(e, "system", "Deal won 🎉", `A deal was marked won (${String(e.payload.id)}).`),
      href: focusLink("deal", e.payload.id),
    });
  });
  eventBus.subscribe("lead.converted", (e) => {
    notifications.add({
      ...base(e, "system", "Lead converted", `A lead was converted to an account, contact and deal.`),
      href: focusLink("lead", e.payload.id),
    });
  });

  logger.info("notifications registered", { count: 4 });
}
