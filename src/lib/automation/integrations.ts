/**
 * Integration hub — provider catalog + config resolution.
 *
 * Declares the connectable providers (Email / SMS / WhatsApp / Slack / ERP /
 * REST) and the detailed variables each one exposes, so the Automation →
 * Integrations screen can render an editable form per provider and persist the
 * values to the database. The Email provider's defaults come from the SMTP/IMAP
 * env vars (so existing config migrates in), and `resolveEmailConfig()` returns
 * the effective connection (DB override → env fallback) used by the live mail
 * transport.
 */
import { env } from "@/lib/config/env";

export type IntegrationFieldType = "text" | "password" | "number" | "boolean" | "select";

export interface IntegrationField {
  key: string;
  label: string;
  type: IntegrationFieldType;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Masked in the UI and redacted from logs. */
  secret?: boolean;
  help?: string;
}

export interface IntegrationProviderDef {
  key: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  fields: IntegrationField[];
}

/** The connectable providers and their variables. Values are stored per-tenant. */
export const INTEGRATION_PROVIDERS: IntegrationProviderDef[] = [
  {
    key: "email",
    name: "Email (SMTP / IMAP)",
    category: "Email",
    icon: "email",
    description: "Send transactional email over SMTP and sync the inbox over IMAP.",
    fields: [
      { key: "smtpHost", label: "SMTP Host", type: "text", placeholder: "smtp.gmail.com" },
      { key: "smtpPort", label: "SMTP Port", type: "number", placeholder: "587" },
      { key: "smtpUser", label: "SMTP User", type: "text", placeholder: "you@example.com" },
      { key: "smtpPass", label: "SMTP Password", type: "password", secret: true },
      { key: "smtpFrom", label: "From address", type: "text", placeholder: "Aula CRM <noreply@…>" },
      { key: "smtpSecure", label: "SMTP TLS (port 465)", type: "boolean" },
      { key: "imapHost", label: "IMAP Host", type: "text", placeholder: "imap.gmail.com" },
      { key: "imapPort", label: "IMAP Port", type: "number", placeholder: "993" },
      { key: "imapUser", label: "IMAP User", type: "text" },
      { key: "imapPass", label: "IMAP Password", type: "password", secret: true },
      { key: "imapSecure", label: "IMAP TLS", type: "boolean" },
      { key: "imapMailbox", label: "Mailbox", type: "text", placeholder: "INBOX" },
    ],
  },
  {
    key: "sms",
    name: "SMS Gateway",
    category: "Messaging",
    icon: "chat",
    description: "Send text messages via an SMS provider (Twilio-compatible).",
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        options: [
          { value: "twilio", label: "Twilio" },
          { value: "vonage", label: "Vonage" },
          { value: "messagebird", label: "MessageBird" },
        ],
      },
      { key: "accountSid", label: "Account SID / Key", type: "text" },
      { key: "authToken", label: "Auth Token", type: "password", secret: true },
      { key: "fromNumber", label: "From number", type: "text", placeholder: "+1..." },
    ],
  },
  {
    key: "whatsapp",
    name: "WhatsApp Business",
    category: "Messaging",
    icon: "chat",
    description: "Send WhatsApp messages via the WhatsApp Cloud API.",
    fields: [
      { key: "phoneNumberId", label: "Phone number ID", type: "text" },
      { key: "businessAccountId", label: "Business account ID", type: "text" },
      { key: "accessToken", label: "Access token", type: "password", secret: true },
      { key: "apiVersion", label: "API version", type: "text", placeholder: "v19.0" },
    ],
  },
  {
    key: "slack",
    name: "Slack",
    category: "Messaging",
    icon: "social",
    description: "Post automation alerts to Slack channels.",
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", type: "password", secret: true, placeholder: "https://hooks.slack.com/…" },
      { key: "botToken", label: "Bot token (optional)", type: "password", secret: true },
      { key: "defaultChannel", label: "Default channel", type: "text", placeholder: "#sales" },
    ],
  },
  {
    key: "erp",
    name: "ERP Connector",
    category: "ERP",
    icon: "network",
    description: "Sync invoices and orders to your ERP system.",
    fields: [
      {
        key: "system",
        label: "ERP system",
        type: "select",
        options: [
          { value: "sap", label: "SAP" },
          { value: "dynamics", label: "Microsoft Dynamics" },
          { value: "netsuite", label: "NetSuite" },
          { value: "odoo", label: "Odoo" },
        ],
      },
      { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://erp.example.com/api" },
      { key: "apiKey", label: "API key", type: "password", secret: true },
      { key: "company", label: "Company / tenant code", type: "text" },
      { key: "syncInvoices", label: "Sync invoices", type: "boolean" },
      { key: "syncOrders", label: "Sync orders", type: "boolean" },
    ],
  },
  {
    key: "rest",
    name: "REST / API",
    category: "API",
    icon: "globe",
    description: "Generic outbound REST integration for custom systems.",
    fields: [
      { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://api.example.com" },
      {
        key: "authType",
        label: "Auth type",
        type: "select",
        options: [
          { value: "none", label: "None" },
          { value: "bearer", label: "Bearer token" },
          { value: "basic", label: "Basic auth" },
          { value: "apiKey", label: "API key header" },
        ],
      },
      { key: "token", label: "Token / password", type: "password", secret: true },
      { key: "headerName", label: "API key header name", type: "text", placeholder: "X-API-Key" },
    ],
  },
];

export type IntegrationConfig = Record<string, string | number | boolean>;

export function getProviderDef(provider: string): IntegrationProviderDef | undefined {
  return INTEGRATION_PROVIDERS.find((p) => p.key === provider);
}

/** Default values for a provider, seeded from env where applicable (Email). */
export function integrationDefaults(provider: string): IntegrationConfig {
  if (provider === "email") {
    return {
      smtpHost: env.SMTP_HOST ?? "",
      smtpPort: env.SMTP_PORT ?? 587,
      smtpUser: env.SMTP_USER ?? "",
      smtpPass: env.SMTP_PASS ?? "",
      smtpFrom: env.SMTP_FROM ?? "",
      smtpSecure: env.SMTP_SECURE ?? false,
      imapHost: env.IMAP_HOST ?? "",
      imapPort: env.IMAP_PORT ?? 993,
      imapUser: env.IMAP_USER ?? "",
      imapPass: env.IMAP_PASS ?? "",
      imapSecure: env.IMAP_SECURE ?? true,
      imapMailbox: env.IMAP_MAILBOX ?? "INBOX",
    };
  }
  return {};
}

/** Whether the Email provider is enabled by default (true when env SMTP is set). */
export function emailEnabledByDefault(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER);
}

