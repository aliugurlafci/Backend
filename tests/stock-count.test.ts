/**
 * Physical inventory counts.
 *
 * Two decisions carry the whole design, and both are about time passing during
 * a count:
 *
 *   the system quantity is FROZEN when the sheet is generated
 *   the posting applies the VARIANCE, not the counted figure
 *
 * Together they mean a sale that happens while someone is counting neither
 * corrupts the variance nor gets erased by it. Run against the in-memory
 * repository, so no database is needed.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { generateSheet, recordCount, postCount } = await import("@/lib/inventory/count");
const { getInventoryService } = await import("@/lib/inventory/service");

const ctx = (): RequestContext => systemContext(TENANT_ID, ORG_ID);

let seq = 0;
async function scenario(opening: Array<{ qty: number; cost: number }>) {
  const qe = await getQueryEngine();
  const c = ctx();
  const run = ++seq;
  const warehouse = await qe.create(c, "warehouse", { name: `W${run}`, code: `W${run}` });
  const inventory = await getInventoryService();

  const products = [];
  for (const [i, o] of opening.entries()) {
    const product = await qe.create(c, "product", {
      name: `P${run}-${i}`,
      sku: `S${run}-${i}`,
      unitPrice: 100,
      trackStock: true,
    });
    if (o.qty !== 0) {
      await inventory.writeMovement(c, {
        productId: String(product.id),
        warehouseId: String(warehouse.id),
        type: "adjustment",
        qty: o.qty,
        unitCost: o.cost,
        refType: "adjustment",
        ref: `open-${run}-${i}`,
      });
    }
    products.push(product);
  }

  const count = await qe.create(c, "stockCount", {
    warehouseId: String(warehouse.id),
    countDate: "2026-08-08",
    status: "draft",
  });
  return { warehouse, products, count, qe, c, inventory };
}

const onHand = async (inventory: Awaited<ReturnType<typeof getInventoryService>>, c: RequestContext, productId: string, warehouseId: string) => {
  const balances = await inventory.onHandByKey(c, [
    { field: "productId", op: "eq", value: productId },
    { field: "warehouseId", op: "eq", value: warehouseId },
  ]);
  return balances[0]?.onHand ?? 0;
};

test("the sheet freezes the system quantity", async () => {
  const s = await scenario([{ qty: 100, cost: 60 }]);
  await generateSheet(s.c, String(s.count.id));

  const before = await s.qe.listComplete(s.c, "stockCountLine", {
    filters: [{ field: "stockCountId", op: "eq", value: String(s.count.id) }],
  });
  assert.equal(Number(before[0]!.systemQty), 100);
  assert.equal(Number(before[0]!.unitCost), 60, "cost is snapshotted too, for valuing the variance");
});

test("a movement during the count does not change the snapshot", async () => {
  // The reason for the freeze: a count takes hours and sales carry on. Reading
  // the expected figure at posting time would fold every intervening movement
  // into the variance and blame the counter for it.
  const s = await scenario([{ qty: 100, cost: 60 }]);
  await generateSheet(s.c, String(s.count.id));

  await s.inventory.writeMovement(s.c, {
    productId: String(s.products[0]!.id),
    warehouseId: String(s.warehouse.id),
    type: "issue",
    qty: -10,
    refType: "invoice",
    ref: `sale-${seq}`,
  });

  const lines = await s.qe.listComplete(s.c, "stockCountLine", {
    filters: [{ field: "stockCountId", op: "eq", value: String(s.count.id) }],
  });
  assert.equal(Number(lines[0]!.systemQty), 100, "the sheet still says what the books said when counting began");
  assert.equal(await onHand(s.inventory, s.c, String(s.products[0]!.id), String(s.warehouse.id)), 90);
});

test("posting applies the variance, preserving what moved during the count", async () => {
  // THE assertion. Snapshot 100, sale of 10 (real stock 90), counted 97 → the
  // count found 3 fewer than the books said, so 90 − 3 = 87.
  //
  // Writing the counted figure absolutely would give 97 and silently erase a
  // sale that was correctly recorded.
  const s = await scenario([{ qty: 100, cost: 60 }]);
  await generateSheet(s.c, String(s.count.id));
  await s.inventory.writeMovement(s.c, {
    productId: String(s.products[0]!.id),
    warehouseId: String(s.warehouse.id),
    type: "issue",
    qty: -10,
    refType: "invoice",
    ref: `sale2-${seq}`,
  });

  await recordCount(s.c, String(s.count.id), [{ productId: String(s.products[0]!.id), countedQty: 97 }]);
  await s.qe.patchComputed(s.c, "stockCount", String(s.count.id), { status: "review" });
  const result = await postCount(s.c, String(s.count.id));

  assert.equal(result.adjustments, 1);
  assert.equal(await onHand(s.inventory, s.c, String(s.products[0]!.id), String(s.warehouse.id)), 87);
});

test("a line that agrees produces no adjustment", async () => {
  const s = await scenario([{ qty: 50, cost: 30 }]);
  await generateSheet(s.c, String(s.count.id));
  await recordCount(s.c, String(s.count.id), [{ productId: String(s.products[0]!.id), countedQty: 50 }]);
  await s.qe.patchComputed(s.c, "stockCount", String(s.count.id), { status: "review" });
  const result = await postCount(s.c, String(s.count.id));
  assert.equal(result.adjustments, 0);
  assert.equal(await onHand(s.inventory, s.c, String(s.products[0]!.id), String(s.warehouse.id)), 50);
});

test("an uncounted line is skipped, not written off", async () => {
  // A line nobody counted is unknown, not agreement. Treating it as zero
  // variance would claim the shelf was checked when it was not — and treating it
  // as zero stock would write off everything nobody got to.
  const s = await scenario([{ qty: 10, cost: 10 }, { qty: 20, cost: 5 }]);
  await generateSheet(s.c, String(s.count.id));
  await recordCount(s.c, String(s.count.id), [{ productId: String(s.products[0]!.id), countedQty: 10 }]);
  await s.qe.patchComputed(s.c, "stockCount", String(s.count.id), { status: "review" });

  const result = await postCount(s.c, String(s.count.id));
  assert.equal(result.skipped, 1);
  assert.equal(await onHand(s.inventory, s.c, String(s.products[1]!.id), String(s.warehouse.id)), 20);
});

test("finding something the sheet does not list adds it", async () => {
  // The system holds no balance for it here, so its snapshot is zero — which is
  // exactly what the system believed. Refusing it would send the counter to a
  // different screen mid-count.
  const s = await scenario([{ qty: 5, cost: 10 }]);
  await generateSheet(s.c, String(s.count.id));
  const qe = await getQueryEngine();
  const stranger = await qe.create(s.c, "product", { name: `X${seq}`, sku: `X${seq}`, unitPrice: 1, trackStock: true });

  const result = await recordCount(s.c, String(s.count.id), [{ productId: String(stranger.id), countedQty: 4 }]);
  assert.equal(result.added, 1);

  const lines = await qe.listComplete(s.c, "stockCountLine", {
    filters: [{ field: "stockCountId", op: "eq", value: String(s.count.id) }],
  });
  const added = lines.find((l) => String(l.productId) === String(stranger.id));
  assert.equal(Number(added?.systemQty), 0);
  assert.equal(Number(added?.variance), 4);
});

test("a count cannot be posted before review", async () => {
  // Counting stock and approving a write-off are different authorities, and the
  // review step is where the second one happens.
  const s = await scenario([{ qty: 1, cost: 1 }]);
  await generateSheet(s.c, String(s.count.id));
  await assert.rejects(() => postCount(s.c, String(s.count.id)), /submitted for review/);
});

test("a count cannot be posted twice", async () => {
  const s = await scenario([{ qty: 8, cost: 2 }]);
  await generateSheet(s.c, String(s.count.id));
  await recordCount(s.c, String(s.count.id), [{ productId: String(s.products[0]!.id), countedQty: 6 }]);
  await s.qe.patchComputed(s.c, "stockCount", String(s.count.id), { status: "review" });
  await postCount(s.c, String(s.count.id));
  await assert.rejects(() => postCount(s.c, String(s.count.id)), /already posted/);
  // And the stock moved exactly once.
  assert.equal(await onHand(s.inventory, s.c, String(s.products[0]!.id), String(s.warehouse.id)), 6);
});

test("a sheet cannot be generated twice", async () => {
  const s = await scenario([{ qty: 3, cost: 1 }]);
  await generateSheet(s.c, String(s.count.id));
  await assert.rejects(() => generateSheet(s.c, String(s.count.id)), /already been started/);
});

test("counting is refused once the sheet is closed for review", async () => {
  const s = await scenario([{ qty: 3, cost: 1 }]);
  await generateSheet(s.c, String(s.count.id));
  await s.qe.patchComputed(s.c, "stockCount", String(s.count.id), { status: "review" });
  await assert.rejects(
    () => recordCount(s.c, String(s.count.id), [{ productId: String(s.products[0]!.id), countedQty: 1 }]),
    /not open for counting/,
  );
});

test("the variance is valued at the snapshot cost", async () => {
  const s = await scenario([{ qty: 10, cost: 40 }]);
  await generateSheet(s.c, String(s.count.id));
  await recordCount(s.c, String(s.count.id), [{ productId: String(s.products[0]!.id), countedQty: 7 }]);
  const header = await s.qe.get(s.c, "stockCount", String(s.count.id));
  assert.equal(Number(header.varianceCount), 1);
  assert.equal(Number(header.varianceValue), -120, "3 missing at the cost they were carried at");
});

test("a movement whose sign contradicts its type is refused", async () => {
  // Found by getting this wrong in a test above. The sign drives the arithmetic
  // and `type` is only a label on the row, so `type: "issue"` with a positive
  // quantity INCREASED stock and filed the row as an issue. Reconciliation
  // cannot catch that — the balance and the movement still agree with each
  // other; only the story they tell is false.
  const s = await scenario([{ qty: 10, cost: 5 }]);
  const base = {
    productId: String(s.products[0]!.id),
    warehouseId: String(s.warehouse.id),
    ref: `sign-${seq}`,
  };

  await assert.rejects(
    () => s.inventory.writeMovement(s.c, { ...base, type: "issue", qty: 5, refType: "invoice" }),
    /must have a negative quantity/,
  );
  await assert.rejects(
    () => s.inventory.writeMovement(s.c, { ...base, type: "receipt", qty: -5, refType: "goodsReceipt" }),
    /cannot have a negative quantity/,
  );

  // An adjustment is legitimately signed both ways — it is the document whose
  // whole purpose is to move stock in either direction.
  await s.inventory.writeMovement(s.c, { ...base, ref: `adj-a-${seq}`, type: "adjustment", qty: 3, unitCost: 5, refType: "adjustment" });
  await s.inventory.writeMovement(s.c, { ...base, ref: `adj-b-${seq}`, type: "adjustment", qty: -2, refType: "adjustment" });
  assert.equal(await onHand(s.inventory, s.c, String(s.products[0]!.id), String(s.warehouse.id)), 11);

  // And the stock was untouched by the refused calls.
});
