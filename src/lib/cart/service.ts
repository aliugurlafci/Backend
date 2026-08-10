import { BASE_CURRENCY } from "@/lib/config/env";
/**
 * Cart (Sepet) service — the two ways a basket can be worked.
 *
 *  1. **Send to the register.** `send` stamps the cart with a short numeric
 *     pickup code and parks it in the register queue. A cashier finds it by that
 *     code and then takes payment (`close` with `paid`), closes it to the
 *     customer's account (`close` with `credit`), suspends it or cancels it.
 *  2. **Ring it up directly.** `close` straight from `open` — the original cart
 *     flow, unchanged for anyone holding `cart:checkout`.
 *
 * Both endings run through the POS service (invoice → send: posts AR/Revenue/
 * COGS and issues stock), so the cart never duplicates GL or stock logic.
 *
 * Authorization mirrors the POS service: the caller's real grants are checked
 * against the lifecycle transition up front (`assertTransition`), then the writes
 * run under an elevated system context that preserves the actor. That way a
 * cashier needs only the cart grants an admin ticked — not broad update rights
 * over baskets other people built (which record-level ABAC would otherwise deny).
 */
import { metadata } from "@/lib/metadata";
import type { EntityRecord, FieldValue } from "@/lib/metadata/types";
import type { RequestContext } from "@/lib/context/types";
import { systemContext } from "@/lib/context/resolver";
import { getQueryEngine } from "@/lib/data/store";
import type { QueryEngine } from "@/lib/data/query-engine";
import type { Filter } from "@/lib/data/query";
import { StateMachine } from "@/lib/domain/state-machine";
import { getDomainService, type DomainService } from "@/lib/domain";
import { getFinanceService, type FinanceService, type LineInput } from "@/lib/finance/service";
import { getPosService, type PosService, type PosPayment } from "@/lib/pos/service";
import { permissionEngine } from "@/lib/permissions/engine";
import { assertAllowed, BadRequestError, ConflictError } from "@/lib/enforcement";

/** Cart states that hold a live register code (and so must not collide). */
export const ACTIVE_CART_STATUSES = ["sent", "suspended"] as const;
/** Highest pickup code handed out before the allocator gives up. */
export const MAX_CART_CODE = 99_999_999;
/** Page size used to walk active codes when looking for the lowest free one. */
const CODE_SCAN_PAGE = 200;

export type CartSettlement = "paid" | "credit";

/**
 * The lowest positive integer missing from `codes` — the next register code to
 * hand out. Codes are recycled on purpose (see {@link CartService.lowestFreeCode}),
 * so this looks for the first gap rather than the maximum: `[1, 2, 4]` yields 3,
 * `[2, 3]` yields 1, and an empty queue yields 1. Values that are not usable
 * codes (null, 0, negatives, non-integers) are ignored, as are duplicates.
 */
export function firstFreeCode(codes: Iterable<number>): number {
  const used = new Set<number>();
  for (const raw of codes) {
    const code = Number(raw);
    if (Number.isInteger(code) && code >= 1) used.add(code);
  }
  let candidate = 1;
  while (used.has(candidate)) candidate++;
  return candidate;
}

export interface CartListQuery {
  /** Statuses to include (default: `open`). */
  statuses?: string[];
  /** Exact register code — the cashier's lookup. */
  code?: number | null;
  /** Restrict to baskets the caller created. */
  mine?: boolean;
  /** Free-text term (cart number / creator name). */
  search?: string | null;
  pageSize?: number;
}

export interface CartCloseInput {
  settlement: CartSettlement;
  payments?: PosPayment[];
  idempotencyKey?: string | null;
}

export interface CartCloseResult {
  cart: EntityRecord;
  invoice: EntityRecord;
  total: number;
  paid: number;
  change: number;
}

export class CartService {
  constructor(
    private readonly qe: QueryEngine,
    private readonly domain: DomainService,
    private readonly finance: FinanceService,
    private readonly pos: PosService,
  ) {}

