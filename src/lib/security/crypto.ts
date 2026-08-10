/**
 * Phase 13 — encryption readiness (AES-256-GCM).
 *
 * Authenticated encryption for data at rest (e.g. encrypting PII columns). The
 * key derives from a secret resolved via env (Phase 14 secret management); a
 * dev fallback keeps local runs working but must be overridden in production.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { env, isProduction } from "@/lib/config/env";

/**
 * Async scrypt (runs on libuv's threadpool, default 4 threads) instead of the
 * synchronous variant, so password hashing + key derivation don't block the
 * single event-loop thread under load. Tune parallelism with UV_THREADPOOL_SIZE.
 */
// The options overload matters: without it the cost parameters cannot be passed
// and every hash silently uses Node's defaults, which is how the old format
// ended up with no recorded work factor at all.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const INSECURE_KEY = "dev-insecure-key-change-me";

function secret(): string {
  const key = env.AULA_ENCRYPTION_KEY;
  // In production a strong key is mandatory (startup also enforces this); never
  // fall back to the well-known dev key, which would render PII/2FA secrets
  // trivially decryptable. Outside production the dev fallback keeps local runs working.
  if (!key || key === INSECURE_KEY) {
    if (isProduction) throw new Error("AULA_ENCRYPTION_KEY must be set to a strong value");
    return INSECURE_KEY;
  }
  return key;
}

/**
 * Derived encryption keys, cached by passphrase. The passphrase is a process-wide
 * constant (the env secret) in every real call, so deriving it once — rather than
 * running scrypt on every encrypt/decrypt — removes a hidden ~scrypt-cost per PII
 * / 2FA operation. Keyed by passphrase to stay correct for explicit `pass` args.
 */
const keyCache = new Map<string, Buffer>();

async function deriveKey(pass: string): Promise<Buffer> {
  const cached = keyCache.get(pass);
  if (cached) return cached;
  const key = await scrypt(pass, "aula-crm-static-salt", 32);
  keyCache.set(pass, key);
  return key;
}

/** Returns `iv.tag.ciphertext`, all base64. */
export async function encrypt(plaintext: string, pass = secret()): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(pass), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export async function decrypt(payload: string, pass = secret()): Promise<string> {
  const parts = payload.split(".");
  // A payload that is not three parts is rejected here rather than a few lines
  // later. Destructuring straight into `Buffer.from(ivB64, "base64")` meant a
  // truncated or corrupted value reached Buffer with `undefined` and threw a
  // TypeError about argument types — an unhandled 500 describing the wrong
  // problem, where the honest answer is that the ciphertext is not one of ours.
  if (parts.length !== 3) throw new Error("malformed ciphertext");
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", await deriveKey(pass), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

// ---- password hashing (scrypt) --------------------------------------------

/**
 * Work factor.
 *
 * `N` is the cost: memory is roughly `N × r × 128` bytes, so 65536 asks for
 * ~64 MB and measures around 90 ms on the hardware this was written on. That is
 * the trade — a login the user does not notice, against an attacker who must pay
 * 64 MB per guess, which is what makes GPU cracking expensive rather than merely
 * slow.
 *
 * Node's default is N=16384 (~16 MB, ~20 ms), which was what this used simply
 * because nothing said otherwise. Raising it is only possible because the
 * parameters now travel WITH the hash — see below.
 */
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1 } as const;
/** scrypt refuses to allocate past this; it must exceed N × r × 128. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const KEY_LEN = 64;

/**
 * Stored format: `scrypt$N$r$p$salt$hash`, salt and hash base64.
 *
 * The parameters are part of the record because a hash is a decision made once
 * and lived with for years. The old format was `salt.hash` and nothing else, so
 * the cost was whatever Node's default happened to be AT VERIFY TIME — meaning
 * raising it would have silently invalidated every existing password, and
 * lowering it (a Node default change) would have weakened them with no signal.
 * There was no upgrade path at all; this is what creates one.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM });
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

interface ParsedHash {
  params: { N: number; r: number; p: number };
  salt: Buffer;
  hash: Buffer;
  /** True when the record predates the versioned format. */
  legacy: boolean;
}

