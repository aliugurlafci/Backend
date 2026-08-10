/**
 * SAP PI/PO wire format — XML and JSON over the same canonical message.
 *
 * PI/PO channels are configured per interface, and which encoding a given
 * channel uses is somebody else's decision: the same interface is often JSON in
 * one landscape and XML in another, and it changes when the channel is
 * reconfigured rather than when our code changes. So the message is defined
 * once, canonically, and each encoding is a projection of it. Nothing above this
 * module knows or cares which one is on the wire.
 *
 * XML is not "JSON with angle brackets", and the differences are exactly where
 * integrations fail in production:
 *
 *  - **A repeated element is an array; a single one is not.** An invoice with
 *    two lines parses as a list, the same invoice with one line parses as a bare
 *    object, and the code that loops over it silently processes nothing. This is
 *    the single most common XML bug, so repeating elements are DECLARED per
 *    message type rather than inferred from what happened to arrive.
 *  - **Everything is text.** `<Qty>3</Qty>` is the string "3" where JSON gives
 *    the number 3. Left alone, the same document produces different types
 *    depending on the encoding, and arithmetic downstream starts concatenating.
 *  - **Namespaces.** PI/PO commonly qualifies elements (`ns0:Invoice`). The
 *    prefix is transport detail and is stripped, so a channel reconfigured to
 *    add or drop a namespace does not break the mapping.
 *  - **An empty element is not null.** `<Notes/>` parses as `""`; treated as a
 *    value it overwrites a real note with an empty string.
 */
import { XMLBuilder, XMLParser } from "fast-xml-parser";

export type ErpFormat = "xml" | "json";

export interface ErpHeader {
  /** Ours when we send; PI/PO's when we receive. The idempotency key either way. */
  messageId: string;
  /** e.g. `Invoice.Post`, `Product.Upsert` — the interface being invoked. */
  messageType: string;
  sentAt: string;
  /** `AULA` or `SAP`, so a message echoed back is recognisable. */
  source: string;
}

export interface ErpEnvelope {
  header: ErpHeader;
  payload: Record<string, unknown>;
}

/** Root element name on the wire. */
const ROOT = "AulaMessage";

/**
 * Payload paths that are lists, per message type.
 *
 * The reason this is declared and not inferred: with one line item, XML gives an
 * object; with two, an array. Inferring from the document means a one-line
 * invoice and a two-line invoice take different code paths — and the one-line
 * case is the one that reaches production untested.
 */
const REPEATING: Record<string, string[]> = {
  "Invoice.Post": ["Lines.Line"],
  "StockMovement.Post": ["Movements.Movement"],
  "Product.Upsert": [],
  "Partner.Upsert": [],
  "Payment.Post": [],
};

/** Every list path we know about, for parsing a message type we do not. */
const ALL_REPEATING = [...new Set(Object.values(REPEATING).flat())];

const parser = new XMLParser({
  ignoreAttributes: true,
  // Text stays text here; typing happens in `coerce`, so XML and JSON agree.
  parseTagValue: false,
  trimValues: true,
  // `ns0:Invoice` → `Invoice`. The prefix belongs to the channel, not the data.
  transformTagName: (tag) => tag.replace(/^[^:]+:/, ""),
});

const builder = new XMLBuilder({
  ignoreAttributes: true,
  format: true,
  indentBy: "  ",
  suppressEmptyNode: false,
});

/**
 * Walk to a dotted path, creating whatever is missing on the way.
 *
 * Creating rather than giving up: `<Lines></Lines>` — an invoice with no lines —
 * parses as an empty element, which coercion turns into null, so the path
 * `Lines.Line` cannot be walked at all. Bailing out there leaves `Lines: null`
 * and the caller crashes reading `.Line` off it. A declared list path is a
 * GUARANTEE about the shape, which is the entire reason it is declared, so the
 * shape is made to exist.
 *
 * Only ever called for declared paths, so this cannot invent structure from a
 * message that merely happens to resemble one.
 */
function ensurePath(payload: Record<string, unknown>, path: string): { parent: Record<string, unknown>; key: string } | null {
  const parts = path.split(".");
  let node = payload;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) return null;
    const next = node[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      // Absent, or an empty element that became null — stand the container up.
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  const key = parts[parts.length - 1];
  return key ? { parent: node, key } : null;
}

/** Force the declared list paths to be arrays, however many elements arrived. */
function normaliseLists(payload: Record<string, unknown>, messageType: string): void {
  const paths = REPEATING[messageType] ?? ALL_REPEATING;
  for (const path of paths) {
    const found = ensurePath(payload, path);
    if (!found) continue;
    const value = found.parent[found.key];
    if (value === undefined || value === null || value === "") {
      found.parent[found.key] = [];
    } else if (!Array.isArray(value)) {
      found.parent[found.key] = [value];
    }
  }
}

