/**
 * UBL-TR 1.2 invoice serialisation.
 *
 * Builds the XML the GİB expects, independently of who transmits it. This is the
 * part that does not vary between integrators — and the part with the rules, so
 * it is where the effort belongs.
 *
 * A few things the schema is strict about, stated here because they are easy to
 * get subtly wrong and the failure arrives as a rejection days later:
 *
 *  - Element ORDER is significant. UBL is a sequence, not a bag; emitting
 *    `cbc:IssueTime` before `cbc:IssueDate` is invalid even though both are
 *    present. The builder writes them in schema order and the tests pin it.
 *  - Amounts carry `currencyID`, and the decimal form matters: fixed 2 decimals,
 *    dot separator, no thousands grouping, regardless of locale.
 *  - The invoice number is exactly 16 characters (3-letter series + 4-digit year
 *    + 9-digit sequence). Anything else is rejected outright.
 *  - `schemeID` on the party identifier is "VKN" for a legal entity and "TCKN"
 *    for an individual, decided by length.
 *
 * Signing (XAdES) and the envelope are the integrator's job — they hold the
 * financial seal. This produces the unsigned document.
 */
import type { UblInvoice, UblLine, UblParty } from "./types";

/** Escape text for XML content and attribute values. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Fixed 2-decimal, dot-separated, no grouping.
 *
 * `toFixed` is locale-independent, unlike `toLocaleString` — which would emit
 * "1.234,56" on a Turkish system and be rejected.
 */
