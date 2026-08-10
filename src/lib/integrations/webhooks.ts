/**
 * Phase 9 / Automation — Webhook system.
 *
 * Tenant-scoped webhook endpoints subscribe to domain event types. Deliveries
 * are HMAC-signed (so receivers can verify authenticity), retried with backoff,
 * and recorded in a delivery log surfaced in the Automation screen.
 */
import { createHmac } from "node:crypto";
import { newId } from "@/lib/core/ids";
import { systemContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { MAX_PAGE_SIZE } from "@/lib/data/query";
import type { EntityRecord } from "@/lib/metadata/types";
import { logger } from "@/lib/observability/logger";
import { BadRequestError } from "@/lib/enforcement/errors";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { withRetry } from "@/lib/workflow/retry";

/** Whether a dotted-quad IPv4 (as 4 octets) is private/loopback/link-local. */
function isBlockedIpv4(o: readonly number[]): boolean {
  // Anything that is not four real octets is BLOCKED, not allowed through.
  // Every caller matches a four-group pattern first, so this cannot happen —
  // but the fallthrough at the end of this function is `return false`, so an
  // unparseable address would have been treated as public and fetched. A guard
  // that cannot identify a host has to refuse it; the alternative is deciding
  // an address is safe on the grounds that we could not read it.
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** Block private/loopback/link-local hosts to stop SSRF (e.g. cloud metadata at
 *  169.254.169.254, internal services on localhost or RFC-1918 ranges). Handles
 *  dotted IPv4, IPv6 loopback, unique-local/link-local IPv6, and IPv4-mapped IPv6
 *  in BOTH dotted (`::ffff:127.0.0.1`) and the hex form Node canonicalises to
 *  (`::ffff:7f00:1`). Decimal/hex/octal IPv4 literals are already normalised to
 *  dotted-quad by the URL parser before they reach here. DNS-rebinding (a public
 *  name resolving to a private IP) is out of scope. */
function isBlockedWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::" || h === "::1") return true;

  const dotted = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) return isBlockedIpv4(dotted.slice(1).map(Number));

  // IPv4-mapped IPv6: dotted tail (::ffff:127.0.0.1) or hex tail (::ffff:7f00:1).
  const mapped = h.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1] ?? "";
    const td = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (td) return isBlockedIpv4(td.slice(1).map(Number));
    const hx = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hx) {
      const hi = parseInt(hx[1] ?? "", 16);
      const lo = parseInt(hx[2] ?? "", 16);
      return isBlockedIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
    }
  }

  // IPv6 unique-local (fc00::/7) / link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || h.startsWith("fe80:")) return true;
  return false;
}

/** Validate a webhook target URL; throws BadRequestError if unsafe. */
export function assertSafeWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError("invalid webhook URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestError("webhook URL must use http or https");
  }
  if (isBlockedWebhookHost(url.hostname)) {
    throw new BadRequestError("webhook URL must not target a private, loopback or link-local address");
  }
  return url;
}

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  orgId: string;
  url: string;
  secret: string;
  events: string[];
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  tenantId: string;
  orgId: string;
  at: string;
  type: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * Database-backed webhook registry.
 *
 * Endpoints and their delivery log are rows, not process state. They used to be
 * two arrays: every restart silently deregistered every integration, and on more
 * than one instance an endpoint was only visible to the node that registered it.
 *
 * Reads and writes go through the query engine under a system context — these
 * are platform records, and access is admin-gated at the API layer.
 */
const ENDPOINT = "webhookEndpoint";
const DELIVERY = "webhookDelivery";

const sysCtx = (tenantId: string, orgId: string): RequestContext => systemContext(tenantId, orgId);

/** Tolerant parse: `events` is stored as JSON text and may predate a shape change. */
function parseEvents(raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === "") return ["*"];
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : ["*"];
  } catch {
    return ["*"];
  }
}

function toEndpoint(row: EntityRecord): WebhookEndpoint {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    orgId: String(row.orgId),
    url: String(row.url),
    secret: String(row.secret ?? ""),
    events: parseEvents(row.events),
    createdAt: String(row.createdAt),
  };
}

function toDelivery(row: EntityRecord): WebhookDelivery {
  return {
    id: String(row.id),
    endpointId: String(row.endpointId),
    tenantId: String(row.tenantId),
    orgId: String(row.orgId),
    at: String(row.at),
    type: String(row.type ?? ""),
    ok: Boolean(row.ok),
    status: row.status === null || row.status === undefined ? null : Number(row.status),
    error: row.error ? String(row.error) : undefined,
  };
}

export class WebhookRegistry {
  private async qe() {
    return getQueryEngine();
  }

  async register(input: Omit<WebhookEndpoint, "id" | "createdAt"> & { createdAt: string }): Promise<WebhookEndpoint> {
    assertSafeWebhookUrl(input.url); // reject SSRF targets at registration
    const qe = await this.qe();
    const row = await qe.create(sysCtx(input.tenantId, input.orgId), ENDPOINT, {
      url: input.url,
      secret: input.secret,
      events: JSON.stringify(input.events ?? ["*"]),
      active: true,
    });
    return toEndpoint(row);
  }

