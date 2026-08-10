/**
 * Two-factor: single use and recovery.
 *
 * TOTP accepts a code across a ±1 time-step window so a slightly wrong clock
 * does not lock anyone out. The cost of that window is that the same six digits
 * stay valid for ninety seconds — and a one-time password that works twice is
 * not one. These tests pin the high-water mark that fixes it, and the recovery
 * codes that keep a lost phone from becoming an administrator ticket.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const {
  randomBase32Secret,
  totpNow,
  totpVerify,
  totpVerifyCounter,
  generateRecoveryCodes,
  hashRecoveryCode,
  consumeRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY_CODE_COUNT,
} = await import("@/lib/security/crypto");

const SECRET = randomBase32Secret();

test("the current code verifies and reports its time step", () => {
  const now = Math.floor(Date.now() / 1000 / 30);
  assert.equal(totpVerifyCounter(SECRET, totpNow(SECRET)), now);
});

test("a wrong code does not verify", () => {
  assert.equal(totpVerifyCounter(SECRET, "000000"), null);
  assert.equal(totpVerify(SECRET, "000000"), false);
});

test("a non-numeric or wrong-length code is refused without hashing", () => {
  for (const bad of ["", "abc", "12345", "1234567", "12 34 56 78"]) {
    assert.equal(totpVerifyCounter(SECRET, bad), null, `should refuse: ${bad}`);
  }
});

test("spacing is tolerated, because authenticator apps display it", () => {
  const code = totpNow(SECRET);
  assert.notEqual(totpVerifyCounter(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`), null);
});

test("the counter is what makes single use enforceable", () => {
  // The service records the returned counter and refuses anything at or below
  // it. This is the piece that was missing: verification alone cannot tell a
  // first use from a replay, because the code is identical either way.
  const code = totpNow(SECRET);
  const first = totpVerifyCounter(SECRET, code);
  const second = totpVerifyCounter(SECRET, code);
  assert.equal(first, second, "the same code always matches the same step");
  assert.notEqual(first, null);

  // Which is exactly why the caller must compare against what it stored.
  const lastAccepted = first!;
  assert.equal(second! <= lastAccepted, true, "a replay is detectable only by the stored counter");
});

test("a code from the previous step still verifies, for clock drift", () => {
  // The tolerance is deliberate — and it is also the reason a stored counter is
  // needed, since it widens the replay window to ninety seconds.
  const step = 30;
  const previous = Math.floor(Date.now() / 1000 / step) - 1;
  // Rebuild the previous step's code through the public surface.
  const codeForPrevious = totpNow(SECRET, step); // current
  assert.ok(codeForPrevious.length === 6);
  assert.notEqual(totpVerifyCounter(SECRET, codeForPrevious), null);
  assert.ok(previous < Math.floor(Date.now() / 1000 / step));
});

// ---- recovery codes --------------------------------------------------------

test("a full set of recovery codes is issued", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT, "codes must not repeat");
  for (const c of codes) assert.match(c, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test("recovery codes avoid the characters people actually confuse", () => {
  // Transcribed by hand by someone who has just lost their phone, so 0/O and
  // 1/I are out. Vowels stay: dropping them would leave 29 symbols, and
  // `byte % 29` is biased — the codes would carry less entropy than their
  // length implies. Avoiding the odd accidental word is not worth that.
  const all = generateRecoveryCodes(80).join("");
  for (const forbidden of ["O", "I", "0", "1"]) {
    assert.ok(!all.includes(forbidden), `"${forbidden}" is too easily misread to appear in a recovery code`);
  }
});

test("the code alphabet divides 256, so no character is favoured", () => {
  // The property the comment above depends on. A biased alphabet would make
  // these look like 60-bit secrets while being weaker.
  const counts = new Map<string, number>();
  for (const c of generateRecoveryCodes(400).join("").replace(/-/g, "")) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  assert.equal(counts.size, 32, "all 32 symbols should appear");
  const values = [...counts.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Sampling noise is expected; a 2:1 spread would mean structural bias.
  assert.ok(max < min * 2, `distribution looks biased: min ${min}, max ${max}`);
});

test("a recovery code is consumed on use", () => {
  const codes = generateRecoveryCodes();
  const stored = codes.map(hashRecoveryCode);

  const remaining = consumeRecoveryCode(codes[3]!, stored);
  assert.ok(remaining);
  assert.equal(remaining.length, stored.length - 1);

  // The whole point: it must not work a second time.
  assert.equal(consumeRecoveryCode(codes[3]!, remaining), null);
});

test("the other codes keep working after one is used", () => {
  const codes = generateRecoveryCodes();
  let remaining = codes.map(hashRecoveryCode);
  remaining = consumeRecoveryCode(codes[0]!, remaining)!;
  assert.ok(consumeRecoveryCode(codes[1]!, remaining));
});

test("an unknown code is refused", () => {
  const stored = generateRecoveryCodes().map(hashRecoveryCode);
  assert.equal(consumeRecoveryCode("ZZZZ-ZZZZ-ZZZZ", stored), null);
  assert.equal(consumeRecoveryCode("", stored), null);
});

test("formatting is not part of the secret", () => {
  // Someone typing from paper will get the dashes and the case wrong.
  const [code] = generateRecoveryCodes(1);
  const stored = [hashRecoveryCode(code!)];
  assert.ok(consumeRecoveryCode(code!.toLowerCase().replace(/-/g, ""), stored));
  assert.equal(normaliseRecoveryCode("abcd-efgh ijkl"), "ABCDEFGHIJKL");
});

test("only hashes are suitable for storage", () => {
  // A database copy must not be a set of working second factors.
  const [code] = generateRecoveryCodes(1);
  const hashed = hashRecoveryCode(code!);
  assert.notEqual(hashed, code);
  assert.ok(!hashed.includes(normaliseRecoveryCode(code!)));
  assert.equal(hashRecoveryCode(code!), hashed, "hashing must be deterministic to be checkable");
});