  /** Elevated context that keeps the caller as the recorded actor. */
  private sys(ctx: RequestContext): RequestContext {
    return systemContext(ctx.tenantId, ctx.orgId, {
      userId: ctx.userId,
      displayName: ctx.displayName,
      email: ctx.email,
    });
  }

  /** The cart state machine, built once per metadata version — the queue endpoint
   *  asks for it per cart, so it must not allocate on every row. */
  private machine: { version: number; sm: StateMachine } | null = null;

  private stateMachine(): StateMachine {
    if (this.machine?.version === metadata.version) return this.machine.sm;
    const def = metadata.getEntity("cart");
    if (!def.lifecycle) throw new BadRequestError("cart has no lifecycle");
    const sm = new StateMachine(def.lifecycle);
    this.machine = { version: metadata.version, sm };
    return sm;
  }

  /**
   * Is `action` legal from the cart's current state, and does the *caller* hold
   * the grant it requires? Checked before any financial work, so a rejected
   * cashier never leaves a half-rung sale behind.
   */
  private assertTransition(ctx: RequestContext, cart: EntityRecord, action: string): void {
    const from = String(cart.status ?? "open");
    const transition = this.stateMachine().find(from, action);
    if (!transition) throw new ConflictError(`cannot "${action}" a cart in state "${from}"`).withKey("err.cartTransition", { action, from });
    if (transition.requires) {
      assertAllowed(
        permissionEngine.evaluate(ctx, {
          action: transition.requires,
          entity: "cart",
          recordOwnerId: cart.ownerId,
        }),
      );
    }
  }

  /** The lifecycle actions the caller may run on this cart right now. */
  actionsFor(ctx: RequestContext, cart: EntityRecord): string[] {
    const from = String(cart.status ?? "open");
    return this.stateMachine()
      .transitionsFrom(from)
      .filter(
        (t) =>
          !t.requires ||
          permissionEngine.can(ctx, { action: t.requires, entity: "cart", recordOwnerId: cart.ownerId }),
      )
      .map((t) => t.action);
  }

  // ---- reads ------------------------------------------------------------

  async list(ctx: RequestContext, query: CartListQuery = {}): Promise<EntityRecord[]> {
    const statuses = query.statuses?.length ? query.statuses : ["open"];
    const filters: Filter[] = [{ field: "status", op: "in", value: statuses }];
    if (query.code != null) filters.push({ field: "code", op: "eq", value: query.code });
    const page = await this.domain.list(ctx, "cart", {
      filters,
      search: query.search?.trim() || undefined,
      sort: [{ field: "code", dir: "asc" }],
      pageSize: Math.min(200, Math.max(1, query.pageSize ?? 100)),
    });
    // Ownership lives in a system column, which the metadata-driven filter layer
    // does not accept — so "only mine" is applied here.
    return query.mine
      ? page.items.filter((c) => String(c.ownerId ?? c.createdBy ?? "") === ctx.userId)
      : page.items;
  }

  // ---- register codes ---------------------------------------------------

  /**
   * The lowest positive integer no active cart is using.
   *
   * Codes are deliberately recycled: a cart that is closed, cancelled or turned
   * back into a draft releases its number, so the next basket sent to the
   * register takes the smallest gap (cart 2 closed ⇒ the next send is 2 again).
   * Walks the active carts in code order — one page in practice, since only
   * queued baskets hold a code.
   */
  private async lowestFreeCode(ctx: RequestContext): Promise<number> {
    const taken: number[] = [];
    for (let page = 1; ; page++) {
      const res = await this.qe.list(ctx, "cart", {
        filters: [{ field: "status", op: "in", value: [...ACTIVE_CART_STATUSES] }],
        sort: [{ field: "code", dir: "asc" }],
        page,
        pageSize: CODE_SCAN_PAGE,
      });
      for (const row of res.items) taken.push(Number(row.code ?? 0));
      if (res.items.length < CODE_SCAN_PAGE || page >= res.pageCount) break;
    }
    const code = firstFreeCode(taken);
    if (code > MAX_CART_CODE) {
      throw new ConflictError("no free cart number is available — close or cancel queued carts first");
    }
    return code;
  }

