/**
 * Every error message a user can meet has a translation.
 *
 * The localization design is gettext-style: the backend throws in ENGLISH, and
 * the boundary (`lib/i18n/errors.ts`) looks the exact text up in the shared
 * catalogue. That lookup fails OPEN — an unmatched message renders in English
 * rather than hiding the error — which means editing a throw string without
 * updating the catalogue is silent. This test closes that hole: it scans the
 * source for static throw strings the way the catalogue was first built, and
 * fails naming the message and the file when one is missing.
 *
 * Dynamic (template-literal) messages are exempt from the text scan because
 * they match by `messageKey` instead — for those, the test asserts the key
 * named at the throw site actually exists in the template catalogue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_TEMPLATES, ERROR_TEXTS } from "@aula/contracts/i18n/errors";

const SRC = join(import.meta.dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * NotFoundError's first argument is an entity WORD, not a sentence — it is
 * interpolated into the localized `err.notFound` template and translated via
 * the entity-label catalogue, so it does not belong in the text catalogue.
 */
const STATIC_THROW = /new (BadRequestError|ConflictError|UnauthenticatedError|ForbiddenError|AccountingError)\(\s*"((?:[^"\\]|\\.)*)"/g;
const KEYED_THROW = /\.withKey\(\s*"([^"]+)"/g;

test("every static throw string has a catalogue translation", () => {
  const missing: string[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(STATIC_THROW)) {
      const message = m[2]!.replace(/\\"/g, '"');
      if (!ERROR_TEXTS[message]) missing.push(`${file.slice(SRC.length + 1)}: "${message}"`);
    }
  }
  assert.deepEqual(missing, [], `add these to packages/contracts/src/i18n/errors.ts ERROR_TEXTS:\n${missing.join("\n")}`);
});

test("every withKey() at a throw site names a real template", () => {
  const missing: string[] = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(KEYED_THROW)) {
      const key = m[1]!;
      if (!ERROR_TEMPLATES[key]) missing.push(`${file.slice(SRC.length + 1)}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `add these templates to ERROR_TEMPLATES:\n${missing.join("\n")}`);
});

test("every template and text entry carries all three languages", () => {
  for (const [key, tpl] of Object.entries(ERROR_TEMPLATES)) {
    assert.ok(tpl.en && tpl.tr && tpl.de, `${key} is missing a language`);
  }
  for (const [msg, t] of Object.entries(ERROR_TEXTS)) {
    assert.ok(t.tr && t.de, `"${msg}" is missing a language`);
  }
});

test("a translation only uses placeholders the English template has", () => {
  // SUBSET, not equality: a translation may deliberately drop a detail (the
  // version-conflict text drops {expected}/{found} — raw version numbers help
  // nobody at a till), but a placeholder the interpolator will never fill
  // would render as literal "{name}" on screen.
  const names = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
  for (const [key, tpl] of Object.entries(ERROR_TEMPLATES)) {
    const en = names(tpl.en);
    for (const lang of ["tr", "de"] as const) {
      for (const name of names(tpl[lang])) {
        assert.ok(en.has(name), `${key}: ${lang} uses {${name}} which en does not define`);
      }
    }
  }
});
