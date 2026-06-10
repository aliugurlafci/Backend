/**
 * Phase 13 — encryption readiness (AES-256-GCM).
 *
 * Authenticated encryption for data at rest (e.g. encrypting PII columns). The
 * key derives from a secret resolved via env (Phase 14 secret management); a
 * dev fallback keeps local runs working but must be overridden in production.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function secret(): string {
  return process.env.AULA_ENCRYPTION_KEY ?? "dev-insecure-key-change-me";
}

function deriveKey(pass: string): Buffer {
  return scryptSync(pass, "aula-crm-static-salt", 32);
}

/** Returns `iv.tag.ciphertext`, all base64. */
export function encrypt(plaintext: string, pass = secret()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(pass), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string, pass = secret()): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(pass), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

// ---- password hashing (scrypt) --------------------------------------------

/** Hash a password with a per-record random salt. Returns `salt.hash` (base64). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("base64")}.${hash.toString("base64")}`;
}

/** Constant-time verify of a password against a stored `salt.hash`. */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltB64, hashB64] = (stored ?? "").split(".");
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

// ---- TOTP two-factor authentication (RFC 6238, HMAC-SHA1, 6 digits / 30s) ----

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A fresh, random base32 TOTP secret (compatible with Google Authenticator etc.). */
export function randomBase32Secret(byteLen = 20): string {
  let bits = "";
  for (const b of randomBytes(byteLen)) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx >= 0) bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secretB32: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The current 6-digit TOTP code for a secret (used by the enable flow + tests). */
export function totpNow(secretB32: string, step = 30): string {
  return hotp(secretB32, Math.floor(Date.now() / 1000 / step));
}

/** Verify a code against the secret, tolerating ±`window` time steps for clock drift. */
export function totpVerify(secretB32: string, code: string, window = 1, step = 30): boolean {
  const clean = (code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretB32, counter + i);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** otpauth:// URI an authenticator app scans to enroll the secret. */
export function totpUri(secretB32: string, account: string, issuer = "Aula ERP"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
