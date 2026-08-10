/**
 * Messages arriving from SAP through PI/PO.
 *
 * Idempotent on the message id, and that is the whole design. PI/PO redelivers
 * whenever it is not certain the acknowledgement arrived — including every case
 * where it did and the reply was lost on the way back — so "apply this payment"
 * WILL arrive twice. Applying it twice is money credited against an invoice that
 * was already settled, and nobody finds it until a reconciliation months later.
 *
 * The unique index on `erpMessage.messageId` is the guarantee, not a helpful
 * check: two instances behind a load balancer can receive the same redelivery at
 * the same moment, and only one insert can win.
 */
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { getDomainService } from "@/lib/domain";
import { getFinanceService } from "@/lib/finance/service";
import { logger } from "@/lib/observability/logger";
import { decode, ErpDecodeError, type ErpEnvelope, type ErpFormat } from "./codec";
import { isInboundType, readPartner, readPayment, readProduct } from "./messages";
import { localIdFor, rememberMapping } from "./sync";

const MESSAGE = "erpMessage";

export interface InboundResult {
  /** What to reply with. PI/PO correlates on this. */
  messageId: string;
  format: ErpFormat;
  status: "ok" | "error";
  detail?: string;
  /** True when this exact message had already been applied. */
  duplicate: boolean;
}

/**
 * Accept, record and apply one message.
 *
 * Recorded BEFORE it is applied. If the insert wins, this delivery owns the
 * message and does the work; if it conflicts, some other delivery already did,
 * and this one acknowledges without touching anything. Applying first and
 * recording after would leave a window where a crash loses the record but keeps
 * the effect — and the redelivery would then apply it a second time.
 */
export async function receiveMessage(
  ctx: RequestContext,
  body: string,
  contentType?: string,
): Promise<InboundResult> {
  let envelope: ErpEnvelope;
  let format: ErpFormat;
  try {
    const decoded = decode(body, contentType);
    envelope = decoded.envelope;
    format = decoded.format;
  } catch (e) {
    // Undecodable, so there is no message id to correlate on and nothing to
    // record against. The only honest reply is a plain error.
    const detail = e instanceof ErpDecodeError ? e.message : "could not read message";
    logger.warn("erp inbound rejected", { detail });
    return { messageId: "", format: contentType?.includes("json") ? "json" : "xml", status: "error", detail, duplicate: false };
  }

  const { messageId, messageType } = envelope.header;
  const qe = await getQueryEngine();

  if (!isInboundType(messageType)) {
    await record(ctx, envelope, format, body, "failed", `unknown interface "${messageType}"`);
    return { messageId, format, status: "error", detail: `unknown interface "${messageType}"`, duplicate: false };
  }

  // Claim the message. A unique violation means somebody already has it.
  try {
    await qe.createWithComputed(
      ctx,
      MESSAGE,
      {
        messageId,
        direction: "inbound",
        messageType,
        status: "pending",
        format,
        payload: body.slice(0, 60_000),
        attempts: 1,
      },
      {},
    );
  } catch {
    // Already delivered. Acknowledged as success, deliberately: PI/PO asked
    // "did you get this?", and the answer is yes. Replying with an error would
    // make it redeliver forever.
    logger.info("erp inbound duplicate ignored", { messageId, messageType });
    return { messageId, format, status: "ok", detail: "already applied", duplicate: true };
  }

  try {
    const detail = await apply(ctx, messageType, envelope.payload);
    await complete(ctx, messageId, "received", detail);
    return { messageId, format, status: "ok", detail, duplicate: false };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await complete(ctx, messageId, "failed", detail);
    logger.warn("erp inbound failed", { messageId, messageType, error: detail });
    // An error reply is right here: the message was understood and could not be
    // applied, so PI/PO should retry it or raise it to an operator.
    return { messageId, format, status: "error", detail, duplicate: false };
  }
}

/** Apply one message, returning what it did. */
async function apply(ctx: RequestContext, messageType: string, payload: Record<string, unknown>): Promise<string> {
  switch (messageType) {
    case "Product.Upsert":
      return upsertProduct(ctx, payload);
    case "Partner.Upsert":
      return upsertPartner(ctx, payload);
    case "Payment.Post":
      return postPayment(ctx, payload);
    default:
      throw new Error(`unhandled interface "${messageType}"`);
  }
}

/**
 * A material from SAP.
 *
 * Matched by the mapping first, then by SKU. The mapping is authoritative
 * because it survives a rename; the SKU is the fallback for the first message
 * about a material we already hold, which is how the two systems get introduced
 * without anyone entering a mapping table by hand.
 */
