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

/** Normalise a scanned code: trim and strip a leading EAN/UPC zero-pad noise. */
export function normalizeScan(raw: string): string {
  return (raw ?? "").trim();
}
