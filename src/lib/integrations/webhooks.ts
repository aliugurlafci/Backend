/**
 * Phase 9 / Automation — Webhook system.
 *
 * Tenant-scoped webhook endpoints subscribe to domain event types. Deliveries
 * are HMAC-signed (so receivers can verify authenticity), retried with backoff,
 * and recorded in a delivery log surfaced in the Automation screen.
 */
import { createHmac } from "node:crypto";
import { newId } from "@/lib/core/ids";
import { logger } from "@/lib/observability/logger";
import { BadRequestError } from "@/lib/enforcement/errors";
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { withRetry } from "@/lib/workflow/retry";

/** Whether a dotted-quad IPv4 (as 4 octets) is private/loopback/link-local. */
function isBlockedIpv4(o: number[]): boolean {
  const [a, b] = o;
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
    const tail = mapped[1];
    const td = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (td) return isBlockedIpv4(td.slice(1).map(Number));
    const hx = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hx) {
      const hi = parseInt(hx[1], 16);
      const lo = parseInt(hx[2], 16);
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

export class WebhookRegistry {
  private endpoints: WebhookEndpoint[] = [];
  private deliveries: WebhookDelivery[] = [];

  register(input: Omit<WebhookEndpoint, "id" | "createdAt"> & { createdAt: string }): WebhookEndpoint {
    assertSafeWebhookUrl(input.url); // reject SSRF targets at registration
    const endpoint = { id: newId("wh"), ...input };
    this.endpoints.push(endpoint);
    return endpoint;
  }

  remove(tenantId: string, orgId: string, id: string): boolean {
    const before = this.endpoints.length;
    this.endpoints = this.endpoints.filter(
      (e) => !(e.id === id && e.tenantId === tenantId && e.orgId === orgId),
    );
    return this.endpoints.length < before;
  }

  get(tenantId: string, orgId: string, id: string): WebhookEndpoint | undefined {
    return this.endpoints.find((e) => e.id === id && e.tenantId === tenantId && e.orgId === orgId);
  }

  list(tenantId: string, orgId: string): WebhookEndpoint[] {
    return this.endpoints.filter((e) => e.tenantId === tenantId && e.orgId === orgId);
  }

  matching(event: DomainEvent): WebhookEndpoint[] {
    return this.endpoints.filter(
      (e) =>
        e.tenantId === event.tenantId &&
        e.orgId === event.orgId &&
        (e.events.includes("*") || e.events.includes(event.type)),
    );
  }

  recordDelivery(d: Omit<WebhookDelivery, "id">): void {
    this.deliveries.unshift({ id: newId("whd"), ...d });
    if (this.deliveries.length > 200) this.deliveries.length = 200;
  }

  listDeliveries(tenantId: string, orgId: string, limit = 20): WebhookDelivery[] {
    return this.deliveries.filter((d) => d.tenantId === tenantId && d.orgId === orgId).slice(0, limit);
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
    webhookRegistry.recordDelivery({
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
    webhookRegistry.recordDelivery({
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
    for (const endpoint of webhookRegistry.matching(event)) await deliver(endpoint, event);
  });
}
