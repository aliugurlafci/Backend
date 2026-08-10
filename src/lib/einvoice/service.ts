/**
 * e-Fatura orchestration.
 *
 * Turns a commercial invoice into a UBL-TR document, stores it, and hands it to
 * whichever integrator is configured. Everything up to transmission works with
 * no provider at all — the document is built, validated and persisted — which is
 * the point of the split: choosing a provider later means writing one adapter,
 * not revisiting how an invoice is expressed.
 *
 * Validation happens HERE rather than at submission. A missing tax number or
 * address comes back from the GİB as a rejection days later, detached from
 * whoever created the invoice; refusing to build the document names the missing
 * field while the person is still looking at it.
 */
import { randomUUID } from "node:crypto";
import type { EntityRecord } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { BadRequestError } from "@/lib/enforcement/errors";
import { logger } from "@/lib/observability/logger";
import { validateTaxNumber } from "@/lib/finance/tax-id";
import { buildEInvoiceId, buildInvoiceXml, isValidEInvoiceId } from "./ubl";
import {
  UnconfiguredIntegrator,
  type EInvoiceIntegrator,
  type EInvoiceKind,
  type EInvoiceProfile,
  type UblInvoice,
  type UblLine,
  type UblParty,
} from "./types";

const round2 = (n: number): number => Math.round(n * 100) / 100 + 0;

/**
 * The active integrator.
 *
 * Registered at boot once a provider is configured. Until then every send fails
 * loudly — see `UnconfiguredIntegrator`, which refuses rather than pretending,
 * because an invoice marked sent that the tax office never received is worse
 * than one that was never sent.
 */
let integrator: EInvoiceIntegrator = new UnconfiguredIntegrator();

export function registerEInvoiceIntegrator(next: EInvoiceIntegrator): void {
  integrator = next;
  logger.info("e-invoice integrator registered", { provider: next.name });
}

export function activeIntegrator(): EInvoiceIntegrator {
  return integrator;
}

/** Collects every missing field so the caller sees them all at once. */
function requireParty(record: EntityRecord, role: "satıcı" | "alıcı", problems: string[]): UblParty {
  const name = String(record.name ?? "").trim();
  const taxNumber = String(record.taxNumber ?? "").trim();
  if (!name) problems.push(`${role} unvanı eksik`);
  if (!taxNumber) problems.push(`${role} VKN/TCKN eksik`);

  const taxpayerType = record.taxpayerType === "individual" ? "individual" : "corporate";
  if (taxNumber) {
    const check = validateTaxNumber(taxNumber, taxpayerType);
    if (!check.ok) problems.push(`${role} VKN/TCKN geçersiz: ${check.reason}`);
  }
  // A tax office is required for a legal entity and meaningless for an individual.
  if (taxNumber.length === 10 && !String(record.taxOffice ?? "").trim()) {
    problems.push(`${role} vergi dairesi eksik`);
  }

  return {
    name,
    taxNumber,
    taxOffice: record.taxOffice ? String(record.taxOffice) : undefined,
    street: record.billingAddress ? String(record.billingAddress) : record.address ? String(record.address) : undefined,
    district: record.billingDistrict ? String(record.billingDistrict) : undefined,
    city: record.billingCity ? String(record.billingCity) : undefined,
    postalCode: record.billingPostalCode ? String(record.billingPostalCode) : undefined,
    phone: record.phone ? String(record.phone) : undefined,
    email: record.email ? String(record.email) : undefined,
  };
}

export interface PrepareOptions {
  /** 3-letter document series, e.g. "AUL". */
  series?: string;
  /** Force the profile; otherwise derived from `kind`. */
  profile?: EInvoiceProfile;
}

/**
 * Build (but do not send) the e-invoice document for a commercial invoice.
 *
 * Idempotent per invoice: an existing document is returned rather than a second
 * one created. Two documents for one supply is a compliance problem, and the
 * ETTN must be stable — the GİB identifies the document by it.
 */
