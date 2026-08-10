/**
 * Stock: transfers, adjustments, on-hand levels, physical counts, reconciliation
 * and price resolution.
 */

import { type Router } from "express";
import { parseListQuery, runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { getInventoryService } from "@/lib/inventory/service";
import { postStockTransfer, postStockAdjustment } from "@/lib/accounting/postings";
import { permissionEngine } from "@/lib/permissions/engine";
import { countEntriesSchema, parseBody, releaseSchema, reserveSchema, revalueSchema } from "@/lib/http/body";
import { BASE_CURRENCY } from "@/lib/config/env";
import { BadRequestError, ForbiddenError } from "@/lib/enforcement/errors";
import { type Filter } from "@/lib/data/query";

export function registerInventoryRoutes(r: Router): void {
  // ---- inventory: stock transfer / adjustment posting ------------------
  r.post(
    "/stock-transfers/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "stockTransfer", action: "stockTransfer:post" })) {
          throw new ForbiddenError("not allowed to post stock transfers");
        }
        return { stockTransfer: await postStockTransfer(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  r.post(
    "/stock-adjustments/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "stockAdjustment", action: "stockAdjustment:post" })) {
          throw new ForbiddenError("not allowed to post stock adjustments");
        }
        return { stockAdjustment: await postStockAdjustment(rc, pathParam(req, "id")) };
      },
      { mutating: true },
    ),
  );

  // ---- inventory: per-location on-hand levels (stock-levels screen) -----
  // A paged read of `stockBalance` joined with product / warehouse / branch
  // names. Filters (?branchId= ?warehouseId= ?productId=) are applied in SQL, so
  // paging stays correct — the response is the standard Page shape.
  //
  // This used to aggregate the entire movement ledger on every call and then
  // resolve names from whole-table reads that were themselves capped, so beyond
  // 200 products rows rendered with a raw UUID and reorderLevel 0.
  //
  // `?lowStock=` is deliberately NOT handled here: it compares qty against a
  // column on another table, which the filter language cannot express, and
  // post-filtering a page would break pagination. See GET /inventory/low-stock.
  r.get("/inventory/on-hand", runApi(async (rc, req) => {
    const domain = await getDomainService();
    const query = parseListQuery(req);
    const filters: Filter[] = [...(query.filters ?? [])];
    for (const key of ["branchId", "warehouseId", "productId"] as const) {
      const value = req.query[key];
      if (typeof value === "string" && value) filters.push({ field: key, op: "eq", value });
    }
    // Keys that have gone to zero are noise on a stock-levels screen.
    if (req.query.includeZero !== "true") filters.push({ field: "qty", op: "ne", value: 0 });

    const page = await domain.list(rc, "stockBalance", {
      ...query,
      filters,
      sort: query.sort?.length ? query.sort : [{ field: "qty", dir: "desc" }],
    });

    // Resolve names for this page only.
    const [products, warehouses] = await Promise.all([
      domain.listByIds(rc, "product", page.items.map((r) => String(r.productId))),
      domain.listByIds(rc, "warehouse", page.items.map((r) => String(r.warehouseId))),
    ]);
    const branches = await domain.listByIds(rc, "branch", warehouses.map((w) => String(w.branchId ?? "")));
    const pById = new Map(products.map((p) => [String(p.id), p]));
    const wById = new Map(warehouses.map((w) => [String(w.id), w]));
    const bById = new Map(branches.map((b) => [String(b.id), b]));

    const rows = page.items.map((row) => {
      const productId = String(row.productId);
      const warehouseId = String(row.warehouseId);
      const product = pById.get(productId);
      const warehouse = wById.get(warehouseId);
      const wBranchId = warehouse ? String(warehouse.branchId ?? "") : "";
      const reorderLevel = Number(product?.reorderLevel ?? 0);
      const onHand = Number(row.qty ?? 0);
      return {
        productId,
        productName: product ? String(product.name) : productId,
        sku: product ? String(product.sku ?? "") : "",
        barcode: product ? String(product.barcode ?? "") : "",
        // Carried so a list can show the packet rather than four similar names.
        // The product row is already loaded for the name; this costs nothing.
        imageId: product?.imageId ? String(product.imageId) : null,
        warehouseId,
        warehouseName: warehouse ? String(warehouse.name) : warehouseId,
        branchId: wBranchId || null,
        branchName: wBranchId ? String(bById.get(wBranchId)?.name ?? "") : "",
        onHand,
        value: Number(row.value ?? 0),
        avgCost: Number(row.avgCost ?? 0),
        reorderLevel,
        low: reorderLevel > 0 && onHand <= reorderLevel,
      };
    });
    return { rows, total: page.total, page: page.page, pageSize: page.pageSize, pageCount: page.pageCount };
  }));

  // Products at or below their reorder level.
  //
  // Driven from the product side rather than the balance side: `reorderLevel > 0`
  // is a small, deliberately configured set, whereas stockBalance grows with the
  // whole catalogue. Comparing a quantity against a column in another table is
  // not expressible in the filter language, so the comparison happens here — over
  // a bounded set, which is what makes that acceptable.
  r.get("/inventory/low-stock", runApi(async (rc, req) => {
    const domain = await getDomainService();
    const warehouseId = typeof req.query.warehouseId === "string" ? req.query.warehouseId : undefined;

    const tracked = await domain.listComplete(rc, "product", {
      filters: [{ field: "trackStock", op: "eq", value: true }],
    });
    const watched = tracked.filter((p) => Number(p.reorderLevel ?? 0) > 0);
    if (watched.length === 0) return { rows: [] };

    const balanceFilters: Filter[] = [
      { field: "productId", op: "in", value: watched.map((p) => String(p.id)) },
    ];
    if (warehouseId) balanceFilters.push({ field: "warehouseId", op: "eq", value: warehouseId });

    const inventory = await getInventoryService();
    const balances = await inventory.onHandByKey(rc, balanceFilters);
    const byProduct = new Map<string, number>();
    for (const b of balances) byProduct.set(b.productId, (byProduct.get(b.productId) ?? 0) + b.onHand);

    const rows = watched
      .map((p) => ({
        productId: String(p.id),
        productName: String(p.name),
        sku: String(p.sku ?? ""),
        onHand: byProduct.get(String(p.id)) ?? 0,
        reorderLevel: Number(p.reorderLevel ?? 0),
      }))
      .filter((r) => r.onHand <= r.reorderLevel)
      .sort((a, b) => a.onHand - b.onHand);
    return { rows };
  }));

  // ---- lots / parti takibi ---------------------------------------------
  /** What is on hand of a product in a warehouse, batch by batch, in picking order. */
  r.get("/inventory/lots", runApi(async (rc, req) => {
    const productId = typeof req.query.productId === "string" ? req.query.productId : "";
    const warehouseId = typeof req.query.warehouseId === "string" ? req.query.warehouseId : "";
    if (!productId || !warehouseId) throw new BadRequestError("productId and warehouseId are required");
    const { lotStock } = await import("@/lib/inventory/lots");
    return {
      // Quarantined and expired batches are included: they are physically on the
      // shelf and still valued, and a stock screen that hides them is one a
      // stocktake will disagree with.
      rows: await lotStock(rc, productId, warehouseId, { includeUnpickable: true }),
    };
  }));

  /**
   * Where a batch came from and where it went.
   *
   * The recall question — "lot 2026-A is contaminated, who has it?" Built from
   * the movement ledger rather than the documents, because the ledger is the
   * only record of what physically moved.
   */
  r.get("/inventory/lots/:id/trace", runApi(async (rc, req) => {
    const { traceLot } = await import("@/lib/inventory/lots");
    return traceLot(rc, pathParam(req, "id"));
  }));

  /** Batches at or past their date. Run nightly; exposed for a manual sweep. */
  r.post(
    "/inventory/lots/expire",
    runApi(
      async (rc) => {
        if (!permissionEngine.can(rc, { entity: "stockLot", action: "stockLot:update" })) {
          throw new ForbiddenError("not allowed to update lots");
        }
        const { expireLots } = await import("@/lib/inventory/lots");
        return { expired: await expireLots(rc) };
      },
      { mutating: true },
    ),
  );

  /**
   * What to buy, how much, and from whom.
   *
   * The step past `/inventory/low-stock`, which can only say that something is
   * low. This says what to do about it — read against AVAILABLE stock, so goods
   * already promised to a confirmed order do not look like cover.
   *
   * A proposal, not an order. Raising purchase orders automatically is how a
   * mistyped stocktake becomes a pallet of something nobody wanted.
   */
  r.get("/inventory/replenishment", runApi(async (rc, req) => {
    const { suggestReplenishment } = await import("@/lib/inventory/replenish");
    return suggestReplenishment(rc, {
      warehouseId: typeof req.query.warehouseId === "string" ? req.query.warehouseId : undefined,
      includeCovered: req.query.includeCovered === "true",
    });
  }));

  /**
   * Period-end revaluation of open foreign-currency balances (kur değerlemesi).
   *
   * Report-only unless `post` is set. Producing the figures and putting them in
   * the ledger are separate because a revaluation run against a wrong closing
   * rate is a period-end correction nobody enjoys — and the numbers are meant to
   * be reviewed first.
   *
   * When it does post, it posts AND reverses in one call. An unreversed
   * revaluation makes every later settlement count the same difference twice,
   * and "someone will run the reversal" is not a control.
   */
  r.post(
    "/accounting/revalue",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "journalEntry", action: "journalEntry:post" })) {
          throw new ForbiddenError("not allowed to post accounting entries");
        }
        const body = parseBody(req, revalueSchema);
        const { revalue } = await import("@/lib/accounting/revaluation");
        return revalue(rc, { asOf: body.asOf, post: body.post === true });
      },
      { mutating: true },
    ),
  );

  // ---- physical inventory counts (sayım) --------------------------------

  /**
   * Generate the sheet and freeze the system quantities.
   *
   * A count takes hours and sales carry on during it, so the expected figures
   * are snapshotted here and never re-read. Reading them at posting time would
   * fold every intervening movement into the variance and blame the counter for
   * it. See `lib/inventory/count`.
   */
  r.post(
    "/stock-counts/:id/sheet",
    runApi(
      async (rc, req) => {
        const { generateSheet } = await import("@/lib/inventory/count");
        return generateSheet(rc, pathParam(req, "id"));
      },
      { mutating: true },
    ),
  );

  /** Record what was found. Entries arrive by product, because that is what a scanner knows. */
  r.post(
    "/stock-counts/:id/entries",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, countEntriesSchema);
        const { recordCount } = await import("@/lib/inventory/count");
        return recordCount(rc, pathParam(req, "id"), body.entries);
      },
      { mutating: true },
    ),
  );

  /**
   * Post the count.
   *
   * Separate permission from counting: writing off stock is money leaving the
   * books, and the person holding the scanner is rarely the one who should sign
   * for that.
   */
  r.post(
    "/stock-counts/:id/post",
    runApi(
      async (rc, req) => {
        if (!permissionEngine.can(rc, { entity: "stockCount", action: "stockCount:post" })) {
          throw new ForbiddenError("not allowed to post a stock count");
        }
        const { postCount } = await import("@/lib/inventory/count");
        return postCount(rc, pathParam(req, "id"));
      },
      { mutating: true },
    ),
  );

  // Run the stock-condition scan now rather than waiting for the nightly job.
  //
  // Deliberately NOT read-only: opening an alert is what emits the event the
  // automation rules act on, so a "preview" mode would test a different code
  // path than the one that runs in production — and the scan is idempotent, so
  // running it twice changes nothing the first run did not already do.
  r.post(
    "/inventory/alerts/scan",
    runApi(
      async (rc) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const { scanStockAlerts } = await import("@/lib/inventory/alerts");
        return scanStockAlerts(rc);
      },
      { mutating: true },
    ),
  );

  /**
   * What can still be promised: on hand, held, and the difference.
   *
   * Sellable stock is `qty - reservedQty`, and this is the only place a caller
   * should ask. Reading `onHand` and subtracting holds separately is a check two
   * callers can pass at the same instant — which is the race reservations exist
   * to close.
   */
  r.get("/inventory/availability", runApi(async (rc, req) => {
    const { availability } = await import("@/lib/inventory/reservations");
    const productId = typeof req.query.productId === "string" ? req.query.productId : "";
    const warehouseId = typeof req.query.warehouseId === "string" ? req.query.warehouseId : "";
    if (!productId || !warehouseId) throw new BadRequestError("productId and warehouseId are required");
    return availability(rc, productId, warehouseId);
  }));

  /**
   * Hold stock for a document.
   *
   * The availability check happens INSIDE, under a row lock — not here, and not
   * in the caller. A check outside the write is one two callers can pass at the
   * same instant, which is precisely the race this exists to close.
   */
  r.post(
    "/inventory/reserve",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, reserveSchema);
        const { reserve } = await import("@/lib/inventory/reservations");
        return reserve(rc, {
          productId: body.productId,
          warehouseId: body.warehouseId,
          qty: body.qty,
          refType: body.refType,
          refId: body.refId,
          expiresAt: body.expiresAt ?? null,
        });
      },
      { mutating: true, status: 201 },
    ),
  );

  /** Give back everything a document was holding. */
  r.post(
    "/inventory/release",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, releaseSchema);
        const { release } = await import("@/lib/inventory/reservations");
        // `consumed` when the goods actually shipped: the issue already reduced
        // the quantity, so the hold must drop at the same moment or the same
        // units are subtracted twice.
        const released = await release(rc, body.refType, body.refId, body.consumed ? "consumed" : "released");
        return { released };
      },
      { mutating: true },
    ),
  );

  // The same, for the conditions outside stock: purchase orders past their
  // promised date, transfers stuck in transit, large count and till variances,
  // and bills that differ from what the goods were received at.
  //
  // Deliberately NOT read-only, for the same reason as the stock scan above:
  // opening an alert is what emits the event the automation rules act on, so a
  // "preview" mode would exercise a different code path than the one that runs
  // in production — and the scan is idempotent, so running it twice changes
  // nothing the first run did not already do.
  r.post(
    "/operations/alerts/scan",
    runApi(
      async (rc) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const { scanOperationsAlerts } = await import("@/lib/ops/alerts");
        return scanOperationsAlerts(rc);
      },
      { mutating: true },
    ),
  );

  // Assert that every stock balance still equals its ledger. Report-only by
  // default; `?apply=true` rebuilds drifted balances from the movements.
  r.post(
    "/inventory/reconcile",
    runApi(
      async (rc, req) => {
        if (!rc.roles.includes("admin")) throw new ForbiddenError("admins only");
        const { reconcileStockBalances } = await import("@/lib/inventory/reconcile");
        return reconcileStockBalances(rc, {
          apply: req.query.apply === "true",
          productId: typeof req.query.productId === "string" ? req.query.productId : undefined,
          warehouseId: typeof req.query.warehouseId === "string" ? req.query.warehouseId : undefined,
        });
      },
      { mutating: true },
    ),
  );


  /**
   * What a product costs for this customer, at this quantity, on this date.
   *
   * A lookup the line editor and the till both call before defaulting a price.
   * It answers with the SOURCE as well as the number — "customer list" versus
   * "product price" is the difference between a negotiated agreement and a
   * fallback, and a salesperson looking at an unexpected figure needs to know
   * which one they are looking at.
   */
  r.get("/pricing/resolve", runApi(async (rc, req) => {
    const productId = String(req.query.productId ?? "");
    if (!productId) throw new BadRequestError("productId is required");
    const qty = Number(req.query.qty ?? 1);
    const { priceFor } = await import("@/lib/pricing/service");
    return priceFor(rc, {
      productId,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      currencyCode: String(req.query.currencyCode ?? BASE_CURRENCY),
      // Defaults to today, but accepts a date so a backdated document prices as
      // of its own date rather than as of now.
      onDate: String(req.query.onDate ?? rc.at).slice(0, 10),
      accountId: req.query.accountId ? String(req.query.accountId) : null,
    });
  }));

}
