/**
 * Request-body validation for the hand-written routes.
 *
 * Entity CRUD has been fully validated from the start: the metadata generates a
 * zod schema per entity and nothing reaches storage without passing it. The
 * bespoke routes — checkout, payments, adjustments, imports, exports — had none
 * of that. Every one of them did:
 *
 *     const body = readJson(req) as { qty?: number; ... }
 *
 * which is a claim, not a check. The object arrives with whatever the caller
 * sent, and the cast makes TypeScript agree. The failures that follow are the
 * quiet kind: `Number(undefined)` becomes NaN and lands in a money column, a
 * string where a number belongs is interpolated into SQL as a bare token, an
 * array the handler assumed was there is `undefined` two frames later. Each
 * surfaces far from its cause, usually as a 500.
 *
 * `parseBody` closes that with the SAME error shape entity CRUD produces —
 * `VALIDATION` with per-field details — so a client handles one format rather
 * than discovering which endpoints are the old kind.
 */
import type { Request } from "express";
import { z } from "zod";
import { detailFromZodIssue } from "@aula/contracts/i18n/errors";
import { ValidationError } from "@/lib/enforcement/errors";

/**
 * Validate and narrow a request body.
 *
 * Returns the PARSED value, not the input: zod coerces and strips, so the
 * handler works with the schema's type rather than with whatever arrived. That
 * is the point — a validator whose output you then ignore is documentation.
 */
export function parseBody<T>(req: Request, schema: z.ZodType<T>): T {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  // `path` is empty for a whole-body failure; "body" reads better than "".
  // detailFromZodIssue attaches the catalogue key + params so the boundary can
  // render the issue in the request's locale.
  throw new ValidationError(result.error.issues.map((issue) => detailFromZodIssue(issue, "body")));
}

/** Same, for query strings and route params. */
export function parseQuery<T>(value: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new ValidationError(result.error.issues.map((issue) => detailFromZodIssue(issue, "query")));
}

// ---- shared field shapes ---------------------------------------------------

/**
 * A record id.
 *
 * Ids are database integers rendered as strings, but the schema accepts any
 * non-empty short string rather than asserting the format: the id shape is a
 * storage detail, and a route that rejected a valid id because the generator
 * changed would be worse than one that lets the lookup 404.
 */
export const idSchema = z.string().min(1).max(64);

/**
 * Money.
 *
 * Finite and non-negative by default. `Number(undefined)` is NaN and NaN passes
 * `typeof === "number"`, which is how a NaN reached a currency column and then
 * an SQL statement as the literal token `NaN`.
 */
export const moneySchema = z.number().finite().nonnegative();

/** A signed amount, for adjustments and reversals where negative is meaningful. */
export const signedMoneySchema = z.number().finite();

/** A quantity. Zero is allowed; a zero-quantity line is a caller's problem, not a schema's. */
export const qtySchema = z.number().finite();

/** A positive quantity, where zero would make the operation meaningless. */
export const positiveQtySchema = z.number().finite().positive();

/** A percentage rate, 0–100. */
export const rateSchema = z.number().finite().min(0).max(100);

/** ISO-8601 date or datetime, as stored. */
export const isoDateSchema = z.string().min(8).max(40);

/**
 * A document line.
 *
 * The shape shared by quote/invoice/order lines. `description` is required
 * because it is what a person reads on the printed document — a line with a
 * product id and no description is a row of numbers.
 */
export const documentLineSchema = z.object({
  productId: idSchema.nullish(),
  description: z.string().min(1).max(500),
  qty: qtySchema,
  /** The unit the quantity is in. Absent means the product's base unit. */
  uomId: idSchema.nullish(),
  unitPrice: moneySchema,
  taxRate: rateSchema.default(0),
});

/**
 * At least one line.
 *
 * A document with no lines totals zero and posts nothing, which reads as success
 * to the caller and as a missing invoice to everyone else.
 */
export const documentLinesSchema = z.array(documentLineSchema).min(1);

// ---- schemas for the money-handling routes ---------------------------------

/** Document-level discount, accepted on any priced document header. */
const documentDiscountFields = {
  discountRate: rateSchema.default(0),
  discountAmount: moneySchema.default(0),
};


