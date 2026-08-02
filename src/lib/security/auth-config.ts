/**
 * Auth wiring for the backend.
 *
 * Every request is authenticated by a real credential: a bearer token issued at
 * login, or the httpOnly session cookie that carries the same JWT. There is no
 * impersonation path — a request with neither is unauthenticated, which is what
 * drives the login gate.
 */
import { jwtSecret } from "@/lib/config/env";
import { setAuthenticator } from "@/lib/context/resolver";
import { jwtAuthenticator, sessionAuthenticator } from "./auth";

/** Install the active authenticator: bearer token → httpOnly session cookie. */
export function configureAuth(): void {
  const jwt = jwtAuthenticator(jwtSecret);
  const session = sessionAuthenticator(jwtSecret);
  setAuthenticator((headers) => {
    const auth = headers.get("authorization");
    if (auth?.startsWith("Bearer ")) return jwt(headers);
    return session(headers);
  });
}