  /**
   * Delete an endpoint and its delivery history.
   *
   * The history has to go first: delivery rows reference the endpoint, so the
   * database refuses to remove one that has ever been used — and swallowing that
   * error reported "not found" for an endpoint sitting right there in the list.
   * Absence is the only thing that returns false; anything else propagates.
   */
  async remove(tenantId: string, orgId: string, id: string): Promise<boolean> {
    const qe = await this.qe();
    const ctx = sysCtx(tenantId, orgId);

    if (!(await this.get(tenantId, orgId, id))) return false;

    for (;;) {
      const page = await qe.list(ctx, DELIVERY, {
        filters: [{ field: "endpointId", op: "eq", value: id }],
        pageSize: MAX_PAGE_SIZE,
      });
      if (page.items.length === 0) break;
      await qe.removeMany(ctx, DELIVERY, page.items.map((r) => String(r.id)));
    }
    await qe.remove(ctx, ENDPOINT, id);
    return true;
  }

  async get(tenantId: string, orgId: string, id: string): Promise<WebhookEndpoint | undefined> {
    const qe = await this.qe();
    try {
      return toEndpoint(await qe.get(sysCtx(tenantId, orgId), ENDPOINT, id));
    } catch {
      return undefined;
    }
  }

  async list(tenantId: string, orgId: string): Promise<WebhookEndpoint[]> {
    const qe = await this.qe();
    const rows = await qe.listComplete(sysCtx(tenantId, orgId), ENDPOINT);
    return rows.map(toEndpoint);
  }

  /**
   * Endpoints subscribed to this event.
   *
   * Runs on every published domain event, so it is a filtered read of a small
   * admin-managed table rather than a scan — but it is still a database round
   * trip per event, which is the cost of endpoints surviving a restart.
   */
  async matching(event: DomainEvent): Promise<WebhookEndpoint[]> {
    const qe = await this.qe();
    const rows = await qe.listComplete(sysCtx(event.tenantId, event.orgId), ENDPOINT, {
      filters: [{ field: "active", op: "eq", value: true }],
    });
    return rows
      .map(toEndpoint)
      .filter((e) => e.events.includes("*") || e.events.includes(event.type));
  }

  async recordDelivery(d: Omit<WebhookDelivery, "id">): Promise<void> {
    const qe = await this.qe();
    try {
      await qe.create(sysCtx(d.tenantId, d.orgId), DELIVERY, {
        endpointId: d.endpointId,
        at: d.at,
        type: d.type,
        ok: d.ok,
        status: d.status,
        error: d.error ?? null,
      });
    } catch (error) {
      // The delivery log is a record of what happened, not part of it — failing
      // to write it must not turn a successful call into a failed one.
      logger.warn("webhook delivery not logged", {
        endpointId: d.endpointId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listDeliveries(tenantId: string, orgId: string, limit = 20): Promise<WebhookDelivery[]> {
    const qe = await this.qe();
    const capped = Math.min(Math.max(1, limit), 200);
    const page = await qe.list(
      sysCtx(tenantId, orgId),
      DELIVERY,
      { sort: [{ field: "at", dir: "desc" }], pageSize: capped },
      { maxPageSize: capped },
    );
    return page.items.map(toDelivery);
  }

  /**
   * Drop delivery rows older than `days`.
   *
   * The log grows with every event delivered to every endpoint, and nothing
   * reads a month-old attempt. Called by the retention job.
   */
  async pruneDeliveries(tenantId: string, orgId: string, days = 30): Promise<number> {
    const qe = await this.qe();
    const ctx = sysCtx(tenantId, orgId);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let removed = 0;
    // Delete in batches: `deleteMany` takes ids, and the set can be large.
    for (;;) {
      const page = await qe.list(ctx, DELIVERY, {
        filters: [{ field: "at", op: "lt", value: cutoff }],
        pageSize: MAX_PAGE_SIZE,
      });
      if (page.items.length === 0) return removed;
      removed += await qe.removeMany(ctx, DELIVERY, page.items.map((r) => String(r.id)));
    }
  }
}

export const webhookRegistry = new WebhookRegistry();

export function signWebhook(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function deliver(endpoint: WebhookEndpoint, event: DomainEvent): Promise<void> {
  const body = JSON.stringify({ id: event.id, type: event.type, at: event.at, payload: event.payload });
  const signature = signWebhook(body, endpoint.secret);
  let status: number | null = null;
  try {
    assertSafeWebhookUrl(endpoint.url); // defense-in-depth: never deliver to a blocked host
    await withRetry(
      async () => {
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-aula-signature": `sha256=${signature}`,
            "x-aula-event": event.type,
          },
          body,
        });
        status = res.status;
        if (!res.ok) throw new Error(`returned ${res.status}`);
      },
      { attempts: 3, baseMs: 100 },
    );
    await webhookRegistry.recordDelivery({
      endpointId: endpoint.id,
      tenantId: endpoint.tenantId,
      orgId: endpoint.orgId,
      at: event.at,
      type: event.type,
      ok: true,
      status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await webhookRegistry.recordDelivery({
      endpointId: endpoint.id,
      tenantId: endpoint.tenantId,
      orgId: endpoint.orgId,
      at: event.at,
      type: event.type,
      ok: false,
      status,
      error: message,
    });
    logger.error("webhook delivery failed", { url: endpoint.url, type: event.type, error: message });
  }
}

/** Deliver a synthetic ping to one endpoint (used by the "Test" button). */
export async function testWebhook(endpoint: WebhookEndpoint, at: string): Promise<void> {
  await deliver(endpoint, {
    id: newId("evt"),
    type: "ping",
    at,
    tenantId: endpoint.tenantId,
    orgId: endpoint.orgId,
    actorId: "system",
    correlationId: newId("cid"),
    payload: { message: "Aula CRM webhook test" },
  });
}

let registered = false;

export function registerWebhookDelivery(): void {
  if (registered) return;
  registered = true;
  eventBus.subscribe("*", async (event: DomainEvent) => {
    for (const endpoint of await webhookRegistry.matching(event)) await deliver(endpoint, event);
  });
}
