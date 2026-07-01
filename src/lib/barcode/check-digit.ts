/**
 * Barcode helpers — check-digit math for the GS1 retail symbologies (EAN-13,
 * UPC-A) plus value validation and internal-code generation. Rendering happens
 * client-side (jsbarcode / qrcode.react); this module only deals with the
 * encoded *value* so the API can validate and the POS can normalise scans.
 */

export type BarcodeType = "ean13" | "upc" | "code128" | "qr";

const digitsOnly = (s: string): boolean => /^[0-9]+$/.test(s);

/** Modulo-10 check digit over a digit string using GS1 weighting (3-1-3-1…
 *  applied right-to-left over the payload). Works for both EAN-13 (12-digit
 *  payload) and UPC-A (11-digit payload). */
function gtinCheckDigit(payload: string): number {
  let sum = 0;
  // Right-most payload digit gets weight 3, then alternate.
  for (let i = payload.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(payload[i]) * w;
  }
  return (10 - (sum % 10)) % 10;
}

/** Append the EAN-13 check digit to a 12-digit payload. */
export function buildEan13(payload12: string): string {
  if (payload12.length !== 12 || !digitsOnly(payload12)) {
    throw new Error("EAN-13 payload must be exactly 12 digits");
  }
  return payload12 + String(gtinCheckDigit(payload12));
}

/** Append the UPC-A check digit to an 11-digit payload. */
export function buildUpcA(payload11: string): string {
  if (payload11.length !== 11 || !digitsOnly(payload11)) {
    throw new Error("UPC-A payload must be exactly 11 digits");
  }
  return payload11 + String(gtinCheckDigit(payload11));
}

/** Validate a fully-formed barcode value against its declared symbology. */
export function isValidBarcode(value: string, type: BarcodeType): boolean {
  const v = (value ?? "").trim();
  if (!v) return false;
  switch (type) {
    case "ean13":
      return v.length === 13 && digitsOnly(v) && Number(v[12]) === gtinCheckDigit(v.slice(0, 12));
    case "upc":
      return v.length === 12 && digitsOnly(v) && Number(v[11]) === gtinCheckDigit(v.slice(0, 11));
    case "code128":
      // Code128 encodes ASCII 0–127; keep it printable and bounded.
      return v.length >= 1 && v.length <= 64 && /^[\x20-\x7e]+$/.test(v);
    case "qr":
      return v.length >= 1 && v.length <= 2048;
    default:
      return false;
  }
}

/** Reason string for an invalid barcode (for API error messages), or null if ok. */
export function barcodeError(value: string, type: BarcodeType): string | null {
  if (isValidBarcode(value, type)) return null;
  switch (type) {
    case "ean13":
      return "EAN-13 must be 13 digits with a valid check digit";
    case "upc":
      return "UPC-A must be 12 digits with a valid check digit";
    case "code128":
      return "Code 128 must be 1–64 printable ASCII characters";
    case "qr":
      return "QR payload must be 1–2048 characters";
    default:
      return "Unknown barcode type";
  }
}

/**
 * Deterministic internal EAN-13 from a sequence number, using GS1 restricted
 * in-store prefix "20" (reserved for internal use, never collides with real
 * GTINs). `seq` provides the 10 middle digits.
 */
export function internalEan13(seq: number): string {
  const body = String(Math.abs(Math.trunc(seq)) % 10_000_000_000).padStart(10, "0");
  return buildEan13("20" + body);
}

/** Normalise a scanned code: trim surrounding whitespace. Equivalence between
 *  the retail symbologies (UPC-A vs EAN-13, UPC-E) is handled by
 *  {@link barcodeCandidates} rather than by mutating the value here. */
export function normalizeScan(raw: string): string {
  return (raw ?? "").trim();
}

/**
 * Expand an 8-digit UPC-E value (number-system + 6 data + check) to its 12-digit
 * UPC-A form. Returns null if the value is not a well-formed UPC-E. The 6 data
 * digits select one of four zero-fill expansions via their last digit.
 */
function expandUpcE(value: string): string | null {
  if (value.length !== 8 || !digitsOnly(value)) return null;
  const ns = value[0];
  if (ns !== "0" && ns !== "1") return null; // UPC-E only carries number system 0/1
  const d = value.slice(1, 7); // X1..X6
  const last = d[5];
  let body: string; // the 10 manufacturer+item digits
  switch (last) {
    case "0":
    case "1":
    case "2":
      body = d.slice(0, 2) + last + "0000" + d.slice(2, 5);
      break;
    case "3":
      body = d.slice(0, 3) + "00000" + d.slice(3, 5);
      break;
    case "4":
      body = d.slice(0, 4) + "00000" + d.slice(4, 5);
      break;
    default: // 5–9
      body = d.slice(0, 5) + "0000" + last;
      break;
  }
  const payload11 = ns + body;
  if (payload11.length !== 11) return null;
  return payload11 + String(gtinCheckDigit(payload11));
}

/**
 * Equivalent representations of a scanned code, most-specific first. The retail
 * GS1 symbologies encode the *same* GTIN at different lengths, and a camera or
 * keyboard-wedge scanner may report either form depending on the platform — e.g.
 * iOS returns a UPC-A as a 13-digit EAN-13 (leading 0) while Android reports 12
 * digits; UPC-E is the zero-compressed form of a UPC-A. Looking a scan up by ALL
 * of its equivalent forms makes the match robust regardless of which form the
 * product's `barcode` was stored under. Shared verbatim with the mobile app so
 * online (`/pos/lookup`) and offline (local cache) resolution behave identically.
 */
export function barcodeCandidates(raw: string): string[] {
  const c = normalizeScan(raw);
  if (!c) return [];
  const out: string[] = [c];
  const add = (v: string | null | undefined): void => {
    if (v && !out.includes(v)) out.push(v);
  };
  if (digitsOnly(c)) {
    // UPC-A (12) ↔ EAN-13 (13 with a leading 0) — the same GTIN.
    if (c.length === 12) add("0" + c);
    if (c.length === 13 && c[0] === "0") add(c.slice(1));
    // GTIN-14 / ITF-14 carrying a leading pack-level 0.
    if (c.length === 14 && c[0] === "0") add(c.slice(1));
    // UPC-E (8) → its expanded UPC-A (12) and the matching EAN-13 (13).
    if (c.length === 8) {
      const upcA = expandUpcE(c);
      if (upcA) {
        add(upcA);
        add("0" + upcA);
      }
    }
  }
  return out;
}
