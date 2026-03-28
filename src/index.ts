/**
 * @ag-vibe/auth
 *
 * Authentication SDK for the ag-vibe ecosystem (allinone backend).
 *
 * ## Quick start
 *
 * ```ts
 * import { createAuthClient } from '@ag-vibe/auth'
 *
 * export const auth = createAuthClient({
 *   baseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
 *   appId: 'ido',
 * })
 *
 * // In your heyapi runtimeConfigPath file:
 * auth: async (a) => {
 *   if (a.scheme === 'bearer') return (await auth.ensureValidAccessToken()) ?? undefined
 * }
 *
 * // Install 401 auto-retry:
 * import { client as apiClient } from '@/api-gen/client.gen'
 * auth.applyTo(apiClient)
 * ```
 *
 * @module
 */

export { createAuthClient } from "./client.ts";
export type { AuthClient, AuthClientConfig, InterceptableClient } from "./client.ts";

export type { AuthSession, AuthState, AuthStore } from "./core/store.ts";

export { decodeJwtPayload, isTokenExpiringSoon } from "./core/jwt.ts";
