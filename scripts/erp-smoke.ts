/* eslint-disable no-console */
/**
 * Throwaway ERP smoke — runs against the in-memory repository through the real
 * QueryEngine. Run: AULA_PERSISTENCE=memory tsx scripts/erp-smoke.ts
 */
import { getQueryEngine, getRepository } from "@/lib/data/store";
import { seedInto } from "@/lib/data/seed";
import { ensureDemoUsers } from "@/lib/security/auth-seed";
import { metadata } from "@/lib/metadata";
import { systemContext } from "@/lib/context/resolver";
import { DEMO_ORG, DEMO_TENANT } from "@/lib/context/dev";
import { getInventoryService } from "@/lib/inventory/service";
import { getPurchasingService } from "@/lib/purchasing/service";
import { getAccountingService } from "@/lib/accounting/service";
import { getFinanceService } from "@/lib/finance/service";
import { getPayablesService } from "@/lib/payables/service";
import { postInvoiceGL, reverseInvoiceGL, postStockTransfer, postStockAdjustment, registerAccountingPostings, retryFailedPostings, listPostingFailures, clearPostingFailures } from "@/lib/accounting/postings";
import { eventBus } from "@/lib/workflow/event-bus";
import { getPosService } from "@/lib/pos/service";
import { getDomainService } from "@/lib/domain";
import ExcelJS from "exceljs";
import { importCsv, importXlsx, buildImportTemplate, parseXlsx } from "@/lib/integrations/import-export";
import { exportXlsx } from "@/lib/integrations/export-formats";
import { executeRule, runScheduledAutomations, enqueueScheduled, processQueue, getLiveActivity, evaluateLeaf, registerAutomationEngine } from "@/lib/automation/engine";
import { automationStore } from "@/lib/automation/store";
import { runAllJobs } from "@/lib/jobs/scheduler";
import { notifications, registerNotifications, inQuietHours, buildInAppMuteFilter } from "@/lib/integrations/notifications";
import { permissionEngine } from "@/lib/permissions/engine";
import { grantsClaimFor, login, recordSecurityEvent } from "@/lib/security/auth-service";
import { randomBase32Secret, totpNow, totpVerify, encrypt } from "@/lib/security/crypto";
import type { EntityRecord } from "@/lib/metadata/types";
import { internalEan13, isValidBarcode } from "@/lib/barcode/check-digit";
import { assertSafeWebhookUrl } from "@/lib/integrations/webhooks";

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
  // Server boot only seeds the admin now, so the smoke seeds its own demo data:
  // business records first (branches), then the demo users (which look up branches).
  await seedInto(getRepository());
  await ensureDemoUsers(getRepository());
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

  console.log("\n[accounting] GL self-heals a missing chart of accounts (fresh tenant):");
  const acctSvc = await getAccountingService();
  const freshAcctCtx = systemContext("t_fresh_acct", "o_fresh_acct");
  const invAcctId = await acctSvc.requireAccount(freshAcctCtx, "inventory");
  assert(!!invAcctId, "requireAccount self-provisions a missing system account (inventory)");
  assert((await acctSvc.accountBySubtype(freshAcctCtx, "inventory"))?.id === invAcctId, "self-provisioned account is found by subtype");
  const grIrAcctId = await acctSvc.requireAccount(freshAcctCtx, "gr_ir");
  assert(grIrAcctId !== invAcctId, "a distinct subtype gets its own account (gr_ir)");

  console.log("\n[purchasing] PO received qty + status reconciled:");
  const poLinesAfter = await qe.list(ctx, "purchaseOrderLine", { filters: [{ field: "poId", op: "eq", value: po.id }], pageSize: 10 });
  const routerLine = poLinesAfter.items.find((l) => l.productId === router.id);
  assert(!!routerLine && Number(routerLine.qtyReceived) === 20, `router PO line qtyReceived = 20 (got ${routerLine?.qtyReceived})`);
  const poAfter = await qe.get(ctx, "purchaseOrder", po.id);
  assert(poAfter.status === "partial", `PO status = partial after partial receipt (got ${poAfter.status})`);

  console.log("\n[purchasing] PO approval routing (rep → manager, admin auto) + GRN gating:");
  registerNotifications(); // subscribe the notification handlers to the event bus
  // System contexts scoped to specific seeded users (isSystem bypasses RBAC — the
  // HTTP endpoints enforce that; here we exercise the workflow logic).
  const poRepCtx = systemContext(DEMO_TENANT, DEMO_ORG, { userId: "3" }); // Riley Rep → manager 2
  const poMgrCtx = systemContext(DEMO_TENANT, DEMO_ORG, { userId: "2", roles: ["sales_manager"] }); // Morgan Manager
  const poAdminCtx = systemContext(DEMO_TENANT, DEMO_ORG, { userId: "1", roles: ["admin"] }); // Avery Admin (no manager)
  const poAcctCtx = systemContext(DEMO_TENANT, DEMO_ORG, { userId: "4", roles: ["accountant"] }); // Casey (not the approver)
  const supId = String(po.supplierId);
  const mkPO = (octx: typeof ctx, qty: number) =>
    purchasing.createPO(
      octx,
      { supplierId: supId, warehouseId: whMain.id, currencyCode: "USD", branchId: whMain.branchId as string, status: "draft" },
      [{ productId: router.id, description: "Edge Router X100", qty, unitPrice: 720, taxRate: 20 }],
    );

  // Rep creates + submits → routed to the rep's manager (user 2).
  const repPO = await mkPO(poRepCtx, 5);
  assert(String(repPO.doc.ownerId) === "3", `PO owned by its creator (got ${repPO.doc.ownerId})`);
  const submitted = await purchasing.submitPO(poRepCtx, repPO.doc.id);
  assert(submitted.status === "pending", `submit routes to pending (got ${submitted.status})`);
  assert(String(submitted.approverId) === "2", `routed to creator's manager (got ${submitted.approverId})`);
  // Notification: the routed approver (user 2) is told; an uninvolved user (4) is not.
  const noteEv = (uid: string, ev: string) => notifications.list(DEMO_TENANT, DEMO_ORG, uid).some((n) => n.eventType === ev);
  assert(noteEv("2", "purchaseOrder.submitted"), "approver notified of pending PO");
  assert(!noteEv("4", "purchaseOrder.submitted"), "uninvolved user is NOT notified (per-user targeting)");

  // A non-approver (accountant) cannot decide it; the routed manager can.
  let nonApproverDenied = false;
  try { await purchasing.decidePO(poAcctCtx, repPO.doc.id, "approve"); } catch { nonApproverDenied = true; }
  assert(nonApproverDenied, "non-approver cannot approve the PO");
  const approvedPO = await purchasing.decidePO(poMgrCtx, repPO.doc.id, "approve");
  assert(approvedPO.status === "approved", `manager approves → approved (got ${approvedPO.status})`);
  assert(noteEv("3", "purchaseOrder.approved"), "creator notified of approval");

  // Admin has no supervisor → submitting auto-approves; no self-notification.
  const adminPO = await mkPO(poAdminCtx, 2);
  const adminSubmitted = await purchasing.submitPO(poAdminCtx, adminPO.doc.id);
  assert(adminSubmitted.status === "approved", `no supervisor → auto-approved (got ${adminSubmitted.status})`);
  assert(!noteEv("1", "purchaseOrder.approved"), "self-action does not notify (admin auto-approve)");

  // Reject flow: submit another, manager rejects with a reason → creator notified.
  const rejPO = await mkPO(poRepCtx, 4);
  await purchasing.submitPO(poRepCtx, rejPO.doc.id);
  const rejPoResult = await purchasing.decidePO(poMgrCtx, rejPO.doc.id, "reject", "over budget");
  assert(rejPoResult.status === "rejected" && rejPoResult.rejectionReason === "over budget", "manager rejects with reason");
  assert(noteEv("3", "purchaseOrder.rejected"), "creator notified of rejection");

  // Preference gating: muting po_approval suppresses the in-app notification.
  await qe.update(systemContext(DEMO_TENANT, DEMO_ORG), "user", "2", {
    notificationPrefs: JSON.stringify({ po_approval: { email: false, push: false, sms: false } }),
  });
  const submittedCount = () => notifications.list(DEMO_TENANT, DEMO_ORG, "2").filter((n) => n.eventType === "purchaseOrder.submitted").length;
  const setPrefs2 = (p: unknown) => qe.update(systemContext(DEMO_TENANT, DEMO_ORG), "user", "2", { notificationPrefs: JSON.stringify(p) });
  const submitToMgr = async () => { const po = await mkPO(poRepCtx, 2); await purchasing.submitPO(poRepCtx, po.doc.id); };
  // Legacy flat prefs: all simulated channels off → suppressed.
  const before2 = submittedCount();
  await submitToMgr();
  assert(submittedCount() === before2, "muted preference suppresses the in-app notification");
  // Structured prefs: explicit in-app off → suppressed.
  await setPrefs2({ events: { po_approval: { inapp: false, email: true } } });
  const beforeStruct = submittedCount();
  await submitToMgr();
  assert(submittedCount() === beforeStruct, "structured inapp=false suppresses delivery");
  // Master pause → everything suppressed.
  await setPrefs2({ paused: true, events: {} });
  const beforePause = submittedCount();
  await submitToMgr();
  assert(submittedCount() === beforePause, "master pause suppresses all notifications");
  // Re-enabled → delivered again.
  await setPrefs2({ events: { po_approval: { inapp: true } } });
  const beforeOn = submittedCount();
  await submitToMgr();
  assert(submittedCount() === beforeOn + 1, "re-enabled preference delivers again");
  // Quiet-hours window logic (pure).
  assert(inQuietHours("22:00", "07:00", "2026-03-01T23:30:00.000Z", "UTC"), "23:30 is inside the 22:00–07:00 quiet window");
  assert(!inQuietHours("22:00", "07:00", "2026-03-01T12:00:00.000Z", "UTC"), "12:00 is outside the overnight quiet window");
  assert(inQuietHours("09:00", "17:00", "2026-03-01T10:00:00.000Z", "UTC"), "10:00 is inside a same-day quiet window");

  // Broadcast notifications (deal_won/quote_sent/invoice_sent) can't be gated at
  // delivery, so they are filtered at read time by the viewer's category prefs.
  notifications.add({ tenantId: DEMO_TENANT, orgId: DEMO_ORG, userId: null, at: "2026-03-01T10:00:00.000Z", channel: "system", subject: "Deal won", body: "x", eventType: "deal.win", prefKey: "deal_won" });
  const dealWon = (uid: string, filter?: (k?: string) => boolean) =>
    notifications.list(DEMO_TENANT, DEMO_ORG, uid, filter).some((n) => n.eventType === "deal.win");
  assert(dealWon("4"), "broadcast deal-won is visible by default");
  await qe.update(systemContext(DEMO_TENANT, DEMO_ORG), "user", "4", { notificationPrefs: JSON.stringify({ events: { deal_won: { inapp: false } } }) });
  const muted4 = await buildInAppMuteFilter(DEMO_TENANT, DEMO_ORG, "4");
  assert(!dealWon("4", muted4), "broadcast is hidden when the viewer mutes that category (read-time gating)");
  const open2 = await buildInAppMuteFilter(DEMO_TENANT, DEMO_ORG, "1");
  assert(dealWon("1", open2), "the same broadcast still shows for a user who hasn't muted it");

  // GRN gating ---------------------------------------------------------------
  const otherProduct = (await qe.list(ctx, "product", { filters: [{ field: "sku", op: "eq", value: "HW-SW-24" }], pageSize: 1 })).items[0];
  const expectReject = async (label: string, fn: () => Promise<unknown>) => {
    let threw = false;
    try { await fn(); } catch { threw = true; }
    assert(threw, label);
  };
  await expectReject("GRN without a PO is rejected", () =>
    purchasing.createGRN(ctx, { warehouseId: whMain.id }, [{ productId: router.id, qty: 1, unitCost: 720 }]));
  const draftPO = await mkPO(poRepCtx, 3);
  await expectReject("GRN against an unapproved (draft) PO is rejected", () =>
    purchasing.createGRN(ctx, { poId: draftPO.doc.id, warehouseId: whMain.id }, [{ productId: router.id, qty: 1, unitCost: 720 }]));
  await expectReject("over-receiving beyond the ordered qty is rejected", () =>
    purchasing.createGRN(ctx, { poId: repPO.doc.id, warehouseId: whMain.id }, [{ productId: router.id, qty: 999, unitCost: 720 }]));
  await expectReject("receiving a product not on the PO is rejected", () =>
    purchasing.createGRN(ctx, { poId: repPO.doc.id, warehouseId: whMain.id }, [{ productId: otherProduct.id, qty: 1, unitCost: 410 }]));

  // Valid receipt against the approved PO posts + fully receives it.
  const approvedBefore = await inventory.onHand(ctx, router.id, whMain.id);
  const okGrn = await purchasing.createGRN(ctx, { poId: repPO.doc.id, warehouseId: whMain.id }, [{ productId: router.id, qty: 5, unitCost: 720 }]);
  assert(String(okGrn.doc.poId) === String(repPO.doc.id), "valid GRN against approved PO created");
  await purchasing.postGRN(ctx, okGrn.doc.id);
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === approvedBefore + 5, "approved-PO receipt updates stock");
  assert((await qe.get(ctx, "purchaseOrder", repPO.doc.id)).status === "received", "fully-received PO → received");
  assert(noteEv("3", "goodsReceipt.posted"), "PO owner notified when goods received");

  console.log("\n[permissions] explicit grant matrix is authoritative + role fallback:");
  const permCtx = (grants?: string[], roles = ["sales_rep"]) =>
    systemContext(DEMO_TENANT, DEMO_ORG, { isSystem: false, roles, grants, userId: "99" });
  // Authoritative: only the granted operations are allowed.
  const limited = permCtx(["account:read", "deal:*"]);
  assert(permissionEngine.can(limited, { entity: "account", action: "account:read" }), "granted account:read allowed");
  assert(!permissionEngine.can(limited, { entity: "account", action: "account:create" }), "ungranted account:create denied (authoritative)");
  assert(!permissionEngine.can(limited, { entity: "invoice", action: "invoice:read" }), "ungranted invoice:read denied");
  assert(permissionEngine.can(limited, { entity: "deal", action: "deal:create" }), "deal:* covers deal:create");
  assert(permissionEngine.can(limited, { entity: "deal", action: "deal:update", recordOwnerId: "other" }), "deal:* manages others' records (ABAC)");
  assert(!permissionEngine.can(limited, { entity: "account", action: "account:update", recordOwnerId: "99" }), "account:update not granted → own record still denied");
  // No grants → fall back to the base role's defaults (sales_rep).
  const roleOnly = permCtx(undefined, ["sales_rep"]);
  assert(permissionEngine.can(roleOnly, { entity: "pos", action: "pos:checkout" }), "role fallback: sales_rep keeps pos:checkout");
  assert(!permissionEngine.can(roleOnly, { entity: "invoice", action: "invoice:create" }), "role fallback: sales_rep cannot create invoices");
  // Master-detail: a line entity inherits its parent document's grants (lines are
  // hidden from the matrix and only exist within their parent document).
  const poGrant = permCtx(["purchaseOrder:*"]);
  assert(permissionEngine.can(poGrant, { entity: "purchaseOrderLine", action: "purchaseOrderLine:read" }), "line inherits parent grant (purchaseOrder:* → purchaseOrderLine:read)");
  assert(permissionEngine.can(poGrant, { entity: "purchaseOrderLine", action: "purchaseOrderLine:create" }), "line inherits parent create");
  // Reference-read inheritance: a PO role may read the entities a PO references.
  assert(permissionEngine.can(poGrant, { entity: "supplier", action: "supplier:read" }), "reference read: purchaseOrder grant → supplier:read");
  assert(permissionEngine.can(poGrant, { entity: "product", action: "product:read" }), "reference read: purchaseOrder grant → product:read (via line)");
  assert(!permissionEngine.can(poGrant, { entity: "supplier", action: "supplier:create" }), "reference inheritance is read-only (no supplier:create)");
  assert(!permissionEngine.can(poGrant, { entity: "user", action: "user:read" }), "system entities (user) are never exposed via reference inheritance");
  assert(!permissionEngine.can(limited, { entity: "invoice", action: "invoice:read" }), "reference inheritance does not over-grant (invoice still denied for account/deal reader)");
  // Token claim computation: admin super, non-admin embeds the matrix, empty inherits.
  const posLike = (perms: string): EntityRecord => ({ permissions: perms } as unknown as EntityRecord);
  assert(grantsClaimFor("admin", posLike(JSON.stringify(["account:read"]))) === undefined, "admin is always super (no embedded matrix)");
  const embedded = grantsClaimFor("sales_rep", posLike(JSON.stringify(["x:y"])));
  assert(!!embedded && embedded.length === 1 && embedded[0] === "x:y", "non-admin matrix is embedded in the token");
  assert(grantsClaimFor("sales_rep", posLike("[]")) === undefined, "empty matrix inherits the role");

  console.log("\n[profile] self-service profile fields persist on the user record:");
  for (const f of ["avatarId", "jobTitle", "location", "bio"]) {
    assert(metadata.getEntity("user").fields.some((x) => x.name === f), `user.${f} field registered`);
  }
  const sysCtx = systemContext(DEMO_TENANT, DEMO_ORG);
  await qe.update(sysCtx, "user", "3", { jobTitle: "Field Sales Lead", location: "Izmir, TR", bio: "Covers the Aegean region.", avatarId: "file_av1" });
  const prof = await qe.get(sysCtx, "user", "3");
  assert(prof.jobTitle === "Field Sales Lead", `jobTitle persisted (got ${prof.jobTitle})`);
  assert(prof.location === "Izmir, TR" && prof.bio === "Covers the Aegean region.", "location + bio persisted");
  assert(prof.avatarId === "file_av1", `avatarId persisted (got ${prof.avatarId})`);

  console.log("\n[security] TOTP 2FA enrollment + login enforcement + activity log:");
  const tfSecret = randomBase32Secret();
  assert(/^[A-Z2-7]{32}$/.test(tfSecret), `base32 secret generated (${tfSecret.length} chars)`);
  assert(totpVerify(tfSecret, totpNow(tfSecret)), "TOTP verifies a freshly generated code");
  assert(!totpVerify(tfSecret, "12345"), "TOTP rejects a malformed code");
  // Enable 2FA on a seeded user and confirm login enforces it.
  const riley = (await qe.list(sysCtx, "user", { filters: [{ field: "email", op: "eq", value: "riley@acme.test" }], pageSize: 1 })).items[0];
  await qe.patchComputed(sysCtx, "user", String(riley.id), { twoFactorEnabled: true, twoFactorSecret: encrypt(tfSecret) });
  assert((await login("riley@acme.test", "wrong-password")).status === "invalid", "wrong password rejected");
  assert((await login("riley@acme.test", "Passw0rd!")).status === "2fa_required", "2FA-on login without a code → 2fa_required");
  assert((await login("riley@acme.test", "Passw0rd!", "12345")).status === "invalid_code", "2FA login with a bad code → invalid_code");
  assert((await login("riley@acme.test", "Passw0rd!", totpNow(tfSecret))).status === "ok", "2FA login with the valid code → ok");
  // Activity log persists to the DB.
  await recordSecurityEvent({ tenantId: DEMO_TENANT, orgId: DEMO_ORG }, String(riley.id), "sign_in", { ip: "127.0.0.1", userAgent: "smoke" });
  const sec = await qe.list(sysCtx, "securityEvent", { filters: [{ field: "userId", op: "eq", value: String(riley.id) }], pageSize: 10 });
  assert(sec.total >= 1 && sec.items.some((e) => e.type === "sign_in"), "security event persisted to the database");
  // Admin 2FA reset (account recovery, Settings → Users): clears enrollment so the user signs in with a password only.
  await qe.patchComputed(sysCtx, "user", String(riley.id), { twoFactorEnabled: false, twoFactorSecret: null });
  assert((await login("riley@acme.test", "Passw0rd!")).status === "ok", "after admin 2FA reset, login no longer requires a code");

  console.log("\n[appearance] per-user UI settings persist (userSetting table):");
  assert(metadata.listEntities().some((e) => e.name === "userSetting"), "userSetting entity registered");
  const us = await qe.create(sysCtx, "userSetting", { userId: "1", key: "fontSize", value: "lg" });
  const usBack = await qe.get(sysCtx, "userSetting", String(us.id));
  assert(usBack.key === "fontSize" && usBack.value === "lg", "appearance setting (fontSize) persisted to the database");
  await qe.update(sysCtx, "userSetting", String(us.id), { value: "sm" });
  assert((await qe.get(sysCtx, "userSetting", String(us.id))).value === "sm", "appearance setting update persists");

  console.log("\n[files] avatar folder accepted (profile photo upload fix):");
  const avatarFile = await qe.create(sysCtx, "file", { name: "me.png", folder: "avatars", sizeKb: 12, mimeType: "image/png", owner: "Smoke" });
  assert(String(avatarFile.folder) === "avatars", "file with folder=avatars created (was rejected by the enum before)");

  console.log("\n[mail] custom folders, move-to-folder + star (e-posta klasörleri):");
  assert(metadata.listEntities().some((e) => e.name === "emailFolder"), "emailFolder entity registered");
  for (const f of ["starred", "folderId"]) {
    assert(metadata.getEntity("email").fields.some((x) => x.name === f), `email.${f} field registered`);
  }
  const mailFolder = await qe.create(sysCtx, "emailFolder", { name: "Projects", color: "#2563eb" });
  assert(String(mailFolder.name) === "Projects", "custom mail folder created in the database");
  const mailMsg = await qe.create(sysCtx, "email", { folder: "inbox", sender: "a@b.com", subject: "Hi", body: "Body", unread: true });
  // Move it into the custom folder (folderId set) and confirm the folder filter finds it.
  await qe.update(sysCtx, "email", String(mailMsg.id), { folderId: String(mailFolder.id) });
  const inFolder = await qe.list(sysCtx, "email", { filters: [{ field: "folderId", op: "eq", value: String(mailFolder.id) }], pageSize: 10 });
  assert(inFolder.items.some((e) => String(e.id) === String(mailMsg.id)), "moved message is listed under its custom folder");
  // Star it and confirm the Starred view finds it.
  await qe.update(sysCtx, "email", String(mailMsg.id), { starred: true });
  const starredList = await qe.list(sysCtx, "email", { filters: [{ field: "starred", op: "eq", value: true }], pageSize: 10 });
  assert(starredList.items.some((e) => String(e.id) === String(mailMsg.id)), "starred message is listed in the Starred view");
  // Folder-delete reassignment: clearing folderId returns the message to its base folder.
  await qe.update(sysCtx, "email", String(mailMsg.id), { folderId: null });
  const afterClear = await qe.get(sysCtx, "email", String(mailMsg.id));
  assert(!afterClear.folderId, "clearing folderId returns the message to its base system folder");
  const backInInbox = await qe.list(sysCtx, "email", { filters: [{ field: "folder", op: "eq", value: "inbox" }], pageSize: 100 });
  assert(backInInbox.items.some((e) => String(e.id) === String(mailMsg.id)), "reassigned message reappears in its base folder (inbox)");
  // Trash move + undo (DB side of the bulk /email/trash + /email/restore endpoints).
  await qe.update(sysCtx, "email", String(mailMsg.id), { folder: "trash", folderId: null });
  assert((await qe.get(sysCtx, "email", String(mailMsg.id))).folder === "trash", "delete moves a message to the Trash folder");
  await qe.update(sysCtx, "email", String(mailMsg.id), { folder: "inbox", folderId: null });
  assert((await qe.get(sysCtx, "email", String(mailMsg.id))).folder === "inbox", "undo restores a trashed message to its original folder");
  // Bulk move + bulk delete in a single batch (domain.updateMany / removeMany).
  const mailDom = await getDomainService();
  const bulkMsgs = [];
  for (let i = 0; i < 5; i++) {
    bulkMsgs.push(await qe.create(sysCtx, "email", { folder: "inbox", sender: `b${i}@x.com`, subject: `Bulk ${i}`, body: "x", unread: true }));
  }
  const bulkIds = bulkMsgs.map((m) => String(m.id));
  const movedN = await mailDom.updateMany(sysCtx, "email", bulkIds, { folder: "spam", folderId: null });
  assert(movedN === 5, `bulk move updates all 5 in one batch (got ${movedN})`);
  const oneMoved = await qe.get(sysCtx, "email", bulkIds[0]);
  assert(oneMoved.folder === "spam", "bulk-moved message persisted its new folder");
  assert(Number(oneMoved.version) === Number(bulkMsgs[0].version) + 1, "bulk update bumps version by exactly one");
  const removedN = await mailDom.removeMany(sysCtx, "email", bulkIds);
  assert(removedN === 5, `bulk delete removes all 5 in one batch (got ${removedN})`);
  const survivors = (await qe.list(sysCtx, "email", { filters: [{ field: "folder", op: "eq", value: "spam" }], pageSize: 50 })).items.filter((e) => bulkIds.includes(String(e.id)));
  assert(survivors.length === 0, "bulk-deleted messages are gone from the database");
  await qe.remove(sysCtx, "emailFolder", String(mailFolder.id));
  const folderGone = await qe.list(sysCtx, "emailFolder", { filters: [{ field: "name", op: "eq", value: "Projects" }], pageSize: 5 });
  assert(folderGone.items.length === 0, "custom folder removed from the database");

  console.log("\n[reports] Excel export renders a styled workbook:");
  const { renderReportXlsx } = await import("@/lib/integrations/report-export");
  const reportBuf = await renderReportXlsx({
    title: "Sales Report",
    subtitle: "Won revenue and open pipeline",
    org: "Aula ERP",
    meta: [{ label: "Generated", value: "2026-06-09 10:00" }],
    kpis: [{ label: "Won revenue", value: "$1,000.00" }],
    sections: [
      {
        title: "Performance by stage",
        columns: [{ label: "Stage" }, { label: "Deals", kind: "number" }, { label: "Value", kind: "currency" }],
        rows: [["Won", 3, 1000], ["Lost", 1, 0]],
        total: ["Total", 4, 1000],
      },
    ],
    currency: "USD",
  });
  assert(reportBuf.length > 0, `report .xlsx workbook produced (${reportBuf.length} bytes)`);
  // A real xlsx is a ZIP archive → starts with the "PK" signature.
  assert(reportBuf[0] === 0x50 && reportBuf[1] === 0x4b, "report buffer is a valid xlsx (PK zip header)");

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

  // ---- Phase A: financial-integrity guards + atomic void ----
  console.log("\n[integrity] overpayment + negative stock are rejected:");
  // invDoc total = 2880, 500 already paid → balance 2380; paying 5000 must reject.
  await expectReject("overpayment beyond the invoice balance is rejected", () =>
    finance.applyPayment(ctx, invDoc.id, { amount: 5000, method: "bank", paidAt: "2026-02-16" }));
  // Paying exactly the remaining balance is allowed (epsilon tolerance).
  const okPay = await finance.applyPayment(ctx, invDoc.id, { amount: 2380, method: "bank", paidAt: "2026-02-16" });
  assert(String(okPay.status) === "paid", `paying the exact balance settles the invoice (got ${okPay.status})`);
  const routerMainNow = await inventory.onHand(ctx, router.id, whMain.id);
  await expectReject("issuing more than on-hand is rejected (no negative stock)", () =>
    inventory.writeMovement(ctx, { productId: router.id, warehouseId: whMain.id, qty: -(routerMainNow + 50), type: "issue", unitCost: 720, ref: "NEG-TEST", refType: "invoice" }));
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === routerMainNow, "rejected issue left on-hand unchanged");

  console.log("\n[security] webhook SSRF guard rejects private/loopback targets:");
  for (const bad of [
    "http://169.254.169.254/latest/meta-data", "http://localhost:4000/x", "http://127.0.0.1/y", "http://10.0.0.5/z", "ftp://example.com",
    "http://[::ffff:127.0.0.1]/x", "http://[::ffff:169.254.169.254]/meta", "http://2130706433/", "http://0x7f000001/", "http://[::1]/",
  ]) {
    let threw = false;
    try { assertSafeWebhookUrl(bad); } catch { threw = true; }
    assert(threw, `blocked unsafe webhook URL ${bad}`);
  }
  assert(!!assertSafeWebhookUrl("https://hooks.example.com/aula"), "allows a public https webhook URL");

  console.log("\n[integrity] invoice void reverses GL + restocks (idempotent):");
  const voidInv = await finance.createDocument(ctx, "invoice", "INV", {
    accountId: account.id, branchId: whMain.branchId as string, warehouseId: whMain.id, currencyCode: "USD",
    issueDate: "2026-02-18", dueDate: "2026-03-18", status: "draft",
  });
  await finance.replaceLines(ctx, "invoice", "invoiceLine", "invoiceId", voidInv.id, [
    { productId: router.id, description: "Edge Router X100", qty: 1, unitPrice: 1200, taxRate: 20 },
  ]);
  const voidStockBefore = await inventory.onHand(ctx, router.id, whMain.id);
  await postInvoiceGL(ctx, voidInv.id);
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === voidStockBefore - 1, "void-test invoice issued 1 unit");
  await reverseInvoiceGL(ctx, voidInv.id);
  assert((await jeCount("invoiceVoid", voidInv.id)) === 1, "invoice void posts a reversing AR entry");
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === voidStockBefore, "void restocked the issued unit");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after invoice void (${bal.dr}/${bal.cr})`);
  await reverseInvoiceGL(ctx, voidInv.id);
  assert((await jeCount("invoiceVoid", voidInv.id)) === 1, "re-void is idempotent (no double reversal)");
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === voidStockBefore, "re-void leaves stock unchanged");

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

  console.log("\n[payables] GR/IR price variance posted on a GRN-linked bill:");
  // GRN received router 20 @ 720 = 14400 (GR/IR credit). Bill it at 730 → +200 variance.
  const varBill = await payables.createBill(
    ctx,
    { supplierId: supplier.id, goodsReceiptId: grn.doc.id, branchId: whMain.branchId as string, billDate: "2026-02-28", dueDate: "2026-03-28", currencyCode: "USD" },
    [{ productId: router.id, description: "Edge Router X100", qty: 20, unitPrice: 730, taxRate: 0 }],
  );
  await payables.receiveBill(ctx, varBill.doc.id);
  assert((await jeCount("vendorBill", varBill.doc.id)) === 1, "GRN-linked vendor bill posted");
  const ppvAcc = (await acctSvc.accountBySubtype(ctx, "purchase_price_variance"))?.id;
  assert(!!ppvAcc, "purchase price variance account self-provisioned");
  const ppvLines = await qe.list(ctx, "journalLine", { filters: [{ field: "ledgerAccountId", op: "eq", value: String(ppvAcc) }], pageSize: 10 });
  assert(ppvLines.items.some((l) => Number(l.debit) === 200), "price variance (200) booked to PPV");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after GR/IR variance (${bal.dr}/${bal.cr})`);

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

  // ---- Barcode + POS + labels (new ERP features) ----
  console.log("\n[barcode] product barcode fields + GTIN check digit:");
  assert(metadata.getEntity("product").fields.some((f) => f.name === "barcode"), "product.barcode field");
  assert(metadata.getEntity("product").fields.some((f) => f.name === "barcodeType"), "product.barcodeType field");
  const ean = internalEan13(1001);
  assert(isValidBarcode(ean, "ean13"), `generated EAN-13 valid (${ean})`);
  assert(!isValidBarcode("123", "ean13"), "malformed EAN-13 rejected");
  const barcoded = (await qe.list(ctx, "product", { filters: [{ field: "barcode", op: "eq", value: ean }], pageSize: 1 })).items[0];
  assert(!!barcoded && barcoded.sku === "HW-RTR-X100", `seeded router carries barcode ${ean}`);

  console.log("\n[pos] barcode/SKU lookup:");
  const posSvc = await getPosService();
  const byBarcode = await posSvc.lookup(ctx, ean);
  assert(!!byBarcode && byBarcode.sku === "HW-RTR-X100", "lookup by barcode resolves the router");
  const switchProd = await posSvc.lookup(ctx, "HW-SW-24");
  assert(!!switchProd, "lookup falls back to SKU");
  assert((await posSvc.lookup(ctx, "NOPE-404")) === null, "unknown code returns null");

  console.log("\n[pos] open shift → checkout (stock issue + GL) → session totals:");
  registerAccountingPostings(); // subscribe invoice.send (main.ts does this in prod)
  const session = await posSvc.openSession(ctx, { branchId: whMain.branchId as string, warehouseId: whMain.id, openingFloat: 100 });
  assert(session.status === "open", "shift opened");
  const posBefore = await inventory.onHand(ctx, switchProd!.id, whMain.id);
  const checkout = await posSvc.checkout(ctx, {
    branchId: whMain.branchId as string,
    warehouseId: whMain.id,
    sessionId: String(session.id),
    lines: [{ productId: switchProd!.id, description: String(switchProd!.name), qty: 2, unitPrice: 650, taxRate: 20 }],
    payments: [{ method: "cash", amount: 2000 }],
  });
  assert(checkout.total === 1560, `POS total = 1560 (got ${checkout.total})`);
  assert(checkout.change === 440, `POS change = 440 (got ${checkout.change})`);
  const posAfter = await inventory.onHand(ctx, switchProd!.id, whMain.id);
  assert(posAfter === posBefore - 2, `POS issued stock (${posBefore} → ${posAfter})`);
  assert((await jeCount("invoice", String(checkout.invoice.id))) === 1, "POS invoice posted to GL");
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after POS sale (${bal.dr}/${bal.cr})`);
  const sessAfter = await qe.get(ctx, "posSession", String(session.id));
  assert(Number(sessAfter.salesTotal) === 1560, `session salesTotal accrued (got ${sessAfter.salesTotal})`);
  assert(Number(sessAfter.cashTotal) === 1560, `session cashTotal = cash kept (got ${sessAfter.cashTotal})`);

  console.log("\n[pos] close shift computes variance:");
  const closed = await posSvc.closeSession(ctx, String(session.id), 1700);
  // expectedCash = float(100) + cashTotal(1560) = 1660; counted 1700 → +40
  assert(closed.status === "closed", "shift closed");
  assert(Number(closed.variance) === 40, `cash variance = +40 (got ${closed.variance})`);

  console.log("\n[pos] checkout is idempotent (double-submit rings up one sale):");
  const idemStockBefore = await inventory.onHand(ctx, switchProd!.id, whMain.id);
  const idemArgs = {
    branchId: whMain.branchId as string, warehouseId: whMain.id, sessionId: null, currencyCode: "USD",
    lines: [{ productId: switchProd!.id, description: String(switchProd!.name), qty: 1, unitPrice: 650, taxRate: 20 }],
    payments: [{ method: "cash", amount: 780 }], idempotencyKey: "smoke-idem-1",
  };
  const firstIdem = await posSvc.checkout(ctx, idemArgs);
  const secondIdem = await posSvc.checkout(ctx, idemArgs);
  assert(String(firstIdem.invoice.id) === String(secondIdem.invoice.id), "duplicate checkout returns the same invoice");
  assert((await inventory.onHand(ctx, switchProd!.id, whMain.id)) === idemStockBefore - 1, "duplicate checkout issues stock only once");

  console.log("\n[posting-retry] a failed GL posting is queued, not silently lost:");
  clearPostingFailures();
  // Publish a posting event for a non-existent invoice → reverseInvoiceGL throws →
  // the failure must be captured in the retry queue (visible + re-attempted).
  await eventBus.publish({ id: "evt_fail", type: "invoice.void", at: ctx.at, tenantId: DEMO_TENANT, orgId: DEMO_ORG, actorId: "system", correlationId: "cid_fail", payload: { id: "987654" } });
  const postFails = listPostingFailures(DEMO_TENANT, DEMO_ORG);
  assert(postFails.some((f) => f.type === "invoice.void" && f.id === "987654"), "failed posting recorded in the retry queue");
  const retryRes = await retryFailedPostings();
  assert(retryRes.retried >= 1, `retry pass re-attempts queued postings (retried ${retryRes.retried})`);
  clearPostingFailures();
  assert(listPostingFailures(DEMO_TENANT, DEMO_ORG).length === 0, "posting-failure queue clears");

  console.log("\n[inventory] per-location on-hand join (stock-levels source):");
  const onHandRows = await inventory.onHandByKey(ctx);
  assert(onHandRows.length >= 5, `on-hand-by-key rows present (${onHandRows.length})`);
  assert(onHandRows.every((r) => typeof r.onHand === "number"), "each row carries a numeric on-hand");

  // Regression: the UI drawer posts via the GENERIC lifecycle transition, not the
  // dedicated endpoint. Without the transition→side-effect subscription the status
  // flipped to "posted" but no stock moved ("transferred stock isn't split").
  console.log("\n[inventory] transfer/adjustment POST via lifecycle transition moves stock:");
  const domain = await getDomainService();
  const trMainBefore = await inventory.onHand(ctx, router.id, whMain.id);
  const trEastBefore = await inventory.onHand(ctx, router.id, whEast.id);
  const trTotalBefore = await inventory.onHand(ctx, router.id);
  const trf2 = await domain.create(ctx, "stockTransfer", {
    fromWarehouseId: whMain.id, toWarehouseId: whEast.id, productId: router.id,
    qty: 4, unitCost: 720, transferDate: "2026-03-01", branchId: whMain.branchId as string,
  });
  assert(/^TRF-\d+$/.test(String(trf2.number)), `generic create auto-numbers transfer (got ${trf2.number})`);
  const trPosted = await domain.transition(ctx, "stockTransfer", trf2.id, "post");
  assert(trPosted.status === "posted", "transition flips transfer to posted");
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === trMainBefore - 4, `transition moved −4 out of main (${trMainBefore})`);
  assert((await inventory.onHand(ctx, router.id, whEast.id)) === trEastBefore + 4, `transition moved +4 into east (${trEastBefore})`);
  assert((await inventory.onHand(ctx, router.id)) === trTotalBefore, "transition transfer keeps total on-hand");
  // Void reverses the movements (idempotent).
  await domain.transition(ctx, "stockTransfer", trf2.id, "void");
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === trMainBefore, `void restored main on-hand (${trMainBefore})`);
  assert((await inventory.onHand(ctx, router.id, whEast.id)) === trEastBefore, `void restored east on-hand (${trEastBefore})`);

  const adjMainBefore = await inventory.onHand(ctx, router.id, whMain.id);
  const adj2 = await domain.create(ctx, "stockAdjustment", {
    warehouseId: whMain.id, productId: router.id, qtyDelta: 6, unitCost: 720,
    reason: "Found", adjustedAt: "2026-03-02", branchId: whMain.branchId as string,
  });
  assert(/^ADJ-\d+$/.test(String(adj2.number)), `generic create auto-numbers adjustment (got ${adj2.number})`);
  await domain.transition(ctx, "stockAdjustment", adj2.id, "post");
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === adjMainBefore + 6, `transition adjustment applied +6 (${adjMainBefore})`);
  assert((await jeCount("adjustment", adj2.id)) === 1, "transition adjustment posted GL");
  await domain.transition(ctx, "stockAdjustment", adj2.id, "void");
  assert((await inventory.onHand(ctx, router.id, whMain.id)) === adjMainBefore, `void restored adjustment on-hand (${adjMainBefore})`);
  bal = await sumTB();
  assert(bal.dr === bal.cr, `TB balanced after transition post/void (${bal.dr}/${bal.cr})`);

  console.log("\n[labels] labelTemplate CRUD + JSON round-trip:");
  assert(metadata.listEntities().some((e) => e.name === "labelTemplate"), "labelTemplate entity registered");
  const tpl = await qe.create(ctx, "labelTemplate", {
    name: "Smoke 50x30", widthMm: 50, heightMm: 30, dpi: 300,
    elements: JSON.stringify([{ id: "e1", type: "barcode", field: "barcode", x: 4, y: 9, w: 42, h: 13 }]), active: true,
  });
  assert(/^\d+$/.test(String(tpl.id)), `label template created (id ${tpl.id})`);
  const tplBack = await qe.get(ctx, "labelTemplate", String(tpl.id));
  assert(JSON.parse(String(tplBack.elements)).length === 1, "template elements round-trip JSON");

  console.log("\n[sales] cart checkout (→ invoice/stock issue) + sales return restock:");
  const finSvc = await getFinanceService();
  const posForCart = await getPosService();
  // Cart: persist a basket, then ring it through the POS pipeline.
  const cartHdr = await finSvc.createDocument(ctx, "cart", "CART", {
    accountId: account.id, branchId: whMain.branchId as string, warehouseId: whMain.id, currencyCode: "USD", status: "open",
  });
  await finSvc.replaceLines(ctx, "cart", "cartLine", "cartId", cartHdr.id, [
    { productId: router.id, description: "Edge Router X100", qty: 3, unitPrice: 1200, taxRate: 20 },
  ]);
  const cartDoc = await finSvc.getDocument(ctx, "cart", "cartLine", "cartId", cartHdr.id);
  assert(Number(cartDoc.doc.total) === 4320, `cart total = 4320 (got ${cartDoc.doc.total})`);
  const beforeCart = await inventory.onHand(ctx, router.id, whMain.id);
  const cartSale = await posForCart.checkout(ctx, {
    branchId: whMain.branchId as string, warehouseId: whMain.id, accountId: account.id, currencyCode: "USD",
    lines: cartDoc.lines.map((l) => ({ productId: String(l.productId), description: String(l.description), qty: Number(l.qty), unitPrice: Number(l.unitPrice), taxRate: Number(l.taxRate) })),
    payments: [],
  });
  const afterCart = await inventory.onHand(ctx, router.id, whMain.id);
  assert(afterCart === beforeCart - 3, `cart checkout issued stock (${beforeCart} → ${afterCart})`);
  assert(Number(cartSale.total) === 4320, `cart invoice total = 4320 (got ${cartSale.total})`);
  await qe.update(ctx, "cart", cartHdr.id, { status: "converted", convertedInvoiceId: cartSale.invoice.id });
  assert((await qe.get(ctx, "cart", cartHdr.id)).status === "converted", "cart marked converted");

  // Sales return: restock 2 units (receipt movement, refType salesReturn).
  const retHdr = await finSvc.createDocument(ctx, "salesReturn", "RET", {
    accountId: account.id, warehouseId: whMain.id, branchId: whMain.branchId as string, currencyCode: "USD", returnDate: "2026-02-01", status: "draft",
  });
  await finSvc.replaceLines(ctx, "salesReturn", "salesReturnLine", "salesReturnId", retHdr.id, [
    { productId: router.id, description: "Edge Router X100", qty: 2, unitPrice: 1200, taxRate: 20 },
  ]);
  const retDoc = await finSvc.getDocument(ctx, "salesReturn", "salesReturnLine", "salesReturnId", retHdr.id);
  assert(Number(retDoc.doc.total) === 2880, `return total = 2880 (got ${retDoc.doc.total})`);
  const beforeRet = await inventory.onHand(ctx, router.id, whMain.id);
  for (const l of retDoc.lines) {
    await inventory.writeMovement(ctx, { productId: String(l.productId), warehouseId: whMain.id, qty: Number(l.qty), type: "receipt", unitCost: Number(l.unitPrice), ref: retHdr.id, refType: "salesReturn", branchId: whMain.branchId as string });
  }
  await qe.update(ctx, "salesReturn", retHdr.id, { status: "posted" });
  const afterRet = await inventory.onHand(ctx, router.id, whMain.id);
  assert(afterRet === beforeRet + 2, `return restocked (${beforeRet} → ${afterRet})`);
  assert((await qe.get(ctx, "salesReturn", retHdr.id)).status === "posted", "return marked posted");

  console.log("\n[metadata] lead & contact removed:");
  assert(!metadata.listEntities().some((e) => e.name === "lead"), "lead entity removed");
  assert(!metadata.listEntities().some((e) => e.name === "contact"), "contact entity removed");
  assert(metadata.listEntities().some((e) => e.name === "cart"), "cart entity registered");
  assert(metadata.listEntities().some((e) => e.name === "salesReturn"), "salesReturn entity registered");

  console.log("\n[recurring] billing run catches a plan up (one invoice per missed period):");
  const rbFin = await getFinanceService();
  const RB_TODAY = "2026-06-09";
  // Drain any already-due seeded plans so the count below reflects only our plan.
  await rbFin.generateDueInvoices(ctx, RB_TODAY);
  const rbAccount = (await qe.list(ctx, "account", { pageSize: 1 })).items[0];
  const rbPlan = await qe.create(ctx, "recurringPlan", {
    name: "Smoke Subscription",
    accountId: rbAccount.id,
    description: "Smoke monthly fee",
    amount: 500,
    taxRate: 0,
    currencyCode: "USD",
    frequency: "monthly",
    nextRun: "2026-03-01", // Mar/Apr/May/Jun → 4 cycles due by 2026-06-09
    active: true,
  });
  const rbGen = await rbFin.generateDueInvoices(ctx, RB_TODAY);
  assert(rbGen.length === 4, `catch-up generates one invoice per missed month (got ${rbGen.length})`);
  const rbPlanAfter = await qe.get(ctx, "recurringPlan", String(rbPlan.id));
  assert(String(rbPlanAfter.nextRun) === "2026-07-01", `nextRun rolls forward past today (got ${rbPlanAfter.nextRun})`);
  const rbGen2 = await rbFin.generateDueInvoices(ctx, RB_TODAY);
  assert(rbGen2.length === 0, "re-running the same day generates nothing (idempotent until the next period)");

  console.log("\n[recurring] month-end plan clamps (Jan 31 → Feb 28, no skipped month):");
  const mePlan = await qe.create(ctx, "recurringPlan", {
    name: "Month-end sub", accountId: rbAccount.id, description: "Month-end fee", amount: 100, taxRate: 0,
    currencyCode: "USD", frequency: "monthly", nextRun: "2026-01-31", active: true,
  });
  const meGen = await rbFin.generateDueInvoices(ctx, "2026-04-15"); // Jan31, Feb28, Mar28 due by Apr 15
  assert(meGen.length === 3, `month-end plan generates one per month, no skips (got ${meGen.length})`);
  assert(String((await qe.get(ctx, "recurringPlan", String(mePlan.id))).nextRun) === "2026-04-28", "month-end nextRun clamps to a valid day");

  console.log("\n[automation] send_email action drives the mail path + schedule cadence:");
  // Exercise the engine → sendMail wiring with SMTP turned off, so sendMail returns
  // null (no network, no real message) and the action falls back to an in-app
  // notification. Real delivery is covered by configuring Email under Integrations
  // (or SMTP_* env) on a running server.
  await automationStore.upsertIntegration(DEMO_TENANT, DEMO_ORG, "email", { enabled: false });
  const emailRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG,
    name: "Smoke welcome email", status: "active",
    trigger: { kind: "event", entity: "account", event: "created" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "se1", type: "send_email", to: "{{record.email}}", subject: "Hi {{record.name}}", body: "Welcome aboard!" }],
    by: "system",
  });
  const emailRun = await executeRule(
    emailRule, ctx, { id: "acc_smoke", name: "Smoke Co", email: "smoke@example.test" }, { test: false, trigger: "account.created" },
  );
  assert(emailRun.status === "success", `email automation run succeeds (got ${emailRun.status})`);
  assert(Number(emailRun.output.emails) === 1, `send_email bumps the emails counter (got ${emailRun.output.emails})`);
  const sendStep = emailRun.steps.find((s) => s.type === "send_email");
  // No SMTP configured in the smoke → graceful in-app fallback (still ok), recipient resolved from {{record.email}}.
  assert(!!sendStep && sendStep.status === "ok", `send_email step ok (got ${sendStep?.status})`);
  assert(!!sendStep && /smoke@example\.test/.test(String(sendStep.output)), `send_email resolved recipient (got ${sendStep?.output})`);
  const noRecipientRun = await executeRule(
    emailRule, ctx, { id: "acc_smoke2", name: "No Email Co" }, { test: false, trigger: "account.created" },
  );
  const noRcptStep = noRecipientRun.steps.find((s) => s.type === "send_email");
  assert(!!noRcptStep && noRcptStep.status === "skipped", `send_email without a recipient is skipped, not failed (got ${noRcptStep?.status})`);

  const dailyRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG,
    name: "Smoke daily digest", status: "active",
    trigger: { kind: "schedule", schedule: "daily" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "n1", type: "notify", subject: "Daily digest", body: "summary" }],
    by: "system",
  });
  const tick1 = await runScheduledAutomations(ctx);
  assert(tick1.some((r) => r.ruleId === dailyRule.id), "scheduled rule fires on the first cadence tick (never run)");
  const tick2 = await runScheduledAutomations(ctx);
  assert(!tick2.some((r) => r.ruleId === dailyRule.id), "scheduled rule is skipped within its daily cadence window");
  const tickForced = await runScheduledAutomations(ctx, { force: true });
  assert(tickForced.some((r) => r.ruleId === dailyRule.id), "force re-runs the scheduled rule (manual 'Run now')");
  // The job registry (what the in-process scheduler + /cron/tick drive) runs end-to-end.
  const jobResults = await runAllJobs(ctx);
  assert(jobResults.length === 2, `job registry runs billing + overdue jobs (got ${jobResults.length})`);
  assert(jobResults.every((r) => !r.summary.startsWith("failed")), "no job failed");

  // Queue: enqueue active scheduled rules, then drain the queue to completion.
  const queuedIds = await enqueueScheduled(ctx, { force: true });
  assert(queuedIds.includes(dailyRule.id), "enqueueScheduled queues an active scheduled rule");
  const drain = await processQueue(ctx);
  assert(drain.processed >= 1 && drain.remaining === 0, `processQueue drains the queue to completion (processed ${drain.processed}, remaining ${drain.remaining})`);
  // Live activity: completed runs are recorded so the UI can show "what ran".
  const liveAct = getLiveActivity(DEMO_TENANT, DEMO_ORG);
  assert(liveAct.recent.some((p) => p.ruleId === dailyRule.id), "live activity records recent runs");

  // Concurrency cap: at most `maxConcurrent` run at once; further due rules queue.
  await automationStore.setStatus(DEMO_TENANT, DEMO_ORG, dailyRule.id, "paused", "system");
  await automationStore.updateSettings(DEMO_TENANT, DEMO_ORG, { maxConcurrent: 2 });
  for (let k = 0; k < 3; k++) {
    await automationStore.createRule({
      tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: `Smoke conc ${k}`, status: "active",
      trigger: { kind: "schedule", schedule: "minutely" },
      conditions: { type: "group", logic: "AND", children: [] },
      actions: [{ id: `c${k}`, type: "notify", subject: "tick", body: "x" }],
      by: "system",
    });
  }
  const ranNow = await runScheduledAutomations(ctx, { force: true });
  assert(ranNow.length === 2, `runs at most maxConcurrent (2) at once (got ${ranNow.length})`);
  const qAfter = await automationStore.listQueue(DEMO_TENANT, DEMO_ORG);
  assert(qAfter.filter((q) => q.state === "pending").length === 1, `the overflow due automation is queued (got ${qAfter.filter((q) => q.state === "pending").length})`);
  const drain2 = await processQueue(ctx);
  assert(drain2.remaining === 0, `the queue drains the overflow to completion (remaining ${drain2.remaining})`);

  // Date-aware conditions: "after / before" compare as real dates (not parseFloat).
  assert(evaluateLeaf({ type: "condition", field: "d", op: "gt", value: "2026-01-01" }, { d: "2026-06-01" }), "date 'after' condition matches a later date");
  assert(!evaluateLeaf({ type: "condition", field: "d", op: "lt", value: "2026-01-01" }, { d: "2026-06-01" }), "date 'before' condition rejects a later date");

  // create_record: multiple field assignments satisfy required fields.
  const crOkRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Smoke create ok", status: "active",
    trigger: { kind: "event", entity: "account", event: "created" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "cr1", type: "create_record", entity: "account", assignments: [{ field: "name", value: "{{record.name}}" }] }],
    by: "system",
  });
  const crOk = await executeRule(crOkRule, ctx, { id: "x", name: "Automation Made Co" }, { test: false, trigger: "account.created" });
  assert(crOk.status === "success", `create_record with required fields succeeds (got ${crOk.status})`);
  // Missing a required field → failed run whose error names the field (not just "Validation failed").
  const crFailRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Smoke create fail", status: "active",
    trigger: { kind: "event", entity: "account", event: "created" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "cr2", type: "create_record", entity: "account", assignments: [] }],
    by: "system",
  });
  const crFail = await executeRule(crFailRule, ctx, { id: "y" }, { test: false, trigger: "account.created" });
  assert(crFail.status === "failed", `create_record missing required field fails (got ${crFail.status})`);
  assert(/name/i.test(String(crFail.error ?? "")), `failed run error names the missing field (got "${crFail.error}")`);

  // End-to-end event path: a real domain event fires the matching ACTIVE rule
  // with the REAL record (not a fixed/seeded value), and admin user-creation
  // now emits user.created so "email the newly-added user" automations work.
  console.log("\n[automation] real domain event fires the matching active rule (user.created):");
  registerAutomationEngine();
  const userRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Welcome new user", status: "active",
    trigger: { kind: "event", entity: "user", event: "created" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "se9", type: "send_email", to: "{{record.email}}", subject: "Welcome {{record.displayName}}", body: "Hi" }],
    by: "system",
  });
  const dsvc = await getDomainService();
  await dsvc.createWithComputed(ctx, "user", {
    email: "newhire@aula.example", displayName: "New Hire", positionId: "1", active: true,
  }, { passwordHash: "x.y" });
  const userRuns = await automationStore.listRuns(DEMO_TENANT, DEMO_ORG, { ruleId: userRule.id, limit: 50 });
  const fired = userRuns.find((r) => r.ruleId === userRule.id && r.trigger === "user.created");
  assert(!!fired, "creating a user fires the active user.created automation (admin create now emits the event)");
  const fireStep = fired?.steps.find((s) => s.type === "send_email");
  assert(!!fireStep && /newhire@aula\.example/.test(String(fireStep.output)), `{{record.email}} resolves to the REAL new record (got ${fireStep?.output})`);

  // Robustness: events whose payload carries ONLY an id (stage_changed, deleted,
  // or a manual run handing over a thin record) must still resolve {{record.*}} —
  // the engine hydrates the full record from the store before interpolating.
  console.log("\n[automation] thin event payload ({id} only) is hydrated so {{record.*}} still resolves:");
  const qeHy = await getQueryEngine();
  const acctHy = await qeHy.create(ctx, "account", { name: "Hydration Test Co", email: "owner@hydration.example" });
  const hydrateRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Email account on stage change", status: "active",
    trigger: { kind: "event", entity: "account", event: "stage_changed" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "seHy", type: "send_email", to: "{{record.email}}", subject: "Hi {{record.name}}", body: "x" }],
    by: "system",
  });
  // Simulate a stage_changed payload — only {id, from, to}, NO email/name.
  const hydrateRun = await executeRule(
    hydrateRule, ctx, { id: acctHy.id, from: "a", to: "b" }, { test: false, trigger: "account.stage_changed" },
  );
  const hydrateStep = hydrateRun.steps.find((s) => s.type === "send_email");
  assert(!!hydrateStep && /owner@hydration\.example/.test(String(hydrateStep.output)),
    `thin {id} payload hydrates {{record.email}} from the store (got ${hydrateStep?.output})`);
  assert(String(hydrateRun.input.email) === "owner@hydration.example",
    "run input snapshot reflects the hydrated record, not the thin payload");
  // A rule that reads no record fields takes no extra read and still runs.
  const noFieldRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Static notify", status: "active",
    trigger: { kind: "event", entity: "account", event: "stage_changed" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "nf1", type: "notify", to: "ops@aula.example", subject: "stage moved", body: "x" }],
    by: "system",
  });
  const noFieldRun = await executeRule(
    noFieldRule, ctx, { id: acctHy.id, from: "a", to: "b" }, { test: false, trigger: "account.stage_changed" },
  );
  assert(noFieldRun.status === "success", "rule referencing no record fields runs without hydration");

  // NO-RECORD GATING — the fix for the "Manual run" placeholder bug. A run that
  // resolves NO record (empty {} — what the manual-run endpoint now passes instead
  // of a fabricated {id:"manual",name:"Manual run"}) must SKIP record-dependent
  // actions with a clear reason, never fire a notify/email against invented values,
  // still run record-INDEPENDENT actions, and NOT enqueue a retry (no background
  // recurrence).
  console.log("\n[automation] no-record run skips record-dependent actions (no fabricated 'Manual run'):");
  const welcomeRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Welcome new hire", status: "active",
    trigger: { kind: "event", entity: "user", event: "created" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [
      { id: "wn1", type: "notify", to: "", subject: "Yeni İşe Giriş - {{record.name}}", body: "{{record.name}} - yeni işe giriş yapmıştır" },
      { id: "we1", type: "send_email", to: "{{record.email}}", subject: "Hi", body: "x" },
      { id: "ws1", type: "notify", to: "hr@aula.example", subject: "A new hire joined", body: "static — no record tokens" },
    ],
    by: "system",
  });
  const qBeforeNoRec = (await automationStore.listQueue(DEMO_TENANT, DEMO_ORG)).length;
  const noRecRun = await executeRule(welcomeRule, ctx, {}, { test: false, trigger: "manual run" });
  assert(
    noRecRun.steps.some((s) => s.type === "notify" && s.status === "skipped" && /no record/.test(String(s.output))),
    "no-record run SKIPS the {{record.name}} notify with a 'no record' reason",
  );
  assert(
    !noRecRun.steps.some((s) => /Manual run/.test(`${s.output ?? ""}${s.error ?? ""}`)),
    "no-record run never fabricates the literal 'Manual run' value",
  );
  assert(
    noRecRun.steps.find((s) => s.type === "send_email")?.status === "skipped",
    "no-record run skips the {{record.email}} send",
  );
  assert(noRecRun.output.notifications === 1, "the record-INDEPENDENT (static) notify still fires exactly once");
  const qAfterNoRec = (await automationStore.listQueue(DEMO_TENANT, DEMO_ORG)).length;
  assert(qAfterNoRec === qBeforeNoRec, "a no-record run does NOT enqueue a retry (kills the background recurrence)");

  // Same gating fixes SCHEDULE rules: their input is {scheduledAt} (no record), so
  // a {{record.*}} send is skipped rather than firing with empty fields.
  const schedRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Daily blast", status: "active",
    trigger: { kind: "schedule", schedule: "daily" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "sb1", type: "send_email", to: "{{record.email}}", subject: "x", body: "y" }],
    by: "system",
  });
  const schedRun = await executeRule(schedRule, ctx, { scheduledAt: ctx.at }, { test: false, trigger: "schedule" });
  assert(
    schedRun.steps.find((s) => s.type === "send_email")?.status === "skipped",
    "schedule rule with {{record.*}} skips the send (no record) instead of firing empty",
  );

  // deleted events now carry a record snapshot so delete-triggered automations
  // can resolve {{record.*}} even though the row is already gone.
  console.log("\n[automation] deleted event carries the record snapshot:");
  const delAcct = await qeHy.create(ctx, "account", { name: "ToDelete Co", email: "bye@del.example" });
  const delRule = await automationStore.createRule({
    tenantId: DEMO_TENANT, orgId: DEMO_ORG, name: "Notify on account delete", status: "active",
    trigger: { kind: "event", entity: "account", event: "deleted" },
    conditions: { type: "group", logic: "AND", children: [] },
    actions: [{ id: "dn1", type: "notify", to: "ops@aula.example", subject: "Deleted {{record.name}}", body: "{{record.email}} removed" }],
    by: "system",
  });
  const dsvcDel = await getDomainService();
  await dsvcDel.remove(ctx, "account", String(delAcct.id));
  const delFired = (await automationStore.listRuns(DEMO_TENANT, DEMO_ORG, { ruleId: delRule.id, limit: 10 }))
    .find((r) => r.trigger === "account.deleted");
  assert(
    !!delFired && String(delFired.input.name) === "ToDelete Co" && String(delFired.input.email) === "bye@del.example",
    "deleted event carries the record snapshot so {{record.*}} resolves",
  );
  assert(delFired?.steps.find((s) => s.type === "notify")?.status === "ok", "notify fires on delete with the snapshot record");

  // PEOPLE: a department's headcount is DERIVED live on read from its manager's
  // reports — employees via managerRef + users via managerId — and the manager is
  // pickable from both ("employee:<id>" / "user:<id>"). Never entered by hand.
  console.log("\n[people] department headcount derives from the manager's reports (employees + users):");
  const qePpl = await getQueryEngine();
  const boss = await qePpl.create(ctx, "user", { email: "boss@aula.example", displayName: "Boss", positionId: "1", active: true });
  const bossRef = `user:${boss.id}`;
  await qePpl.create(ctx, "employee", { firstName: "Rep", lastName: "One", managerRef: bossRef });
  await qePpl.create(ctx, "employee", { firstName: "Rep", lastName: "Two", managerRef: bossRef });
  await qePpl.create(ctx, "user", { email: "rep3@aula.example", displayName: "Rep Three", positionId: "1", active: true, managerId: String(boss.id) });
  const dept = await qePpl.create(ctx, "department", { name: "Engineering X", head: bossRef });
  const pplDom = await getDomainService();
  const deptRow = (await pplDom.list(ctx, "department", {})).items.find((d) => d.id === dept.id);
  assert(Number(deptRow?.headcount) === 3, `headcount = manager's reports: 2 employees + 1 user = 3 (got ${deptRow?.headcount})`);
  const deptOne = await pplDom.get(ctx, "department", String(dept.id));
  assert(Number(deptOne.headcount) === 3, `single department GET also derives headcount live (got ${deptOne.headcount})`);
  // An employee can manage too: head = "employee:<id>" counts employees reporting to that employee.
  const empBoss = await qePpl.create(ctx, "employee", { firstName: "Emp", lastName: "Boss" });
  const empBossRef = `employee:${empBoss.id}`;
  await qePpl.create(ctx, "employee", { firstName: "Sub", lastName: "Ord", managerRef: empBossRef });
  const dept2 = await qePpl.create(ctx, "department", { name: "Ops X", head: empBossRef });
  const dept2Row = (await pplDom.list(ctx, "department", {})).items.find((d) => d.id === dept2.id);
  assert(Number(dept2Row?.headcount) === 1, `employee-manager headcount counts employee reports (got ${dept2Row?.headcount})`);

  // IMPORT: accepts Excel (.xlsx), not just CSV — round-trips with enum/number coercion.
  console.log("\n[import] xlsx import + enum-label CSV round-trip:");
  const impDom = await getDomainService();
  const wbImp = new ExcelJS.Workbook();
  const wsImp = wbImp.addWorksheet("currency");
  wsImp.addRow(["id", "code", "symbol", "rate"]);
  wsImp.addRow(["", "XTS", "X", "2.5"]);
  const xbuf = await wbImp.xlsx.writeBuffer();
  const xb64 = Buffer.from(xbuf as ArrayBuffer).toString("base64");
  const xRes = await importXlsx(ctx, "currency", xb64, metadata, impDom);
  assert(
    xRes.created.length === 1 && xRes.errors.length === 0,
    `xlsx import created 1 currency (got ${xRes.created.length}, errors ${JSON.stringify(xRes.errors)})`,
  );
  const curr = await qe.get(ctx, "currency", xRes.created[0]);
  assert(String(curr.code) === "XTS" && Number(curr.rate) === 2.5, `xlsx values coerced (code=${curr.code}, rate=${curr.rate})`);
  // Header cells resolved by LABEL too (this is how the xlsx/pdf export writes them).
  const wbLbl = new ExcelJS.Workbook();
  const wsLbl = wbLbl.addWorksheet("currency");
  wsLbl.addRow(["ID", "Code", "Symbol", "Rate (per USD)"]); // localized labels, not field names
  wsLbl.addRow(["", "XTC", "Y", "3"]);
  const lb64 = Buffer.from((await wbLbl.xlsx.writeBuffer()) as ArrayBuffer).toString("base64");
  const lRes = await importXlsx(ctx, "currency", lb64, metadata, impDom);
  assert(
    lRes.created.length === 1 && lRes.errors.length === 0,
    `label-header xlsx import created 1 currency (got ${lRes.created.length}, errors ${JSON.stringify(lRes.errors)})`,
  );
  // CSV import maps an enum LABEL ("Technology") back to its stored value ("technology").
  const cRes = await importCsv(ctx, "account", "id,name,industry\n,EnumImportCo,Technology\n", metadata, impDom);
  assert(cRes.created.length === 1, `csv import created 1 account (got ${cRes.created.length}, errors ${JSON.stringify(cRes.errors)})`);
  const acc = await qe.get(ctx, "account", cRes.created[0]);
  assert(String(acc.industry) === "technology", `enum label mapped to value on import (got ${acc.industry})`);
  // ROUND-TRIP: re-importing a real xlsx export (label headers) must NOT fail
  // validation — any errors are unique-conflicts (records already exist), not the
  // "Validation failed" the broken label-header path produced.
  const xlsxBuf = await exportXlsx(ctx, "account", metadata, impDom);
  const rt = await importXlsx(ctx, "account", xlsxBuf.toString("base64"), metadata, impDom);
  assert(
    rt.errors.every((e) => !/validation failed/i.test(e.message)),
    `xlsx export round-trips without validation errors (got ${JSON.stringify(rt.errors.slice(0, 2))})`,
  );
  // LOCALIZED headers: a file headed in the user's language imports via aliases
  // (localized field label → field name) supplied by the UI.
  const trRes = await importCsv(
    ctx, "account", "Ad,E-posta\nLokalize Co,lokalize@test.example\n", metadata, impDom,
    { Ad: "name", "E-posta": "email" },
  );
  assert(
    trRes.created.length === 1 && trRes.errors.length === 0,
    `localized-header import created 1 account (got ${trRes.created.length}, errors ${JSON.stringify(trRes.errors)})`,
  );
  const trAcc = await qe.get(ctx, "account", trRes.created[0]);
  assert(
    String(trAcc.name) === "Lokalize Co" && String(trAcc.email) === "lokalize@test.example",
    `localized headers mapped via aliases (name=${trAcc.name}, email=${trAcc.email})`,
  );
  // Unrecognized columns are reported (not silently dropped).
  const ignRes = await importCsv(ctx, "account", "Bilinmeyen,name\nx,IgnoreColCo\n", metadata, impDom);
  assert((ignRes.ignored ?? []).includes("Bilinmeyen"), `unrecognized column reported as ignored (got ${JSON.stringify(ignRes.ignored)})`);
  // Import TEMPLATE is a real .xlsx with one header row of the writable field labels.
  const acctTpl = await buildImportTemplate("account", metadata, "xlsx");
  assert(acctTpl.ext === "xlsx" && acctTpl.buffer.length > 0, `xlsx template built (${acctTpl.buffer.length} bytes)`);
  const tplRows = await parseXlsx(acctTpl.buffer);
  assert(
    tplRows.length === 1 && tplRows[0].includes("Account Name"),
    `template = single header row of writable field labels (got ${JSON.stringify(tplRows[0])})`,
  );
  // BULK: a large import goes through qe.bulkCreate (no per-row domain events), so
  // thousands of rows complete fast instead of timing out.
  const BULK_N = 2000;
  let bulkCsv = "Name,Unit Price,SKU\n";
  for (let i = 0; i < BULK_N; i++) bulkCsv += `Bulk Prod ${i},9.99,BULK-${i}\n`;
  const t0 = Date.now();
  const bulkRes = await importCsv(ctx, "product", bulkCsv, metadata, impDom);
  console.log(`  (bulk-imported ${BULK_N} products in ${Date.now() - t0}ms)`);
  assert(
    bulkRes.created.length === BULK_N && bulkRes.errors.length === 0,
    `bulk import created ${BULK_N} products (got ${bulkRes.created.length}, errors ${bulkRes.errors.length})`,
  );
  // Within-batch duplicate unique value → one created, one rejected.
  const dupRes = await importCsv(ctx, "product", "Name,Unit Price,SKU\nDup A,1,DUP-SKU\nDup B,1,DUP-SKU\n", metadata, impDom);
  assert(
    dupRes.created.length === 1 && dupRes.errors.length === 1 && /unique/i.test(dupRes.errors[0].message),
    `within-batch duplicate SKU rejected (created ${dupRes.created.length}, errors ${JSON.stringify(dupRes.errors)})`,
  );
  // Unique value that already exists → rejected with a clear message.
  const existRes = await importCsv(ctx, "product", "Name,Unit Price,SKU\nExisting Dup,1,BULK-1\n", metadata, impDom);
  assert(
    existRes.created.length === 0 && /already exists/i.test(existRes.errors[0]?.message ?? ""),
    `existing unique SKU rejected (got ${JSON.stringify(existRes.errors)})`,
  );

  console.log(failures === 0 ? "\n✅ ERP smoke passed (Phase 1–6 + barcode/POS/labels + cart/returns + automation)\n" : `\n❌ ${failures} assertion(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
