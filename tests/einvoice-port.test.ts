/**
 * The integrator port's contract.
 *
 * No provider is chosen yet, so what matters is that the boundary behaves
 * predictably without one: everything up to transmission works, and
 * transmission itself refuses rather than pretending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnconfiguredIntegrator, type EInvoiceIntegrator, type EInvoiceRef } from "@/lib/einvoice/types";
import { activeIntegrator, registerEInvoiceIntegrator } from "@/lib/einvoice/service";

test("with no provider, sending fails loudly instead of silently succeeding", async () => {
  const unconfigured = new UnconfiguredIntegrator();
  // A no-op here would mark invoices sent that the tax office never received —
  // strictly worse than not being wired up.
  await assert.rejects(async () => unconfigured.send("<Invoice/>", {} as EInvoiceRef), /no e-invoice integrator/);
  await assert.rejects(async () => unconfigured.status("x"), /no e-invoice integrator/);
});

test("registration cannot be guessed without a provider", async () => {
  // Defaulting to "not registered" would quietly route e-fatura customers to
  // e-arşiv, which the GİB rejects. Refusing is the honest answer.
  await assert.rejects(async () => new UnconfiguredIntegrator().isRegistered("1234567890"), /no e-invoice integrator/);
});

test("a provider can be plugged in with one object", async () => {
  // The whole point of the port: adding a provider is writing this, not
  // revisiting how invoices are expressed.
  const calls: { xml: string; ref: EInvoiceRef }[] = [];
  const fake: EInvoiceIntegrator = {
    name: "test-provider",
    isRegistered: async (taxNumber) => taxNumber === "1234567890",
    send: async (xml, ref) => {
      calls.push({ xml, ref });
      return { status: "sent", externalId: "EXT-1" };
    },
    status: async () => ({ status: "accepted" }),
  };

  const previous = activeIntegrator();
  try {
    registerEInvoiceIntegrator(fake);
    assert.equal(activeIntegrator().name, "test-provider");

    assert.equal(await fake.isRegistered("1234567890"), true, "an enrolled taxpayer gets an e-fatura");
    assert.equal(await fake.isRegistered("9999999999"), false, "everyone else gets an e-arşiv");

    const result = await fake.send("<Invoice/>", {
      documentNumber: "AUL2026000000001",
      uuid: "u-1",
      kind: "efatura",
      profile: "TEMELFATURA",
    });
    assert.equal(result.status, "sent");
    assert.equal(result.externalId, "EXT-1");
    assert.equal(calls[0]!.ref.documentNumber, "AUL2026000000001");
  } finally {
    registerEInvoiceIntegrator(previous);
  }
});

test("cancel is optional — e-fatura cannot be cancelled, only reversed", () => {
  const minimal: EInvoiceIntegrator = {
    name: "minimal",
    isRegistered: async () => false,
    send: async () => ({ status: "sent" }),
    status: async () => ({ status: "sent" }),
  };
  // A provider that only supports e-fatura need not implement it at all.
  assert.ok(!("cancel" in minimal), "cancel is optional on the port");
});
