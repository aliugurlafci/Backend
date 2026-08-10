/**
 * The chart of accounts must be provisionable.
 *
 * `requireAccount` self-provisions a missing account by writing a `ledgerAccount`
 * row whose `subtype` is the lookup key. `subtype` is an enum, so a key that is
 * not among its options fails validation — and because posting failures are
 * queued for retry rather than surfaced, the symptom was a vendor bill marked
 * "received" with no payable and no VAT behind it. This catches the mismatch at
 * build time instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { metadata } from "@/lib/metadata";
import { STANDARD_ACCOUNT_SUBTYPES } from "@/lib/accounting/service";

test("every standard account's subtype is a valid ledgerAccount option", () => {
  const field = metadata.getEntity("ledgerAccount").fields.find((f) => f.name === "subtype");
  assert.ok(field?.options, "ledgerAccount.subtype should be an enum");
  const allowed = new Set(field.options.map((o) => o.value));
  for (const subtype of STANDARD_ACCOUNT_SUBTYPES) {
    assert.ok(allowed.has(subtype), `subtype "${subtype}" is missing from ledgerAccount.subtype options`);
  }
});

test("the statutory codes are the Turkish ones, not the Anglo-Saxon defaults", () => {
  // A guard against a well-meaning revert: 1000/1100/4000 are the old plan.
  const field = metadata.getEntity("ledgerAccount").fields.find((f) => f.name === "subtype");
  assert.ok(field?.options?.some((o) => o.value === "vat_deductible"), "191 input VAT must be selectable");
});

/**
 * Every `source` the posting code writes must be a valid `journalEntry.source`.
 *
 * `source` is an enum, so an unlisted value fails validation — and posting
 * failures are queued for retry rather than surfaced, so the symptom is a
 * document that changed state with no journal entry behind it. That has now
 * happened three times (salesReturn, goodsReceiptVoid, the cheque sources);
 * this makes the next one a failing test instead.
 */
test("every posting source is a valid journalEntry.source option", () => {
  const field = metadata.getEntity("journalEntry").fields.find((f) => f.name === "source");
  assert.ok(field?.options, "journalEntry.source should be an enum");
  const allowed = new Set(field.options.map((o) => o.value));

  // READ FROM THE CODE, not maintained by hand.
  //
  // The list used to be written out here, which made this test good at noticing
  // a REMOVED enum value and blind to an ADDED source — the far more common
  // direction, and the one that has now bitten four times (salesReturn,
  // goodsReceiptVoid, the cheque sources, and the FX revaluation). Scanning the
  // posting modules means a new `source:` is checked the moment it is written.
  const dir = new URL("../src/lib/accounting/", import.meta.url);
  const posted = new Set<string>(["manual", "reversal"]);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(new URL(file, dir), "utf8");
    for (const m of text.matchAll(/\bsource:\s*"([A-Za-z]+)"/g)) posted.add(m[1]!);
  }
  assert.ok(posted.size >= 15, `expected to find the posting sources by scanning; found ${posted.size}`);
  for (const source of posted) {
    assert.ok(allowed.has(source), `source "${source}" is missing from journalEntry.source options`);
  }
});