  // ---- transitions ------------------------------------------------------

  /**
   * Hand the basket to the cash desk: assign the pickup code, stamp who sent it
   * and when, then move it to `sent`. A basket that somehow already carries a
   * number keeps it, so the code a salesperson already read out stays valid.
   */
  async send(ctx: RequestContext, cartId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const cart = await this.qe.get(ctx, "cart", cartId);
    this.assertTransition(ctx, cart, "send");
    const { lines } = await this.finance.getDocument(sys, "cart", "cartLine", "cartId", cartId);
    if (!lines.length) throw new BadRequestError("cart is empty");

    const stamps: Record<string, FieldValue> = { sentAt: ctx.at };
    // Fill the denormalized creator name for baskets saved before it existed —
    // only from the owner themselves, since we cannot resolve another user's name
    // without `user:read`.
    if (!cart.createdByName && (!cart.ownerId || cart.ownerId === ctx.userId)) {
      stamps.createdByName = ctx.displayName;
    }

    const reuse = Number(cart.code ?? 0);
    const claimed = reuse > 0 ? reuse : await this.lowestFreeCode(sys);
    await this.qe.runInTransaction(async () => {
      await this.qe.patchComputed(sys, "cart", cartId, { ...stamps, code: claimed });
      await this.domain.transition(sys, "cart", cartId, "send");
    });
    // Codes are unique among *active* carts only — there is no unique index to
    // lean on — so confirm the claim now that the cart is visible as queued. If a
    // second register claimed the same number in the same instant, the older cart
    // keeps it and this one quietly moves to the next free number.
    return this.settleCode(sys, cartId, claimed);
  }

