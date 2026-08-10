/**
 * The SAP exchange: staging, mapping, and idempotent receipt.
 *
 * The property worth the most here is that a redelivered message does nothing.
 * PI/PO redelivers whenever it is not certain the acknowledgement arrived —
 * including every case where it did and the reply was lost coming back — so
 * "apply this payment" WILL arrive twice. Applying it twice credits an invoice
 * that was already settled, and nobody finds it until a reconciliation months
 * later.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { queueOutbound, remoteIdFor, localIdFor, rememberMapping, backoffMs, MAX_ATTEMPTS } = await import("@/lib/erp/sync");
const { receiveMessage } = await import("@/lib/erp/inbound");
const { encode } = await import("@/lib/erp/codec");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;
const message = (messageType: string, payload: Record<string, unknown>, id?: string) =>
  encode(
    { header: { messageId: id ?? `SAP-${++seq}`, messageType, sentAt: "2026-08-09T10:00:00.000Z", source: "SAP" }, payload },
    "xml",
  );

const messagesFor = async (messageId: string) => {
  const qe = await getQueryEngine();
  return (await qe.list(ctx(), "erpMessage", { filters: [{ field: "messageId", op: "eq", value: messageId }], pageSize: 5 })).items;
};

// ---- mapping ---------------------------------------------------------------

test("a mapping resolves in both directions", () => {
  // Two systems that both own master data need a translation table: our product
  // 42 is SAP material 0000001234, and neither side will adopt the other's key.
  return (async () => {
    await rememberMapping(ctx(), "product", "42", "000000000000001234", "aula");
    assert.equal(await remoteIdFor(ctx(), "product", "42"), "000000000000001234");
    assert.equal(await localIdFor(ctx(), "product", "000000000000001234"), "42");
  })();
});

test("re-mapping the same record updates rather than duplicating", async () => {
  await rememberMapping(ctx(), "account", "7", "OLD-KEY", "aula");
  await rememberMapping(ctx(), "account", "7", "NEW-KEY", "sap");
  assert.equal(await remoteIdFor(ctx(), "account", "7"), "NEW-KEY");
  const qe = await getQueryEngine();
  const rows = await qe.listComplete(ctx(), "erpMapping", { filters: [{ field: "localId", op: "eq", value: "7" }] });
  assert.equal(rows.filter((r) => r.entityName === "account").length, 1, "one row, not two");
});

test("a SAP key keeps its leading zeros", async () => {
  // The padding IS the identifier. Storing it as a number loses it and every
  // subsequent lookup against SAP misses.
  await rememberMapping(ctx(), "product", "99", "0000000042", "sap");
  assert.equal(await remoteIdFor(ctx(), "product", "99"), "0000000042");
});

// ---- outbound staging ------------------------------------------------------

test("an outbound message is staged pending, with its payload already encoded", async () => {
  // Encoded at queue time so the row holds exactly what will be sent — a channel
  // reconfigured between queueing and sending must not silently change the bytes
  // the row claims to contain.
  const row = await queueOutbound(ctx(), "Product.Upsert", { Sku: "A1" }, { refType: "product", refId: "1" });
  assert.equal(row.status, "pending");
  assert.equal(row.direction, "outbound");
  assert.ok(String(row.payload).includes("A1"));
  assert.ok(String(row.messageId).startsWith("AULA-"), "our id, so an echo is recognisable");
});

test("backoff grows and then stops growing", async () => {
  // Retrying a downed PI/PO immediately turns a five-minute outage into a queue
  // full of attempts; retrying forever means a backlog nobody can distinguish
  // from one that is moving.
  assert.ok(backoffMs(1) < backoffMs(2));
  assert.ok(backoffMs(2) < backoffMs(3));
  assert.equal(backoffMs(99), backoffMs(50), "capped");
  assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 10);
});

// ---- inbound ---------------------------------------------------------------

test("a material from SAP creates a product and remembers its key", async () => {
  const body = message("Product.Upsert", { Matnr: "000000000000005555", Sku: "SAP-A", Name: "Somun", UnitPrice: 12.5 });
  const result = await receiveMessage(ctx(), body, "text/xml");
  assert.equal(result.status, "ok", result.detail);

  const qe = await getQueryEngine();
  const found = await qe.list(ctx(), "product", { filters: [{ field: "sku", op: "eq", value: "SAP-A" }], pageSize: 1 });
  assert.equal(found.items.length, 1);
  assert.equal(String(found.items[0]?.name), "Somun");
  assert.equal(await localIdFor(ctx(), "product", "000000000000005555"), String(found.items[0]?.id));
});

test("a second message about the same material updates it rather than duplicating", async () => {
  await receiveMessage(ctx(), message("Product.Upsert", { Matnr: "M-DUP", Sku: "DUP-1", Name: "First" }), "text/xml");
  await receiveMessage(ctx(), message("Product.Upsert", { Matnr: "M-DUP", Sku: "DUP-1", Name: "Second" }), "text/xml");
  const qe = await getQueryEngine();
  const found = await qe.listComplete(ctx(), "product", { filters: [{ field: "sku", op: "eq", value: "DUP-1" }] });
  assert.equal(found.length, 1, "one product");
  assert.equal(String(found[0]?.name), "Second", "updated");
});

test("a field SAP did not send is left alone, not blanked", async () => {
  // Omitting `UnitPrice` means "I am not telling you about the price", not "the
  // price is zero". Writing a zero wipes a price nobody asked to change.
  await receiveMessage(ctx(), message("Product.Upsert", { Matnr: "M-KEEP", Sku: "KEEP-1", Name: "N", UnitPrice: 40 }), "text/xml");
  await receiveMessage(ctx(), message("Product.Upsert", { Matnr: "M-KEEP", Sku: "KEEP-1", Name: "Renamed" }), "text/xml");
  const qe = await getQueryEngine();
  const found = await qe.listComplete(ctx(), "product", { filters: [{ field: "sku", op: "eq", value: "KEEP-1" }] });
  assert.equal(Number(found[0]?.unitPrice), 40, "the price survived a message that did not mention it");
  assert.equal(String(found[0]?.name), "Renamed");
});

test("THE property: a redelivered message is acknowledged and does nothing", async () => {
  const qe = await getQueryEngine();
  const account = await qe.create(ctx(), "account", { name: "Idem A.Ş." });
  const { getFinanceService } = await import("@/lib/finance/service");
  const finance = await getFinanceService();
  const invoice = await finance.createDocument(ctx(), "invoice", "INV", {
    accountId: String(account.id),
    status: "draft",
    issueDate: "2026-08-01",
  });
  await finance.replaceLines(ctx(), "invoice", "invoiceLine", "invoiceId", invoice.id, [
    { productId: null, description: "Goods", qty: 1, unitPrice: 500, taxRate: 0 },
  ]);
  const number = String((await qe.get(ctx(), "invoice", invoice.id)).number);

  const body = message("Payment.Post", { DocumentNumber: number, Amount: 500, PaidAt: "2026-08-05" }, "SAP-PAY-1");
  const first = await receiveMessage(ctx(), body, "text/xml");
  assert.equal(first.status, "ok", first.detail);
  assert.equal(first.duplicate, false);

  // PI/PO re-sends the identical message — its acknowledgement was lost.
  const second = await receiveMessage(ctx(), body, "text/xml");
  assert.equal(second.status, "ok", "acknowledged, so PI/PO stops asking");
  assert.equal(second.duplicate, true);

  const after = await qe.get(ctx(), "invoice", invoice.id);
  assert.equal(Number(after.amountPaid), 500, "paid once, not twice");
  assert.equal(Number(after.balance), 0);
});

test("a payment for an unknown invoice is refused, not applied somewhere plausible", async () => {
  // Matching on amount and date instead of the document number would credit
  // whichever invoice happened to look similar — and two customers paying the
  // same amount on the same day is not unusual.
  const result = await receiveMessage(ctx(), message("Payment.Post", { DocumentNumber: "INV-NOPE", Amount: 10 }), "text/xml");
  assert.equal(result.status, "error");
  assert.match(String(result.detail), /no invoice numbered/);
});

test("an unknown interface is recorded and refused", async () => {
  const result = await receiveMessage(ctx(), message("Something.Else", { X: 1 }, "SAP-UNKNOWN"), "text/xml");
  assert.equal(result.status, "error");
  const rows = await messagesFor("SAP-UNKNOWN");
  assert.equal(rows.length, 1, "recorded, so the operator can see what arrived");
  assert.equal(rows[0]?.status, "failed");
});

test("an unreadable body is refused without a message row", async () => {
  // There is no message id to correlate on and nothing to record against.
  const result = await receiveMessage(ctx(), "<<< not xml", "text/xml");
  assert.equal(result.status, "error");
  assert.equal(result.messageId, "");
});

test("JSON and XML deliveries of the same interface behave identically", async () => {
  // A real VKN — the check digit is validated, and rightly so: an invalid one
  // produces an invoice e-Fatura rejects later and more expensively.
  const payload = { Kunnr: "KUN-1", Name: "JSON Müşteri A.Ş.", TaxNumber: "1000000006" };
  const asJson = encode({ header: { messageId: "SAP-J1", messageType: "Partner.Upsert", sentAt: "x", source: "SAP" }, payload }, "json");
  const result = await receiveMessage(ctx(), asJson, "application/json");
  assert.equal(result.status, "ok", result.detail);
  assert.equal(result.format, "json", "and the acknowledgement goes back in JSON");

  const qe = await getQueryEngine();
  const found = await qe.listComplete(ctx(), "account", { filters: [{ field: "name", op: "eq", value: "JSON Müşteri A.Ş." }] });
  assert.equal(found.length, 1);
  assert.equal(String(found[0]?.taxNumber), "1000000006");
});

test("every delivery is recorded, whatever happened to it", async () => {
  // "Did that message arrive, and what did we do with it?" is the first question
  // when the two systems disagree, and answering it from application logs means
  // grepping a file nobody has access to.
  await receiveMessage(ctx(), message("Product.Upsert", { Matnr: "M-LOG", Sku: "LOG-1", Name: "L" }, "SAP-LOG-1"), "text/xml");
  const rows = await messagesFor("SAP-LOG-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.direction, "inbound");
  assert.equal(rows[0]?.status, "received");
  assert.ok(String(rows[0]?.payload).includes("M-LOG"), "the bytes as they arrived");
});

test("a partner with an invalid tax number is refused, with the reason recorded", async () => {
  // SAP is the master for partner data, but a tax number that fails its check
  // digit cannot produce a legal invoice — e-Fatura would reject it later, at
  // more cost. Failing here, visibly, sends it back to be fixed at the source.
  const bad = encode(
    { header: { messageId: "SAP-BADVKN", messageType: "Partner.Upsert", sentAt: "x", source: "SAP" },
      payload: { Kunnr: "KUN-BAD", Name: "Hatalı VKN A.Ş.", TaxNumber: "1234567890" } },
    "xml",
  );
  const result = await receiveMessage(ctx(), bad, "text/xml");
  assert.equal(result.status, "error");

  const rows = await messagesFor("SAP-BADVKN");
  assert.equal(rows[0]?.status, "failed");
  assert.ok(String(rows[0]?.error).length > 0, "with the reason, so somebody can act on it");

  const qe = await getQueryEngine();
  const created = await qe.listComplete(ctx(), "account", { filters: [{ field: "name", op: "eq", value: "Hatalı VKN A.Ş." }] });
  assert.equal(created.length, 0, "and nothing half-written");
});
