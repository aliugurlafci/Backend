/**
 * Delegation limits: a caller may never grant an operation, screen or settings
 * area they don't hold themselves, and the catalogue they are served is narrowed
 * to exactly what they can hand out. The record-visibility half (administrators
 * hidden, creation-subtree scoping) touches the data store and is exercised
 * through the API rather than here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { covers, narrowCatalog, assertGrantsDelegatable } from "@/lib/security/delegation";
import { SETTINGS_AREAS } from "@/lib/config/settings-permissions";
import type { RequestContext } from "@/lib/context/types";

function ctx(roles: string[], grants?: string[]): RequestContext {
  return {
    tenantId: "t",
    orgId: "o",
    userId: "u1",
    displayName: "Test",
    email: "test@example.test",
    roles: Object.freeze(roles),
    grants: grants ? Object.freeze(grants) : undefined,
    locale: "en",
    featureFlags: Object.freeze({}),
    correlationId: "test",
    at: new Date(0).toISOString(),
    isSystem: false,
  };
}

const CATALOG = {
  entities: [
    { name: "deal", group: "crm", actions: ["read", "create", "update", "delete", "win"] },
    { name: "invoice", group: "finance", actions: ["read", "create", "update", "delete"] },
  ],
  special: ["pos:checkout", "pii:read"],
  roles: [
    { value: "admin", grants: ["*", "pii:read"] },
    { value: "sales_rep", grants: ["deal:read", "deal:create", "invoice:read"] },
  ],
  settings: SETTINGS_AREAS,
};

test("covers understands the wildcard rules", () => {
  assert.equal(covers(["*"], "deal:delete"), true);
  assert.equal(covers(["deal:*"], "deal:delete"), true);
  assert.equal(covers(["deal:read"], "deal:read"), true);
  assert.equal(covers(["deal:read"], "deal:delete"), false);
  // Holding one operation never lets you hand out the whole entity.
  assert.equal(covers(["deal:read"], "deal:*"), false);
  assert.equal(covers(["deal:*"], "deal:*"), true);
});

test("a non-admin catalogue is clipped to the grants actually held", () => {
  const held = ["deal:read", "deal:create", "pii:read", "settings.users:read"];
  const narrowed = narrowCatalog(ctx(["sales_manager"], held), CATALOG);

  const deal = narrowed.entities.find((e) => e.name === "deal");
  assert.deepEqual(deal?.actions, ["read", "create"], "only held operations survive");
  assert.equal(narrowed.entities.some((e) => e.name === "invoice"), false, "entities with nothing left are dropped");
  assert.deepEqual(narrowed.special, ["pii:read"]);

  const users = narrowed.settings.find((a) => a.key === "settings.users");
  assert.deepEqual(users?.actions, ["read"], "settings areas are clipped per action");
  assert.equal(narrowed.settings.some((a) => a.key === "settings.mobile"), false);
});

test("the administrator preset is never offered to a non-admin", () => {
  const narrowed = narrowCatalog(ctx(["sales_manager"], ["deal:read"]), CATALOG);
  assert.equal(narrowed.roles.some((r) => r.value === "admin"), false);
  const rep = narrowed.roles.find((r) => r.value === "sales_rep");
  assert.deepEqual(rep?.grants, ["deal:read"], "presets are clipped to what the caller holds");
});

test("an administrator sees the catalogue untouched", () => {
  const narrowed = narrowCatalog(ctx(["admin"]), CATALOG);
  assert.equal(narrowed.entities.length, CATALOG.entities.length);
  assert.equal(narrowed.roles.length, CATALOG.roles.length);
  assert.equal(narrowed.settings.length, SETTINGS_AREAS.length);
});

test("writes are re-checked, not just the catalogue", () => {
  const caller = ctx(["sales_manager"], ["deal:read", "deal:create"]);
  assert.doesNotThrow(() => assertGrantsDelegatable(caller, ["deal:read"]));
  // Escalation attempts: an unheld operation, a wildcard, and super-user.
  assert.throws(() => assertGrantsDelegatable(caller, ["deal:delete"]), /cannot grant/);
  assert.throws(() => assertGrantsDelegatable(caller, ["deal:*"]), /cannot grant/);
  assert.throws(() => assertGrantsDelegatable(caller, ["*"]), /cannot grant/);
  // Administrators are unrestricted.
  assert.doesNotThrow(() => assertGrantsDelegatable(ctx(["admin"]), ["*"]));
});
