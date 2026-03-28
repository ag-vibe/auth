/**
 * Factory that creates a fully configured auth client instance.
 *
 * @module
 */

import { FetchError, ofetch } from "ofetch";
import { createAuthStore, type AuthStore, type AuthSession } from "./core/store.ts";
import { isTokenExpiringSoon } from "./core/jwt.ts";

/** Configuration for {@link createAuthClient}. */
export interface AuthClientConfig {
  /**
   * Base URL of the allinone API, **without** a trailing slash.
   *
   * @example "/api/v1"
   * @example "https://api.example.com/api/v1"
   */
  baseUrl: string;

  /**
   * Unique identifier for this application.
   *
   * Used to namespace the localStorage key so multiple ag-vibe apps on the
   * same origin do not share auth tokens.
   *
   * @example "ido"
   * @example "dashboard"
   */
  appId: string;
}

/**
 * Minimal interface matching the interceptor API of a `@hey-api/client-ofetch`
 * generated client. Typed loosely so this package does not depend on
 * `@hey-api/client-ofetch` directly.
 */
export interface InterceptableClient {
  interceptors: {
    response: {
      use: (
        fn: (
          response: Response,
          request: Request,
          options: { serializedBody?: unknown; signal?: AbortSignal },
        ) => Promise<Response> | Response,
      ) => number;
    };
  };
}

/** The object returned by {@link createAuthClient}. */
export interface AuthClient {
  /** Zustand vanilla store — subscribe, getState, setSession, clearSession. */
  store: AuthStore;

  /**
   * Returns a valid access token, refreshing proactively when the current
   * token is expiring soon.
   *
   * @param forceRefresh - Always attempt a refresh. Useful for 401 recovery.
   * @returns The access token string, or `null` if not authenticated.
   */
  ensureValidAccessToken: (forceRefresh?: boolean) => Promise<string | null>;

  /**
   * Installs a 401 auto-retry interceptor on one or more heyapi clients.
   *
   * Safe to call multiple times with the same client — idempotent.
   *
   * @param clients - A single client or an array of clients.
   */
  applyTo: (clients: InterceptableClient | InterceptableClient[]) => void;
}

/** HTTP status codes indicating the credentials themselves are invalid. */
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

const RETRY_MARKER_HEADER = "x-ag-vibe-auth-retried";
const JSON_CONTENT_TYPE = "application/json";

function isAuthEndpoint(url: string): boolean {
  return /\/auth\/(sign-in|sign-up|sign-out|refresh)\/?$/.test(url);
}

function isBodyInit(value: unknown): value is NonNullable<RequestInit["body"]> {
  if (typeof value === "string") return true;
  if (value instanceof Blob || value instanceof FormData || value instanceof URLSearchParams) {
    return true;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

function getRetryBody(options: { serializedBody?: unknown }): {
  body: RequestInit["body"] | undefined;
  isJsonBody: boolean;
} {
  const body = options.serializedBody;
  if (body == null) return { body: undefined, isJsonBody: false };
  if (isBodyInit(body)) {
    return {
      body: typeof body === "string" && body.length === 0 ? undefined : body,
      isJsonBody: false,
    };
  }
  if (typeof body === "object") {
    return { body: JSON.stringify(body), isJsonBody: true };
  }
  if (typeof body === "number" || typeof body === "boolean" || typeof body === "bigint") {
    return { body: JSON.stringify(body), isJsonBody: true };
  }
  return { body: undefined, isJsonBody: false };
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/**
 * Creates a configured auth client for an ag-vibe application.
 *
 * @param config - {@link AuthClientConfig}
 * @returns {@link AuthClient}
 *
 * @example
 * ```ts
 * // src/lib/auth.ts
 * import { createAuthClient } from '@ag-vibe/auth'
 *
 * export const auth = createAuthClient({
 *   baseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
 *   appId: 'ido',
 * })
 *
 * // src/lib/client.config.ts (heyapi runtimeConfigPath)
 * auth: async (a) => {
 *   if (a.scheme === 'bearer') return (await auth.ensureValidAccessToken()) ?? undefined
 * }
 *
 * // src/main.tsx
 * auth.applyTo([apiClient, anclaxClient])
 * ```
 */
export function createAuthClient(config: AuthClientConfig): AuthClient {
  const { baseUrl, appId } = config;
  const store = createAuthStore(appId);

  let refreshInFlight: Promise<AuthSession | null> | null = null;

  async function refreshAuthSession(): Promise<AuthSession | null> {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const { session } = store.getState();
      if (!session?.refreshToken) return null;

      try {
        const refreshed = await ofetch<RefreshResponse>(`${baseUrl}/auth/refresh`, {
          method: "POST",
          body: { refreshToken: session.refreshToken },
        });

        const nextSession: AuthSession = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          tokenType: refreshed.tokenType ?? "Bearer",
        };

        store.getState().setSession(nextSession);
        return nextSession;
      } catch (err) {
        // Only clear on definitive auth rejection (401/403).
        // 429, 5xx, network errors must NOT log the user out.
        if (
          err instanceof FetchError &&
          err.response != null &&
          AUTH_FAILURE_STATUSES.has(err.response.status)
        ) {
          store.getState().clearSession();
        }
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  }

  async function ensureValidAccessToken(forceRefresh = false): Promise<string | null> {
    const { session } = store.getState();
    if (!session?.accessToken) return null;

    const shouldRefresh =
      forceRefresh || (!!session.refreshToken && isTokenExpiringSoon(session.accessToken));

    if (!shouldRefresh) return session.accessToken;

    const refreshed = await refreshAuthSession();
    return refreshed?.accessToken ?? null;
  }

  const installed = new WeakSet<InterceptableClient>();

  function applyTo(clients: InterceptableClient | InterceptableClient[]): void {
    const list = Array.isArray(clients) ? clients : [clients];

    for (const client of list) {
      if (installed.has(client)) continue;
      installed.add(client);

      client.interceptors.response.use(async (response, request, options) => {
        if (response.status !== 401) return response;
        if (isAuthEndpoint(request.url)) return response;
        if (request.headers.get(RETRY_MARKER_HEADER) === "1") return response;

        const refreshedToken = await ensureValidAccessToken(true);
        if (!refreshedToken) return response;

        const { session } = store.getState();
        const tokenType = session?.tokenType ?? "Bearer";
        const retryHeaders = new Headers(request.headers);
        retryHeaders.set("Authorization", `${tokenType} ${refreshedToken}`);
        retryHeaders.set(RETRY_MARKER_HEADER, "1");
        const { body, isJsonBody } = getRetryBody(options);
        if (isJsonBody && !retryHeaders.has("Content-Type")) {
          retryHeaders.set("Content-Type", JSON_CONTENT_TYPE);
        }

        try {
          return await ofetch.raw(request.url, {
            method: request.method,
            headers: retryHeaders,
            body,
            signal: options.signal ?? request.signal,
            redirect: request.redirect,
            credentials: request.credentials,
            cache: request.cache,
            mode: request.mode,
            referrer: request.referrer,
            referrerPolicy: request.referrerPolicy,
            integrity: request.integrity,
            keepalive: request.keepalive,
            ignoreResponseError: true,
          });
        } catch {
          return response;
        }
      });
    }
  }

  return { store, ensureValidAccessToken, applyTo };
}
