/**
 * What each SAP interface carries.
 *
 * One module holding both directions of every interface, because the two halves
 * have to agree and keeping them apart is how they stop agreeing: the field we
 * send as `Sku` gets read back as `MaterialCode` and neither side is wrong on
 * its own.
 *
 * PascalCase field names throughout — that is how SAP interfaces are named, and
 * matching their convention means the mapping in PI/PO is an identity mapping
 * rather than a rename per field, which is one less place for a typo to live.
 *
 * Money and quantities go across as numbers. Dates go as ISO-8601 strings, not
 * SAP's `YYYYMMDD`: the conversion belongs in the PI/PO mapping where it can be
 * changed without a deploy, and ISO is unambiguous about what it means.
 */
import type { EntityRecord } from "@/lib/metadata/types";

/** Interfaces we send. */
export const OUTBOUND_TYPES = ["Product.Upsert", "Partner.Upsert", "Invoice.Post", "StockMovement.Post"] as const;
/** Interfaces we accept. */
export const INBOUND_TYPES = ["Product.Upsert", "Partner.Upsert", "Payment.Post"] as const;

export type OutboundType = (typeof OUTBOUND_TYPES)[number];
export type InboundType = (typeof INBOUND_TYPES)[number];

export const isInboundType = (t: string): t is InboundType => (INBOUND_TYPES as readonly string[]).includes(t);

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * Which entity each outbound interface is about.
 *
 * Drives both the trigger wiring and the mapping lookup, so an interface cannot
 * be added without saying what it maps.
 */
export const OUTBOUND_ENTITY: Record<OutboundType, string> = {
  "Product.Upsert": "product",
  "Partner.Upsert": "account",
  "Invoice.Post": "invoice",
  "StockMovement.Post": "stockMovement",
};

/** A product as SAP material master fields. */
export function productPayload(product: EntityRecord, remoteId?: string): Record<string, unknown> {
  return {
    // Present only once we know it — the first send creates the material and
    // SAP tells us its number in the reply.
    ...(remoteId ? { Matnr: remoteId } : {}),
    Sku: str(product.sku),
    Name: str(product.name),
    Barcode: str(product.barcode),
    Uom: str(product.uom) || "EA",
    UnitPrice: num(product.unitPrice),
    Currency: str(product.currencyCode) || "TRY",
    TaxRate: num(product.taxRate),
    Active: product.active !== false,
  };
}

/** A customer/supplier as SAP business partner fields. */
export function partnerPayload(account: EntityRecord, remoteId?: string): Record<string, unknown> {
  return {
    ...(remoteId ? { Kunnr: remoteId } : {}),
    Name: str(account.name),
    TaxNumber: str(account.taxNumber),
    TaxOffice: str(account.taxOffice),
    Email: str(account.email),
    Phone: str(account.phone),
    Address: str(account.billingAddress),
    City: str(account.billingCity),
    District: str(account.billingDistrict),
    PostalCode: str(account.billingPostalCode),
  };
}

/**
 * An invoice with its lines.
 *
 * `Lines.Line` is nested rather than a bare array because XML has no way to say
 * "array" — a repeated `<Line>` inside a `<Lines>` wrapper is the conventional
 * shape, and it is what makes the JSON and XML encodings structurally the same
 * document rather than two different ones.
 */
export function invoicePayload(
  invoice: EntityRecord,
  lines: EntityRecord[],
  partnerRemoteId?: string,
): Record<string, unknown> {
  return {
    DocumentNumber: str(invoice.number),
    ...(partnerRemoteId ? { Kunnr: partnerRemoteId } : {}),
    CustomerId: str(invoice.accountId),
    IssueDate: str(invoice.issueDate),
    DueDate: str(invoice.dueDate),
    Currency: str(invoice.currencyCode) || "TRY",
    Subtotal: num(invoice.subtotal),
    TaxTotal: num(invoice.taxTotal),
    Total: num(invoice.total),
    Lines: {
      Line: lines.map((l, i) => ({
        LineNumber: i + 1,
        Sku: str(l.productId),
        Description: str(l.description),
        Qty: num(l.qty),
        UnitPrice: num(l.unitPrice),
        TaxRate: num(l.taxRate),
        LineTotal: num(l.lineTotal ?? l.total),
      })),
    },
  };
}

