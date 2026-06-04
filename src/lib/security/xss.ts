/**
 * Phase 13 — XSS protection: HTML output encoding.
 *
 * React escapes by default in JSX; this helper covers the cases where strings
 * are placed into non-React contexts (exports, emails, raw responses).
 */
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}
