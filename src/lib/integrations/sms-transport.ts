/**
 * SMS transport — real outbound send over the tenant's configured SMS Gateway
 * (Automation → Integrations → SMS Gateway).
 *
 * Resolves the per-tenant SMS integration, then dispatches to the selected
 * provider's HTTP API (Twilio, Vonage, MessageBird, Netgsm, Infobip, or a
 * generic JSON endpoint). Returns a structured result so callers can fall back
 * to an in-app notification when the gateway isn't configured, or surface the
 * provider error when a send fails.
 */
import { automationStore } from "@/lib/automation/store";
import type { IntegrationConfig } from "@/lib/automation/integrations";
import { logger } from "@/lib/observability/logger";

export interface SmsScope {
  tenantId: string;
  orgId: string;
}

export interface SmsResult {
  ok: boolean;
  /** Provider message / job id on success. */
  id?: string;
  /** Provider or transport error on failure. */
  error?: string;
  /** True when the gateway is disabled or missing credentials — caller should fall back. */
  notConfigured?: boolean;
}

const str = (c: IntegrationConfig, k: string): string => {
  const v = c[k];
  return v === undefined || v === null ? "" : String(v).trim();
};
const bool = (c: IntegrationConfig, k: string): boolean => {
  const v = c[k];
  return v === true || v === "true" || v === 1 || v === "1";
};
const num = (c: IntegrationConfig, k: string, def: number): number => {
  const n = Number(c[k]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

function notConfigured(error: string): SmsResult {
  return { ok: false, notConfigured: true, error };
}

/** fetch() with an abort-based timeout so a hung gateway can't stall the run. */
async function httpRequest(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure a base URL has a scheme and no trailing slash. */
function normBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

const digitsOnly = (s: string): string => s.replace(/[^\d]/g, "");

// ---- provider adapters ------------------------------------------------------

async function sendTwilio(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<SmsResult> {
  const sid = str(c, "accountSid");
  const token = str(c, "authToken");
  if (!sid || !token) return notConfigured("Twilio Account SID / Auth Token missing");
  const serviceSid = str(c, "messagingServiceSid");
  const from = str(c, "fromNumber");
  if (!serviceSid && !from) return notConfigured("Twilio From number or Messaging Service SID missing");

  const params = new URLSearchParams();
  params.set("To", to);
  params.set("Body", body);
  if (serviceSid) params.set("MessagingServiceSid", serviceSid);
  else params.set("From", from);
  const callback = str(c, "statusCallbackUrl");
  if (callback) params.set("StatusCallback", callback);

  const res = await httpRequest(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (res.ok && data.sid) return { ok: true, id: data.sid };
  return { ok: false, error: data.message || `Twilio HTTP ${res.status}` };
}

async function sendVonage(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<SmsResult> {
  const key = str(c, "vonageApiKey");
  const secret = str(c, "vonageApiSecret");
  const from = str(c, "senderId");
  if (!key || !secret) return notConfigured("Vonage API key / secret missing");
  if (!from) return notConfigured("Vonage sender ID missing");

  const params = new URLSearchParams({ api_key: key, api_secret: secret, from, to: digitsOnly(to), text: body });
  if (bool(c, "unicodeEnabled")) params.set("type", "unicode");
  const res = await httpRequest(
    "https://rest.nexmo.com/sms/json",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as { messages?: { status?: string; "message-id"?: string; "error-text"?: string }[] };
  const msg = data.messages?.[0];
  if (res.ok && msg && msg.status === "0") return { ok: true, id: msg["message-id"] };
  return { ok: false, error: msg?.["error-text"] || `Vonage HTTP ${res.status}` };
}

async function sendMessageBird(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<SmsResult> {
  const key = str(c, "messagebirdAccessKey");
  const from = str(c, "senderId");
  if (!key) return notConfigured("MessageBird access key missing");
  if (!from) return notConfigured("MessageBird originator (sender ID) missing");

  const res = await httpRequest(
    "https://rest.messagebird.com/messages",
    {
      method: "POST",
      headers: { Authorization: `AccessKey ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ originator: from, recipients: [digitsOnly(to)], body }),
    },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as { id?: string; errors?: { description?: string }[] };
  if (res.ok && data.id) return { ok: true, id: data.id };
  return { ok: false, error: data.errors?.[0]?.description || `MessageBird HTTP ${res.status}` };
}

async function sendNetgsm(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<SmsResult> {
  const user = str(c, "netgsmUsername");
  const pass = str(c, "netgsmPassword");
  const header = str(c, "netgsmHeader");
  if (!user || !pass) return notConfigured("Netgsm kullanıcı kodu / şifre eksik");
  if (!header) return notConfigured("Netgsm mesaj başlığı (sender header) eksik");

  // Netgsm REST v2 — Basic auth, JSON body. `encoding: TR` preserves Turkish chars.
  const res = await httpRequest(
    "https://api.netgsm.com.tr/sms/rest/v2/send",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msgheader: header,
        encoding: bool(c, "unicodeEnabled") ? "TR" : "GSM",
        messages: [{ msg: body, no: digitsOnly(to) }],
      }),
    },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as { code?: string | number; jobid?: string; description?: string };
  const code = String(data.code ?? "");
  if (res.ok && (code === "00" || code === "0")) return { ok: true, id: data.jobid ? String(data.jobid) : undefined };
  return { ok: false, error: data.description || `Netgsm code ${code || res.status}` };
}

async function sendInfobip(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<SmsResult> {
  const key = str(c, "infobipApiKey");
  const base = normBase(str(c, "baseUrl"));
  const from = str(c, "senderId");
  if (!key) return notConfigured("Infobip API key missing");
  if (!base) return notConfigured("Infobip base URL missing");

  const res = await httpRequest(
    `${base}/sms/2/text/advanced`,
    {
      method: "POST",
      headers: { Authorization: `App ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ messages: [{ from: from || undefined, destinations: [{ to: digitsOnly(to) }], text: body }] }),
    },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as {
    messages?: { messageId?: string; status?: { name?: string; description?: string } }[];
    requestError?: { serviceException?: { text?: string } };
  };
  const msg = data.messages?.[0];
  if (res.ok && msg) return { ok: true, id: msg.messageId };
  return { ok: false, error: data.requestError?.serviceException?.text || `Infobip HTTP ${res.status}` };
}

async function sendGeneric(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<SmsResult> {
  const base = normBase(str(c, "baseUrl"));
  if (!base) return notConfigured("Generic gateway base URL missing");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const headerName = str(c, "genericAuthHeader") || "Authorization";
  const apiKey = str(c, "genericApiKey");
  if (apiKey) headers[headerName] = apiKey;

  const res = await httpRequest(
    base,
    { method: "POST", headers, body: JSON.stringify({ to, from: str(c, "fromNumber"), message: body, text: body }) },
    timeoutMs,
  );
  if (res.ok) {
    const data = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
    return { ok: true, id: data.id || data.messageId };
  }
  const text = await res.text().catch(() => "");
  return { ok: false, error: text ? text.slice(0, 200) : `Gateway HTTP ${res.status}` };
}

const DISPATCH: Record<string, (c: IntegrationConfig, to: string, body: string, timeoutMs: number) => Promise<SmsResult>> = {
  twilio: sendTwilio,
  vonage: sendVonage,
  messagebird: sendMessageBird,
  netgsm: sendNetgsm,
  infobip: sendInfobip,
  generic: sendGeneric,
};

/**
 * Send an SMS over the tenant's configured gateway.
 *
 * - `notConfigured: true` → the integration is disabled or missing credentials;
 *   the caller should fall back (e.g. to an in-app notification).
 * - `ok: false` (without notConfigured) → the gateway rejected the message;
 *   `error` carries the provider's reason.
 */
export async function sendSms(scope: SmsScope, to: string, body: string): Promise<SmsResult> {
  const state = await automationStore.getIntegration(scope.tenantId, scope.orgId, "sms");
  if (!state.enabled) return notConfigured("SMS gateway is disabled");
  const c = state.config;
  const provider = str(c, "provider") || "twilio";
  const adapter = DISPATCH[provider];
  if (!adapter) return notConfigured(`Unknown SMS provider "${provider}"`);

  const timeoutMs = num(c, "timeoutMs", 15000);
  try {
    const result = await adapter(c, to, body, timeoutMs);
    if (result.ok) logger.info("sms sent", { provider, to, id: result.id });
    else logger.warn("sms send failed", { provider, to, error: result.error });
    return result;
  } catch (e) {
    const error = e instanceof Error ? (e.name === "AbortError" ? `Gateway timed out after ${timeoutMs}ms` : e.message) : String(e);
    logger.warn("sms send error", { provider, to, error });
    return { ok: false, error };
  }
}
