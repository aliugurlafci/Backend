/**
 * Errors reach the user in the request's language.
 *
 * The full chain, over a real socket: the client says `x-locale: tr` (or an
 * `Accept-Language`), the backend throws in English, and the serialized
 * `error.message` arrives in Turkish. This is the mechanism that localizes the
 * ~130 `toast.error(e.message)` call sites across both apps without touching
 * one of them — so the thing to test is the boundary, not the call sites.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";
process.env.AULA_TRUST_PROXY = "0";

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { createApp } = await import("@/http/server");
const { ValidationError, ConflictError } = await import("@/lib/enforcement/errors");
const { localizeAppError } = await import("@/lib/i18n/errors");
const { detailFromZodIssue } = await import("@aula/contracts/i18n/errors");

async function serve(): Promise<{ url: string; stop: () => Promise<void> }> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function loginMessage(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
  });
  assert.equal(res.status, 401);
  const json = (await res.json()) as { error: { message: string } };
  return json.error.message;
}

test("the same wrong password answers in the caller's language", async () => {
  const { url, stop } = await serve();
  try {
    assert.equal(await loginMessage(url, { "x-locale": "tr" }), "e-posta veya şifre hatalı");
    assert.equal(await loginMessage(url, { "x-locale": "de" }), "E-Mail oder Passwort ist falsch");
    // No app locale: Accept-Language decides, exactly like a first visit.
    assert.equal(
      await loginMessage(url, { "accept-language": "tr-TR,tr;q=0.9,en;q=0.5" }),
      "e-posta veya şifre hatalı",
    );
    assert.equal(await loginMessage(url, {}), "invalid email or password");
  } finally {
    await stop();
  }
});

test("the runApi boundary localizes too, even when auth itself failed", async () => {
  const { url, stop } = await serve();
  try {
    const res = await fetch(`${url}/api/v1/auth/me`, { headers: { "x-locale": "tr" } });
    assert.equal(res.status, 401);
    const json = (await res.json()) as { error: { message: string; messageKey?: string } };
    // UnauthenticatedError's default message, keyed by its constructor.
    assert.equal(json.error.message, "Oturum açmanız gerekiyor");
    assert.equal(json.error.messageKey, "err.unauthenticated");
  } finally {
    await stop();
  }
});

test("validation details localize per issue, not as one blob", () => {
  // What parseBody produces for a body missing a required string field and
  // overflowing another — the zod issues carry key + params.
  const err = new ValidationError([
    detailFromZodIssue({ code: "invalid_type", path: ["email"], message: "Invalid input: expected string, received undefined", expected: "string" }),
    detailFromZodIssue({ code: "too_small", path: ["password"], message: "Too small", minimum: 8, origin: "string" }),
  ]);
  const payload = localizeAppError(err, "tr");
  assert.equal(payload.error.message, "Doğrulama başarısız — işaretli alanları kontrol edin");
  assert.equal(payload.error.details?.[0]?.message, "Bu alan zorunlu");
  assert.equal(payload.error.details?.[1]?.message, "En az 8 karakter olmalı");
});

test("machine words inside a template translate as words, not as syntax", () => {
  const err = new ConflictError('cannot "send" a Invoice in state "paid"').withKey("err.invalidTransition", {
    action: "send",
    entity: "invoice",
    state: "paid",
  });
  const payload = localizeAppError(err, "tr");
  // entity → entity-label catalogue, action → action verbs, state → enum labels.
  assert.equal(payload.error.message, '"Ödendi" durumundaki bir Fatura için "Gönder" uygulanamaz');
});
