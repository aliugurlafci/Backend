/**
 * The permission engine, bound to THIS application's metadata registry.
 *
 * The rules live in `packages/contracts`; only the registry differs between the
 * two applications, so that is the one thing injected here. Keeping the
 * singleton in each app means no call site changed — `permissionEngine.can(...)`
 * reads the same everywhere it always did.
 *
 * Sharing the rules mattered: the copy that used to sit here derived its
 * decision-cache key from the role list alone, so a principal carrying explicit
 * matrix grants and one carrying identically-named roles shared a cache entry
 * and could be answered with each other's decision.
 */
import { PermissionEngine } from "@aula/contracts/permissions/engine";
import { metadata } from "@/lib/metadata";

export { PermissionEngine } from "@aula/contracts/permissions/engine";
export type { PermissionMetadata } from "@aula/contracts/permissions/engine";

export const permissionEngine = new PermissionEngine(metadata);
