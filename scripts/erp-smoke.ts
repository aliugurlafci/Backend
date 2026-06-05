/* eslint-disable no-console */
/**
 * Throwaway ERP smoke — runs against the in-memory repository through the real
 * QueryEngine. Run: AULA_PERSISTENCE=memory tsx scripts/erp-smoke.ts
 */
import { getQueryEngine } from "@/lib/data/store";
import { metadata } from "@/lib/metadata";
import { systemContext } from "@/lib/context/resolver";
import { DEMO_ORG, DEMO_TENANT } from "@/lib/context/dev";
import { getInventoryService } from "@/lib/inventory/service";
import { getPurchasingService } from "@/lib/purchasing/service";
import { getAccountingService } from "@/lib/accounting/service";
import { getFinanceService } from "@/lib/finance/service";
import { getPayablesService } from "@/lib/payables/service";
import { postInvoiceGL, postStockTransfer, postStockAdjustment } from "@/lib/accounting/postings";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

async function main(): Promise<void> {
  const qe = await getQueryEngine();
  const ctx = systemContext(DEMO_TENANT, DEMO_ORG);

  console.log("\n[metadata] removed entities are gone:");
  for (const name of ["project", "milestone", "timesheet", "campaign", "ticket", "post"]) {
    assert(!metadata.findEntity?.(name) && !metadata.listEntities().some((e) => e.name === name), `${name} removed`);
  }

  console.log("\n[metadata] new entities registered:");
  for (const name of ["branch", "dealer"]) {
    assert(metadata.listEntities().some((e) => e.name === name), `${name} present`);
  }

  console.log("\n[metadata] branch/dealer reference fields present:");
  const inv = metadata.getEntity("invoice");
  assert(inv.fields.some((f) => f.name === "branchId"), "invoice.branchId field");
  assert(inv.fields.some((f) => f.name === "dealerId"), "invoice.dealerId field");

  console.log("\n[data] seeded branches & dealers:");
  const branches = await qe.list(ctx, "branch", { pageSize: 50 });
  assert(branches.total >= 2, `branches seeded (${branches.total})`);
  const dealers = await qe.list(ctx, "dealer", { pageSize: 50 });
  assert(dealers.total >= 2, `dealers seeded (${dealers.total})`);

  console.log("\n[data] invoices carry a branchId:");
  const invoices = await qe.list(ctx, "invoice", { pageSize: 50 });
  const withBranch = invoices.items.filter((i) => i.branchId).length;
  assert(withBranch >= 3, `invoices have branchId (${withBranch}/${invoices.total})`);

  console.log("\n[data] filter invoices by branch:");
  const firstBranch = branches.items[0];
  const byBranch = await qe.list(ctx, "invoice", {
    filters: [{ field: "branchId", op: "eq", value: firstBranch.id }],
    pageSize: 50,
  });
  assert(byBranch.total >= 1, `invoices filtered by branch "${firstBranch.name}" (${byBranch.total})`);

  console.log("\n[ids] record ids are sequential int strings + references resolve:");
  const branchIds = branches.items.map((b) => String(b.id));
  assert(branchIds.every((id) => /^\d+$/.test(id)), `branch ids are numeric strings (${branchIds.join(",")})`);
  assert(Math.min(...branchIds.map(Number)) === 1, "an entity's ids start at 1");
  const invWithBranch = invoices.items.find((i) => i.branchId)!;
  const refBranch = await qe.get(ctx, "branch", String(invWithBranch.branchId));
  assert(!!refBranch, `invoice.branchId "${invWithBranch.branchId}" resolves to a branch row`);
  assert(typeof invWithBranch.branchId === "string", "reference value is a string in the app layer");

  // ---- Phase 2: inventory ----
  console.log("\n[inventory] entities registered:");
  for (const name of ["warehouse", "supplier", "stockMovement"]) {
    assert(metadata.listEntities().some((e) => e.name === name), `${name} present`);
  }
  assert(metadata.getEntity("product").fields.some((f) => f.name === "trackStock"), "product.trackStock field");

  console.log("\n[inventory] seeded warehouses/suppliers/opening stock:");
  const warehouses = await qe.list(ctx, "warehouse", { pageSize: 50 });
  assert(warehouses.total >= 2, `warehouses seeded (${warehouses.total})`);
  const suppliers = await qe.list(ctx, "supplier", { pageSize: 50 });
  assert(suppliers.total >= 2, `suppliers seeded (${suppliers.total})`);
  const movements = await qe.list(ctx, "stockMovement", { pageSize: 100 });
  assert(movements.total >= 5, `opening movements seeded (${movements.total})`);

  console.log("\n[inventory] on-hand derived from the ledger:");
  const inventory = await getInventoryService();
  const router = (await qe.list(ctx, "product", { filters: [{ field: "sku", op: "eq", value: "HW-RTR-X100" }], pageSize: 1 })).items[0];
  const whMain = (await qe.list(ctx, "warehouse", { filters: [{ field: "code", op: "eq", value: "WH-MAIN" }], pageSize: 1 })).items[0];
  const totalRouter = await inventory.onHand(ctx, router.id);
  const mainRouter = await inventory.onHand(ctx, router.id, whMain.id);
  assert(totalRouter === 52, `router total on-hand = 52 (got ${totalRouter})`);
  assert(mainRouter === 40, `router @ main on-hand = 40 (got ${mainRouter})`);

  console.log("\n[inventory] valuation + on-hand-by-key:");
  const valuation = await inventory.valuation(ctx);
  // 40*720 + 12*720 + 30*410 + 120*65 + 45*65 = 28800+8640+12300+7800+2925 = 60465
  assert(valuation === 60465, `total valuation = 60465 (got ${valuation})`);
  const byKey = await inventory.onHandByKey(ctx);
  assert(byKey.length === 5, `5 product+warehouse on-hand rows (got ${byKey.length})`);

  console.log("\n[inventory] writeMovement is idempotent:");
  const before = (await qe.list(ctx, "stockMovement", { pageSize: 1 })).total;
  await inventory.writeMovement(ctx, { productId: router.id, warehouseId: whMain.id, qty: 40, type: "receipt", unitCost: 720, ref: "OPENING", refType: "opening", branchId: whMain.branchId as string });
  const after = (await qe.list(ctx, "stockMovement", { pageSize: 1 })).total;
  assert(before === after, `re-post OPENING is a no-op (${before} → ${after})`);

  // ---- Phase 3: purchasing ----
  console.log("\n[purchasing] entities + seeded PO:");
  for (const name of ["purchaseOrder", "purchaseOrderLine", "goodsReceipt", "goodsReceiptLine"]) {
    assert(metadata.listEntities().some((e) => e.name === name), `${name} present`);
  }
  const pos = await qe.list(ctx, "purchaseOrder", { pageSize: 10 });
  assert(pos.total >= 1, `purchase orders seeded (${pos.total})`);

  console.log("\n[purchasing] create + post a goods receipt:");
  const purchasing = await getPurchasingService();
  const po = pos.items[0];
  const routerBefore = await inventory.onHand(ctx, router.id, whMain.id);
  const grn = await purchasing.createGRN(
    ctx,
    { poId: po.id, supplierId: po.supplierId, warehouseId: whMain.id, receiptDate: "2026-01-26", branchId: whMain.branchId as string },
    [{ productId: router.id, qty: 20, unitCost: 720 }],
  );
  assert(grn.doc.status === "draft", "GRN created as draft");
  const posted = await purchasing.postGRN(ctx, grn.doc.id);
  assert(posted.status === "posted", "GRN posted");
  const routerAfter = await inventory.onHand(ctx, router.id, whMain.id);
  assert(routerAfter === routerBefore + 20, `on-hand +20 after GRN (${routerBefore} → ${routerAfter})`);

  console.log("\n[purchasing] re-post is idempotent:");
  const movesBefore = (await qe.list(ctx, "stockMovement", { pageSize: 1 })).total;
  await purchasing.postGRN(ctx, grn.doc.id);
  const movesAfter = (await qe.list(ctx, "stockMovement", { pageSize: 1 })).total;
  assert(movesBefore === movesAfter, `re-post GRN writes no new movements (${movesBefore} → ${movesAfter})`);

  console.log("\n[purchasing] PO received qty + status reconciled:");
  const poLinesAfter = await qe.list(ctx, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: po.id }], pageSize: 10 });
  const routerLine = poLinesAfter.items.find((l) => l.productId === router.id);
  assert(!!routerLine && Number(routerLine.qtyReceived) === 20, `router PO line qtyReceived = 20 (got ${routerLine?.qtyReceived})`);
  const poAfter = await qe.get(ctx, "purchaseOrder", po.id);
  assert(poAfter.status === "partial", `PO status = partial after partial receipt (got ${poAfter.status})`);

  // ---- Phase 4: accounting ----
  console.log("\n[accounting] entities + seeded chart of accounts:");
  for (const name of ["ledgerAccount", "fiscalPeriod", "journalEntry", "journalLine"]) {
    assert(metadata.listEntities().some((e) => e.name === name), `${name} present`);
  }
  const coa = await qe.list(ctx, "ledgerAccount", { pageSize: 50 });
  assert(coa.total >= 10, `chart of accounts seeded (${coa.total})`);

  const accounting = await getAccountingService();
  const sumTB = async () => {
    const tb = await accounting.trialBalance(ctx);
    return { dr: Math.round(tb.reduce((s, r) => s + r.debit, 0) * 100) / 100, cr: Math.round(tb.reduce((s, r) => s + r.credit, 0) * 100) / 100 };
  };

  console.log("\n[accounting] trial balance balanced (seed + earlier postings):");
  let bal = await sumTB();
  assert(bal.dr === bal.cr, `Σdebit ${bal.dr} == Σcredit ${bal.cr}`);
  assert(bal.dr >= 60465, `opening balances present (≥ 60465, got ${bal.dr})`);

  console.log("\n[accounting] post a balanced manual entry:");
  const cash = await accounting.requireAccount(ctx, "cash");
  const rev = await accounting.requireAccount(ctx, "sales_revenue");
  const manual = await accounting.createAndPost(ctx, { date: "2026-02-01", memo: "cash sale" }, [
    { ledgerAccountId: cash, debit: 500 },
    { ledgerAccountId: rev, credit: 500 },
  ]);
  assert(manual.status === "posted", "manual entry posted");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB still balanced (${bal.dr}/${bal.cr})`);

  console.log("\n[accounting] unbalanced entry rejected:");
  let rejected = false;
  try {
    await accounting.createEntry(ctx, { date: "2026-02-02" }, [{ ledgerAccountId: cash, debit: 100 }, { ledgerAccountId: rev, credit: 90 }]);
  } catch {
    rejected = true;
  }
  assert(rejected, "unbalanced entry rejected");

  console.log("\n[accounting] void → reversing entry:");
  const jeBefore = (await qe.list(ctx, "journalEntry", { pageSize: 1 })).total;
  const voided = await accounting.voidEntry(ctx, manual.id);
  assert(voided.status === "void", "entry marked void");
  const jeAfter = (await qe.list(ctx, "journalEntry", { pageSize: 1 })).total;
  assert(jeAfter === jeBefore + 1, `reversal entry created (${jeBefore} → ${jeAfter})`);
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after reversal (${bal.dr}/${bal.cr})`);

  console.log("\n[accounting] closed-period posting rejected:");
  const fp = (await qe.list(ctx, "fiscalPeriod", { pageSize: 1 })).items[0];
  await qe.patchComputed(ctx, "fiscalPeriod", fp.id, { status: "closed" });
  let periodRejected = false;
  try {
    await accounting.createAndPost(ctx, { date: "2026-03-01", memo: "should fail" }, [{ ledgerAccountId: cash, debit: 10 }, { ledgerAccountId: rev, credit: 10 }]);
  } catch {
    periodRejected = true;
  }
  assert(periodRejected, "posting into closed period rejected");
  await qe.patchComputed(ctx, "fiscalPeriod", fp.id, { status: "open" });

  // ---- Phase 5: auto-posting ----
  const finance = await getFinanceService();
  const account = (await qe.list(ctx, "account", { pageSize: 1 })).items[0];
  const jeCount = async (source: string, ref: string) =>
    (await qe.list(ctx, "journalEntry", { filters: [{ field: "source", op: "eq", value: source }, { field: "sourceRef", op: "eq", value: ref }], pageSize: 5 })).total;

  console.log("\n[auto-post] invoice send → AR/Revenue/Tax + COGS:");
  const invDoc = await finance.createDocument(ctx, "invoice", "INV", {
    accountId: account.id, branchId: whMain.branchId as string, currencyCode: "USD",
    issueDate: "2026-02-10", dueDate: "2026-03-10", status: "draft",
  });
  await finance.replaceLines(ctx, "invoice", "invoiceLine", "invoiceId", invDoc.id, [
    { productId: router.id, description: "Edge Router X100", qty: 2, unitPrice: 1200, taxRate: 20 },
  ]);
  assert(/^\d+$/.test(String(invDoc.id)) && Number(invDoc.id) >= 4, `runtime invoice id continues the seeded sequence (got ${invDoc.id})`);
  const onHandBefore = await inventory.onHand(ctx, router.id, whMain.id);
  await postInvoiceGL(ctx, invDoc.id);
  assert((await jeCount("invoice", invDoc.id)) === 1, "invoice AR/Revenue/Tax entry posted");
  assert((await jeCount("stockIssue", invDoc.id)) === 1, "COGS entry posted");
  const onHandAfter = await inventory.onHand(ctx, router.id, whMain.id);
  assert(onHandAfter === onHandBefore - 2, `stock issued on sale (${onHandBefore} → ${onHandAfter})`);
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after invoice posting (${bal.dr}/${bal.cr})`);

  console.log("\n[auto-post] invoice re-post is idempotent:");
  await postInvoiceGL(ctx, invDoc.id);
  assert((await jeCount("invoice", invDoc.id)) === 1, "invoice GL not double-posted");
  assert((await jeCount("stockIssue", invDoc.id)) === 1, "COGS not double-posted");

  console.log("\n[auto-post] payment → Cash/AR:");
  await finance.applyPayment(ctx, invDoc.id, { amount: 500, method: "bank", paidAt: "2026-02-15" });
  const payments = await qe.list(ctx, "payment", { sort: [{ field: "paidAt", dir: "desc" }], pageSize: 1 });
  assert((await jeCount("payment", payments.items[0].id)) === 1, "payment Cash/AR entry posted");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after payment (${bal.dr}/${bal.cr})`);

  console.log("\n[auto-post] goods receipt posted to GL (from Phase 3):");
  const grnEntries = (await qe.list(ctx, "journalEntry", { filters: [{ field: "source", op: "eq", value: "goodsReceipt" }], pageSize: 10 })).total;
  assert(grnEntries >= 1, `GRN Inventory/GR-IR entry posted (${grnEntries})`);
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced end-to-end (${bal.dr}/${bal.cr})`);

  // ---- Phase 6: AP + transfer/adjustment ----
  console.log("\n[payables] vendor bill receive → AP, then pay → AP/Cash:");
  const payables = await getPayablesService();
  const supplier = (await qe.list(ctx, "supplier", { pageSize: 1 })).items[0];
  const billRes = await payables.createBill(
    ctx,
    { supplierId: supplier.id, branchId: whMain.branchId as string, billDate: "2026-02-20", dueDate: "2026-03-20", currencyCode: "USD" },
    [{ productId: null, description: "Office supplies", qty: 1, unitPrice: 1000, taxRate: 20 }],
  );
  const received = await payables.receiveBill(ctx, billRes.doc.id);
  assert(received.status === "received", "vendor bill received");
  assert((await jeCount("vendorBill", billRes.doc.id)) === 1, "AP entry posted on receive");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after bill receive (${bal.dr}/${bal.cr})`);
  const billPaid = await payables.payBill(ctx, billRes.doc.id, { amount: 1200, method: "bank", paidAt: "2026-02-25" });
  assert(billPaid.status === "paid", `bill fully paid (status ${billPaid.status})`);
  const bpay = (await qe.list(ctx, "billPayment", { pageSize: 1 })).items[0];
  assert((await jeCount("billPayment", bpay.id)) === 1, "AP/Cash entry posted on bill payment");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after bill payment (${bal.dr}/${bal.cr})`);

  console.log("\n[inventory] stock transfer (net-zero total on-hand):");
  const whEast = (await qe.list(ctx, "warehouse", { filters: [{ field: "code", op: "eq", value: "WH-EAST" }], pageSize: 1 })).items[0];
  const mainBefore = await inventory.onHand(ctx, router.id, whMain.id);
  const totalBefore = await inventory.onHand(ctx, router.id);
  const transfer = await qe.create(ctx, "stockTransfer", {
    number: "TRF-1", fromWarehouseId: whMain.id, toWarehouseId: whEast.id, productId: router.id,
    qty: 5, unitCost: 720, status: "draft", transferDate: "2026-02-26", branchId: whMain.branchId as string,
  });
  await postStockTransfer(ctx, transfer.id);
  const totalAfter = await inventory.onHand(ctx, router.id);
  const mainAfter = await inventory.onHand(ctx, router.id, whMain.id);
  assert(totalAfter === totalBefore, `transfer keeps total on-hand (${totalBefore} → ${totalAfter})`);
  assert(mainAfter === mainBefore - 5, `main warehouse −5 after transfer (${mainBefore} → ${mainAfter})`);

  console.log("\n[inventory] stock adjustment (movement + GL):");
  const adjBefore = await inventory.onHand(ctx, router.id, whMain.id);
  const adj = await qe.create(ctx, "stockAdjustment", {
    number: "ADJ-1", warehouseId: whMain.id, productId: router.id, qtyDelta: -3, unitCost: 720,
    reason: "Damaged", status: "draft", adjustedAt: "2026-02-27", branchId: whMain.branchId as string,
  });
  await postStockAdjustment(ctx, adj.id);
  const adjAfter = await inventory.onHand(ctx, router.id, whMain.id);
  assert(adjAfter === adjBefore - 3, `adjustment applied (${adjBefore} → ${adjAfter})`);
  assert((await jeCount("adjustment", adj.id)) === 1, "adjustment GL posted");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after adjustment (${bal.dr}/${bal.cr})`);

  // ---- Calendar: shared events, viewer-read + admin-only CRUD ----
  console.log("\n[calendar] calendarEvent + view permission + admin CRUD:");
  assert(metadata.listEntities().some((e) => e.name === "calendarEvent"), "calendarEvent entity registered");
  const calBefore = await qe.list(ctx, "calendarEvent", { pageSize: 50 });
  assert(calBefore.total >= 3, `seeded calendar events present (${calBefore.total})`);
  const newEv = await qe.create(ctx, "calendarEvent", { title: "Smoke event", date: "2026-03-15", type: "meeting" });
  assert(/^\d+$/.test(String(newEv.id)), `admin created event (id ${newEv.id})`);
  const repCtx = systemContext(DEMO_TENANT, DEMO_ORG, { isSystem: false, roles: ["sales_rep"], userId: "3" });
  const repView = await qe.list(repCtx, "calendarEvent", { pageSize: 5 });
  assert(repView.total >= 1, `viewer (sales_rep) can read events (${repView.total})`);
  let repDenied = false;
  try {
    await qe.create(repCtx, "calendarEvent", { title: "nope", date: "2026-03-16" });
  } catch {
    repDenied = true;
  }
  assert(repDenied, "viewer (sales_rep) cannot create events");

  // ---- Chat: DM/group create, private read, admin reachable ----
  console.log("\n[chat] DM create + private read + group + admin reachable:");
  const chat = await import("@/lib/chat/service");
  const adminCtx = systemContext(DEMO_TENANT, DEMO_ORG, { userId: "1", displayName: "Avery Admin", isSystem: false, roles: ["admin"] });
  const repChatCtx = systemContext(DEMO_TENANT, DEMO_ORG, { userId: "3", displayName: "Riley Rep", isSystem: false, roles: ["sales_rep"] });
  const outsiderCtx = systemContext(DEMO_TENANT, DEMO_ORG, { userId: "4", displayName: "Casey", isSystem: false, roles: ["accountant"] });

  const dm = await chat.createMessage(repChatCtx, { participants: ["1"], body: "Merhaba admin!" });
  assert(/^\d+$/.test(String(dm.id)) && dm.conversationId === "1-3", `rep→admin DM created (conv ${dm.conversationId})`);
  const adminMsgs = await chat.listMessages(adminCtx, "1-3");
  assert(adminMsgs.some((m) => m.body === "Merhaba admin!"), "admin reads the DM (participant)");
  let chatDenied = false;
  try {
    await chat.listMessages(outsiderCtx, "1-3");
  } catch {
    chatDenied = true;
  }
  assert(chatDenied, "non-participant cannot read the conversation");
  const repConvs = await chat.listConversations(repChatCtx);
  assert(repConvs.some((c) => c.conversationId === "1-3"), "conversation appears in rep's list");
  const grp = await chat.createMessage(repChatCtx, { participants: ["1", "2"], body: "grup selam" });
  assert(grp.conversationId === "1-2-3", `group conversation key sorted (${grp.conversationId})`);
  const chatUsers = await chat.listChatUsers(repChatCtx);
  assert(chatUsers.some((u) => u.isAdmin), "chat users include an admin (everyone can DM admin)");
  assert(!chatUsers.some((u) => u.id === "3"), "picker excludes self");

  console.log(failures === 0 ? "\n✅ ERP smoke passed (Phase 1–6)\n" : `\n❌ ${failures} assertion(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
