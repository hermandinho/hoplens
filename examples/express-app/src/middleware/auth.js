const AUTH_DELAY_MS = 30;

/**
 * SEEDED PROBLEM (slow middleware): pretends to verify a session against a remote service, which takes
 * ~30 ms on every request before next(). Nothing is rejected: a missing token is just an anonymous user.
 * The `authorization` header is redacted in Hoplens's request view.
 */
export function slowAuth(req, _res, next) {
  const header = req.get("authorization") ?? "";
  setTimeout(() => {
    req.user = header.startsWith("Bearer ") ? { id: 1, token: "verified" } : { id: null, anonymous: true };
    next();
  }, AUTH_DELAY_MS);
}
