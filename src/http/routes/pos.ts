/**
 * Point of sale and the sales cart (Sepet) that feeds it.
 */

import { type Router } from "express";
import { runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { getFinanceService } from "@/lib/finance/service";
import { getPosService } from "@/lib/pos/service";
import { getCartService } from "@/lib/cart/service";
import { permissionEngine } from "@/lib/permissions/engine";
import {
  cartCheckoutSchema,
  cashMovementSchema,
  closeSessionSchema,
  createCartSchema,
  parseBody,
  posCheckoutSchema,
  posSessionSchema,
  replaceDocumentSchema,
} from "@/lib/http/body";
import { BASE_CURRENCY } from "@/lib/config/env";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/enforcement/errors";
import { headerDiscount } from "./shared";

export function registerPosRoutes(r: Router): void {
  // ---- point of sale ---------------------------------------------------
  // Barcode/SKU lookup, till sessions, and the checkout that rings a sale
  // through the invoice → send → pay pipeline (stock issued from warehouseId).
  r.get("/pos/lookup", runApi(async (rc, req) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) throw new BadRequestError("code is required");
    const pos = await getPosService();
    const hit = await pos.scan(rc, code);
    if (!hit) throw new NotFoundError(`no product for code "${code}"`).withKey("err.noProductForCode", { code });
    // `product` stays at the top level: every existing caller reads it there,
    // and a scan that resolves the base unit is exactly what it always was. The
    // unit is additional information beside it, not a replacement.
    return { product: hit.product, uomId: hit.uomId, qty: hit.qty };
  }));

  /**
   * The X-report: a mid-shift read that changes nothing.
   *
   * Same arithmetic as the Z, which is the property that makes it worth
   * trusting — a cashier checks the drawer at lunchtime and the figures still
   * match at closing.
   */
  r.get("/pos/session/:id/report", runApi(async (rc, req) => {
    const { sessionReport } = await import("@/lib/pos/report");
    const kind = req.query.kind === "z" ? "z" : "x";
    return sessionReport(rc, pathParam(req, "id"), kind);
  }));

  /**
   * Money into or out of the drawer that is not a sale.
   *
   * A float top-up, a courier paid from the till. Without somewhere to record
   * these, every one of them surfaced at closing as a variance — and a variance
   * that is routinely wrong is a control nobody reads.
   */
  r.post(
    "/pos/session/:id/cash",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, cashMovementSchema);
        const { recordMovement } = await import("@/lib/pos/report");
        return { movement: await recordMovement(rc, pathParam(req, "id"), body) };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/pos/session", runApi(async (rc) => {
    const pos = await getPosService();
    return { session: await pos.currentSession(rc) };
  }));

  r.post(
    "/pos/session/open",
    runApi(
      async (rc, req) => {
        // The opening float is money in a drawer; a NaN here becomes a session
        // whose variance can never reconcile.
        const body = parseBody(req, posSessionSchema);
        const pos = await getPosService();
        return { session: await pos.openSession(rc, body) };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/pos/session/close",
    runApi(
      async (rc, req) => {
        // `Number(undefined)` is NaN, and NaN in a cash-count column reaches SQL
        // as the bare token `NaN`. The schema requires a finite number.
        const body = parseBody(req, closeSessionSchema);
        const pos = await getPosService();
        return { session: await pos.closeSession(rc, body.sessionId, body.countedCash) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/pos/checkout",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "pos", action: "pos:checkout" })) {
          throw new ForbiddenError("not allowed to check out POS sales");
        }
        // Validated, not cast. A cast made TypeScript agree about an object the
        // caller controls; the till sends this one and an empty `lines` array
        // used to post nothing and return 201 — a completed sale to the terminal,
        // a missing invoice to the books.
        const body = parseBody(req, posCheckoutSchema);

        // Ringing up a sale and deciding what it costs are separate authorities.
        // `pos:checkout` is every cashier; `pos:discount` is the one a shop keeps
        // with a supervisor, because it is how a till leaks money. Refused rather
        // than silently zeroed: a sale that quietly charges more than the cashier
        // told the customer is worse than one that stops and says why.
        const discounting =
          Number(body.discountRate ?? 0) > 0 ||
          Number(body.discountAmount ?? 0) > 0 ||
          body.lines.some((l) => Number(l.discountRate ?? 0) > 0 || Number(l.discountAmount ?? 0) > 0);
        if (discounting && !permissionEngine.can(rc, { entity: "pos", action: "pos:discount" })) {
          throw new ForbiddenError("not allowed to discount at the till");
        }

        const idempotencyKey = req.get("Idempotency-Key") || body.idempotencyKey || null;
        const pos = await getPosService();
        return pos.checkout(rc, { ...body, idempotencyKey });
      },
      { mutating: true, status: 201 },
    ),
  );

  // ---- sales cart (Sepet) ----------------------------------------------
  // A persisted basket (cart + cartLine), workable two ways: sent to the cash
  // desk with a short pickup code (`/send`, then the cashier pays / closes to
  // account / suspends / cancels it), or rung up on the spot (`/checkout`).
  // Either ending goes through the POS pipeline (invoice → send: posts
  // AR/Revenue/COGS + issues stock), so the cart never duplicates GL/stock logic.
  // Which of the two a position may use is decided by its `cart:send` /
  // `cart:checkout` grants in Settings → Permissions.
  r.get("/carts", runApi(async (rc, req) => {
    const cartService = await getCartService();
    const statusParam = typeof req.query.status === "string" ? req.query.status : "";
    const codeParam = typeof req.query.code === "string" ? req.query.code.trim() : "";
    const code = codeParam ? Number(codeParam.replace(/\D/g, "")) : null;
    const items = await cartService.list(rc, {
      statuses: statusParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      code: code && Number.isFinite(code) && code > 0 ? code : null,
      mine: req.query.mine === "1" || req.query.mine === "true",
      search: typeof req.query.q === "string" ? req.query.q : null,
    });
    // The actions each cart offers this caller, so a client renders only buttons
    // the server will actually honour.
    return { items, actions: Object.fromEntries(items.map((c) => [String(c.id), cartService.actionsFor(rc, c)])) };
  }));

  r.get("/carts/:id", runApi(async (rc, req) => {
    const fin = await getFinanceService();
    const cartService = await getCartService();
    const doc = await fin.getDocument(rc, "cart", "cartLine", "cartId", pathParam(req, "id"));
    return { ...doc, actions: cartService.actionsFor(rc, doc.doc) };
  }));

  r.post(
    "/carts",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const body = parseBody(req, createCartSchema);
        const doc = await fin.createDocument(
          rc,
          "cart",
          "CART",
          {
            accountId: body.accountId ?? null,
            branchId: body.branchId ?? null,
            warehouseId: body.warehouseId ?? null,
            currencyCode: body.currencyCode ?? BASE_CURRENCY,
            status: "open",
            notes: body.notes ?? null,
            ...headerDiscount(body),
          },
          // Denormalized so the cashier sees who built the basket without needing
          // permission to read user records.
          { createdByName: rc.displayName },
        );
        if (body.lines?.length) await fin.replaceLines(rc, "cart", "cartLine", "cartId", doc.id, body.lines);
        return fin.getDocument(rc, "cart", "cartLine", "cartId", doc.id);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.put(
    "/carts/:id",
    runApi(
      async (rc, req) => {
        const cartService = await getCartService();
        const body = parseBody(req, replaceDocumentSchema);
        return cartService.save(rc, pathParam(req, "id"), body.header, body.lines ?? []);
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/carts/:id",
    runApi(
      async (rc, req) => {
        const fin = await getFinanceService();
        const domain = await getDomainService();
        const { lines } = await fin.getDocument(rc, "cart", "cartLine", "cartId", pathParam(req, "id"));
        for (const l of lines) await domain.remove(rc, "cartLine", String(l.id));
        await domain.remove(rc, "cart", pathParam(req, "id"));
        return { ok: true };
      },
      { mutating: true },
    ),
  );

  // Hand the basket to the cash desk — assigns the pickup code the cashier
  // searches by (`cart:send`).
  r.post(
    "/carts/:id/send",
    runApi(
      async (rc, req) => {
        const cartService = await getCartService();
        const cart = await cartService.send(rc, pathParam(req, "id"));
        return { cart, code: Number(cart.code ?? 0) };
      },
      { mutating: true, status: 201 },
    ),
  );

  // Park a queued cart / put it back in the queue (`cart:suspend`).
  r.post(
    "/carts/:id/suspend",
    runApi(
      async (rc, req) => {
        const cartService = await getCartService();
        return { cart: await cartService.suspend(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/carts/:id/resume",
    runApi(
      async (rc, req) => {
        const cartService = await getCartService();
        return { cart: await cartService.resume(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  // Reject a cart at the register / void a draft (`cart:cancel`).
  r.post(
    "/carts/:id/cancel",
    runApi(
      async (rc, req) => {
        const cartService = await getCartService();
        return { cart: await cartService.cancel(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  // Close the cart: `paid` tenders at the register (`cart:checkout`), `credit`
  // invoices it and leaves the balance on the customer's account (`cart:credit`).
  r.post(
    "/carts/:id/checkout",
    runApi(
      async (rc, req) => {
        const cartService = await getCartService();
        const body = parseBody(req, cartCheckoutSchema);
        const result = await cartService.close(rc, pathParam(req, "id"), {
          settlement: body.settlement === "credit" ? "credit" : "paid",
          payments: body.payments ?? [],
          idempotencyKey: req.get("Idempotency-Key") || null,
        });
        return {
          invoice: result.invoice,
          cart: result.cart,
          total: result.total,
          paid: result.paid,
          change: result.change,
        };
      },
      { mutating: true, status: 201 },
    ),
  );

}
