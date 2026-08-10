/**
 * The sell side: quotes, invoices, invoice payments and sales returns.
 */

import { type Router } from "express";
import { runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { getFinanceService, type PaymentInput } from "@/lib/finance/service";
import { postSalesReturnGL } from "@/lib/accounting/postings";
import { permissionEngine } from "@/lib/permissions/engine";
import { withIdempotency } from "@/lib/http/idempotency-cache";
import {
  createDeliverySchema,
  createQuoteSchema,
  createInvoiceSchema,
  createSalesOrderSchema,
  createSalesReturnSchema,
  parseBody,
  paymentSchema,
  replaceDocumentSchema,
} from "@/lib/http/body";
import {
  confirmOrder,
  convertDeliveryToInvoice,
  convertQuoteToOrder,
  createDelivery,
  createOrder,
  orderFulfilment,
} from "@/lib/sales/orders";
import { BASE_CURRENCY } from "@/lib/config/env";
import { BadRequestError, ForbiddenError } from "@/lib/enforcement/errors";
import { headerDiscount } from "./shared";

export function registerSalesRoutes(r: Router): void {
  // ---- quotes -----------------------------------------------------------
  r.post(
    "/quotes",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createQuoteSchema);
        const fin = await getFinanceService();
        const doc = await fin.createDocument(rc, "quote", "Q", {
          accountId: body.accountId,
          currencyCode: body.currencyCode ?? BASE_CURRENCY,
          validUntil: body.validUntil ?? null,
          notes: body.notes ?? null,
          status: "draft",
          ...headerDiscount(body),
        });
        if (body.lines?.length) {
          await fin.replaceLines(rc, "quote", "quoteLine", "quoteId", doc.id, body.lines);
        }
        return fin.getDocument(rc, "quote", "quoteLine", "quoteId", doc.id);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/quotes/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "quote", "quoteLine", "quoteId", pathParam(req, "id"));
  }));

  r.put(
    "/quotes/:id",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, replaceDocumentSchema);
        const fin = await getFinanceService();
        return fin.saveDocument(rc, "quote", "quoteLine", "quoteId", pathParam(req, "id"), body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.post(
    "/quotes/:id/convert",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const invoiceId = await fin.convertQuoteToInvoice(rc, pathParam(req, "id"));
        return { invoiceId };
      },
      { mutating: true, status: 201 },
    ),
  );

  /**
   * Turn an opportunity into a draft quote — the first link of the chain.
   *
   * Mounted under `/deals` rather than `/quotes` because the deal is what the
   * caller has in hand, matching `/quotes/:id/convert` on the step after it.
   */
  r.post(
    "/deals/:id/quote",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const quoteId = await fin.convertDealToQuote(rc, pathParam(req, "id"));
        return { quoteId };
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- invoices ---------------------------------------------------------
  r.post(
    "/invoices",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createInvoiceSchema);
        const fin = await getFinanceService();
        const doc = await fin.createDocument(rc, "invoice", "INV", {
          accountId: body.accountId,
          currencyCode: body.currencyCode ?? BASE_CURRENCY,
          issueDate: body.issueDate ?? null,
          dueDate: body.dueDate ?? null,
          notes: body.notes ?? null,
          warehouseId: body.warehouseId ?? null,
          branchId: body.branchId ?? null,
          status: "draft",
          ...headerDiscount(body),
        });
        if (body.lines?.length) {
          await fin.replaceLines(rc, "invoice", "invoiceLine", "invoiceId", doc.id, body.lines);
        }
        return fin.getDocument(rc, "invoice", "invoiceLine", "invoiceId", doc.id);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/invoices/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "invoice", "invoiceLine", "invoiceId", pathParam(req, "id"));
  }));

  r.put(
    "/invoices/:id",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, replaceDocumentSchema);
        const fin = await getFinanceService();
        return fin.saveDocument(rc, "invoice", "invoiceLine", "invoiceId", pathParam(req, "id"), body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.get("/invoices/:id/payments", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    const [doc, payments] = await Promise.all([
      fin.getDocument(rc, "invoice", "invoiceLine", "invoiceId", pathParam(req, "id")),
      fin.listPayments(rc, pathParam(req, "id")),
    ]);
    return { invoice: doc.doc, payments };
  }));

  r.post(
    "/invoices/:id/payments",
    runApi(
      async (rc, req) => {
        // Money in. An amount that was not a number used to travel all the way
        // to the ledger before anything noticed.
        const body = parseBody(req, paymentSchema) as unknown as Partial<PaymentInput>;
        if (typeof body.amount !== "number" || body.amount <= 0) throw new BadRequestError("amount must be positive");
        if (!body.paidAt) throw new BadRequestError("paidAt is required");
        const fin = await getFinanceService();
        const invoice = await fin.applyPayment(rc, pathParam(req, "id"), {
          amount: body.amount,
          method: body.method ?? "bank",
          paidAt: body.paidAt,
          notes: body.notes ?? null,
        });
        const payments = await fin.listPayments(rc, pathParam(req, "id"));
        return { invoice, payments };
      },
      { mutating: true, status: 201 },
    ),
  );


  // ---- sales orders + delivery notes (İrsaliye) -------------------------
  //
  // The middle of the chain: `deal → quote → ORDER → DELIVERY → invoice`.
  // An order takes the commitment and holds the stock; a delivery note moves
  // the goods and costs them; the invoice bills what left.
  r.post(
    "/sales-orders",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createSalesOrderSchema);
        return withIdempotency(req.get("Idempotency-Key"), async () => {
          const order = await createOrder(
            rc,
            {
              accountId: body.accountId,
              quoteId: body.quoteId ?? null,
              warehouseId: body.warehouseId ?? null,
              branchId: body.branchId ?? null,
              currencyCode: body.currencyCode ?? BASE_CURRENCY,
              orderDate: body.orderDate ?? rc.at.slice(0, 10),
              requestedDate: body.requestedDate ?? null,
              notes: body.notes ?? null,
              ...headerDiscount(body),
            },
            body.lines ?? [],
          );
          const fin = await getFinanceService();
          return fin.getDocument(rc, "salesOrder", "salesOrderLine", "orderId", order.id);
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/sales-orders/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "salesOrder", "salesOrderLine", "orderId", pathParam(req, "id"));
  }));

  r.put(
    "/sales-orders/:id",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, replaceDocumentSchema);
        const fin = await getFinanceService();
        return fin.saveDocument(rc, "salesOrder", "salesOrderLine", "orderId", pathParam(req, "id"), body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  /** Confirm — this is what actually holds the stock. */
  r.post(
    "/sales-orders/:id/confirm",
    runApi(
      async (rc, req) => {
        const order = await confirmOrder(rc, pathParam(req, "id"));
        return { salesOrder: order };
      },
      { mutating: true },
    ),
  );

  /** What the order still owes, per line — what the picker works from. */
  r.get("/sales-orders/:id/fulfilment", runApi(async (rc, req) => {
    return orderFulfilment(rc, pathParam(req, "id"));
  }));

  r.post(
    "/quotes/:id/order",
    runApi(
      async (rc, req) => {
        const orderId = await convertQuoteToOrder(rc, pathParam(req, "id"));
        return { orderId };
      },
      { mutating: true, status: 201 },
    ),
  );

  /** Raise a delivery note for a load going out against this order. */
  r.post(
    "/sales-orders/:id/deliveries",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createDeliverySchema);
        return withIdempotency(req.get("Idempotency-Key"), async () => {
          const note = await createDelivery(
            rc,
            pathParam(req, "id"),
            {
              dispatchedAt: body.dispatchedAt ?? rc.at,
              carrierName: body.carrierName ?? null,
              vehiclePlate: body.vehiclePlate ?? null,
              driverName: body.driverName ?? null,
              deliveryAddress: body.deliveryAddress ?? null,
              notes: body.notes ?? null,
            },
            body.lines,
          );
          return { deliveryNote: note };
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/delivery-notes/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "deliveryNote", "deliveryNoteLine", "noteId", pathParam(req, "id"));
  }));

  /**
   * Dispatch: the goods leave.
   *
   * Driven through the lifecycle transition rather than by calling `applyDelivery`
   * directly, so the bespoke route and the generic `/entities/deliveryNote/:id/
   * transition` endpoint take exactly the same path — the divergence that left
   * goods receipts flipping status with no stock movement.
   */
  r.post(
    "/delivery-notes/:id/post",
    runApi(
      async (rc, req) => {
        const domain = await getDomainService();
        const id = pathParam(req, "id");
        const fin = await getFinanceService();
        const { doc } = await fin.getDocument(rc, "deliveryNote", "deliveryNoteLine", "noteId", id);
        if (doc.status === "posted") return { deliveryNote: doc };
        const updated = await domain.transition(rc, "deliveryNote", id, "post");
        return { deliveryNote: updated };
      },
      { mutating: true },
    ),
  );

  /** Invoice a dispatched load. The stock already left, so this bills only. */
  r.post(
    "/delivery-notes/:id/invoice",
    runApi(
      async (rc, req) => {
        const invoiceId = await convertDeliveryToInvoice(rc, pathParam(req, "id"));
        return { invoiceId };
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- sales returns (İadeler) -----------------------------------------
  // A return document (salesReturn + salesReturnLine). Posting restocks the
  // returned goods (a receipt movement per line, refType `salesReturn`).
  r.get("/sales-returns", runApi(async (rc) => {
    const domain = await getDomainService();
    const page = await domain.list(rc, "salesReturn", { sort: [{ field: "createdAt", dir: "desc" }], pageSize: 100 });
    return { items: page.items };
  }));

  r.get("/sales-returns/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "salesReturn", "salesReturnLine", "salesReturnId", pathParam(req, "id"));
  }));

  r.post(
    "/sales-returns",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const body = parseBody(req, createSalesReturnSchema);
        // Idempotent: a double-submit with the same key won't create two returns.
        return withIdempotency(req.get("Idempotency-Key"), async () => {
          const doc = await fin.createDocument(rc, "salesReturn", "RET", {
            accountId: body.accountId ?? null,
            invoiceId: body.invoiceId ?? null,
            warehouseId: body.warehouseId ?? null,
            branchId: body.branchId ?? null,
            currencyCode: body.currencyCode ?? BASE_CURRENCY,
            returnDate: body.returnDate ?? rc.at.slice(0, 10),
            reason: body.reason ?? null,
            status: "draft",
            notes: body.notes ?? null,
            ...headerDiscount(body),
          });
          if (body.lines?.length) await fin.replaceLines(rc, "salesReturn", "salesReturnLine", "salesReturnId", doc.id, body.lines);
          return fin.getDocument(rc, "salesReturn", "salesReturnLine", "salesReturnId", doc.id);
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/sales-returns/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "salesReturn", action: "salesReturn:post" })) {
          throw new ForbiddenError("not allowed to post sales returns");
        }
        const fin = await getFinanceService();
        const domain = await getDomainService();
        const { doc } = await fin.getDocument(rc, "salesReturn", "salesReturnLine", "salesReturnId", pathParam(req, "id"));
        if (doc.status === "posted") return { salesReturn: doc };
        // Restock at cost + reverse the sale in the GL. This used to restock at
        // the SELLING price and post no journal entry at all.
        await postSalesReturnGL(rc, pathParam(req, "id"));
        const updated = await domain.update(rc, "salesReturn", pathParam(req, "id"), { status: "posted" });
        return { salesReturn: updated };
      },
      { mutating: true },
    ),
  );

}
