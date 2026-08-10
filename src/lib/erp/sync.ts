/**
 * Talking to SAP through PI/PO.
 *
 * Outbound is staged, never sent inline. A message row is written when the
 * business change happens and a dispatcher sends it afterwards, because the two
 * cannot be made atomic: PI/PO is a separate system reached over a network, and
 * "post the invoice and tell SAP" as one operation means either holding a
 * database transaction open across an HTTP call, or discovering months later
 * that some invoices were never transmitted. Staging turns "did it send?" from
 * a question nobody can answer into a row with a status.
 *
 * Inbound is idempotent on the message id. PI/PO redelivers whenever it is
 * unsure the acknowledgement arrived — including when it did — so "apply this
 * payment" WILL be delivered twice eventually, and applying it twice is real
 * money in the wrong place.
 */
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";
import { getQueryEngine } from "@/lib/data/store";
import { automationStore } from "@/lib/automation/store";
import { logger } from "@/lib/observability/logger";
import { BadRequestError } from "@/lib/enforcement/errors";
import { httpRequest, str, num, normBase } from "@/lib/integrations/transport-util";
import { encode, type ErpEnvelope, type ErpFormat } from "./codec";
import { OUTBOUND_ENTITY, type OutboundType } from "./messages";

const MESSAGE = "erpMessage";
const MAPPING = "erpMapping";

/**
 * How many times a message is retried before it stops trying.
 *
 * Bounded, and dead-lettered rather than retried forever: a message SAP rejects
 * for a business reason — an unknown material, a closed period — will be
 * rejected identically on the thousandth attempt, and a queue that never gives
 * up is one whose backlog nobody can distinguish from a backlog that is moving.
 */
export const MAX_ATTEMPTS = 6;

/** Exponential, from a minute. Attempt 6 waits about half an hour. */
export function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

export interface ErpConfig {
  enabled: boolean;
  baseUrl: string;
  format: ErpFormat;
  username: string;
  password: string;
  timeoutMs: number;
}

/**
 * The tenant's PI/PO channel configuration.
 *
 * Read per dispatch rather than cached: a channel URL changes when the SAP team
 * moves an interface, and a cache would keep posting into the void until the
 * next restart.
 */
export async function erpConfig(ctx: RequestContext): Promise<ErpConfig> {
  const state = await automationStore.getIntegration(ctx.tenantId, ctx.orgId, "erp");
  const c = state.config;
  const format = str(c, "format") === "json" ? "json" : "xml";
  return {
    enabled: Boolean(state.enabled),
    baseUrl: normBase(str(c, "baseUrl")),
    format,
    username: str(c, "username"),
    password: str(c, "password"),
    timeoutMs: num(c, "timeoutMs", 30_000),
  };
}

const mapKey = (entityName: string, localId: string): string => `${entityName}:${localId}`;

/** The SAP key for one of our records, if we have ever learned it. */
export async function remoteIdFor(ctx: RequestContext, entityName: string, localId: string): Promise<string | null> {
  const qe = await getQueryEngine();
  const page = await qe.list(ctx, MAPPING, {
    filters: [{ field: "mapKey", op: "eq", value: mapKey(entityName, localId) }],
    pageSize: 1,
  });
  const row = page.items[0];
  return row ? String(row.remoteId) : null;
}

/** Our record for a SAP key, if there is one. */
export async function localIdFor(ctx: RequestContext, entityName: string, remoteId: string): Promise<string | null> {
  const qe = await getQueryEngine();
  const page = await qe.list(ctx, MAPPING, {
    filters: [
      { field: "entityName", op: "eq", value: entityName },
      { field: "remoteId", op: "eq", value: remoteId },
    ],
    pageSize: 1,
  });
  const row = page.items[0];
  return row ? String(row.localId) : null;
}

