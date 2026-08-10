/**
 * Re-export. The definition lives in `packages/contracts`, which the backend
 * and the web app both read, so the two can no longer drift apart.
 *
 * This file stays as a re-export rather than being deleted so that every
 * `@/lib/...` import across the codebase keeps working — moving the source of
 * truth should not mean touching a hundred call sites.
 */
export * from "@aula/contracts/enforcement/errors";
