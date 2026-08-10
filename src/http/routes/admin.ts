/**
 * Screen catalogue, mobile screen configuration, the permission catalogue, user
 * administration, system settings and metadata releases — the Settings screens.
 */

import { type Router } from "express";
import { runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { roleGrants, GRANTABLE_SYSTEM_ENTITIES } from "@/lib/permissions/policies";
import { metadata } from "@/lib/metadata";
import { automationStore, SYSTEM_SETTINGS } from "@/lib/automation";
import { publishMetadata } from "@/lib/config/governance";
import { releaseLog } from "@/lib/config/release";
import { schemaStatus } from "@/lib/data/sql/migrate";
import {
  createUserSchema,
  customFieldSchema,
  parseBody,
  mobileConfigSchema,
  settingsBagSchema,
  updateUserSchema,
} from "@/lib/http/body";
import { usingInMemoryBackends } from "@/lib/config/env";
import { bumpTokenEpoch } from "@/lib/security/revocation";
import { BadRequestError, ForbiddenError } from "@/lib/enforcement/errors";
import { assertPositionVisible, assertUserVisible, isAdmin, visibleUsers } from "@/lib/security/visibility";
import { callerScreens, narrowCatalog } from "@/lib/security/delegation";
import { hashPassword } from "@/lib/security/crypto";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import { screenCatalog } from "@/lib/config/screens";
import { SETTINGS_AREAS } from "@/lib/config/settings-permissions";
import { resolveMobileConfig, mobileScreenCatalog } from "@/lib/mobile/service";
import { adminOnly, assertMobileConfigDelegatable, assertPasswordStrength, assertSettings, stripHash } from "./shared";

export function registerAdminRoutes(r: Router): void {
  // Screen catalog (for nav + the admin position editor).
  r.get("/screens", runApi(async () => ({ screens: screenCatalog(metadata) })));

  // ---- mobile screen configuration -------------------------------------
  // The companion app's screen visibility is curated here. `GET /mobile/config`
  // is the per-user resolved view the app polls; the rest are admin tools.

  // Resolved config for the signed-in user (app foreground/login + ~60s poll).
  r.get("/mobile/config", runApi(async (rc, req) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "*";
    return resolveMobileConfig(rc, clientId);
  }));

  // Toggleable screen catalog (full web catalog, flagged with mobile support).
  r.get("/mobile/screens", runApi(async (rc) => {
    assertSettings(rc, "settings.mobile", "read");
    // Only the screens the caller can open themselves are configurable.
    const own = await callerScreens(rc);
    return { screens: mobileScreenCatalog().filter((s) => own.has(s.key)) };
  }));

  // Admin CRUD over the raw config rows. `screens`/`hiddenFields` are persisted
  // as JSON text; accept either the parsed shape or a pre-stringified value.
  const asJsonText = (value: unknown, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  };

  r.get("/mobile/configs", runApi(async (rc) => {
    assertSettings(rc, "settings.mobile", "read");
    const domain = await getDomainService();
    const rows = await domain.listComplete(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", {
      sort: [{ field: "updatedAt", dir: "desc" }],
    });
    const configs = rows.map((row) => ({
      id: String(row.id),
      clientId: String(row.clientId ?? "*"),
      positionId: (row.positionId as string | null) || null,
      userId: (row.userId as string | null) || null,
      screens: JSON.parse(String(row.screens ?? "[]")) as string[],
      hiddenFields: JSON.parse(String(row.hiddenFields ?? "{}")) as Record<string, string[]>,
      active: row.active !== false,
      version: Number(row.version ?? 0),
      updatedAt: String(row.updatedAt ?? ""),
    }));
    return { configs };
  }));

  r.post(
    "/mobile/configs",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.mobile", "create");
        const body = parseBody(req, mobileConfigSchema) as Record<string, unknown>;
        await assertMobileConfigDelegatable(rc, body);
        const domain = await getDomainService();
        const created = await domain.create(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", {
          clientId: String(body.clientId ?? "*") || "*",
          positionId: body.positionId ? String(body.positionId) : null,
          userId: body.userId ? String(body.userId) : null,
          screens: asJsonText(body.screens, "[]"),
          hiddenFields: asJsonText(body.hiddenFields, "{}"),
          active: body.active === undefined ? true : Boolean(body.active),
        });
        return { id: String(created.id) };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.patch(
    "/mobile/configs/:id",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.mobile", "update");
        const body = parseBody(req, mobileConfigSchema) as Record<string, unknown>;
        await assertMobileConfigDelegatable(rc, body);
        const patch: Record<string, unknown> = {};
        if (body.clientId !== undefined) patch.clientId = String(body.clientId) || "*";
        if (body.positionId !== undefined) patch.positionId = body.positionId ? String(body.positionId) : null;
        if (body.userId !== undefined) patch.userId = body.userId ? String(body.userId) : null;
        if (body.screens !== undefined) patch.screens = asJsonText(body.screens, "[]");
        if (body.hiddenFields !== undefined) patch.hiddenFields = asJsonText(body.hiddenFields, "{}");
        if (body.active !== undefined) patch.active = Boolean(body.active);
        const domain = await getDomainService();
        const updated = await domain.update(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", pathParam(req, "id"), patch);
        return { id: String(updated.id) };
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/mobile/configs/:id",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.mobile", "delete");
        const domain = await getDomainService();
        await domain.remove(systemContext(rc.tenantId, rc.orgId), "mobileScreenConfig", pathParam(req, "id"));
        return { deleted: true, id: pathParam(req, "id") };
      },
      { mutating: true },
    ),
  );

  // Permission catalog — every entity's grantable operations, the Settings-screen
  // areas + their operations, the special (non-entity) grants, and each base
  // role's default grants (matrix presets).
  r.get("/permissions/catalog", runApi(async (rc) => {
    assertSettings(rc, "settings.roles", "read");
    const CRUD = ["read", "create", "update", "delete"];
    const entities = metadata
      .listEntities()
      .filter((e) => !e.system || GRANTABLE_SYSTEM_ENTITIES.has(e.name))
      .map((e) => {
        // Operations = CRUD + the entity's own lifecycle actions (post/approve/win…).
        const extra = new Set<string>();
        for (const tr of e.lifecycle?.transitions ?? []) {
          if (!tr.requires) continue;
          const [ent, verb] = tr.requires.split(":");
          if (ent === e.name && verb && !CRUD.includes(verb)) extra.add(verb);
        }
        return { name: e.name, group: e.group ?? "crm", actions: [...CRUD, ...extra] };
      });
    // Non-entity grants that gate bespoke operations.
    const special = ["pos:checkout", "pii:read"];
    const roles = ["admin", "sales_manager", "sales_rep", "accountant", "warehouse_manager"].map((role) => ({
      value: role,
      grants: roleGrants(role),
    }));
    // The Settings screen, area by area — the fine-grained layer on top of the
    // coarse `settings` screen key. Narrowed to what this caller may delegate:
    // nobody hands out a privilege they don't hold themselves.
    return narrowCatalog(rc, { entities, special, roles, settings: SETTINGS_AREAS });
  }));

  // The screens a caller may grant to a position — their own screen access
  // (everything, for an administrator). Drives both the position editor and the
  // mobile-visibility screens so neither can offer more than the caller has.
  r.get("/screens/grantable", runApi(async (rc) => {
    const own = await callerScreens(rc);
    return { screens: screenCatalog(metadata).filter((s) => own.has(s.key)) };
  }));

  // ---- user administration ----------------------------------------------
  // Administrators always pass; other positions need the `settings.users` grants
  // an admin ticked in the permission matrix (read / create / update / password
  // / twoFactor / activate are separately grantable).
  r.get("/admin/users", runApi(async (rc) => {
    assertSettings(rc, "settings.users", "read");
    const domain = await getDomainService();
    // Unpaged endpoint: it must return the caller's whole visible set, and
    // visibility is applied in memory, so the read has to be complete.
    const all = await domain.listComplete(rc, "user", { sort: [{ field: "displayName", dir: "asc" }] });
    // Non-admins see only their own creation subtree, never an administrator.
    const visible = await visibleUsers(rc, all);
    return { users: visible.map(stripHash) };
  }));

  r.post(
    "/admin/users",
    runApi(
      async (rc, req) => {
        assertSettings(rc, "settings.users", "create");
        const body = parseBody(req, createUserSchema);
        if (!body.email || !body.password || !body.positionId) {
          throw new BadRequestError("email, password and positionId are required");
        }
        // A creator may only hand out a position they can see themselves, and
        // only assign a manager from their own subtree.
        await assertPositionVisible(rc, body.positionId);
        if (body.managerId) await assertUserVisible(rc, String(body.managerId));
        assertPasswordStrength(body.password);
        const domain = await getDomainService();
        // Go through the domain service (not the raw query engine) so a
        // `user.created` event is emitted — letting automations/webhooks fire
        // when an admin adds a user (e.g. "email the newly-added user").
        const record = await domain.createWithComputed(
          rc,
          "user",
          {
            email: body.email.toLowerCase(),
            displayName: body.displayName || body.email,
            positionId: body.positionId,
            companyId: body.companyId || null,
            active: body.active ?? true,
            managerId: body.managerId || null,
            phone: body.phone || null,
            jobTitle: body.jobTitle || null,
          },
          { passwordHash: await hashPassword(body.password) },
        );
        return stripHash(record);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.patch(
    "/admin/users/:id",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, updateUserSchema);
        // Administrators are off-limits to everyone else, and a non-admin may
        // only touch users (and hand out positions) inside their own subtree.
        await assertUserVisible(rc, pathParam(req, "id"));
        if (body.positionId) await assertPositionVisible(rc, body.positionId);
        if (body.managerId) await assertUserVisible(rc, String(body.managerId));
        // Editing a user, resetting their password, clearing their second factor
        // and enabling/disabling the account are separate privileges.
        const editKeys = ["displayName", "email", "positionId", "managerId", "phone", "jobTitle"] as const;
        if (editKeys.some((k) => body[k] !== undefined)) assertSettings(rc, "settings.users", "update");
        if (body.password !== undefined) assertSettings(rc, "settings.users", "password");
        if (body.resetTwoFactor) assertSettings(rc, "settings.users", "twoFactor");
        if (body.active !== undefined) assertSettings(rc, "settings.users", "activate");
        // A manager can't be their own supervisor.
        if (body.managerId && String(body.managerId) === pathParam(req, "id")) {
          throw new BadRequestError("a user cannot be their own manager");
        }
        const domain = await getDomainService();
        const patch: Record<string, unknown> = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.email !== undefined) patch.email = String(body.email).toLowerCase();
        if (body.positionId !== undefined) patch.positionId = body.positionId;
        if (body.companyId !== undefined) patch.companyId = body.companyId || null;
        if (body.active !== undefined) patch.active = body.active;
        if (body.managerId !== undefined) patch.managerId = body.managerId || null;
        if (body.phone !== undefined) patch.phone = body.phone || null;
        if (body.jobTitle !== undefined) patch.jobTitle = body.jobTitle || null;
        let record = Object.keys(patch).length
          ? await domain.update(rc, "user", pathParam(req, "id"), patch)
          : await domain.get(rc, "user", pathParam(req, "id"));
        const qe = await getQueryEngine();
        if (body.password) {
          assertPasswordStrength(body.password);
          record = await qe.patchComputed(rc, "user", pathParam(req, "id"), { passwordHash: await hashPassword(body.password) });
        }
        // Admin recovery: clear a user's two-factor enrollment (e.g. lost device).
        if (body.resetTwoFactor) {
          record = await qe.patchComputed(rc, "user", pathParam(req, "id"), { twoFactorEnabled: false, twoFactorSecret: null });
        }

        // Anything that changes what this person may do, or whether they may be
        // here at all, must end their current sessions — the grants are baked
        // into the token they are already holding. Without this, taking away a
        // role, disabling an account or resetting a password left the old
        // authority working until the token expired, which is exactly the window
        // an administrator believes they just closed.
        const revoking =
          body.positionId !== undefined ||
          body.password !== undefined ||
          body.resetTwoFactor === true ||
          body.active === false;
        if (revoking) {
          await bumpTokenEpoch(pathParam(req, "id"), "admin-changed-access");
        }
        return stripHash(record);
      },
      { mutating: true },
    ),
  );


  // ---- system / environment settings (admin only; stored in the DB) ----
  r.get("/system/settings", runApi(async (rc) => {
    adminOnly(rc);
    return {
      groups: [...new Set(SYSTEM_SETTINGS.map((s) => s.group))],
      settings: await automationStore.getSystemSettings(rc.tenantId, rc.orgId),
    };
  }));

  r.patch(
    "/system/settings",
    runApi(
      async (rc, req) => {
        adminOnly(rc);
        const body = parseBody(req, settingsBagSchema) as Record<string, unknown>;
        return { settings: await automationStore.updateSystemSettings(rc.tenantId, rc.orgId, body) };
      },
      { mutating: true },
    ),
  );


  // ---- custom fields ----------------------------------------------------
  //
  // The registry already does versioned publish; the schema already heals itself
  // towards the metadata. What was missing was somewhere to keep a definition
  // between restarts, which is all `customField` is — the field it describes
  // goes through exactly the same validation, DDL and API generation as one
  // written by hand.
  r.get("/admin/custom-fields", runApi(async (rc) => {
    assertSettings(rc, "settings.model", "read");
    const domain = await getDomainService();
    const rows = await domain.listComplete(rc, "customField", {});
    return {
      items: [...rows].sort(
        (a, b) =>
          String(a.entityName).localeCompare(String(b.entityName)) ||
          Number(a.position ?? 0) - Number(b.position ?? 0),
      ),
      // Which entities may be extended, so a UI does not offer the system
      // tables that exist to serve the engine rather than the business.
      entities: metadata
        .listEntities()
        .filter((e) => !e.system)
        .map((e) => ({ name: e.name, label: e.label })),
    };
  }));

  r.post(
    "/admin/custom-fields",
    runApi(
      async (rc, req) => {
        if (!isAdmin(rc)) throw new ForbiddenError("only an administrator may change the data model");
        const body = parseBody(req, customFieldSchema);
        const { assertValidField, fieldKeyOf, applyCustomFields } = await import("@/lib/metadata/custom-fields");

        // Validated against the CURRENT model, so a name that collides with a
        // built-in added since the last release is refused rather than silently
        // shadowed.
        const entity = metadata.getEntity(body.entityName);
        if (entity.system) throw new BadRequestError(`${entity.label} is a system table and cannot be extended`).withKey("err.systemTableNoExtend", { entity: entity.name });
        assertValidField(body, entity);

        const domain = await getDomainService();
        await domain.create(rc, "customField", {
          ...body,
          fieldKey: fieldKeyOf(body.entityName, body.name),
          active: true,
        });

        // Republish and reconcile immediately: a field somebody just added and
        // cannot yet use is indistinguishable from one that failed to save.
        const applied = await applyCustomFields(rc);
        return { ok: true, ...applied };
      },
      { mutating: true, status: 201 },
    ),
  );

  /**
   * Retire a field.
   *
   * Deactivates it — the column and its data stay. A mis-click should not drop
   * a column somebody spent a year filling in, and "it disappeared from the
   * form" is a recoverable mistake in a way that "it is gone" is not.
   */
  r.delete(
    "/admin/custom-fields/:id",
    runApi(
      async (rc, req) => {
        if (!isAdmin(rc)) throw new ForbiddenError("only an administrator may change the data model");
        const domain = await getDomainService();
        await domain.update(rc, "customField", pathParam(req, "id"), { active: false });
        const { applyCustomFields } = await import("@/lib/metadata/custom-fields");
        return { ok: true, ...(await applyCustomFields(rc)) };
      },
      { mutating: true },
    ),
  );

  // ---- admin governance / releases -------------------------------------
  r.post(
    "/admin/metadata/republish",
    runApi(
      async (rc) => {
        if (!isAdmin(rc)) throw new ForbiddenError("only an administrator may re-publish the data model");
        const published = publishMetadata(rc, metadata.version, "re-published from settings");
        return { version: published.version, publishedAt: published.publishedAt, publishedBy: published.publishedBy };
      },
      { mutating: true },
    ),
  );

  r.get("/admin/releases", runApi(async (rc) => {
    assertSettings(rc, "settings.releases", "read");
    // Real applied schema versions from the `_schema_migrations` ledger (empty in
    // memory mode, which has no physical schema).
    const migrations = usingInMemoryBackends ? [] : await schemaStatus().catch(() => []);
    return { releases: releaseLog.list(), migrations };
  }));

}