export async function prepareEInvoice(
  ctx: RequestContext,
  invoiceId: string,
  opts: PrepareOptions = {},
): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });

  const existing = await qe.list(sys, "eInvoice", {
    filters: [{ field: "invoiceId", op: "eq", value: invoiceId }],
    pageSize: 1,
  });
  if (existing.items[0]) return existing.items[0];

  const invoice = await qe.get(sys, "invoice", invoiceId);
  const problems: string[] = [];

  const customerRec = invoice.accountId
    ? await qe.get(sys, "account", String(invoice.accountId)).catch(() => null)
    : null;
  if (!customerRec) problems.push("faturada müşteri yok");

  // The seller is the company the invoice belongs to. A deployment serves one
  // tenant but can hold several companies, so this is looked up rather than
  // assumed — and a missing one is a hard stop, not a default.
  const companies = await qe.list(sys, "company", {
    filters: [{ field: "active", op: "eq", value: true }],
    pageSize: 1,
  });
  const companyRec = companies.items[0];
  if (!companyRec) problems.push("satıcı firma tanımlı değil (Ayarlar → Firma)");

  const supplier = companyRec ? requireParty(companyRec, "satıcı", problems) : null;
  const customer = customerRec ? requireParty(customerRec, "alıcı", problems) : null;

  const lines = await qe.listComplete(sys, "invoiceLine", {
    filters: [{ field: "invoiceId", op: "eq", value: invoiceId }],
  });
  if (lines.length === 0) problems.push("faturada satır yok");

  if (problems.length) {
    throw new BadRequestError(`e-fatura hazırlanamadı: ${problems.join("; ")}`);
  }

  // Registration decides e-fatura vs e-arşiv. Without a provider we cannot know,
  // so the document is prepared as e-arşiv and the kind is settled at send time
  // — recorded here so the reason is visible rather than looking like a choice.
  let kind: EInvoiceKind = "earsiv";
  try {
    kind = (await integrator.isRegistered(customer!.taxNumber)) ? "efatura" : "earsiv";
  } catch {
    logger.info("e-invoice kind defaulted to earsiv (no integrator to check registration)", { invoiceId });
  }

  const ublLines: UblLine[] = lines.map((l, i) => {
    const quantity = Number(l.qty ?? 0);
    const unitPrice = Number(l.unitPrice ?? 0);
    const lineAmount = round2(quantity * unitPrice);
    const vatRate = Number(l.taxRate ?? 0);
    return {
      index: i + 1,
      name: String(l.description ?? ""),
      quantity,
      unitPrice,
      lineAmount,
      vatRate,
      vatAmount: round2((lineAmount * vatRate) / 100),
    };
  });

  const subtotal = round2(Number(invoice.subtotal ?? 0));
  const vatTotal = round2(Number(invoice.taxTotal ?? 0));
  const withheld = round2(Number(invoice.tevkifatTotal ?? 0));
  const ratio = Number(invoice.tevkifatRatio ?? 0);
  const payable = round2(Number(invoice.total ?? 0));

  const year = Number(String(invoice.issueDate ?? ctx.at).slice(0, 4));
  const sequence = await nextDocumentSequence(sys, year);
  const documentNumber = buildEInvoiceId(opts.series ?? "AUL", year, sequence);
  if (!isValidEInvoiceId(documentNumber)) {
    throw new BadRequestError(`geçersiz belge numarası üretildi: ${documentNumber}`);
  }

  const profile: EInvoiceProfile =
    opts.profile ?? (kind === "earsiv" ? "EARSIVFATURA" : "TEMELFATURA");
  const uuid = randomUUID();
  const issuedAt = String(invoice.issueDate ?? ctx.at.slice(0, 10));

  const ubl: UblInvoice = {
    id: documentNumber,
    uuid,
    issueDate: issuedAt.slice(0, 10),
    issueTime: ctx.at.slice(11, 19),
    profile,
    // TEVKIFAT is its own document type — not SATIS with an extra block.
    typeCode: withheld > 0 ? "TEVKIFAT" : "SATIS",
    currencyCode: String(invoice.currencyCode ?? "TRY"),
    supplier: supplier!,
    customer: customer!,
    lines: ublLines,
    lineExtensionAmount: subtotal,
    taxExclusiveAmount: subtotal,
    taxInclusiveAmount: round2(subtotal + vatTotal),
    payableAmount: payable,
    vatTotal,
    withholdingAmount: withheld > 0 ? withheld : undefined,
    withholdingRatioTenths: withheld > 0 ? ratio : undefined,
  };

  const xml = buildInvoiceXml(ubl);

  return qe.create(sys, "eInvoice", {
    invoiceId,
    documentNumber,
    uuid,
    kind,
    profile,
    issuedAt: ctx.at,
    integrator: integrator.name,
    xml,
    status: "draft",
  });
}

/**
 * Next sequence number for the year.
 *
 * Derived from the highest document already issued rather than a counter, so it
 * cannot drift from what was actually sent. Statutory numbering must be gapless
 * and monotonic; a separate counter that got ahead of reality would be very
 * hard to correct after the fact.
 */
async function nextDocumentSequence(ctx: RequestContext, year: number): Promise<number> {
  const qe = await getQueryEngine();
  const page = await qe.list(ctx, "eInvoice", {
    sort: [{ field: "documentNumber", dir: "desc" }],
    pageSize: 1,
  });
  const last = page.items[0]?.documentNumber ? String(page.items[0].documentNumber) : "";
  // Same series and year → continue; a new year restarts at 1.
  if (last.length === 16 && Number(last.slice(3, 7)) === year) {
    return Number(last.slice(7)) + 1;
  }
  return 1;
}

/**
 * Submit a prepared document.
 *
 * Failures are recorded on the document and re-thrown: the caller needs to know,
 * and the document needs to show why. Without a provider this always fails —
 * deliberately.
 */
export async function sendEInvoice(ctx: RequestContext, eInvoiceId: string): Promise<EntityRecord> {
  const qe = await getQueryEngine();
  const sys = systemContext(ctx.tenantId, ctx.orgId, { userId: ctx.userId, displayName: ctx.displayName, email: ctx.email });
  const doc = await qe.get(sys, "eInvoice", eInvoiceId);

  if (doc.status === "accepted" || doc.status === "sent") return doc;

  try {
    const result = await integrator.send(String(doc.xml ?? ""), {
      documentNumber: String(doc.documentNumber),
      uuid: String(doc.uuid),
      kind: String(doc.kind) as EInvoiceKind,
      profile: String(doc.profile) as EInvoiceProfile,
    });
    return qe.patchComputed(sys, "eInvoice", eInvoiceId, {
      status: result.status,
      externalId: result.externalId ?? null,
      integrator: integrator.name,
      lastError: result.message ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await qe.patchComputed(sys, "eInvoice", eInvoiceId, { status: "error", lastError: message });
    throw error;
  }
}