  /**
   * Confirm this cart's exclusive hold on `code`, re-numbering it if another
   * active cart already had it. Bounded so a pathological race still terminates
   * with the cart queued (the code is what may change, never the basket).
   */
  private async settleCode(sys: RequestContext, cartId: string, code: number): Promise<EntityRecord> {
    let current = code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const page = await this.qe.list(sys, "cart", {
        filters: [
          { field: "code", op: "eq", value: current },
          { field: "status", op: "in", value: [...ACTIVE_CART_STATUSES] },
        ],
        sort: [{ field: "sentAt", dir: "asc" }],
        pageSize: 5,
      });
      const holder = page.items[0];
      if (!holder || String(holder.id) === String(cartId)) return this.qe.get(sys, "cart", cartId);
      current = await this.lowestFreeCode(sys);
      await this.qe.patchComputed(sys, "cart", cartId, { code: current });
    }
    return this.qe.get(sys, "cart", cartId);
  }

  /** Park a queued cart (customer stepped away) — it keeps its code. */
  async suspend(ctx: RequestContext, cartId: string): Promise<EntityRecord> {
    return this.runTransition(ctx, cartId, "suspend");
  }

  /** Put a suspended cart back in the register queue. */
  async resume(ctx: RequestContext, cartId: string): Promise<EntityRecord> {
    return this.runTransition(ctx, cartId, "resume");
  }

  /**
   * Reject/void a cart. The code stays on the record for traceability — since
   * only active carts are scanned when allocating, cancelling already frees the
   * number for the next basket.
   */
  async cancel(ctx: RequestContext, cartId: string): Promise<EntityRecord> {
    const sys = this.sys(ctx);
    const cart = await this.qe.get(ctx, "cart", cartId);
    this.assertTransition(ctx, cart, "cancel");
    await this.qe.patchComputed(sys, "cart", cartId, { closedByName: ctx.displayName, closedAt: ctx.at });
    return this.domain.transition(sys, "cart", cartId, "cancel");
  }

  private async runTransition(ctx: RequestContext, cartId: string, action: string): Promise<EntityRecord> {
    const cart = await this.qe.get(ctx, "cart", cartId);
    this.assertTransition(ctx, cart, action);
    return this.domain.transition(this.sys(ctx), "cart", cartId, action);
  }

  // ---- register edits ---------------------------------------------------

  /**
   * Edit a cart's header + lines. A queued basket belongs to the register, so the
   * write runs elevated once the caller's `cart:update` grant is verified —
   * otherwise ABAC would refuse to let a cashier touch someone else's basket.
   * Drafts keep the ordinary owner-scoped path.
   */
  async save(
    ctx: RequestContext,
    cartId: string,
    header: Record<string, unknown> | undefined,
    lines: LineInput[],
  ): Promise<{ doc: EntityRecord; lines: EntityRecord[] }> {
    const cart = await this.qe.get(ctx, "cart", cartId);
    const status = String(cart.status ?? "open");
    if (status === "converted" || status === "cancelled") {
      throw new ConflictError(`a ${status} cart can no longer be edited`).withKey("err.cartNotEditable", { status });
    }
    const queued = (ACTIVE_CART_STATUSES as readonly string[]).includes(status);
    if (!queued) return this.finance.saveDocument(ctx, "cart", "cartLine", "cartId", cartId, header, lines);

    assertAllowed(
      permissionEngine.evaluate(ctx, { action: "cart:update", entity: "cart", recordOwnerId: null }),
    );
    const sys = this.sys(ctx);
    // The lifecycle field is transition-managed; never let it ride in on a header.
    const safeHeader = { ...(header ?? {}) };
    delete safeHeader.status;
    delete safeHeader.code;
    return this.finance.saveDocument(sys, "cart", "cartLine", "cartId", cartId, safeHeader, lines);
  }

  // ---- closing ----------------------------------------------------------

  /**
   * Close the cart: ring it through the POS pipeline (invoice → send → tender),
   * then mark it converted. `paid` applies the tender at the register; `credit`
   * closes it with no payment, leaving the balance on the customer's account.
   */
  async close(ctx: RequestContext, cartId: string, input: CartCloseInput): Promise<CartCloseResult> {
    const settlement: CartSettlement = input.settlement === "credit" ? "credit" : "paid";
    const action = settlement === "credit" ? "credit" : "checkout";
    const sys = this.sys(ctx);

    const { doc: cart, lines } = await this.finance.getDocument(ctx, "cart", "cartLine", "cartId", cartId);
    this.assertTransition(ctx, cart, action);
    if (!lines.length) throw new BadRequestError("cart is empty");

    const payments = settlement === "credit" ? [] : (input.payments ?? []).filter((p) => p.amount > 0);
    if (settlement === "paid" && payments.length === 0) {
      throw new BadRequestError("a payment is required — use the on-account close to leave the balance open");
    }

    const result = await this.pos.checkout(sys, {
      idempotencyKey: input.idempotencyKey || `cart:${cartId}`,
      branchId: (cart.branchId as string) ?? null,
      warehouseId: (cart.warehouseId as string) ?? null,
      accountId: (cart.accountId as string) ?? null,
      currencyCode: String(cart.currencyCode ?? BASE_CURRENCY),
      lines: lines.map((l) => ({
        productId: (l.productId as string) ?? null,
        description: String(l.description ?? ""),
        qty: Number(l.qty ?? 0),
        unitPrice: Number(l.unitPrice ?? 0),
        taxRate: Number(l.taxRate ?? 0),
      })),
      payments,
    });

    await this.qe.patchComputed(sys, "cart", cartId, {
      convertedInvoiceId: String(result.invoice.id),
      settlement,
      closedByName: ctx.displayName,
      closedAt: ctx.at,
    });
    const closed = await this.domain.transition(sys, "cart", cartId, action);

    return { cart: closed, invoice: result.invoice, total: result.total, paid: result.paid, change: result.change };
  }
}

const globalRef = globalThis as unknown as { __aulaCart?: CartService };

export async function getCartService(): Promise<CartService> {
  const [qe, domain, finance, pos] = await Promise.all([
    getQueryEngine(),
    getDomainService(),
    getFinanceService(),
    getPosService(),
  ]);
  globalRef.__aulaCart ??= new CartService(qe, domain, finance, pos);
  return globalRef.__aulaCart;
}
