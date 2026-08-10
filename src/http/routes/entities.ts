/**
 * Metadata, the generic entity CRUD surface, and the reads built on top of it
 * (aggregate, stats, activity, search).
 */

import { type Router } from "express";
import { assertKnownEntity, parseIfMatch, parseListQuery, readJson, runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { permissionEngine } from "@/lib/permissions/engine";
import { metadata } from "@/lib/metadata";
import { search } from "@/lib/search/service";
import { cache } from "@/lib/cache/cache";
import { statsKey } from "@/lib/cache/invalidation";
import { aggregateSchema, parseBody, transitionSchema } from "@/lib/http/body";
import { BadRequestError, ForbiddenError } from "@/lib/enforcement/errors";
import {
  normalizePaging,
  type Dimension,
  type Filter,
  type Having,
  type Measure,
} from "@/lib/data/query";
import { isAdmin, visiblePositions, visibleUsers } from "@/lib/security/visibility";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { EntityDef } from "@/lib/metadata/types";
import { adminOnly, assertAdminRecordVisible, assertPositionPayloadDelegatable } from "./shared";

export function registerEntityRoutes(r: Router): void {
  // ---- metadata ---------------------------------------------------------
  r.get("/meta", runApi(async () => ({ version: metadata.version, entities: metadata.listEntities() })));

  r.get("/meta/:entity", runApi(async (_rc, req) => {
    assertKnownEntity(pathParam(req, "entity"));
    return metadata.getEntity(pathParam(req, "entity"));
  }));

  // ---- generic entity CRUD ---------------------------------------------
  // `user` and `position` carry administrative visibility on top of the
  // permission matrix (see lib/security/visibility): administrators are hidden
  // from everyone else, and the rest is scoped to the caller's creation subtree.
  r.get("/entities/:entity", runApi(async (rc, req) => {
    assertKnownEntity(pathParam(req, "entity"));
    const domain = await getDomainService();
    const query = parseListQuery(req, pathParam(req, "entity"));
    const entity = pathParam(req, "entity");

    // Visibility is a row-level predicate the SQL layer cannot express (it walks
    // the creation chain), so it has to run in memory — which means it has to run
    // BEFORE paging. Filtering a page and then reporting `total = items.length`
    // produced a wrong page count and made every user past the first page
    // unreachable, since the rows the filter removed were never replaced.
    //
    // Safe to materialise: both tables are administrative and bounded, and
    // `visibleUsers` already loads the full user set to compute the subtree.
    if (entity === "position" || entity === "user") {
      const all = await domain.listComplete(rc, entity, { ...query, page: undefined, pageSize: undefined });
      const visible = entity === "position" ? await visiblePositions(rc, all) : await visibleUsers(rc, all);
      const { page, pageSize } = normalizePaging(query);
      const start = (page - 1) * pageSize;
      return {
        items: visible.slice(start, start + pageSize),
        total: visible.length,
        page,
        pageSize,
        pageCount: Math.max(1, Math.ceil(visible.length / pageSize)),
      };
    }

    // `?cursor=` switches to keyset paging: the response carries `nextCursor`
    // instead of `total`/`page`/`pageCount`, because producing a total means
    // scanning the whole filtered set — most of what offset paging costs.
    //
    // Opt-in rather than the default: every existing screen reads `total` to
    // render a page count, and a list of 25 rows gains nothing from a cursor.
    // What gains is a client walking the whole table, which is the case that
    // was both slow and, under concurrent writes, wrong.
    //
    // `?cursor=first` starts a keyset walk without having a cursor yet; any
    // other value must be one this endpoint minted.
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (cursor !== undefined) {
      return domain.listByCursor(rc, entity, query, cursor === "first" ? undefined : cursor);
    }

    return domain.list(rc, entity, query);
  }));

  r.post(
    "/entities/:entity",
    runApi(
      async (rc, req) => {
        assertKnownEntity(pathParam(req, "entity"));
        const domain = await getDomainService();
        // NOT schema-checked here, deliberately. The body is an entity record,
        // and `domain.create`/`domain.update` validate it against the schema the
        // metadata generates for that entity — types, lengths, enums, required
        // fields and uniqueness, all derived from one definition. A zod schema at
        // this route would be a second description of the same thing, and the
        // moment an entity changed, the two would disagree with the copy here
        // winning. `Record<string, unknown>` is the honest type: it is an
        // arbitrary record until the metadata says otherwise.
        const body = readJson(req) as Record<string, unknown>;
        if (pathParam(req, "entity") === "position") {
          // Only an administrator may mint an admin-role position, and nobody
          // may hand out access they don't hold themselves.
          if (!isAdmin(rc) && String(body.role ?? "") === "admin") {
            throw new ForbiddenError("only an administrator may create an administrator position");
          }
          await assertPositionPayloadDelegatable(rc, body);
        }
        return domain.create(rc, pathParam(req, "entity"), body);
      },
      { mutating: true, status: 201 },
    ),
  );

  r.get("/entities/:entity/:id", runApi(async (rc, req) => {
    assertKnownEntity(pathParam(req, "entity"));
    await assertAdminRecordVisible(rc, pathParam(req, "entity"), pathParam(req, "id"));
    const domain = await getDomainService();
    return domain.get(rc, pathParam(req, "entity"), pathParam(req, "id"));
  }));

  r.patch(
    "/entities/:entity/:id",
    runApi(
      async (rc, req) => {
        assertKnownEntity(pathParam(req, "entity"));
        await assertAdminRecordVisible(rc, pathParam(req, "entity"), pathParam(req, "id"));
        // NOT schema-checked here, deliberately. The body is an entity record,
        // and `domain.create`/`domain.update` validate it against the schema the
        // metadata generates for that entity — types, lengths, enums, required
        // fields and uniqueness, all derived from one definition. A zod schema at
        // this route would be a second description of the same thing, and the
        // moment an entity changed, the two would disagree with the copy here
        // winning. `Record<string, unknown>` is the honest type: it is an
        // arbitrary record until the metadata says otherwise.
        const body = readJson(req) as Record<string, unknown>;
        if (pathParam(req, "entity") === "position") {
          if (!isAdmin(rc) && body.role !== undefined && String(body.role) === "admin") {
            throw new ForbiddenError("only an administrator may create an administrator position");
          }
          await assertPositionPayloadDelegatable(rc, body);
        }
        const domain = await getDomainService();
        return domain.update(rc, pathParam(req, "entity"), pathParam(req, "id"), body, parseIfMatch(req));
      },
      { mutating: true },
    ),
  );

  r.delete(
    "/entities/:entity/:id",
    runApi(
      async (rc, req) => {
        assertKnownEntity(pathParam(req, "entity"));
        await assertAdminRecordVisible(rc, pathParam(req, "entity"), pathParam(req, "id"));
        const domain = await getDomainService();
        await domain.remove(rc, pathParam(req, "entity"), pathParam(req, "id"), parseIfMatch(req));
        return { deleted: true, id: pathParam(req, "id") };
      },
      { mutating: true },
    ),
  );

  r.get("/entities/:entity/:id/audit", runApi(async (rc, req) => {
    assertKnownEntity(pathParam(req, "entity"));
    const domain = await getDomainService();
    await domain.get(rc, pathParam(req, "entity"), pathParam(req, "id")); // enforce read + scope
    return { entries: await domain.auditTrail(rc, pathParam(req, "entity"), pathParam(req, "id")) };
  }));

  r.get("/entities/:entity/:id/transitions", runApi(async (rc, req) => {
    assertKnownEntity(pathParam(req, "entity"));
    const domain = await getDomainService();
    return { actions: await domain.availableActions(rc, pathParam(req, "entity"), pathParam(req, "id")) };
  }));

  /**
   * Everything attached to one record, in a single response.
   *
   * Two kinds of relationship, deliberately answered together:
   *
   *  - **children** — records with a `reference` field pointing at this entity
   *    (an invoice's lines, an account's invoices). A real foreign key.
   *  - **satellites** — correspondence, calendar entries, notes and tasks, linked
   *    by the shared polymorphic `refType`/`refId` pair. There is no foreign key
   *    to follow, which is precisely why the pair is defined in one place: a
   *    satellite that spelled the columns differently would just be missing here,
   *    with no error to notice.
   *
   * This runs on the server because the discovery step needs the entity
   * registry. The browser used to do it: fetch `/meta` — every entity definition,
   * on every open — then issue one request per candidate child entity, which for
   * an account is a dozen sequential round trips. And it could never find the
   * satellites at all, because they are not reachable by walking reference
   * fields.
   *
   * Only `{ id, title }` is returned. The drawer renders a link label; sending
   * whole records would put fields on the wire that nothing displays.
   *
   * Every read goes through the query engine, so the caller sees only what they
   * were already entitled to. An entity they cannot read is skipped rather than
   * failing the request — a salesperson opening an invoice should see its
   * correspondence without being refused over an entity they have no access to.
   */
  r.get("/entities/:entity/:id/related", runApi(async (rc, req) => {
    assertKnownEntity(pathParam(req, "entity"));
    const entity = pathParam(req, "entity");
    const id = pathParam(req, "id");
    const domain = await getDomainService();
    await domain.get(rc, entity, id); // enforce read + tenant scope on the anchor

    const qe = await getQueryEngine();
    const groups: Array<{
      entity: string;
      label: string;
      pluralLabel: string;
      link: "child" | "satellite";
      items: Array<{ id: string; title: string }>;
    }> = [];

    const readable = (name: string): boolean =>
      permissionEngine.can(rc, { action: `${name}:read`, entity: name });

    /** Read a page and reduce it to link labels. */
    const collect = async (
      def: EntityDef,
      filters: Filter[],
      link: "child" | "satellite",
    ): Promise<void> => {
      const page = await qe.list(rc, def.name, {
        filters,
        sort: [{ field: "createdAt", dir: "desc" }],
        // Capped: this is a navigation aid, not an export. A record with
        // thousands of children would otherwise make opening the drawer slow
        // enough to look broken.
        pageSize: 50,
      });
      if (page.items.length === 0) return;
      groups.push({
        entity: def.name,
        label: def.label,
        pluralLabel: def.pluralLabel ?? def.label,
        link,
        items: page.items.map((r) => ({
          id: String(r.id),
          title: String(r[def.titleField] ?? r.id),
        })),
      });
    };

    // Satellites first — what someone said or planned about this record is
    // usually the reason they opened the tab.
    const satelliteFilters: Filter[] = [
      { field: "refType", op: "eq", value: entity },
      { field: "refId", op: "eq", value: id },
    ];
    for (const name of ["email", "calendarEvent", "note", "task"]) {
      const def = metadata.findEntity(name);
      if (!def || !readable(name)) continue;
      await collect(def, satelliteFilters, "satellite");
    }

    // Children: any entity with a reference field aimed at this one.
    for (const def of metadata.listEntities()) {
      if (def.name === entity || !readable(def.name)) continue;
      const refField = def.fields.find(
        (f) => f.type === "reference" && f.referenceEntity === entity,
      );
      if (!refField) continue;
      await collect(def, [{ field: refField.name, op: "eq", value: id }], "child");
    }

    return { groups };
  }));

  r.post(
    "/entities/:entity/:id/transitions",
    runApi(
      async (rc, req) => {
        assertKnownEntity(pathParam(req, "entity"));
        const body = parseBody(req, transitionSchema);
        if (!body.action) throw new BadRequestError("`action` is required");
        const domain = await getDomainService();
        return domain.transition(rc, pathParam(req, "entity"), pathParam(req, "id"), body.action, parseIfMatch(req));
      },
      { mutating: true },
    ),
  );

  // ---- aggregation / stats / activity / search -------------------------
  r.post(
    "/aggregate",
    runApi(async (rc, req) => {
      // Validated rather than cast. An empty `measures` array reached the
      // repository and produced `SELECT  FROM …` — a database syntax error
      // surfaced to the caller as a 500, i.e. their mistake reported as ours.
      const parsed = parseBody(req, aggregateSchema);
      const body = parsed as unknown as {
        entity: string;
        groupBy?: string;
        dimensions?: Dimension[];
        measures?: Measure[];
        filters?: Filter[];
        having?: Having[];
        sort?: { by: string; dir: "asc" | "desc" }[];
        limit?: number;
      };
      assertKnownEntity(body.entity);

      // Shape the body before it reaches the repository. An empty `measures`
      // array used to reach the SQL builder and produce `SELECT  FROM …`, which
      // surfaced as a 500 rather than the 400 it is. The other bounds keep one
      // request from asking for an unreasonably wide result.
      const measures = body.measures ?? [];
      if (measures.length === 0) throw new BadRequestError("aggregate requires at least one measure");
      if (measures.length > 12) throw new BadRequestError("aggregate accepts at most 12 measures");
      const dimensions = body.dimensions ?? [];
      if (dimensions.length > 4) throw new BadRequestError("aggregate accepts at most 4 dimensions");
      if (body.limit !== undefined && (!Number.isFinite(body.limit) || body.limit < 1)) {
        throw new BadRequestError("aggregate limit must be a positive number");
      }

      const domain = await getDomainService();
      const rows = await domain.aggregate(rc, body.entity, {
        groupBy: body.groupBy,
        dimensions: body.dimensions,
        measures,
        filters: body.filters,
        having: body.having,
        sort: body.sort,
        limit: body.limit,
      });
      return { rows };
    }),
  );

  r.get("/stats", runApi(async (rc) => {
    return cache.wrap(statsKey(rc.tenantId, rc.orgId), 30_000, async () => {
      const domain = await getDomainService();
      // Group in SQL, not in JS. Reading 1,000 deals and summing them here was
      // wrong twice over: the page size was clamped to MAX_PAGE_SIZE, so every
      // figure below silently stopped counting at 200 deals.
      const [accounts, deals, tasks, byStage] = await Promise.all([
        domain.list(rc, "account", { pageSize: 1 }),
        domain.list(rc, "deal", { pageSize: 1 }),
        domain.list(rc, "task", { pageSize: 1 }),
        domain.aggregate(rc, "deal", {
          groupBy: "stage",
          measures: [
            { op: "count", as: "count" },
            { op: "sum", field: "amount", as: "value" },
          ],
        }),
      ]);

      const pipelineByStage: Record<string, { count: number; value: number }> = {};
      let openPipeline = 0;
      let won = 0;
      for (const row of byStage) {
        const stage = row.key == null || row.key === "" ? "lead" : String(row.key);
        const count = row.measures.count ?? 0;
        const value = row.measures.value ?? 0;
        // Rows are grouped on the raw column, so a null and an empty stage both
        // fold into "lead" — accumulate rather than assign.
        pipelineByStage[stage] ??= { count: 0, value: 0 };
        pipelineByStage[stage].count += count;
        pipelineByStage[stage].value += value;
        if (stage === "won") won += value;
        else if (stage !== "lost") openPipeline += value;
      }

      return {
        counts: { account: accounts.total, deal: deals.total, task: tasks.total },
        pipelineByStage,
        openPipeline,
        wonValue: won,
        cachedAt: rc.at,
      };
    });
  }));

  r.get("/activity", runApi(async (rc, req) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.floor(raw))) : 12;
    const domain = await getDomainService();
    const entries = await domain.recentActivity(rc, limit);
    // Resolve actor ids → display names. The user table is admin-scoped, so read
    // it through a system context; "system" is the platform/automation actor.
    const nameById = new Map<string, string>();
    // Read only the actors actually referenced by this page of activity, rather
    // than the whole user table (which was capped, so names beyond the cap
    // rendered as raw ids).
    const actorIds = [...new Set(entries.map((e) => String(e.actorId)).filter((id) => id && id !== "system"))];
    if (actorIds.length > 0) {
      try {
        const users = await domain.listComplete(systemContext(rc.tenantId, rc.orgId), "user", {
          filters: [{ field: "id", op: "in", value: actorIds }],
        });
        for (const u of users) nameById.set(String(u.id), String(u.displayName ?? u.email ?? u.id));
      } catch {
        /* user read unavailable — fall back to raw id */
      }
    }
    const enriched = entries.map((e) => ({
      ...e,
      actorName: e.actorId === "system" ? "System" : nameById.get(String(e.actorId)) ?? String(e.actorId),
    }));
    return { entries: enriched };
  }));

  r.get("/search", runApi(async (rc, req) => {
    const term = (req.query.q as string) ?? "";
    const entitiesParam = req.query.entity;
    const entities = Array.isArray(entitiesParam)
      ? (entitiesParam as string[])
      : entitiesParam
        ? [entitiesParam as string]
        : undefined;
    return { query: term, hits: await search(rc, term, { entities, limit: 20 }) };
  }));

  /**
   * Rebuild the search index from the records themselves — admin only.
   *
   * Startup no longer does this. The index is a table now, so rebuilding it on
   * every boot would clear what the other instances are serving from, which
   * turns a rolling restart into an outage for search. It is rebuilt on first
   * boot, when the index is empty, and here when someone has reason to think it
   * has drifted.
   *
   * Awaited rather than backgrounded: an admin who asks for a rebuild wants to
   * know it finished, and a response that returns before the work is done is
   * how you end up running it four more times.
   */
  r.post(
    "/search/reindex",
    runApi(
      async (rc) => {
        adminOnly(rc);
        const { reindexAll } = await import("@/lib/search/indexer");
        await reindexAll({ force: true });
        const { searchStore } = await import("@/lib/search/store");
        return { ok: true, documents: await searchStore().size(rc) };
      },
      { mutating: true },
    ),
  );
}