function parseStoredHash(stored: string): ParsedHash | null {
  if (!stored) return null;

  if (stored.startsWith("scrypt$")) {
    const [, n, r, p, saltB64, hashB64] = stored.split("$");
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    if (!saltB64 || !hashB64 || !Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
      return null;
    }
    return { params, salt: Buffer.from(saltB64, "base64"), hash: Buffer.from(hashB64, "base64"), legacy: false };
  }

  // Legacy `salt.hash`, hashed with whatever Node's defaults were. Still
  // verifiable — refusing it would lock out every account created before this
  // change, which is not a security improvement.
  const [saltB64, hashB64] = stored.split(".");
  if (!saltB64 || !hashB64) return null;
  return {
    params: { N: 16384, r: 8, p: 1 },
    salt: Buffer.from(saltB64, "base64"),
    hash: Buffer.from(hashB64, "base64"),
    legacy: true,
  };
}

/**
 * Shortest comparison this will accept, in bytes.
 *
 * This exists because scrypt's output is PREFIX-CONSISTENT: deriving 7 bytes
 * gives exactly the first 7 bytes of a 64-byte derivation. The verifier used to
 * derive `stored.hash.length` bytes and compare, which meant a truncated stored
 * value did not fail — it silently reduced the comparison to however many bytes
 * survived. A 3-byte remnant is 24 bits, brute-forced instantly, and nothing
 * anywhere would have reported a problem.
 *
 * Clients cannot write `passwordHash` (it is a computed field), so this is not
 * reachable from the API — but a partial write, a bad migration or a hand-edited
 * row would all produce it, and "the check is only as strong as the data it is
 * checking against" is not a property to leave in an authentication path.
 */
const MIN_HASH_BYTES = 32;

/** Constant-time verify against a stored hash, in either format. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored ?? "");
  if (!parsed) return false;
  // A stored hash too short to be a real one is a corrupt record, not a
  // password that happens to be easy to match.
  if (parsed.hash.length < MIN_HASH_BYTES) return false;
  const actual = await scrypt(password, parsed.salt, parsed.hash.length, {
    ...parsed.params,
    maxmem: SCRYPT_MAXMEM,
  });
  return parsed.hash.length === actual.length && timingSafeEqual(actual, parsed.hash);
}

/**
 * Should this hash be rewritten with the current parameters?
 *
 * Checked after a SUCCESSFUL verify, which is the only moment the plaintext is
 * available to rehash with. Without this step the versioned format would be an
 * upgrade path nobody ever walks: existing users would keep their weaker hashes
 * until they happened to change their password.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored ?? "");
  if (!parsed) return false;
  if (parsed.legacy) return true;
  const { N, r, p } = SCRYPT_PARAMS;
  // Only ever upgrade. A record already stronger than the current setting is
  // left alone — rewriting it would be a downgrade.
  return parsed.params.N < N || parsed.params.r < r || parsed.params.p < p;
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
  // RFC 4226 dynamic truncation. Every index here is in range by construction
  // and not by luck: SHA-1 always digests to 20 bytes, and the offset is the low
  // nibble of the last one, so it is 0–15 and `offset + 3` is at most 18.
  // `readUInt32BE` states that as one bounds-checked read rather than four
  // indexes the compiler has to be told to trust.
  const offset = hmac.readUInt8(hmac.length - 1) & 0xf;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** The current 6-digit TOTP code for a secret (used by the enable flow + tests). */
export function totpNow(secretB32: string, step = 30): string {
  return hotp(secretB32, Math.floor(Date.now() / 1000 / step));
}

