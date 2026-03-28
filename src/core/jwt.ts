/**
 * Lightweight JWT utilities — no external dependencies.
 *
 * These operate purely on the token string and never make network requests.
 * Signature verification is NOT performed — that is the server's job.
 */

/**
 * Decodes the payload section of a JWT **without verifying the signature**.
 *
 * @param token - A JWT string in the form `header.payload.signature`.
 * @returns The parsed payload object, or `null` if decoding fails.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;

  const payload = parts[1];
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns `true` if the token is expired or will expire within `leewayMs`.
 *
 * Returns `false` when the token has no `exp` claim — the 401 interceptor
 * will handle actual failures.
 *
 * @param token    - A JWT access token string.
 * @param leewayMs - Milliseconds before expiry to consider "expiring soon".
 *                   Defaults to 60 000 (1 minute).
 */
export function isTokenExpiringSoon(token: string, leewayMs = 60_000): boolean {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  return Date.now() + leewayMs >= exp * 1000;
}