/** Record (or refresh) the correspondence between one of ours and one of SAP's. */
export async function rememberMapping(
  ctx: RequestContext,
  entityName: string,
  localId: string,
  remoteId: string,
  writtenBy: "aula" | "sap",
): Promise<void> {
  const qe = await getQueryEngine();
  const key = mapKey(entityName, localId);
  const existing = await qe.list(ctx, MAPPING, { filters: [{ field: "mapKey", op: "eq", value: key }], pageSize: 1 });
  const row = existing.items[0];
  const values = { remoteId, lastSyncedAt: ctx.at, lastSyncedBy: writtenBy };
  if (row) {
    await qe.patchComputed(ctx, MAPPING, String(row.id), values);
    return;
  }
  try {
    await qe.createWithComputed(ctx, MAPPING, { mapKey: key, entityName, localId, ...values }, {});
  } catch {
    // Lost a race with another writer creating the same mapping. The unique
    // index on `mapKey` is what makes that a conflict rather than a duplicate,
    // and the winner wrote the same correspondence.
  }
}

/**
 * Stage an outbound message.
 *
 * Returns the row. Deliberately does not send: the caller is usually inside the
 * transaction that made the change, and an HTTP call there would either hold
 * the transaction open across the network or commit before the change did.
 */
export async function queueOutbound(
  ctx: RequestContext,
  messageType: OutboundType,
  payload: Record<string, unknown>,
  ref: { refType: string; refId: string },
): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const config = await erpConfig(ctx);
  const messageId = `AULA-${randomUUID()}`;
  const envelope: ErpEnvelope = {
    header: { messageId, messageType, sentAt: ctx.at, source: "AULA" },
    payload,
  };
  // Encoded at queue time, so what is stored is exactly what will be sent — and
  // a channel reconfigured between queueing and sending does not silently
  // change the bytes a message row claims to hold.
  return qe.createWithComputed(
    ctx,
    MESSAGE,
    {
      messageId,
      direction: "outbound",
      messageType,
      status: "pending",
      format: config.format,
      refType: ref.refType,
      refId: ref.refId,
      payload: encode(envelope, config.format),
      attempts: 0,
      nextAttemptAt: ctx.at,
    },
    {},
  );
}

export interface DispatchResult {
  sent: number;
  failed: number;
  dead: number;
  skipped: number;
}

/**
 * Send every message that is due.
 *
 * Due means pending or failed with its backoff elapsed. A failed message is not
 * retried immediately: PI/PO being down is the common cause, and hammering it
 * turns a five-minute outage into a queue full of attempts.
 */