/**
 * A POS basket line.
 *
 * `description` is optional here, unlike a document line: the till resolves it
 * from the scanned product. `qty` allows negative for a return rung up at the
 * same terminal.
 */
export const posLineSchema = z.object({
  productId: idSchema.nullish(),
  description: z.string().max(500).optional(),
  qty: qtySchema,
  /** The unit scanned — a case, a six-pack. Absent means the base unit. */
  uomId: idSchema.nullish(),
  unitPrice: moneySchema,
  /**
   * A discount rung up at the till.
   *
   * Whether the cashier MAY apply one is a permission (`pos:discount`), checked
   * at the route — the schema only says what the shape is. Those are different
   * questions and conflating them would either block a manager or let anyone
   * discount at will.
   */
  discountRate: rateSchema.default(0),
  discountAmount: moneySchema.default(0),
  taxRate: rateSchema,
});

/**
 * A tender.
 *
 * The amount must be finite and non-negative — a negative tender is change, and
 * change is derived, never submitted. `method` is a short token the posting
 * layer maps to a ledger account; an unknown one is rejected downstream by that
 * mapping rather than here, so adding a payment method does not require editing
 * two places.
 */
export const posPaymentSchema = z.object({
  method: z.string().min(1).max(40),
  amount: moneySchema,
});

export const posCheckoutSchema = z.object({
  ...documentDiscountFields,
  branchId: idSchema.nullish(),
  warehouseId: idSchema.nullish(),
  dealerId: idSchema.nullish(),
  accountId: idSchema.nullish(),
  sessionId: idSchema.nullish(),
  currencyCode: z.string().length(3).optional(),
  // At least one line: an empty sale posts nothing and returns 201, which reads
  // as a completed transaction to the till and as a missing invoice to the books.
  lines: z.array(posLineSchema).min(1),
  // Payments MAY be empty — a sale can be left on the customer's account.
  payments: z.array(posPaymentSchema).default([]),
  idempotencyKey: z.string().max(120).nullish(),
});

/**
 * A receipt against an invoice.
 *
 * `paidAt` is the field the service reads and the column it lands in. The schema
 * previously offered `receivedAt` and `date` as well — three names for one
 * thing, none of which the service consulted, so a caller using either of the
 * other two was told "paidAt is required" by a layer that had just accepted
 * their body. One name, and it is the one that means something downstream.
 */
export const paymentSchema = z.object({
  amount: moneySchema,
  method: z.string().min(1).max(40).optional(),
  reference: z.string().max(120).nullish(),
  paidAt: isoDateSchema.optional(),
  notes: z.string().max(2000).nullish(),
  chequeId: idSchema.nullish(),
});

/** Opening or closing a till session. */
export const posSessionSchema = z.object({
  branchId: idSchema.nullish(),
  warehouseId: idSchema.nullish(),
  openingFloat: moneySchema.optional(),
  countedCash: moneySchema.optional(),
  notes: z.string().max(2000).nullish(),
});

/**
 * A stock adjustment.
 *
 * `qtyDelta` is signed on purpose — it is the whole point of the document, and
 * the sign decides whether stock is written on or off. `unitCost` is only
 * consulted for a positive delta; a write-off consumes the running average, so
 * a cost supplied with a negative delta is ignored rather than trusted.
 */
export const stockAdjustmentSchema = z.object({
  productId: idSchema,
  warehouseId: idSchema,
  qtyDelta: signedMoneySchema,
  unitCost: moneySchema.optional(),
  reason: z.string().max(200).optional(),
  notes: z.string().max(2000).nullish(),
});