async function upsertProduct(ctx: RequestContext, payload: Record<string, unknown>): Promise<string> {
  const parsed = readProduct(payload);
  if (!parsed) throw new Error("product message carries neither Matnr nor Sku");
  const qe = await getQueryEngine();
  const domain = await getDomainService();

  let localId = parsed.remoteId ? await localIdFor(ctx, "product", parsed.remoteId) : null;
  if (!localId && parsed.sku) {
    const bySku = await qe.list(ctx, "product", { filters: [{ field: "sku", op: "eq", value: parsed.sku }], pageSize: 1 });
    localId = bySku.items[0] ? String(bySku.items[0].id) : null;
  }

  if (localId) {
    await domain.update(ctx, "product", localId, parsed.fields);
  } else {
    // A material we have never seen.
    //
    // `trackStock` defaults on because a SAP material master record is a stocked
    // item unless told otherwise, and creating it untracked would silently keep
    // it out of inventory.
    //
    // `unitPrice` defaults to 0 because our schema requires one and SAP's
    // material master often does not carry a sales price at all — that lives in
    // condition records, a separate object on a separate interface. Refusing the
    // material because it arrived without a price means it does not exist here
    // at all, which is far worse than existing at zero where somebody can see it
    // needs pricing. The default applies ONLY on create: an update that omits
    // the price leaves whatever we already had.
    const created = await domain.create(ctx, "product", { trackStock: true, unitPrice: 0, ...parsed.fields });
    localId = String(created.id);
  }
  if (parsed.remoteId) await rememberMapping(ctx, "product", localId, parsed.remoteId, "sap");
  return `product ${localId}`;
}

/** A business partner from SAP, matched by mapping then by exact name. */
async function upsertPartner(ctx: RequestContext, payload: Record<string, unknown>): Promise<string> {
  const parsed = readPartner(payload);
  if (!parsed) throw new Error("partner message carries neither Kunnr nor Name");
  const qe = await getQueryEngine();
  const domain = await getDomainService();

  let localId = parsed.remoteId ? await localIdFor(ctx, "account", parsed.remoteId) : null;
  if (!localId && parsed.name) {
    const byName = await qe.list(ctx, "account", { filters: [{ field: "name", op: "eq", value: parsed.name }], pageSize: 1 });
    localId = byName.items[0] ? String(byName.items[0].id) : null;
  }

  if (localId) await domain.update(ctx, "account", localId, parsed.fields);
  else localId = String((await domain.create(ctx, "account", parsed.fields)).id);

  if (parsed.remoteId) await rememberMapping(ctx, "account", localId, parsed.remoteId, "sap");
  return `account ${localId}`;
}

/**
 * A payment collected in SAP, applied against our invoice.
 *
 * Identified by OUR document number, which SAP has because we sent it on
 * `Invoice.Post`. Matching on amount and date instead would credit whichever
 * invoice happened to look similar — and two customers paying the same amount
 * on the same day is not unusual.
 */
async function postPayment(ctx: RequestContext, payload: Record<string, unknown>): Promise<string> {
  const parsed = readPayment(payload);
  if (!parsed) throw new Error("payment message needs a DocumentNumber and a positive Amount");
  const qe = await getQueryEngine();
  const found = await qe.list(ctx, "invoice", {
    filters: [{ field: "number", op: "eq", value: parsed.documentNumber }],
    pageSize: 1,
  });
  const invoice = found.items[0];
  if (!invoice) throw new Error(`no invoice numbered "${parsed.documentNumber}"`);

  const finance = await getFinanceService();
  await finance.applyPayment(ctx, String(invoice.id), {
    amount: parsed.amount,
    method: parsed.method,
    paidAt: parsed.paidAt,
    notes: parsed.reference ? `SAP ${parsed.reference}` : "Posted from SAP",
  });
  return `payment ${parsed.amount} against invoice ${String(invoice.number)}`;
}

async function record(
  ctx: RequestContext,
  envelope: ErpEnvelope,
  format: ErpFormat,
  body: string,
  status: string,
  error: string,
): Promise<void> {
  const qe = await getQueryEngine();
  try {
    await qe.createWithComputed(
      ctx,
      MESSAGE,
      {
        messageId: envelope.header.messageId,
        direction: "inbound",
        messageType: envelope.header.messageType,
        status,
        format,
        payload: body.slice(0, 60_000),
        error: error.slice(0, 2000),
        attempts: 1,
        completedAt: ctx.at,
      },
      {},
    );
  } catch {
    /* already recorded — a redelivery of something we already rejected */
  }
}

async function complete(ctx: RequestContext, messageId: string, status: string, detail: string): Promise<void> {
  const qe = await getQueryEngine();
  const found = await qe.list(ctx, MESSAGE, { filters: [{ field: "messageId", op: "eq", value: messageId }], pageSize: 1 });
  const row = found.items[0];
  if (!row) return;
  await qe.patchComputed(ctx, MESSAGE, String(row.id), {
    status,
    completedAt: ctx.at,
    ...(status === "failed" ? { error: detail.slice(0, 2000) } : { response: detail.slice(0, 4000) }),
  });
}
