/**
 * Email transport — SMTP send (nodemailer) + IMAP fetch (imapflow).
 *
 * Both are optional: when the SMTP and IMAP env vars are unset the mailbox is
 * DB-only (compose just stores to "sent"; sync is a no-op). When configured,
 * compose sends real mail and `/email/sync` pulls the real inbox into the
 * `email` entity table.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env, smtpConfigured, imapConfigured } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!smtpConfigured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE, // true for 465, false for 587/STARTTLS
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Send an email via SMTP. Returns the provider message id, or null when SMTP is unconfigured. */
export async function sendMail(mail: OutgoingMail): Promise<string | null> {
  const tx = getTransporter();
  if (!tx) return null;
  const info = await tx.sendMail({
    from: env.SMTP_FROM || env.SMTP_USER,
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

function makeImapClient(): ImapFlow {
  return new ImapFlow({
    host: env.IMAP_HOST!,
    port: env.IMAP_PORT,
    secure: env.IMAP_SECURE,
    auth: { user: env.IMAP_USER!, pass: env.IMAP_PASS ?? "" },
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
export async function fetchHeaders(limit?: number): Promise<MailHeader[]> {
  if (!imapConfigured) return [];
  const client = makeImapClient();
  const out: MailHeader[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(env.IMAP_MAILBOX);
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
export async function fetchBodiesByUid(uids: number[]): Promise<FetchedMail[]> {
  if (!imapConfigured || uids.length === 0) return [];
  const client = makeImapClient();
  const out: FetchedMail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(env.IMAP_MAILBOX);
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
            messageId: parsed.messageId ?? `${msg.uid}@${env.IMAP_HOST}`,
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
export async function fetchInbox(limit?: number): Promise<FetchedMail[]> {
  if (!imapConfigured) return [];
  const client = makeImapClient();

  const out: FetchedMail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(env.IMAP_MAILBOX);
    try {
      const mailbox = client.mailbox;
      const total = typeof mailbox === "object" && mailbox ? mailbox.exists : 0;
      if (!total) return [];
      // No limit → fetch the entire mailbox (1:*); otherwise just the most recent N.
      const from = limit && limit > 0 ? Math.max(1, total - limit + 1) : 1;
      for await (const msg of client.fetch(`${from}:*`, { source: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        out.push({
          sender: parsed.from?.text ?? "(unknown)",
          subject: parsed.subject ?? "(no subject)",
          body: parsed.text ?? parsed.html?.toString() ?? "",
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          messageId: parsed.messageId ?? `${msg.uid}@${env.IMAP_HOST}`,
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
