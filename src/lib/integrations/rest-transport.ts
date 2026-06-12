/**
 * REST transport — generic authenticated outbound HTTP using the tenant's
 * REST / API integration (Automation → Integrations → REST / API).
 *
 * Applies the configured auth (bearer / basic / API key / OAuth2 client
 * credentials), default headers, content-type and optional HMAC request signing.
 * The automation `webhook` action routes through this when the integration is
 * enabled, so outbound calls carry the right auth without per-action config.
 */
import { createHmac } from "node:crypto";
import { automationStore } from "@/lib/automation/store";
import type { IntegrationConfig } from "@/lib/automation/integrations";
import { logger } from "@/lib/observability/logger";
import { str, num, notConfigured, httpRequest, errMessage, normBase, type MessageResult, type TenantScope } from "./transport-util";

export interface RestRequestInput {
  /** HTTP method; defaults to the integration's configured default method. */
  method?: string;
  /** Absolute URL, or a path/relative URL resolved against the configured base URL. */
  url?: string;
  /** JSON-serialisable payload (omitted for GET/HEAD). */
  body?: unknown;
  /** Extra per-call headers. */
  headers?: Record<string, string>;
  /**
   * When true, only apply the integration's auth if an absolute `url` shares the
   * configured base URL's origin — so a generic webhook to a third-party host
   * doesn't leak the configured credentials. (Relative URLs always qualify.)
   */
  sameOriginOnly?: boolean;
}

// OAuth2 client-credentials tokens, cached per (tokenUrl, clientId) until expiry.
const tokenCache = new Map<string, { token: string; exp: number }>();

async function oauthToken(c: IntegrationConfig, timeoutMs: number): Promise<string | null> {
  const tokenUrl = str(c, "tokenUrl");
  const clientId = str(c, "clientId");
  const clientSecret = str(c, "clientSecret");
  if (!tokenUrl || !clientId || !clientSecret) return null;
  const key = `${tokenUrl}|${clientId}`;
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && cached.exp > now + 5000) return cached.token;

  const params = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const scope = str(c, "scope");
  if (scope) params.set("scope", scope);
  const res = await httpRequest(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() }, timeoutMs);
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) return null;
  tokenCache.set(key, { token: data.access_token, exp: now + (data.expires_in ? data.expires_in * 1000 : 3_600_000) });
  return data.access_token;
}

function resolveUrl(base: string, input: RestRequestInput): string {
  const u = (input.url ?? "").trim();
  if (u && /^https?:\/\//i.test(u)) return u; // absolute
  if (!base) return u; // no base — use whatever was given (may be empty)
  const path = u || "";
  return path ? `${base}/${path.replace(/^\/+/, "")}` : base;
}

/**
 * Perform an authenticated REST call. Returns `notConfigured: true` when the
 * integration is disabled so callers can fall back to an unauthenticated call.
 */
export async function restRequest(scope: TenantScope, input: RestRequestInput): Promise<MessageResult> {
  const state = await automationStore.getIntegration(scope.tenantId, scope.orgId, "rest");
  if (!state.enabled) return notConfigured("REST integration is disabled");
  const c = state.config;
  const base = normBase(str(c, "baseUrl"));
  const target = resolveUrl(base, input);
  if (!target) return notConfigured("REST base URL missing");

  // Don't apply credentials to a third-party host (generic webhook safety).
  if (input.sameOriginOnly && /^https?:\/\//i.test((input.url ?? ""))) {
    try {
      if (!base || new URL(target).origin !== new URL(base).origin) {
        return notConfigured("URL is outside the configured REST base — auth not applied");
      }
    } catch {
      return notConfigured("invalid URL");
    }
  }

  const timeoutMs = num(c, "timeoutMs", 15000);
  const method = (input.method || str(c, "defaultMethod") || "POST").toUpperCase();
  const headers: Record<string, string> = {};

  // Default headers (JSON object), then auth, then per-call overrides.
  const rawHeaders = str(c, "defaultHeaders");
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
    } catch {
      return { ok: false, error: "Default headers is not valid JSON" };
    }
  }

  const authType = str(c, "authType") || "none";
  try {
    if (authType === "bearer") {
      const token = str(c, "token");
      if (token) headers.Authorization = `Bearer ${token}`;
    } else if (authType === "basic") {
      headers.Authorization = `Basic ${Buffer.from(`${str(c, "username")}:${str(c, "password")}`).toString("base64")}`;
    } else if (authType === "apiKey") {
      const name = str(c, "headerName") || "X-API-Key";
      const val = str(c, "apiKeyValue");
      if (val) headers[name] = val;
    } else if (authType === "oauth2") {
      const token = await oauthToken(c, timeoutMs);
      if (!token) return { ok: false, error: "OAuth2 token request failed (check client ID/secret/token URL)" };
      headers.Authorization = `Bearer ${token}`;
    }

    const hasBody = method !== "GET" && method !== "HEAD" && input.body !== undefined;
    const bodyStr = hasBody ? JSON.stringify(input.body) : undefined;
    if (hasBody) headers["Content-Type"] = str(c, "contentType") || "application/json";

    // Optional HMAC signature so the receiver can verify the request.
    const secret = str(c, "signingSecret");
    if (secret && bodyStr) headers["X-Signature"] = createHmac("sha256", secret).update(bodyStr).digest("hex");

    for (const [k, v] of Object.entries(input.headers ?? {})) headers[k] = v;

    const res = await httpRequest(target, { method, headers, body: bodyStr }, timeoutMs);
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
      logger.info("rest call ok", { url: target, method, status: res.status });
      return { ok: true, status: res.status, id: data.id || data.messageId };
    }
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text ? text.slice(0, 200) : `HTTP ${res.status}` };
  } catch (e) {
    const error = errMessage(e, timeoutMs);
    logger.warn("rest call error", { url: target, error });
    return { ok: false, error };
  }
}

/** Lightweight connectivity check used by the integration Test button (GET base URL). */
export async function restTestConnection(scope: TenantScope): Promise<MessageResult> {
  return restRequest(scope, { method: "GET" });
}
