/**
 * Cart register codes + lifecycle.
 *
 * The pickup code a cashier types is deliberately recycled: only carts still at
 * the register hold one, so closing or cancelling a cart frees its number and the
 * next basket sent takes the lowest gap. These tests pin that allocation rule and
 * the state machine / permission surface the two cart modes hang off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstFreeCode, MAX_CART_CODE, ACTIVE_CART_STATUSES } from "@/lib/cart/service";
import { cartEntity } from "@/lib/metadata/entities";
import { StateMachine } from "@/lib/domain/state-machine";
import { GRANTABLE_SYSTEM_ENTITIES, roleGrants, grantMatches } from "@/lib/permissions/policies";

test("an empty register queue hands out code 1", () => {
  assert.equal(firstFreeCode([]), 1);
});

test("codes are handed out in ascending order while the run is contiguous", () => {
  assert.equal(firstFreeCode([1]), 2);
  assert.equal(firstFreeCode([1, 2, 3]), 4);
});

test("a closed cart frees its number — the next send takes the lowest gap", () => {
  assert.equal(firstFreeCode([1, 3]), 2, "cart 2 was closed");
  assert.equal(firstFreeCode([2, 3]), 1, "cart 1 was closed");
  assert.equal(firstFreeCode([1, 2, 4, 5]), 3);
});

test("unusable and duplicate values are ignored", () => {
  assert.equal(firstFreeCode([0, -4, Number.NaN, 1.5, 1]), 2);
  assert.equal(firstFreeCode([1, 1, 2, 2]), 3);
});

test("order of the supplied codes does not matter", () => {
  assert.equal(firstFreeCode([5, 1, 4, 2]), 3);
});

test("the code ceiling is the documented maximum", () => {
  assert.equal(MAX_CART_CODE, 99_999_999);
});

test("only queued carts hold a code", () => {
  assert.deepEqual([...ACTIVE_CART_STATUSES], ["sent", "suspended"]);
  for (const status of ACTIVE_CART_STATUSES) {
    assert.ok(cartEntity.lifecycle?.states.includes(status), `${status} must be a cart state`);
  }
});

test("both cart modes are reachable from a draft, and each closes the cart", () => {
  const sm = new StateMachine(cartEntity.lifecycle!);
  // 1. send to the register  2. ring it up on the spot
  assert.equal(sm.find("open", "send")?.to, "sent");
  assert.equal(sm.find("open", "checkout")?.to, "converted");
  // the cash desk's own actions on a queued basket
  assert.equal(sm.find("sent", "suspend")?.to, "suspended");
  assert.equal(sm.find("suspended", "resume")?.to, "sent");
  assert.equal(sm.find("sent", "checkout")?.to, "converted");
  assert.equal(sm.find("sent", "credit")?.to, "converted");
  assert.equal(sm.find("sent", "cancel")?.to, "cancelled");
  // a settled cart is final
  assert.deepEqual(sm.transitionsFrom("converted"), []);
  assert.deepEqual(sm.transitionsFrom("cancelled"), []);
});

test("every cart transition is permission-gated and grantable from the matrix", () => {
  assert.ok(GRANTABLE_SYSTEM_ENTITIES.has("cart"), "cart must appear in the permission matrix");
  for (const tr of cartEntity.lifecycle!.transitions) {
    assert.ok(tr.requires?.startsWith("cart:"), `${tr.action} needs a cart:* grant`);
  }
  const verbs = new Set(cartEntity.lifecycle!.transitions.map((t) => t.requires!.split(":")[1]));
  assert.deepEqual([...verbs].sort(), ["cancel", "checkout", "credit", "send", "suspend"]);
});

test("role presets split the floor from the cash desk", () => {
  const holds = (role: string, grant: string) => roleGrants(role).some((g) => grantMatches(g, grant));
  // A rep hands baskets over and can ring them up, but never sells on account.
  assert.ok(holds("sales_rep", "cart:send"));
  assert.ok(holds("sales_rep", "cart:checkout"));
  assert.equal(holds("sales_rep", "cart:credit"), false);
  // The cash desk works the queue but does not create/send baskets.
  assert.ok(holds("accountant", "cart:checkout"));
  assert.ok(holds("accountant", "cart:credit"));
  assert.ok(holds("accountant", "cart:suspend"));
  assert.equal(holds("accountant", "cart:send"), false);
  // A manager keeps the lot.
  assert.ok(holds("sales_manager", "cart:credit"));
  assert.ok(holds("sales_manager", "cart:send"));
});
