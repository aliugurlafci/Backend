/**
 * The API router's shape.
 *
 * `api.ts` used to be one 3,640-line file; it is now fourteen domain modules
 * registered in order. Express resolves by registration order, so splitting a
 * file into modules that mount in a different order is exactly the kind of
 * refactor that changes behaviour without changing a line of handler code.
 *
 * What this pins is the property that makes the order safe: no route may be
 * registered ahead of one it would swallow. `GET /inventory/:id` mounted before
 * `GET /inventory/on-hand` compiles, lints, and answers the wrong handler with
 * `id = "on-hand"` — and only in production, where somebody has an inventory
 * screen that stopped working.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { buildApiRouter } = await import("@/http/api");

interface Route {
  methods: Set<string>;
  path: string;
}

function routeTable(): Route[] {
  const out: Route[] = [];
  for (const layer of buildApiRouter().stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
    if (!layer.route) continue;
    out.push({
      path: layer.route.path,
      methods: new Set(Object.entries(layer.route.methods).filter(([, on]) => on).map(([m]) => m)),
    });
  }
  return out;
}

/** An Express path as the regex it effectively matches (`:id` → one segment). */
function matcher(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/:[A-Za-z_]\w*/g, "[^/]+")}$`);
}

test("no route is shadowed by an earlier one", () => {
  const routes = routeTable();
  const shadowed: string[] = [];
  for (let i = 0; i < routes.length; i++) {
    const earlier = routes[i];
    if (!earlier!.path.includes(":")) continue; // a literal can only shadow itself
    const re = matcher(earlier!.path);
    for (const later of routes.slice(i + 1)) {
      const overlap = [...earlier!.methods].some((m) => later.methods.has(m));
      if (overlap && re.test(later.path)) {
        shadowed.push(`${later.path} is unreachable behind ${earlier!.path}`);
      }
    }
  }
  assert.deepEqual(shadowed, []);
});

test("no path is registered twice for the same method", () => {
  // Two handlers on one method+path is always a mistake: the second never runs.
  // It is the likeliest way for the split to go wrong — the same range pasted
  // into two modules.
  const seen = new Map<string, number>();
  for (const r of routeTable()) {
    for (const m of r.methods) {
      const key = `${m.toUpperCase()} ${r.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  assert.deepEqual([...seen].filter(([, n]) => n > 1), []);
});

test("every domain module contributes routes", () => {
  // A module that registers nothing means its ranges were dropped in the split
  // and every endpoint it owned is silently gone — the failure mode a route
  // count alone would not catch, since the total would simply be lower.
  const prefixes = [
    "/auth/", "/admin/", "/entities/", "/export/", "/quotes", "/purchase-orders",
    "/accounting/", "/inventory/", "/pos/", "/automation/", "/webhooks", "/files/",
    "/email/", "/health",
  ];
  const paths = routeTable().map((r) => r.path);
  const missing = prefixes.filter((p) => !paths.some((path) => path.startsWith(p)));
  assert.deepEqual(missing, []);
});
