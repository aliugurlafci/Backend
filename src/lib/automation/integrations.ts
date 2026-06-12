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

export type IntegrationFieldType = "text" | "password" | "number" | "boolean" | "select" | "textarea";

export interface IntegrationField {
  key: string;
  label: string;
  type: IntegrationFieldType;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Masked in the UI and redacted from logs. */
  secret?: boolean;
  /** Required for a working connection — the test endpoint flags it when empty. */
  required?: boolean;
  /** Section header the field is grouped under in the editor (purely cosmetic). */
  group?: string;
  /**
   * Only show/validate this field when another field (usually `provider` / the
   * sub-selector) holds one of the given values. Lets each provider expose its
   * own parameter set. Omit to always show.
   */
  showWhen?: { field: string; in: string[] };
  help?: string;
}

export interface IntegrationProviderDef {
  key: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  fields: IntegrationField[];
  /**
   * Groups of field keys where AT LEAST ONE must be supplied (e.g. Slack accepts
   * either an incoming webhook URL or a bot token). The test endpoint enforces it.
   */
  requireOneOf?: string[][];
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
    description: "Send text messages via Twilio, Vonage, MessageBird, Netgsm, Infobip or any HTTP gateway.",
    fields: [
      // ---- Provider (controls which fields below are shown) ----
      {
        key: "provider",
        label: "Provider",
        type: "select",
        required: true,
        group: "Provider",
        options: [
          { value: "twilio", label: "Twilio" },
          { value: "vonage", label: "Vonage" },
          { value: "messagebird", label: "MessageBird" },
          { value: "netgsm", label: "Netgsm" },
          { value: "infobip", label: "Infobip" },
          { value: "generic", label: "Generic HTTP" },
        ],
      },
      { key: "baseUrl", label: "API base URL", type: "text", required: true, group: "Provider", placeholder: "https://api.example.com", help: "Your provider-specific (personalized) base URL.", showWhen: { field: "provider", in: ["infobip", "generic"] } },
      { key: "region", label: "Region", type: "text", group: "Provider", placeholder: "eu1", help: "Provider data region, where applicable.", showWhen: { field: "provider", in: ["vonage", "infobip"] } },

      // ---- Authentication (per provider) ----
      { key: "accountSid", label: "Account SID", type: "text", required: true, group: "Authentication", showWhen: { field: "provider", in: ["twilio"] } },
      { key: "authToken", label: "Auth Token", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["twilio"] } },
      { key: "vonageApiKey", label: "API Key", type: "text", required: true, group: "Authentication", showWhen: { field: "provider", in: ["vonage"] } },
      { key: "vonageApiSecret", label: "API Secret", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["vonage"] } },
      { key: "messagebirdAccessKey", label: "Access Key", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["messagebird"] } },
      { key: "netgsmUsername", label: "Kullanıcı kodu (Username)", type: "text", required: true, group: "Authentication", showWhen: { field: "provider", in: ["netgsm"] } },
      { key: "netgsmPassword", label: "Şifre (Password)", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["netgsm"] } },
      { key: "infobipApiKey", label: "API Key", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["infobip"] } },
      { key: "genericApiKey", label: "Auth token / API key", type: "password", secret: true, group: "Authentication", showWhen: { field: "provider", in: ["generic"] } },
      { key: "genericAuthHeader", label: "Auth header name", type: "text", group: "Authentication", placeholder: "Authorization", showWhen: { field: "provider", in: ["generic"] } },

      // ---- Sender ----
      { key: "fromNumber", label: "From number", type: "text", group: "Sender", placeholder: "+1...", help: "Required unless a Messaging Service SID is set.", showWhen: { field: "provider", in: ["twilio", "generic"] } },
      { key: "messagingServiceSid", label: "Messaging Service SID", type: "text", group: "Sender", help: "Twilio Messaging Service SID — overrides the From number when set.", showWhen: { field: "provider", in: ["twilio"] } },
      { key: "senderId", label: "Sender ID / Originator", type: "text", required: true, group: "Sender", placeholder: "AULA", help: "Branded sender name (alphanumeric where carriers allow it).", showWhen: { field: "provider", in: ["vonage", "messagebird", "infobip"] } },
      { key: "netgsmHeader", label: "Mesaj başlığı (Sender header)", type: "text", required: true, group: "Sender", help: "Onaylı Netgsm gönderici başlığı.", showWhen: { field: "provider", in: ["netgsm"] } },
      { key: "defaultCountryCode", label: "Default country code", type: "text", group: "Sender", placeholder: "+90" },

      // ---- Delivery (common) ----
      { key: "statusCallbackUrl", label: "Delivery status webhook", type: "text", group: "Delivery", placeholder: "https://crm.example.com/api/v1/webhooks/sms" },
      { key: "enableDeliveryReports", label: "Request delivery reports", type: "boolean", group: "Delivery" },

      // ---- Advanced (common) ----
      { key: "unicodeEnabled", label: "Allow Unicode (UCS-2)", type: "boolean", group: "Advanced", help: "Enable for non-GSM alphabets (Turkish characters, emoji, …)." },
      { key: "timeoutMs", label: "Request timeout (ms)", type: "number", group: "Advanced", placeholder: "15000" },
      { key: "maxRetries", label: "Max retries", type: "number", group: "Advanced", placeholder: "3" },
      { key: "rateLimitPerSec", label: "Rate limit (msg/sec)", type: "number", group: "Advanced", placeholder: "10" },
    ],
  },
  {
    key: "whatsapp",
    name: "WhatsApp Business",
    category: "Messaging",
    icon: "chat",
    description: "Send WhatsApp messages via Meta Cloud API, Twilio or 360dialog.",
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        required: true,
        group: "Provider",
        options: [
          { value: "cloud", label: "Meta Cloud API" },
          { value: "twilio", label: "Twilio" },
          { value: "dialog360", label: "360dialog" },
        ],
      },

      // ---- Connection ----
      { key: "phoneNumberId", label: "Phone number ID", type: "text", required: true, group: "Connection", showWhen: { field: "provider", in: ["cloud"] } },
      { key: "businessAccountId", label: "WhatsApp Business Account ID (WABA)", type: "text", required: true, group: "Connection", showWhen: { field: "provider", in: ["cloud"] } },
      { key: "apiVersion", label: "Graph API version", type: "text", group: "Connection", placeholder: "v19.0", showWhen: { field: "provider", in: ["cloud"] } },
      { key: "channelId", label: "Channel / phone number", type: "text", required: true, group: "Connection", showWhen: { field: "provider", in: ["dialog360"] } },
      { key: "fromNumber", label: "From (whatsapp:+…)", type: "text", required: true, group: "Connection", placeholder: "whatsapp:+1...", showWhen: { field: "provider", in: ["twilio"] } },
      { key: "baseUrl", label: "API base URL", type: "text", group: "Connection", placeholder: "https://graph.facebook.com", showWhen: { field: "provider", in: ["cloud", "dialog360"] } },

      // ---- Authentication (per provider) ----
      { key: "accessToken", label: "Permanent access token", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["cloud"] } },
      { key: "appId", label: "Meta App ID", type: "text", group: "Authentication", showWhen: { field: "provider", in: ["cloud"] } },
      { key: "appSecret", label: "Meta App secret", type: "password", secret: true, group: "Authentication", showWhen: { field: "provider", in: ["cloud"] } },
      { key: "accountSid", label: "Account SID", type: "text", required: true, group: "Authentication", showWhen: { field: "provider", in: ["twilio"] } },
      { key: "authToken", label: "Auth Token", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["twilio"] } },
      { key: "dialogApiKey", label: "API Key", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "provider", in: ["dialog360"] } },

      // ---- Webhooks ----
      { key: "verifyToken", label: "Webhook verify token", type: "password", secret: true, group: "Webhooks", help: "The token you configure in the Meta webhook settings.", showWhen: { field: "provider", in: ["cloud"] } },
      { key: "webhookUrl", label: "Callback URL", type: "text", group: "Webhooks", placeholder: "https://crm.example.com/api/v1/webhooks/whatsapp", showWhen: { field: "provider", in: ["cloud", "dialog360"] } },

      // ---- Messaging (common) ----
      { key: "defaultTemplate", label: "Default template name", type: "text", group: "Messaging", help: "Approved template used outside the 24h session window." },
      { key: "templateLanguage", label: "Template language", type: "text", group: "Messaging", placeholder: "tr" },
      { key: "defaultCountryCode", label: "Default country code", type: "text", group: "Messaging", placeholder: "+90" },

      // ---- Advanced (common) ----
      { key: "timeoutMs", label: "Request timeout (ms)", type: "number", group: "Advanced", placeholder: "15000" },
      { key: "maxRetries", label: "Max retries", type: "number", group: "Advanced", placeholder: "3" },
    ],
  },
  {
    key: "slack",
    name: "Slack",
    category: "Messaging",
    icon: "social",
    description: "Post automation alerts to Slack via an incoming webhook or a bot token.",
    fields: [
      {
        key: "mode",
        label: "Connection mode",
        type: "select",
        required: true,
        group: "Connection",
        options: [
          { value: "webhook", label: "Incoming webhook" },
          { value: "bot", label: "Bot (OAuth token)" },
        ],
      },
      { key: "webhookUrl", label: "Incoming webhook URL", type: "password", secret: true, required: true, group: "Connection", placeholder: "https://hooks.slack.com/services/…", help: "Posts to the single channel the webhook is bound to.", showWhen: { field: "mode", in: ["webhook"] } },

      // ---- Bot mode ----
      { key: "botToken", label: "Bot User OAuth token", type: "password", secret: true, required: true, group: "Authentication", placeholder: "xoxb-…", showWhen: { field: "mode", in: ["bot"] } },
      { key: "signingSecret", label: "Signing secret", type: "password", secret: true, group: "Authentication", help: "Required to verify inbound Slack requests / interactivity.", showWhen: { field: "mode", in: ["bot"] } },
      { key: "appId", label: "App ID", type: "text", group: "Authentication", showWhen: { field: "mode", in: ["bot"] } },
      { key: "defaultChannel", label: "Default channel", type: "text", group: "Authentication", placeholder: "#sales", help: "Bot posts here unless an action overrides it.", showWhen: { field: "mode", in: ["bot"] } },

      // ---- Appearance (common) ----
      { key: "username", label: "Bot display name", type: "text", group: "Appearance", placeholder: "Aula CRM" },
      { key: "iconEmoji", label: "Icon emoji", type: "text", group: "Appearance", placeholder: ":robot_face:" },
      { key: "mentionUsers", label: "Default mentions", type: "text", group: "Appearance", placeholder: "@here", help: "Comma-separated @users/@groups prepended to each alert." },

      { key: "timeoutMs", label: "Request timeout (ms)", type: "number", group: "Advanced", placeholder: "10000" },
    ],
  },
  {
    key: "erp",
    name: "ERP Connector",
    category: "ERP",
    icon: "network",
    description: "Sync invoices, orders, products and customers with your ERP system.",
    fields: [
      {
        key: "system",
        label: "ERP system",
        type: "select",
        required: true,
        group: "System",
        options: [
          { value: "sap", label: "SAP" },
          { value: "dynamics", label: "Microsoft Dynamics" },
          { value: "netsuite", label: "NetSuite" },
          { value: "odoo", label: "Odoo" },
          { value: "logo", label: "Logo" },
          { value: "netsis", label: "Netsis" },
          { value: "generic", label: "Generic REST" },
        ],
      },

      // ---- Connection (common) ----
      { key: "baseUrl", label: "Base URL", type: "text", required: true, group: "Connection", placeholder: "https://erp.example.com/api" },
      { key: "company", label: "Company / tenant code", type: "text", group: "Connection", help: "ERP company / organisation code." },
      {
        key: "environment",
        label: "Environment",
        type: "select",
        group: "Connection",
        options: [
          { value: "production", label: "Production" },
          { value: "sandbox", label: "Sandbox / Test" },
        ],
      },

      // ---- Authentication (per ERP system) ----
      { key: "username", label: "Username", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["sap", "odoo", "logo", "netsis", "generic"] } },
      { key: "password", label: "Password", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "system", in: ["sap", "odoo", "logo", "netsis", "generic"] } },
      { key: "sapClient", label: "Client (Mandant)", type: "text", group: "Authentication", placeholder: "100", showWhen: { field: "system", in: ["sap"] } },
      { key: "database", label: "Database", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["odoo"] } },
      { key: "logoFirmNo", label: "Firma no", type: "text", required: true, group: "Authentication", placeholder: "001", showWhen: { field: "system", in: ["logo"] } },
      { key: "logoPeriodNo", label: "Dönem no", type: "text", group: "Authentication", placeholder: "01", showWhen: { field: "system", in: ["logo"] } },
      { key: "netsisDbName", label: "Veritabanı adı", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["netsis"] } },
      { key: "netsisBranchCode", label: "Şube kodu", type: "text", group: "Authentication", showWhen: { field: "system", in: ["netsis"] } },
      { key: "tenantId", label: "Azure AD tenant ID", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["dynamics"] } },
      { key: "clientId", label: "Client ID", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["dynamics"] } },
      { key: "clientSecret", label: "Client secret", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "system", in: ["dynamics"] } },
      { key: "resource", label: "Resource / scope", type: "text", group: "Authentication", placeholder: "https://org.crm.dynamics.com", showWhen: { field: "system", in: ["dynamics"] } },
      { key: "accountId", label: "Account ID", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["netsuite"] } },
      { key: "consumerKey", label: "Consumer key", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["netsuite"] } },
      { key: "consumerSecret", label: "Consumer secret", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "system", in: ["netsuite"] } },
      { key: "tokenId", label: "Token ID", type: "text", required: true, group: "Authentication", showWhen: { field: "system", in: ["netsuite"] } },
      { key: "tokenSecret", label: "Token secret", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "system", in: ["netsuite"] } },
      { key: "apiKey", label: "API key", type: "password", secret: true, group: "Authentication", showWhen: { field: "system", in: ["generic"] } },
      { key: "headerName", label: "API key header", type: "text", group: "Authentication", placeholder: "X-API-Key", showWhen: { field: "system", in: ["generic"] } },

      // ---- Sync (common) ----
      { key: "syncInvoices", label: "Sync invoices", type: "boolean", group: "Sync" },
      { key: "syncOrders", label: "Sync orders", type: "boolean", group: "Sync" },
      { key: "syncProducts", label: "Sync products", type: "boolean", group: "Sync" },
      { key: "syncCustomers", label: "Sync customers", type: "boolean", group: "Sync" },
      {
        key: "syncDirection",
        label: "Sync direction",
        type: "select",
        group: "Sync",
        options: [
          { value: "push", label: "Push (CRM → ERP)" },
          { value: "pull", label: "Pull (ERP → CRM)" },
          { value: "both", label: "Two-way" },
        ],
      },
      { key: "syncIntervalMin", label: "Sync interval (minutes)", type: "number", group: "Sync", placeholder: "60" },
      { key: "defaultCurrency", label: "Default currency", type: "text", group: "Sync", placeholder: "TRY" },
      { key: "warehouseCode", label: "Default warehouse code", type: "text", group: "Sync" },

      // ---- Advanced (common) ----
      { key: "timeoutMs", label: "Request timeout (ms)", type: "number", group: "Advanced", placeholder: "30000" },
      { key: "verifySsl", label: "Verify SSL certificate", type: "boolean", group: "Advanced" },
    ],
  },
  {
    key: "rest",
    name: "REST / API",
    category: "API",
    icon: "globe",
    description: "Generic outbound REST integration for custom systems and webhooks.",
    fields: [
      // ---- Connection (common) ----
      { key: "baseUrl", label: "Base URL", type: "text", required: true, group: "Connection", placeholder: "https://api.example.com" },
      {
        key: "defaultMethod",
        label: "Default method",
        type: "select",
        group: "Connection",
        options: [
          { value: "POST", label: "POST" },
          { value: "GET", label: "GET" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "DELETE", label: "DELETE" },
        ],
      },
      { key: "contentType", label: "Content-Type", type: "text", group: "Connection", placeholder: "application/json" },

      // ---- Authentication (per auth type) ----
      {
        key: "authType",
        label: "Auth type",
        type: "select",
        required: true,
        group: "Authentication",
        options: [
          { value: "none", label: "None" },
          { value: "bearer", label: "Bearer token" },
          { value: "basic", label: "Basic auth" },
          { value: "apiKey", label: "API key header" },
          { value: "oauth2", label: "OAuth2 (client credentials)" },
        ],
      },
      { key: "token", label: "Bearer token", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "authType", in: ["bearer"] } },
      { key: "username", label: "Username", type: "text", required: true, group: "Authentication", showWhen: { field: "authType", in: ["basic"] } },
      { key: "password", label: "Password", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "authType", in: ["basic"] } },
      { key: "headerName", label: "API key header name", type: "text", required: true, group: "Authentication", placeholder: "X-API-Key", showWhen: { field: "authType", in: ["apiKey"] } },
      { key: "apiKeyValue", label: "API key value", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "authType", in: ["apiKey"] } },
      { key: "clientId", label: "OAuth2 client ID", type: "text", required: true, group: "Authentication", showWhen: { field: "authType", in: ["oauth2"] } },
      { key: "clientSecret", label: "OAuth2 client secret", type: "password", secret: true, required: true, group: "Authentication", showWhen: { field: "authType", in: ["oauth2"] } },
      { key: "tokenUrl", label: "OAuth2 token URL", type: "text", required: true, group: "Authentication", placeholder: "https://api.example.com/oauth/token", showWhen: { field: "authType", in: ["oauth2"] } },
      { key: "scope", label: "OAuth2 scope", type: "text", group: "Authentication", showWhen: { field: "authType", in: ["oauth2"] } },

      // ---- Headers ----
      { key: "defaultHeaders", label: "Default headers (JSON)", type: "textarea", group: "Headers", placeholder: '{ "X-Tenant": "acme" }', help: "Extra headers sent with every request, as a JSON object." },

      // ---- Advanced (common) ----
      { key: "signingSecret", label: "HMAC signing secret", type: "password", secret: true, group: "Advanced", help: "When set, each request is signed (X-Signature) so the receiver can verify it." },
      { key: "timeoutMs", label: "Request timeout (ms)", type: "number", group: "Advanced", placeholder: "15000" },
      { key: "maxRetries", label: "Max retries", type: "number", group: "Advanced", placeholder: "3" },
      { key: "retryBackoffMs", label: "Retry backoff (ms)", type: "number", group: "Advanced", placeholder: "1000" },
      { key: "verifySsl", label: "Verify SSL certificate", type: "boolean", group: "Advanced" },
    ],
  },
];

