/**
 * Shared helpers for the outbound integration transports (WhatsApp / Slack /
 * REST / ERP). Mirrors the small utilities in `sms-transport.ts`.
 */
import type { IntegrationConfig } from "@/lib/automation/integrations";

export interface TenantScope {
  tenantId: string;
  orgId: string;
}

export interface MessageResult {
  ok: boolean;
  /** Provider message / job id on success. */
  id?: string;
  /** Provider or transport error on failure. */
  error?: string;
  /** True when the integration is disabled or missing credentials — caller should fall back. */
  notConfigured?: boolean;
  /** HTTP status of the underlying call, when relevant (REST/ERP tests). */
  status?: number;
}

export const str = (c: IntegrationConfig, k: string): string => {
  const v = c[k];
  return v === undefined || v === null ? "" : String(v).trim();
};
export const bool = (c: IntegrationConfig, k: string): boolean => {
  const v = c[k];
  return v === true || v === "true" || v === 1 || v === "1";
};
export const num = (c: IntegrationConfig, k: string, def: number): number => {
  const n = Number(c[k]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export function notConfigured(error: string): MessageResult {
  return { ok: false, notConfigured: true, error };
}

/** fetch() with an abort-based timeout so a hung endpoint can't stall a run. */
export async function httpRequest(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Normalise an error into a short message (timeouts get a friendly label). */
export function errMessage(e: unknown, timeoutMs?: number): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return `Timed out${timeoutMs ? ` after ${timeoutMs}ms` : ""}`;
    return e.message;
  }
  return String(e);
}

/** Ensure a base URL has a scheme and no trailing slash. */
export function normBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}
