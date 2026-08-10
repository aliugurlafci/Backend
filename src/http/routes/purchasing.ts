/**
 * The buy side: purchase orders, goods receipts, vendor bills and bill payments.
 */

import { type Router } from "express";
import { runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { getPurchasingService } from "@/lib/purchasing/service";
import { getPayablesService } from "@/lib/payables/service";
import { permissionEngine } from "@/lib/permissions/engine";
import { getFinanceService } from "@/lib/finance/service";
import { getQueryEngine } from "@/lib/data/store";
import {
  awardQuoteSchema,
  createGoodsReceiptSchema,
  createLandedCostSchema,
  createPurchaseOrderSchema,
  createPurchaseRequestSchema,
  createPurchaseReturnSchema,
  createSupplierQuoteSchema,
  orderRequestSchema,
  billPaymentSchema,
  createVendorBillSchema,
  parseBody,
  rejectSchema,
  replaceDocumentSchema,
} from "@/lib/http/body";
import { BASE_CURRENCY } from "@/lib/config/env";
import { BadRequestError, ForbiddenError } from "@/lib/enforcement/errors";
import { systemContext } from "@/lib/context/resolver";
import { headerDiscount } from "./shared";

export function registerPurchasingRoutes(r: Router): void {
  // ---- purchasing: purchase orders + goods receipts --------------------
  r.post(
    "/purchase-orders",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createPurchaseOrderSchema);
        const pur = await getPurchasingService();
        return pur.createPO(
          rc,
          {
            supplierId: body.supplierId,
            warehouseId: body.warehouseId,
            currencyCode: body.currencyCode ?? BASE_CURRENCY,
            orderDate: body.orderDate ?? null,
            expectedDate: body.expectedDate ?? null,
            branchId: body.branchId ?? null,
            notes: body.notes ?? null,
            status: "draft",
            ...headerDiscount(body),
          },
          body.lines ?? [],
        );
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/purchase-orders/:id", runApi(async (rc, req) => {
    const pur = await getPurchasingService();
    const res = await pur.getPO(rc, pathParam(req, "id"));
    // Resolve the approver's name server-side (the user table isn't readable by
    // non-admins, but the approver/manager must see who a PO is routed to).
    let approverName: string | null = null;
    if (res.doc.approverId) {
      try {
        const u = await (await getDomainService()).get(systemContext(rc.tenantId, rc.orgId), "user", String(res.doc.approverId));
        approverName = String(u.displayName ?? u.email ?? res.doc.approverId);
      } catch {
        approverName = null;
      }
    }
    return { ...res, approverName };
  }));

  r.put(
    "/purchase-orders/:id",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, replaceDocumentSchema);
        const pur = await getPurchasingService();
        return pur.savePO(rc, pathParam(req, "id"), body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  // Submit a PO for approval (routes to the creator's supervisor; auto-approves
  // when the creator has none). Needs update rights on the PO.
  r.post(
    "/purchase-orders/:id/submit",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "purchaseOrder", action: "purchaseOrder:update" })) {
          throw new ForbiddenError("not allowed to submit purchase orders");
        }
        const pur = await getPurchasingService();
        return { purchaseOrder: await pur.submitPO(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  // Approve / reject a pending PO — the service enforces that only the routed
  // approver (or an admin) may decide.
  r.post(
    "/purchase-orders/:id/approve",
    runApi(
      async (rc, req) => {
        const pur = await getPurchasingService();
        return { purchaseOrder: await pur.decidePO(rc, pathParam(req, "id"), "approve") };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/purchase-orders/:id/reject",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, rejectSchema);
        const pur = await getPurchasingService();
        return { purchaseOrder: await pur.decidePO(rc, pathParam(req, "id"), "reject", body.reason ?? null) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/goods-receipts",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createGoodsReceiptSchema);
        const pur = await getPurchasingService();
        return pur.createGRN(
          rc,
          {
            poId: body.poId ?? null,
            supplierId: body.supplierId ?? null,
            warehouseId: body.warehouseId,
            receiptDate: body.receiptDate ?? null,
            branchId: body.branchId ?? null,
            notes: body.notes ?? null,
          },
          body.lines ?? [],
        );
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/goods-receipts/:id", runApi(async (rc, req) => {
    const pur = await getPurchasingService();
    return pur.getGRN(rc, pathParam(req, "id"));
  }));

  r.post(
    "/goods-receipts/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "goodsReceipt", action: "goodsReceipt:post" })) {
          throw new ForbiddenError("not allowed to post goods receipts");
        }
        const pur = await getPurchasingService();
        const goodsReceipt = await pur.postGRN(rc, pathParam(req, "id"));
        return { goodsReceipt };
      },
      { mutating: true },
    ),
  );


  // ---- landed cost: freight, duty, insurance ---------------------------
  //
  // The part of what goods cost that is not on the supplier's invoice. Booking
  // it to an expense account and valuing stock at the invoice price understates
  // inventory and reports a margin on every subsequent sale that was never
  // earned — and VUK md. 262 puts these inside maliyet bedeli anyway.
  r.post(
    "/landed-costs",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createLandedCostSchema);
        const fin = await getFinanceService();
        const doc = await fin.createDocument(rc, "landedCost", "LC", {
          grnId: body.grnId,
          supplierId: body.supplierId ?? null,
          vendorBillId: body.vendorBillId ?? null,
          costType: body.costType,
          allocationMethod: body.allocationMethod,
          amount: body.amount,
          currencyCode: body.currencyCode ?? BASE_CURRENCY,
          costDate: body.costDate ?? rc.at.slice(0, 10),
          branchId: body.branchId ?? null,
          notes: body.notes ?? null,
          status: "draft",
        });
        return { landedCost: doc };
      },
      { mutating: true, status: 201 },
    ),
  );

  /**
   * What each product would carry, without changing anything.
   *
   * Separate from applying it: "which product ends up carrying this 12.000 lira
   * of freight" is a question people want answered while it is still a
   * proposal. Once applied it is in the moving average, and only a void takes
   * it back out.
   */
  r.get("/landed-costs/:id/preview", runApi(async (rc, req) => {
    const { previewLandedCost } = await import("@/lib/purchasing/landed-cost");
    return previewLandedCost(rc, pathParam(req, "id"));
  }));

  r.post(
    "/landed-costs/:id/apply",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "goodsReceipt", action: "goodsReceipt:post" })) {
          throw new ForbiddenError("not allowed to apply landed costs");
        }
        // Through the lifecycle, so the bespoke route and the generic transition
        // endpoint take exactly the same path — the divergence that once left
        // goods receipts flipping status with no stock movement.
        const domain = await getDomainService();
        const landedCost = await domain.transition(rc, "landedCost", pathParam(req, "id"), "apply");
        return { landedCost };
      },
      { mutating: true },
    ),
  );

  // ---- purchase requests + supplier quotes ------------------------------
  //
  // Purchasing began at the purchase order, which is the point where the
  // company has already committed. Who wanted this, why, when they needed it,
  // and what the alternatives cost happened in conversation and was gone by the
  // time the invoice was queried.
  r.post(
    "/purchase-requests",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createPurchaseRequestSchema);
        const fin = await getFinanceService();
        const doc = await fin.createDocument(rc, "purchaseRequest", "STK", {
          title: body.title,
          warehouseId: body.warehouseId ?? null,
          branchId: body.branchId ?? null,
          requestedDate: rc.at.slice(0, 10),
          neededBy: body.neededBy ?? null,
          priority: body.priority,
          justification: body.justification ?? null,
          notes: body.notes ?? null,
          status: "draft",
        });
        const qe = await getQueryEngine();
        for (const line of body.lines ?? []) {
          await qe.create(rc, "purchaseRequestLine", {
            requestId: doc.id,
            productId: line.productId ?? null,
            description: line.description,
            qty: line.qty,
            uomId: line.uomId ?? null,
            estimatedPrice: line.estimatedPrice ?? null,
            neededBy: line.neededBy ?? null,
          });
        }
        return { purchaseRequest: await qe.get(rc, "purchaseRequest", doc.id) };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/purchase-requests/:id", runApi(async (rc, req) => {
    const qe = await getQueryEngine();
    const id = pathParam(req, "id");
    const [doc, lines] = await Promise.all([
      qe.get(rc, "purchaseRequest", id),
      qe.listComplete(rc, "purchaseRequestLine", { filters: [{ field: "requestId", op: "eq", value: id }] }),
    ]);
    return { doc, lines };
  }));

  /** Record a supplier's offer against a request. */
  r.post(
    "/supplier-quotes",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createSupplierQuoteSchema);
        const fin = await getFinanceService();
        const qe = await getQueryEngine();
        const doc = await fin.createDocument(rc, "supplierQuote", "TKL", {
          requestId: body.requestId,
          supplierId: body.supplierId,
          supplierRef: body.supplierRef ?? null,
          currencyCode: body.currencyCode ?? BASE_CURRENCY,
          quotedAt: body.quotedAt ?? rc.at.slice(0, 10),
          validUntil: body.validUntil ?? null,
          leadTimeDays: body.leadTimeDays ?? null,
          paymentTermDays: body.paymentTermDays ?? null,
          notes: body.notes ?? null,
          status: "received",
        });

        // Totals are summed from the lines that can actually be supplied. An
        // unavailable line contributes nothing — counting it at zero would make
        // the supplier who can supply least look cheapest.
        let subtotal = 0;
        let taxTotal = 0;
        for (const line of body.lines) {
          const lineTotal = line.unavailable ? 0 : Math.round(line.qty * line.unitPrice * 100) / 100;
          const lineTax = Math.round(lineTotal * (line.taxRate / 100) * 100) / 100;
          subtotal += lineTotal;
          taxTotal += lineTax;
          await qe.createWithComputed(
            rc,
            "supplierQuoteLine",
            {
              quoteId: doc.id,
              requestLineId: line.requestLineId ?? null,
              productId: line.productId ?? null,
              description: line.description,
              qty: line.qty,
              uomId: line.uomId ?? null,
              unitPrice: line.unitPrice,
              taxRate: line.taxRate,
              leadTimeDays: line.leadTimeDays ?? null,
              unavailable: line.unavailable,
            },
            { lineTotal },
          );
        }
        subtotal = Math.round(subtotal * 100) / 100;
        taxTotal = Math.round(taxTotal * 100) / 100;
        const supplierQuote = await qe.patchComputed(rc, "supplierQuote", doc.id, {
          subtotal,
          taxTotal,
          total: Math.round((subtotal + taxTotal) * 100) / 100,
        });
        return { supplierQuote };
      },
      { mutating: true, status: 201 },
    ),
  );

  /**
   * Every offer against a request, line by line, with the cheapest marked.
   *
   * Not a ranking: an offer that arrives after the goods were needed is worth
   * nothing, and a supplier who can only supply half the lines is not
   * comparable to one who can supply all of them. The numbers go side by side
   * and a person decides.
   */
  r.get("/purchase-requests/:id/comparison", runApi(async (rc, req) => {
    const { compareQuotes } = await import("@/lib/purchasing/sourcing");
    return compareQuotes(rc, pathParam(req, "id"));
  }));

  r.post(
    "/supplier-quotes/:id/award",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "purchaseOrder", action: "purchaseOrder:create" })) {
          throw new ForbiddenError("not allowed to raise purchase orders");
        }
        const body = parseBody(req, awardQuoteSchema);
        const { awardQuote } = await import("@/lib/purchasing/sourcing");
        return awardQuote(rc, pathParam(req, "id"), body.reason ?? null);
      },
      { mutating: true, status: 201 },
    ),
  );

  /** The routine case: a known product from a known supplier, no quote round. */
  r.post(
    "/purchase-requests/:id/order",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "purchaseOrder", action: "purchaseOrder:create" })) {
          throw new ForbiddenError("not allowed to raise purchase orders");
        }
        const body = parseBody(req, orderRequestSchema);
        const { orderRequestDirect } = await import("@/lib/purchasing/sourcing");
        return orderRequestDirect(rc, pathParam(req, "id"), body.supplierId);
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- purchase returns (alım iadesi) -----------------------------------
  //
  // The supplier side of `salesReturn`, which did not exist: a damaged pallet
  // had nowhere to go, so it was either left on the books as stock we did not
  // have or written off — which puts the cost in the P&L instead of on the
  // supplier's account, and the next payment run pays for goods sent back.
  r.post(
    "/purchase-returns",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createPurchaseReturnSchema);
        const fin = await getFinanceService();
        const doc = await fin.createDocument(rc, "purchaseReturn", "AIA", {
          supplierId: body.supplierId,
          grnId: body.grnId ?? null,
          vendorBillId: body.vendorBillId ?? null,
          warehouseId: body.warehouseId,
          branchId: body.branchId ?? null,
          currencyCode: body.currencyCode ?? BASE_CURRENCY,
          returnDate: body.returnDate ?? rc.at.slice(0, 10),
          reason: body.reason ?? null,
          notes: body.notes ?? null,
          status: "draft",
          ...headerDiscount(body),
        });
        if (body.lines?.length) {
          await fin.replaceLines(rc, "purchaseReturn", "purchaseReturnLine", "returnId", doc.id, body.lines);
        }
        return fin.getDocument(rc, "purchaseReturn", "purchaseReturnLine", "returnId", doc.id);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/purchase-returns/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    return fin.getDocument(rc, "purchaseReturn", "purchaseReturnLine", "returnId", pathParam(req, "id"));
  }));

  r.post(
    "/purchase-returns/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "goodsReceipt", action: "goodsReceipt:post" })) {
          throw new ForbiddenError("not allowed to post purchase returns");
        }
        // Through the lifecycle, so this and the generic transition endpoint
        // take the same path.
        const domain = await getDomainService();
        const purchaseReturn = await domain.transition(rc, "purchaseReturn", pathParam(req, "id"), "post");
        return { purchaseReturn };
      },
      { mutating: true },
    ),
  );

  // ---- supplier price agreements ---------------------------------------
  /** Who can supply this product, preferred first then cheapest. */
  r.get("/products/:id/suppliers", runApi(async (rc, req) => {
    const { suppliersFor } = await import("@/lib/purchasing/supplier-price");
    const rows = await suppliersFor(rc, pathParam(req, "id"));
    const domain = await getDomainService();
    const suppliers = await domain.listByIds(rc, "supplier", rows.map((r) => String(r.supplierId)));
    const byId = new Map(suppliers.map((s) => [String(s.id), String(s.name)]));
    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        supplierId: String(r.supplierId),
        supplierName: byId.get(String(r.supplierId)) ?? null,
        supplierSku: r.supplierSku ?? null,
        unitPrice: Number(r.unitPrice ?? 0),
        currencyCode: String(r.currencyCode ?? BASE_CURRENCY),
        minOrderQty: Number(r.minOrderQty ?? 0),
        leadTimeDays: Number(r.leadTimeDays ?? 0),
        preferred: Boolean(r.preferred),
        // Both figures, deliberately: the agreed price and what was last
        // actually paid. Showing only one hides the discrepancy worth seeing.
        lastPurchasePrice: r.lastPurchasePrice === null || r.lastPurchasePrice === undefined ? null : Number(r.lastPurchasePrice),
        lastPurchaseAt: r.lastPurchaseAt ? String(r.lastPurchaseAt) : null,
      })),
    };
  }));

  // ---- accounts payable: vendor bills + bill payments ------------------
  r.post(
    "/vendor-bills",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, createVendorBillSchema);
        const ap = await getPayablesService();
        return ap.createBill(
          rc,
          {
            supplierId: body.supplierId,
            goodsReceiptId: body.goodsReceiptId ?? null,
            currencyCode: body.currencyCode ?? BASE_CURRENCY,
            billDate: body.billDate ?? null,
            dueDate: body.dueDate ?? null,
            branchId: body.branchId ?? null,
            notes: body.notes ?? null,
            ...headerDiscount(body),
          },
          body.lines ?? [],
        );
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/vendor-bills/:id", runApi(async (rc, req) => {
    const ap = await getPayablesService();
    const [doc, payments] = await Promise.all([ap.getBill(rc, pathParam(req, "id")), ap.listBillPayments(rc, pathParam(req, "id"))]);
    return { ...doc, payments };
  }));

  r.put(
    "/vendor-bills/:id",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, replaceDocumentSchema);
        const ap = await getPayablesService();
        return ap.saveBill(rc, pathParam(req, "id"), body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.post(
    "/vendor-bills/:id/receive",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "vendorBill", action: "vendorBill:receive" })) {
          throw new ForbiddenError("not allowed to receive vendor bills");
        }
        const ap = await getPayablesService();
        return { vendorBill: await ap.receiveBill(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/vendor-bills/:id/payments",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, billPaymentSchema);
        if (typeof body.amount !== "number" || body.amount <= 0) throw new BadRequestError("amount must be positive");
        if (!body.paidAt) throw new BadRequestError("paidAt is required");
        const ap = await getPayablesService();
        const vendorBill = await ap.payBill(rc, pathParam(req, "id"), { amount: body.amount, method: body.method ?? "bank", paidAt: body.paidAt, notes: body.notes ?? null });
        const payments = await ap.listBillPayments(rc, pathParam(req, "id"));
        return { vendorBill, payments };
      },
      { mutating: true, status: 201 },
    ),
  );

}
