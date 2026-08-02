/**
 * Administrative record visibility — who may see (and touch) which users and
 * positions.
 *
 * The permission matrix answers "may this position manage users at all?". This
 * module answers the narrower question of *which* users and positions a
 * non-administrator may act on:
 *
 *  - The administrator account and every admin-role position are invisible to
 *    everyone except administrators. They cannot be listed, opened, edited, have
 *    their password reset or be assigned.
 *  - Everything else is scoped to the caller's creation subtree: the records
 *    they created, plus everything created by the users they created, and so on.
 *    A dealer manager therefore manages their whole team, but never anyone
 *    else's.
 *
 * Administrators bypass all of it.
 */
import { ORG_ID, TENANT_ID } from "@/lib/config/env";
import { systemContext } from "@/lib/context/resolver";
import type { RequestContext } from "@/lib/context/types";
import { getQueryEngine } from "@/lib/data/store";
import { ForbiddenError } from "@/lib/enforcement/errors";
import type { EntityRecord } from "@/lib/metadata/types";

const sys = () => systemContext(TENANT_ID, ORG_ID);

export function isAdmin(rc: RequestContext): boolean {
  return rc.roles.includes("admin") || rc.isSystem;
}

/** Every user row in the tenant (system-scoped — visibility is applied on top). */
async function allUsers(): Promise<EntityRecord[]> {
  const qe = await getQueryEngine();
  const page = await qe.list(sys(), "user", { pageSize: 1000 });
  return page.items;
}

async function allPositions(): Promise<EntityRecord[]> {
  const qe = await getQueryEngine();
  const page = await qe.list(sys(), "position", { pageSize: 500 });
  return page.items;
}

/** Position ids whose role is `admin` — the ones non-admins may never see. */
async function adminPositionIds(): Promise<Set<string>> {
  const positions = await allPositions();
  return new Set(positions.filter((p) => String(p.role) === "admin").map((p) => String(p.id)));
}

/**
 * The caller plus every user beneath them in the creation chain: users they
 * created, users those users created, and so on. Cycles (a user somehow created
 * by their own descendant) terminate on the visited set.
 */
export async function creatorSubtree(rc: RequestContext): Promise<Set<string>> {
  const users = await allUsers();
  const children = new Map<string, string[]>();
  for (const u of users) {
    const parent = String(u.createdBy ?? "");
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(String(u.id));
    children.set(parent, list);
  }
  const seen = new Set<string>([rc.userId]);
  const queue = [rc.userId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/**
 * Narrow a list of user rows to what the caller may see: their creation subtree,
 * never an administrator. The caller's own row is always included.
 */
export async function visibleUsers(rc: RequestContext, users: EntityRecord[]): Promise<EntityRecord[]> {
  if (isAdmin(rc)) return users;
  const [subtree, adminPositions] = await Promise.all([creatorSubtree(rc), adminPositionIds()]);
  return users.filter((u) => {
    if (adminPositions.has(String(u.positionId ?? ""))) return false;
    return subtree.has(String(u.id));
  });
}

/** Throw unless the caller may act on this user id. */
export async function assertUserVisible(rc: RequestContext, userId: string): Promise<void> {
  if (isAdmin(rc)) return;
  const qe = await getQueryEngine();
  let user: EntityRecord;
  try {
    user = await qe.get(sys(), "user", userId);
  } catch {
    throw new ForbiddenError("this user is not visible to you");
  }
  const [subtree, adminPositions] = await Promise.all([creatorSubtree(rc), adminPositionIds()]);
  if (adminPositions.has(String(user.positionId ?? ""))) {
    throw new ForbiddenError("administrator accounts can only be managed by an administrator");
  }
  if (!subtree.has(String(user.id))) {
    throw new ForbiddenError("this user is not visible to you");
  }
}

/**
 * Narrow a list of position rows: never an admin-role position, and only the
 * ones created by someone in the caller's subtree. The caller's own position is
 * always included so their profile and permission screens keep working.
 */
export async function visiblePositions(rc: RequestContext, positions: EntityRecord[]): Promise<EntityRecord[]> {
  if (isAdmin(rc)) return positions;
  const subtree = await creatorSubtree(rc);
  return positions.filter((p) => {
    if (String(p.role) === "admin") return false;
    if (rc.positionId && String(p.id) === rc.positionId) return true;
    return subtree.has(String(p.createdBy ?? ""));
  });
}

/** Throw unless the caller may act on this position id. */
export async function assertPositionVisible(rc: RequestContext, positionId: string): Promise<void> {
  if (isAdmin(rc)) return;
  const qe = await getQueryEngine();
  let position: EntityRecord;
  try {
    position = await qe.get(sys(), "position", positionId);
  } catch {
    throw new ForbiddenError("this position is not visible to you");
  }
  const visible = await visiblePositions(rc, [position]);
  if (visible.length === 0) throw new ForbiddenError("this position is not visible to you");
}
