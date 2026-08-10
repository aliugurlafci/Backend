/**
 * JWT verification.
 *
 * Every test here is a token that must be REFUSED. The verifier used to ignore
 * the header entirely and recompute HMAC-SHA256 regardless of what the token
 * claimed — safe against `alg: none`, but by accident rather than by decision,
 * and one algorithm away from the textbook confusion attack.
 */
process.env.AULA_PERSISTENCE = "memory";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const { signJwt, verifyJwt, JWT_ISSUER, JWT_AUDIENCE } = await import("@/lib/security/auth");

const SECRET = "test-secret-not-a-real-one";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

/** Mint a token by hand, so the header and claims can be anything. */
function forge(header: Record<string, unknown>, claims: Record<string, unknown>, secret = SECRET): string {
  const h = b64(header);
  const p = b64(claims);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

const now = (): number => Math.floor(Date.now() / 1000);
const validClaims = (over: Record<string, unknown> = {}) => ({
  sub: "u1",
  tenantId: "T",
  orgId: "O",
  iat: now(),
  exp: now() + 3600,
  iss: JWT_ISSUER,
  aud: JWT_AUDIENCE,
  ...over,
});

test("a token this issuer minted verifies", () => {
  const token = signJwt({ sub: "u1", tenantId: "T", orgId: "O" }, SECRET, 3600);
  const claims = verifyJwt(token, SECRET);
  assert.equal(claims.sub, "u1");
  assert.equal(claims.iss, JWT_ISSUER);
  assert.equal(claims.aud, JWT_AUDIENCE);
});

test("`alg: none` is refused by name", () => {
  // The classic forgery: strip the signature and declare no algorithm. This was
  // already refused, but for the wrong reason — the signature simply did not
  // match. Now the algorithm itself is rejected, which keeps holding if a second
  // algorithm is ever added.
  const t = `${b64({ alg: "none", typ: "JWT" })}.${b64(validClaims())}.`;
  assert.throws(() => verifyJwt(t, SECRET), /signature|algorithm/i);
});

test("a different algorithm in the header is refused even with a valid HMAC", () => {
  // The signature is genuinely correct HMAC-SHA256; only the header lies. Under
  // the old code this passed, because the header was never read.
  const t = forge({ alg: "HS512", typ: "JWT" }, validClaims());
  assert.throws(() => verifyJwt(t, SECRET), /unsupported token algorithm: HS512/);
});

test("a token signed with another secret is refused", () => {
  const t = forge({ alg: "HS256", typ: "JWT" }, validClaims(), "some-other-secret");
  assert.throws(() => verifyJwt(t, SECRET), /invalid token signature/);
});

test("a token with no expiry is refused", () => {
  // Previously `if (claims.exp && ...)` — so omitting the claim produced a token
  // that never expired. An eternal session is a strange thing to grant on the
  // basis that a field happened to be absent.
  const { exp: _dropped, ...noExp } = validClaims();
  const t = forge({ alg: "HS256", typ: "JWT" }, noExp);
  assert.throws(() => verifyJwt(t, SECRET), /no expiry/);
});

test("an expired token is refused", () => {
  const t = forge({ alg: "HS256", typ: "JWT" }, validClaims({ iat: now() - 7200, exp: now() - 60 }));
  assert.throws(() => verifyJwt(t, SECRET), /expired/);
});

test("a token that is not valid yet is refused", () => {
  const t = forge({ alg: "HS256", typ: "JWT" }, validClaims({ nbf: now() + 600 }));
  assert.throws(() => verifyJwt(t, SECRET), /not valid yet/);
});

test("a small clock skew does not reject a good token", () => {
  // A second "too new" is a clock problem, not an attack.
  const t = forge({ alg: "HS256", typ: "JWT" }, validClaims({ nbf: now() + 5, iat: now() + 5 }));
  assert.equal(verifyJwt(t, SECRET).sub, "u1");
});

test("a token issued far in the future is refused", () => {
  const t = forge({ alg: "HS256", typ: "JWT" }, validClaims({ iat: now() + 86400 }));
  assert.throws(() => verifyJwt(t, SECRET), /issued in the future/);
});

test("a token for another audience is refused", () => {
  // The point of binding this: one secret often ends up signing more than one
  // kind of value — a reset link, a webhook callback — and without an audience
  // any of them would validate as a session.
  const t = forge({ alg: "HS256", typ: "JWT" }, validClaims({ aud: "some-other-service" }));
  assert.throws(() => verifyJwt(t, SECRET), /not for this API/);
});

test("a token from another issuer is refused", () => {
  const t = forge({ alg: "HS256", typ: "JWT" }, validClaims({ iss: "somebody-else" }));
  assert.throws(() => verifyJwt(t, SECRET), /unknown issuer/);
});

test("a malformed token is refused rather than crashing", () => {
  assert.throws(() => verifyJwt("not.a.token", SECRET), /signature|malformed/);
  assert.throws(() => verifyJwt("onlyonepart", SECRET), /malformed token/);
  assert.throws(() => verifyJwt("", SECRET), /malformed token/);
});

test("a tampered payload is refused", () => {
  // Escalate a role by editing the claims and keeping the original signature.
  const token = signJwt({ sub: "u1", tenantId: "T", orgId: "O", roles: ["sales_rep"] }, SECRET, 3600);
  const [h, , sig] = token.split(".");
  const swapped = `${h}.${b64(validClaims({ roles: ["admin"] }))}.${sig}`;
  assert.throws(() => verifyJwt(swapped, SECRET), /invalid token signature/);
});
