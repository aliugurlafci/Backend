/**
 * Mailbox: SMTP send, IMAP sync, the paged listing and the bulk operations the
 * mail board issues over a whole selection.
 */

import { type Router } from "express";
import { runApi, pathParam } from "@/lib/http/handler";
import { getDomainService } from "@/lib/domain";
import { notifyUser } from "@/lib/integrations/notifications";
import { automationStore } from "@/lib/automation";
import { emailIdsSchema, emailRestoreSchema, parseBody, sendEmailSchema } from "@/lib/http/body";
import { BadRequestError } from "@/lib/enforcement/errors";
import { MAX_PAGE_SIZE } from "@/lib/data/query";
import {
  sendMail,
  fetchHeaders,
  fetchBodiesByUid,
  deleteOnServer,
  restoreOnServer,
} from "@/lib/integrations/email-transport";

export function registerEmailRoutes(r: Router): void {
  // ---- email: SMTP send + IMAP sync (env-driven; DB-only when unconfigured) -
  r.post(
    "/email/send",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, sendEmailSchema);
        // `to` may be a single address or a list (single / bulk send to many recipients).
        const recipients = (Array.isArray(body.to) ? body.to : body.to ? [body.to] : [])
          .map((t) => String(t).trim())
          .filter(Boolean);
        if (recipients.length === 0) throw new BadRequestError("`to` is required");
        if (recipients.length > 100) throw new BadRequestError("too many recipients (max 100)");
        if ((body.subject ?? "").length > 512) throw new BadRequestError("subject too long (max 512)");
        if ((body.body ?? "").length > 100_000) throw new BadRequestError("body too long (max 100KB)");
        const domain = await getDomainService();
        const scope = { tenantId: rc.tenantId, orgId: rc.orgId };
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const records = [];
        let sentCount = 0;
        // One real message + one Sent record per recipient (individual delivery, no shared To).
        for (const to of recipients) {
          const messageId = await sendMail({ to, subject: body.subject ?? "", text: body.body ?? "" }, scope);
          if (messageId !== null) sentCount++;
          records.push(
            await domain.create(rc, "email", {
              folder: "sent",
              sender: to,
              subject: body.subject ?? "",
              body: body.body ?? "",
              unread: false,
            }),
          );
        }
        return { records, record: records[0], sent: sentCount > 0, count: records.length, smtpConfigured: emailCfg.smtpConfigured };
      },
      { mutating: true, status: 201 },
    ),
  );

  r.post(
    "/email/sync",
    runApi(
      async (rc) => {
        const scope = { tenantId: rc.tenantId, orgId: rc.orgId };
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        if (!emailCfg.imapConfigured) return { configured: false, synced: 0 };
        const domain = await getDomainService();
        const norm = (id: unknown) => String(id ?? "").replace(/[<>]/g, "").trim().toLowerCase();
        // Dedup precisely by Message-ID (one row per real email); fall back to
        // sender|subject only for mail with no Message-ID header.
        const keyOf = (messageId: unknown, sender: unknown, subject: unknown) => {
          const k = norm(messageId);
          return k ? `mid:${k}` : `ss:${String(sender)}|${String(subject)}`;
        };
        // Message-IDs already stored — stream the whole inbox to build the seen-set.
        const seen = new Set<string>();
        await domain.listAll(
          rc,
          "email",
          { filters: [{ field: "folder", op: "eq", value: "inbox" }] },
          (batch) => {
            for (const e of batch) seen.add(keyOf(e.messageId, e.sender, e.subject));
          },
        );
        // Cheap envelope scan of the whole mailbox (no bodies) → only the UIDs
        // whose Message-ID is new. We then download bodies ONLY for new mail,
        // capped per run so a large mailbox never times out the request.
        const headers = await fetchHeaders(scope);
        const freshUids = headers.filter((h) => !seen.has(`mid:${norm(h.messageId)}`)).map((h) => h.uid);
        if (freshUids.length === 0) return { configured: true, synced: 0, remaining: 0 };
        const BATCH = 100;
        const messages = await fetchBodiesByUid(freshUids.slice(0, BATCH), scope);
        let synced = 0;
        for (const m of messages) {
          const key = keyOf(m.messageId, m.sender, m.subject);
          if (seen.has(key)) continue; // post-check: envelope vs parsed Message-ID may differ
          seen.add(key);
          const created = await domain.create(rc, "email", {
            folder: "inbox",
            sender: m.sender,
            subject: m.subject,
            body: m.body,
            unread: true,
            messageId: m.messageId,
          });
          // A synced mailbox is personal to its owner; honour the `new_email` pref.
          await notifyUser({
            at: new Date().toISOString(),
            tenantId: rc.tenantId,
            orgId: rc.orgId,
            userId: rc.userId,
            channel: "email",
            subject: m.subject || "(no subject)",
            body: `New email from ${m.sender}`,
            eventType: "email.received",
            prefKey: "new_email",
            // Deep link straight to this message so the bell opens it in the mailbox.
            href: `/email?open=${encodeURIComponent(String(created.id))}`,
          });
          synced++;
        }
        return { configured: true, synced, remaining: Math.max(0, freshUids.length - BATCH) };
      },
      { mutating: true },
    ),
  );

  // Lightweight mailbox listing: full records minus the heavy `body` — just a
  // short preview. The mailbox UI loads this (paged) and fetches the full body
  // lazily via GET /entities/email/:id when a message is opened.
  r.get(
    "/email/list",
    runApi(async (rc, req) => {
      const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
      const domain = await getDomainService();
      const res = await domain.list(rc, "email", { page, pageSize: 200 });
      const items = res.items.map((e) => ({
        id: e.id,
        folder: e.folder,
        folderId: e.folderId ?? null,
        starred: Boolean(e.starred),
        // Needed so the client can target IMAP deletes for synced inbox messages.
        messageId: e.messageId ?? "",
        sender: e.sender,
        subject: e.subject,
        preview: String(e.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
        unread: e.unread,
        createdAt: e.createdAt,
        version: e.version,
      }));
      return { items, total: res.total, page: res.page, pageSize: res.pageSize, pageCount: res.pageCount };
    }),
  );

  // Delete a custom mail folder. Its messages are first reassigned back to their
  // base system folder (folderId cleared) so nothing is orphaned, then the folder
  // row is removed. (Folder create/rename/list use generic /entities/emailFolder.)
  r.delete(
    "/email/folders/:id",
    runApi(
      async (rc, req) => {
        const id = String(pathParam(req, "id"));
        const domain = await getDomainService();
        let reassigned = 0;
        // Clear folderId on this folder's messages in bulk (one UPDATE per page);
        // reassigned rows drop out of the filter, so always re-read the first page.
        for (;;) {
          const msgs = await domain.list(rc, "email", {
            filters: [{ field: "folderId", op: "eq", value: id }],
            pageSize: MAX_PAGE_SIZE,
            page: 1,
          });
          if (msgs.items.length === 0) break;
          reassigned += await domain.updateMany(rc, "email", msgs.items.map((m) => String(m.id)), { folderId: null });
        }
        await domain.remove(rc, "emailFolder", id);
        return { ok: true, reassigned };
      },
      { mutating: true },
    ),
  );

  // ---- bulk mailbox ops (one request for the whole selection; the UI chunks at
  //      250 so 1000s of messages move/delete without 1000s of round trips) -----

  // Move many messages to a system folder (folder + clear folderId) or a custom
  // folder (set folderId) — ONE bulk UPDATE. Organizational only (no IMAP).
  r.post(
    "/email/move",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, emailIdsSchema);
        const ids = (body.ids ?? []).map(String);
        const patch: Record<string, unknown> = {};
        if (typeof body.folder === "string") patch.folder = body.folder;
        if ("folderId" in body) patch.folderId = body.folderId ?? null;
        const domain = await getDomainService();
        const updated = await domain.updateMany(rc, "email", ids, patch);
        return { updated };
      },
      { mutating: true },
    ),
  );

  // Move many messages to Trash (folder → "trash", folderId cleared) in ONE bulk
  // UPDATE, then remove them from the IMAP server (Gmail) by the client-supplied
  // message-ids when configured.
  r.post(
    "/email/trash",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, emailIdsSchema);
        const ids = (body.ids ?? []).map(String);
        const domain = await getDomainService();
        const updated = await domain.updateMany(rc, "email", ids, { folder: "trash", folderId: null });
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const serverDeleted = emailCfg.imapConfigured
          ? await deleteOnServer(body.messageIds ?? [], { tenantId: rc.tenantId, orgId: rc.orgId })
          : 0;
        return { updated, serverDeleted, configured: emailCfg.imapConfigured };
      },
      { mutating: true },
    ),
  );

  // Permanently delete many messages — ONE bulk DELETE + IMAP delete.
  r.post(
    "/email/purge",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, emailIdsSchema);
        const ids = (body.ids ?? []).map(String);
        const domain = await getDomainService();
        const deleted = await domain.removeMany(rc, "email", ids);
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const serverDeleted = emailCfg.imapConfigured
          ? await deleteOnServer(body.messageIds ?? [], { tenantId: rc.tenantId, orgId: rc.orgId })
          : 0;
        return { deleted, serverDeleted, configured: emailCfg.imapConfigured };
      },
      { mutating: true },
    ),
  );

  // Restore many messages from Trash to their original folder (grouped bulk
  // UPDATEs, since targets may differ) + move them back on the IMAP server.
  r.post(
    "/email/restore",
    runApi(
      async (rc, req) => {
        const body = parseBody(req, emailRestoreSchema);
        const incoming = body.items ?? [];
        const domain = await getDomainService();
        // Group ids by identical (folder, folderId) target so each group is one UPDATE.
        const groups = new Map<string, { folder?: string; folderId: string | null; ids: string[] }>();
        for (const it of incoming) {
          const folder = typeof it.folder === "string" ? it.folder : undefined;
          const folderId = it.folderId ?? null;
          const key = `${folder ?? ""}|${folderId ?? ""}`;
          const g = groups.get(key) ?? { folder, folderId, ids: [] };
          g.ids.push(String(it.id));
          groups.set(key, g);
        }
        let updated = 0;
        for (const g of groups.values()) {
          const patch: Record<string, unknown> = { folderId: g.folderId };
          if (g.folder) patch.folder = g.folder;
          updated += await domain.updateMany(rc, "email", g.ids, patch);
        }
        const emailCfg = await automationStore.resolveEmail(rc.tenantId, rc.orgId);
        const serverRestored = emailCfg.imapConfigured
          ? await restoreOnServer(body.messageIds ?? [], { tenantId: rc.tenantId, orgId: rc.orgId })
          : 0;
        return { updated, serverRestored };
      },
      { mutating: true },
    ),
  );

}
