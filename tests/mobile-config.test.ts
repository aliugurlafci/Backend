/**
 * Mobile screen-config catalog + metadata registration checks. The resolver's
 * precedence/intersection logic touches the data store (exercised live in memory
 * mode), so here we pin the pieces that are pure: the entity is registered with
 * the right shape, and the catalog flags exactly the screens the app implements.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { metadata } from "@/lib/metadata";
import { mobileScreenCatalog } from "@/lib/mobile/service";
import { MOBILE_IMPLEMENTED_SCREENS } from "@/lib/config/screens";

test("mobileScreenConfig entity is registered as a system entity", () => {
  const e = metadata.getEntity("mobileScreenConfig");
  assert.ok(e, "entity should be registered");
  assert.equal(e.system, true);
  const fields = e.fields.map((f) => f.name);
  for (const name of ["clientId", "positionId", "userId", "screens", "hiddenFields", "active"]) {
    assert.ok(fields.includes(name), `missing field ${name}`);
  }
});

test("mobile catalog flags the default + generic-host screens as implemented", () => {
  const catalog = mobileScreenCatalog();
  const implemented = new Set(MOBILE_IMPLEMENTED_SCREENS);
  // Every default (POS-core) key is present and flagged true.
  for (const key of implemented) {
    const def = catalog.find((s) => s.key === key);
    assert.ok(def, `catalog should include ${key}`);
    assert.equal(def.mobileImplemented, true, `${key} should be mobileImplemented`);
  }
  // Entity screens are covered by the generic entity browser.
  const invoice = catalog.find((s) => s.key === "invoice");
  assert.ok(invoice, "catalog should include the invoice entity screen");
  assert.equal(invoice.mobileImplemented, true, "entity screens are mobile-implemented");
  // Supported extras (dashboards, activity feed, entity-backed tools) too.
  for (const key of ["sales-dashboard", "activity", "automation"]) {
    const def = catalog.find((s) => s.key === key);
    assert.ok(def, `catalog should include ${key}`);
    assert.equal(def.mobileImplemented, true, `${key} should be mobileImplemented`);
  }
  // The catalog is the full web catalog, so it has many more than the default set.
  assert.ok(catalog.length > implemented.size);
});
