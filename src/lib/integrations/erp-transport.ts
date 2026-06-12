/**
 * ERP transport — connectivity / credential check for the tenant's ERP Connector
 * integration (Automation → Integrations → ERP Connector).
 *
 * NOTE: full record sync (invoices / orders / products / customers) is a large,
 * system-specific subsystem and is out of scope here. This module verifies that
 * the configured ERP endpoint is reachable and that the credentials are accepted,
 * which is what the integration Test button needs. The provider-specific auth is
 * best-effort: Basic auth / API-key systems are fully exercised; OAuth-handshake
 * systems (Dynamics / NetSuite) are checked for reachability only.
 */
import { automationStore } from "@/lib/automation/store";
import type { IntegrationConfig } from "@/lib/automation/integrations";
import { str, num, notConfigured, httpRequest, errMessage, normBase, type MessageResult, type TenantScope } from "./transport-util";

function authHeaders(system: string, c: IntegrationConfig): { headers: Record<string, string>; full: boolean } {
  const headers: Record<string, string> = { Accept: "application/json" };
  // Username/password systems → HTTP Basic.
  if (["sap", "odoo", "logo", "netsis"].includes(system)) {
    const user = str(c, "username");
    const pass = str(c, "password");
    if (user) headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    return { headers, full: Boolean(user) };
  }
  // Generic REST → API key header.
  if (system === "generic") {
    const name = str(c, "headerName") || "X-API-Key";
    const key = str(c, "apiKey");
    if (key) headers[name] = key;
    return { headers, full: Boolean(key) };
  }
  // Dynamics / NetSuite use multi-step OAuth/TBA handshakes — reachability only.
  return { headers, full: false };
}

/**
 * Verify the ERP endpoint is reachable and (where applicable) credentials are
 * accepted. Returns `notConfigured` when disabled or missing a base URL.
 */
export async function erpTestConnection(scope: TenantScope): Promise<MessageResult> {
  const state = await automationStore.getIntegration(scope.tenantId, scope.orgId, "erp");
  if (!state.enabled) return notConfigured("ERP integration is disabled");
  const c = state.config;
  const system = str(c, "system");
  const base = normBase(str(c, "baseUrl"));
  if (!system) return notConfigured("ERP system not selected");
  if (!base) return notConfigured("ERP base URL missing");

  const timeoutMs = num(c, "timeoutMs", 30000);
  const { headers, full } = authHeaders(system, c);
  try {
    const res = await httpRequest(base, { method: "GET", headers }, timeoutMs);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: `Reachable but credentials rejected (HTTP ${res.status})` };
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: `ERP server error (HTTP ${res.status})` };
    }
    // 2xx/3xx/4xx (other than auth) means the host answered — endpoint is reachable.
    return {
      ok: true,
      status: res.status,
      error: full ? undefined : "reachable (credentials not fully verified for this system)",
    };
  } catch (e) {
    return { ok: false, error: errMessage(e, timeoutMs) };
  }
}
