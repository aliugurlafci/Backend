/**
 * SAP PI/PO wire format.
 *
 * A PI/PO channel's encoding is somebody else's configuration: the same
 * interface is JSON in one landscape and XML in another, and it changes when the
 * channel is reconfigured rather than when our code is. So both encodings have
 * to produce the same canonical message — and the ways XML differs from JSON are
 * exactly where integrations fail, silently, in production.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { encode, decode, ack, ErpDecodeError } = await import("@/lib/erp/codec");

const envelope = {
  header: { messageId: "MSG-1", messageType: "Invoice.Post", sentAt: "2026-08-09T10:00:00.000Z", source: "AULA" },
  payload: { DocumentNumber: "INV-0001", Total: 1250.5, Lines: { Line: [{ Sku: "A", Qty: 2 }, { Sku: "B", Qty: 1 }] } },
};

// ---- round trips -----------------------------------------------------------

test("a message survives a round trip in both encodings, identically", () => {
  // The property the whole design rests on: which encoding a channel uses must
  // not change what the application sees.
  for (const format of ["xml", "json"] as const) {
    const { envelope: back } = decode(encode(envelope, format));
    assert.deepEqual(back.header, envelope.header, format);
    assert.deepEqual(back.payload, envelope.payload, format);
  }
});

test("XML and JSON of the same message decode to the same thing", () => {
  const fromXml = decode(encode(envelope, "xml")).envelope;
  const fromJson = decode(encode(envelope, "json")).envelope;
  assert.deepEqual(fromXml, fromJson);
});

// ---- the XML/JSON asymmetries ---------------------------------------------

test("ONE line item is still a list", () => {
  // The single most common XML integration bug. With two lines the parser gives
  // an array; with one it gives a bare object, and the loop over it processes
  // nothing — on the invoice that reaches production untested.
  const xml = `<AulaMessage><Header><MessageId>M</MessageId><MessageType>Invoice.Post</MessageType></Header>
    <Payload><Lines><Line><Sku>ONLY</Sku><Qty>5</Qty></Line></Lines></Payload></AulaMessage>`;
  const { envelope: e } = decode(xml);
  const lines = (e.payload.Lines as { Line: unknown[] }).Line;
  assert.ok(Array.isArray(lines), "a single element still arrives as an array");
  assert.equal(lines.length, 1);
});

test("no line items at all is an empty list, not a missing key", () => {
  const xml = `<AulaMessage><Header><MessageId>M</MessageId><MessageType>Invoice.Post</MessageType></Header>
    <Payload><Lines></Lines></Payload></AulaMessage>`;
  const lines = (decode(xml).envelope.payload.Lines as { Line: unknown[] }).Line;
  assert.deepEqual(lines, []);
});

test("numbers and booleans come back typed, not as text", () => {
  // `<Qty>3</Qty>` is the string "3" to an XML parser. Left alone, arithmetic
  // downstream starts concatenating and a total of 2 and 3 becomes "23".
  const xml = `<AulaMessage><Header><MessageId>M</MessageId><MessageType>Product.Upsert</MessageType></Header>
    <Payload><Qty>3</Qty><Price>19.9</Price><Active>true</Active><Name>Vida</Name></Payload></AulaMessage>`;
  const p = decode(xml).envelope.payload;
  assert.strictEqual(p.Qty, 3);
  assert.strictEqual(p.Price, 19.9);
  assert.strictEqual(p.Active, true);
  assert.strictEqual(p.Name, "Vida");
});

test("a zero-padded SAP key stays a string", () => {
  // THE reason coercion is round-trip checked rather than eager. A material
  // number is zero-padded and the padding IS the identifier — turning
  // "000000000000001234" into 1234 breaks every lookup against SAP.
  const xml = `<AulaMessage><Header><MessageId>M</MessageId><MessageType>Product.Upsert</MessageType></Header>
    <Payload><Matnr>000000000000001234</Matnr><Exp>1e5</Exp></Payload></AulaMessage>`;
  const p = decode(xml).envelope.payload;
  assert.strictEqual(p.Matnr, "000000000000001234");
  assert.strictEqual(p.Exp, "1e5", "and anything else that would not come back looking the same");
});

test("an empty element is absence, not an empty value", () => {
  // `<Notes/>` parses as "". Treated as a value it overwrites a real note with
  // nothing, which is a data loss nobody reports because nothing errors.
  const xml = `<AulaMessage><Header><MessageId>M</MessageId><MessageType>Product.Upsert</MessageType></Header>
    <Payload><Notes/><Sku>A</Sku></Payload></AulaMessage>`;
  assert.strictEqual(decode(xml).envelope.payload.Notes, null);
});

test("namespace prefixes are stripped", () => {
  // PI/PO qualifies elements according to the channel's configuration. The
  // prefix is transport detail; a channel reconfigured to add one must not
  // break the mapping.
  const xml = `<ns0:AulaMessage xmlns:ns0="urn:aula"><ns0:Header><ns0:MessageId>M</ns0:MessageId>
    <ns0:MessageType>Product.Upsert</ns0:MessageType></ns0:Header>
    <ns0:Payload><ns0:Sku>ABC</ns0:Sku></ns0:Payload></ns0:AulaMessage>`;
  const { envelope: e } = decode(xml);
  assert.equal(e.header.messageType, "Product.Upsert");
  assert.equal(e.payload.Sku, "ABC");
});

test("a SOAP envelope is unwrapped", () => {
  // Whether the interface arrives wrapped depends on the adapter, and the same
  // interface can come both ways from different channels.
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
    <AulaMessage><Header><MessageId>M</MessageId><MessageType>Payment.Post</MessageType></Header>
    <Payload><Amount>100</Amount></Payload></AulaMessage>
  </soap:Body></soap:Envelope>`;
  const { envelope: e } = decode(xml);
  assert.equal(e.header.messageType, "Payment.Post");
  assert.equal(e.payload.Amount, 100);
});

test("Turkish characters survive both encodings", () => {
  // A product catalogue is full of them; a codec that only round-trips ASCII
  // looks correct until the first real message.
  const turkish = { ...envelope, payload: { Name: "Somun Anahtarı — 12 mm, çelik", City: "İstanbul" } };
  for (const format of ["xml", "json"] as const) {
    assert.equal(decode(encode(turkish, format)).envelope.payload.Name, "Somun Anahtarı — 12 mm, çelik", format);
    assert.equal(decode(encode(turkish, format)).envelope.payload.City, "İstanbul", format);
  }
});

// ---- format detection and refusal ------------------------------------------

test("the format is detected from the body, not the content-type", () => {
  // PI/PO sets the content-type from the channel configuration and gets it
  // wrong often enough that trusting it means rejecting valid messages.
  assert.equal(decode(encode(envelope, "xml"), "application/json").format, "xml");
  assert.equal(decode(encode(envelope, "json"), "text/xml").format, "json");
});

test("a message with no type or no id is refused", () => {
  // Both are required to do anything at all: the type says which interface this
  // is, the id is what makes redelivery safe. Accepting either as blank means
  // acknowledging a message that can never be applied.
  const noType = `<AulaMessage><Header><MessageId>M</MessageId></Header><Payload/></AulaMessage>`;
  const noId = `<AulaMessage><Header><MessageType>Payment.Post</MessageType></Header><Payload/></AulaMessage>`;
  assert.throws(() => decode(noType), ErpDecodeError);
  assert.throws(() => decode(noId), ErpDecodeError);
});

test("garbage is refused rather than half-parsed", () => {
  assert.throws(() => decode(""), ErpDecodeError);
  assert.throws(() => decode("not xml and not json"), ErpDecodeError);
  assert.throws(() => decode("{ broken json"), ErpDecodeError);
});

// ---- acknowledgement -------------------------------------------------------

test("the acknowledgement echoes the message id in the request's own encoding", () => {
  // PI/PO correlates the reply by message id, and a reply in the wrong encoding
  // is a channel error on their side that surfaces as our interface being down.
  const xmlAck = ack("MSG-9", "xml", "ok");
  assert.ok(xmlAck.includes("<MessageId>MSG-9</MessageId>"));
  const jsonAck = JSON.parse(ack("MSG-9", "json", "error", "no such product")) as {
    Header: { MessageId: string }; Payload: { Status: string; Detail: string };
  };
  assert.equal(jsonAck.Header.MessageId, "MSG-9");
  assert.equal(jsonAck.Payload.Status, "error");
  assert.equal(jsonAck.Payload.Detail, "no such product");
});
