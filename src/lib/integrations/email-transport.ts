/**
 * Email transport — SMTP send (nodemailer) + IMAP fetch (imapflow).
 *
 * The connection is resolved from the DB-backed Email integration (Automation →
 * Integrations) with the SMTP/IMAP env vars as the fallback. So mail config is
 * managed in the database and editable from the app; when nothing is configured
 * the mailbox is DB-only (compose stores to "sent"; sync is a no-op).
 */
import nodemailer, { type Transporter } from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { automationStore } from "@/lib/automation/store";
import { resolveEmailConfig, type ResolvedEmailConfig } from "@/lib/automation/integrations";
import { logger } from "@/lib/observability/logger";

/** Tenant scope used to resolve the per-tenant email connection. */
export interface EmailScope {
  tenantId: string;
  orgId: string;
}

/** Resolve the effective email connection: DB integration (per tenant) → env. */
async function resolve(scope?: EmailScope): Promise<ResolvedEmailConfig> {
  if (scope) return automationStore.resolveEmail(scope.tenantId, scope.orgId);
  return resolveEmailConfig(null, true); // env-only fallback (treated as enabled)
}

// SMTP transporters are cached per distinct connection so repeated sends reuse a
// pooled connection; the cache key is the resolved SMTP tuple.
const transporters = new Map<string, Transporter>();

function transporterFor(cfg: ResolvedEmailConfig): Transporter {
  const key = `${cfg.smtpHost}:${cfg.smtpPort}:${cfg.smtpUser}:${cfg.smtpSecure}`;
  let tx = transporters.get(key);
  if (!tx) {
    tx = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpSecure, // true for 465, false for 587/STARTTLS
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    });
    transporters.set(key, tx);
  }
  return tx;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Send an email via SMTP. Returns the provider message id, or null when SMTP is unconfigured. */
export async function sendMail(mail: OutgoingMail, scope?: EmailScope): Promise<string | null> {
  const cfg = await resolve(scope);
  if (!cfg.smtpConfigured) return null;
  const info = await transporterFor(cfg).sendMail({
    from: cfg.smtpFrom || cfg.smtpUser,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
  logger.info("smtp mail sent", { to: mail.to, messageId: info.messageId });
  return info.messageId ?? null;
}

export interface FetchedMail {
  sender: string;
  subject: string;
  body: string;
  receivedAt: string;
  messageId: string;
}

function makeImapClient(cfg: ResolvedEmailConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapSecure,
    auth: { user: cfg.imapUser, pass: cfg.imapPass },
    logger: false,
  });
}

export interface MailHeader {
  uid: number;
  messageId: string;
}

/**
 * Cheap envelope-only scan (no message bodies) — used to discover which messages
 * are new. With no `limit` the whole mailbox is scanned; pass a positive number
 * to scan just the most recent N (new mail is always recent, so this stays fast).
 */
export async function fetchHeaders(scope?: EmailScope, limit?: number): Promise<MailHeader[]> {
  const cfg = await resolve(scope);
  if (!cfg.imapConfigured) return [];
  const client = makeImapClient(cfg);
  const out: MailHeader[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.imapMailbox);
    try {
      const mailbox = client.mailbox;
      const total = typeof mailbox === "object" && mailbox ? mailbox.exists : 0;
      if (!total) return [];
      const from = limit && limit > 0 ? Math.max(1, total - limit + 1) : 1;
      for await (const msg of client.fetch(`${from}:*`, { envelope: true })) {
        out.push({ uid: msg.uid, messageId: msg.envelope?.messageId ?? "" });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

/** Download + parse full bodies for the given UIDs (chunked to keep IMAP commands small). */
export async function fetchBodiesByUid(uids: number[], scope?: EmailScope): Promise<FetchedMail[]> {
  const cfg = await resolve(scope);
  if (!cfg.imapConfigured || uids.length === 0) return [];
  const client = makeImapClient(cfg);
  const out: FetchedMail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.imapMailbox);
    try {
      for (let i = 0; i < uids.length; i += 200) {
        const chunk = uids.slice(i, i + 200);
        for await (const msg of client.fetch(chunk.join(","), { source: true }, { uid: true })) {
          const parsed = await simpleParser(msg.source as Buffer);
          out.push({
            sender: parsed.from?.text ?? "(unknown)",
            subject: parsed.subject ?? "(no subject)",
            body: parsed.text ?? parsed.html?.toString() ?? "",
            receivedAt: (parsed.date ?? new Date()).toISOString(),
            messageId: parsed.messageId ?? `${msg.uid}@${cfg.imapHost}`,
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

/**
 * Fetch messages from the configured IMAP mailbox. With no `limit` the whole
 * mailbox is pulled; pass a positive number to fetch only the most recent N.
 * Returns an empty list when IMAP is unconfigured.
 */
export async function fetchInbox(scope?: EmailScope, limit?: number): Promise<FetchedMail[]> {
  const cfg = await resolve(scope);
  if (!cfg.imapConfigured) return [];
  const client = makeImapClient(cfg);

  const out: FetchedMail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.imapMailbox);
    try {
      const mailbox = client.mailbox;
      const total = typeof mailbox === "object" && mailbox ? mailbox.exists : 0;
      if (!total) return [];
      const from = limit && limit > 0 ? Math.max(1, total - limit + 1) : 1;
      for await (const msg of client.fetch(`${from}:*`, { source: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        out.push({
          sender: parsed.from?.text ?? "(unknown)",
          subject: parsed.subject ?? "(no subject)",
          body: parsed.text ?? parsed.html?.toString() ?? "",
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          messageId: parsed.messageId ?? `${msg.uid}@${cfg.imapHost}`,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out.reverse(); // newest first
}
