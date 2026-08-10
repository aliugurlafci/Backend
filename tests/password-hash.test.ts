/**
 * Password hashing.
 *
 * The change under test is not the algorithm — it was already scrypt with a
 * per-record salt — it is that the WORK FACTOR is now stored alongside the hash.
 * Without it the cost was whatever Node's default happened to be at verify time,
 * so raising it would have invalidated every existing password and a future Node
 * change lowering it would have weakened them all with no signal.
 *
 * The tests that matter most are the two about the old format: a change to how
 * passwords are stored is only safe if nobody is locked out by it.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const { hashPassword, verifyPassword, needsRehash } = await import("@/lib/security/crypto");

const scrypt = promisify(scryptCb) as (
  p: string | Buffer,
  s: string | Buffer,
  k: number,
  o?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/** A hash in the format this codebase used before the parameters were recorded. */
async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("base64")}.${hash.toString("base64")}`;
}

test("a password verifies against its own hash", async () => {
  const stored = await hashPassword("Str0ng-Passw0rd!");
  assert.equal(await verifyPassword("Str0ng-Passw0rd!", stored), true);
  assert.equal(await verifyPassword("Str0ng-Passw0rd", stored), false);
});

test("the stored value records the parameters it was made with", async () => {
  const stored = await hashPassword("x");
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  assert.equal(scheme, "scrypt");
  assert.ok(Number(n) >= 65536, `work factor should be at least 65536, got ${n}`);
  assert.equal(r, "8");
  assert.equal(p, "1");
  assert.ok(salt!.length > 0 && hash!.length > 0);
});

test("two hashes of the same password differ", async () => {
  // Per-record salt. Identical hashes would mean two people with the same
  // password are visibly the same in the database.
  assert.notEqual(await hashPassword("same"), await hashPassword("same"));
});

test("a legacy hash still verifies", async () => {
  // Nobody may be locked out by a change to the storage format. Refusing the old
  // shape would have been a self-inflicted outage for every existing account.
  const stored = await legacyHash("old-password");
  assert.equal(await verifyPassword("old-password", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
});

test("a legacy hash is flagged for upgrade", async () => {
  assert.equal(needsRehash(await legacyHash("old-password")), true);
});

test("a current hash is not rewritten", async () => {
  assert.equal(needsRehash(await hashPassword("current")), false);
});

test("a hash already stronger than the current setting is left alone", async () => {
  // Only ever upgrade: rewriting a stronger record with today's parameters would
  // be a downgrade dressed up as maintenance.
  const salt = randomBytes(16);
  const hash = await scrypt("x", salt, 64, { N: 131072, r: 8, p: 1, maxmem: 512 * 1024 * 1024 });
  const stronger = `scrypt$131072$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
  assert.equal(needsRehash(stronger), false);
  assert.equal(await verifyPassword("x", stronger), true);
});

test("a malformed or empty stored value is refused, not crashed on", async () => {
  for (const bad of ["", "garbage", "scrypt$$$$", "only.one", "scrypt$abc$8$1$x$y"]) {
    assert.equal(await verifyPassword("anything", bad), false, `should refuse: ${bad}`);
  }
});

test("verification is not fooled by a truncated hash", async () => {
  // scrypt's output is PREFIX-CONSISTENT — deriving 7 bytes yields exactly the
  // first 7 bytes of a 64-byte derivation. So a verifier that derives
  // `stored.length` bytes and compares does not fail on a truncated record; it
  // silently drops to comparing whatever survived. This test found that: a
  // 3-byte remnant matched, which is 24 bits.
  //
  // Not reachable through the API (`passwordHash` is computed and clients cannot
  // write it), but a partial write or a hand-edited row produces it, and an
  // authentication check must not be only as strong as the row it reads.
  const stored = await hashPassword("secret");
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  for (const cut of [4, 10, 20, 40]) {
    const truncated = `${scheme}$${n}$${r}$${p}$${salt}$${hash!.slice(0, cut)}`;
    assert.equal(await verifyPassword("secret", truncated), false, `truncation to ${cut} chars must not verify`);
  }
});