function amount(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** Quantities allow more precision than money. */
function qty(value: number): string {
  return String(Math.round(value * 1_000_000) / 1_000_000);
}

function el(tag: string, value: unknown, attrs?: Record<string, string>): string {
  const a = attrs
    ? Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join("")
    : "";
  return `<${tag}${a}>${esc(value)}</${tag}>`;
}

/** VKN (10 digits) identifies a legal entity; TCKN (11) an individual. */
function schemeIdFor(taxNumber: string): "VKN" | "TCKN" {
  return taxNumber.trim().length === 11 ? "TCKN" : "VKN";
}

/**
 * The statutory invoice number format.
 *
 * 3 uppercase letters (the series), 4-digit year, 9-digit sequence — 16
 * characters in total. Checked here rather than at the integrator so the failure
 * names the actual problem instead of arriving as a schema rejection.
 */
const INVOICE_ID_PATTERN = /^[A-Z]{3}\d{4}\d{9}$/;

export function isValidEInvoiceId(id: string): boolean {
  return INVOICE_ID_PATTERN.test(id);
}

/** Build a conforming number from its parts. */
export function buildEInvoiceId(series: string, year: number, sequence: number): string {
  const s = series.toUpperCase().slice(0, 3).padEnd(3, "X");
  return `${s}${String(year).padStart(4, "0")}${String(sequence).padStart(9, "0")}`;
}

function partyXml(tag: string, party: UblParty): string {
  const scheme = schemeIdFor(party.taxNumber);
  const parts: string[] = [];
  parts.push(`<${tag}><cac:Party>`);
  if (party.website) parts.push(el("cbc:WebsiteURI", party.website));
  parts.push(
    `<cac:PartyIdentification>${el("cbc:ID", party.taxNumber.trim(), { schemeID: scheme })}</cac:PartyIdentification>`,
  );
  parts.push(`<cac:PartyName>${el("cbc:Name", party.name)}</cac:PartyName>`);

  // PostalAddress is mandatory; its children are individually optional but
  // ordered. CityName is the il, CitySubdivisionName the ilçe.
  parts.push("<cac:PostalAddress>");
  if (party.street) parts.push(el("cbc:StreetName", party.street));
  if (party.district) parts.push(el("cbc:CitySubdivisionName", party.district));
  if (party.city) parts.push(el("cbc:CityName", party.city));
  if (party.postalCode) parts.push(el("cbc:PostalZone", party.postalCode));
  parts.push(`<cac:Country>${el("cbc:Name", party.country ?? "Türkiye")}</cac:Country>`);
  parts.push("</cac:PostalAddress>");

  // The tax office goes in TaxScheme/Name. An individual (TCKN) has none, and
  // emitting an empty one is invalid — so it is omitted entirely.
  if (scheme === "VKN") {
    parts.push(
      `<cac:PartyTaxScheme><cac:TaxScheme>${el("cbc:Name", party.taxOffice ?? "")}</cac:TaxScheme></cac:PartyTaxScheme>`,
    );
  }

  if (party.phone || party.email) {
    parts.push("<cac:Contact>");
    if (party.phone) parts.push(el("cbc:Telephone", party.phone));
    if (party.email) parts.push(el("cbc:ElectronicMail", party.email));
    parts.push("</cac:Contact>");
  }
  parts.push(`</cac:Party></${tag}>`);
  return parts.join("");
}

function lineXml(line: UblLine, currency: string): string {
  return [
    "<cac:InvoiceLine>",
    el("cbc:ID", line.index),
    el("cbc:InvoicedQuantity", qty(line.quantity), { unitCode: line.unitCode ?? "C62" }),
    el("cbc:LineExtensionAmount", amount(line.lineAmount), { currencyID: currency }),
    "<cac:TaxTotal>",
    el("cbc:TaxAmount", amount(line.vatAmount), { currencyID: currency }),
    "<cac:TaxSubtotal>",
    el("cbc:TaxableAmount", amount(line.lineAmount), { currencyID: currency }),
    el("cbc:TaxAmount", amount(line.vatAmount), { currencyID: currency }),
    el("cbc:Percent", line.vatRate),
    // 0015 is the KDV tax type code.
    `<cac:TaxCategory><cac:TaxScheme>${el("cbc:Name", "KDV")}${el("cbc:TaxTypeCode", "0015")}</cac:TaxScheme></cac:TaxCategory>`,
    "</cac:TaxSubtotal>",
    "</cac:TaxTotal>",
    `<cac:Item>${el("cbc:Name", line.name)}</cac:Item>`,
    `<cac:Price>${el("cbc:PriceAmount", amount(line.unitPrice), { currencyID: currency })}</cac:Price>`,
    "</cac:InvoiceLine>",
  ].join("");
}

/**
 * Serialise an invoice to UBL-TR 1.2.
 *
 * Returns the unsigned document. The integrator adds the XAdES signature and the
 * transport envelope, because the seal is theirs.
 */
export function buildInvoiceXml(invoice: UblInvoice): string {
  if (!isValidEInvoiceId(invoice.id)) {
    throw new Error(
      `invalid e-invoice number "${invoice.id}": expected 3 letters + 4-digit year + 9-digit sequence (16 chars)`,
    );
  }

  const c = invoice.currencyCode;
  const parts: string[] = [];

  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
      ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
      ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
      ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">',
  );
  // The signature lands in this extension slot; the integrator fills it.
  parts.push("<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>");

  parts.push(el("cbc:UBLVersionID", "2.1"));
  parts.push(el("cbc:CustomizationID", "TR1.2"));
  parts.push(el("cbc:ProfileID", invoice.profile));
  parts.push(el("cbc:ID", invoice.id));
  parts.push(el("cbc:CopyIndicator", "false"));
  parts.push(el("cbc:UUID", invoice.uuid));
  parts.push(el("cbc:IssueDate", invoice.issueDate));
  parts.push(el("cbc:IssueTime", invoice.issueTime));
  parts.push(el("cbc:InvoiceTypeCode", invoice.typeCode));
  for (const note of invoice.notes ?? []) parts.push(el("cbc:Note", note));
  parts.push(el("cbc:DocumentCurrencyCode", c));
  parts.push(el("cbc:LineCountNumeric", invoice.lines.length));

  parts.push(partyXml("cac:AccountingSupplierParty", invoice.supplier));
  parts.push(partyXml("cac:AccountingCustomerParty", invoice.customer));

  // Document-level KDV, grouped by rate: one TaxSubtotal per distinct rate, as
  // the schema expects — not one per line.
  const byRate = new Map<number, { base: number; tax: number }>();
  for (const line of invoice.lines) {
    const bucket = byRate.get(line.vatRate) ?? { base: 0, tax: 0 };
    bucket.base += line.lineAmount;
    bucket.tax += line.vatAmount;
    byRate.set(line.vatRate, bucket);
  }
  parts.push("<cac:TaxTotal>");
  parts.push(el("cbc:TaxAmount", amount(invoice.vatTotal), { currencyID: c }));
  for (const [rate, bucket] of [...byRate].sort((a, b) => a[0] - b[0])) {
    parts.push("<cac:TaxSubtotal>");
    parts.push(el("cbc:TaxableAmount", amount(bucket.base), { currencyID: c }));
    parts.push(el("cbc:TaxAmount", amount(bucket.tax), { currencyID: c }));
    parts.push(el("cbc:Percent", rate));
    parts.push(
      `<cac:TaxCategory><cac:TaxScheme>${el("cbc:Name", "KDV")}${el("cbc:TaxTypeCode", "0015")}</cac:TaxScheme></cac:TaxCategory>`,
    );
    parts.push("</cac:TaxSubtotal>");
  }
  parts.push("</cac:TaxTotal>");

  // Tevkifat is a SEPARATE TaxTotal with tax type 9015 — not a modification of
  // the KDV block. The withheld amount is what the buyer remits directly.
  if (invoice.withholdingAmount && invoice.withholdingAmount > 0) {
    const ratio = invoice.withholdingRatioTenths ?? 0;
    parts.push("<cac:WithholdingTaxTotal>");
    parts.push(el("cbc:TaxAmount", amount(invoice.withholdingAmount), { currencyID: c }));
    parts.push("<cac:TaxSubtotal>");
    parts.push(el("cbc:TaxableAmount", amount(invoice.vatTotal), { currencyID: c }));
    parts.push(el("cbc:TaxAmount", amount(invoice.withholdingAmount), { currencyID: c }));
    parts.push(el("cbc:Percent", (ratio * 10).toFixed(0)));
    parts.push(
      `<cac:TaxCategory><cac:TaxScheme>${el("cbc:Name", "KDV TEVKIFATI")}${el("cbc:TaxTypeCode", "9015")}</cac:TaxScheme></cac:TaxCategory>`,
    );
    parts.push("</cac:TaxSubtotal>");
    parts.push("</cac:WithholdingTaxTotal>");
  }

  parts.push("<cac:LegalMonetaryTotal>");
  parts.push(el("cbc:LineExtensionAmount", amount(invoice.lineExtensionAmount), { currencyID: c }));
  parts.push(el("cbc:TaxExclusiveAmount", amount(invoice.taxExclusiveAmount), { currencyID: c }));
  parts.push(el("cbc:TaxInclusiveAmount", amount(invoice.taxInclusiveAmount), { currencyID: c }));
  parts.push(el("cbc:PayableAmount", amount(invoice.payableAmount), { currencyID: c }));
  parts.push("</cac:LegalMonetaryTotal>");

  for (const line of invoice.lines) parts.push(lineXml(line, c));

  parts.push("</Invoice>");
  return parts.join("");
}
