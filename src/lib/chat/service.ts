/**
 * Chat service — the only path normal users have to chat data.
 *
 * All reads/writes run under an elevated (system) context with EXPLICIT,
 * server-side participant-membership checks, so a user can never read or post
 * to a conversation they are not part of (the generic `/entities/chatMessage`
 * grants are withheld from non-admin roles for the same reason). Conversations
 * are keyed deterministically from the sorted participant user ids, so the same
 * set of people always shares one thread.
 */
import { getQueryEngine } from "@/lib/data/store";
import { systemContext } from "@/lib/context/resolver";
import { BadRequestError, ForbiddenError } from "@/lib/enforcement/errors";
import type { RequestContext } from "@/lib/context/types";
import type { EntityRecord } from "@/lib/metadata/types";

export interface ChatAttachment {
  fileId: string;
  name: string;
  kind: "image" | "file";
  sizeKb?: number;
}

export interface CreateChatInput {
  participants?: Array<string | number>;
  conversationId?: string;
  body?: string | null;
  attachments?: ChatAttachment[] | null;
}

/** Elevated context scoped to the caller's tenant/org (bypasses RBAC; we gate by membership instead). */
function sys(ctx: RequestContext): RequestContext {
  return systemContext(ctx.tenantId, ctx.orgId);
}

/** Deterministic conversation key + `,id,id,` membership string from participant ids. */
export function conversationKey(ids: Array<string | number>): { conversationId: string; participants: string } {
  const uniq = [...new Set(ids.map((x) => String(x)).filter((x) => /^\d+$/.test(x)))];
  uniq.sort((a, b) => Number(a) - Number(b));
  return { conversationId: uniq.join("-"), participants: uniq.length ? `,${uniq.join(",")},` : "" };
}

function isMember(conversationId: string, userId: string): boolean {
  return conversationId.split("-").includes(String(userId));
}

const byCreatedAt = (a: EntityRecord, b: EntityRecord) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1);

/** Persist a message; ensures the caller is a participant and the thread has ≥2 people. */
export async function createMessage(ctx: RequestContext, input: CreateChatInput): Promise<EntityRecord> {
  const seedIds = input.conversationId ? input.conversationId.split("-") : (input.participants ?? []).map(String);
  const { conversationId, participants } = conversationKey([...seedIds, ctx.userId]);
  if (conversationId.split("-").filter(Boolean).length < 2) {
    throw new BadRequestError("a conversation needs at least one other participant");
  }
  const body = (input.body ?? "").trim();
  const atts = Array.isArray(input.attachments) ? input.attachments : [];
  if (!body && atts.length === 0) throw new BadRequestError("message body or an attachment is required");

  const qe = await getQueryEngine();
  return qe.create(sys(ctx), "chatMessage", {
    conversationId,
    participants,
    fromUserId: String(ctx.userId),
    author: ctx.displayName,
    body: body || null,
    attachments: atts.length ? JSON.stringify(atts) : null,
  });
}

/** Messages of a conversation — only if the caller is a participant. */
export async function listMessages(ctx: RequestContext, conversationId: string): Promise<EntityRecord[]> {
  if (!conversationId || !isMember(conversationId, ctx.userId)) {
    throw new ForbiddenError("you are not a participant of this conversation");
  }
  const qe = await getQueryEngine();
  const page = await qe.list(sys(ctx), "chatMessage", {
    filters: [{ field: "conversationId", op: "eq", value: conversationId }],
    pageSize: 1000,
  });
  return [...page.items].sort(byCreatedAt);
}

export interface ConversationSummary {
  conversationId: string;
  participants: string[];
  title: string;
  last: { body: string | null; author: string | null; createdAt: string; fromUserId: string | null; hasAttachments: boolean };
}

/** The caller's conversations (where they are a participant), newest first. */
export async function listConversations(ctx: RequestContext): Promise<ConversationSummary[]> {
  const qe = await getQueryEngine();
  const page = await qe.list(sys(ctx), "chatMessage", {
    filters: [{ field: "participants", op: "contains", value: `,${ctx.userId},` }],
    pageSize: 2000,
  });
  const names = await userNameMap(ctx);

  const byConv = new Map<string, EntityRecord[]>();
  for (const m of page.items) {
    const cid = String(m.conversationId);
    (byConv.get(cid) ?? byConv.set(cid, []).get(cid)!).push(m);
  }

  const out: ConversationSummary[] = [];
  for (const [conversationId, msgs] of byConv) {
    const sorted = [...msgs].sort(byCreatedAt);
    const last = sorted[sorted.length - 1];
    const ids = conversationId.split("-");
    const others = ids.filter((id) => id !== String(ctx.userId));
    out.push({
      conversationId,
      participants: ids,
      title: others.map((id) => names.get(id) ?? `User ${id}`).join(", ") || "Me",
      last: {
        body: (last.body as string) ?? null,
        author: (last.author as string) ?? null,
        createdAt: String(last.createdAt),
        fromUserId: (last.fromUserId as string) ?? null,
        hasAttachments: Boolean(last.attachments),
      },
    });
  }
  out.sort((a, b) => (a.last.createdAt < b.last.createdAt ? 1 : -1));
  return out;
}

export interface ChatUser {
  id: string;
  displayName: string;
  email: string;
  role: string;
  roleLabel: string;
  isAdmin: boolean;
  branchId: string | null;
  branchName: string | null;
  dealerId: string | null;
  dealerName: string | null;
}

async function loadActiveUsers(ctx: RequestContext): Promise<EntityRecord[]> {
  const qe = await getQueryEngine();
  const page = await qe.list(sys(ctx), "user", {
    filters: [{ field: "active", op: "eq", value: true }],
    pageSize: 1000,
  });
  return page.items;
}

async function userNameMap(ctx: RequestContext): Promise<Map<string, string>> {
  const users = await loadActiveUsers(ctx);
  return new Map(users.map((u) => [String(u.id), String(u.displayName ?? u.email ?? u.id)]));
}

/** Selectable chat users (the company + its branches/dealers), excluding the caller. */
export async function listChatUsers(ctx: RequestContext): Promise<ChatUser[]> {
  const qe = await getQueryEngine();
  const [users, positions, branches, dealers] = await Promise.all([
    loadActiveUsers(ctx),
    qe.list(sys(ctx), "position", { pageSize: 200 }),
    qe.list(sys(ctx), "branch", { pageSize: 500 }),
    qe.list(sys(ctx), "dealer", { pageSize: 500 }),
  ]);
  const pos = new Map(positions.items.map((p) => [String(p.id), { role: String(p.role ?? ""), name: String(p.name ?? "") }]));
  const branchName = new Map(branches.items.map((b) => [String(b.id), String(b.name ?? b.code ?? "")]));
  const dealerName = new Map(dealers.items.map((d) => [String(d.id), String(d.name ?? d.code ?? "")]));

  return users
    .filter((u) => String(u.id) !== String(ctx.userId))
    .map((u) => {
      const p = pos.get(String(u.positionId));
      const branchId = u.branchId ? String(u.branchId) : null;
      const dealerId = u.dealerId ? String(u.dealerId) : null;
      return {
        id: String(u.id),
        displayName: String(u.displayName ?? u.email ?? u.id),
        email: String(u.email ?? ""),
        role: p?.role ?? "",
        roleLabel: p?.name ?? "",
        isAdmin: p?.role === "admin",
        branchId,
        branchName: branchId ? branchName.get(branchId) ?? null : null,
        dealerId,
        dealerName: dealerId ? dealerName.get(dealerId) ?? null : null,
      };
    });
}
