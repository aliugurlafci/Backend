/**
 * VKN / TCKN check-digit validation.
 *
 * A wrong tax number is not discovered until the invoice is rejected, by which
 * point the sale has happened — so the check digits are worth getting exactly
 * right. The valid samples below are synthetic numbers constructed to satisfy
 * each algorithm, not real taxpayers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidTckn, isValidVkn, validateTaxNumber } from "@/lib/finance/tax-id";

// ---- VKN (10 digits, legal entities) ---------------------------------------

/** Build a VKN by computing the correct check digit for a 9-digit prefix. */
function makeVkn(prefix9: string): string {
  const digits = [...prefix9].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (digits[i]! + (10 - i)) % 10;
    sum += tmp === 9 ? tmp : (tmp * 2 ** (10 - i)) % 9;
  }
  const check = sum % 10 === 0 ? 0 : 10 - (sum % 10);
  return prefix9 + String(check);
}

test("a VKN with the correct check digit passes", () => {
  for (const prefix of ["123456789", "987654321", "111111111", "100000000"]) {
    const vkn = makeVkn(prefix);
    assert.equal(isValidVkn(vkn), true, `${vkn} should be valid`);
  }
});

test("changing any digit of a valid VKN breaks it", () => {
  const vkn = makeVkn("123456789");
  for (let i = 0; i < 10; i++) {
    const digit = Number(vkn[i]);
    const mutated = vkn.slice(0, i) + String((digit + 1) % 10) + vkn.slice(i + 1);
    assert.equal(isValidVkn(mutated), false, `${mutated} should be rejected`);
  }
});

test("a VKN must be exactly 10 digits", () => {
  assert.equal(isValidVkn("12345678"), false);
  assert.equal(isValidVkn("12345678901"), false);
  assert.equal(isValidVkn("12345678a0"), false);
  assert.equal(isValidVkn(""), false);
});

// ---- TCKN (11 digits, individuals) -----------------------------------------

/** Build a TCKN by computing both check digits for a 9-digit prefix. */
function makeTckn(prefix9: string): string {
  const d = [...prefix9].map(Number);
  const oddSum = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const evenSum = d[1]! + d[3]! + d[5]! + d[7]!;
  const tenth = (((oddSum * 7 - evenSum) % 10) + 10) % 10;
  const first10 = [...d, tenth];
  const eleventh = first10.reduce((s, n) => s + n, 0) % 10;
  return prefix9 + String(tenth) + String(eleventh);
}

test("a TCKN with correct check digits passes", () => {
  for (const prefix of ["123456789", "987654321", "111111111"]) {
    const tckn = makeTckn(prefix);
    assert.equal(isValidTckn(tckn), true, `${tckn} should be valid`);
  }
});

test("a TCKN cannot start with zero", () => {
  const tckn = makeTckn("023456789");
  assert.equal(isValidTckn(tckn), false);
});

test("changing any digit of a valid TCKN breaks it", () => {
  const tckn = makeTckn("123456789");
  for (let i = 0; i < 11; i++) {
    const digit = Number(tckn[i]);
    const mutated = tckn.slice(0, i) + String((digit + 1) % 10) + tckn.slice(i + 1);
    if (i === 0 && mutated[0] === "0") continue; // covered by the leading-zero case
    assert.equal(isValidTckn(mutated), false, `${mutated} should be rejected`);
  }
});

test("a TCKN must be exactly 11 digits", () => {
  assert.equal(isValidTckn("1234567890"), false);
  assert.equal(isValidTckn("123456789012"), false);
  assert.equal(isValidTckn(""), false);
});

// ---- the field-level validator ---------------------------------------------

test("the right algorithm is applied for each taxpayer type", () => {
  const vkn = makeVkn("123456789");
  const tckn = makeTckn("123456789");
  assert.deepEqual(validateTaxNumber(vkn, "corporate"), { ok: true });
  assert.deepEqual(validateTaxNumber(tckn, "individual"), { ok: true });
  // A valid VKN is still the wrong length for an individual, and vice versa.
  assert.equal(validateTaxNumber(vkn, "individual").ok, false);
  assert.equal(validateTaxNumber(tckn, "corporate").ok, false);
});

test("an empty tax number is accepted — the field is optional until invoicing", () => {
  assert.deepEqual(validateTaxNumber("", "corporate"), { ok: true });
  assert.deepEqual(validateTaxNumber(null, "individual"), { ok: true });
  assert.deepEqual(validateTaxNumber(undefined, "corporate"), { ok: true });
});

test("the failure says which rule was broken", () => {
  const short = validateTaxNumber("123", "corporate");
  assert.equal(short.ok, false);
  assert.match((short as { reason: string }).reason, /10 haneli/);

  const badCheck = validateTaxNumber("1234567890", "corporate");
  assert.equal(badCheck.ok, false);
  assert.match((badCheck as { reason: string }).reason, /doğrulama hanesi/);
});

test("surrounding whitespace is tolerated", () => {
  assert.deepEqual(validateTaxNumber(`  ${makeVkn("123456789")}  `, "corporate"), { ok: true });
});
