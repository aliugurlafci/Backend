/** Phase 10 — className combiner (dependency-free). */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter((v) => typeof v === "string" && v.length > 0).join(" ");
}