/** An aggregation request. */
export const aggregateSchema = z.object({
  entity: z.string().min(1).max(64),
  groupBy: z.string().max(64).optional(),
  dimensions: z
    .array(z.object({ field: z.string().min(1).max(64), bucket: z.string().max(16).optional(), as: z.string().max(40).optional() }))
    .optional(),
  // At least one measure. An empty list produced `SELECT  FROM …`, which reached
  // the database as a syntax error and surfaced as a 500 — a client mistake
  // reported as a server fault.
  measures: z
    .array(z.object({ op: z.string().min(1).max(16), field: z.string().max(64).optional(), as: z.string().max(40).optional() }))
    .min(1),
  filters: z.array(z.unknown()).optional(),
  having: z.array(z.unknown()).optional(),
  sort: z.array(z.unknown()).optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

/** Closing a till session: the counted cash is the whole point, so it is required. */
/**
 * A field somebody is adding to an entity without a deploy.
 *
 * The name is checked here for shape and again by `assertValidField` against the
 * live model — this one says "could be a column", that one says "may be one".
 */
export const customFieldSchema = z.object({
  entityName: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  type: z.enum([
    "string",
    "text",
    "number",
    "currency",
    "percent",
    "boolean",
    "date",
    "datetime",
    "enum",
    "reference",
    "email",
    "phone",
  ]),
  referenceEntity: z.string().max(60).nullish(),
  /** One choice per line: `value|Label`. */
  options: z.string().max(4000).nullish(),
  required: z.boolean().default(false),
  filterable: z.boolean().default(false),
  searchable: z.boolean().default(false),
  sortable: z.boolean().default(false),
  helpText: z.string().max(200).nullish(),
  max: z.number().finite().min(0).nullish(),
  defaultValue: z.string().max(200).nullish(),
  position: z.number().finite().min(0).default(0),
});

export const cashMovementSchema = z.object({
  direction: z.enum(["in", "out"]),
  /** Always positive; the direction says which way it went. */
  amount: moneySchema,
  /**
   * Why — required.
   *
   * An unexplained drawer movement is indistinguishable from a till being
   * short, which is the thing this record exists to tell apart.
   */
  reason: z.string().min(1).max(200),
  notes: z.string().max(2000).nullish(),
});

export const closeSessionSchema = z.object({
  sessionId: idSchema,
  countedCash: moneySchema,
});

// ---- self-service account ---------------------------------------------------

/**
 * Free text on a person's own record.
 *
 * Bounded rather than unbounded: these render on screens and in PDFs, and an
 * unbounded string is both a storage surprise and a layout one. The lengths
 * mirror the metadata's `max` for the same columns, so a value that passes here
 * also fits the column it lands in.
 */
export const profileSchema = z.object({
  displayName: z.string().min(1).max(160).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).nullish(),
  timezone: z.string().max(64).nullish(),
  avatarId: z.string().max(80).nullish(),
  jobTitle: z.string().max(120).nullish(),
  location: z.string().max(160).nullish(),
  bio: z.string().max(4000).nullish(),
  notificationPrefs: z.unknown().optional(),
});

export const userSettingsSchema = z.object({
  settings: z.record(z.string().max(80), z.unknown()).default({}),
});

/**
 * A password change.
 *
 * Both fields required by the schema rather than by a hand-written guard, so the
 * failure is a 422 naming the field instead of a 400 naming both. Strength is
 * asserted separately — that policy lives with the rest of the password rules.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(400),
  newPassword: z.string().min(1).max(400),
});

export const totpCodeSchema = z.object({ code: z.string().min(6).max(20) });
export const passwordConfirmSchema = z.object({ password: z.string().min(1).max(400) });

/** Creating a user. Password strength is checked separately, as above. */
export const createUserSchema = z.object({
  email: z.string().email().max(200),
  displayName: z.string().min(1).max(160).optional(),
  password: z.string().min(1).max(400),
  positionId: idSchema,
  active: z.boolean().optional(),
  managerId: idSchema.nullish(),
  phone: z.string().max(40).nullish(),
  jobTitle: z.string().max(120).nullish(),
  companyId: idSchema.nullish(),
});

/** Editing a user. Every field optional — a PATCH says what changes, not what is. */
export const updateUserSchema = z.object({
  displayName: z.string().min(1).max(160).optional(),
  email: z.string().email().max(200).optional(),
  positionId: idSchema.optional(),
  active: z.boolean().optional(),
  password: z.string().min(1).max(400).optional(),
  managerId: idSchema.nullish(),
  phone: z.string().max(40).nullish(),
  jobTitle: z.string().max(120).nullish(),
  companyId: idSchema.nullish(),
  resetTwoFactor: z.boolean().optional(),
});

// ---- documents ---------------------------------------------------------------

/**
 * A priced line as the document endpoints accept it.
 *
 * `description` is REQUIRED, and that is not a tightening — the metadata already
 * required it on every line entity, and the service passes the value straight
 * through without resolving anything from the product. What the old cast did was
 * declare it optional to TypeScript while the column demanded it, so a line
 * without one failed deep inside the service, after the document header had
 * already been written. Requiring it here moves the same rejection to the edge,
 * where the error can name the field.
 */
export const lineInputSchema = z.object({
  productId: idSchema.nullish(),
  description: z.string().min(1).max(500),
  qty: qtySchema,
  /** The unit the quantity is in. Absent means the product's base unit. */
  uomId: idSchema.nullish(),
  unitPrice: moneySchema,
  /** Line discount. Both forms are clamped and applied in `finance/totals`. */
  discountRate: rateSchema.default(0),
  discountAmount: moneySchema.default(0),
  taxRate: rateSchema.default(0),
});

const documentHeaderBase = {
  currencyCode: z.string().length(3).optional(),
  branchId: idSchema.nullish(),
  notes: z.string().max(4000).nullish(),
  lines: z.array(lineInputSchema).default([]),
};

export const createQuoteSchema = z.object({
  ...documentDiscountFields,
  accountId: idSchema,
  validUntil: isoDateSchema.nullish(),
  ...documentHeaderBase,
});

export const createInvoiceSchema = z.object({
  ...documentDiscountFields,
  accountId: idSchema,
  warehouseId: idSchema.nullish(),
  issueDate: isoDateSchema.nullish(),
  dueDate: isoDateSchema.nullish(),
  tevkifatRatio: z.number().finite().min(0).max(10).optional(),
  ...documentHeaderBase,
});

export const createSalesOrderSchema = z.object({
  ...documentDiscountFields,
  accountId: idSchema,
  /** Where the stock is held when the order is confirmed. */
  warehouseId: idSchema.nullish(),
  quoteId: idSchema.nullish(),
  orderDate: isoDateSchema.nullish(),
  requestedDate: isoDateSchema.nullish(),
  ...documentHeaderBase,
});

/**
 * A load leaving against an order.
 *
 * `orderLineId` rather than the product alone: the same product can sit on an
 * order twice at different prices, and matching on the product collapses the two
 * so the shipped quantity cannot be attributed. Optional — omitted, the service
 * fills the oldest line for that product still owing something.
 */
export const deliveryLineSchema = z.object({
  orderLineId: idSchema.nullish(),
  productId: idSchema,
  /** In the ORDER line's units: the caller ships what was ordered. */
  qty: positiveQtySchema,
  description: z.string().max(500).optional(),
});

export const createDeliverySchema = z.object({
  dispatchedAt: isoDateSchema.nullish(),
  carrierName: z.string().max(160).nullish(),
  vehiclePlate: z.string().max(20).nullish(),
  driverName: z.string().max(160).nullish(),
  deliveryAddress: z.string().max(4000).nullish(),
  notes: z.string().max(4000).nullish(),
  lines: z.array(deliveryLineSchema).min(1),
});

export const purchaseRequestLineSchema = z.object({
  /** Optional: half of what gets requested is not in the catalogue yet. */
  productId: idSchema.nullish(),
  description: z.string().min(1).max(500),
  qty: positiveQtySchema,
  uomId: idSchema.nullish(),
  estimatedPrice: moneySchema.optional(),
  neededBy: isoDateSchema.nullish(),
});

export const createPurchaseRequestSchema = z.object({
  title: z.string().min(1).max(200),
  warehouseId: idSchema.nullish(),
  branchId: idSchema.nullish(),
  neededBy: isoDateSchema.nullish(),
  priority: z.enum(["low", "normal", "urgent"]).default("normal"),
  justification: z.string().max(4000).nullish(),
  notes: z.string().max(4000).nullish(),
  lines: z.array(purchaseRequestLineSchema).default([]),
});

export const supplierQuoteLineSchema = z.object({
  /** Which REQUEST line this prices — what puts three suppliers side by side. */
  requestLineId: idSchema.nullish(),
  productId: idSchema.nullish(),
  description: z.string().min(1).max(500),
  qty: positiveQtySchema,
  uomId: idSchema.nullish(),
  unitPrice: moneySchema,
  taxRate: rateSchema.default(0),
  leadTimeDays: z.number().finite().min(0).optional(),
  /** The supplier cannot supply this line. A zero here is not a price of zero. */
  unavailable: z.boolean().default(false),
});

export const createSupplierQuoteSchema = z.object({
  requestId: idSchema,
  supplierId: idSchema,
  supplierRef: z.string().max(80).nullish(),
  currencyCode: z.string().length(3).optional(),
  quotedAt: isoDateSchema.nullish(),
  validUntil: isoDateSchema.nullish(),
  leadTimeDays: z.number().finite().min(0).optional(),
  paymentTermDays: z.number().finite().min(0).optional(),
  notes: z.string().max(4000).nullish(),
  lines: z.array(supplierQuoteLineSchema).min(1),
});

export const awardQuoteSchema = z.object({
  /** Why this one won — including when it was not the cheapest. */
  reason: z.string().max(500).nullish(),
});

export const orderRequestSchema = z.object({
  supplierId: idSchema,
});

export const createPurchaseReturnSchema = z.object({
  ...documentDiscountFields,
  supplierId: idSchema,
  /** Where the goods leave from — a return is stock going out of a real place. */
  warehouseId: idSchema,
  grnId: idSchema.nullish(),
  /** Set when the goods were already invoiced; it decides whether AP or the accrual reverses. */
  vendorBillId: idSchema.nullish(),
  returnDate: isoDateSchema.nullish(),
  reason: z.string().max(200).nullish(),
  ...documentHeaderBase,
});

export const createLandedCostSchema = z.object({
  /** The RECEIPT, not the order: freight is paid on what actually turned up. */
  grnId: idSchema,
  supplierId: idSchema.nullish(),
  vendorBillId: idSchema.nullish(),
  costType: z.enum(["freight", "customs", "insurance", "handling", "other"]),
  /**
   * How to spread it.
   *
   * `value` for duty, which is charged on value. `quantity`/`weight`/`volume`
   * for freight, which is charged by what fills a lorry — a pallet of feathers
   * and a pallet of tiles cost the same to move.
   */
  allocationMethod: z.enum(["value", "quantity", "weight", "volume"]).default("value"),
  amount: moneySchema,
  currencyCode: z.string().length(3).optional(),
  costDate: isoDateSchema.nullish(),
  branchId: idSchema.nullish(),
  notes: z.string().max(4000).nullish(),
});

export const createPurchaseOrderSchema = z.object({
  ...documentDiscountFields,
  supplierId: idSchema,
  warehouseId: idSchema,
  orderDate: isoDateSchema.nullish(),
  expectedDate: isoDateSchema.nullish(),
  ...documentHeaderBase,
});

export const createVendorBillSchema = z.object({
  ...documentDiscountFields,
  supplierId: idSchema,
  poId: idSchema.nullish(),
  // The receipt this bill is matched against — the third leg of the three-way
  // match (order / receipt / bill). Omitting it from the schema would have
  // silently unlinked every bill from its goods receipt.
  goodsReceiptId: idSchema.nullish(),
  billDate: isoDateSchema.nullish(),
  dueDate: isoDateSchema.nullish(),
  ...documentHeaderBase,
});

/**
 * A goods-receipt line.
 *
 * `qty` must be positive: receiving zero of something is not a receipt, and
 * receiving a negative quantity is a return, which is a different document with
 * different postings.
 */
export const grnLineSchema = z.object({
  productId: idSchema,
  description: z.string().max(500).optional(),
  qty: positiveQtySchema,
  /**
   * Optional: the service defaults it from the PO line being received.
   *
   * Requiring it here contradicted that and made the default unreachable — the
   * request was rejected before the service could supply one. Receiving at the
   * agreed price is the normal case; naming a different cost is the exception.
   */
  unitCost: moneySchema.optional(),
  /** Which PO line this satisfies — see `purchasing/service`. */
  poLineId: idSchema.nullish(),
  /**
   * The batch that arrived, as printed on the box.
   *
   * Required for a lot-tracked product — posting refuses without it, because
   * stock received against no lot lands in a balance no lot holds and is
   * invisible to both picking and recall.
   */
  lotNumber: z.string().max(64).nullish(),
  expiryDate: isoDateSchema.nullish(),
  manufacturedDate: isoDateSchema.nullish(),
  serialNumber: z.string().max(64).nullish(),
});

export const createGoodsReceiptSchema = z.object({
  poId: idSchema.nullish(),
  supplierId: idSchema.nullish(),
  warehouseId: idSchema,
  receiptDate: isoDateSchema.nullish(),
  branchId: idSchema.nullish(),
  notes: z.string().max(4000).nullish(),
  lines: z.array(grnLineSchema).min(1),
});

/**
 * A manual journal line.
 *
 * Debit and credit both default to zero so a line may carry either. The rule
 * that exactly one is non-zero, and that the entry balances, belongs to the
 * accounting service — it is an invariant about the SET of lines, which a
 * per-line schema cannot see.
 */
export const journalLineSchema = z.object({
  // `ledgerAccountId`, matching the service and the column. Naming it `accountId`
  // here would have been a second name for the same thing — and `account` is a
  // different entity in this system (a customer), so the wrong one is a
  // plausible-looking mistake rather than an obvious one.
  ledgerAccountId: idSchema,
  debit: moneySchema.default(0),
  credit: moneySchema.default(0),
  description: z.string().max(500).nullish(),
  branchId: idSchema.nullish(),
});

export const createJournalEntrySchema = z.object({
  date: isoDateSchema,
  memo: z.string().max(2000).nullish(),
  branchId: idSchema.nullish(),
  // A journal entry needs at least two lines to balance; one is never valid.
  lines: z.array(journalLineSchema).min(2),
  post: z.boolean().optional(),
});

/** Replacing a document's header and lines wholesale (PUT). */
export const replaceDocumentSchema = z.object({
  header: z.record(z.string().max(64), z.unknown()).optional(),
  lines: z.array(lineInputSchema).optional(),
});

export const createCartSchema = z.object({
  ...documentDiscountFields,
  accountId: idSchema.nullish(),
  warehouseId: idSchema.nullish(),
  ...documentHeaderBase,
});

export const cartCheckoutSchema = z.object({
  payments: z.array(posPaymentSchema).default([]),
  settlement: z.enum(["paid", "credit"]).optional(),
});

export const createSalesReturnSchema = z.object({
  ...documentDiscountFields,
  accountId: idSchema.nullish(),
  invoiceId: idSchema.nullish(),
  warehouseId: idSchema.nullish(),
  branchId: idSchema.nullish(),
  currencyCode: z.string().length(3).optional(),
  returnDate: isoDateSchema.nullish(),
  reason: z.string().max(200).nullish(),
  notes: z.string().max(4000).nullish(),
  lines: z.array(lineInputSchema).min(1),
});

export const rejectSchema = z.object({ reason: z.string().max(500).nullish() });
export const eInvoiceSchema = z.object({ series: z.string().length(3).optional() });
export const transitionSchema = z.object({ action: z.string().min(1).max(60) });

// ---- import / export ---------------------------------------------------------

/**
 * A CSV import.
 *
 * The size cap is the point: this arrives as a string in a JSON body, is parsed
 * in memory and turned into rows. 8 MB of CSV is already tens of thousands of
 * records, and beyond that the request is a memory event rather than an import.
 */
export const importSchema = z.object({
  // Either a CSV string or a base64 .xlsx workbook — the endpoint accepts both,
  // and requiring `csv` would have broken every spreadsheet import.
  csv: z.string().max(8 * 1024 * 1024).optional(),
  xlsx: z.string().max(24 * 1024 * 1024).optional(),
  /** Maps the user's (localised) column headers back to field names. */
  aliases: z.record(z.string().max(200), z.string().max(64)).optional(),
  mode: z.enum(["insert", "upsert"]).optional(),
  dryRun: z.boolean().optional(),
}).refine((b) => Boolean(b.csv || b.xlsx), {
  message: "either csv or xlsx is required",
  path: ["csv"],
});

/**
 * Rendering a report the client has already composed.
 *
 * `payload` is shape-checked only as far as the renderer needs — a title and
 * sections — rather than fully described here. The report structure is the
 * client's to compose and the renderer's to interpret; duplicating it in a
 * schema would mean editing two files to add a column to a report.
 *
 * `fileName`, not `filename`: it is what the handler reads, and a schema that
 * renamed it would have quietly produced every export as "report.xlsx".
 */
export const reportExportSchema = z.object({
  payload: z.object({
    // Required, because the renderer requires it — an optional title here would
    // typecheck and then produce a report with no heading.
    title: z.string().max(200),
    sections: z.array(z.unknown()),
  }).passthrough(),
  format: z.enum(["pdf", "xlsx", "csv"]).optional(),
  fileName: z.string().max(160).optional(),
});

// ---- automation ---------------------------------------------------------------

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  status: z.enum(["active", "paused", "draft"]).optional(),
  // Shape-checked by the automation engine, which owns the trigger vocabulary.
  // Requiring only its presence here keeps one definition of what a trigger is.
  trigger: z.unknown().refine((v) => v !== undefined && v !== null, "trigger is required"),
  // Passed through to the automation engine, which owns both vocabularies. A
  // structural copy here would be a second definition to keep in step.
  conditions: z.record(z.string().max(64), z.unknown()).optional(),
  actions: z.array(z.unknown()).optional(),
  tags: z.array(z.string().max(40)).optional(),
  requiresApproval: z.boolean().optional(),
});