/**
 * Give an XML-parsed value the type JSON would have given it.
 *
 * Only where it is unambiguous. "0042" stays a string because a SAP material
 * number is zero-padded and turning it into 42 would break every lookup — the
 * leading zero IS the identifier. Likewise a value that merely looks numeric but
 * does not round-trip is left alone.
 */
function coerce(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (s === "") return null; // `<Notes/>` is absence, not an empty value
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // Round-trip check: rejects "0042", "1e5" and anything that would come back
    // looking different from what SAP sent.
    if (Number.isFinite(n) && String(n) === s) return n;
  }
  return s;
}

function coerceDeep(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(coerceDeep);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = coerceDeep(v);
    return out;
  }
  return coerce(node);
}

/** Canonical envelope → the wire, in the requested encoding. */
export function encode(envelope: ErpEnvelope, format: ErpFormat): string {
  if (format === "json") return JSON.stringify(toWire(envelope), null, 2);
  return builder.build({ [ROOT]: toWire(envelope) });
}

/** The shape both encodings share — PascalCase, as SAP interfaces are named. */
function toWire(envelope: ErpEnvelope): Record<string, unknown> {
  return {
    Header: {
      MessageId: envelope.header.messageId,
      MessageType: envelope.header.messageType,
      SentAt: envelope.header.sentAt,
      Source: envelope.header.source,
    },
    Payload: envelope.payload,
  };
}

export class ErpDecodeError extends Error {}

/**
 * The wire → a canonical envelope.
 *
 * The format is detected rather than declared, because PI/PO sets the
 * content-type from the channel configuration and gets it wrong often enough
 * that trusting it means rejecting valid messages. A leading `<` is XML; a
 * leading `{` is JSON. Nothing else is either.
 */
export function decode(body: string, contentType?: string): { envelope: ErpEnvelope; format: ErpFormat } {
  const text = body.trim();
  if (!text) throw new ErpDecodeError("empty message body");

  const looksXml = text.startsWith("<");
  const looksJson = text.startsWith("{");
  if (!looksXml && !looksJson) {
    throw new ErpDecodeError(`unrecognised message format (content-type: ${contentType ?? "none"})`);
  }

  let wire: Record<string, unknown>;
  if (looksJson) {
    try {
      wire = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new ErpDecodeError(`malformed JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    let parsed: Record<string, unknown>;
    try {
      parsed = parser.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new ErpDecodeError(`malformed XML: ${e instanceof Error ? e.message : String(e)}`);
    }
    // PI/PO may or may not wrap in a SOAP envelope depending on the adapter, and
    // the same interface can arrive both ways from different channels.
    const unwrapped = unwrapSoap(parsed);
    const root = unwrapped[ROOT] ?? unwrapped[Object.keys(unwrapped)[0] ?? ""];
    if (!root || typeof root !== "object") throw new ErpDecodeError("XML has no message root");
    wire = root as Record<string, unknown>;
  }

  const header = (wire.Header ?? {}) as Record<string, unknown>;
  const messageType = String(header.MessageType ?? "").trim();
  if (!messageType) throw new ErpDecodeError("message has no MessageType");
  const messageId = String(header.MessageId ?? "").trim();
  if (!messageId) throw new ErpDecodeError("message has no MessageId");

  const payload = (wire.Payload ?? {}) as Record<string, unknown>;
  const canonical = looksJson ? payload : (coerceDeep(payload) as Record<string, unknown>);
  normaliseLists(canonical, messageType);

  return {
    format: looksJson ? "json" : "xml",
    envelope: {
      header: {
        messageId,
        messageType,
        sentAt: String(header.SentAt ?? "").trim(),
        source: String(header.Source ?? "SAP").trim(),
      },
      payload: canonical,
    },
  };
}

/** Strip a SOAP envelope if there is one; return the document otherwise. */
function unwrapSoap(parsed: Record<string, unknown>): Record<string, unknown> {
  const envelope = parsed.Envelope as Record<string, unknown> | undefined;
  if (!envelope) return parsed;
  const body = envelope.Body as Record<string, unknown> | undefined;
  return body ?? parsed;
}

/**
 * An acknowledgement, in the encoding the request arrived in.
 *
 * PI/PO correlates the reply to the request by its message id, and an
 * acknowledgement in the wrong encoding is a channel error on their side that
 * shows up as our interface being down.
 */
export function ack(messageId: string, format: ErpFormat, status: "ok" | "error", detail?: string): string {
  const wire = {
    Header: { MessageId: messageId, MessageType: "Ack", SentAt: new Date().toISOString(), Source: "AULA" },
    Payload: { Status: status, ...(detail ? { Detail: detail } : {}) },
  };
  return format === "json" ? JSON.stringify(wire, null, 2) : builder.build({ [ROOT]: wire });
}
