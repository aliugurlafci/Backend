/**
 * UBL-TR 1.2 serialisation.
 *
 * The document is the part that does not vary between integrators, so it is the
 * part worth pinning. Every assertion here corresponds to something the GİB
 * rejects outright — and a rejection arrives days later, detached from whatever
 * change caused it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEInvoiceId, buildInvoiceXml, isValidEInvoiceId } from "@/lib/einvoice/ubl";
import type { UblInvoice } from "@/lib/einvoice/types";

function sample(overrides: Partial<UblInvoice> = {}): UblInvoice {
  return {
    id: "AUL2026000000001",
    uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    issueDate: "2026-08-08",
    issueTime: "14:30:00",
    profile: "TEMELFATURA",
    typeCode: "SATIS",
    currencyCode: "TRY",
    supplier: {
      name: "Uğur Corp A.Ş.",
      taxNumber: "1234567890",
      taxOffice: "Kadıköy",
      city: "İstanbul",
      district: "Kadıköy",
    },
    customer: { name: "Müşteri Ltd. Şti.", taxNumber: "9876543210", taxOffice: "Beşiktaş" },
    lines: [
      { index: 1, name: "Hizmet", quantity: 1, unitPrice: 10_000, lineAmount: 10_000, vatRate: 20, vatAmount: 2_000 },
    ],
    lineExtensionAmount: 10_000,
    taxExclusiveAmount: 10_000,
    taxInclusiveAmount: 12_000,
    payableAmount: 12_000,
    vatTotal: 2_000,
    ...overrides,
  };
}

// ---- the invoice number format ---------------------------------------------

test("the statutory 16-character number is accepted", () => {
  assert.equal(isValidEInvoiceId("AUL2026000000001"), true);
});

test("anything but 3 letters + year + 9 digits is rejected", () => {
  assert.equal(isValidEInvoiceId("INV-0001"), false, "our internal numbering is not valid here");
  assert.equal(isValidEInvoiceId("AU2026000000001"), false, "two-letter series");
  assert.equal(isValidEInvoiceId("AUL202600000001"), false, "one digit short");
  assert.equal(isValidEInvoiceId("aul2026000000001"), false, "lowercase series");
});

test("buildEInvoiceId pads the parts to the required widths", () => {
  assert.equal(buildEInvoiceId("AUL", 2026, 1), "AUL2026000000001");
  assert.equal(buildEInvoiceId("aul", 2026, 123_456_789), "AUL2026123456789");
  assert.equal(buildEInvoiceId("A", 2026, 1), "AXX2026000000001", "a short series is padded");
});

test("building refuses an invoice whose number is not conforming", () => {
  assert.throws(() => buildInvoiceXml(sample({ id: "INV-0001" })), /invalid e-invoice number/);
});

// ---- document shape ---------------------------------------------------------

test("the UBL-TR header identifies the customisation and profile", () => {
  const xml = buildInvoiceXml(sample());
  assert.match(xml, /<cbc:UBLVersionID>2\.1<\/cbc:UBLVersionID>/);
  assert.match(xml, /<cbc:CustomizationID>TR1\.2<\/cbc:CustomizationID>/);
  assert.match(xml, /<cbc:ProfileID>TEMELFATURA<\/cbc:ProfileID>/);
  assert.match(xml, /<cbc:UUID>3f2504e0-4f89-11d3-9a0c-0305e82c3301<\/cbc:UUID>/);
});

test("elements appear in schema order", () => {
  // UBL is a sequence: IssueTime after IssueDate, TypeCode after both. Present
  // but misordered is still invalid, which is why order is asserted, not just
  // presence.
  const xml = buildInvoiceXml(sample());
  const order = ["cbc:ID", "cbc:UUID", "cbc:IssueDate", "cbc:IssueTime", "cbc:InvoiceTypeCode", "cbc:DocumentCurrencyCode"];
  let cursor = -1;
  for (const tag of order) {
    const at = xml.indexOf(`<${tag}>`);
    assert.ok(at > cursor, `${tag} is out of order`);
    cursor = at;
  }
});

test("a legal entity is identified by VKN, an individual by TCKN", () => {
  const corporate = buildInvoiceXml(sample());
  assert.match(corporate, /schemeID="VKN">9876543210</);

  const individual = buildInvoiceXml(
    sample({ customer: { name: "Ahmet Yılmaz", taxNumber: "12345678901" } }),
  );
  assert.match(individual, /schemeID="TCKN">12345678901</);
  // An individual has no tax office; an empty one would be invalid.
  const customerBlock = individual.slice(individual.indexOf("AccountingCustomerParty"));
  assert.ok(!customerBlock.includes("PartyTaxScheme"), "TCKN parties carry no tax office");
});

test("amounts are fixed 2-decimal with a dot, whatever the locale", () => {
  const xml = buildInvoiceXml(sample({ payableAmount: 1234.5, taxInclusiveAmount: 1234.5 }));
  assert.match(xml, /<cbc:PayableAmount currencyID="TRY">1234\.50<\/cbc:PayableAmount>/);
  assert.ok(!xml.includes("1.234,50"), "must not use Turkish digit grouping");
});

test("VAT is grouped by rate, not emitted per line", () => {
  const xml = buildInvoiceXml(
    sample({
      lines: [
        { index: 1, name: "A", quantity: 1, unitPrice: 100, lineAmount: 100, vatRate: 20, vatAmount: 20 },
        { index: 2, name: "B", quantity: 1, unitPrice: 100, lineAmount: 100, vatRate: 20, vatAmount: 20 },
        { index: 3, name: "C", quantity: 1, unitPrice: 100, lineAmount: 100, vatRate: 10, vatAmount: 10 },
      ],
      vatTotal: 50,
    }),
  );
  const docTax = xml.slice(xml.indexOf("<cac:TaxTotal>"), xml.indexOf("<cac:LegalMonetaryTotal>"));
  const subtotals = docTax.match(/<cac:TaxSubtotal>/g) ?? [];
  assert.equal(subtotals.length, 2, "two distinct rates → two subtotals");
  assert.match(docTax, /<cbc:TaxableAmount currencyID="TRY">200\.00<\/cbc:TaxableAmount>/, "the 20% lines are summed");
});

test("tevkifat is a separate withholding block, not a changed KDV block", () => {
  const xml = buildInvoiceXml(
    sample({ typeCode: "TEVKIFAT", withholdingAmount: 1_000, withholdingRatioTenths: 5, payableAmount: 11_000 }),
  );
  assert.match(xml, /<cac:WithholdingTaxTotal>/);
  assert.match(xml, /<cbc:TaxTypeCode>9015<\/cbc:TaxTypeCode>/, "9015 is the withholding code");
  assert.match(xml, /<cbc:TaxTypeCode>0015<\/cbc:TaxTypeCode>/, "the KDV block is still 0015");
  assert.match(xml, /<cbc:PayableAmount currencyID="TRY">11000\.00</, "the buyer pays the base plus collectible VAT");
});

test("no withholding block when there is no tevkifat", () => {
  assert.ok(!buildInvoiceXml(sample()).includes("WithholdingTaxTotal"));
});

test("text is XML-escaped", () => {
  const xml = buildInvoiceXml(sample({ customer: { name: 'Acme & Co <"test">', taxNumber: "9876543210" } }));
  assert.match(xml, /Acme &amp; Co &lt;&quot;test&quot;&gt;/);
  assert.ok(!xml.includes("<\"test\">"), "raw markup must not reach the document");
});

test("line count matches the lines emitted", () => {
  const xml = buildInvoiceXml(
    sample({
      lines: [
        { index: 1, name: "A", quantity: 2, unitPrice: 50, lineAmount: 100, vatRate: 20, vatAmount: 20 },
        { index: 2, name: "B", quantity: 1, unitPrice: 100, lineAmount: 100, vatRate: 20, vatAmount: 20 },
      ],
    }),
  );
  assert.match(xml, /<cbc:LineCountNumeric>2<\/cbc:LineCountNumeric>/);
  assert.equal((xml.match(/<cac:InvoiceLine>/g) ?? []).length, 2);
});
