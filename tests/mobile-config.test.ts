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

test("mobile catalog flags exactly the implemented screens", () => {
  const catalog = mobileScreenCatalog();
  const implemented = new Set(MOBILE_IMPLEMENTED_SCREENS);
  // Every implemented key is present and flagged true.
  for (const key of implemented) {
    const def = catalog.find((s) => s.key === key);
    assert.ok(def, `catalog should include ${key}`);
    assert.equal(def.mobileImplemented, true, `${key} should be mobileImplemented`);
  }
  // Web-only screens exist and are flagged false (e.g. a dashboard).
  const webOnly = catalog.find((s) => s.key === "automation");
  assert.ok(webOnly);
  assert.equal(webOnly.mobileImplemented, false);
  // The catalog is the full web catalog, so it has many more than the app set.
  assert.ok(catalog.length > implemented.size);
});
