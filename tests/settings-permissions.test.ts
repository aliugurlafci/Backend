/**
 * Settings-area permission checks: the wildcard rules, the legacy fallback that
 * keeps pre-existing positions out of a self-lockout, and the entity grants an
 * administrative area implies (the screens behind them read `user`/`position`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_AREAS,
  SELF_SERVICE_SETTINGS_GRANTS,
  canSettings,
  canAnySettings,
  expandSettingsGrants,
  areaForUserSettingKey,
} from "@/lib/config/settings-permissions";
import { ROLES, roleGrants } from "@/lib/permissions/policies";

test("area keys are unique and namespaced under settings.", () => {
  const keys = SETTINGS_AREAS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate area key");
  for (const key of keys) assert.ok(key.startsWith("settings."), `${key} must be namespaced`);
  for (const area of SETTINGS_AREAS) assert.ok(area.actions.length > 0, `${area.key} needs actions`);
});

test("explicit, wildcard and super-user grants all allow", () => {
  assert.equal(canSettings(["settings.users:read"], "settings.users", "read"), true);
  assert.equal(canSettings(["settings.users:*"], "settings.users", "password"), true);
  assert.equal(canSettings(["*"], "settings.users", "password"), true);
});

test("an unrelated settings grant does not leak into another area", () => {
  const grants = ["settings.profile:*", "deal:*"];
  assert.equal(canSettings(grants, "settings.users", "read"), false);
  assert.equal(canSettings(grants, "settings.roles", "read"), false);
  // ...and a granted area is limited to the ticked operation.
  assert.equal(canSettings(["settings.users:read"], "settings.users", "create"), false);
});

test("legacy matrices (no settings grant at all) keep the personal areas only", () => {
  const legacy = ["deal:read", "account:*"];
  assert.equal(canSettings(legacy, "settings.profile", "update"), true);
  assert.equal(canSettings(legacy, "settings.security", "password"), true);
  assert.equal(canSettings(legacy, "settings.users", "read"), false, "admin areas stay closed");
  // Once any settings grant is present the fallback is off — the matrix rules.
  const explicit = ["deal:read", "settings.appearance:read"];
  assert.equal(canSettings(explicit, "settings.profile", "update"), false);
});

test("canAnySettings reports section visibility", () => {
  assert.equal(canAnySettings(["settings.users:password"], "settings.users"), true);
  assert.equal(canAnySettings(["settings.users:password"], "settings.mobile"), false);
});

test("administrative areas expand into the entity grants they need", () => {
  const expanded = expandSettingsGrants(["settings.users:read"]);
  for (const grant of ["user:read", "position:read", "pii:read", "settings.users:read"]) {
    assert.ok(expanded.includes(grant), `expected ${grant}`);
  }
  // A wildcard area grant expands every one of its actions.
  const wildcard = expandSettingsGrants(["settings.roles:*"]);
  for (const grant of ["position:read", "position:create", "position:update", "position:delete"]) {
    assert.ok(wildcard.includes(grant), `expected ${grant}`);
  }
  // Personal areas imply nothing extra.
  assert.deepEqual(expandSettingsGrants(["settings.profile:*"]), ["settings.profile:*"]);
});

test("every non-super-user role preset carries the personal settings grants", () => {
  for (const [name, def] of Object.entries(ROLES)) {
    if (def.grants.includes("*")) continue;
    for (const grant of SELF_SERVICE_SETTINGS_GRANTS) {
      assert.ok(def.grants.includes(grant), `${name} is missing ${grant}`);
    }
  }
  // The matrix presets served to the admin UI reflect it too.
  assert.ok(roleGrants("sales_rep").includes("settings.profile:*"));
  assert.equal(canSettings(roleGrants("sales_rep"), "settings.users", "read"), false);
});

test("user-setting keys map to the area that governs them", () => {
  assert.deepEqual(areaForUserSettingKey("mailSyncInterval"), {
    area: "settings.notifications",
    action: "mailSync",
  });
  assert.deepEqual(areaForUserSettingKey("theme"), { area: "settings.appearance", action: "update" });
});