export const automationStatusSchema = z.object({ status: z.enum(["active", "paused", "draft"]) });
export const automationRollbackSchema = z.object({ version: z.number().int().nonnegative() });
export const automationRunSchema = z.object({
  recordId: idSchema.optional(),
  test: z.boolean().optional(),
  /** A stand-in record for a test run, when no real one is selected. */
  sample: z.record(z.string().max(64), z.unknown()).optional(),
});
export const integrationToggleSchema = z.object({
  enabled: z.boolean().optional(),
  // Scalars only. Integration config is credentials and endpoints, and a nested
  // object here would be a place for something structured to arrive unchecked.
  config: z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
});
export const integrationTestSchema = z.object({ to: z.string().max(200).optional() });

// ---- integrations --------------------------------------------------------------

/**
 * A webhook endpoint.
 *
 * The URL is only shape-checked here. Whether it may be CALLED — the
 * private-address and redirect rules that stop a webhook being used to reach
 * inside the network — is enforced at delivery time by the SSRF guard, because
 * DNS can change between registering an endpoint and calling it.
 */
export const webhookSchema = z.object({
  // `z.string().url()` is not enough on its own: it accepts `javascript:`,
  // `file:` and `ftp:` — all valid URIs, none of them something this system
  // could ever POST to. The SSRF guard rejects them at delivery time, so they
  // were defended, but a scheme that can never be a webhook target belongs in
  // the 422 that names the field rather than a 400 from three layers down.
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "url must be http or https"),
  events: z.array(z.string().max(80)).min(1),
  secret: z.string().max(200).optional(),
  active: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

/** Sending mail. Recipients may be one address or a list. */
export const sendEmailSchema = z.object({
  to: z.union([z.string().max(200), z.array(z.string().max(200)).min(1)]),
  cc: z.union([z.string().max(200), z.array(z.string().max(200))]).optional(),
  bcc: z.union([z.string().max(200), z.array(z.string().max(200))]).optional(),
  subject: z.string().max(300).default(""),
  body: z.string().max(1024 * 1024).default(""),
  refType: z.string().max(40).nullish(),
  refId: idSchema.nullish(),
});

/**
 * A bulk mail operation.
 *
 * Capped so one request cannot ask for an unbounded number of row updates. The
 * cap is generous enough for "select all on this page" and small enough that the
 * work is bounded.
 */
export const emailIdsSchema = z.object({
  ids: z.array(idSchema).min(1).max(500),
  folder: z.string().max(60).optional(),
  folderId: idSchema.nullish(),
  /**
   * IMAP message ids, for operations that must also act on the mail server.
   * Separate from `ids` (our row ids) because they identify different things —
   * conflating them would delete locally and leave the server copy behind.
   */
  messageIds: z.array(z.string().max(400)).max(500).optional(),
});

export const emailRestoreSchema = z.object({
  items: z
    .array(z.object({ id: idSchema, folder: z.string().max(60).optional(), folderId: idSchema.nullish() }))
    .min(1)
    .max(500),
  messageIds: z.array(z.string().max(400)).max(500).optional(),
});

/**
 * A settings bag.
 *
 * Keys are bounded and values must be scalars or short arrays of them. The
 * contents are deliberately open — these tables hold whatever a screen chooses
 * to remember — but "open" should not mean an arbitrarily deep object arriving
 * unchecked and being written straight to storage.
 */
const settingValueSchema = z.union([
  z.string().max(4000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(400), z.number(), z.boolean()])).max(200),
]);