export async function dispatchOutbound(ctx: RequestContext, limit = 50): Promise<DispatchResult> {
  const qe = await getQueryEngine();
  const result: DispatchResult = { sent: 0, failed: 0, dead: 0, skipped: 0 };
  const config = await erpConfig(ctx);
  if (!config.enabled || !config.baseUrl) {
    // Not an error: the integration is simply not configured. Messages keep
    // accumulating and go out when it is — which is the point of staging them.
    return result;
  }

  const due = await qe.list(ctx, MESSAGE, {
    filters: [
      { field: "direction", op: "eq", value: "outbound" },
      { field: "status", op: "in", value: ["pending", "failed"] },
      { field: "nextAttemptAt", op: "lte", value: ctx.at },
    ],
    sort: [{ field: "createdAt", dir: "asc" }],
    pageSize: limit,
  });

  for (const message of due.items) {
    const attempts = Number(message.attempts ?? 0) + 1;
    try {
      const res = await httpRequest(
        config.baseUrl,
        {
          method: "POST",
          headers: {
            "content-type": config.format === "json" ? "application/json" : "text/xml; charset=utf-8",
            accept: config.format === "json" ? "application/json" : "text/xml",
            ...(config.username
              ? { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` }
              : {}),
          },
          body: String(message.payload ?? ""),
        },
        config.timeoutMs,
      );

      // The body is read once, here: a `Response` can only be consumed once,
      // and both the success and the failure path want it — the acknowledgement
      // on success, the rejection reason on failure.
      const body = await res.text().catch(() => "");

      if (res.status >= 200 && res.status < 300) {
        await qe.patchComputed(ctx, MESSAGE, String(message.id), {
          status: "sent",
          httpStatus: res.status,
          response: body.slice(0, 4000),
          attempts,
          sentAt: ctx.at,
          completedAt: ctx.at,
          error: null,
        });
        result.sent += 1;
        continue;
      }

      // A 4xx is SAP refusing the content, and it will refuse it identically
      // next time — retrying is pure noise. A 5xx is the middleware having a
      // bad day, which is exactly what backoff is for.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      await failMessage(ctx, message, attempts, `HTTP ${res.status}`, body, res.status, permanent);
      if (permanent || attempts >= MAX_ATTEMPTS) result.dead += 1;
      else result.failed += 1;
    } catch (e) {
      await failMessage(ctx, message, attempts, e instanceof Error ? e.message : String(e), null, null, false);
      if (attempts >= MAX_ATTEMPTS) result.dead += 1;
      else result.failed += 1;
    }
  }

  if (result.sent || result.failed || result.dead) logger.info("erp dispatch", { ...result });
  return result;
}

async function failMessage(
  ctx: RequestContext,
  message: EntityRecord,
  attempts: number,
  error: string,
  body: string | null,
  httpStatus: number | null,
  permanent: boolean,
): Promise<void> {
  const qe = await getQueryEngine();
  const exhausted = permanent || attempts >= MAX_ATTEMPTS;
  await qe.patchComputed(ctx, MESSAGE, String(message.id), {
    status: exhausted ? "dead" : "failed",
    attempts,
    error: error.slice(0, 2000),
    response: body ? body.slice(0, 4000) : null,
    httpStatus,
    // A dead message has no next attempt. Leaving one set would make it look
    // due forever to anything scanning the queue.
    nextAttemptAt: exhausted ? null : new Date(Date.parse(ctx.at) + backoffMs(attempts)).toISOString(),
    completedAt: exhausted ? ctx.at : null,
  });
}

/** Put a dead-lettered message back in the queue — after somebody fixed the cause. */
export async function retryMessage(ctx: RequestContext, id: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const message = await qe.get(ctx, MESSAGE, id);
  if (String(message.direction) !== "outbound") {
    throw new BadRequestError("only an outbound message can be resent");
  }
  // Attempts reset: a person has looked at it and changed something, so the
  // backoff earned by the previous cause no longer applies.
  return qe.patchComputed(ctx, MESSAGE, id, {
    status: "pending",
    attempts: 0,
    nextAttemptAt: ctx.at,
    error: null,
    completedAt: null,
  });
}

/**
 * Build and queue the message for one record.
 *
 * The single entry point for "send this to SAP", used by the manual sync
 * endpoint and by the automatic triggers, so both produce identical messages.
 */
export async function queueRecord(ctx: RequestContext, messageType: OutboundType, id: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const entityName = OUTBOUND_ENTITY[messageType];
  const record = await qe.get(ctx, entityName, id);
  const remoteId = (await remoteIdFor(ctx, entityName, id)) ?? undefined;
  const { invoicePayload, partnerPayload, productPayload, stockMovementPayload } = await import("./messages");

  let payload: Record<string, unknown>;
  switch (messageType) {
    case "Product.Upsert":
      payload = productPayload(record, remoteId);
      break;
    case "Partner.Upsert":
      payload = partnerPayload(record, remoteId);
      break;
    case "StockMovement.Post":
      payload = stockMovementPayload(record, (await remoteIdFor(ctx, "product", String(record.productId))) ?? undefined);
      break;
    case "Invoice.Post":
    default: {
      const lines = await qe.listComplete(ctx, "invoiceLine", {
        filters: [{ field: "invoiceId", op: "eq", value: id }],
      });
      const partner = record.accountId ? await remoteIdFor(ctx, "account", String(record.accountId)) : null;
      payload = invoicePayload(record, lines, partner ?? undefined);
      break;
    }
  }
  return queueOutbound(ctx, messageType, payload, { refType: entityName, refId: id });
}
