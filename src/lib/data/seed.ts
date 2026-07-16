/**
 * Phase 5 — Seed data.
 *
 * Populates the in-memory repository so the app is useful on first run. Records
 * are written directly (trusted) with explicit owners across two tenants to
 * exercise ownership ABAC and cross-tenant isolation.
 */
import {
  DEMO_ORG,
  DEMO_TENANT,
  DEMO_USERS,
  OTHER_ORG,
  OTHER_TENANT,
  OTHER_USER,
} from "@/lib/context/dev";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import { numberSequence } from "@/lib/finance/number-sequence";
import { internalEan13 } from "@/lib/barcode/check-digit";
import type { Repository } from "./repository";
import { getDriver } from "./sql/driver";
import { getDialect } from "./sql/dialect";

/** Whether demo data has already been seeded (any account row exists). */
export async function isSeeded(): Promise<boolean> {
  const driver = await getDriver();
  const dialect = await getDialect();
  const result = await driver.query(`SELECT COUNT(*) AS c FROM ${dialect.table("account")}`, []);
  return Number((result.rows[0] as { c: number }).c) > 0;
}

const T0 = "2026-01-15T09:00:00.000Z";

/**
 * Seed ids are explicit, per-entity sequential integers (as strings) so the
 * cross-referenced graph below can link records before they are inserted. The
 * repository adopts these ids (via IDENTITY_INSERT on MSSQL) and continues the
 * IDENTITY sequence from there for runtime-created rows.
 */
const idCounters = new Map<string, number>();
function nextId(entity: string): string {
  const n = (idCounters.get(entity) ?? 0) + 1;
  idCounters.set(entity, n);
  return String(n);
}

/** Each seed record remembers its entity so `put` can route the insert. */
const entityOf = new WeakMap<EntityRecord, string>();

function mk(
  entity: string,
  tenantId: string,
  orgId: string,
  ownerId: string,
  fields: Record<string, FieldValue>,
): EntityRecord {
  const rec: EntityRecord = {
    id: nextId(entity),
    tenantId,
    orgId,
    ownerId,
    createdAt: T0,
    updatedAt: T0,
    createdBy: ownerId,
    updatedBy: ownerId,
    version: 1,
    ...fields,
  };
  entityOf.set(rec, entity);
  return rec;
}

