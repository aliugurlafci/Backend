/**
 * WhatsApp transport — real outbound send over the tenant's configured WhatsApp
 * Business integration (Automation → Integrations → WhatsApp Business).
 *
 * Dispatches to Meta's Cloud API (Graph), Twilio's WhatsApp channel, or 360dialog
 * depending on the selected provider. Returns a structured result so callers can
 * fall back to an in-app notification when unconfigured, or surface the error.
 */
import { automationStore } from "@/lib/automation/store";
import type { IntegrationConfig } from "@/lib/automation/integrations";
import { logger } from "@/lib/observability/logger";
import { str, num, notConfigured, httpRequest, errMessage, normBase, type MessageResult, type TenantScope } from "./transport-util";

const digitsPlus = (s: string): string => {
  const d = s.replace(/[^\d]/g, "");
  return d ? `+${d}` : "";
};

async function sendCloud(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<MessageResult> {
  const token = str(c, "accessToken");
  const phoneNumberId = str(c, "phoneNumberId");
  if (!token) return notConfigured("WhatsApp access token missing");
  if (!phoneNumberId) return notConfigured("WhatsApp phone number ID missing");
  const base = normBase(str(c, "baseUrl")) || "https://graph.facebook.com";
  const version = str(c, "apiVersion") || "v19.0";

  const res = await httpRequest(
    `${base}/${version}/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: digitsPlus(to), type: "text", text: { body } }),
    },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { message?: string } };
  if (res.ok && data.messages?.[0]?.id) return { ok: true, id: data.messages[0].id };
  return { ok: false, error: data.error?.message || `WhatsApp Cloud HTTP ${res.status}` };
}

async function sendTwilio(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<MessageResult> {
  const sid = str(c, "accountSid");
  const token = str(c, "authToken");
  const from = str(c, "fromNumber");
  if (!sid || !token) return notConfigured("Twilio Account SID / Auth Token missing");
  if (!from) return notConfigured("Twilio WhatsApp From number missing");

  const waFrom = from.startsWith("whatsapp:") ? from : `whatsapp:${digitsPlus(from)}`;
  const waTo = to.startsWith("whatsapp:") ? to : `whatsapp:${digitsPlus(to)}`;
  const params = new URLSearchParams({ To: waTo, From: waFrom, Body: body });
  const res = await httpRequest(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (res.ok && data.sid) return { ok: true, id: data.sid };
  return { ok: false, error: data.message || `Twilio HTTP ${res.status}` };
}

async function sendDialog360(c: IntegrationConfig, to: string, body: string, timeoutMs: number): Promise<MessageResult> {
  const key = str(c, "dialogApiKey");
  if (!key) return notConfigured("360dialog API key missing");
  const base = normBase(str(c, "baseUrl")) || "https://waba-v2.360dialog.io";

  const res = await httpRequest(
    `${base}/messages`,
    {
      method: "POST",
      headers: { "D360-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: digitsPlus(to), type: "text", text: { body } }),
    },
    timeoutMs,
  );
  const data = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { message?: string }; meta?: { developer_message?: string } };
  if (res.ok && data.messages?.[0]?.id) return { ok: true, id: data.messages[0].id };
  return { ok: false, error: data.error?.message || data.meta?.developer_message || `360dialog HTTP ${res.status}` };
}

const DISPATCH: Record<string, (c: IntegrationConfig, to: string, body: string, timeoutMs: number) => Promise<MessageResult>> = {
  cloud: sendCloud,
  twilio: sendTwilio,
  dialog360: sendDialog360,
};

/** Send a WhatsApp message over the tenant's configured provider. */
export async function sendWhatsApp(scope: TenantScope, to: string, body: string): Promise<MessageResult> {
  const state = await automationStore.getIntegration(scope.tenantId, scope.orgId, "whatsapp");
  if (!state.enabled) return notConfigured("WhatsApp integration is disabled");
  const c = state.config;
  const provider = str(c, "provider") || "cloud";
  const adapter = DISPATCH[provider];
  if (!adapter) return notConfigured(`Unknown WhatsApp provider "${provider}"`);

  const timeoutMs = num(c, "timeoutMs", 15000);
  try {
    const result = await adapter(c, to, body, timeoutMs);
    if (result.ok) logger.info("whatsapp sent", { provider, to, id: result.id });
    else logger.warn("whatsapp send failed", { provider, to, error: result.error });
    return result;
  } catch (e) {
    const error = errMessage(e, timeoutMs);
    logger.warn("whatsapp send error", { provider, to, error });
    return { ok: false, error };
  }
}
