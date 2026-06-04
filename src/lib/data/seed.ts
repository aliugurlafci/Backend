/**
 * Phase 5 — Seed data.
 *
 * Populates the in-memory repository so the app is useful on first run. Records
 * are written directly (trusted) with explicit owners across two tenants to
 * exercise ownership ABAC and cross-tenant isolation.
 */
import { newId } from "@/lib/core/ids";
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
import type { Repository } from "./repository";
import { getPool } from "./mssql/connection";

/** Whether demo data has already been seeded (any account row exists). */
export async function isSeeded(): Promise<boolean> {
  const pool = await getPool();
  const result = await pool.request().query("SELECT COUNT(*) AS c FROM [dbo].[account]");
  return Number((result.recordset[0] as { c: number }).c) > 0;
}

const T0 = "2026-01-15T09:00:00.000Z";

function mk(
  entity: string,
  tenantId: string,
  orgId: string,
  ownerId: string,
  fields: Record<string, FieldValue>,
): EntityRecord {
  return {
    id: newId(entity),
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
}

export async function seedInto(repo: Repository): Promise<void> {
  const rep = DEMO_USERS.rep.userId;
  const mgr = DEMO_USERS.manager.userId;

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

  for (const a of [initech, umbrella, stark]) await repo.insert(a);

  // --- Contacts ---
  await repo.insert(
    mk("contact", DEMO_TENANT, DEMO_ORG, mgr, {
      firstName: "Bill",
      lastName: "Lumbergh",
      email: "bill@initech.example",
      phone: "+1-555-0101",
      title: "VP",
      accountId: initech.id,
    }),
  );
  await repo.insert(
    mk("contact", DEMO_TENANT, DEMO_ORG, rep, {
      firstName: "Alice",
      lastName: "Wesker",
      email: "alice@umbrella.example",
      phone: "+1-555-0145",
      title: "Procurement Lead",
      accountId: umbrella.id,
    }),
  );

  // --- Deals across stages and owners (for ABAC) ---
  await repo.insert(
    mk("deal", DEMO_TENANT, DEMO_ORG, rep, {
      name: "Initech — Printer Fleet",
      stage: "qualified",
      amount: 75_000,
      probability: 40,
      closeDate: "2026-03-31",
      accountId: initech.id,
    }),
  );
  await repo.insert(
    mk("deal", DEMO_TENANT, DEMO_ORG, mgr, {
      name: "Umbrella — Lab Systems",
      stage: "negotiation",
      amount: 540_000,
      probability: 70,
      closeDate: "2026-02-28",
      accountId: umbrella.id,
    }),
  );
  await repo.insert(
    mk("deal", DEMO_TENANT, DEMO_ORG, mgr, {
      name: "Stark — Defense Platform",
      stage: "won",
      amount: 9_900_000,
      probability: 100,
      closeDate: "2026-01-10",
      accountId: stark.id,
    }),
  );
  await repo.insert(
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
  await repo.insert(
    mk("task", DEMO_TENANT, DEMO_ORG, rep, {
      subject: "Follow up with Bill",
      status: "open",
      dueDate: "2026-02-01",
      notes: "Send revised quote.",
      dealId: null,
    }),
  );

  // --- Leads ---
  await repo.insert(
    mk("lead", DEMO_TENANT, DEMO_ORG, rep, {
      name: "Dana Scully",
      company: "Wayne Enterprises",
      email: "dana@wayne.example",
      phone: "+1-555-0200",
      source: "web",
      estimatedValue: 120_000,
      status: "working",
    }),
  );
  await repo.insert(
    mk("lead", DEMO_TENANT, DEMO_ORG, mgr, {
      name: "Frank Castle",
      company: "Cyberdyne",
      email: "frank@cyberdyne.example",
      phone: "+1-555-0201",
      source: "referral",
      estimatedValue: 60_000,
      status: "new",
    }),
  );

  // --- Currencies (rate = USD per 1 unit) ---
  for (const c of [
    { code: "USD", symbol: "$", rate: 1 },
    { code: "EUR", symbol: "€", rate: 1.08 },
    { code: "GBP", symbol: "£", rate: 1.27 },
    { code: "TRY", symbol: "₺", rate: 0.03 },
  ]) {
    await repo.insert(mk("currency", DEMO_TENANT, DEMO_ORG, mgr, c));
  }

  // --- Tax rates ---
  for (const t of [
    { name: "Standard VAT", rate: 20, region: "EU" },
    { name: "Reduced VAT", rate: 10, region: "EU" },
    { name: "Zero", rate: 0, region: "Global" },
  ]) {
    await repo.insert(mk("taxRate", DEMO_TENANT, DEMO_ORG, mgr, t));
  }

  // --- Products ---
  for (const p of [
    { name: "Platform License (Annual)", sku: "LIC-PLT", unitPrice: 12_000, currencyCode: "USD", taxRate: 20, active: true },
    { name: "Onboarding Package", sku: "SVC-ONB", unitPrice: 4_500, currencyCode: "USD", taxRate: 20, active: true },
    { name: "Premium Support", sku: "SVC-SUP", unitPrice: 2_000, currencyCode: "USD", taxRate: 10, active: true },
    { name: "Data Migration", sku: "SVC-MIG", unitPrice: 7_500, currencyCode: "EUR", taxRate: 20, active: true },
  ]) {
    await repo.insert(mk("product", DEMO_TENANT, DEMO_ORG, mgr, p));
  }

  // --- Invoices + payments (AR) ---
  const inv1 = mk("invoice", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "INV-1001", accountId: initech.id, quoteId: null, status: "partial", currencyCode: "USD",
    issueDate: "2026-01-05", dueDate: "2026-02-04", subtotal: 12_000, taxTotal: 2_400, total: 14_400,
    amountPaid: 5_000, balance: 9_400, notes: null,
  });
  const inv2 = mk("invoice", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "INV-1002", accountId: umbrella.id, quoteId: null, status: "sent", currencyCode: "USD",
    issueDate: "2025-12-10", dueDate: "2026-01-09", subtotal: 60_000, taxTotal: 0, total: 60_000,
    amountPaid: 0, balance: 60_000, notes: null,
  });
  const inv3 = mk("invoice", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "INV-1003", accountId: stark.id, quoteId: null, status: "paid", currencyCode: "USD",
    issueDate: "2026-01-02", dueDate: "2026-02-01", subtotal: 100_000, taxTotal: 0, total: 100_000,
    amountPaid: 100_000, balance: 0, notes: null,
  });
  for (const inv of [inv1, inv2, inv3]) await repo.insert(inv);

  await repo.insert(mk("invoiceLine", DEMO_TENANT, DEMO_ORG, mgr, {
    invoiceId: inv1.id, productId: null, description: "Platform License (Annual)", qty: 1, unitPrice: 12_000, taxRate: 20, lineTotal: 14_400,
  }));
  await repo.insert(mk("invoiceLine", DEMO_TENANT, DEMO_ORG, mgr, {
    invoiceId: inv2.id, productId: null, description: "Lab Systems Rollout", qty: 1, unitPrice: 60_000, taxRate: 0, lineTotal: 60_000,
  }));
  await repo.insert(mk("invoiceLine", DEMO_TENANT, DEMO_ORG, mgr, {
    invoiceId: inv3.id, productId: null, description: "Defense Platform", qty: 1, unitPrice: 100_000, taxRate: 0, lineTotal: 100_000,
  }));

  await repo.insert(mk("payment", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "P-1001", invoiceId: inv1.id, accountId: initech.id, amount: 5_000, method: "bank", paidAt: "2026-01-20", notes: null,
  }));
  await repo.insert(mk("payment", DEMO_TENANT, DEMO_ORG, mgr, {
    number: "P-1002", invoiceId: inv3.id, accountId: stark.id, amount: 100_000, method: "bank", paidAt: "2026-01-15", notes: null,
  }));

  // --- Recurring plan (due in the past so the billing run generates one) ---
  await repo.insert(mk("recurringPlan", DEMO_TENANT, DEMO_ORG, mgr, {
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

  // --- Proposals ---
  for (const p of [
    { title: "Initech — Platform Rollout", accountId: initech.id, status: "sent", amount: 84_000, validUntil: "2026-03-15" },
    { title: "Umbrella — Lab Integration", accountId: umbrella.id, status: "accepted", amount: 220_000, validUntil: "2026-02-20" },
    { title: "Stark — Security Suite", accountId: stark.id, status: "draft", amount: 510_000, validUntil: "2026-04-30" },
  ]) {
    await repo.insert(mk("proposal", DEMO_TENANT, DEMO_ORG, rep, p));
  }

  // --- Estimations ---
  for (const e of [
    { number: "EST-2001", accountId: initech.id, status: "approved", amount: 42_000, expiryDate: "2026-03-01" },
    { number: "EST-2002", accountId: umbrella.id, status: "sent", amount: 96_000, expiryDate: "2026-03-12" },
  ]) {
    await repo.insert(mk("estimation", DEMO_TENANT, DEMO_ORG, mgr, e));
  }

  // --- Contracts ---
  for (const c of [
    { title: "Initech MSA", accountId: initech.id, status: "active", value: 144_000, startDate: "2026-01-01", endDate: "2026-12-31" },
    { title: "Umbrella SLA", accountId: umbrella.id, status: "active", value: 360_000, startDate: "2025-07-01", endDate: "2026-06-30" },
    { title: "Stark NDA + Build", accountId: stark.id, status: "draft", value: 1_200_000, startDate: "2026-02-01", endDate: "2027-01-31" },
  ]) {
    await repo.insert(mk("contract", DEMO_TENANT, DEMO_ORG, mgr, c));
  }

  // --- Sales orders ---
  for (const o of [
    { number: "SO-3001", accountId: initech.id, status: "confirmed", amount: 36_000, orderDate: "2026-01-08" },
    { number: "SO-3002", accountId: stark.id, status: "completed", amount: 100_000, orderDate: "2026-01-03" },
    { number: "SO-3003", accountId: umbrella.id, status: "pending", amount: 60_000, orderDate: "2026-01-22" },
  ]) {
    await repo.insert(mk("salesOrder", DEMO_TENANT, DEMO_ORG, rep, o));
  }

  // --- Projects + milestones + timesheets ---
  const proj1 = mk("project", DEMO_TENANT, DEMO_ORG, mgr, {
    name: "Initech CRM Migration", accountId: initech.id, status: "active", priority: "high",
    budget: 120_000, progress: 65, startDate: "2026-01-05", dueDate: "2026-04-30",
  });
  const proj2 = mk("project", DEMO_TENANT, DEMO_ORG, rep, {
    name: "Umbrella Data Platform", accountId: umbrella.id, status: "planning", priority: "medium",
    budget: 280_000, progress: 15, startDate: "2026-02-01", dueDate: "2026-08-31",
  });
  for (const p of [proj1, proj2]) await repo.insert(p);

  for (const m of [
    { name: "Discovery & Audit", projectId: proj1.id, status: "done", amount: 20_000, dueDate: "2026-01-31" },
    { name: "Data Migration", projectId: proj1.id, status: "in_progress", amount: 50_000, dueDate: "2026-03-15" },
    { name: "Go-Live", projectId: proj1.id, status: "pending", amount: 50_000, dueDate: "2026-04-30" },
    { name: "Requirements", projectId: proj2.id, status: "in_progress", amount: 40_000, dueDate: "2026-03-01" },
  ]) {
    await repo.insert(mk("milestone", DEMO_TENANT, DEMO_ORG, mgr, m));
  }

  for (const t of [
    { title: "Schema mapping", projectId: proj1.id, hours: 6, date: "2026-01-20", billable: true, status: "approved" },
    { title: "ETL scripting", projectId: proj1.id, hours: 8, date: "2026-01-21", billable: true, status: "submitted" },
    { title: "Kickoff workshop", projectId: proj2.id, hours: 4, date: "2026-02-03", billable: false, status: "draft" },
  ]) {
    await repo.insert(mk("timesheet", DEMO_TENANT, DEMO_ORG, rep, t));
  }

  // --- Marketing campaigns ---
  for (const c of [
    { name: "Q1 Product Launch", channel: "email", status: "running", budget: 12_000, sent: 18_400, startDate: "2026-01-10", endDate: "2026-03-31" },
    { name: "Spring Webinar Series", channel: "social", status: "scheduled", budget: 5_000, sent: 0, startDate: "2026-03-01", endDate: "2026-05-31" },
    { name: "Renewal Reminders", channel: "sms", status: "completed", budget: 1_500, sent: 920, startDate: "2025-12-01", endDate: "2025-12-31" },
    { name: "Holiday WhatsApp Blast", channel: "whatsapp", status: "draft", budget: 800, sent: 0, startDate: "2026-04-01", endDate: "2026-04-15" },
  ]) {
    await repo.insert(mk("campaign", DEMO_TENANT, DEMO_ORG, mgr, c));
  }

  // --- Support tickets ---
  for (const t of [
    { subject: "Login fails after SSO change", accountId: initech.id, priority: "urgent", status: "open", assignee: "Riley Rep" },
    { subject: "Export to CSV truncates rows", accountId: umbrella.id, priority: "high", status: "pending", assignee: "Morgan Manager" },
    { subject: "Request: dark mode for portal", accountId: stark.id, priority: "low", status: "open", assignee: "Riley Rep" },
    { subject: "Invoice PDF missing logo", accountId: initech.id, priority: "medium", status: "resolved", assignee: "Casey Accountant" },
  ]) {
    await repo.insert(mk("ticket", DEMO_TENANT, DEMO_ORG, rep, t));
  }

  // --- People: departments + staff ---
  const deptSales = mk("department", DEMO_TENANT, DEMO_ORG, mgr, { name: "Sales", head: "Morgan Manager", headcount: 8 });
  const deptEng = mk("department", DEMO_TENANT, DEMO_ORG, mgr, { name: "Engineering", head: "Dana Lee", headcount: 14 });
  const deptSupport = mk("department", DEMO_TENANT, DEMO_ORG, mgr, { name: "Support", head: "Sam Park", headcount: 5 });
  for (const d of [deptSales, deptEng, deptSupport]) await repo.insert(d);

  for (const e of [
    { firstName: "Morgan", lastName: "Manager", email: "morgan@aula.example", phone: "+1-555-0300", title: "Sales Manager", departmentId: deptSales.id, status: "active" },
    { firstName: "Riley", lastName: "Rep", email: "riley@aula.example", phone: "+1-555-0301", title: "Account Executive", departmentId: deptSales.id, status: "active" },
    { firstName: "Dana", lastName: "Lee", email: "dana@aula.example", phone: "+1-555-0302", title: "Eng Lead", departmentId: deptEng.id, status: "active" },
    { firstName: "Sam", lastName: "Park", email: "sam@aula.example", phone: "+1-555-0303", title: "Support Lead", departmentId: deptSupport.id, status: "on_leave" },
  ]) {
    await repo.insert(mk("employee", DEMO_TENANT, DEMO_ORG, mgr, e));
  }

  // Keep runtime sequences ahead of seeded document numbers.
  await numberSequence.bump(DEMO_TENANT, "INV", 1003);
  await numberSequence.bump(DEMO_TENANT, "P", 1002);

  // --- Other tenant (must remain invisible to demo tenant) ---
  await repo.insert(
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
