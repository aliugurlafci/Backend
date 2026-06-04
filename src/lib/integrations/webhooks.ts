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
import { eventBus, type DomainEvent } from "@/lib/workflow/event-bus";
import { withRetry } from "@/lib/workflow/retry";

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