export async function seedInto(repo: Repository): Promise<void> {
  const rep = DEMO_USERS.rep.userId;
  const mgr = DEMO_USERS.manager.userId;
  /** Insert a record built by `mk`, routing to its remembered entity table. */
  const put = (rec: EntityRecord) => repo.insert(entityOf.get(rec) ?? "unknown", rec);

  // --- Demo tenant accounts ---
  const initech = mk("account", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Initech",
    industry: "technology",
    website: "https://initech.example",
    phone: "+1-555-0100",
    annualRevenue: 4_200_000,
    employees: 120,
  });
  const umbrella = mk("account", DEMO_TENANT, DEMO_ORG, rep, {
    name: "Umbrella Corp",
    industry: "healthcare",
    website: "https://umbrella.example",
    phone: "+1-555-0144",
    annualRevenue: 88_000_000,
    employees: 5400,
  });
  const stark = mk("account", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Stark Industries",
    industry: "manufacturing",
    website: "https://stark.example",
    phone: "+1-555-0188",
    annualRevenue: 1_200_000_000,
    employees: 30000,
  });
  // Default cash-sale customer for POS walk-in sales (resolved by name in PosService).
  const walkIn = mk("account", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Walk-in Customer",
  });

  for (const a of [initech, umbrella, stark, walkIn]) await put(a);

  // --- Branches + dealers ---
  const hq = mk("branch", DEMO_TENANT, DEMO_ORG, mgr, {
    code: "HQ", name: "Headquarters", type: "headquarters", managerId: null,
    phone: "+1-555-0000", address: "1 Market Street, Metropolis", active: true,
  });
  const branchEast = mk("branch", DEMO_TENANT, DEMO_ORG, mgr, {
    code: "BR-E", name: "East Region Branch", type: "branch", managerId: null,
    phone: "+1-555-0010", address: "22 East Avenue, Gotham", active: true,
  });
  for (const b of [hq, branchEast]) await put(b);

  const dealerAcme = mk("dealer", DEMO_TENANT, DEMO_ORG, rep, {
    code: "DLR-1", name: "Acme Reseller", branchId: branchEast.id,
    email: "sales@acme-reseller.example", phone: "+1-555-0500", creditLimit: 50_000, balance: 0, active: true,
  });
  const dealerVertex = mk("dealer", DEMO_TENANT, DEMO_ORG, mgr, {
    code: "DLR-2", name: "Vertex Distribution", branchId: hq.id,
    email: "ops@vertex.example", phone: "+1-555-0501", creditLimit: 120_000, balance: 0, active: true,
  });
  for (const d of [dealerAcme, dealerVertex]) await put(d);

  // --- Deals across stages and owners (for ABAC) ---
  await put(
    mk("deal", DEMO_TENANT, DEMO_ORG, rep, {
      name: "Initech — Printer Fleet",
      stage: "qualified",
      amount: 75_000,
      probability: 40,
      closeDate: "2026-03-31",
      accountId: initech.id,
    }),
  );
  await put(
    mk("deal", DEMO_TENANT, DEMO_ORG, mgr, {
      name: "Umbrella — Lab Systems",
      stage: "negotiation",
      amount: 540_000,
      probability: 70,
      closeDate: "2026-02-28",
      accountId: umbrella.id,
    }),
  );
  await put(
    mk("deal", DEMO_TENANT, DEMO_ORG, mgr, {
      name: "Stark — Defense Platform",
      stage: "won",
      amount: 9_900_000,
      probability: 100,
      closeDate: "2026-01-10",
      accountId: stark.id,
    }),
  );
  await put(
    mk("deal", DEMO_TENANT, DEMO_ORG, rep, {
      name: "Initech — Expansion",
      stage: "lead",
      amount: 30_000,
      probability: 10,
      closeDate: "2026-05-15",
      accountId: initech.id,
    }),
  );

  // --- Tasks ---
  await put(
    mk("task", DEMO_TENANT, DEMO_ORG, rep, {
      subject: "Follow up with Bill",
      status: "open",
      dueDate: "2026-02-01",
      notes: "Send revised quote.",
      dealId: null,
    }),
  );

  // --- Currencies (rate = USD per 1 unit) ---
  for (const c of [
    { code: "USD", symbol: "$", rate: 1 },
    { code: "EUR", symbol: "€", rate: 1.08 },
    { code: "GBP", symbol: "£", rate: 1.27 },
    { code: "TRY", symbol: "₺", rate: 0.03 },
  ]) {
    await put(mk("currency", DEMO_TENANT, DEMO_ORG, mgr, c));
  }

  // --- Tax rates ---
  for (const t of [
    { name: "Standard VAT", rate: 20, region: "EU" },
    { name: "Reduced VAT", rate: 10, region: "EU" },
    { name: "Zero", rate: 0, region: "Global" },
  ]) {
    await put(mk("taxRate", DEMO_TENANT, DEMO_ORG, mgr, t));
  }

  // --- Products ---
  for (const p of [
    { name: "Platform License (Annual)", sku: "LIC-PLT", unitPrice: 12_000, currencyCode: "USD", taxRate: 20, active: true },
    { name: "Onboarding Package", sku: "SVC-ONB", unitPrice: 4_500, currencyCode: "USD", taxRate: 20, active: true },
    { name: "Premium Support", sku: "SVC-SUP", unitPrice: 2_000, currencyCode: "USD", taxRate: 10, active: true },
    { name: "Data Migration", sku: "SVC-MIG", unitPrice: 7_500, currencyCode: "EUR", taxRate: 20, active: true },
  ]) {
    await put(mk("product", DEMO_TENANT, DEMO_ORG, mgr, p));
  }

  // --- Stock-tracked products (physical goods) ---
  const prodRouter = mk("product", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Edge Router X100", sku: "HW-RTR-X100", barcode: internalEan13(1001), barcodeType: "ean13", unitPrice: 1_200, currencyCode: "USD", taxRate: 20,
    trackStock: true, costPrice: 720, reorderLevel: 20, uom: "ea", active: true,
  });
  const prodSwitch = mk("product", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Access Switch 24p", sku: "HW-SW-24", barcode: internalEan13(1002), barcodeType: "ean13", unitPrice: 650, currencyCode: "USD", taxRate: 20,
    trackStock: true, costPrice: 410, reorderLevel: 15, uom: "ea", active: true,
  });
  const prodCable = mk("product", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Cat6 Cable (305m box)", sku: "HW-CBL-CAT6", barcode: internalEan13(1003), barcodeType: "ean13", unitPrice: 120, currencyCode: "USD", taxRate: 20,
    trackStock: true, costPrice: 65, reorderLevel: 50, uom: "box", active: true,
  });
  for (const p of [prodRouter, prodSwitch, prodCable]) await put(p);

  // --- Warehouses ---
  const whMain = mk("warehouse", DEMO_TENANT, DEMO_ORG, mgr, {
    code: "WH-MAIN", name: "Main Warehouse", branchId: hq.id, address: "1 Market Street", active: true,
  });
  const whEast = mk("warehouse", DEMO_TENANT, DEMO_ORG, mgr, {
    code: "WH-EAST", name: "East Depot", branchId: branchEast.id, address: "22 East Avenue", active: true,
  });
  for (const w of [whMain, whEast]) await put(w);

  // --- Suppliers ---
  const supNetgear = mk("supplier", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Netgear Distribution", code: "SUP-NTG", email: "orders@netgear-dist.example",
    phone: "+1-555-0700", address: "9 Supply Rd", taxNumber: "TX-7781", currencyCode: "USD", active: true,
  });
  const supCableco = mk("supplier", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "CableCo Wholesale", code: "SUP-CBL", email: "sales@cableco.example",
    phone: "+1-555-0701", address: "14 Wire Ave", taxNumber: "TX-9920", currencyCode: "USD", active: true,
  });
  for (const s of [supNetgear, supCableco]) await put(s);

  // --- Opening stock (movements; on-hand is derived from these) ---
  const openings = [
    { product: prodRouter, warehouse: whMain, qty: 40, cost: 720 },
    { product: prodRouter, warehouse: whEast, qty: 12, cost: 720 },
    { product: prodSwitch, warehouse: whMain, qty: 30, cost: 410 },
    { product: prodCable, warehouse: whMain, qty: 120, cost: 65 },
    { product: prodCable, warehouse: whEast, qty: 45, cost: 65 },
  ];
  let openingStockValue = 0;
  for (const o of openings) {
    openingStockValue += o.qty * o.cost;
    await put(
      mk("stockMovement", DEMO_TENANT, DEMO_ORG, mgr, {
        productId: o.product.id, warehouseId: o.warehouse.id, qty: o.qty, type: "receipt",
        unitCost: o.cost, value: o.qty * o.cost, ref: "OPENING", refType: "opening",
        branchId: (o.warehouse.branchId as string) ?? null, movedAt: T0,
        stockKey: `${o.product.id}:${o.warehouse.id}`,
      }),
    );
  }

  // --- Chart of accounts ---
  const coa = [
    { code: "1000", name: "Cash & Bank", type: "asset", subtype: "cash", normalBalance: "debit" },
    { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "accounts_receivable", normalBalance: "debit" },
    { code: "1200", name: "Inventory", type: "asset", subtype: "inventory", normalBalance: "debit" },
    { code: "2000", name: "Accounts Payable", type: "liability", subtype: "accounts_payable", normalBalance: "credit" },
    { code: "2050", name: "GR/IR Clearing", type: "liability", subtype: "gr_ir", normalBalance: "credit" },
    { code: "2100", name: "Tax Payable", type: "liability", subtype: "tax_payable", normalBalance: "credit" },
    { code: "3000", name: "Opening Balance Equity", type: "equity", subtype: "retained_earnings", normalBalance: "credit" },
    { code: "4000", name: "Sales Revenue", type: "revenue", subtype: "sales_revenue", normalBalance: "credit" },
    { code: "5000", name: "Cost of Goods Sold", type: "expense", subtype: "cogs", normalBalance: "debit" },
    { code: "6000", name: "Operating Expenses", type: "expense", subtype: "operating_expense", normalBalance: "debit" },
    { code: "6100", name: "Inventory Adjustments", type: "expense", subtype: "operating_expense", normalBalance: "debit" },
  ];
  const acctBySubtype = new Map<string, EntityRecord>();
  for (const a of coa) {
    const rec = mk("ledgerAccount", DEMO_TENANT, DEMO_ORG, mgr, { ...a, parentId: null, isPostable: true, active: true });
    await put(rec);
    acctBySubtype.set(a.subtype, rec);
  }

  // --- Fiscal period ---
  await put(mk("fiscalPeriod", DEMO_TENANT, DEMO_ORG, mgr, { name: "FY2026", startDate: "2026-01-01", endDate: "2026-12-31", status: "open" }));

  // --- Opening balance journal (Inventory vs Opening Equity) — keeps the TB balanced from seed ---
  const invAcct = acctBySubtype.get("inventory")!;
  const eqAcct = acctBySubtype.get("retained_earnings")!;
  const openingJe = mk("journalEntry", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "JE-1", date: "2026-01-01", memo: "Opening balances", source: "manual", sourceRef: "OPENING",
    branchId: hq.id, status: "posted", debitTotal: openingStockValue, creditTotal: openingStockValue,
  });
  await put(openingJe);
  await put(mk("journalLine", DEMO_TENANT, DEMO_ORG, mgr, {
    entryId: openingJe.id, ledgerAccountId: invAcct.id, debit: openingStockValue, credit: 0, description: "Opening inventory", branchId: hq.id, posted: true,
  }));
  await put(mk("journalLine", DEMO_TENANT, DEMO_ORG, mgr, {
    entryId: openingJe.id, ledgerAccountId: eqAcct.id, debit: 0, credit: openingStockValue, description: "Opening equity", branchId: hq.id, posted: true,
  }));

  // --- Purchasing: an approved PO awaiting goods receipt ---
  const poLines = [
    { productId: prodRouter.id, description: "Edge Router X100", qty: 20, unitPrice: 720, taxRate: 20 },
    { productId: prodSwitch.id, description: "Access Switch 24p", qty: 10, unitPrice: 410, taxRate: 20 },
  ];
  let poSub = 0;
  let poTax = 0;
  for (const l of poLines) {
    poSub += l.qty * l.unitPrice;
    poTax += l.qty * l.unitPrice * (l.taxRate / 100);
  }
  const po1 = mk("purchaseOrder", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "PO-5001", supplierId: supNetgear.id, warehouseId: whMain.id, status: "approved",
    currencyCode: "USD", orderDate: "2026-01-12", expectedDate: "2026-01-25", branchId: hq.id,
    subtotal: poSub, taxTotal: poTax, total: poSub + poTax, notes: null,
  });
  await put(po1);
  for (const l of poLines) {
    const net = l.qty * l.unitPrice;
    await put(
      mk("purchaseOrderLine", DEMO_TENANT, DEMO_ORG, mgr, {
        poId: po1.id, productId: l.productId, description: l.description, qty: l.qty,
        unitPrice: l.unitPrice, taxRate: l.taxRate, qtyReceived: 0, lineTotal: net + net * (l.taxRate / 100),
      }),
    );
  }

  // --- Invoices + payments (AR) ---
  const inv1 = mk("invoice", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "INV-1001", accountId: initech.id, quoteId: null, branchId: hq.id, dealerId: null, status: "partial", currencyCode: "USD",
    issueDate: "2026-01-05", dueDate: "2026-02-04", subtotal: 12_000, taxTotal: 2_400, total: 14_400,
    amountPaid: 5_000, balance: 9_400, notes: null,
  });
  const inv2 = mk("invoice", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "INV-1002", accountId: umbrella.id, quoteId: null, branchId: branchEast.id, dealerId: dealerAcme.id, status: "sent", currencyCode: "USD",
    issueDate: "2025-12-10", dueDate: "2026-01-09", subtotal: 60_000, taxTotal: 0, total: 60_000,
    amountPaid: 0, balance: 60_000, notes: null,
  });
  const inv3 = mk("invoice", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "INV-1003", accountId: stark.id, quoteId: null, branchId: hq.id, dealerId: dealerVertex.id, status: "paid", currencyCode: "USD",
    issueDate: "2026-01-02", dueDate: "2026-02-01", subtotal: 100_000, taxTotal: 0, total: 100_000,
    amountPaid: 100_000, balance: 0, notes: null,
  });
  for (const inv of [inv1, inv2, inv3]) await put(inv);

  await put(mk("invoiceLine", DEMO_TENANT, DEMO_ORG, mgr, {
    invoiceId: inv1.id, productId: null, description: "Platform License (Annual)", qty: 1, unitPrice: 12_000, taxRate: 20, lineTotal: 14_400,
  }));
  await put(mk("invoiceLine", DEMO_TENANT, DEMO_ORG, mgr, {
    invoiceId: inv2.id, productId: null, description: "Lab Systems Rollout", qty: 1, unitPrice: 60_000, taxRate: 0, lineTotal: 60_000,
  }));
  await put(mk("invoiceLine", DEMO_TENANT, DEMO_ORG, mgr, {
    invoiceId: inv3.id, productId: null, description: "Defense Platform", qty: 1, unitPrice: 100_000, taxRate: 0, lineTotal: 100_000,
  }));

  await put(mk("payment", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "P-1001", invoiceId: inv1.id, accountId: initech.id, branchId: hq.id, dealerId: null, amount: 5_000, method: "bank", paidAt: "2026-01-20", notes: null,
  }));
  await put(mk("payment", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "P-1002", invoiceId: inv3.id, accountId: stark.id, branchId: hq.id, dealerId: dealerVertex.id, amount: 100_000, method: "bank", paidAt: "2026-01-15", notes: null,
  }));

  // --- Recurring plan (due in the past so the billing run generates one) ---
  await put(mk("recurringPlan", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Initech — Monthly Platform Fee",
    accountId: initech.id,
    description: "Monthly platform subscription",
    amount: 1_000,
    taxRate: 20,
    currencyCode: "USD",
    frequency: "monthly",
    nextRun: "2026-01-01",
    active: true,
  }));

  // --- Sales orders ---
  for (const o of [
    { number: "SO-3001", accountId: initech.id, branchId: hq.id, dealerId: null, status: "confirmed", amount: 36_000, orderDate: "2026-01-08" },
    { number: "SO-3002", accountId: stark.id, branchId: hq.id, dealerId: dealerVertex.id, status: "completed", amount: 100_000, orderDate: "2026-01-03" },
    { number: "SO-3003", accountId: umbrella.id, branchId: branchEast.id, dealerId: dealerAcme.id, status: "pending", amount: 60_000, orderDate: "2026-01-22" },
  ]) {
    await put(mk("salesOrder", DEMO_TENANT, DEMO_ORG, rep, o));
  }

  // --- People: departments + staff ---
  // Staff are created first so a department's `head` can point at a real person
  // ("employee:<id>") and reports can link to their manager via `managerRef` —
  // which drives the live-derived headcount. Managers' own departmentId is wired
  // after the departments exist.
  const morgan = mk("employee", DEMO_TENANT, DEMO_ORG, mgr, { firstName: "Morgan", lastName: "Manager", email: "morgan@aula.example", phone: "+1-555-0300", title: "Sales Manager", branchId: hq.id, status: "active" });
  const dana = mk("employee", DEMO_TENANT, DEMO_ORG, mgr, { firstName: "Dana", lastName: "Lee", email: "dana@aula.example", phone: "+1-555-0302", title: "Eng Lead", branchId: hq.id, status: "active" });
  const sam = mk("employee", DEMO_TENANT, DEMO_ORG, mgr, { firstName: "Sam", lastName: "Park", email: "sam@aula.example", phone: "+1-555-0303", title: "Support Lead", branchId: branchEast.id, status: "on_leave" });

  const deptSales = mk("department", DEMO_TENANT, DEMO_ORG, mgr, { name: "Sales", head: `employee:${morgan.id}` });
  const deptEng = mk("department", DEMO_TENANT, DEMO_ORG, mgr, { name: "Engineering", head: `employee:${dana.id}` });
  const deptSupport = mk("department", DEMO_TENANT, DEMO_ORG, mgr, { name: "Support", head: `employee:${sam.id}` });

  morgan.departmentId = deptSales.id;
  dana.departmentId = deptEng.id;
  sam.departmentId = deptSupport.id;

  // Reports — `managerRef` links each to their manager so the manager's
  // department headcount derives to a real number on read.
  const riley = mk("employee", DEMO_TENANT, DEMO_ORG, mgr, { firstName: "Riley", lastName: "Rep", email: "riley@aula.example", phone: "+1-555-0301", title: "Account Executive", departmentId: deptSales.id, branchId: branchEast.id, status: "active", managerRef: `employee:${morgan.id}` });
  const cory = mk("employee", DEMO_TENANT, DEMO_ORG, mgr, { firstName: "Cory", lastName: "Channel", email: "cory@aula.example", phone: "+1-555-0304", title: "Dealer Account Manager", departmentId: deptSales.id, dealerId: dealerAcme.id, status: "active", managerRef: `employee:${morgan.id}` });

  for (const d of [deptSales, deptEng, deptSupport]) await put(d);
  for (const e of [morgan, dana, sam, riley, cory]) await put(e);

  // --- Calendar events (shared org calendar; admin-managed) ---
  for (const ev of [
    { title: "Q1 Sales Review", date: "2026-01-20", type: "meeting", notes: "Quarterly pipeline review with the team." },
    { title: "INV-1002 payment due", date: "2026-01-09", type: "deadline", notes: null },
    { title: "Warehouse stock count", date: "2026-01-28", type: "reminder", notes: "Cycle count main + east warehouses." },
  ]) {
    await put(mk("calendarEvent", DEMO_TENANT, DEMO_ORG, mgr, ev));
  }

  // Keep runtime sequences ahead of seeded document numbers.
  await numberSequence.bump(DEMO_TENANT, "INV", 1003);
  await numberSequence.bump(DEMO_TENANT, "P", 1002);
  await numberSequence.bump(DEMO_TENANT, "PO", 5001);
  await numberSequence.bump(DEMO_TENANT, "JE", 1);

  // --- Other tenant (must remain invisible to demo tenant) ---
  await put(
    mk("account", OTHER_TENANT, OTHER_ORG, OTHER_USER.userId, {
      name: "Globex Internal",
      industry: "finance",
      website: "https://globex.example",
      phone: "+1-555-9000",
      annualRevenue: 50_000_000,
      employees: 800,
    }),
  );
}