export type IntegrationConfig = Record<string, string | number | boolean>;

export function getProviderDef(provider: string): IntegrationProviderDef | undefined {
  return INTEGRATION_PROVIDERS.find((p) => p.key === provider);
}

/**
 * Whether a field is active for the current config — its `showWhen` selector (if
 * any) matches the stored value. Used by the editor (to render) and the test
 * endpoint (to validate only the fields the chosen provider actually uses).
 */
export function fieldApplies(field: IntegrationField, config: IntegrationConfig): boolean {
  if (!field.showWhen) return true;
  const v = config[field.showWhen.field];
  return field.showWhen.in.includes(String(v ?? ""));
}

/** Default values for a provider, seeded from env where applicable (Email). */
export function integrationDefaults(provider: string): IntegrationConfig {
  switch (provider) {
    case "email":
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
    case "sms":
      return {
        provider: "twilio",
        defaultCountryCode: "+90",
        enableDeliveryReports: false,
        unicodeEnabled: true,
        timeoutMs: 15000,
        maxRetries: 3,
        rateLimitPerSec: 10,
      };
    case "whatsapp":
      return {
        provider: "cloud",
        apiVersion: "v19.0",
        baseUrl: "https://graph.facebook.com",
        templateLanguage: "tr",
        defaultCountryCode: "+90",
        timeoutMs: 15000,
        maxRetries: 3,
      };
    case "slack":
      return {
        mode: "webhook",
        username: "Aula CRM",
        iconEmoji: ":robot_face:",
        timeoutMs: 10000,
      };
    case "erp":
      return {
        environment: "production",
        syncDirection: "both",
        syncInvoices: true,
        syncOrders: true,
        syncProducts: false,
        syncCustomers: false,
        syncIntervalMin: 60,
        defaultCurrency: "TRY",
        timeoutMs: 30000,
        verifySsl: true,
      };
    case "rest":
      return {
        defaultMethod: "POST",
        authType: "none",
        contentType: "application/json",
        timeoutMs: 15000,
        maxRetries: 3,
        retryBackoffMs: 1000,
        verifySsl: true,
      };
    default:
      return {};
  }
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