export const settingsBagSchema = z.record(z.string().max(80), settingValueSchema);

/**
 * A mobile screen configuration.
 *
 * Open for the same reason as the settings bag, and bounded the same way. The
 * screen keys and the hidden-field lists are validated by the mobile config
 * service, which knows what a screen key is.
 */
export const mobileConfigSchema = z.record(
  z.string().max(80),
  z.union([settingValueSchema, z.record(z.string().max(80), settingValueSchema)]),
);

/** Editing an automation rule — every field optional, as a PATCH should be. */
export const updateAutomationSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(["active", "paused", "draft"]).optional(),
  trigger: z.unknown().optional(),
  conditions: z.record(z.string().max(64), z.unknown()).optional(),
  actions: z.array(z.unknown()).optional(),
  tags: z.array(z.string().max(40)).optional(),
  requiresApproval: z.boolean().optional(),
});

/** A bill payment. `paidAt` rather than `receivedAt` — money going out, not in. */
export const billPaymentSchema = z.object({
  amount: moneySchema,
  method: z.string().min(1).max(40).optional(),
  paidAt: isoDateSchema.optional(),
  notes: z.string().max(2000).nullish(),
  reference: z.string().max(120).nullish(),
  chequeId: idSchema.nullish(),
});

/** An assignment rule. Shape owned by the automation engine. */
export const assignmentRuleSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  strategy: z.string().max(40).optional(),
  entity: z.string().max(64).optional(),
  active: z.boolean().optional(),
  targets: z.array(z.unknown()).optional(),
  conditions: z.record(z.string().max(64), z.unknown()).optional(),
});