/**
 * Verify a code and return the time step it matched, or `null`.
 *
 * Returning the counter rather than a boolean is what makes single-use possible:
 * the caller records it and refuses anything at or below it next time. A code is
 * accepted across a ±1 step window for clock drift, so without that record the
 * same six digits stay valid for ninety seconds — and "one-time password" is
 * precisely the property that was missing. Ninety seconds is ample for anyone
 * who read the code over a shoulder, captured it in a phishing form, or found it
 * in a request log.
 *
 * Newest-first, so the code the user is looking at right now costs one HMAC and
 * lands on the highest counter — which also makes the stored high-water mark
 * advance as fast as possible.
 */
export function totpVerifyCounter(secretB32: string, code: string, window = 1, step = 30): number | null {
  const clean = (code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let i = window; i >= -window; i--) {
    const candidate = counter + i;
    const expected = hotp(secretB32, candidate);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return candidate;
  }
  return null;
}

/**
 * Boolean verify, for flows with no session to record a counter against.
 *
 * Used by enrolment, where the code proves the authenticator is set up correctly
 * and there is nothing yet to replay INTO — 2FA is not enabled until this
 * succeeds. Sign-in uses `totpVerifyCounter` and enforces single use.
 */
export function totpVerify(secretB32: string, code: string, window = 1, step = 30): boolean {
  return totpVerifyCounter(secretB32, code, window, step) !== null;
}

// ---- two-factor recovery codes ---------------------------------------------

/**
 * How many recovery codes are issued.
 *
 * Enough that losing a couple to a misread does not matter, few enough that the
 * user will actually write them down. Each is single-use.
 */
export const RECOVERY_CODE_COUNT = 10;

/**
 * A recovery code, in the format shown to the user: `XXXX-XXXX-XXXX`.
 *
 * The alphabet drops the characters people genuinely confuse when copying from
 * paper — `0`/`O` and `1`/`I` — because that is what these are for: transcribed
 * by hand, under pressure, by someone who has just lost their phone.
 *
 * It keeps vowels, and that is a deliberate trade rather than an oversight.
 * Removing them would leave 29 symbols, and `byte % 29` is biased (256 is not a
 * multiple of 29), so some characters would appear more often than others and
 * the codes would carry less entropy than their length suggests. 32 divides 256
 * exactly. Avoiding an occasional accidental word is not worth weakening the
 * randomness of a credential.
 */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const chars = [...randomBytes(12)].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
    codes.push(`${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`);
  }
  return codes;
}

/** Normalise for comparison: case and dashes are presentation, not content. */
export function normaliseRecoveryCode(code: string): string {
  return (code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Hash a recovery code for storage.
 *
 * SHA-256 rather than scrypt, deliberately: these are 12 random characters from
 * a 32-symbol alphabet — 60 bits — generated by us, not chosen by a person. A
 * slow KDF defends against guessing a weak human password; there is nothing weak
 * to defend here, and paying 90 ms per candidate across ten codes would make
 * every recovery attempt take a second for no gain.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code)).digest("base64");
}

/**
 * Consume a recovery code.
 *
 * Returns the remaining hashes with the used one removed, or `null` when the
 * code does not match. Single use is the entire point: a recovery code that
 * still works after it has been used is a password with extra steps.
 */
export function consumeRecoveryCode(code: string, storedHashes: readonly string[]): string[] | null {
  const candidate = hashRecoveryCode(code);
  const buf = Buffer.from(candidate);
  let matched = -1;
  for (let i = 0; i < storedHashes.length; i++) {
    // `?? ""` rather than an index assertion: an empty stored hash cannot equal
    // the candidate (lengths differ), so a hole in the array is a miss and not a
    // crash — and this loop must not throw partway through, or the timing it
    // goes to such trouble to keep constant would leak after all.
    const stored = Buffer.from(storedHashes[i] ?? "");
    // Compared in constant time and WITHOUT breaking early, so the work does not
    // depend on which code matched or whether one did.
    if (stored.length === buf.length && timingSafeEqual(stored, buf)) matched = i;
  }
  if (matched < 0) return null;
  return storedHashes.filter((_, i) => i !== matched);
}

/** otpauth:// URI an authenticator app scans to enroll the secret. */
export function totpUri(secretB32: string, account: string, issuer = "Aula ERP"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
