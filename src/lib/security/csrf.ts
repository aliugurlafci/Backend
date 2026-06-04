/**
 * Phase 13 — CSRF protection (double-submit cookie).
 *
 * State-changing requests must echo the CSRF cookie value in a header; the two
 * are compared in constant time.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_COOKIE = "aula_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function issueCsrfToken(): string {
  return randomBytes(24).toString("hex");
}

export function verifyCsrf(headerToken: string | null, cookieToken: string | null): boolean {
  if (!headerToken || !cookieToken) return false;
  const a = Buffer.from(headerToken);
  const b = Buffer.from(cookieToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
