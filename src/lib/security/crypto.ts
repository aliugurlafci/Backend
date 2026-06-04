/**
 * Phase 13 — encryption readiness (AES-256-GCM).
 *
 * Authenticated encryption for data at rest (e.g. encrypting PII columns). The
 * key derives from a secret resolved via env (Phase 14 secret management); a
 * dev fallback keeps local runs working but must be overridden in production.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