/**
 * Counted quantities from the shop floor.
 *
 * `countedQty` may be zero — "there are none" is a finding, and the most
 * consequential one. It may not be negative: a negative count is a typo, and
 * accepting it would write off twice what is actually missing.
 */
export const countEntriesSchema = z.object({
  entries: z
    .array(
      z.object({
        productId: idSchema,
        countedQty: z.number().finite().nonnegative(),
        notes: z.string().max(300).nullish(),
      }),
    )
    .min(1)
    .max(1000),
});

/**
 * A period-end revaluation run.
 *
 * `post` defaults to false: the figures are produced for review first, because
 * a revaluation against a wrong closing rate is a correction nobody enjoys.
 */
/** Push one record to SAP by hand — which interface, and which record. */
export const erpSyncSchema = z.object({
  messageType: z.string().min(1).max(60),
  id: idSchema,
});

/** Hold stock for a document. */
/** Register a device for push notifications. */
/**
 * A batch of client-side failures.
 *
 * Batched because a fatal crash is reported on the NEXT launch, along with
 * whatever was queued behind it. Capped so one misbehaving device cannot post an
 * unbounded payload.
 */
export const clientErrorsSchema = z.object({
  errors: z
    .array(
      z.object({
        message: z.string().min(1).max(500),
        severity: z.enum(["fatal", "handled"]),
        stack: z.string().max(8000).nullish(),
        context: z.string().max(120).nullish(),
        platform: z.enum(["ios", "android", "web"]).nullish(),
        appVersion: z.string().max(40).nullish(),
        deviceName: z.string().max(120).nullish(),
        occurredAt: isoDateSchema,
      }),
    )
    .min(1)
    .max(50),
});

export const registerDeviceSchema = z.object({
  token: z.string().min(8).max(400),
  platform: z.enum(["ios", "android", "web"]),
  deviceName: z.string().max(120).nullish(),
  appVersion: z.string().max(40).nullish(),
});

export const unregisterDeviceSchema = z.object({ token: z.string().min(8).max(400) });

export const reserveSchema = z.object({
  productId: idSchema,
  warehouseId: idSchema,
  qty: positiveQtySchema,
  refType: z.string().min(1).max(40),
  refId: idSchema,
  expiresAt: isoDateSchema.nullish(),
});

/** Give a document's hold back. */
export const releaseSchema = z.object({
  refType: z.string().min(1).max(40),
  refId: idSchema,
  /** True when the goods shipped — the hold is dropped, not returned to stock. */
  consumed: z.boolean().optional(),
});

export const revalueSchema = z.object({
  asOf: isoDateSchema,
  post: z.boolean().optional(),
});