/** The effective email connection, resolved as DB value (non-empty) → env default. */
export interface ResolvedEmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  imapSecure: boolean;
  imapMailbox: string;
  smtpConfigured: boolean;
  imapConfigured: boolean;
}

export function resolveEmailConfig(dbConfig: IntegrationConfig | null, enabled: boolean): ResolvedEmailConfig {
  const c = dbConfig ?? {};
  const str = (k: string, def: string) => {
    const v = c[k];
    return v === undefined || v === null || v === "" ? def : String(v);
  };
  const num = (k: string, def: number) => {
    const v = c[k];
    return v === undefined || v === null || v === "" ? def : Number(v);
  };
  const bool = (k: string, def: boolean) => {
    const v = c[k];
    if (v === undefined || v === null || v === "") return def;
    return v === true || v === "true" || v === 1 || v === "1";
  };
  const out: Omit<ResolvedEmailConfig, "smtpConfigured" | "imapConfigured"> = {
    smtpHost: str("smtpHost", env.SMTP_HOST ?? ""),
    smtpPort: num("smtpPort", env.SMTP_PORT ?? 587),
    smtpUser: str("smtpUser", env.SMTP_USER ?? ""),
    smtpPass: str("smtpPass", env.SMTP_PASS ?? ""),
    smtpFrom: str("smtpFrom", env.SMTP_FROM ?? ""),
    smtpSecure: bool("smtpSecure", env.SMTP_SECURE ?? false),
    imapHost: str("imapHost", env.IMAP_HOST ?? ""),
    imapPort: num("imapPort", env.IMAP_PORT ?? 993),
    imapUser: str("imapUser", env.IMAP_USER ?? ""),
    imapPass: str("imapPass", env.IMAP_PASS ?? ""),
    imapSecure: bool("imapSecure", env.IMAP_SECURE ?? true),
    imapMailbox: str("imapMailbox", env.IMAP_MAILBOX ?? "INBOX"),
  };
  // A connection only counts as configured when the integration is enabled.
  return {
    ...out,
    smtpConfigured: enabled && Boolean(out.smtpHost && out.smtpUser),
    imapConfigured: enabled && Boolean(out.imapHost && out.imapUser),
  };
}
