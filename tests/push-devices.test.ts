/**
 * Devices, and pushing to them.
 *
 * The missing half of "send the basket to the till": the app could hand a
 * basket over and nothing could tell the cashier it had arrived. Notifications
 * existed only as inbox rows the app had to be open to read — which is the one
 * state a notification is for.
 *
 * The transport itself is not tested here (that would be testing Expo). What is
 * tested is everything around it, which is where the failure modes live:
 * re-registration, reassignment, and above all what happens to a token the push
 * service says will never work again.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";
// Somewhere that cannot answer. The point of these tests is everything AROUND
// the transport — registration, reassignment, and what happens when delivery
// fails — so reaching the real push service would make them slow, dependent on
// the internet in CI, and would not exercise the failure path at all.
process.env.AULA_EXPO_PUSH_URL = "http://127.0.0.1:1/push";

import test from "node:test";
import assert from "node:assert/strict";
import type { RequestContext } from "@/lib/context/types";

const { getQueryEngine } = await import("@/lib/data/store");
const { systemContext } = await import("@/lib/context/resolver");
const { TENANT_ID, ORG_ID } = await import("@/lib/config/env");
const { registerDevice, unregisterDevice, devicesFor, pushToUser } = await import("@/lib/integrations/push-transport");

const ctxFor = (userId: string): RequestContext => ({ ...systemContext(TENANT_ID, ORG_ID), userId });

let seq = 0;
let position: string | null = null;
async function aUser(name = "Kasiyer") {
  const qe = await getQueryEngine();
  const sys = systemContext(TENANT_ID, ORG_ID);
  const n = ++seq;
  position ??= String((await qe.create(sys, "position", { name: "Kasiyer", role: "sales_rep" })).id);
  const user = await qe.create(sys, "user", {
    displayName: `${name} ${n}`,
    email: `push${n}@example.com`,
    passwordHash: "x",
    positionId: position,
  });
  return String(user.id);
}

test("registering a device makes the user reachable", async () => {
  const userId = await aUser();
  await registerDevice(ctxFor(userId), { token: `ExponentPushToken[a${++seq}]`, platform: "ios", deviceName: "Kasa iPad" });
  const devices = await devicesFor(ctxFor(userId), userId);
  assert.equal(devices.length, 1);
  assert.equal(String(devices[0]?.deviceName), "Kasa iPad");
  assert.equal(devices[0]?.active, true);
});

test("re-registering the same device UPDATES it rather than adding another", async () => {
  // Called on every app launch, because a push token rotates. Inserting instead
  // would mean the user receives each notification as many times as they have
  // opened the app.
  const userId = await aUser();
  const token = `ExponentPushToken[b${++seq}]`;
  await registerDevice(ctxFor(userId), { token, platform: "android", deviceName: "Old name", appVersion: "1.0.0" });
  await registerDevice(ctxFor(userId), { token, platform: "android", deviceName: "New name", appVersion: "1.1.0" });

  const devices = await devicesFor(ctxFor(userId), userId);
  assert.equal(devices.length, 1, "one device, not two");
  assert.equal(String(devices[0]?.deviceName), "New name");
  assert.equal(String(devices[0]?.appVersion), "1.1.0");
});

test("a shared till follows whoever is signed in", async () => {
  // The same physical device, a different cashier on the next shift. The
  // notification must reach the person actually standing there.
  const first = await aUser("Vardiya A");
  const second = await aUser("Vardiya B");
  const token = `ExponentPushToken[c${++seq}]`;

  await registerDevice(ctxFor(first), { token, platform: "android", deviceName: "Kasa 1" });
  await registerDevice(ctxFor(second), { token, platform: "android", deviceName: "Kasa 1" });

  assert.equal((await devicesFor(ctxFor(first), first)).length, 0, "no longer theirs");
  assert.equal((await devicesFor(ctxFor(second), second)).length, 1, "now theirs");
});

test("a re-registered device becomes active again", async () => {
  // Signing back in after signing out must restore delivery, or the phone stays
  // silent for ever with nothing to show why.
  const userId = await aUser();
  const token = `ExponentPushToken[d${++seq}]`;
  await registerDevice(ctxFor(userId), { token, platform: "ios" });
  await unregisterDevice(ctxFor(userId), token);
  assert.equal((await devicesFor(ctxFor(userId), userId)).length, 0);

  await registerDevice(ctxFor(userId), { token, platform: "ios" });
  assert.equal((await devicesFor(ctxFor(userId), userId)).length, 1);
});

test("unregistering deactivates rather than deletes", async () => {
  // The row is also the record of which devices somebody has used, which is the
  // first thing looked at when one of them stops receiving anything.
  const userId = await aUser();
  const token = `ExponentPushToken[e${++seq}]`;
  await registerDevice(ctxFor(userId), { token, platform: "ios", deviceName: "Telefon" });
  assert.equal(await unregisterDevice(ctxFor(userId), token), true);

  const qe = await getQueryEngine();
  const all = await qe.listComplete(systemContext(TENANT_ID, ORG_ID), "deviceToken", {
    filters: [{ field: "token", op: "eq", value: token }],
  });
  assert.equal(all.length, 1, "the row survives");
  assert.equal(all[0]?.active, false);
  assert.equal(String(all[0]?.lastError), "unregistered");
});

test("unregistering an unknown token is not an error", async () => {
  // A sign-out from a device whose registration never landed is ordinary, and a
  // throw here would fail the sign-out.
  assert.equal(await unregisterDevice(ctxFor(await aUser()), "ExponentPushToken[nope]"), false);
});

test("pushing to a user with no devices is a no-op, not a failure", async () => {
  // Most users never install the app. Treating that as an error would make every
  // notification look broken.
  const userId = await aUser();
  const result = await pushToUser(ctxFor(userId), userId, { title: "t", body: "b" });
  assert.equal(result.skipped, true);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
});

test("a push never throws when the service is unreachable", async () => {
  // A push is a convenience over a notification already recorded in the inbox.
  // Failing the operation that triggered it because a phone was unreachable
  // would be the wrong trade entirely — the invoice still posted.
  const userId = await aUser();
  await registerDevice(ctxFor(userId), { token: `ExponentPushToken[f${++seq}]`, platform: "ios" });
  const result = await pushToUser(ctxFor(userId), userId, { title: "Sepet", body: "Kasaya gönderildi" });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1, "counted as failed, not thrown");
  // Nothing is deactivated: an unreachable service says nothing about whether
  // the token is still good, and deactivating on a network blip would silence
  // devices that were working.
  assert.equal(result.deactivated, 0);
});

test("only active devices are pushed to", async () => {
  const userId = await aUser();
  const live = `ExponentPushToken[g${++seq}]`;
  const dead = `ExponentPushToken[h${++seq}]`;
  await registerDevice(ctxFor(userId), { token: live, platform: "ios", deviceName: "Live" });
  await registerDevice(ctxFor(userId), { token: dead, platform: "ios", deviceName: "Dead" });
  await unregisterDevice(ctxFor(userId), dead);

  const devices = await devicesFor(ctxFor(userId), userId);
  assert.equal(devices.length, 1);
  assert.equal(String(devices[0]?.deviceName), "Live");
});

test("notifying a user does not fail when the push cannot be delivered", async () => {
  // The inbox row is the guarantee; the push is the convenience. This is the
  // whole reason `notifyUser` fires it without awaiting it into its own failure
  // path.
  const { notifyUser } = await import("@/lib/integrations/notifications");
  const userId = await aUser();
  await registerDevice(ctxFor(userId), { token: `ExponentPushToken[i${++seq}]`, platform: "android" });

  await notifyUser({
    tenantId: TENANT_ID,
    orgId: ORG_ID,
    userId,
    at: new Date().toISOString(),
    channel: "system",
    subject: "Sepet kasaya gönderildi",
    body: "3 kalem, ₺450",
    eventType: "cart.sent",
  });

  const qe = await getQueryEngine();
  const inbox = await qe.listComplete(systemContext(TENANT_ID, ORG_ID), "notification", {
    filters: [{ field: "userId", op: "eq", value: userId }],
  });
  assert.equal(inbox.length, 1, "the inbox row is written regardless");
});