/** A stock movement as a goods movement document. */
export function stockMovementPayload(movement: EntityRecord, materialRemoteId?: string): Record<string, unknown> {
  return {
    MovementId: str(movement.id),
    ...(materialRemoteId ? { Matnr: materialRemoteId } : {}),
    ProductId: str(movement.productId),
    WarehouseId: str(movement.warehouseId),
    // Signed: a receipt is positive, an issue negative. Sending an unsigned
    // quantity plus a separate direction field means two places to get it wrong.
    Qty: num(movement.qty),
    UnitCost: num(movement.unitCost),
    Value: num(movement.value),
    MovedAt: str(movement.movedAt),
    RefType: str(movement.refType),
    RefId: str(movement.refId),
  };
}

// ---- inbound ---------------------------------------------------------------

export interface InboundProduct {
  remoteId: string;
  sku: string;
  fields: Record<string, unknown>;
}

/**
 * A SAP material message → the fields to write, plus its key.
 *
 * Only fields SAP actually sent are returned. A message that omits `UnitPrice`
 * means "I am not telling you about the price", not "the price is zero" — and
 * writing a zero would wipe a price nobody asked to change.
 */
export function readProduct(payload: Record<string, unknown>): InboundProduct | null {
  const remoteId = str(payload.Matnr).trim();
  const sku = str(payload.Sku).trim();
  if (!remoteId && !sku) return null; // nothing to match on
  const fields: Record<string, unknown> = {};
  const set = (key: string, source: string, cast: (v: unknown) => unknown = str) => {
    if (payload[source] !== undefined && payload[source] !== null) fields[key] = cast(payload[source]);
  };
  set("name", "Name");
  set("sku", "Sku");
  set("barcode", "Barcode");
  set("uom", "Uom");
  set("unitPrice", "UnitPrice", num);
  set("currencyCode", "Currency");
  set("taxRate", "TaxRate", num);
  if (typeof payload.Active === "boolean") fields.active = payload.Active;
  return { remoteId, sku, fields };
}

export interface InboundPartner {
  remoteId: string;
  name: string;
  fields: Record<string, unknown>;
}

export function readPartner(payload: Record<string, unknown>): InboundPartner | null {
  const remoteId = str(payload.Kunnr).trim();
  const name = str(payload.Name).trim();
  if (!remoteId && !name) return null;
  const fields: Record<string, unknown> = {};
  const set = (key: string, source: string) => {
    if (payload[source] !== undefined && payload[source] !== null) fields[key] = str(payload[source]);
  };
  set("name", "Name");
  set("taxNumber", "TaxNumber");
  set("taxOffice", "TaxOffice");
  set("email", "Email");
  set("phone", "Phone");
  set("billingAddress", "Address");
  set("billingCity", "City");
  set("billingDistrict", "District");
  set("billingPostalCode", "PostalCode");
  return { remoteId, name, fields };
}

export interface InboundPayment {
  documentNumber: string;
  amount: number;
  paidAt: string;
  method: string;
  reference: string;
}

/**
 * A payment posted in SAP, to be applied against our invoice.
 *
 * The invoice is identified by OUR document number, which SAP carries because
 * we sent it on `Invoice.Post`. Matching on amount and date instead would apply
 * the payment to whichever invoice happened to look similar.
 */
export function readPayment(payload: Record<string, unknown>): InboundPayment | null {
  const documentNumber = str(payload.DocumentNumber).trim();
  const amount = num(payload.Amount);
  if (!documentNumber || amount <= 0) return null;
  return {
    documentNumber,
    amount,
    paidAt: str(payload.PaidAt).trim() || new Date().toISOString().slice(0, 10),
    method: str(payload.Method).trim() || "bank",
    reference: str(payload.Reference).trim(),
  };
}
