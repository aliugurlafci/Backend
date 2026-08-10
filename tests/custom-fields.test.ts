/**
 * Fields added to the model at runtime.
 *
 * The registry already did versioned publish and the schema already healed
 * itself towards the metadata. What was missing was somewhere to keep a
 * definition between restarts — entities were compiled into the binary, so "add
 * a field" meant editing TypeScript.
 *
 * The two guarantees this rests on, both tested here:
 *
 *  - **A custom field is not a second kind of field.** It becomes an ordinary
 *    `FieldDef` and goes through the same validation, DDL and API generation.
 *  - **It cannot shadow a built-in.** Redefining `total` on an invoice as a
 *    string is not customisation, it is a way to make the ledger stop adding up.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { assertValidField, mergeCustomFields, parseOptions, toFieldDef, fieldKeyOf } = await import(
  "@/lib/metadata/custom-fields"
);
const { metadata } = await import("@/lib/metadata");

const base = {
  entityName: "account",
  name: "loyaltyTier",
  label: "Sadakat Seviyesi",
  type: "string",
};

const account = () => metadata.getEntity("account");

test("a stored definition becomes an ordinary field", () => {
  const field = toFieldDef({
    name: "loyaltyTier",
    label: "Sadakat Seviyesi",
    type: "string",
    required: true,
    filterable: true,
    max: 40,
    helpText: "Gold / Silver",
  });
  assert.deepEqual(field, {
    name: "loyaltyTier",
    label: "Sadakat Seviyesi",
    type: "string",
    required: true,
    filterable: true,
    max: 40,
    helpText: "Gold / Silver",
  });
});

test("a default is coerced to the field's own type", () => {
  // Stored as text because one column has to hold every type's default. Left as
  // a string, a boolean default would fail validation on the first record.
  assert.equal(toFieldDef({ name: "a", label: "A", type: "boolean", defaultValue: "true" }).defaultValue, true);
  assert.equal(toFieldDef({ name: "b", label: "B", type: "number", defaultValue: "7" }).defaultValue, 7);
  assert.equal(toFieldDef({ name: "c", label: "C", type: "string", defaultValue: "x" }).defaultValue, "x");
});

test("choices are parsed from one line each, value doubling as label", () => {
  assert.deepEqual(parseOptions("gold|Altın\nsilver|Gümüş"), [
    { value: "gold", label: "Altın" },
    { value: "silver", label: "Gümüş" },
  ]);
  assert.deepEqual(parseOptions("plain"), [{ value: "plain", label: "plain" }]);
  assert.deepEqual(parseOptions("  \n\n"), []);
  assert.deepEqual(parseOptions(null), []);
});

test("a name that cannot be a column is refused", () => {
  // It reaches DDL. A bad name that gets that far fails as a migration error at
  // boot, with nobody in front of it to read the message.
  for (const name of ["2fast", "with space", "sürpriz", "a-b", ""]) {
    assert.throws(() => assertValidField({ ...base, name }, account()), /field name/, `accepted "${name}"`);
  }
});

test("a system column cannot be redefined", () => {
  for (const name of ["id", "version", "createdAt", "ownerId"]) {
    assert.throws(() => assertValidField({ ...base, name }, account()), /system column/);
  }
});

test("a built-in field cannot be shadowed", () => {
  assert.throws(() => assertValidField({ ...base, name: "name" }, account()), /already has a field/);
});

test("a link field must say what it links to", () => {
  assert.throws(
    () => assertValidField({ ...base, type: "reference" }, account()),
    /which entity it links to/,
  );
  assert.doesNotThrow(() =>
    assertValidField({ ...base, type: "reference", referenceEntity: "product" }, account()),
  );
});

test("a choice field needs choices", () => {
  assert.throws(() => assertValidField({ ...base, type: "enum" }, account()), /at least one choice/);
  assert.doesNotThrow(() => assertValidField({ ...base, type: "enum", options: "a|A" }, account()));
});

test("a required field needs a default, because existing rows have nothing to put in it", () => {
  assert.throws(() => assertValidField({ ...base, required: true }, account()), /default value/);
  assert.doesNotThrow(() => assertValidField({ ...base, required: true, defaultValue: "bronze" }, account()));
});

test("a type the schema cannot build is refused", () => {
  assert.throws(() => assertValidField({ ...base, type: "json" }, account()), /not a field type/);
});

test("merging adds the field to its entity and leaves the others alone", () => {
  const before = metadata.listEntities();
  const merged = mergeCustomFields(before, [
    { entityName: "account", name: "loyaltyTier", label: "Seviye", type: "string", position: 0 },
  ]);
  const acct = merged.find((e) => e.name === "account");
  const product = merged.find((e) => e.name === "product");
  assert.ok(acct?.fields.some((f) => f.name === "loyaltyTier"));
  assert.equal(
    product?.fields.length,
    before.find((e) => e.name === "product")?.fields.length,
    "an untouched entity is untouched",
  );
});

test("merged fields keep their declared order", () => {
  const merged = mergeCustomFields(metadata.listEntities(), [
    { entityName: "account", name: "second", label: "B", type: "string", position: 2 },
    { entityName: "account", name: "first", label: "A", type: "string", position: 1 },
  ]);
  const names = merged.find((e) => e.name === "account")?.fields.map((f) => f.name) ?? [];
  assert.ok(names.indexOf("first") < names.indexOf("second"));
});

test("an inactive field is still merged, so its column stays readable", () => {
  // Dropping it from the metadata would make the repository stop selecting a
  // column that is physically there — the data would look deleted without being
  // deleted, which is the worst of both.
  const merged = mergeCustomFields(metadata.listEntities(), [
    { entityName: "account", name: "retired", label: "Eski", type: "string", active: false },
  ]);
  assert.ok(merged.find((e) => e.name === "account")?.fields.some((f) => f.name === "retired"));
});

test("a stored field that collides with a built-in added since is dropped, not shadowed", () => {
  // The built-in is the one the code reads.
  const merged = mergeCustomFields(metadata.listEntities(), [
    { entityName: "account", name: "name", label: "Sahte", type: "string" },
  ]);
  const nameFields = merged.find((e) => e.name === "account")?.fields.filter((f) => f.name === "name") ?? [];
  assert.equal(nameFields.length, 1);
  assert.equal(nameFields[0]?.label, account().fields.find((f) => f.name === "name")?.label);
});

test("a definition for an entity that no longer exists is ignored", () => {
  const merged = mergeCustomFields(metadata.listEntities(), [
    { entityName: "gone", name: "x", label: "X", type: "string" },
  ]);
  assert.equal(merged.length, metadata.listEntities().length);
});

test("nothing stored means nothing changes", () => {
  const before = metadata.listEntities();
  assert.deepEqual(mergeCustomFields(before, []), [...before]);
});

test("the key is one field name per entity", () => {
  assert.equal(fieldKeyOf("account", "loyaltyTier"), "account:loyaltyTier");
  // Two entities may legitimately both add a `region`.
  assert.notEqual(fieldKeyOf("account", "region"), fieldKeyOf("product", "region"));
});
